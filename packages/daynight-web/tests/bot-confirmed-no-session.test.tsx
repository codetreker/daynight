import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import * as sessions from '../src/api/sessions';
import { pauseAuthRequests } from '../src/api/client';
import { parseBot } from '../src/api/bots';
import { BotsPage } from '../src/features/bots/BotsPage';
import { getBotDisplaySnapshotCoordinator } from '../src/features/bots/display-snapshot-coordinator';
import type { BotDisplayPreview } from '../src/features/bots/display-snapshot';
import { BotSessionCache } from '../src/features/bots/session-cache';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { sessionFence } from '../../daynight/src/session/protocol';
import { botBinding, botFixture } from './helpers/bot-session';
import { botDefaults, botDefinition, botResponse } from './helpers/bots';
import { mockWideAssistantWorkspace } from './helpers/assistant-ui';
import { renderWithLocale } from './helpers/renderWithLocale';

async function fixture() {
  mockWideAssistantWorkspace();
  let pendingLock = Promise.resolve();
  const navigatorWithLocks = Object.create(navigator);
  Object.defineProperty(navigatorWithLocks, 'locks', { value: { request: (_name: string, run: () => Promise<unknown>) => {
    const result = pendingLock.then(run); pendingLock = result.then(() => {}, () => {}); return result;
  } } });
  vi.stubGlobal('navigator', navigatorWithLocks);
  const user = crypto.randomUUID();
  const previous = botFixture({ ...botBinding(1), ownerUserId: user }), next = botFixture({ ...botBinding(2), ownerUserId: user, botId: previous.binding.botId });
  for (const [bot, text] of [[previous, 'Previous live Session'], [next, 'New live Session']] as const) {
    vi.mocked(bot.api.timeline).mockResolvedValue({ ...bot.page, items: [{ kind: 'assistant_message', entryId: crypto.randomUUID(), entrySeq: '1', revision: '1', content: [{ type: 'text', text }] }] });
  }
  const definition = { ...botDefinition(), id: previous.binding.botId, ownerUserId: user, sessionId: previous.binding.sessionId, testExecutionId: previous.binding.testExecutionId, roleConfiguration: { instructions: 'role', revision: 'v1', digest: 'a'.repeat(64) }, startupResult: { state: 'ready' as const, code: null } };
  let response = Promise.withResolvers<Response>();
  const api = vi.spyOn(sessions, 'createBotSessionApi').mockImplementation(binding => binding.sessionId === previous.binding.sessionId ? previous.api : next.api);
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    const path = String(url);
    return path.endsWith(definition.id) ? response.promise : botResponse(path.includes('/defaults') ? botDefaults() : { items: [definition], nextCursor: null }, user);
  }));
  const scope = createTaskCacheScope({ userId: user, onIdentityMismatch: vi.fn() });
  const owner = getBotDisplaySnapshotCoordinator(scope);
  const preview: BotDisplayPreview = { schemaVersion: 1, ownerUserId: user, botId: definition.id, lastKnownBinding: previous.binding, botName: definition.name, fence: sessionFence(previous.snapshot()), historyEpoch: previous.snapshot().historyEpoch, lastEventSeq: '0', entries: [{ kind: 'assistant_message', entryId: crypto.randomUUID(), entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'Previously saved history' }] }], resources: [], savedAt: 1 };
  const save = async (botName = preview.botName) => {
    const lease = (await owner.store.observe(user, definition.id))!;
    expect(await owner.store.save(lease, { source: 'verified-history', historyLoaded: true, preview: { ...preview, botName } })).toBe('saved');
  };
  await save();
  const selections = vi.spyOn(BotSessionCache.prototype, 'select');
  const node = (enabled = true) => <TaskCacheProvider scope={scope}><BotsPage botId={definition.id} readEnabled={enabled} /></TaskCacheProvider>;
  const view = renderWithLocale(node(), { locale: 'en' });
  const answer = async (value: typeof definition | ReturnType<typeof absent>) => { parseBot(value, user, definition.id); await act(async () => { response.resolve(botResponse(value, user)); }); };
  const absent = (state: 'pending' | 'failed') => ({ ...definition, sessionId: null, testExecutionId: null, roleConfiguration: null, startupResult: { state, code: state === 'failed' ? 'startup_failed' : null } });
  const refresh = () => { response = Promise.withResolvers<Response>(); fireEvent.click(view.container.querySelector('.bot-refresh')!); };
  return { user, previous, next, definition, scope, owner, preview, api, node, view, save, answer, absent, refresh, cache: () => selections.mock.contexts.find(value => value instanceof BotSessionCache)!, async close() { view.unmount(); scope.dispose(); await owner.clearAccount(); owner.close(); } };
}

