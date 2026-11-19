import { expect, test, type Page, type Route } from '@playwright/test';
import { stringifyWireJson } from '../helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000101';
const actorId = '00000000-0000-4000-8000-000000000001';
const teamId = '00000000-0000-4000-8000-000000000011';
const time = '2026-10-20T09:00:00Z';
const base = `/projects/${projectId}/settings?tab=management`;
const oldAddress = 'https://github.com/example/project';
const sameAddress = 'git@github.com:example/project.git';
const nextAddress = 'https://github.com/example/next-project';
const unknownAddress = `https://git.example.com/platform/${'long-repository-name-'.repeat(14)}project.git`;
const version = '9007199254740993';

type State = {
  role: 'admin' | 'member'; classification: 'unchanged' | 'same_repository' | 'different_repository' | 'unverified';
  result: 'success' | 'conflict' | 'occupied' | 'unknown' | 'unknown_unchanged'; repoUrl: string; repositoryVersion: string;
  githubConnected: boolean; githubRepositoryName: string | null;
  previews: Record<string, unknown>[]; writes: Record<string, unknown>[]; reads: string[]; hold: Promise<void> | null; holdGitHub: Promise<void> | null;
};

const install = async (page: Page): Promise<State> => {
  const state: State = { role: 'admin', classification: 'same_repository', result: 'success', repoUrl: oldAddress, repositoryVersion: version, githubConnected: false, githubRepositoryName: null, previews: [], writes: [], reads: [], hold: null, holdGitHub: null };
  const team = { id: teamId, kind: 'personal', name: null };
  const ownership = { teamId, version: 1n };
  const grant = () => ({ projectId, userId: actorId, role: state.role, version: 1n, createdAt: time, updatedAt: time });
  const access = () => ({ projectId, ownerTeam: team, ownership, effectiveRole: state.role, teamRole: null, canTransfer: false, directGrant: grant() });
  const project = () => ({ id: projectId, name: 'Repository project', repoUrl: state.repoUrl, ownership, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time });
  await page.context().route('**/api/v1/**', async (route: Route) => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': actorId } });
    const reject = (code: string) => send({ error: { code, message: code, requestId: 'repository-browser-test' } }, 409);
    if (method === 'GET') state.reads.push(path);
    if (path === '/api/v1/me') return send({ id: actorId, personalTeam: team, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}`) return send({ ...team, version: 1n, createdAt: time, updatedAt: time, membership: { teamId, userId: actorId, role: 'admin', version: 1n, createdAt: time, updatedAt: time } });
    if (path === '/api/v1/projects') return send({ items: [project()], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`) return send(project());
    if (path === `/api/v1/projects/${projectId}/access`) return send(access());
    if (path === `/api/v1/projects/${projectId}/members`) return send({ actorAccess: access(), items: [{ userId: actorId, profile: { name: 'Alice', email: null, avatarUrl: null }, effectiveRole: state.role, inheritedFrom: null, directGrant: grant() }] });
    if (path === `/api/v1/projects/${projectId}/repository/preview`) {
      const body = request.postDataJSON() as Record<string, unknown>; state.previews.push(body);
      return send({ projectId, projectName: 'Repository project', currentRepoUrl: state.repoUrl, repoUrl: body.repoUrl, repositoryVersion: state.repositoryVersion, ownershipVersion: '1', classification: state.classification, targetGitHubRepositoryId: state.classification === 'different_repository' ? '42' : null, unverifiedReason: state.classification === 'unverified' ? 'unsupported_host' : null, bindingsInvalidated: state.classification === 'unverified' || state.classification === 'different_repository' });
    }
    if (path === `/api/v1/projects/${projectId}/repository`) {
      const body = request.postDataJSON() as Record<string, unknown>; state.writes.push(body);
      if (state.hold !== null) await state.hold;
      if (state.result === 'conflict') { state.repositoryVersion = String(BigInt(state.repositoryVersion) + 1n); return reject('version_conflict'); }
      if (state.result === 'occupied') return reject('project_repository_conflict');
      if (state.result === 'unknown_unchanged') return route.abort('failed');
      state.repoUrl = body.repoUrl as string; state.repositoryVersion = String(BigInt(state.repositoryVersion) + 1n);
      if (state.classification === 'different_repository') { state.githubConnected = false; state.githubRepositoryName = 'example/next-project'; }
      if (state.result === 'unknown') return route.abort('failed');
      return send({ projectId, repoUrl: state.repoUrl, repositoryVersion: state.repositoryVersion, changed: true, bindingsInvalidated: state.classification === 'unverified' || state.classification === 'different_repository' });
    }
    if (path === `/api/v1/me/projects/${projectId}/worker-prompt`) return send({ scope: 'project', scopeId: projectId, revision: '0', text: '', updatedAt: null });
    if (path === `/api/v1/projects/${projectId}/invitations`) return send({ items: [] });
    if (path === `/api/v1/teams/${teamId}/github/apps`) return send({ items: [], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}/github`) {
      if (state.holdGitHub !== null) await state.holdGitHub;
      return send({ projectId, version: '1', revision: '0', serviceAvailable: true, syncEnabled: false, connection: state.githubConnected ? 'connected' : 'not_connected', repository: state.githubRepositoryName === null ? null : { id: state.githubConnected ? '41' : '42', fullName: state.githubRepositoryName, private: false }, installation: state.githubConnected ? { id: '1', accountLogin: 'example' } : null, canManageConnection: true, app: state.githubConnected ? { id: '00000000-0000-4000-8000-000000000022', githubAppId: '2', name: 'Repository App', githubSlug: 'repository-app' } : null, grantId: state.githubConnected ? '00000000-0000-4000-8000-000000000023' : null, pollIntervalMinutes: 5, initializing: false, poll: { running: false, lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null, error: null }, webhook: { running: false, lastReceivedAt: null, lastAttemptAt: null, lastSuccessAt: null, error: null } });
    }
    if (path === `/api/v1/projects/${projectId}/pull-requests`) return send({ projectId, revision: '0', items: [], total: '0', counts: { active: '0', closed: '0', merged: '0', all: '0' }, nextCursor: null, previousCursor: null });
    return send({ error: { code: 'not_found', message: 'not_found', requestId: 'repository-browser-test' } }, 404);
  });
  return state;
};

const labels = (zh: boolean) => ({
  title: zh ? '仓库地址' : 'Repository address', target: zh ? '新仓库地址' : 'New repository address', preview: zh ? '预览更改' : 'Preview change',
  confirm: zh ? '确认修改仓库地址' : 'Confirm repository address change', cancel: zh ? '取消' : 'Cancel', save: zh ? '保存地址' : 'Save address',
  switch: zh ? '确认更换仓库' : 'Confirm repository switch', ack: zh ? '按更换仓库处理' : 'Proceed as a repository switch',
});
const open = async (page: Page, address = sameAddress, zh = false) => {
  const m = labels(zh);
  await page.getByLabel(m.target, { exact: true }).fill(address);
  await page.getByRole('button', { name: m.preview, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: m.confirm });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(address, { exact: true }).last()).toBeVisible();
  return dialog;
};

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 1280]) {
  test(`repository confirmation wraps long addresses and preserves keyboard drafts at ${width}px (${locale})`, async ({ page }, testInfo) => {
    const state = await install(page); state.classification = 'unverified';
    const zh = locale === 'zh-CN', m = labels(zh);
    await page.setViewportSize({ width, height: 900 }); await page.goto(base);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const dialog = await open(page, unknownAddress, zh);
    await expect(dialog.getByRole('button', { name: m.cancel, exact: true })).toBeFocused();
    await expect(dialog.getByRole('button', { name: m.switch, exact: true })).toBeDisabled();
    await expect(dialog).toContainText(zh ? '现有执行也可能在配置应用时中断' : 'applying removal can interrupt running work');
    await dialog.getByLabel(m.ack, { exact: true }).check();
    await expect(dialog.getByRole('button', { name: m.switch, exact: true })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: m.switch, exact: true })).toHaveClass(/\bdanger\b/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('confirmation.png') });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: m.preview, exact: true })).toBeFocused();
    await expect(page.getByLabel(m.target, { exact: true })).toHaveValue(unknownAddress);
    expect(state.writes).toEqual([]);
  });
}

test('a direct project administrator saves the precise preview once and refreshes the project', async ({ page }) => {
  const state = await install(page); await page.goto(base);
  const dialog = await open(page);
  await expect(dialog).toContainText('The GitHub App connection and Worker selections are retained.');
  const before = state.reads.filter(path => path === `/api/v1/projects/${projectId}`).length;
  const gate = Promise.withResolvers<void>(); state.hold = gate.promise;
  await dialog.getByRole('button', { name: 'Save address', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(dialog.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  await page.keyboard.press('Enter');
  expect(state.writes).toHaveLength(1);
  gate.resolve();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Repository address saved.', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Repository address', exact: true }).getByText(sameAddress, { exact: true })).toBeVisible();
  expect(state.writes[0]).toEqual({ repoUrl: sameAddress, expectedUserId: actorId, repositoryVersion: version, ownershipVersion: '1', classification: 'same_repository', targetGitHubRepositoryId: null, treatUnverifiedAsSwitch: false });
  expect(state.reads.filter(path => path === `/api/v1/projects/${projectId}`).length).toBeGreaterThan(before);
});

test('switching repositories preserves an execution draft and refreshes the hidden GitHub tab', async ({ page }) => {
  const state = await install(page); state.classification = 'different_repository'; state.githubConnected = true; state.githubRepositoryName = 'example/project';
  const settingsTab = (name: string) => page.getByRole('navigation', { name: 'Project settings sections' }).getByRole('link', { name });
  await page.goto(`/projects/${projectId}/settings`);
  const threshold = page.getByLabel('Alert threshold', { exact: true });
  await expect(threshold).toHaveValue('60'); await threshold.fill('75');
  await settingsTab('GitHub integration').click();
  await expect(page.locator('.github-repository-name strong')).toHaveText('example/project');
  const before = state.reads.filter(path => path === `/api/v1/projects/${projectId}/github`).length;
  await settingsTab('Project management').click();
  const dialog = await open(page, nextAddress);
  await dialog.getByRole('button', { name: 'Confirm repository switch', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('region', { name: 'Repository address', exact: true }).getByText(nextAddress, { exact: true })).toBeVisible();
  await settingsTab('Execution & alerts').click();
  await expect(threshold).toHaveValue('75');
  await expect(threshold).toBeEditable();
  const refresh = Promise.withResolvers<void>(); state.holdGitHub = refresh.promise;
  try {
    await settingsTab('GitHub integration').click();
    await expect.poll(() => state.reads.filter(path => path === `/api/v1/projects/${projectId}/github`).length).toBeGreaterThan(before);
    await expect(page.getByText('Loading GitHub sync status…', { exact: true })).toBeVisible();
    await expect(page.locator('.github-repository-name strong')).toHaveCount(0);
  } finally { refresh.resolve(); }
  await expect(page.locator('.github-repository-name strong')).toHaveText('example/next-project');
  await expect(page.getByRole('heading', { name: 'Connect a repository', exact: true })).toBeVisible();
  expect(state.reads.filter(path => path === `/api/v1/projects/${projectId}/github`).length).toBeGreaterThan(before);
  expect(state.writes).toHaveLength(1);
});

test('different repositories display binding effects and save without an unknown acknowledgement', async ({ page }) => {
  const state = await install(page); state.classification = 'different_repository'; await page.goto(base);
  const dialog = await open(page, nextAddress);
  await expect(dialog).toContainText('Repository switch effects');
  await expect(dialog).toContainText('Existing PRs are kept.');
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Confirm repository switch', exact: true })).toHaveClass(/\bdanger\b/);
  await dialog.getByRole('button', { name: 'Confirm repository switch', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(state.writes[0]?.classification).toBe('different_repository');
  expect(state.writes[0]?.targetGitHubRepositoryId).toBe('42');
  expect(state.writes[0]?.treatUnverifiedAsSwitch).toBe(false);
});

test('unknown identity requires a separate acknowledgement before saving', async ({ page }) => {
  const state = await install(page); state.classification = 'unverified'; await page.goto(base);
  const dialog = await open(page, unknownAddress);
  const confirm = dialog.getByRole('button', { name: 'Confirm repository switch', exact: true });
  await expect(confirm).toBeDisabled(); expect(state.writes).toEqual([]);
  await dialog.getByLabel('Proceed as a repository switch', { exact: true }).check();
  await confirm.click(); await expect(dialog).toBeHidden();
  expect(state.writes[0]?.treatUnverifiedAsSwitch).toBe(true);
});

test('members see the current address and cannot preview or save', async ({ page }) => {
  const state = await install(page); state.role = 'member'; await page.goto(base);
  const panel = page.getByRole('region', { name: 'Repository address', exact: true });
  await expect(panel.getByText(oldAddress, { exact: true })).toBeVisible();
  await expect(panel).toContainText('Only project administrators can change the repository address.');
  await expect(panel.getByRole('button', { name: 'Preview change', exact: true })).toBeDisabled();
  expect(state.previews).toEqual([]); expect(state.writes).toEqual([]);
});

test('unchanged preview has no save action', async ({ page }) => {
  const state = await install(page); state.classification = 'unchanged'; await page.goto(base);
  const dialog = await open(page, oldAddress);
  await expect(dialog).toContainText('The address matches the current value.');
  await expect(dialog.getByRole('button', { name: 'Save address', exact: true })).toBeDisabled();
  expect(state.writes).toEqual([]);
});

test('a version conflict requires another preview and confirmation', async ({ page }) => {
  const state = await install(page); state.result = 'conflict'; await page.goto(base);
  const dialog = await open(page);
  await dialog.getByRole('button', { name: 'Save address', exact: true }).click();
  await expect(dialog).toContainText('Preview the change again and confirm.');
  await expect(dialog.getByRole('button', { name: 'Save address', exact: true })).toHaveCount(0);
  state.result = 'success';
  await dialog.getByRole('button', { name: 'Preview again', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Save address', exact: true })).toBeEnabled();
  expect(state.writes).toHaveLength(1); expect(state.previews).toHaveLength(2);
  await dialog.getByRole('button', { name: 'Save address', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(state.writes[1]?.repositoryVersion).toBe('9007199254740994');
});

test('occupied repository refusal preserves an editable draft', async ({ page }) => {
  const state = await install(page); state.result = 'occupied'; await page.goto(base);
  const dialog = await open(page);
  await dialog.getByRole('button', { name: 'Save address', exact: true }).click();
  await expect(dialog).toContainText('Another active project in this Team already uses this repository.');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('New repository address', { exact: true })).toHaveValue(sameAddress);
  await page.getByLabel('New repository address', { exact: true }).fill(nextAddress);
  await expect(page.getByRole('button', { name: 'Preview change', exact: true })).toBeEnabled();
  expect(state.writes).toHaveLength(1);
});

for (const committed of [false, true]) test(`a lost save response permits readback without replaying or claiming original success (committed: ${committed})`, async ({ page }) => {
  const state = await install(page); state.result = committed ? 'unknown' : 'unknown_unchanged'; await page.goto(base);
  const dialog = await open(page);
  await dialog.getByRole('button', { name: 'Save address', exact: true }).click();
  await expect(dialog).toContainText('The save outcome is unknown.');
  await expect(dialog.getByRole('button', { name: 'Save address', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Check current address', exact: true }).click();
  await expect(dialog).toContainText('Current address observed');
  await expect(dialog).toContainText(committed ? sameAddress : oldAddress);
  await expect(dialog).toContainText('it cannot confirm the original operation');
  await expect(page.getByText('Repository address saved.', { exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});
