import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { BotSessionHost } from '../src/features/bots/BotSessionHost';
import { BotDisplaySnapshotCoordinator } from '../src/features/bots/display-snapshot-coordinator';
import { BotDisplaySnapshotStore, type BotDisplayPreview } from '../src/features/bots/display-snapshot';
import { BotSessionCache } from '../src/features/bots/session-cache';
import { botBinding, botFixture } from './helpers/bot-session';
import { createLocaleRender } from './helpers/renderWithLocale';
import { sessionFence } from '../../daynight/src/session/protocol';

const render = createLocaleRender('en');
const entry = (n: number) => ({ kind: 'assistant_message' as const, entryId: `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`, entrySeq: String(n), revision: '1', content: [{ type: 'text' as const, text: `Retained history ${n}` }] });

async function fixture() {
  const user = crypto.randomUUID(), binding = { ...botBinding(1), ownerUserId: user }, bot = botFixture(binding);
  bot.change({ ...bot.snapshot(), lastTimelineSeq: '150' });
  const store = new BotDisplaySnapshotStore({ isCurrent: owner => owner === user, storage: localStorage, withLock: async (_key, run) => run() });
  const owner = new BotDisplaySnapshotCoordinator({ userId: user, isCurrent: () => true, store });
  const seed: BotDisplayPreview = { schemaVersion: 1, ownerUserId: user, botId: binding.botId, lastKnownBinding: binding, botName: 'Assistant', fence: sessionFence(bot.snapshot()), historyEpoch: bot.snapshot().historyEpoch, lastEventSeq: '0', entries: Array.from({ length: 150 }, (_, index) => entry(index + 1)), resources: [], savedAt: 1 };
  const lease = (await store.observe(user, binding.botId))!;
  expect(await store.save(lease, { source: 'verified-history', historyLoaded: true, preview: seed })).toBe('saved');
  const cache = new BotSessionCache({ userId: user, isCurrent: () => true, storage: null, displaySnapshots: owner, onPrincipalMismatch: vi.fn(), createApi: () => bot.api });
  const node = (bound: boolean) => <BotSessionHost cache={cache} botName="Assistant" botId={binding.botId} displayBinding={bound ? binding : null} />;
  const view = render(node(false));
  await screen.findByText('Retained history 1');
  return { user, binding, bot, store, owner, cache, view, node, close() { view.unmount(); cache.close(); owner.close(); } };
}

it('keeps uncovered display rows and their reading anchor after the real observer persists a shorter tail', async () => {
  // JSDOM has no layout; real reading ownership uses these stable row positions.
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(3000);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const key = this.dataset.entryKey, seq = key ? Number(key.slice(-12)) : null;
    return new DOMRect(0, seq === null ? 0 : (seq - 1) * 20 - this.closest('.session-timeline')!.scrollTop, 400, seq === null ? 200 : 20);
  });
  const f = await fixture();
  try {
    const timeline = f.view.container.querySelector<HTMLElement>('.session-timeline')!;
    timeline.scrollTop = 400; fireEvent.wheel(timeline, { deltaY: -120 }); fireEvent.scroll(timeline);
    const oldRow = screen.getByText('Retained history 21').closest('[data-entry-key]');
    const save = vi.spyOn(f.store, 'save');
    vi.mocked(f.bot.api.timeline).mockResolvedValue({ ...f.bot.page, items: Array.from({ length: 100 }, (_, index) => entry(index + 51)), beforeCursor: 'before-50', hasMoreBefore: true });
    f.view.rerender(f.node(true));
    await waitFor(() => expect(f.cache.snapshot()[0]?.client.snapshot().historySettled).toBe(true));
    const pane = f.cache.snapshot()[0]!, bookmark = pane.reading.current!.captureBookmark();
    expect(bookmark).toMatchObject({ following: false, anchor: { key: entry(21).entryId } });
    // Wait for the production observer's coalesced write, not a seeded replacement.
    await waitFor(() => expect(save.mock.calls.some(([, input]) => input.preview.entries.length === 100)).toBe(true), { timeout: 5000 });
    await waitFor(async () => expect((await f.store.read(f.user, f.binding.botId, { touch: false }))?.entries).toHaveLength(100));
    expect(pane.client.snapshot().state.entries).toHaveLength(100);
    expect(f.view.container.querySelectorAll('[data-entry-key]')).toHaveLength(150);
    expect(f.view.container.querySelectorAll('[data-history-preview="true"]')).toHaveLength(50);
    expect(screen.getByText('Retained history 21').closest('[data-entry-key]')).toBe(oldRow);
    expect(f.view.container.querySelector('.session-timeline')).toBe(timeline);
    expect(pane.reading.current!.captureBookmark()).toEqual(bookmark);
    vi.mocked(f.bot.api.timeline).mockResolvedValueOnce({ ...f.bot.page, items: Array.from({ length: 50 }, (_, index) => entry(index + 1)) });
    await act(() => pane.client.loadOlder());
    expect(pane.client.snapshot().state.entries).toHaveLength(150);
    expect(f.view.container.querySelectorAll('[data-entry-key]')).toHaveLength(150);
    expect(f.view.container.querySelectorAll('[data-history-preview="true"]')).toHaveLength(0);
    expect(screen.getByText('Retained history 21').closest('[data-entry-key]')).toBe(oldRow);
    expect(f.bot.api.command).not.toHaveBeenCalled();
    act(() => f.cache.invalidateBot(f.binding.botId));
    expect(screen.queryByText('Retained history 21')).toBeNull();
  } finally { f.close(); }
});

it('does not resurrect a consumed preview gap when a disjoint refresh starts a new coverage chain', async () => {
  const f = await fixture();
  try {
    f.bot.change({ ...f.bot.snapshot(), lastTimelineSeq: '100' });
    vi.mocked(f.bot.api.timeline).mockResolvedValueOnce({ ...f.bot.page, items: [entry(1), ...Array.from({ length: 98 }, (_, index) => entry(index + 3))], beforeCursor: 'older', hasMoreBefore: true });
    f.view.rerender(f.node(true));
    await waitFor(() => expect(f.cache.snapshot()[0]?.client.snapshot().historySettled).toBe(true));
    await waitFor(() => expect(screen.queryByText('Retained history 2')).toBeNull());
    expect(screen.getByText('Retained history 125')).toBeVisible();
    vi.mocked(f.bot.api.timeline).mockResolvedValueOnce({ ...f.bot.page, items: Array.from({ length: 100 }, (_, index) => entry(index + 151)), beforeCursor: 'new-older', hasMoreBefore: true });
    f.bot.change({ ...f.bot.snapshot(), lastTimelineSeq: '250' });
    await act(() => f.cache.snapshot()[0]!.client.refresh());
    await screen.findByText('Retained history 250');
    expect(screen.queryByText('Retained history 2')).toBeNull();
    expect(screen.getByText('Retained history 125')).toBeVisible();
  } finally { f.close(); }
});
