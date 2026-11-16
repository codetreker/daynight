import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BotSessionCache } from '../src/features/bots/session-cache';
import { BotSessionHost, useBotSessionCache } from '../src/features/bots/BotSessionHost';
import { pauseAuthRequests } from '../src/api/client';
import { BotsPage } from '../src/features/bots/BotsPage';
import * as sessions from '../src/api/sessions';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { botDefaults, botDefinition, botResponse } from './helpers/bots';
import { createLocaleRender } from './helpers/renderWithLocale';
import { botBinding, botFixture, botOwner } from './helpers/bot-session';
import { sessionFence, sessionFenceKey } from '../../daynight/src/session/protocol';
import type { SessionArchive } from '../../daynight/src/session/archive';
const render = createLocaleRender('en');
const caches: BotSessionCache[] = [];
afterEach(() => { caches.splice(0).forEach(cache => cache.close()); });
it('stops every Bot Session synchronously and stops panes created during account pause', async () => {
  const first = botFixture(botBinding(1)), second = botFixture(botBinding(2));
  const scope = createTaskCacheScope({ userId: botOwner, onIdentityMismatch: vi.fn() });
  const api = vi.spyOn(sessions, 'createBotSessionApi').mockImplementation(binding => binding.botId === first.binding.botId ? first.api : second.api);
  let cache!: BotSessionCache;
  const Owner = () => { cache = useBotSessionCache(); return null; };
  const view = render(<TaskCacheProvider scope={scope}><Owner /></TaskCacheProvider>);
  let resume = () => {};
  try {
    act(() => cache.select(first.binding, first.binding));
    await waitFor(() => expect(first.api.channel).toHaveBeenCalledOnce());
    const pane = cache.snapshot()[0]!;
    act(() => pane.client.setDraft('local draft'));
    act(() => { resume = pauseAuthRequests(); expect(first.channel.close).toHaveBeenCalledOnce(); });
    expect(pane.client.snapshot().draft.text).toBe('local draft');
    act(() => cache.select(second.binding));
    const later = cache.snapshot().find(value => value.binding.botId === second.binding.botId)!;
    expect(later.client.snapshot().authPaused).toBe(true);
    expect(second.api.current).not.toHaveBeenCalled();
  } finally { resume(); view.unmount(); scope.dispose(); api.mockRestore(); }
});
function fixture() {
  const bots = [1, 2, 3, 4].map(n => botFixture(botBinding(n)));
  const cache = new BotSessionCache({ userId: botOwner, isCurrent: () => true, storage: null, onPrincipalMismatch: vi.fn(), createApi: binding => bots.find(bot => bot.binding.botId === binding.botId)!.api }); caches.push(cache);
  const view = render(<BotSessionHost cache={cache} displayBinding={botBinding(1)} actionBinding={botBinding(1)} />);
  const select = async (n: number) => { view.rerender(<BotSessionHost cache={cache} displayBinding={botBinding(n)} actionBinding={botBinding(n)} />); await waitFor(() => { const input = screen.getByRole('textbox', { name: 'Message' }); expect(input).toBeEnabled(); expect(input).not.toHaveAttribute('readonly'); }); };
  return { bots, cache, view, select };
}
it('gives Bot provider settings named-container touch presentation through the shared composer', async () => {
  const bot = botFixture();
  bot.change({ ...bot.snapshot(), controls: { revision: '1', settings: [
    { id: 'model', category: 'model', label: 'Model selection', description: null, value: 'native-a', mutable: true, scope: 'session',
      options: [{ value: 'native-a', label: 'Native A' }, { value: 'native-b', label: 'Native B' }] },
  ], commands: [], settingsError: null, commandsError: null } });
  const cache = new BotSessionCache({ userId: botOwner, isCurrent: () => true, storage: null, onPrincipalMismatch: vi.fn(), createApi: () => bot.api });
  caches.push(cache);
  render(<BotSessionHost cache={cache} displayBinding={bot.binding} actionBinding={bot.binding} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Model' }));
  const select = screen.getByRole('combobox', { name: 'Model' });
  expect(select.parentElement).toHaveAttribute('data-touch-mode', 'container');
  expect(select.parentElement).toHaveAttribute('data-density', 'form');
  expect(select.parentElement).toHaveAttribute('data-layout', 'fill');
  expect(select).toHaveValue('native-a');
  expect(bot.api.command).not.toHaveBeenCalled();
});

it('retains the actual shared Session DOM and independent drafts across A/B/A and releases a fourth pane', async () => {
  const f = fixture(); await f.select(1);
  const shell = f.view.container.firstElementChild, a = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(a, { target: { value: 'draft A' } }); const session = a.closest('.task-agent-session');
  const pane = f.cache.snapshot()[0]!, client = pane.client, reading = pane.reading.current;
  const timeline = session!.querySelector('.session-timeline');
  expect(reading).not.toBeNull();
  const bookmark = reading!.captureBookmark();
  expect(bookmark).not.toBeNull();
  await f.select(2); const b = screen.getByRole('textbox', { name: 'Message' }); fireEvent.change(b, { target: { value: 'draft B' } });
  expect(a.closest('[data-bot-id]')).toHaveAttribute('hidden'); expect(a.closest('[data-bot-id]')).toHaveAttribute('inert');
  await f.select(1); expect(screen.getByRole('textbox', { name: 'Message' })).toBe(a); expect(a).toHaveValue('draft A'); expect(a.closest('.task-agent-session')).toBe(session);
  expect(f.cache.snapshot().find(item => item.key === pane.key)).toBe(pane);
  expect(pane.client).toBe(client); expect(pane.reading.current).toBe(reading);
  expect(pane.reading.current!.captureBookmark()).toEqual(bookmark);
  expect(session!.querySelector('.session-timeline')).toBe(timeline);
  expect(f.bots[0]!.api.current).toHaveBeenCalledOnce();
  expect(f.bots[0]!.api.channel).toHaveBeenCalledOnce();
  expect(f.view.container.firstElementChild).toBe(shell);
  await f.select(3); await f.select(4); expect(f.view.container.querySelectorAll('[data-bot-id]')).toHaveLength(3); expect(b.isConnected).toBe(false); expect(a.isConnected).toBe(true);
  await f.select(2); expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('draft B');
  expect(f.bots.every(bot => vi.mocked(bot.api.command).mock.calls.length === 0)).toBe(true);
});
it('removes all private content on access loss, including hidden panes', async () => {
  const f = fixture(); await f.select(1); await f.select(2);
  act(() => f.cache.invalidate());
  expect(f.view.container.querySelectorAll('[data-bot-id]')).toHaveLength(0);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(f.bots[0]!.channel.close).toHaveBeenCalledOnce(); expect(f.bots[1]!.channel.close).toHaveBeenCalledOnce();
});
it('shows no old target while the new binding is unavailable and restores it without a restart', async () => {
  const f = fixture(); await f.select(1); const a = screen.getByRole('textbox');
  f.view.rerender(<BotSessionHost cache={f.cache} displayBinding={null} actionBinding={null} />);
  expect(screen.queryByRole('textbox')).toBeNull(); expect(a.isConnected).toBe(true);
  await f.select(1); expect(screen.getByRole('textbox')).toBe(a); expect(f.bots[0]!.api.current).toHaveBeenCalledOnce();
});

it('revokes old callbacks when the committed target or active state no longer admits the binding', async () => {
  const f = fixture(); await f.select(1); const a = screen.getByRole('textbox'), pane = f.cache.snapshot()[0]!;
  f.view.rerender(<BotSessionHost cache={f.cache} botId={botBinding(2).botId} displayBinding={pane.binding} actionBinding={pane.binding} />);
  expect(screen.queryByRole('textbox')).toBeNull(); expect(a.isConnected).toBe(true);
  await expect(pane.client.send('wrong committed target')).rejects.toThrow();
  f.view.rerender(<BotSessionHost cache={f.cache} displayBinding={pane.binding} actionBinding={pane.binding} active={false} />);
  await expect(pane.client.send('inactive callback')).rejects.toThrow();
  expect(f.bots[0]!.api.command).not.toHaveBeenCalled(); expect(f.bots[0]!.channel.close).not.toHaveBeenCalled();
  f.view.rerender(<BotSessionHost cache={f.cache} displayBinding={pane.binding} actionBinding={pane.binding} />);
  expect(screen.getByRole('textbox')).toBe(a); expect(pane.client.snapshot().actionAdmitted).toBe(true);
});

it.each(['deadline', 'buffer', 'transport'] as const)('retains the pane and client while %s forces a paused channel to reconnect', async reason => {
  const bot=botFixture(); let paused=false, onClose: (error?:unknown)=>void=()=>{};
  const original=vi.mocked(bot.api.channel).getMockImplementation()!;
  vi.mocked(bot.api.channel).mockImplementation((id,after,onMessage,close)=>{onClose=close;return original(id,after,onMessage,close);});
  const cache=new BotSessionCache({userId:botOwner,isCurrent:()=>true,isPaused:()=>paused,storage:null,onPrincipalMismatch:vi.fn(),createApi:()=>bot.api}); caches.push(cache);
  const view=render(<BotSessionHost cache={cache} displayBinding={bot.binding} actionBinding={bot.binding} />);
  const input=await screen.findByRole('textbox',{name:'Message'}); await waitFor(()=>expect(input).toBeEnabled());
  await waitFor(() => expect(input).not.toHaveAttribute('readonly'));
  const pane=cache.snapshot()[0]!, client=pane.client, timeline=view.container.querySelector('.session-timeline');
  fireEvent.change(input,{target:{value:'kept draft'}}); const firstGeneration=client.snapshot().connectionGeneration;
  const now=Date.now(); let clock: ReturnType<typeof vi.spyOn>|undefined;
  try {
    // Anchor suspension and expiry to the same clock, independent of render time.
    if(reason==='deadline') clock=vi.spyOn(Date,'now').mockReturnValue(now);
    act(()=>{paused=true;cache.syncAvailability();});
    expect(client.snapshot().authPaused).toBe(true);
    if(reason==='deadline') clock!.mockReturnValue(now+60_001);
    if(reason==='buffer') act(()=>{for(let n=0;n<1001;n++)bot.receive({protocol:bot.snapshot().protocol,type:'snapshot',userId:botOwner,snapshot:bot.snapshot(),cursor:'queued'});});
    if(reason==='transport') act(()=>onClose(new Error('transport interrupted')));
    expect(screen.getByRole('textbox',{name:'Message'})).toBe(input); expect(input).toHaveValue('kept draft');
    act(()=>{paused=false;cache.syncAvailability();});
    clock?.mockRestore(); clock=undefined;
    await waitFor(()=>expect(vi.mocked(bot.api.channel).mock.calls.length).toBe(2));
    await waitFor(()=>expect(client.snapshot().connected).toBe(true));
    expect(cache.snapshot()[0]).toBe(pane); expect(cache.snapshot()[0]!.client).toBe(client);
    expect(screen.getByRole('textbox',{name:'Message'})).toBe(input); expect(input).toHaveValue('kept draft');
    expect(view.container.querySelector('.session-timeline')).toBe(timeline);
    expect(client.snapshot().connectionGeneration).toBeGreaterThan(firstGeneration);
    expect(vi.mocked(bot.api.channel).mock.calls[1]![1]).toBe('zero');
    expect(bot.api.command).not.toHaveBeenCalled();
  } finally {clock?.mockRestore();}
});

it('retains a cold bookmark on failed history and resumes the same target through local retry', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('session-timeline') ? 200 : 0; });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ top: 0, bottom: 200, left: 0, right: 400, x: 0, y: 0, width: 400, height: 200, toJSON() {} }));
  const bot = botFixture(), cache = new BotSessionCache({ userId: botOwner, isCurrent: () => true, storage: null, onPrincipalMismatch: vi.fn(), createApi: () => bot.api }); caches.push(cache);
  cache.select(bot.binding); const old = cache.snapshot()[0]!;
  await waitFor(() => expect(old.client.snapshot().connected).toBe(true));
  const { sessionFenceKey } = await import('../../daynight/src/session/protocol');
  const bookmark = { identity: JSON.stringify([old.key, sessionFenceKey(bot.snapshot())]), historyEpoch: bot.snapshot().historyEpoch, following: false, anchor: { key: 'early', top: 0 } };
  old.retained.bookmark = bookmark; cache.close();
  let older = 0;
  vi.mocked(bot.api.timeline).mockImplementation(async (_id, direction) => {
    if (direction === 'tail') return { ...bot.page, beforeCursor: 'before', hasMoreBefore: true };
    if (++older === 1) throw Error('older history unavailable');
    return { ...bot.page, items: [{ kind: 'assistant_message', entryId: 'early', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'Original reading target' }] }] };
  });
  render(<BotSessionHost cache={cache} displayBinding={bot.binding} actionBinding={bot.binding} />);
  await screen.findByText('older history unavailable');
  expect(cache.snapshot()[0]!.reading.current?.captureBookmark()).toEqual(bookmark);
  expect(older).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));
  await screen.findByText('Original reading target');
  await waitFor(() => expect(cache.snapshot()[0]!.reading.current?.getRestoreStatus()).toBe('restored'));
  expect(older).toBe(2);
});

