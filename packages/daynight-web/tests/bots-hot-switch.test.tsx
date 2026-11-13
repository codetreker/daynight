vi.mock('../src/api/assistant-tasks', async original => ({ ...await original<typeof import('../src/api/assistant-tasks')>(), listAssistantTasks: async () => ({items:[],nextCursor:null,observedAt:'2026-11-13T00:00:00Z'}) }));
import { useSyncExternalStore } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import * as sessions from '../src/api/sessions';
import { browserNavigation } from '../src/app/navigation';
import { parseAuthRoute } from '../src/app/router';
import { BotsPage } from '../src/features/bots/BotsPage';
import { BotDetailCache } from '../src/features/bots/detail-cache';
import { BotSessionCache } from '../src/features/bots/session-cache';
import type { TaskSessionClient } from '../src/features/task-agent-session/client';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { sessionFence, type SessionCommand, type SessionOperation } from '../../daynight/src/session/protocol';
import { botFixture } from './helpers/bot-session';
import { BOT_USER, botDefaults, botDefinition, botError, botId, botResponse } from './helpers/bots';
import { mockWideAssistantWorkspace } from './helpers/assistant-ui';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
beforeEach(mockWideAssistantWorkspace);
afterEach(() => scopes.splice(0).forEach(scope => scope.dispose()));
function scopeFixture() {
  const scope = createTaskCacheScope({ userId: BOT_USER, onIdentityMismatch: vi.fn() });
  scopes.push(scope); return scope;
}
function fixture(configure?: (live: ReturnType<typeof botFixture>[]) => void) {
  const scope = scopeFixture();
  const bots = [1, 2, 3, 4].map(n => ({ ...botDefinition(n), sessionId: botId(100 + n), testExecutionId: botId(200 + n), roleConfiguration: { instructions: 'Assistant instructions', revision: '1', digest: 'a'.repeat(64) }, startupResult: { state: 'ready' as const, code: null } }));
  const live = bots.map(bot => botFixture({ ownerUserId: BOT_USER, botId: bot.id, sessionId: bot.sessionId, testExecutionId: bot.testExecutionId }));
  configure?.(live);
  vi.spyOn(sessions, 'createBotSessionApi').mockImplementation(binding => live.find(bot => bot.binding.botId === binding.botId)!.api);
  const select = vi.spyOn(BotSessionCache.prototype, 'select');
  const delayed = new Map<string, ReturnType<typeof Promise.withResolvers<Response>>>();
  const reads: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    const path = String(url);
    if (path.includes('/defaults')) return botResponse(botDefaults());
    if (path.includes('?')) return botResponse({ items: bots, nextCursor: null });
    const bot = bots.find(value => path.endsWith(value.id));
    if (!bot) throw new Error(`Unexpected Bot read: ${path}`);
    reads.push(bot.id);
    return delayed.get(bot.id)?.promise ?? botResponse(bot);
  }));
  window.history.replaceState(null, '', `/bots/${bots[0]!.id}`);
  const navigation = browserNavigation();
  function Page({ enabled }: { enabled: boolean }) {
    const location = useSyncExternalStore(navigation.subscribe, navigation.snapshot);
    const route = parseAuthRoute(location.pathname);
    return <TaskCacheProvider scope={scope}><BotsPage botId={route.kind === 'bot' ? route.botId : null} readEnabled={enabled} /></TaskCacheProvider>;
  }
  const view = render(<Page enabled />);
  const resident = () => select.mock.contexts.find(value => value instanceof BotSessionCache)!;
  const input = () => screen.getByRole('textbox', { name: 'Message' });
  const choose = (n: number) => fireEvent.click(screen.getByRole('link', { name: new RegExp(`Assistant ${n}`) }));
  const delay = (n: number) => { const pending = Promise.withResolvers<Response>(); delayed.set(bots[n - 1]!.id, pending); return pending; };
  return { scope, bots, live, delayed, reads, view, navigation, resident, input, choose, delay, enabled: (enabled: boolean) => view.rerender(<Page enabled={enabled} />) };
}