it.each(['pending', 'failed'] as const)('withdraws a saved preview after an authoritative %s detail confirms no Session', async state => {
  const f = await fixture();
  let resume: (() => void) | undefined;
  try {
    await screen.findByText('Previously saved history');
    expect(f.api).not.toHaveBeenCalled();
    await f.answer(f.absent(state));
    await waitFor(() => expect(f.view.container.querySelector('.bot-conversation-content > .bot-empty')).not.toBeNull());
    await waitFor(() => expect(screen.queryByText('Previously saved history')).toBeNull());
    await waitFor(async () => expect(await f.owner.store.read(f.user, f.definition.id, { touch: false })).toBeNull());
    resume = pauseAuthRequests(); f.view.rerender(f.node(false));
    expect(screen.queryByText('Previously saved history')).toBeNull();
    f.refresh(); resume(); resume = undefined; f.view.rerender(f.node());
    expect(screen.queryByText('Previously saved history')).toBeNull();
    expect(f.api).not.toHaveBeenCalled();
    expect(f.previous.api.command).not.toHaveBeenCalled();
  } finally { resume?.(); await f.close(); }
});

it('withdraws the resident client on confirmed no Session and admits a later confirmed real binding', async () => {
  const f = await fixture();
  try {
    await screen.findByText('Previously saved history');
    await f.answer(f.definition);
    await screen.findByText('Previous live Session');
    const input = screen.getByRole('textbox', { name: 'Message' }), oldPane = f.cache().snapshot()[0]!;
    fireEvent.change(input, { target: { value: 'Obsolete Session draft' } });
    f.refresh(); await f.answer(f.absent('pending'));
    await waitFor(() => expect(screen.queryByText('Previous live Session')).toBeNull());
    expect(screen.queryByText('Previously saved history')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    expect(f.cache().snapshot()).toHaveLength(0);
    await expect(oldPane.client.send('Stale Session callback')).rejects.toThrow();
    f.refresh();
    expect(screen.queryByText('Previous live Session')).toBeNull();
    await f.answer({ ...f.definition, sessionId: f.next.binding.sessionId, testExecutionId: f.next.binding.testExecutionId });
    await screen.findByText('New live Session');
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled());
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
    expect(f.cache().snapshot()[0]?.binding).toEqual(f.next.binding);
    expect(f.previous.channel.close).toHaveBeenCalled();
    expect(f.previous.api.command).not.toHaveBeenCalled(); expect(f.next.api.command).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('does not restore a saved preview from an in-flight read after no Session confirmation or auth recovery', async () => {
  const f = await fixture();
  const release = Promise.withResolvers<void>();
  const captured = Promise.withResolvers<BotDisplayPreview | null>();
  let resume: (() => void) | undefined;
  try {
    await screen.findByText('Previously saved history');
    const original = f.owner.store.read.bind(f.owner.store);
    vi.spyOn(f.owner.store, 'read').mockImplementation(async (...args) => { const result = await original(...args); captured.resolve(result); await release.promise; return result; });
    await act(() => f.save('Updated assistant'));
    expect(await captured.promise).not.toBeNull();
    await f.answer(f.absent('pending'));
    await waitFor(() => expect(screen.queryByText('Previously saved history')).toBeNull());
    resume = pauseAuthRequests(); f.view.rerender(f.node(false));
    await act(async () => { release.resolve(); await release.promise; });
    expect(screen.queryByText('Previously saved history')).toBeNull();
    f.refresh(); resume(); resume = undefined; f.view.rerender(f.node());
    expect(screen.queryByText('Previously saved history')).toBeNull();
    expect(f.api).not.toHaveBeenCalled(); expect(f.previous.api.command).not.toHaveBeenCalled();
  } finally { release.resolve(); resume?.(); await f.close(); }
});

it('records confirmed absence when requests pause before the cache commits it', () => {
  let paused = true;
  const bot = botFixture();
  const cache = new BotSessionCache({ userId: bot.binding.ownerUserId, isCurrent: () => true, isPaused: () => paused, storage: null, createApi: () => bot.api, onPrincipalMismatch: vi.fn() });
  try {
    cache.confirmNoSession(bot.binding.botId);
    expect(cache.isNoSession(bot.binding.botId)).toBe(true);
    cache.select(bot.binding, bot.binding);
    expect(cache.snapshot()).toHaveLength(0);
    paused = false;
    cache.select(bot.binding);
    expect(cache.snapshot()).toHaveLength(0);
    expect(bot.api.current).not.toHaveBeenCalled();
  } finally { cache.close(); }
});
