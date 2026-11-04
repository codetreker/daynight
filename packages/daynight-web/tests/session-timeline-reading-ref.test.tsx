import { createRef } from 'react';
import { readFileSync } from 'node:fs';
import { act } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { SessionSnapshot } from '../src/api/types';
import { SessionTimeline, type SessionTimelineReadingHandle } from '../src/features/task-agent-session/SessionTimeline';
import { emptySessionState } from '../src/features/task-agent-session/state';
import { createLocaleRender } from './helpers/renderWithLocale';
const render = createLocaleRender('en');
const snapshot: SessionSnapshot = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
const props = { active: true, canRespond: false, onRespond: async () => {}, hasOlder: true, loadingOlder: false, onLoadOlder: async () => {}, onLoadResource: async () => new Blob() };

it('exposes optional reading controls scoped to the principal and actual session fence', () => {
  const ref = createRef<SessionTimelineReadingHandle>();
  let current = snapshot, scope = 'user-a';
  const ui = () => <SessionTimeline {...props} state={{ ...emptySessionState(), snapshot: current }} reading={{ scope, ref }} />;
  const view = render(ui());
  expect(ref.current).not.toBeNull();
  const bookmark = ref.current!.captureBookmark()!;
  expect(bookmark.historyEpoch).toBe(snapshot.historyEpoch);
  expect(bookmark.following).toBe(true);
  scope = 'user-b'; view.rerender(ui());
  act(() => { expect(ref.current!.restoreBookmark(bookmark)).toBe('rejected'); });
  scope = 'user-a'; current = { ...snapshot, executionGeneration: String(BigInt(snapshot.executionGeneration) + 1n) }; view.rerender(ui());
  act(() => { expect(ref.current!.restoreBookmark(bookmark)).toBe('rejected'); });
  current = { ...snapshot, historyEpoch: 'new-history' }; view.rerender(ui());
  act(() => { expect(ref.current!.restoreBookmark(bookmark)).toBe('rejected'); });
  view.unmount(); expect(ref.current).toBeNull();
});

it('does not export a bookmark before a real session snapshot exists', () => {
  const ref = createRef<SessionTimelineReadingHandle>();
  render(<SessionTimeline {...props} state={emptySessionState()} reading={{ scope: 'user-a', ref }} />);
  expect(ref.current!.captureBookmark()).toBeNull();
});