it.each([false, true])('resumes canceled cold history after Controller replacement (delayed readiness: %s)', async delayed => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('session-timeline') ? 200 : 0; });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ top: 0, bottom: 200, left: 0, right: 400, x: 0, y: 0, width: 400, height: 200, toJSON() {} }));
  const bot = botFixture(), cache = new BotSessionCache({ userId: botOwner, isCurrent: () => true, storage: null, onPrincipalMismatch: vi.fn(), createApi: () => bot.api }); caches.push(cache);
  cache.select(bot.binding); const old = cache.snapshot()[0]!;
  await waitFor(() => expect(old.client.snapshot().connected).toBe(true));
  const { sessionFenceKey } = await import('../../daynight/src/session/protocol');
  old.retained.bookmark = { identity: JSON.stringify([old.key, sessionFenceKey(bot.snapshot())]), historyEpoch: bot.snapshot().historyEpoch, following: false, anchor: { key: 'early', top: 0 } };
  cache.close();
  let older = 0, canceled = false;
  vi.mocked(bot.api.timeline).mockImplementation(async (_id, direction, _cursor, signal) => {
    if (direction === 'tail') return { ...bot.page, beforeCursor: 'before', hasMoreBefore: true };
    if (++older === 1) return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { canceled = true; reject(new DOMException('Canceled', 'AbortError')); }, { once: true });
    });
    return { ...bot.page, items: [{ kind: 'assistant_message', entryId: 'early', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'Recovered Controller reading target' }] }] };
  });
  render(<BotSessionHost cache={cache} displayBinding={bot.binding} actionBinding={bot.binding} />);
  await waitFor(() => expect(older).toBe(1));
  const pane = cache.snapshot()[0]!, generation = pane.client.snapshot().connectionGeneration;
  // Keep the viewport away from its automatic top-edge paginator.
  const timeline = document.querySelector<HTMLElement>('.session-timeline')!;
  timeline.scrollTop = 800;
  const replaced = { ...bot.snapshot(), connectionEpoch: '2', sessionRevision: '20', synchronized: !delayed };
  act(() => bot.receive({ protocol: replaced.protocol, type: 'snapshot', userId: botOwner, snapshot: replaced, cursor: 'replacement' }));
  expect(canceled).toBe(true);
  expect(pane.client.snapshot().connectionGeneration).toBe(generation);
  if (delayed) {
    expect(older).toBe(1);
    act(() => bot.receive({ protocol: replaced.protocol, type: 'snapshot', userId: botOwner, snapshot: { ...replaced, synchronized: true, sessionRevision: '21' }, cursor: 'ready' }));
  }
  await screen.findByText('Recovered Controller reading target');
  await waitFor(() => expect(pane.reading.current?.getRestoreStatus()).toBe('restored'));
  expect(older).toBe(2);
});