const interaction = { interactionId: 'approval', revision: '1', state: 'pending' as const, kind: 'approval' as const, title: 'Run tool', detail: 'Tool request', actions: ['allow_once' as const] };
function receipt(command: SessionCommand, state: SessionOperation['state'] = 'confirmed'): SessionOperation {
  return { protocol: command.protocol, ...sessionFence(command), operationId: command.operationId, kind: command.kind, state, providerResult: 'handled', error: null };
}
function actionFixture() {
  return fixture(live => {
    const a = live[0]!;
    a.change({ ...a.snapshot(), activity: 'working', currentTurnId: 'turn-1', operations: { canSend: true, canCancel: true, canRespond: true }, controls: {
      revision: '4', settings: [{ id: 'model', category: 'model', label: 'Model', value: 'a', description: null, mutable: true, scope: 'session', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }],
      commands: [{ id: 'compact', name: 'compact', description: 'Compact', argumentHint: null, available: true }], settingsError: null, commandsError: null,
    } });
    vi.mocked(a.api.timeline).mockResolvedValue({ ...a.page, items: [...a.page.items, { kind: 'interaction', entryId: 'approval', entrySeq: '2', revision: '1', interaction }] });
    vi.mocked(a.api.command).mockImplementation(async (_id, command) => receipt(command));
  });
}
const actions = [
  { name: 'send', kind: 'send_message', invoke: (client: TaskSessionClient) => client.send('Local draft') },
  { name: 'cancel', kind: 'cancel', invoke: (client: TaskSessionClient) => client.cancel() },
  { name: 'respond', kind: 'interaction_response', invoke: (client: TaskSessionClient) => client.respond(interaction, { kind: 'approval', action: 'allow_once' }) },
  { name: 'updateSetting', kind: 'update_setting', invoke: (client: TaskSessionClient) => client.updateSetting('model', 'b', '4') },
  { name: 'executeCommand', kind: 'execute_command', invoke: (client: TaskSessionClient) => client.executeCommand('compact', '', '4', 'Local draft') },
  { name: 'refreshControls', kind: 'refresh_controls', invoke: (client: TaskSessionClient) => client.refreshControls() },
];
const stored = () => Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)]));
async function editableInput() {
  const input = await screen.findByRole('textbox', { name: 'Message' });
  await waitFor(() => expect(input).not.toHaveAttribute('readonly'));
  return input;
}

