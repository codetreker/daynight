import { selectTaskList } from '../../tests/e2e/project-view.ts';
import { attachmentFileButton, attachmentFileActions } from '../../tests/e2e/attachment-tree.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { chromium, expect, request as playwrightRequest, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { authenticatedAPI, browserFetch, tokenContext, type AuthenticatedAPI } from '../../tests/e2e/authentication.ts';
import { stringifyApiJson } from '../../src/api/json.ts';
import { login } from './auth-fixture.mts';
import { browserInventory, recordBrowserOwnership, recoverBrowsers, type BrowserInventory } from './browser.mts';
import { createAcceptanceCli, recoverCliProcesses, validateInstalledCli } from './installed-cli.mts';
import { command } from './process.mts';
import { processIdentity, requireGroupStopped, type ProcessIdentity } from './identity.mts';
import { createAuthCombinedTarget, type CombinedCommand, type CombinedTarget, type UploadObservation } from './auth-combined-target.mts';
import { AuthCombinedTransportError, startAuthCombinedUpload, type PausedUpload } from './auth-combined-transport.mts';

export type RestartReceipt = {
  target: 'native' | 'container'; origin: string; startedAt: string; readyAt: string;
  before: { pid: number; start: string }; after: { pid: number; start: string };
  binaryOrImage: string; containerId?: string;
};
type Check = { name: string; result: 'passed'; details: Record<string, unknown> };
export type AuthCombinedReceipt = {
  schemaVersion: 1; kind: 'auth-combined'; target: 'native' | 'container'; sourceGitSha: string;
  origin: string; result: 'running' | 'passed' | 'failed'; startedAt: string; finishedAt?: string;
  cleanup: 'pending' | 'passed' | 'failed'; browserCleanup: 'not-started' | 'pending' | 'passed' | 'failed';
  browserInventory?: BrowserInventory; browser?: { name: string; version: string; platform: string; executableOverride: boolean };
  installedCli: { version: string; sourceGitSha: string; entrySha256: string; tarballSha256: string };
  checks: Check[]; screenshots: string[]; commands: ProcessIdentity[]; commandGroups: number[];
  restart?: RestartReceipt; error?: string; cleanupErrors?: string[];
};
export type AuthCombinedOptions = {
  target: CombinedTarget; directory: string; installedReceiptPath: string; signal: AbortSignal;
  restartTarget(run: CombinedCommand, signal: AbortSignal): Promise<RestartReceipt>;
  readLogs(run: CombinedCommand): Promise<string>;
};

const requiredChecks = ['partial-sharing', 'normal-member-writes', 'bilingual-token', 'same-data-cli-browser',
  'restart-original-state', 'logout-independent-pat', 'pat-revocation', 'socket-disconnect',
  'admitted-member-removal', 'expired-pat', 'secret-scan'] as const;
