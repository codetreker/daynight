import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BotSessionCache } from '../src/features/bots/session-cache';
import { BotSessionHost } from '../src/features/bots/BotSessionHost';
import { createLocaleRender } from './helpers/renderWithLocale';
import { botBinding, botFixture, botOwner } from './helpers/bot-session';
const render = createLocaleRender('en');
const caches: BotSessionCache[] = [];
afterEach(() => { caches.splice(0).forEach(cache => cache.close()); });
function fixture() {
  const bots = [1, 2, 3, 4].map(n => botFixture(botBinding(n)));
  const cache = new BotSessionCache({ userId: botOwner, isCurrent: () => true, storage: null, onPrincipalMismatch: vi.fn(), createApi: binding => bots.find(bot => bot.binding.botId === binding.botId)!.api }); caches.push(cache);
  const view = render(<BotSessionHost cache={cache} binding={botBinding(1)} />);
  const select = async (n: number) => { view.rerender(<BotSessionHost cache={cache} binding={botBinding(n)} />); await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled()); };
  return { bots, cache, view, select };
}
it('retains the actual shared Session DOM and independent drafts across A/B/A and releases a fourth pane', async () => {
  const f = fixture(); await f.select(1);
  const shell = f.view.container.firstElementChild, a = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(a, { target: { value: 'draft A' } }); const session = a.closest('.task-agent-session');
  await f.select(2); const b = screen.getByRole('textbox', { name: 'Message' }); fireEvent.change(b, { target: { value: 'draft B' } });
  expect(a.closest('[data-bot-id]')).toHaveAttribute('hidden'); expect(a.closest('[data-bot-id]')).toHaveAttribute('inert');
  await f.select(1); expect(screen.getByRole('textbox', { name: 'Message' })).toBe(a); expect(a).toHaveValue('draft A'); expect(a.closest('.task-agent-session')).toBe(session);
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
  f.view.rerender(<BotSessionHost cache={f.cache} binding={null} />);
  expect(screen.queryByRole('textbox')).toBeNull(); expect(a.isConnected).toBe(true);
  await f.select(1); expect(screen.getByRole('textbox')).toBe(a); expect(f.bots[0]!.api.current).toHaveBeenCalledOnce();
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
  render(<BotSessionHost cache={cache} binding={bot.binding} />);
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
  render(<BotSessionHost cache={cache} binding={bot.binding} />);
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
  render(<BotSessionHost cache={cache} binding={bot.binding} />);
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