it('restores the original resident DOM and local state before the returning detail responds', async () => {
  localStorage.setItem(`daynight.web.session.display.v1:${JSON.stringify([BOT_USER, botId(101)])}`, '"standard"');
  // JSDOM has no layout. Supply a long Timeline with an earlier tool row in view.
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('session-timeline') ? 200 : 0; });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2600);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const key = this.dataset.entryKey;
    const top = key ? (key === 'before' ? 0 : key === 'tool' ? 500 : 1200) - this.closest('.session-timeline')!.scrollTop : 0;
    return new DOMRect(0, top, 1040, key ? 300 : 200);
  });
  const f = fixture(live => {
    const a = live[0]!;
    vi.mocked(a.api.timeline).mockResolvedValue({ ...a.page, items: [
      { kind: 'assistant_message', entryId: 'before', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'Earlier message' }] },
      { kind: 'tool_call', entryId: 'tool', entrySeq: '2', revision: '1', callId: 'call', name: 'shell', input: 'pwd', output: [{ type: 'text', text: 'Local tool output' }], status: 'completed', truncated: false },
      { kind: 'assistant_message', entryId: 'after', entrySeq: '3', revision: '1', content: [{ type: 'text', text: 'Later message' }] },
    ] });
  });
  const a = await editableInput();
  await waitFor(() => expect(f.resident().snapshot()[0]!.client.snapshot().historyReady).toBe(true));
  fireEvent.change(a, { target: { value: 'A local draft' } });
  const pane = f.resident().snapshot()[0]!, timeline = a.closest('.task-agent-session')!.querySelector<HTMLElement>('.session-timeline')!, reading = pane.reading.current;
  const expanded = timeline.querySelector<HTMLDetailsElement>('details.session-tool')!;
  expanded.open = true; fireEvent(expanded, new Event('toggle'));
  await screen.findByText('Local tool output');
  timeline.scrollTop = 470; fireEvent.wheel(timeline, { deltaY: -120 }); fireEvent.scroll(timeline);
  const bookmark = reading!.captureBookmark();
  expect(bookmark).toMatchObject({ following: false, anchor: { key: 'tool', top: 30 } });
  f.choose(2); await screen.findByText(`Message ${f.bots[1]!.id}`);
  const pending = f.delay(1); f.choose(1);
  expect(f.input()).toBe(a); expect(a).toHaveValue('A local draft');
  expect(a.closest('.task-agent-session')!.querySelector('.session-timeline')).toBe(timeline);
  expect(timeline.querySelector('details.session-tool')).toBe(expanded); expect(expanded.open).toBe(true); expect(timeline.scrollTop).toBe(470);
  expect(pane.reading.current).toBe(reading); expect(reading!.captureBookmark()).toEqual(bookmark);
  await expect(pane.client.send('a stale callback')).rejects.toThrow();
  expect(f.live[0]!.api.command).not.toHaveBeenCalled();
  fireEvent.change(a, { target: { value: 'Edited while reconfirming' } }); expect(a).toHaveValue('Edited while reconfirming');
  expect(f.live[0]!.api.current).toHaveBeenCalledOnce(); expect(f.live[0]!.api.channel).toHaveBeenCalledOnce();
  await act(async () => pending.resolve(botResponse(f.bots[0])));
  await waitFor(() => expect(pane.client.snapshot().actionAdmitted).toBe(true));
});

it.each(actions)('freezes $name before the navigation commit and rejects it until the returning detail is confirmed', async ({ invoke, kind }) => {
  const f = actionFixture(), input = await editableInput();
  await waitFor(() => expect(f.resident().snapshot()[0]!.client.snapshot()).toMatchObject({ actionAdmitted: true, historyReady: true }));
  fireEvent.change(input, { target: { value: 'Local draft' } });
  const a = f.resident().snapshot()[0]!, api = f.live[0]!.api, staleCall = () => invoke(a.client);
  const before = a.client.snapshot(), disk = stored(), uuid = vi.spyOn(crypto, 'randomUUID');
  const unchanged = () => {
    const current = a.client.snapshot();
    expect(current).toMatchObject({ actionAdmitted: false, connected: true, authPaused: false });
    expect(current.state.operations).toBe(before.state.operations);
    expect(current.state.responseTargets).toBe(before.state.responseTargets);
    expect(current.operationProgress).toBe(before.operationProgress);
    expect(current.settingIntents).toBe(before.settingIntents);
    expect(current.draft).toBe(before.draft);
    expect(current.draft.submission).toBeNull();
    expect(stored()).toEqual(disk);
    expect(uuid).not.toHaveBeenCalled();
    expect(api.command).not.toHaveBeenCalled();
  };
  f.delay(2);
  let rejected: Promise<void>;
  act(() => {
    f.navigation.navigate(`/bots/${f.bots[1]!.id}`);
    expect(uuid).toHaveBeenCalledOnce(); // The navigation entry has its own identity.
    uuid.mockClear();
    expect(screen.getByRole('heading', { name: 'Assistant 1' })).toBeVisible();
    rejected = expect(staleCall()).rejects.toThrow('Session actions are not currently admitted.');
    unchanged();
  });
  await rejected!; unchanged();
  expect(screen.getByRole('heading', { name: 'Assistant 2' })).toBeVisible();

  const pending = f.delay(1); f.choose(1);
  expect(uuid).toHaveBeenCalledOnce(); uuid.mockClear();
  expect(f.input()).toBe(input);
  await expect(staleCall()).rejects.toThrow('Session actions are not currently admitted.');
  unchanged();
  await act(async () => pending.resolve(botResponse(f.bots[0])));
  await waitFor(() => expect(a.client.snapshot().actionAdmitted).toBe(true));
  expect(api.command).not.toHaveBeenCalled();
  expect(uuid).not.toHaveBeenCalled();
  expect(a.client.snapshot().state.operations.size).toBe(0);
  expect(a.client.snapshot().draft.submission).toBeNull();
  expect(a.client.snapshot().settingIntents.size).toBe(0);

  await act(async () => staleCall());
  expect(api.command).toHaveBeenCalledExactlyOnceWith(a.binding.sessionId, expect.objectContaining({ kind }), expect.any(AbortSignal));
  expect(uuid).toHaveBeenCalled();
  expect(api.current).toHaveBeenCalledOnce(); expect(api.channel).toHaveBeenCalledOnce();
});

