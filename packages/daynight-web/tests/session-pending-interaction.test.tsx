import { readFileSync } from 'node:fs';
import { createRef } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { SessionTimeline, type SessionTimelineReadingHandle } from '../src/features/task-agent-session/SessionTimeline';
import { emptySessionState, hydrateSession, type SessionState } from '../src/features/task-agent-session/state';
import type { TimelineEntry } from '../src/api/types';
import type { TaskSessionSnapshot } from './helpers/session';
import { createLocaleRender } from './helpers/renderWithLocale';
const render = createLocaleRender('en');
const snapshot = (): TaskSessionSnapshot => JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
const approval = (id: string, title = 'Approve Write'): TimelineEntry => ({ entryId: id, entrySeq: id, revision: '1', kind: 'interaction', interaction: { interactionId: id, revision: '1', state: 'pending', kind: 'approval', title, detail: 'notes/review.txt', actions: ['allow_once', 'reject'] } });
function setup(entries = [approval('1')], onRespond = vi.fn(async () => {})) {
  const s = snapshot();
  let state: SessionState = hydrateSession(emptySessionState(), { ...s, activity: 'waiting_input', operations: { ...s.operations, canRespond: true } }, entries);
  let active = true, canRespond = true, mode: 'standard' | 'conversation' = 'standard';
  const reading = createRef<SessionTimelineReadingHandle>();
  const props = { reading: { scope: 'test-user', ref: reading }, onRespond, hasOlder: false, loadingOlder: false, onLoadOlder: async () => {}, onLoadResource: async () => new Blob() };
  const content = () => <SessionTimeline state={state} active={active} canRespond={canRespond} displayMode={mode} {...props} />;
  const view = render(content());
  const box = view.container.querySelector<HTMLElement>('.session-timeline')!;
  let height = 1000;
  Object.defineProperties(box, { clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, get: () => height } });
  const rect = (top: number, size: number) => ({ top, bottom: top + size, left: 0, right: 320, width: 320, height: size, x: 0, y: top, toJSON() {} });
  vi.spyOn(box, 'getBoundingClientRect').mockImplementation(() => rect(0, 200));
  const cards = new Map<string, { top: number; height: number; node: HTMLElement }>();
  for (const article of view.container.querySelectorAll<HTMLElement>('[data-entry-key]')) {
    const node = article.querySelector<HTMLElement>('.session-interaction')!;
    if (!node) continue;
    const geometry = { top: 0, height: 100, node }; cards.set(article.dataset.entryKey!, geometry);
    vi.spyOn(article, 'getBoundingClientRect').mockImplementation(() => rect(geometry.top - box.scrollTop, geometry.height));
    vi.spyOn(node, 'getBoundingClientRect').mockImplementation(() => rect(geometry.top - box.scrollTop, geometry.height));
  }
  const resize = () => act(() => { window.dispatchEvent(new Event('resize')); });
  resize();
  return { view, box, cards, onRespond, resize, reading,
    read: (top: number) => { fireEvent.wheel(box, { deltaY: -10 }); box.scrollTop = top; fireEvent.scroll(box); },
    update: (next: { state?: SessionState; active?: boolean; canRespond?: boolean; mode?: typeof mode; height?: number } = {}) => {
      state = next.state ?? state; active = next.active ?? active; canRespond = next.canRespond ?? canRespond; mode = next.mode ?? mode; height = next.height ?? height; view.rerender(content());
    }, state: () => state,
  };
}
it('only offers a localized locator for an offscreen answerable request, without answering', () => {
  const view = setup();
  const button = screen.getByRole('button', { name: 'Pending request · Approve Write' });
  expect(button).toHaveTextContent('↑');
  view.view.setLocale('zh-CN');
  expect(screen.getByRole('button', { name: '待处理请求 · Approve Write' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '待处理请求 · Approve Write' }));
  expect(view.box.scrollTop).toBe(0);
  expect(view.cards.get('1')!.node).toHaveFocus();
  expect(screen.queryByRole('button', { name: /待处理请求/ })).toBeNull();
  expect(view.onRespond).not.toHaveBeenCalled();
  view.update({ height: 1200 });
  expect(view.box.scrollTop).toBe(0);
});
it('tracks user scrolling in both directions and keeps a partially visible tall card quiet', () => {
  const view = setup(); view.cards.get('1')!.top = 400;
  view.read(0);
  expect(screen.getByRole('button', { name: /Pending request/ })).toHaveTextContent('↓');
  view.read(350);
  expect(screen.queryByRole('button', { name: /Pending request/ })).toBeNull();
  view.cards.get('1')!.height = 800; view.read(600);
  expect(screen.queryByRole('button', { name: /Pending request/ })).toBeNull();
  view.cards.get('1')!.height = 100; view.read(800);
  expect(screen.getByRole('button', { name: /Pending request/ })).toHaveTextContent('↑');
});
it('supports keyboard activation and focuses the card without activating approval', async () => {
  const view = setup(), user = userEvent.setup();
  screen.getByRole('button', { name: /Pending request/ }).focus();
  await user.keyboard('{Enter}');
  expect(view.cards.get('1')!.node).toHaveFocus();
  expect(view.onRespond).not.toHaveBeenCalled();
});
it('removes the locator for resolved requests, inactive views and lost response admission', () => {
  const view = setup();
  view.update({ active: false }); expect(screen.queryByRole('button', { name: /Pending request/ })).toBeNull();
  view.update({ active: true, canRespond: false }); expect(screen.queryByRole('button', { name: /Pending request/ })).toBeNull();
  view.update({ canRespond: true }); expect(screen.getByRole('button', { name: /Pending request/ })).toBeVisible();
  const entry = approval('1'); if (entry.kind !== 'interaction') throw new Error('Expected interaction');
  view.update({ state: { ...view.state(), entries: [{ ...entry, interaction: { ...entry.interaction, state: 'resolved' } }] } });
  expect(screen.queryByRole('button', { name: /Pending request/ })).toBeNull();
});
it('does not offer a request in a read-only or non-waiting session', () => {
  const view = setup(); const state = view.state();
  view.update({ state: { ...state, snapshot: { ...state.snapshot!, lifecycle: 'draining' } } });
  expect(screen.queryByRole('button', { name: /Pending request/ })).toBeNull();
  view.update({ state: { ...state, snapshot: { ...state.snapshot!, activity: 'working' } } });
  expect(screen.queryByRole('button', { name: /Pending request/ })).toBeNull();
});
it('selects another hidden pending request when one request is already visible', () => {
  const view = setup([approval('1'), approval('2', 'Approve command')]);
  view.cards.get('2')!.top = 800; view.resize();
  expect(screen.getByRole('button', { name: 'Pending request · Approve Write' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /Pending request/ }));
  expect(screen.getByRole('button', { name: 'Pending request · Approve command' })).toHaveTextContent('↓');
  view.update({ mode: 'conversation' });
  expect(screen.getByRole('button', { name: 'Pending request · Approve command' })).toBeVisible();
});
it('removes locally completed and pending cards before a new snapshot arrives', async () => {
  let resolve!: () => void;
  const view = setup([approval('1')], vi.fn(() => new Promise<void>(done => { resolve = done; })));
  fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: /Pending request/ })).toBeNull());
  await act(async () => resolve());
  view.resize();
  expect(screen.queryByRole('button', { name: /Pending request/ })).toBeNull();
});

it('lets an explicit pending-card jump supersede an unfinished historical bookmark restoration', () => {
  const view = setup();
  const bookmark = view.reading.current!.captureBookmark()!;
  act(() => { expect(view.reading.current!.restoreBookmark({ ...bookmark, following: false, anchor: { key: 'unloaded', top: 0 } })).toBe('pending'); });
  fireEvent.click(screen.getByRole('button', { name: /Pending request/ }));
  expect(view.reading.current!.getRestoreStatus()).toBe('idle');
  expect(view.cards.get('1')!.node).toHaveFocus();
  expect(view.reading.current!.captureBookmark()!.anchor?.key).toBe('1');
  view.resize();
  expect(view.box.scrollTop).toBe(0);
});