it('does not consume a cold-history attempt while auth admission is paused before its view updates', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('session-timeline') ? 200 : 0; });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ top: 0, bottom: 200, left: 0, right: 400, x: 0, y: 0, width: 400, height: 200, toJSON() {} }));
  const bot = botFixture(); let paused = false, older = 0;
  vi.mocked(bot.api.timeline).mockImplementation(async (_id, direction) => {
    if (direction === 'tail') return { ...bot.page, beforeCursor: 'before', hasMoreBefore: true };
    older++;
    return { ...bot.page, items: [{ kind: 'assistant_message', entryId: 'early', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'Recovered after authentication' }] }] };
  });
  const cache = new BotSessionCache({ userId: botOwner, isCurrent: () => true, isPaused: () => paused, storage: null, onPrincipalMismatch: vi.fn(), createApi: () => bot.api }); caches.push(cache);
  cache.select(bot.binding); const pane = cache.snapshot()[0]!;
  await waitFor(() => expect(pane.client.snapshot().historyReady).toBe(true));
  const { sessionFenceKey } = await import('../../daynight/src/session/protocol');
  pane.retained.bookmark = { identity: JSON.stringify([pane.key, sessionFenceKey(bot.snapshot())]), historyEpoch: bot.snapshot().historyEpoch, following: false, anchor: { key: 'early', top: 0 } };
  paused = true;
  render(<BotSessionHost cache={cache} displayBinding={bot.binding} actionBinding={bot.binding} />);
  const timeline = document.querySelector<HTMLElement>('.session-timeline')!;
  timeline.scrollTop = 800;
  expect(older).toBe(0);
  act(() => cache.syncAvailability());
  expect(pane.client.snapshot().authPaused).toBe(true);
  act(() => { paused = false; cache.syncAvailability(); });
  await screen.findByText('Recovered after authentication');
  await waitFor(() => expect(pane.reading.current?.getRestoreStatus()).toBe('restored'));
  expect(older).toBe(1);
});