it('queries an original unknown operation while the returning detail is frozen without replaying or clearing a newer draft', async () => {
  const f = actionFixture(), input = await editableInput();
  await waitFor(() => expect(f.resident().snapshot()[0]!.client.snapshot()).toMatchObject({ actionAdmitted: true, historyReady: true }));
  const a = f.resident().snapshot()[0]!, api = f.live[0]!.api;
  fireEvent.change(input, { target: { value: 'Original submission' } });
  vi.mocked(api.command).mockRejectedValueOnce(new Error('Lost command receipt'));
  await act(async () => { await expect(a.client.send('Original submission')).rejects.toThrow('Lost command receipt'); });
  const command = vi.mocked(api.command).mock.calls[0]![1];
  expect(a.client.snapshot().state.operations.get(command.operationId)?.state).toBe('unknown');
  expect(a.client.snapshot().draft.submission?.operationId).toBe(command.operationId);

  f.choose(2); await screen.findByText(`Message ${f.bots[1]!.id}`);
  const pending = f.delay(1); f.choose(1);
  expect(f.input()).toBe(input); expect(input).toHaveValue('Original submission');
  expect(a.client.snapshot().actionAdmitted).toBe(false);
  fireEvent.change(input, { target: { value: 'Edited while checking the original receipt' } });
  const draft = a.client.snapshot().draft, uuid = vi.spyOn(crypto, 'randomUUID');
  const queried = Promise.withResolvers<SessionOperation>();
  vi.mocked(api.operation).mockReturnValueOnce(queried.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Check original operation' }));
  expect(api.operation).toHaveBeenCalledExactlyOnceWith(command.sessionId, command.operationId, expect.any(AbortSignal));
  expect(a.client.snapshot().checking.has(command.operationId)).toBe(true);
  expect(a.client.snapshot().actionAdmitted).toBe(false);
  await act(async () => queried.resolve(receipt(command, 'provider_accepted')));
  expect(a.client.snapshot().state.operations.get(command.operationId)?.state).toBe('provider_accepted');
  expect(a.client.snapshot().checking.size).toBe(0);
  expect(a.client.snapshot().actionAdmitted).toBe(false);
  expect(a.client.snapshot().draft).toMatchObject({ text: draft.text, revision: draft.revision, submission: null });
  expect(input).toHaveValue('Edited while checking the original receipt');
  expect(uuid).not.toHaveBeenCalled(); expect(api.command).toHaveBeenCalledOnce();

  await act(async () => pending.resolve(botResponse(f.bots[0])));
  await waitFor(() => expect(a.client.snapshot().actionAdmitted).toBe(true));
  expect(api.command).toHaveBeenCalledOnce(); expect(api.operation).toHaveBeenCalledOnce();
  expect(a.client.snapshot().state.operations.size).toBe(1);
  expect(input).toHaveValue('Edited while checking the original receipt');
  expect(uuid).not.toHaveBeenCalled();
  expect(api.current).toHaveBeenCalledOnce(); expect(api.channel).toHaveBeenCalledOnce();
});

it('does not freeze the current client on same-target or cancelled guarded navigation', async () => {
  const f = fixture(); await screen.findByRole('textbox', { name: 'Message' });
  await waitFor(() => expect(f.resident().snapshot()[0]!.client.snapshot().actionAdmitted).toBe(true));
  const a = f.resident().snapshot()[0]!;
  f.choose(1); expect(a.client.snapshot().actionAdmitted).toBe(true);
  const detach = f.navigation.register({ scope: { identity: f.scope, projectId: botId(700), taskId: botId(701) }, isDirty: () => true, discard: vi.fn(), survives: () => false });
  f.choose(2); expect(f.navigation.decision()).not.toBeNull();
  expect(a.client.snapshot().actionAdmitted).toBe(true);
  act(() => f.navigation.cancel());
  expect(f.input()).toBeVisible(); expect(a.client.snapshot().actionAdmitted).toBe(true); detach();
});

it.each(['?reading=older', '#reading'])('keeps the same Bot admitted when only the location suffix changes to %s', async suffix => {
  const f = fixture(); const input = await screen.findByRole('textbox', { name: 'Message' });
  await waitFor(() => expect(f.resident().snapshot()[0]!.client.snapshot().actionAdmitted).toBe(true));
  const pane = f.resident().snapshot()[0]!;
  act(() => f.navigation.navigate(`/bots/${f.bots[0]!.id}${suffix}`));
  expect(pane.client.snapshot().actionAdmitted).toBe(true); expect(f.input()).toBe(input);
});

it('readmits the committed A when admitted A/B/A navigation is batched into one commit', async () => {
  const f = fixture(); const input = await screen.findByRole('textbox', { name: 'Message' });
  await waitFor(() => expect(f.resident().snapshot()[0]!.client.snapshot().actionAdmitted).toBe(true));
  const pane = f.resident().snapshot()[0]!;
  act(() => { f.navigation.navigate(`/bots/${f.bots[1]!.id}`); f.navigation.navigate(`/bots/${f.bots[0]!.id}`); });
  expect(f.input()).toBe(input); expect(pane.client.snapshot().actionAdmitted).toBe(true);
  expect(f.live[0]!.api.current).toHaveBeenCalledOnce(); expect(f.live[1]!.api.current).not.toHaveBeenCalled();
});

it('keeps C selected when cancelled A and B detail reads resolve out of order', async () => {
  const f = fixture(); await screen.findByRole('textbox', { name: 'Message' });
  const a = f.delay(1), b = f.delay(2), c = f.delay(3);
  f.choose(2); await waitFor(() => expect(f.reads).toContain(f.bots[1]!.id));
  f.choose(1); await waitFor(() => expect(f.reads.filter(id => id === f.bots[0]!.id)).toHaveLength(2));
  f.choose(3); await waitFor(() => expect(f.reads).toContain(f.bots[2]!.id));
  await act(async () => c.resolve(botResponse(f.bots[2]))); await screen.findByText(`Message ${f.bots[2]!.id}`);
  const input = await editableInput(); fireEvent.change(input, { target: { value: 'C only' } });
  await act(async () => { b.resolve(botResponse(f.bots[1])); a.resolve(botResponse(f.bots[0])); });
  expect(f.input()).toBe(input); expect(input).toHaveValue('C only');
  expect(screen.getByRole('heading', { name: 'Assistant 3' })).toBeVisible();
  expect(f.live[1]!.api.current).not.toHaveBeenCalled();
});

it('retains readable DOM but revokes new actions during read admission pause', async () => {
  const f = fixture(); const input = await editableInput();
  await waitFor(() => expect(f.resident().snapshot()[0]!.client.snapshot().actionAdmitted).toBe(true));
  const pane = f.resident().snapshot()[0]!; fireEvent.change(input, { target: { value: 'Kept across pause' } });
  f.enabled(false); expect(f.input()).toBe(input);
  await expect(pane.client.send('while disabled')).rejects.toThrow(); expect(f.live[0]!.api.command).not.toHaveBeenCalled();
  const pending = f.delay(1); f.enabled(true);
  expect(f.input()).toBe(input); expect(input).toHaveValue('Kept across pause');
  await act(async () => pending.resolve(botResponse(f.bots[0])));
  await waitFor(() => expect(pane.client.snapshot().actionAdmitted).toBe(true));
});

it('preserves action admission during an ordinary poll and keeps the resident readable through failure and retry', async () => {
  const timers = vi.spyOn(globalThis, 'setInterval');
  const f = fixture(); const input = await editableInput();
  await waitFor(() => expect(f.resident().snapshot()[0]!.client.snapshot().actionAdmitted).toBe(true));
  const pane = f.resident().snapshot()[0]!, timeline = input.closest('.task-agent-session')!.querySelector('.session-timeline');
  fireEvent.change(input, { target: { value: 'Readable through a transient failure' } });
  const poll = f.delay(1), before = f.reads.length;
  await act(async () => { for (const [run, delay] of timers.mock.calls) if (delay === 5_000 && typeof run === 'function') run(); });
  await waitFor(() => expect(f.reads.length).toBeGreaterThan(before));
  expect(pane.client.snapshot().actionAdmitted).toBe(true); expect(f.input()).toBe(input);
  await act(async () => poll.reject(new TypeError('Temporary detail outage')));
  await screen.findByText('Could not load this assistant.');
  expect(f.input()).toBe(input); expect(input).toHaveValue('Readable through a transient failure');
  expect(input.closest('.task-agent-session')!.querySelector('.session-timeline')).toBe(timeline);
  await expect(pane.client.send('failed confirmation')).rejects.toThrow(); expect(f.live[0]!.api.command).not.toHaveBeenCalled();
  f.delayed.delete(f.bots[0]!.id); fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(pane.client.snapshot().actionAdmitted).toBe(true)); expect(f.input()).toBe(input);
});