class CombinedFailure extends Error {}
let launchingBrowser = false;
export const launchAuthCombinedBrowser = async <T,>(temporaryRoot: string, launch: () => Promise<T>): Promise<T> => {
  if (launchingBrowser) throw new CombinedFailure('A combined browser launch is already active.');
  const previous = process.env.TMPDIR;
  launchingBrowser = true;
  try { await mkdir(temporaryRoot, { recursive: true }); process.env.TMPDIR = temporaryRoot; return await launch(); }
  finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    launchingBrowser = false;
  }
};
const check: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new CombinedFailure(message); };
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const json = async (path: string, value: unknown): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(`${path}.next`, `${JSON.stringify(value)}\n`);
  await rename(`${path}.next`, path);
};
const safeFailure = (operation: string): Error => new CombinedFailure(`Combined authentication acceptance failed: ${operation}.`);
const decode = <T,>(text: string): T => {
  try {
    return JSON.parse(text, (key: string, value: unknown, context?: { source: string }) => {
      if (key !== 'version' || typeof value !== 'number') return value;
      if (context === undefined || !/^[1-9][0-9]*$/.test(context.source)) throw safeFailure('exact version decoding');
      return BigInt(context.source);
    }) as T;
  } catch { throw safeFailure('JSON decoding'); }
};
const encode = (body: unknown): string => JSON.stringify(body, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
const request = async <T,>(api: AuthenticatedAPI, origin: string, method: string, path: string, status: number, body?: unknown): Promise<T> => {
  const response = await api.fetch(`${origin}${path}`, { method, timeout: 10_000, maxRetries: 0,
    ...(body === undefined ? {} : { data: stringifyApiJson(body) }),
    ...(method === 'GET' || method === 'HEAD' ? {} : { headers: { Origin: origin, 'Content-Type': 'application/json' } }) });
  check(response.status() === status, `${method} ${path.split('?')[0]} returned an unexpected status.`);
  if (status === 204 || method === 'HEAD') return undefined as T;
  return decode<T>(await response.text());
};
const resourceStatus = async (api: AuthenticatedAPI, origin: string, method: 'GET' | 'HEAD', path: string, status: number): Promise<void> => {
  const response = await api.fetch(`${origin}${path}`, { method, timeout: 10_000, maxRetries: 0 });
  check(response.status() === status, `${method} ${path} returned an unexpected resource status.`);
  if (status >= 400) check(/^application\/json(?:;|$)/i.test(response.headers()['content-type'] ?? ''), 'A denied resource returned a login document.');
};
const waitFor = async (operation: () => Promise<boolean>, signal: AbortSignal, label: string, milliseconds = 5_000): Promise<void> => {
  const deadline = performance.now() + milliseconds;
  for (;;) {
    signal.throwIfAborted();
    if (await operation()) return;
    if (performance.now() >= deadline) throw safeFailure(label);
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => { clearTimeout(timer); reject(safeFailure('cancellation')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 50);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
};
const fileUrl = (project: string, task: string, path: string): string => `/api/v1/projects/${project}/tasks/${task}/attachments/files/${path.split('/').map(encodeURIComponent).join('/')}`;
const previewUrl = (project: string, task: string, path: string): string => `/api/v1/projects/${project}/tasks/${task}/preview/${path.split('/').map(encodeURIComponent).join('/')}`;
type User = { id: string; name: string; email: string };
type Project = { id: string; name: string };
type Task = { id: string; title: string; version: bigint; properties: { pullRequests: { url: string; title: string }[] }; updatedAt: string };
type Member = { userId: string; role: string; version: bigint };
type Token = { id: string; token: string };
type Invitation = { id: string; link: string };
type Cli = Awaited<ReturnType<typeof createAcceptanceCli>>;

const projectIds = async (api: AuthenticatedAPI, origin: string): Promise<string[]> => {
  const ids: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: { items: Project[]; nextCursor: string | null } = await request(api, origin, 'GET',
      `/api/v1/projects?limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, 200);
    check(page.items.length <= 1, 'Project pagination exceeded its requested limit.');
    ids.push(...page.items.map((project) => project.id));
    cursor = page.nextCursor;
    if (cursor !== null) { check(!cursors.has(cursor), 'Project pagination repeated a cursor.'); cursors.add(cursor); }
  } while (cursor !== null);
  check(new Set(ids).size === ids.length, 'Project pagination repeated a project.');
  return ids.sort();
};
const sameIds = (actual: readonly string[], expected: readonly string[], label: string): void => {
  check(JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()), label);
};
const cliSuccess = async (cli: Cli, args: string[]): Promise<string> => {
  const response = await cli.run(args);
  check(response.exitCode === 0 && response.stderr === '', 'Installed CLI command failed.');
  return response.stdout;
};
const cliDenied = async (cli: Cli, args: string[], code: 'not_found' | 'unauthenticated'): Promise<void> => {
  const response = await cli.run(args);
  check(response.exitCode !== 0 && response.stdout === '' && response.stderr.includes(code), 'Installed CLI did not preserve the expected authority failure.');
};

export const validateAuthCombinedReceipt = (value: unknown, target: CombinedTarget): AuthCombinedReceipt => {
  check(typeof value === 'object' && value !== null, 'Combined receipt is missing.');
  const receipt = value as AuthCombinedReceipt;
  check(receipt.schemaVersion === 1 && receipt.kind === 'auth-combined' && receipt.result === 'passed'
    && receipt.cleanup === 'passed' && receipt.browserCleanup === 'passed' && receipt.target === target.target
    && receipt.origin === target.baseUrl && receipt.sourceGitSha === target.sourceGitSha, 'Combined receipt identity or cleanup differs.');
  check(receipt.checks.length === requiredChecks.length && requiredChecks.every((name) => receipt.checks.filter((entry) => entry.name === name && entry.result === 'passed').length === 1), 'Combined receipt does not contain every required result exactly once.');
  check(receipt.restart?.origin === target.baseUrl && receipt.restart.before.pid !== receipt.restart.after.pid
    && receipt.restart.before.start !== receipt.restart.after.start, 'Combined restart did not replace the owned process.');
  check(receipt.browser?.name === 'chromium' && /^\d+\.\d+\.\d+\.\d+$/.test(receipt.browser.version)
    && receipt.browser.platform === process.platform && ['linux', 'darwin'].includes(receipt.browser.platform)
    && (!process.env.CI || receipt.browser.executableOverride === false), 'Combined browser identity is invalid.');
  check(receipt.installedCli.sourceGitSha === target.sourceGitSha && receipt.screenshots.length >= 2, 'Combined CLI source or screenshot evidence is missing.');
  return receipt;
};

const bilingualToken = async (page: Page, context: BrowserContext, origin: string, secrets: Set<string>, signal: AbortSignal): Promise<Token> => {
  await page.goto(`${origin}/account`);
  await page.getByRole('button', { name: 'Access tokens', exact: true }).click();
  await page.getByRole('button', { name: 'Create token', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const name = `Combined CLI ${randomUUID()}`;
  const input = dialog.getByLabel('Token name', { exact: false });
  await input.fill(name);
  await dialog.getByLabel('Expiration', { exact: true }).selectOption('never');
  const originalInput = await input.elementHandle();
  check(originalInput !== null, 'The production token input is missing.');
  const fetched = Promise.withResolvers<Token>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  void fetched.promise.catch(() => {});
  void finished.promise.catch(() => {});
  const abort = (): void => release.resolve();
  signal.addEventListener('abort', abort, { once: true });
  let posts = 0;
  const url = `${origin}/api/v1/me/tokens`;
  await page.route(url, async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    posts++;
    try {
      const response = await authenticatedAPI(context.request).fetch(route.request(), { timeout: 10_000, maxRetries: 0 });
      check(response.status() === 201, 'Production token creation failed.');
      const bytes = await response.body();
      const metadata = decode<Token>(bytes.toString());
      check(typeof metadata.token === 'string' && metadata.token.startsWith('dnpat_'), 'The issued token has an invalid shape.');
      secrets.add(metadata.token);
      fetched.resolve(metadata);
      await release.promise;
      await route.fulfill({ status: response.status(), headers: response.headers(), body: bytes });
      finished.resolve();
    } catch { const error = safeFailure('production token forwarding'); fetched.reject(error); finished.reject(error); }
  });
  try {
    await dialog.getByRole('button', { name: 'Create token', exact: true }).click();
    const token = await fetched.promise;
    await dialog.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption('zh-CN');
    check(await originalInput.evaluate((element) => element.isConnected), 'Language switching replaced the pending token input.');
    check(await originalInput.evaluate((element) => (element as HTMLInputElement).value) === name && posts === 1, 'Language switching changed token input or repeated submission.');
    release.resolve();
    await finished.promise;
    const secret = page.getByLabel('一次性访问令牌', { exact: true });
    await expect(secret).toBeVisible();
    check(await secret.inputValue() === token.token, 'Production one-time token field differs from its response.');
    const originalSecret = await secret.elementHandle();
    check(originalSecret !== null, 'The revealed token element is missing.');
    await page.getByRole('dialog').getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption('en');
    check(await originalSecret.evaluate((element) => element.isConnected), 'Language switching replaced the revealed token.');
    check(await originalSecret.evaluate((element) => (element as HTMLTextAreaElement).value) === token.token && posts === 1, 'Language switching changed the token or repeated submission.');
    await page.getByRole('dialog').getByRole('button', { name: 'I have saved it, close', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    return token;
  } finally {
    release.resolve();
    try { if (posts > 0) await finished.promise; }
    finally { signal.removeEventListener('abort', abort); await page.unroute(url); }
  }
};

const visibleReadingHeight = async (owner: Locator): Promise<number> => {
  const geometry = await owner.evaluate((element) => {
    const box = element.getBoundingClientRect();
    let top = 0;
    let bottom = innerHeight;
    let left = 0;
    let right = innerWidth;
    for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const bounds = ancestor.getBoundingClientRect();
      if (style.overflowY !== 'visible') { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
      if (style.overflowX !== 'visible') { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
    }
    return { clientHeight: element.clientHeight, visibleHeight: Math.max(0, Math.min(bottom, box.bottom) - Math.max(top, box.top)),
      visibleWidth: Math.max(0, Math.min(right, box.right) - Math.max(left, box.left)) };
  });
  check(geometry.clientHeight > 0 && geometry.visibleHeight > 0 && geometry.visibleWidth > 0, 'Fullscreen reading content has no visible area.');
  return geometry.visibleHeight;
};

const scrollReading = async (page: Page, owner: Locator): Promise<number> => {
  check(await owner.evaluate((element) => element.scrollHeight > element.clientHeight), 'The reading fixture does not overflow.');
  await owner.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => owner.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  return await owner.evaluate((element) => element.scrollTop);
};

const fullscreenPreview = async (page: Page, context: BrowserContext, origin: string, projectId: string, task: Task): Promise<Record<string, unknown>> => {
  const detail = page.getByRole('dialog', { name: task.title, exact: true });
  const toggle = detail.locator('.task-detail-fullscreen-toggle');
  const frame = detail.frameLocator('iframe');
  const retained = await Promise.all([detail.elementHandle(), detail.locator('iframe').elementHandle(), detail.locator('input[type=file]').elementHandle()]);
  check(retained.every((element) => element !== null), 'Fullscreen reading elements are missing.');
  await detail.locator('.attachment-upload-disclosure summary').click();
  await detail.locator('input[type=file]').setInputFiles({ name: 'fullscreen-draft.txt', mimeType: 'text/plain', buffer: Buffer.from('Fullscreen draft') });
  const path = detail.locator('.attachment-upload-target input');
  await path.fill('draft/retained.txt');
  const resourceRequests: string[] = [];
  const shortReading: Record<string, number> = {};
  const observe = (request: import('@playwright/test').Request): void => {
    if (request.url().includes(`/tasks/${task.id}/preview/`)) resourceRequests.push(request.url());
  };
  page.on('request', observe);
  try {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 640 }, { width: 320, height: 240 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(async () => {
        const box = await detail.boundingBox();
        return box !== null && Math.abs(box.x) <= 1 && Math.abs(box.y) <= 1
          && Math.abs(box.width - viewport.width) <= 1 && Math.abs(box.height - viewport.height) <= 1;
      }).toBe(true);
      for (const control of [toggle, detail.locator('.task-detail-more'), detail.locator('.task-detail-close')]) {
        const box = await control.boundingBox();
        check(box !== null && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, 'A fullscreen header action is outside the viewport.');
      }
      if (viewport.height === 240) {
        shortReading.htmlHeight = await visibleReadingHeight(detail.locator('.attachment-preview-body-native'));
        await visibleReadingHeight(detail.locator('iframe'));
        await frame.locator('#counter').press('End');
        await expect.poll(() => frame.locator('html').evaluate((element) => element.ownerDocument.scrollingElement!.scrollTop)).toBeGreaterThan(0);
        shortReading.htmlScroll = await frame.locator('html').evaluate((element) => element.ownerDocument.scrollingElement!.scrollTop);
        await detail.getByRole('tab', { name: '概览', exact: true }).click();
        const overview = detail.locator('.task-detail-panel-overview');
        shortReading.overviewHeight = await visibleReadingHeight(overview);
        shortReading.overviewScroll = await scrollReading(page, overview);
        await detail.getByRole('tab', { name: '附件', exact: true }).click();
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await (await attachmentFileActions(detail, 'docs/long.md')).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await frame.locator('#counter').evaluate((element) => {
      element.ownerDocument.defaultView!.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && element.ownerDocument.body.dataset.consumeEscape === 'yes') {
          event.preventDefault();
          element.ownerDocument.body.dataset.consumeEscape = 'no';
        }
      });
      element.ownerDocument.body.dataset.consumeEscape = 'yes';
    });
    await frame.locator('#counter').press('Escape');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(frame.locator('body')).toHaveAttribute('data-consume-escape', 'no');
    await frame.locator('#counter').press('Escape');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toBeFocused();
    await expect(path).toHaveValue('draft/retained.txt');
    check(await retained[2]!.evaluate((element) => (element as HTMLInputElement).files?.[0]?.name) === 'fullscreen-draft.txt', 'Fullscreen switching lost the selected local file.');
    await expect(frame.locator('#counter')).toHaveText('1');
    check((await Promise.all(retained.map((element) => element!.evaluate((node) => node.isConnected)))).every(Boolean), 'Fullscreen switching replaced retained reading DOM.');
    check(resourceRequests.length === 0, 'Fullscreen switching reloaded a preview resource.');
    await frame.locator('#counter').press('Escape');
    await expect(detail).toHaveCount(0);
    await expect(page.locator(`#standalone-task-${task.id}`)).toBeFocused();
  } finally { page.off('request', observe); await Promise.all(retained.map((element) => element?.dispose())); }

  await page.locator(`#standalone-task-${task.id}`).click();
  await detail.getByRole('tab', { name: '附件', exact: true }).click();
  await (await attachmentFileButton(detail, 'docs/long.md')).click();
  await expect(detail.locator('.attachment-markdown h1')).toHaveText('Fullscreen reading');
  await toggle.click();
  await page.setViewportSize({ width: 320, height: 240 });
  const markdown = detail.locator('.attachment-preview-body');
  shortReading.markdownHeight = await visibleReadingHeight(markdown);
  shortReading.markdownScroll = await scrollReading(page, markdown);
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });

  const reader = await context.newPage();
  try {
    await reader.goto(`${origin}/projects/${projectId}/tasks/${task.id}/attachments/site/index.html`);
    const surface = reader.locator('.task-detail-page');
    const readerToggle = surface.locator('.task-detail-fullscreen-toggle');
    const counter = surface.frameLocator('iframe').locator('#counter');
    await expect(counter).toHaveText('0');
    await counter.click();
    await counter.evaluate((element) => {
      element.ownerDocument.defaultView!.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') setTimeout(() => { element.ownerDocument.body.dataset.escapePrevented = String(event.defaultPrevented); }, 0);
      });
    });
    const originalFrame = await surface.locator('iframe').elementHandle();
    check(originalFrame !== null, 'Standalone fullscreen iframe is missing.');
    const address = reader.url();
    const standaloneRequests: string[] = [];
    reader.on('request', (request) => { if (request.url().includes(`/tasks/${task.id}/preview/`)) standaloneRequests.push(request.url()); });
    for (let iteration = 0; iteration < 2; iteration++) {
      await readerToggle.click();
      await expect(readerToggle).toHaveAttribute('aria-pressed', 'true');
      await expect(surface.locator('.task-detail-page-topbar')).toBeHidden();
      await expect(surface.getByRole('link', { name: '返回任务所在项目', exact: true })).toBeVisible();
      await counter.press('Escape');
      await expect(readerToggle).toHaveAttribute('aria-pressed', 'false');
      await expect(readerToggle).toBeFocused();
      await expect(surface.frameLocator('iframe').locator('body')).toHaveAttribute('data-escape-prevented', 'true');
      await counter.press('Escape');
      await expect(surface.frameLocator('iframe').locator('body')).toHaveAttribute('data-escape-prevented', 'false');
      await expect(surface).toBeVisible();
      await expect(counter).toHaveText('1');
      check(reader.url() === address && await originalFrame.evaluate((element) => element.isConnected), 'Standalone fullscreen changed the URL or iframe identity.');
    }
    check(standaloneRequests.length === 0, 'Standalone fullscreen reloaded its HTML resources.');
    await originalFrame.dispose();
  } finally { await reader.close(); }
  return { modalEscape: 'full-normal-close', standaloneEscape: 'full-normal-native', retainedFrameAndFileInput: true,
    draftRetained: true, noPreviewReload: true, nestedMenuFirst: true, childWindowEscapeFirst: true, shortReading, viewports: ['1440x1000', '390x640', '320x240'] };
};