async function coldArchiveFixture(historyFailure = false) {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('session-timeline') && !this.closest('[hidden]') ? 200 : 0; });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this.dataset.entryKey ? (this.dataset.entryKey === 'early' ? 400 : 900) - this.closest('.session-timeline')!.scrollTop : 0;
    return { top, bottom: top + 300, left: 0, right: 400, x: 0, y: top, width: 400, height: 300, toJSON() {} };
  });
  const bot = botFixture(), bots = [bot, ...[2, 3, 4].map(n => botFixture(botBinding(n)))];
  const cache = new BotSessionCache({ userId: botOwner, isCurrent: () => true, storage: null, onPrincipalMismatch: vi.fn(), createApi: binding => bots.find(candidate => candidate.binding.botId === binding.botId)!.api }); caches.push(cache);
  cache.select(bot.binding); const old = cache.snapshot()[0]!;
  await waitFor(() => expect(old.client.snapshot().historyReady).toBe(true));
  const bookmark = { identity: JSON.stringify([old.key, sessionFenceKey(bot.snapshot())]), historyEpoch: bot.snapshot().historyEpoch, following: false, anchor: { key: 'early', top: 15 } };
  old.retained.bookmark = bookmark; cache.close();
  vi.mocked(bot.api.timeline).mockImplementation(async (_id, direction, _cursor, signal) => {
    if (direction === 'tail') return { ...bot.page, beforeCursor: 'before', hasMoreBefore: true };
    if (historyFailure) throw Error('Live history unavailable');
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true }));
  });
  let finish!: (archive: SessionArchive) => void;
  vi.mocked(bot.api.archive).mockResolvedValue({ state: 'ready', sha256: 'a'.repeat(64), byteLength: '100', errorCode: null });
  vi.mocked(bot.api.archiveContent).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<BotSessionHost cache={cache} displayBinding={bot.binding} actionBinding={bot.binding} />);
  const pane = cache.snapshot()[0]!;
  await waitFor(() => expect(pane.reading.current?.getRestoreStatus()).toBe('pending'));
  if (historyFailure) await screen.findByText('Live history unavailable');
  const liveHandle = pane.reading.current!;
  const show = (active: boolean) => view.rerender(<BotSessionHost cache={cache} displayBinding={bot.binding} actionBinding={bot.binding} active={active} />);
  const select = async (n: number) => {
    view.rerender(<BotSessionHost cache={cache} displayBinding={botBinding(n)} actionBinding={botBinding(n)} />);
    await waitFor(() => {
      const state = cache.snapshot().find(candidate => candidate.binding.botId === botBinding(n).botId)?.client.snapshot();
      expect(state?.connected || state?.archiveState === 'ready').toBe(true);
    });
    return cache.snapshot().find(candidate => candidate.binding.botId === botBinding(n).botId)!;
  };
  return {
    bot, cache, pane, bookmark, liveHandle, view, show, select,
    archive: async (change: { historyEpoch?: string; executionGeneration?: string } = {}, content: 'target' | 'missing' | 'empty' | 'filtered' = 'target') => {
      const final = { ...bot.snapshot(), ...change, lifecycle: 'archived' as const, synchronized: false, connectionState: 'disconnected' as const };
      bot.change(final);
      act(() => bot.receive({ protocol: final.protocol, type: 'snapshot', userId: botOwner, snapshot: { ...final, lifecycle: 'draining' }, cursor: 'draining' }));
      await waitFor(() => expect(bot.api.archiveContent).toHaveBeenCalledOnce());
      expect(pane.reading.current).toBeNull();
      expect(view.container.querySelector(`[data-bot-id="${bot.binding.botId}"] .session-timeline`)).toBeNull();
      const archive: SessionArchive = { schemaVersion: 1, ...sessionFence(final), controllerId: final.identity.controllerId, controllerInstanceId: final.identity.controllerInstanceId, provider: final.identity.provider, nativeSessionId: final.identity.nativeSessionId,
        entries: content === 'empty' ? [] : content === 'filtered' ? [{ kind: 'reasoning', entryId: 'reasoning', entrySeq: '1', revision: '1', text: 'Filtered reasoning' }] : content === 'target' ? [{ kind: 'assistant_message', entryId: 'early', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'Archived original target' }] }, ...bot.page.items] : bot.page.items, resources: [] };
      await act(async () => finish(archive));
      vi.mocked(bot.api.archiveContent).mockResolvedValue(archive);
      await waitFor(() => expect(pane.client.snapshot().archiveState).toBe('ready'));
      expect(pane.reading.current).not.toBe(liveHandle);
    },
  };
}

