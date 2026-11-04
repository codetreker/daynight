import { StrictMode } from 'react';
import { readFileSync } from 'node:fs';
import type { SessionSnapshot } from '../src/api/types';
import { act, fireEvent } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { SessionTimeline } from '../src/features/task-agent-session/SessionTimeline';
import { emptySessionState, type SessionState } from '../src/features/task-agent-session/state';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
let frames: Map<number, FrameRequestCallback>, nextFrame: number;
beforeEach(() => {
  frames = new Map(); nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
async function advance(count = 4) {
  for (let i = 0; i < count; i++) await act(async () => {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(i * 16));
    await Promise.resolve();
  });
}
// JSDOM supplies event propagation but no layout. Model only viewport metrics;
// real browser acceptance measures text anchors and native input scrolling.
function setup({ height: initialHeight = 1000, strict = false } = {}) {
  let height = initialHeight, top = 0;
  let props = { active: true, canRespond: false, onRespond: async () => {}, hasOlder: true, loadingOlder: false,
    historyReady: true, historyRevision: 1, connectionGeneration: 1, historyError: null as string | null,
    displayMode: 'standard' as 'standard' | 'conversation', onLoadResource: async () => new Blob() };
  const snapshot: SessionSnapshot = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
  let state: SessionState = { ...emptySessionState(), snapshot, entries: [{ kind: 'assistant_message', entryId: 'tail', entrySeq: '10', revision: '1', content: [{ type: 'text', text: 'Visible reading text' }] }] };
  const load = vi.fn(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }));
  let finish = () => {}; let fail: (error: Error) => void = () => {};
  const ui = () => <SessionTimeline {...props} state={{ ...state, entries: [...state.entries] }} onLoadOlder={load} />;
  const view = render(strict ? <StrictMode>{ui()}</StrictMode> : ui());
  const box = view.container.querySelector<HTMLElement>('.session-timeline')!;
  Object.defineProperties(box, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, get: () => height },
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - 200)); } },
  });
  const rect = (y: number, size: number) => ({ x: 0, y, top: y, bottom: y + size, left: 0, right: 400, width: 400, height: size, toJSON() {} });
  box.getBoundingClientRect = () => rect(0, 200);
  view.container.querySelector<HTMLElement>('[data-entry-key]')!.getBoundingClientRect = () => rect(-top, height);
  const update = (patch: Partial<typeof props> = {}, nextHeight = height) => {
    height = nextHeight; props = { ...props, ...patch };
    view.rerender(strict ? <StrictMode>{ui()}</StrictMode> : ui());
  };
  update({ historyRevision: 2 });
  return { view, box, load, update, props: () => props,
    switchFence: (patch: Partial<Pick<SessionSnapshot, 'connectionEpoch' | 'executionGeneration'>>) => { state = { ...state, snapshot: { ...snapshot, ...patch } }; update(); },
    switchIdentity: (historyEpoch = 'other-epoch') => { state = { ...state, snapshot: { ...snapshot, historyEpoch } }; update(); },
    read: (position = 80) => { fireEvent.wheel(box, { deltaY: -100 }); box.scrollTop = position; fireEvent.scroll(box); },
    complete: async (patch: Partial<typeof props> = {}, nextHeight = height) => {
      update({ loadingOlder: false, historyRevision: props.historyRevision + 1, ...patch }, nextHeight);
      await act(async () => { finish(); await Promise.resolve(); });
    },
    pendingCompletion: () => finish,
    rejectOnly: async () => { await act(async () => { fail(new Error('History request rejected')); await Promise.resolve(); }); },
    resolveOnly: async () => { await act(async () => { finish(); await Promise.resolve(); }); },
  };
}