it('removes every resident on scope revocation and rejects the previous client', async () => {
  const f = fixture(); const a = await screen.findByRole('textbox', { name: 'Message' });
  const pane = f.resident().snapshot()[0]!; f.choose(2); await screen.findByText(`Message ${f.bots[1]!.id}`);
  act(() => f.scope.dispose());
  expect(a.isConnected).toBe(false); expect(f.view.container.querySelectorAll('.bot-session-pane')).toHaveLength(0);
  await expect(pane.client.send('old account')).rejects.toThrow(); expect(f.live[0]!.api.command).not.toHaveBeenCalled();
});

it.each([403, 404, 410])('revokes the resident and refuses an old callback after authoritative %s', async status => {
  const f = fixture(); const input = await screen.findByRole('textbox', { name: 'Message' });
  const pane = f.resident().snapshot()[0]!, pending = f.delay(1);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await act(async () => pending.resolve(botError(status, 'unavailable')));
  await waitFor(() => expect(input.isConnected).toBe(false));
  await expect(pane.client.send('revoked')).rejects.toThrow(); expect(f.live[0]!.api.command).not.toHaveBeenCalled();
});

it('exposes a confirmed active detail without a Session and preserves it across ordinary polling', () => {
  const scope = scopeFixture(), cache = new BotDetailCache(scope), selection = { botId: botId(1) };
  cache.select(selection, new Set()); const first = cache.begin()!; cache.accept(first, botDefinition(1));
  expect(cache.read(selection).confirmed).toBe(true); expect(cache.read(selection).actionBinding).toBeNull();
  const poll = cache.begin()!; expect(cache.read(selection).confirmed).toBe(true);
  cache.fail(poll, new ApiError('network')); expect(cache.read(selection).confirmed).toBe(false);
  const retry = cache.begin()!; cache.accept(retry, botDefinition(1)); expect(cache.read(selection).confirmed).toBe(true);
  const next = { botId: botId(1) }; cache.select(next, new Set([botId(1)]));
  expect(cache.read(next).value?.name).toBe('Assistant 1'); expect(cache.read(next).confirmed).toBe(false);
  cache.close();
});