it.each([false, true])('transfers unfinished cold reading to the replacement archive Timeline (hidden: %s)', async hidden => {
  const f = await coldArchiveFixture();
  if (hidden) f.show(false);
  await f.archive();
  if (hidden) { expect(f.pane.retained.bookmark).toEqual(f.bookmark); f.show(true); }
  expect(screen.getByRole('status')).toHaveTextContent('Completed · Read-only history');
  expect(f.view.container.querySelector('.task-agent-session > .session-empty')).toBeNull();
  expect(f.pane.reading.current?.getRestoreStatus()).toBe('restored');
  expect(f.pane.reading.current?.captureBookmark()).toMatchObject({ following: false, anchor: { key: 'early', top: 15 } });
  expect(f.view.container.querySelector('.session-timeline')!.scrollTop).toBe(385);
});

it.each([false, true])('honors Latest before replacing a pending Timeline with its archive (hidden: %s)', async hidden => {
  const f = await coldArchiveFixture();
  fireEvent.click(screen.getByRole('button', { name: /latest/i }));
  expect(f.liveHandle.getRestoreStatus()).toBe('idle');
  if (hidden) f.show(false);
  await f.archive();
  if (hidden) f.show(true);
  expect(f.pane.reading.current?.captureBookmark()).toMatchObject({ following: true, anchor: null });
  expect(f.view.container.querySelector('.session-timeline')!.scrollTop).toBe(1800);
  expect(f.pane.retained.bookmark).toBeNull();
});