it('loads from the actual timeline scroll root after upward reading, never initial tail positioning', async () => {
  const f = setup(); await advance(); expect(f.box.scrollTop).toBe(800); expect(f.load).not.toHaveBeenCalled();
  fireEvent.scroll(window); await advance(); expect(f.load).not.toHaveBeenCalled();
  f.read(); await advance(); expect(f.load).toHaveBeenCalledTimes(1);
  expect(f.view.queryByRole('button', { name: 'Load earlier activity' })).toBeNull();
});
it('deduplicates StrictMode and rapid input while a page is pending', async () => {
  const f = setup({ strict: true }); f.read();
  for (let i = 0; i < 10; i++) fireEvent.scroll(f.box);
  await advance(); expect(f.load).toHaveBeenCalledTimes(1);
  fireEvent.wheel(f.box, { deltaY: -1 }); await advance(); expect(f.load).toHaveBeenCalledTimes(1);
});
it('fills a short viewport serially after layout and preserves latest following', async () => {
  const f = setup({ height: 100 }); expect(f.load).not.toHaveBeenCalled();
  await advance(); expect(f.load).toHaveBeenCalledTimes(1);
  f.update({ loadingOlder: true }); await advance(); expect(f.load).toHaveBeenCalledTimes(1);
  await f.complete({}, 150); await advance(); expect(f.load).toHaveBeenCalledTimes(2);
  await f.complete({}, 500); await advance(); expect(f.load).toHaveBeenCalledTimes(2); expect(f.box.scrollTop).toBe(300);
});
it('continues successful filtered pages without a DOM or intersection change', async () => {
  const f = setup(); f.read(50); await advance(); expect(f.load).toHaveBeenCalledTimes(1);
  await f.complete(); await advance(); expect(f.load).toHaveBeenCalledTimes(2);
  await f.complete(); await advance(); expect(f.load).toHaveBeenCalledTimes(3);
  await f.complete({ hasOlder: false }); await advance(); expect(f.load).toHaveBeenCalledTimes(3);
});
it('does not treat Promise resolution without a successful page revision as progress', async () => {
  const f = setup(); f.read(); await advance(); await f.resolveOnly(); await advance(8);
  fireEvent.scroll(f.box); await advance(); expect(f.load).toHaveBeenCalledTimes(1);
});
it('rechecks demand after each committed page and stops when reading leaves the top region', async () => {
  const f = setup(); f.read(); await advance();
  f.box.scrollTop = 500; fireEvent.scroll(f.box); await f.complete(); await advance(); expect(f.load).toHaveBeenCalledTimes(1);
});
it('shows accessible loading and actual failures, then requires explicit retry', async () => {
  const f = setup(); f.read(); await advance(); f.update({ loadingOlder: true });
  expect(f.view.getByRole('status')).toHaveTextContent('Loading earlier activity');
  await f.complete({ historyError: 'The history relay failed' }); await advance();
  expect(f.view.getByRole('alert')).toHaveTextContent('The history relay failed');
  fireEvent.wheel(f.box, { deltaY: -10 }); await advance(); expect(f.load).toHaveBeenCalledTimes(1);
  fireEvent.click(f.view.getByRole('button', { name: 'Retry' })); expect(f.load).toHaveBeenCalledTimes(2);
});
it.each(['active', 'historyReady'] as const)('blocks automatic work while %s is false', async (key) => {
  const f = setup(); f.update({ [key]: false }); f.read(); await advance(); expect(f.load).not.toHaveBeenCalled();
});
it('cancels pending continuation on latest and plain mode switches with a full viewport', async () => {
  const f = setup(); f.read(); await advance();
  fireEvent.click(f.view.getByRole('button', { name: 'Latest ↓' })); await f.complete(); await advance(); expect(f.load).toHaveBeenCalledTimes(1);
  f.read(); await advance(); expect(f.load).toHaveBeenCalledTimes(2);
  f.update({ displayMode: 'conversation' }); await f.complete(); await advance(); expect(f.load).toHaveBeenCalledTimes(2);
});
it('uses keyboard, touch and scrollbar reading input through the same scroll root', async () => {
  for (const kind of ['keyboard', 'touch', 'scrollbar']) {
    const f = setup(); await advance();
    if (kind === 'keyboard') fireEvent.keyDown(f.box, { key: 'Home' });
    if (kind === 'touch') { fireEvent.touchStart(f.box, { touches: [{ clientY: 50 }] }); fireEvent.touchMove(f.box, { touches: [{ clientY: 100 }] }); }
    if (kind === 'scrollbar') fireEvent.pointerDown(f.box, { pointerType: 'mouse', clientX: 399 });
    f.box.scrollTop = 50; fireEvent.scroll(f.box); await advance(); expect(f.load, kind).toHaveBeenCalledTimes(1); f.view.unmount();
  }
});
it('cancels hidden-page work and resumes a fresh demand after visibility returns', async () => {
  const f = setup(); f.read();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  fireEvent(document, new Event('visibilitychange')); await advance(); expect(f.load).not.toHaveBeenCalled();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  fireEvent(document, new Event('visibilitychange')); await advance(); expect(f.load).toHaveBeenCalledTimes(1);
});