export const runAuthCombined = async (options: AuthCombinedOptions): Promise<AuthCombinedReceipt> => {
  check(options.directory === join(options.target.acceptanceDirectory, options.target.target === 'native' ? 'native/auth-combined' : 'container/auth-combined'), 'Combined directory is outside its owned target.');
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(180_000)]);
  const installed = await validateInstalledCli(options.installedReceiptPath, options.target.acceptanceDirectory);
  const receipt: AuthCombinedReceipt = {
    schemaVersion: 1, kind: 'auth-combined', target: options.target.target, sourceGitSha: options.target.sourceGitSha,
    origin: options.target.baseUrl, result: 'running', startedAt: new Date().toISOString(), cleanup: 'pending', browserCleanup: 'not-started',
    installedCli: { version: installed.packageVersion, sourceGitSha: installed.source.gitSha, entrySha256: installed.entrySha256, tarballSha256: installed.tarballSha256 },
    checks: [], screenshots: [], commands: [], commandGroups: [],
  };
  let writes = Promise.resolve();
  const save = (): Promise<void> => writes = writes.then(() => json(join(options.directory, 'target.json'), receipt));
  let currentStep = 'partial-sharing';
  const record = async (name: typeof requiredChecks[number], details: Record<string, unknown>): Promise<void> => {
    receipt.checks.push({ name, result: 'passed', details });
    currentStep = requiredChecks[requiredChecks.indexOf(name) + 1] ?? 'completion'; await save();
  };
  const run: CombinedCommand = async (file, args, extra = {}) => {
    let group: number | undefined;
    let registration = Promise.resolve();
    try {
      return await command(file, args, { cwd: process.cwd(), ...extra, quiet: true, signal,
        onSpawn: (child) => {
          group = child.pid!; receipt.commandGroups.push(group);
          registration = (async () => {
            await save();
            const identity = await processIdentity(child.pid!);
            if (identity !== null) receipt.commands.push(identity);
            await save();
            await extra.onSpawn?.(child);
          })();
          return registration;
        } });
    } finally { try { await registration; } finally { if (group !== undefined) requireGroupStopped(group); } }
  };
  let browser: Browser | undefined;
  const contexts: BrowserContext[] = [];
  const clients: Cli[] = [];
  const tokenClients: AuthenticatedAPI[] = [];
  const uploads: PausedUpload[] = [];
  const secrets = new Set<string>();
  const screenshots = async (page: Page, name: string): Promise<void> => {
    const path = join(options.directory, `${name}.png`);
    await page.screenshot({ path }); receipt.screenshots.push(path); await save();
  };
  const rememberLocation = (input: string): void => {
    const url = new URL(input, options.target.baseUrl);
    for (const name of ['code', 'state']) { const value = url.searchParams.get(name); if (value !== null) secrets.add(value); }
  };
  const signIn = async (context: BrowserContext, persona: 'alice' | 'bob') => {
    const fetcher = browserFetch(context.request);
    const session = await login({ origin: options.target.baseUrl, persona, signal, fetch: async (input, init) => {
      rememberLocation(input instanceof Request ? input.url : String(input));
      const response = await fetcher(input, init);
      const location = response.headers.get('location'); if (location !== null) rememberLocation(location);
      return response;
    } });
    secrets.add(session.cookie); secrets.add(session.cookie.slice(session.cookie.indexOf('=') + 1));
    return session;
  };
  const cli = async (token: string, name: string): Promise<Cli> => {
    secrets.add(token);
    const client = await createAcceptanceCli(options.target.baseUrl, join(options.directory, name), token, options.installedReceiptPath);
    clients.push(client); return client;
  };
  const pat = async (api: AuthenticatedAPI, name: string): Promise<Token> => {
    const token = await request<Token>(api, options.target.baseUrl, 'POST', '/api/v1/me/tokens', 201, { name, expiresAt: null });
    secrets.add(token.token); return token;
  };
  const origin = options.target.baseUrl;
  let failure: unknown;
  let abortClose: Promise<void> | undefined;
  let abortCliRecovery: Promise<void> | undefined;
  const closeOnAbort = (): void => {
    abortClose = browser?.close(); void abortClose?.catch(() => {});
    if (clients.length > 0) {
      abortCliRecovery = recoverCliProcesses(options.target.acceptanceDirectory, options.installedReceiptPath, installed);
      void abortCliRecovery.catch(() => {});
    }
  };
  signal.addEventListener('abort', closeOnAbort, { once: true });
  try {
    await save();
    signal.throwIfAborted();
    const controls = createAuthCombinedTarget(options.target, run);
    receipt.browserInventory = await browserInventory(); receipt.browserCleanup = 'pending'; await save();
    // Playwright creates profiles from the parent os.tmpdir(), while launch env
    // configures only Chromium. The preceding browser/CLI phase has drained;
    // concurrent container preparation already runs in a separate process.
    browser = await launchAuthCombinedBrowser(join(options.target.acceptanceDirectory, '../..'), async () => chromium.launch({
      headless: true, channel: 'chromium', env: { ...process.env, TMPDIR: '.tmp', DAYNIGHT_ACCEPTANCE_DIRECTORY: options.directory },
      ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined ? {} : { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE }) }));
    await recordBrowserOwnership(browser, options.directory);
    receipt.browser = { name: browser.browserType().name(), version: browser.version(), platform: process.platform, executableOverride: process.env.DAYNIGHT_BROWSER_EXECUTABLE !== undefined }; await save();
    const aliceContext = await browser.newContext({ baseURL: origin, locale: 'en-US', viewport: { width: 1440, height: 1000 } });
    const bobContext = await browser.newContext({ baseURL: origin, locale: 'en-US', viewport: { width: 1440, height: 1000 } });
    contexts.push(aliceContext, bobContext);
    await signIn(aliceContext, 'alice'); const originalBobSession = await signIn(bobContext, 'bob');
    const alice = authenticatedAPI(aliceContext.request), bob = authenticatedAPI(bobContext.request);
    const aliceUser = await request<User>(alice, origin, 'GET', '/api/v1/me', 200);
    const bobUser = await request<User>(bob, origin, 'GET', '/api/v1/me', 200);
    check(aliceUser.id !== bobUser.id && aliceUser.email === bobUser.email, 'Normal same-email users did not remain distinct.');
    const a0 = await projectIds(alice, origin), b0 = await projectIds(bob, origin);
    const shared = await request<Project>(alice, origin, 'POST', '/api/v1/projects', 201, { name: `Combined shared ${randomUUID()}`, repoUrl: `https://example.test/combined/${randomUUID()}` });
    const privateProject = await request<Project>(bob, origin, 'POST', '/api/v1/projects', 201, { name: `Combined private ${randomUUID()}`, repoUrl: `https://example.test/combined/${randomUUID()}` });
    sameIds(await projectIds(alice, origin), [...a0, shared.id], 'Alice private-project pagination differs.');
    sameIds(await projectIds(bob, origin), [...b0, privateProject.id], 'Bob private-project pagination differs.');
    const invite = await request<Invitation>(alice, origin, 'POST', `/api/v1/projects/${shared.id}/invitations`, 201, {});
    const inviteToken = new URL(invite.link).hash.slice(1); secrets.add(inviteToken);
    const alicePage = await aliceContext.newPage(), bobPage = await bobContext.newPage();
    for (const page of [alicePage, bobPage]) { page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(30_000); }
    try { await bobPage.goto(invite.link); } catch { throw safeFailure('invitation navigation'); }
    await expect(bobPage.getByRole('heading', { name: 'You are invited to a project', exact: true })).toBeVisible();
    check(new URL(bobPage.url()).hash === '', 'Invitation navigation retained a secret fragment.');
    await bobPage.getByRole('button', { name: 'Accept invitation and join', exact: true }).click();
    await expect(bobPage.getByRole('heading', { name: shared.name, exact: true })).toBeVisible();
    sameIds(await projectIds(alice, origin), [...a0, shared.id], 'Alice shared-project pagination differs.');
    sameIds(await projectIds(bob, origin), [...b0, privateProject.id, shared.id], 'Bob shared-project pagination differs.');
    await request(alice, origin, 'GET', `/api/v1/projects/${privateProject.id}`, 404);
    const members = await request<{ items: Member[] }>(alice, origin, 'GET', `/api/v1/projects/${shared.id}/members`, 200);
    const bobMember = members.items.find((member) => member.userId === bobUser.id);
    check(bobMember?.role === 'member', 'Invitation did not create a normal member.');
    await record('partial-sharing', { aliceId: aliceUser.id, bobId: bobUser.id, sharedProject: shared.id, privateProject: privateProject.id, baselineAlice: a0, baselineBob: b0, pageLimit: 1 });
    const reading = `# Fullscreen reading\n\n${'Browser and installed CLI share this long reading task.\n\n'.repeat(120)}`;
    const task = await request<Task>(bob, origin, 'POST', `/api/v1/projects/${shared.id}/tasks`, 201, { title: 'Combined member task', description: reading });
    const privateTask = await request<Task>(bob, origin, 'POST', `/api/v1/projects/${privateProject.id}/tasks`, 201, { title: 'Private authority control' });
    await request(bob, origin, 'POST', `/api/v1/projects/${shared.id}/invitations`, 403, {});
    await request(bob, origin, 'PATCH', `/api/v1/projects/${shared.id}/members/${bobUser.id}`, 403, { version: bobMember.version, role: 'admin' });
    await record('normal-member-writes', { taskId: task.id, privateTaskId: privateTask.id, memberVersion: bobMember.version.toString(), administratorDenial: 403 });
    const originalToken = await bilingualToken(bobPage, bobContext, origin, secrets, signal);
    await screenshots(bobPage, 'account-english-after-secret-close');
    await record('bilingual-token', { tokenId: originalToken.id, requests: 1, pendingInputRetained: true, revealedElementRetained: true, locales: ['en', 'zh-CN', 'en'] });
    const bobCli = await cli(originalToken.token, 'original-cli');
    const tokenApi = await tokenContext(playwrightRequest, origin, originalToken.token);
    tokenClients.push(tokenApi);
    await cliSuccess(bobCli, ['task', 'set-property', task.id, 'pullRequests', JSON.stringify([{ url: 'https://example.test/combined/pull/1', title: 'Combined property retained' }]),
      '--project', shared.id, '--if-version', task.version.toString()]);
    const snapshot = await request<Task>(bob, origin, 'GET', `/api/v1/projects/${shared.id}/tasks/${task.id}`, 200);
    check(snapshot.version === task.version + 1n && snapshot.properties.pullRequests[0]?.title === 'Combined property retained', 'CLI property write differs from the browser API resource.');
    const binary = Buffer.from(Array.from({ length: 65_536 }, (_unused, index) => index % 256));
    const binaryPath = join(options.directory, 'same-data.bin'); await writeFile(binaryPath, binary);
    const binaryArgs = ['task', 'attachment', 'read', task.id, 'shared/data.bin', '--project', shared.id];
    await cliSuccess(bobCli, ['task', 'attachment', 'put', task.id, binaryPath, '--path', 'shared/data.bin', '--project', shared.id]);
    const binaryResource = fileUrl(shared.id, task.id, 'shared/data.bin');
    check((await (await alice.get(`${origin}${binaryResource}`)).body()).equals(binary), 'Browser cookie bytes differ from the installed CLI upload.');
    check((await bobCli.read(binaryArgs)).equals(binary), 'Installed CLI bytes differ from its uploaded resource.');
    const privateResource = fileUrl(privateProject.id, privateTask.id, 'private.bin');
    check((await bob.put(`${origin}${privateResource}`, { headers: { Origin: origin, 'Content-Type': 'application/octet-stream' }, data: binary })).status() === 201, 'Private control attachment creation failed.');
    const assets = [
      ['site/index.html', 'text/html', '<!doctype html><link rel="stylesheet" href="style.css"><button id="counter" onclick="this.textContent=String(Number(this.textContent)+1)">0</button><main id="reading-space">Long embedded document</main><script type="module" src="app.js"></script>'],
      ['site/style.css', 'text/css', 'button{color:rgb(17,99,155)}#reading-space{height:1800px}'],
      ['site/app.js', 'text/javascript', 'const response=await fetch("data.json");document.body.dataset.value=(await response.json()).value;'],
      ['site/data.json', 'application/json', '{"value":"combined-cookie-module"}'],
      ['docs/long.md', 'text/markdown', reading],
    ] as const;
    for (const [path, type, body] of assets) check((await bob.put(`${origin}${fileUrl(shared.id, task.id, path)}`, {
      headers: { Origin: origin, 'Content-Type': type }, data: body })).status() === 201, 'Shared preview resource creation failed.');
    const preview = previewUrl(shared.id, task.id, 'site/index.html');
    const protectedPaths = [`/api/v1/projects/${shared.id}`, `/api/v1/projects/${shared.id}/tasks`, `/api/v1/projects/${shared.id}/task-graph?taskId=${task.id}`,
      `/api/v1/projects/${shared.id}/tasks/${task.id}`, `/api/v1/projects/${shared.id}/tasks/${task.id}/attachments`, binaryResource, preview,
      `/api/v1/projects/${shared.id}/members`];
    const anonymousContext = await browser.newContext({ baseURL: origin }); contexts.push(anonymousContext);
    const anonymous = authenticatedAPI(anonymousContext.request);
    for (const path of protectedPaths) {
      await resourceStatus(bob, origin, 'GET', path, 200); await resourceStatus(anonymous, origin, 'GET', path, 401);
    }
    await request(anonymous, origin, 'HEAD', preview, 401);
    for (const path of [`/api/v1/projects/${privateProject.id}`, `/api/v1/projects/${privateProject.id}/tasks/${privateTask.id}`, privateResource]) await request(alice, origin, 'GET', path, 404);
    await bobPage.goto(`${origin}/projects/${shared.id}`);
    await bobPage.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption('zh-CN');
    await selectTaskList(bobPage);
    await bobPage.getByRole('tab', { name: '独立任务', exact: true }).click();
    await bobPage.locator(`#standalone-task-${task.id}`).click();
    const detail = bobPage.getByRole('dialog', { name: task.title, exact: true });
    await detail.getByRole('tab', { name: '附件', exact: true }).click();
    await (await attachmentFileButton(detail, 'site/index.html')).click();
    const frame = detail.frameLocator('iframe');
    await expect(frame.locator('body')).toHaveAttribute('data-value', 'combined-cookie-module');
    await expect(frame.locator('#counter')).toHaveCSS('color', 'rgb(17, 99, 155)');
    await frame.locator('#counter').click(); await expect(frame.locator('#counter')).toHaveText('1');
    await screenshots(bobPage, 'shared-preview-chinese');
    const fullscreen = await fullscreenPreview(bobPage, bobContext, origin, shared.id, task);
    await record('same-data-cli-browser', { projectId: shared.id, taskId: task.id, taskVersion: snapshot.version.toString(), path: 'shared/data.bin', bytes: binary.length, sha256: hash(binary), propertiesRetained: true, moduleAndRelativeFetch: true, fullscreen });
    const pending = await request<Invitation>(alice, origin, 'POST', `/api/v1/projects/${shared.id}/invitations`, 201, {});
    const pendingToken = new URL(pending.link).hash.slice(1); secrets.add(pendingToken);
    const memberSnapshot = encode(await request(alice, origin, 'GET', `/api/v1/projects/${shared.id}/members`, 200));
    receipt.restart = await options.restartTarget(run, signal); await save();
    check((await request<User>(alice, origin, 'GET', '/api/v1/me', 200)).id === aliceUser.id
      && (await request<User>(bob, origin, 'GET', '/api/v1/me', 200)).id === bobUser.id, 'Original sessions did not survive the owned restart.');
    check((await bobCli.read(binaryArgs)).equals(binary), 'Original PAT/CLI bytes did not survive restart.');
    const afterRestart = await request<Task>(bob, origin, 'GET', `/api/v1/projects/${shared.id}/tasks/${task.id}`, 200);
    check(encode(afterRestart) === encode(snapshot), 'Task properties/version changed across restart.');
    check(encode(await request(alice, origin, 'GET', `/api/v1/projects/${shared.id}/members`, 200)) === memberSnapshot, 'Original memberships changed across restart.');
    const inspected = await request<{ projectId: string }>(bob, origin, 'POST', '/api/v1/invitations/inspect', 200, { token: pendingToken });
    check(inspected.projectId === shared.id, 'Original pending invitation did not survive restart.');
    const activeInvites = await request<{ items: { id: string; consumedAt: string | null }[] }>(alice, origin, 'GET', `/api/v1/projects/${shared.id}/invitations`, 200);
    check(activeInvites.items.some((item) => item.id === pending.id && item.consumedAt === null), 'Restart or inspect consumed the pending invitation.');
    await bobPage.reload(); await expect(bobPage.getByRole('heading', { name: shared.name, exact: true })).toBeVisible();
    await record('restart-original-state', { originalSessions: true, originalPAT: true, memberships: true, pendingInvitationId: pending.id, taskAndFiles: true });
    await request(bob, origin, 'POST', '/api/v1/auth/logout', 204);
    await request(bob, origin, 'HEAD', preview, 401);
    check((await bobCli.read(binaryArgs)).equals(binary), 'Cookie logout invalidated the independent installed CLI PAT.');
    await request(tokenApi, origin, 'GET', `/api/v1/projects/${privateProject.id}`, 200);
    await record('logout-independent-pat', { cookieResourceStatus: 401, patResourceStatus: 200 });
    await signIn(bobContext, 'bob');
    await request(bob, origin, 'DELETE', `/api/v1/me/tokens/${originalToken.id}`, 204);
    await cliDenied(bobCli, ['task', 'show', task.id, '--project', shared.id, '--json'], 'unauthenticated');
    await request(tokenApi, origin, 'GET', binaryResource, 401);
    await request(bob, origin, 'GET', `/api/v1/me`, 200);
    await record('pat-revocation', { tokenId: originalToken.id, cliUnauthenticated: true, rawStatus: 401, cookieStillValid: true });
    const replacement = await pat(bob, 'Combined stream and expiry');
    const replacementCli = await cli(replacement.token, 'replacement-cli');
    const replacementApi = await tokenContext(playwrightRequest, origin, replacement.token); tokenClients.push(replacementApi);
    const body = Buffer.alloc(1_048_576); for (let index = 0; index < body.length; index++) body[index] = index % 251;
    const prefixBytes = 65_536, prefixSha256 = hash(body.subarray(0, prefixBytes));
    const probe = (path: string) => ({ projectId: shared.id, taskId: task.id, userId: bobUser.id, path, prefixBytes, prefixSha256 });
    const incomplete = (observation: UploadObservation, memberRows: number): boolean => observation.temporaryFiles === 1
      && observation.temporaryBytes === prefixBytes && observation.temporarySha256 === prefixSha256
      && !observation.finalExists && observation.metadataRows === 0 && observation.memberRows === memberRows;
    const abortPath = `admission/${randomUUID()}/abort.bin`;
    const abortRequestId = randomUUID();
    const aborted = await startAuthCombinedUpload({ origin, path: fileUrl(shared.id, task.id, abortPath), token: replacement.token, body, prefixBytes, requestId: abortRequestId, signal }); uploads.push(aborted);
    await waitFor(async () => incomplete(await controls.observeUpload(probe(abortPath)), 1), signal, 'aborted upload admission');
    check(!aborted.completed && aborted.sentBytes === prefixBytes, 'Aborted upload was not held with an incomplete body.');
    await aborted.disconnect(); await aborted.socketClosed;
    await waitFor(async () => { const observed = await controls.observeUpload(probe(abortPath)); return observed.temporaryFiles === 0 && !observed.finalExists && observed.metadataRows === 0 && observed.memberRows === 1; }, signal, 'aborted upload filesystem cleanup');
    const afterAbort = await request<Task>(alice, origin, 'GET', `/api/v1/projects/${shared.id}/tasks/${task.id}`, 200);
    check(afterAbort.version === snapshot.version && afterAbort.updatedAt === snapshot.updatedAt, 'Disconnected upload changed the task resource.');
    await request(bob, origin, 'GET', `/api/v1/projects/${privateProject.id}`, 200);
    await record('socket-disconnect', { path: abortPath, requestId: abortRequestId, prefixBytes, socketClosed: true, stagingRemoved: true, metadataRows: 0, taskUnchanged: true });
    const admittedPath = `admission/${randomUUID()}/complete.bin`;
    const admissionRequestId = randomUUID();
    const admitted = await startAuthCombinedUpload({ origin, path: fileUrl(shared.id, task.id, admittedPath), token: replacement.token, body, prefixBytes, requestId: admissionRequestId, signal }); uploads.push(admitted);
    await waitFor(async () => incomplete(await controls.observeUpload(probe(admittedPath)), 1), signal, 'real upload admission');
    check(!admitted.completed && admitted.sentBytes === prefixBytes, 'Admitted upload body was not incomplete.');
    const currentMembers = await request<{ items: Member[] }>(alice, origin, 'GET', `/api/v1/projects/${shared.id}/members`, 200);
    const currentMember = currentMembers.items.find((member) => member.userId === bobUser.id); check(currentMember !== undefined, 'Current member is missing before removal.');
    const removalStarted = performance.now();
    await request(alice, origin, 'DELETE', `/api/v1/projects/${shared.id}/members/${bobUser.id}`, 204, { version: currentMember.version });
    const removalMs = performance.now() - removalStarted;
    check(removalMs < 5_000 && !admitted.completed && admitted.sentBytes === prefixBytes, 'Member removal waited for the held upload IO.');
    const removedDuringIO = await controls.observeUpload(probe(admittedPath));
    check(incomplete(removedDuringIO, 0), 'Member removal did not commit while real file IO remained incomplete.');
    const completed = await admitted.complete();
    check(completed.status === 201 && /^application\/json(?:;|$)/i.test(completed.contentType) && completed.requestId === admissionRequestId,
      'Previously admitted upload failed or lost its JSON/request correlation after member removal.');
    check(decode<{ sizeBytes: number }>(completed.body.toString()).sizeBytes === body.length, 'Admitted response metadata has an unexpected byte size.');
    await admitted.socketClosed;
    await waitFor(async () => { const observed = await controls.observeUpload(probe(admittedPath)); return observed.temporaryFiles === 0 && observed.finalExists && observed.metadataRows === 1 && observed.memberRows === 0; }, signal, 'admitted upload publication');
    const final = await alice.get(`${origin}${fileUrl(shared.id, task.id, admittedPath)}`); check(final.status() === 200 && (await final.body()).equals(body), 'Admitted bytes differ after publication.');
    for (const path of [...protectedPaths, fileUrl(shared.id, task.id, admittedPath)]) await request(replacementApi, origin, 'GET', path, 404);
    await request(replacementApi, origin, 'HEAD', preview, 404);
    await resourceStatus(bob, origin, 'GET', preview, 404); await resourceStatus(bob, origin, 'HEAD', preview, 404);
    await cliDenied(replacementCli, binaryArgs, 'not_found');
    const privateArgs = ['task', 'attachment', 'read', privateTask.id, 'private.bin', '--project', privateProject.id];
    check((await replacementCli.read(privateArgs)).equals(binary), 'Removing shared membership changed private-project authority.');
    sameIds(await projectIds(bob, origin), [...b0, privateProject.id], 'Removed membership remained in paginated project results.');
    await bobPage.goto(`${origin}/projects/${shared.id}`);
    await expect(bobPage.getByRole('heading', { name: '项目不存在或你没有访问权限', exact: true })).toBeVisible();
    await screenshots(bobPage, 'shared-membership-removed');
    await record('admitted-member-removal', { projectId: shared.id, taskId: task.id, path: admittedPath, requestId: completed.requestId,
      responseContentType: completed.contentType, bytes: body.length, sha256: hash(body), prefixBytes, prefixSha256,
      removalMs, observedWhileBodyIncomplete: removedDuringIO, status: completed.status, newResourceStatus: 404, privateProjectStatus: 200 });
    const expired = await controls.expirePAT({ id: replacement.id, userId: bobUser.id });
    await cliDenied(replacementCli, privateArgs, 'unauthenticated');
    await request(replacementApi, origin, 'GET', privateResource, 401);
    const oldCookieContext = await playwrightRequest.newContext({ baseURL: origin, extraHTTPHeaders: { Cookie: originalBobSession.cookie } });
    const oldCookie = authenticatedAPI(oldCookieContext); tokenClients.push(oldCookie);
    await request(oldCookie, origin, 'GET', privateResource, 401);
    await request(bob, origin, 'HEAD', privateResource, 200);
    check((await request<User>(bob, origin, 'GET', '/api/v1/me', 200)).id === bobUser.id, 'PAT expiry invalidated the independent browser session.');
    await record('expired-pat', { tokenId: expired.id, expiresAt: expired.expiresAt, cliUnauthenticated: true, rawStatus: 401, oldCookieStatus: 401, currentCookieStatus: 200 });
    const logs = await options.readLogs(run);
    check(logs.length > 0, 'Target log capture is empty.');
    for (const path of receipt.screenshots) {
      check(resolve(path).startsWith(`${resolve(options.directory)}${sep}`), 'Combined screenshot lies outside its owned directory.');
      check((await readFile(path)).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Combined screenshot evidence is invalid.');
    }
    check([...secrets].every((secret) => secret.length === 0 || !logs.includes(secret)), 'Target logs contain an actual authentication secret.');
    const artifactFiles = async (directory: string): Promise<string[]> => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(async (entry) => entry.isDirectory() ? artifactFiles(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
    const retained = await artifactFiles(options.directory);
    for (const path of retained) {
      const bytes = await readFile(path);
      check([...secrets].every((secret) => secret.length === 0 || !bytes.includes(Buffer.from(secret))), 'Combined artifacts contain an actual authentication secret.');
    }
    check(!/(?:dnpat_|dninvite_|dnst_)[A-Za-z0-9_-]{16,}|daynight_session=[A-Za-z0-9_-]{16,}|authorization["'\s:=]+bearer[ \t]+[A-Za-z0-9._~-]{16,}/i.test(logs), 'Target logs contain credential-shaped diagnostics.');
    await record('secret-scan', { actualSecretsChecked: secrets.size, retainedFiles: retained.length, matches: 0 });
    receipt.result = 'passed';
  } catch (error) {
    failure = error instanceof CombinedFailure ? error : safeFailure(error instanceof AuthCombinedTransportError ? `${currentStep} (${error.category})` : currentStep);
    receipt.result = 'failed'; receipt.error = (failure as Error).message;
  } finally {
    signal.removeEventListener('abort', closeOnAbort);
    const cleanupErrors: string[] = [];
    try { await abortCliRecovery; } catch { cleanupErrors.push('Cancelled CLI recovery failed.'); }
    for (const upload of uploads) { try { await upload.close(); } catch { cleanupErrors.push('HTTP transfer cleanup failed.'); } }
    for (const client of tokenClients) { try { await client.dispose(); } catch { cleanupErrors.push('API context cleanup failed.'); } }
    for (const context of contexts) { try { await context.close(); } catch { cleanupErrors.push('Browser context cleanup failed.'); } }
    try { await browser?.close(); } catch { cleanupErrors.push('Browser close failed.'); }
    try { await abortClose; } catch { cleanupErrors.push('Cancelled browser close failed.'); }
    for (const client of clients) { try { await client.close(); } catch { cleanupErrors.push('CLI private-home cleanup failed.'); } }
    try { await recoverCliProcesses(options.target.acceptanceDirectory, options.installedReceiptPath, installed); } catch { cleanupErrors.push('CLI process recovery failed.'); }
    if (receipt.browserInventory !== undefined) {
      try { await recoverBrowsers(options.directory, receipt.browserInventory); receipt.browserCleanup = 'passed'; }
      catch { receipt.browserCleanup = 'failed'; cleanupErrors.push('Browser process/profile recovery failed.'); }
    }
    receipt.cleanup = cleanupErrors.length === 0 ? 'passed' : 'failed';
    if (cleanupErrors.length > 0) { receipt.cleanupErrors = cleanupErrors; receipt.result = 'failed'; failure = safeFailure('owned-resource cleanup'); }
    receipt.finishedAt = new Date().toISOString(); await save();
  }
  if (failure !== undefined) throw failure;
  return validateAuthCombinedReceipt(receipt, options.target);
};