it.each(['historyEpoch', 'executionGeneration'] as const)('rejects a pending bookmark after the archive identity changes: %s', async field => {
  const f = await coldArchiveFixture();
  const change = field === 'historyEpoch' ? { historyEpoch: 'new-history' } : { executionGeneration: String(BigInt(f.bot.snapshot().executionGeneration) + 1n) };
  await f.archive(change);
  expect(f.pane.reading.current?.captureBookmark()).toMatchObject({ following: true, anchor: null });
  expect(f.pane.retained.bookmark).toBeNull();
});

it('keeps the mounted reading handle stable while the pane changes visibility', async () => {
  const f = await coldArchiveFixture();
  f.show(false); expect(f.pane.reading.current).toBe(f.liveHandle);
  f.show(true); expect(f.pane.reading.current).toBe(f.liveHandle);
});

it.each([false, true])('uses the complete archive boundary when its target is absent (old live history error: %s)', async historyFailure => {
  const f = await coldArchiveFixture(historyFailure); await f.archive({}, 'missing');
  expect(f.pane.reading.current?.getRestoreStatus()).toBe('restored');
  expect(f.pane.reading.current?.captureBookmark()).toMatchObject({ following: false, anchor: { key: 'message', top: 0 } });
  expect(f.view.container.querySelector('.session-timeline')!.scrollTop).toBe(900);
});

it.each(['empty', 'filtered'] as const)('retains the pending bookmark when the complete archive has an %s display', async content => {
  const f = await coldArchiveFixture(); await f.archive({}, content);
  expect(f.pane.reading.current?.getRestoreStatus()).toBe('pending');
  expect(f.pane.reading.current?.captureBookmark()).toEqual(f.bookmark);
});