it('abandons the old continuation when history identity changes', async () => {
  const f = setup(); f.read(); await advance(); expect(f.load).toHaveBeenCalledTimes(1);
  f.switchIdentity(); await f.complete(); await advance();
  expect(f.box.scrollTop).toBe(800); expect(f.load).toHaveBeenCalledTimes(1);
});
it('restarts from current reading demand after a disconnected generation becomes ready', async () => {
  const f = setup(); f.read(); await advance();
  f.update({ historyReady: false, loadingOlder: false, connectionGeneration: 2 }); await advance();
  expect(f.load).toHaveBeenCalledTimes(1);
  await f.resolveOnly(); f.update({ historyReady: true }); await advance();
  expect(f.load).toHaveBeenCalledTimes(2);
});
it('drops scheduled and in-flight continuation after unmount', async () => {
  const f = setup(); f.read(); await advance(); f.view.unmount(); await f.resolveOnly(); await advance();
  expect(f.load).toHaveBeenCalledTimes(1);
});
it('does not rearm pagination for a programmatic anchor scroll after a mode switch', async () => {
  const f = setup(); f.read(); await advance(); await f.complete({ hasOlder: false }); await advance();
  f.update({ displayMode: 'conversation', hasOlder: true }); fireEvent.scroll(f.box); await advance();
  expect(f.load).toHaveBeenCalledTimes(1);
});
it('allows a mode change to fill newly short content without enabling full-history sweeping', async () => {
  const f = setup(); await advance(); f.update({ displayMode: 'conversation' }, 100); await advance();
  expect(f.load).toHaveBeenCalledTimes(1);
  await f.complete({}, 500); await advance(); expect(f.load).toHaveBeenCalledTimes(1);
});
it('ignores reading keys inside editable descendants', async () => {
  const f = setup(); const input = document.createElement('textarea'); f.box.append(input);
  fireEvent.keyDown(input, { key: 'Home' }); f.box.scrollTop = 80; fireEvent.scroll(f.box); await advance();
  expect(f.load).not.toHaveBeenCalled();
});

it.each([{ connectionEpoch: '4' }, { executionGeneration: '9007199254740994' }])('abandons a pending page when the server fence changes: %j', async (fence) => {
  const f = setup(); f.read(); await advance(); expect(f.load).toHaveBeenCalledTimes(1);
  const completeOld = f.pendingCompletion();
  f.switchFence(fence); await advance(); expect(f.load).toHaveBeenCalledTimes(2);
  await act(async () => { completeOld(); await Promise.resolve(); }); await advance();
  expect(f.load).toHaveBeenCalledTimes(2);
});

it('retains rejected-request errors across activation until explicit retry', async () => {
  const f = setup(); f.read(); await advance(); await f.rejectOnly(); await advance();
  expect(f.view.getByRole('alert')).toHaveTextContent('History request rejected');
  f.update({ active: false }); f.update({ active: true }); await advance();
  expect(f.load).toHaveBeenCalledTimes(1); expect(f.view.getByRole('alert')).toHaveTextContent('History request rejected');
  fireEvent.click(f.view.getByRole('button', { name: 'Retry' })); expect(f.load).toHaveBeenCalledTimes(2);
});
