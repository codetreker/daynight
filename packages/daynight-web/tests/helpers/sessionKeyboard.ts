import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { sessionFence, type SessionSnapshot } from '../../../daynight/src/session/protocol';
import { detailFixture, graphFixture } from './taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from './taskSync';
import type { TaskSessionSnapshot } from './session';
import { stringifyWireJson } from './wireJson';
import { botDefaults, botDefinition } from './bots';
import type { SessionControls } from '../../../daynight/src/session/controls';

const source: TaskSessionSnapshot = JSON.parse(readFileSync(new URL('../../../daynight/test/session/fixtures/snapshot.json', import.meta.url), 'utf8'));
const projectId = source.identity.projectId, taskId = source.identity.taskId;
const taskRoot = `/api/v1/projects/${projectId}/tasks/${taskId}`;
const personalId = '00000000-0000-4000-8000-000000000701';
const time = '2026-11-06T00:00:00Z';
const controls: SessionControls = { revision: '3', settings: [
  { id: 'model', category: 'model', label: 'Model selection', description: null, value: 'native-a', mutable: true, scope: 'session', options: [{ value: 'native-a', label: 'A long native model name for layout verification' }, { value: 'native-b', label: 'Native B' }] },
  { id: 'permissions', category: 'permission', label: 'Approval policy', description: 'Native policy', value: 'ask', mutable: true, scope: 'session', options: [{ value: 'ask', label: 'Ask' }, { value: 'allow', label: 'Allow' }] },
], commands: Array.from({ length: 18 }, (_, index) => ({ id: `skill:review-${index}`, name: `review-${index}`, description: 'Review changes with a longer English description and 中文命令说明', argumentHint: 'Review instructions', available: true })), settingsError: null, commandsError: null };
const states = { idle: 'Ready', working: 'Working', waiting_input: 'Waiting for an answer', archived: 'Completed · Read-only history' } as const;
type State = keyof typeof states;
export type KeyboardEntry = 'task' | 'dialog' | 'test' | 'assistant';
type Content = 'short' | 'long' | 'empty';
export async function openKeyboardSession(page: Page, entry: KeyboardEntry, content: Content = 'long') {
  const locale = 'en', state = 'working' as State, errors = false;
  const taskEntry = entry === 'task' || entry === 'dialog';
  const provider = 'codex';
  const archived = state === 'archived';
  const taskSnapshot: TaskSessionSnapshot = { ...source, controls: errors ? { ...controls, commandsError: 'Native commands could not be refreshed. 原生命令刷新失败，已有命令仍可查看。', settingsError: 'Native settings could not be refreshed. 原生设置刷新失败。' } : controls, identity: { ...source.identity, provider }, lastEventSeq: '0', lastTimelineSeq: content === 'long' ? '30' : content === 'empty' ? '0' : '1',
    lifecycle: archived ? 'archived' : 'active', activity: archived ? 'idle' : state, connectionState: archived ? 'disconnected' : 'connected',
    currentTurnId: state === 'working' || state === 'waiting_input' ? 'column-fixture-turn' : null,
    operations: { canSend: state === 'idle' || state === 'working', canCancel: state === 'working' || state === 'waiting_input', canRespond: false } };
  const { claimId: _claim, identity: _identity, ...base } = taskSnapshot;
  const snapshot: SessionSnapshot = taskEntry ? taskSnapshot : { ...base, testExecutionId: '00000003-1111-4111-8111-111111111112',
    identity: { ownerUserId: TEST_VIEWER_ID, controllerId: source.identity.controllerId, controllerInstanceId: source.identity.controllerInstanceId, provider, agentControlMode: 'web', nativeSessionId: 'column-fixture' } };
  const root = taskEntry ? `${taskRoot}/sessions/${source.sessionId}` : `/api/v1/test-sessions/${source.sessionId}`;
  const entries = content === 'empty' ? [] : Array.from({ length: content === 'long' ? 30 : 1 }, (_, index) => ({ entryId: `00000009-1111-4111-8111-${String(index + 1).padStart(12, '0')}`, entrySeq: String(index + 1), revision: '1', kind: 'assistant_message', content: [{ type: 'text', text: content === 'long' ? `### Message ${index + 1}\n\nSession column acceptance conversation. Long content wraps within the reading column. 中文正文与输入框保持一致。\n\n\`\`\`text\n${'long_code_without_spaces_'.repeat(60)}\n\`\`\`` : 'Session column acceptance conversation' }] }));
  const bot = { ...botDefinition(), ownerUserId: TEST_VIEWER_ID, name: 'Column assistant', sessionId: snapshot.sessionId, testExecutionId: snapshot.testExecutionId!, roleConfiguration: { instructions: 'Fixture only.', revision: '1', digest: 'a'.repeat(64) }, startupResult: { state: 'ready', code: null } };
  const worker = { claimId: source.claimId, state: archived ? 'completed' : 'active', userId: TEST_VIEWER_ID, workerId: source.identity.workerId,
    machine: { id: source.identity.controllerId, name: 'Column fixture' }, platform: 'macos', agent: provider, agentControlMode: 'web',
    worktreeId: source.identity.worktreeId, phase: archived ? 'completing' : 'executing', herdr: null, nativeSessionId: 'native-thread', claimedAt: time };
  const detail = detailFixture(projectId, taskId, { title: 'Session column layout', status: archived ? 'done' : 'in_progress', ready: false,
    completedAt: archived ? time : null, properties: { worker } });
  const graph = graphFixture([detail]);
  const observations = { phase: 'opening', pageErrorPhases: [] as { phase: string; message: string }[], channels: 0, currentReads: 0, writes: [] as string[], pageErrors: [] as string[] };
  page.on('pageerror', error => { observations.pageErrors.push(error.message); observations.pageErrorPhases.push({ phase: observations.phase, message: error.message }); });
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  await page.routeWebSocket('**/channel*', socket => {
    observations.channels++;
    socket.send(JSON.stringify({ protocol: snapshot.protocol, type: 'snapshot', userId: TEST_VIEWER_ID, snapshot, cursor: 'zero' }));
  });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) observations.writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...extra } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/me/bots/defaults') return send(botDefaults());
    if (path === '/api/v1/me/bots') return send({ items: [bot], nextCursor: null });
    if (path === `/api/v1/me/bots/${bot.id}`) return send(bot);
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/members`) return send({ items: [{ userId: TEST_VIEWER_ID, profile: { name: 'Reader', email: null, avatarUrl: null }, effectiveRole: 'member', directGrant: directAccessFixture(projectId).directGrant, inheritedFrom: null }], actorAccess: directAccessFixture(projectId) });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => detail.version, propertiesForTask: () => detail.properties }));
    if (path === taskRoot) return send(detail, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
    if (path === `${taskRoot}/sessions`) return send({ items: [], nextCursor: null });
    if (path === (taskEntry ? `${taskRoot}/sessions/current` : root)) {
      observations.currentReads++; return send(taskEntry ? { status: 'registered', session: snapshot } : { session: snapshot });
    }
    if (path === `${root}/timeline`) return send({ sessionId: snapshot.sessionId, historyEpoch: snapshot.historyEpoch, items: entries, resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    if (path === `${root}/archive`) return send({ archive: { state: 'ready', sha256: 'a'.repeat(64), byteLength: '100', errorCode: null } });
    if (path === `${root}/archive/content`) return send({ archive: { schemaVersion: 1, ...sessionFence(snapshot), controllerId: snapshot.identity.controllerId, controllerInstanceId: snapshot.identity.controllerInstanceId, provider, nativeSessionId: snapshot.identity.nativeSessionId, entries, resources: [] } });
    if (path.endsWith('/steps')) return send({ projectId, taskId, version: detail.version, steps: [] });
    if (path.endsWith('/attachments')) return send({ items: [], nextCursor: null });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: source.sessionId } }, 404);
  });
  if (entry === 'dialog') {
    await page.goto(`/projects/${projectId}`);
    await page.locator('#project-section-tab-tasks').click();
    await page.getByRole('tab', { name: 'Standalone tasks', exact: true }).click();
    await page.locator(`#standalone-task-${taskId}`).click();
    await page.getByRole('tab', { name: 'Session', exact: true }).click();
  } else await page.goto(entry === 'assistant' ? `/bots/${bot.id}` : taskEntry ? `/projects/${projectId}/tasks/${taskId}?tab=session` : `/test-sessions/${source.sessionId}`);
  const header = page.locator('.session-header');
  if (entry !== 'assistant') await expect(header.locator('.session-status')).toHaveText(states[state]);
  await expect(page.locator('.session-timeline-content')).toBeAttached();
  if (!archived) await expect(page.locator('.session-composer textarea')).toBeVisible();
  if (content !== 'empty') await expect(page.locator('.session-entry')).toHaveCount(entries.length);
  return { header, observations };
}