it.each([false, true])('retains the reader intent through hidden archive replacement and A/B/C/D eviction (Latest canceled: %s)', async canceled => {
  const f = await coldArchiveFixture();
  if (canceled) fireEvent.click(screen.getByRole('button', { name: /latest/i }));
  await f.select(2); await f.archive();
  const archivedTimeline = f.view.container.querySelector(`[data-bot-id="${f.bot.binding.botId}"] .session-timeline`)!;
  await f.select(3); await f.select(4);
  expect(f.cache.snapshot().some(pane => pane.binding.botId === f.bot.binding.botId)).toBe(false);
  expect(archivedTimeline.isConnected).toBe(false);
  const restored = await f.select(1);
  expect(restored).not.toBe(f.pane);
  expect(restored.reading.current?.captureBookmark()).toMatchObject(canceled ? { following: true, anchor: null } : { following: false, anchor: { key: 'early', top: 15 } });
  expect(f.view.container.querySelector(`[data-bot-id="${f.bot.binding.botId}"] .session-timeline`)!.scrollTop).toBe(canceled ? 1800 : 385);
});

it('retains a cold bookmark through closing a replacement Timeline before its tail hydration completes', async () => {
  const f = await coldArchiveFixture();
  act(() => f.cache.close()); f.view.unmount();
  vi.mocked(f.bot.api.timeline).mockImplementation((_id, _direction, _cursor, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true })));
  const loading = render(<BotSessionHost cache={f.cache} displayBinding={f.bot.binding} actionBinding={f.bot.binding} />);
  const pending = f.cache.snapshot()[0]!;
  await waitFor(() => expect(pending.reading.current).not.toBeNull());
  expect(pending.client.snapshot().historyReady).toBe(false);
  act(() => f.cache.close()); loading.unmount();
  vi.mocked(f.bot.api.timeline).mockResolvedValue({ ...f.bot.page, items: [{ kind: 'assistant_message', entryId: 'early', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'Restored after pending hydration' }] }] });
  const final = render(<BotSessionHost cache={f.cache} displayBinding={f.bot.binding} actionBinding={f.bot.binding} />);
  await screen.findByText('Restored after pending hydration');
  expect(f.cache.snapshot()[0]!.reading.current?.captureBookmark()).toMatchObject({ following: false, anchor: { key: 'early', top: 15 } });
  expect(final.container.querySelector('.session-timeline')!.scrollTop).toBe(385);
});

it('does not start older-page requests for a hidden pending bookmark after reconnect', async () => {
  const f = await coldArchiveFixture();
  const olderRequests = () => vi.mocked(f.bot.api.timeline).mock.calls.filter(([, direction]) => direction === 'before').length;
  expect(olderRequests()).toBe(1);
  f.show(false); act(() => f.pane.client.refresh());
  await waitFor(() => expect(f.pane.client.snapshot().historyReady).toBe(true));
  expect(f.pane.reading.current?.captureBookmark()).toEqual(f.bookmark);
  expect(olderRequests()).toBe(1);
  f.show(true);
  await waitFor(() => expect(olderRequests()).toBe(2));
});


it('preserves a nonfollowing reading anchor through details, fullscreen and responsive reflow', async () => {
  const observers = new Set<LayoutObserver>();
  class LayoutObserver {
    readonly targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); observers.delete(this); }
    deliver() {
      const entries = [...this.targets].filter(target => target.isConnected).map(target => ({ target, contentRect: target.getBoundingClientRect(), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }));
      if (entries.length) this.callback(entries, this);
    }
  }
  vi.stubGlobal('ResizeObserver', LayoutObserver);
  let workspaceWidth = 1040;
  vi.stubGlobal('innerWidth', 1440);
  // JSDOM has no layout. Reflow moves the same row when production panels and
  // fullscreen change; the original reading handle must compensate scrollTop.
  const rowOffset = () => {
    const details = document.querySelector('.bot-details-panel');
    return 500 + (details && !details.classList.contains('bot-details-drawer') ? 300 : 0)
      + (window.innerWidth < 1280 ? 600 : 0)
      - (document.querySelector('[data-session-fullscreen="true"]') ? 150 : 0);
  };
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('bot-conversation') ? workspaceWidth : 1040;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('session-timeline') ? 200 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2600);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const key = this.dataset.entryKey;
    const top = key ? (key === 'before' ? 0 : rowOffset() + (key === 'after' ? 700 : 0)) - this.closest('.session-timeline')!.scrollTop : 0;
    return new DOMRect(0, top, workspaceWidth, key ? 300 : 200);
  });
  const bot = botFixture();
  vi.mocked(bot.api.timeline).mockResolvedValue({ ...bot.page, items: ['before', 'reading', 'after'].map((key, index) => ({
    kind: 'assistant_message' as const, entryId: key, entrySeq: String(index + 1), revision: '1', content: [{ type: 'text' as const, text: `Retained ${key} message` }],
  })) });
  const definition = { ...botDefinition(), id: bot.binding.botId, ownerUserId: botOwner, sessionId: bot.binding.sessionId, testExecutionId: bot.binding.testExecutionId, roleConfiguration: { instructions: 'role', revision: 'v1', digest: 'a'.repeat(64) }, startupResult: { state: 'ready' as const, code: null } };
  vi.spyOn(sessions, 'createBotSessionApi').mockReturnValue(bot.api);
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => botResponse(String(url).includes('/defaults') ? botDefaults() : String(url).includes('?') ? { items: [definition], nextCursor: null } : definition, botOwner)));
  // Observe the real cache instance without replacing its selection behavior.
  const selections = vi.spyOn(BotSessionCache.prototype, 'select');
  const scope = createTaskCacheScope({ userId: botOwner, onIdentityMismatch: vi.fn() });
  const view = render(<TaskCacheProvider scope={scope}><BotsPage botId={definition.id} readEnabled /></TaskCacheProvider>);
  try {
    const input = await screen.findByRole('textbox', { name: 'Message' });
    await waitFor(() => expect(input).toBeEnabled());
    await waitFor(() => expect(input).not.toHaveAttribute('readonly'));
    await screen.findByText('Retained reading message');
    fireEvent.change(input, { target: { value: 'Draft while reading earlier content' } });
    const cache = selections.mock.contexts.find(candidate => candidate instanceof BotSessionCache)!;
    const pane = cache.snapshot()[0]!, client = pane.client, reading = pane.reading.current!;
    const timeline = view.container.querySelector<HTMLElement>('.session-timeline')!;
    const session = input.closest('.task-agent-session');
    timeline.scrollTop = 470;
    fireEvent.wheel(timeline, { deltaY: -120 });
    fireEvent.scroll(timeline);
    const bookmark = reading.captureBookmark();
    const restores = vi.spyOn(reading, 'restoreBookmark');
    expect(bookmark).toMatchObject({ following: false, anchor: { key: 'reading', top: 30 } });
    const assertReading = async () => {
      // Native ResizeObserver runs after the panel's layout effects choose its
      // final mode. Deliver that browser notification without invoking reading methods.
      act(() => { for (const observer of [...observers]) observer.deliver(); });
      await waitFor(() => expect(timeline.scrollTop).toBe(rowOffset() - 30));
      expect(pane.reading.current).toBe(reading);
      expect(reading.captureBookmark()).toEqual(bookmark);
      expect(cache.snapshot()[0]).toBe(pane);
      expect(pane.client).toBe(client);
      expect(view.container.querySelector('.session-timeline')).toBe(timeline);
      expect(screen.getByRole('textbox', { name: 'Message' })).toBe(input);
      expect(input.closest('.task-agent-session')).toBe(session);
      expect(input).toHaveValue('Draft while reading earlier content');
    };
    fireEvent.click(screen.getByRole('button', { name: 'Assistant details' }));
    expect(screen.getByRole('complementary', { name: 'Assistant details' })).toBeVisible();
    await assertReading();
    fireEvent.click(screen.getByRole('button', { name: 'Close assistant details' }));
    await assertReading();
    fireEvent.click(screen.getByRole('button', { name: 'Enter Session fullscreen' }));
    await assertReading();
    fireEvent.click(screen.getByRole('button', { name: 'Assistant details' }));
    await assertReading();
    act(() => { workspaceWidth = 620; vi.stubGlobal('innerWidth', 390); window.dispatchEvent(new Event('resize')); });
    expect(screen.getByRole('dialog', { name: 'Assistant details' })).toBeVisible();
    await assertReading();
    act(() => { workspaceWidth = 1040; vi.stubGlobal('innerWidth', 1440); window.dispatchEvent(new Event('resize')); });
    expect(screen.getByRole('complementary', { name: 'Assistant details' })).toBeVisible();
    await assertReading();
    fireEvent.click(screen.getByRole('button', { name: 'Close assistant details' }));
    await assertReading();
    fireEvent.click(screen.getByRole('button', { name: 'Exit Session fullscreen' }));
    await assertReading();
    expect(restores).toHaveBeenCalledWith(bookmark);
    expect(bot.api.current).toHaveBeenCalledOnce();
    expect(bot.api.channel).toHaveBeenCalledOnce();
    expect(bot.api.command).not.toHaveBeenCalled();
  } finally { view.unmount(); scope.dispose(); }
});
