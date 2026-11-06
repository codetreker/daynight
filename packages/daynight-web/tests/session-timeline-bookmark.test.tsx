import { act, fireEvent } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useTimelineScroll, type TimelineReadingBookmark } from '../src/ui/useTimelineScroll';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
type Settings = { original: string[]; visible: string[]; identity: string; epoch: string; complete: boolean; active: boolean; heights: Readonly<Record<string, number>>; imageKey: string | null; imageExpanded: boolean };
// JSDOM has no layout or scroll clamping. Model those primitives while using
// actual mounted rows, the real hook and the same events as a Session viewport.
function timeline(initial: Partial<Settings> = {}) {
  let settings: Settings = { original: ['a', 'b', 'c', 'd', 'e', 'f'], visible: ['a', 'b', 'c', 'd', 'e', 'f'], identity: 'user/session/fence', epoch: '1', complete: true, active: true, heights: {}, imageKey: null, imageExpanded: true, ...initial };
  let position = 0, scroll!: ReturnType<typeof useTimelineScroll>;
  const rowHeight = (key: string) => settings.heights[key] ?? 300;
  const contentHeight = () => 40 + settings.visible.reduce((height, key) => height + rowHeight(key), 0);
  const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 400, width: 400, height, x: 0, y: top, toJSON() {} });
  function Timeline() {
    scroll = useTimelineScroll(settings.identity, settings.active, settings.original, undefined, { originalKeys: settings.original, visibleKeys: settings.visible, mode: 'test' }, { historyEpoch: settings.epoch, historyComplete: settings.complete });
    return <div ref={node => {
      scroll.viewport.current = node;
      if (!node) return;
      Object.defineProperties(node, {
        clientHeight: { configurable: true, value: 200 },
        scrollHeight: { configurable: true, get: contentHeight },
        scrollTop: { configurable: true, get: () => position, set: (top: number) => { position = Math.max(0, Math.min(top, Math.max(0, contentHeight() - 200))); } },
      });
      node.getBoundingClientRect = () => rect(0, 200);
    }} onScroll={scroll.onScroll} onWheel={scroll.onWheel}>
      <div ref={scroll.content}>{settings.visible.map((key, index) => <article key={key} data-entry-key={key} ref={node => {
        if (node) node.getBoundingClientRect = () => rect(40 + settings.visible.slice(0, index).reduce((height, previous) => height + rowHeight(previous), 0) - position, rowHeight(key));
      }}>{key === settings.imageKey ? <details open={settings.imageExpanded}><summary>Image output</summary>{settings.imageExpanded ? <img alt="" /> : null}</details> : `${key} `.repeat(600)}</article>)}</div>
    </div>;
  }
  const view = render(<Timeline />), box = view.container.firstElementChild as HTMLElement;
  return {
    view, box, scroll: () => scroll,
    read: (top: number) => { fireEvent.wheel(box, { deltaY: -10 }); box.scrollTop = top; fireEvent.scroll(box); },
    capture: () => scroll.captureBookmark()!,
    restore: (bookmark: TimelineReadingBookmark) => { let result!: ReturnType<typeof scroll.restoreBookmark>; act(() => { result = scroll.restoreBookmark(bookmark); }); return result; },
    update: (next: Partial<Settings>) => { settings = { ...settings, ...next }; view.rerender(<Timeline />); },
  };
}

it('exports a detached bounded bookmark and restores its row after unmount and prepending', () => {
  const first = timeline(); first.read(950);
  const bookmark = first.capture(); first.view.unmount();
  const second = timeline({ original: ['older', 'a', 'b', 'c', 'd', 'e', 'f'], visible: ['older', 'a', 'b', 'c', 'd', 'e', 'f'] });
  expect(second.restore(bookmark)).toBe('restored');
  expect(second.box.scrollTop).toBe(1250); expect(second.scroll().isFollowing()).toBe(false);
  expect(bookmark.identity).toBe('user/session/fence'); expect(bookmark.historyEpoch).toBe('1');
  expect(bookmark.anchor?.key).toBe('d');
  expect(JSON.stringify(bookmark)).not.toContain('originalKeys');
  expect(JSON.stringify(bookmark)).not.toContain('order');
  expect(JSON.stringify(bookmark).length).toBeLessThan(500);
  second.read(50); expect(bookmark.anchor?.key).toBe('d');
});

it('retains a missing historical bookmark through partial pages and capture attempts', () => {
  const first = timeline(); first.read(350); const bookmark = first.capture(); first.view.unmount();
  const second = timeline({ original: ['e', 'f'], visible: ['e', 'f'], complete: false });
  expect(second.restore(bookmark)).toBe('pending');
  act(() => { second.scroll().pause(); second.scroll().capture(); window.dispatchEvent(new Event('resize')); });
  expect(second.capture()).toEqual(bookmark); expect(second.scroll().getRestoreStatus()).toBe('pending');
  second.update({ original: ['c', 'd', 'e', 'f'], visible: ['c', 'd', 'e', 'f'] });
  expect(second.capture()).toEqual(bookmark);
  second.update({ original: ['a', 'b', 'c', 'd', 'e', 'f'], visible: ['a', 'b', 'c', 'd', 'e', 'f'] });
  expect(second.scroll().getRestoreStatus()).toBe('restored'); expect(second.box.scrollTop).toBe(350);
});

it('defers missing-row fallback until the caller confirms the history boundary', () => {
  const first = timeline(); first.read(650); const bookmark = first.capture(); first.view.unmount();
  const second = timeline({ original: ['b', 'd', 'f'], visible: ['b', 'd', 'f'], complete: false });
  expect(second.restore(bookmark)).toBe('pending');
  second.update({ complete: true });
  expect(second.scroll().getRestoreStatus()).toBe('restored'); expect(second.box.scrollTop).toBe(40); expect(second.scroll().isFollowing()).toBe(false);
});

it('uses current display order for a filtered anchor and retains an empty display bookmark', () => {
  const first = timeline(); first.read(650); const bookmark = first.capture(); first.view.unmount();
  const second = timeline({ visible: [] });
  expect(second.restore(bookmark)).toBe('pending'); expect(second.capture()).toEqual(bookmark);
  second.update({ visible: ['b', 'd', 'f'] });
  expect(second.box.scrollTop).toBe(40); expect(second.scroll().getRestoreStatus()).toBe('restored');
});

it.each([{ identity: 'other-user/session/fence' }, { identity: 'user/session/new-fence' }, { epoch: '2' }])('rejects an incompatible bookmark without changing reading intent: %o', change => {
  const first = timeline(); first.read(350); const bookmark = first.capture(); first.view.unmount();
  const second = timeline(change); const top = second.box.scrollTop;
  expect(second.restore(bookmark)).toBe('rejected'); expect(second.box.scrollTop).toBe(top); expect(second.scroll().isFollowing()).toBe(true);
});

it('restores following at the current tail and cancels a pending bookmark on latest', () => {
  const first = timeline(); const following = first.capture(); first.read(350); const reading = first.capture(); first.view.unmount();
  const second = timeline({ original: ['e', 'f'], visible: ['e', 'f'], complete: false });
  second.restore(reading); act(() => { second.scroll().latest(); });
  expect(second.scroll().getRestoreStatus()).toBe('idle'); expect(second.scroll().isFollowing()).toBe(true);
  second.read(40); expect(second.restore(following)).toBe('restored'); expect(second.box.scrollTop).toBe(440);
});

it('keeps imported text offsets through width changes and export without recapture drift', () => {
  let charsPerLine = 40;
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    let node: Node, offset = 0;
    return { setStart: (n: Node, start: number) => { node = n; offset = start; }, setEnd: () => {}, getBoundingClientRect: () => {
      const top = node.parentElement!.getBoundingClientRect().top + Math.floor(offset / charsPerLine) * 20;
      return { top, bottom: top + 20, height: 20 } as DOMRect;
    } } as unknown as Range;
  });
  const first = timeline(); first.read(445); const bookmark = first.capture(); first.view.unmount();
  charsPerLine = 80;
  const second = timeline(); second.restore(bookmark);
  expect(second.box.scrollTop).toBe(385);
  expect(second.capture().anchor?.text?.offset).toBe(bookmark.anchor?.text?.offset);
  charsPerLine = 40; act(() => { window.dispatchEvent(new Event('resize')); });
  expect(second.box.scrollTop).toBe(445);
});

it('defers restoring into an inactive viewport until it becomes visible', () => {
  const first = timeline(); first.read(650); const bookmark = first.capture(); first.view.unmount();
  const second = timeline({ active: false });
  expect(second.restore(bookmark)).toBe('pending'); expect(second.box.scrollTop).toBe(0);
  second.update({ active: true }); expect(second.box.scrollTop).toBe(650); expect(second.scroll().getRestoreStatus()).toBe('restored');
});

it('drops pending restoration when the current history changes', () => {
  const first = timeline(); first.read(350); const bookmark = first.capture(); first.view.unmount();
  const second = timeline({ original: ['e', 'f'], visible: ['e', 'f'], complete: false });
  second.restore(bookmark); second.update({ epoch: '2' });
  expect(second.scroll().getRestoreStatus()).toBe('idle'); expect(second.scroll().isFollowing()).toBe(true);
  expect(second.box.scrollTop).toBe(440); expect(second.capture().historyEpoch).toBe('2');
});

it('does not replace a valid pending target when another identity is rejected', () => {
  const first = timeline(); first.read(350); const bookmark = first.capture(); first.view.unmount();
  const second = timeline({ original: ['e', 'f'], visible: ['e', 'f'], complete: false });
  second.restore(bookmark);
  expect(second.restore({ ...bookmark, identity: 'wrong-owner', following: true })).toBe('rejected');
  expect(second.capture()).toEqual(bookmark); expect(second.scroll().getRestoreStatus()).toBe('pending');
  second.update({ original: ['a', 'b', 'e', 'f'], visible: ['a', 'b', 'e', 'f'] });
  expect(second.box.scrollTop).toBe(350); expect(second.scroll().isFollowing()).toBe(false);
});

it('falls back to the row offset when the bookmarked text no longer exists', () => {
  const first = timeline(); first.read(650); const bookmark = first.capture(); first.view.unmount();
  const second = timeline();
  const changedText: TimelineReadingBookmark = { ...bookmark, anchor: { ...bookmark.anchor!, text: { offset: 200, quote: 'removed text', top: -5 } } };
  expect(second.restore(changedText)).toBe('restored');
  expect(second.box.scrollTop).toBe(650); expect(second.capture().anchor?.text).toBeUndefined();
});

it.each([-300, -649.75])('returns a collapsed cold-restored row to its top when its old text offset would hide the whole row: %s', top => {
  const first = timeline(); first.read(350); const bookmark = first.capture(); first.view.unmount();
  // An expanded details body supplied this position before eviction. Its text
  // is absent from the remounted collapsed row, now only 300 CSS px tall.
  const expanded: TimelineReadingBookmark = { ...bookmark, anchor: { ...bookmark.anchor!, top, text: { offset: 1459, quote: 'Removed expanded body', top: 6 } } };
  const second = timeline();
  expect(second.restore(expanded)).toBe('restored');
  expect(second.box.scrollTop).toBe(340); expect(second.capture().anchor?.key).toBe('b');
  expect(second.box.querySelector('[data-entry-key="b"]')!.getBoundingClientRect().top).toBe(0);
});

it.each([{ offset: 310, restoredTop: 0 }, { offset: 10, restoredTop: -10 }])('restores a genuinely captured image-only position after cold collapse: %o', ({ offset, restoredTop }) => {
  // The only text is the summary above the image. Real Range measurements
  // place it above the viewport when reading inside the expanded image.
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    let node: Node;
    return { setStart: (next: Node) => { node = next; }, setEnd: () => {}, getBoundingClientRect: () => {
      const top = node.parentElement!.closest('article')!.getBoundingClientRect().top;
      return { top, bottom: top + 8, height: 8 } as DOMRect;
    } } as unknown as Range;
  });
  const first = timeline({ heights: { b: 900 }, imageKey: 'b' }); first.read(340 + offset);
  const bookmark = first.capture();
  expect(bookmark.anchor?.key).toBe('b'); expect(bookmark.anchor?.top).toBe(-offset); expect(bookmark.anchor?.text).toBeUndefined();
  first.view.unmount();
  const second = timeline({ heights: { b: 32 }, imageKey: 'b', imageExpanded: false });
  expect(second.restore(bookmark)).toBe('restored');
  expect(second.box.querySelector('[data-entry-key="b"]')!.getBoundingClientRect().top).toBe(restoredTop);
  expect(second.capture().anchor?.key).toBe('b'); expect(second.scroll().isFollowing()).toBe(false);
});

it('uses the first visible row only after all bounded neighbor hints are unavailable at the boundary', () => {
  const first = timeline(); first.read(650); const bookmark = first.capture(); first.view.unmount();
  const second = timeline({ original: ['e', 'f'], visible: ['e', 'f'], complete: false });
  second.restore(bookmark); expect(second.capture()).toEqual(bookmark);
  second.update({ complete: true });
  expect(second.box.scrollTop).toBe(40); expect(second.capture().anchor?.key).toBe('e');
});

it.each([{ identity: 'other-user/session/fence' }, { epoch: '2' }])('rejects a retained restoration callback after its owner changes: %o', change => {
  const view = timeline(); view.read(350); const bookmark = view.capture(), restore = view.scroll().restoreBookmark;
  view.update(change); const top = view.box.scrollTop;
  let result: string | undefined;
  act(() => { result = restore(bookmark); });
  expect(result).toBe('rejected'); expect(view.box.scrollTop).toBe(top); expect(view.scroll().isFollowing()).toBe(true);
});

it('exposes return to latest while a missing bookmark is pending', () => {
  const first = timeline(); first.read(350); const bookmark = first.capture(); first.view.unmount();
  const second = timeline({ original: ['e', 'f'], visible: ['e', 'f'], complete: false });
  second.restore(bookmark); expect(second.scroll().showLatest).toBe(true);
  act(() => { second.scroll().latest(); });
  expect(second.scroll().showLatest).toBe(false); expect(second.scroll().getRestoreStatus()).toBe('idle');
});

it('keeps an explicitly revealed row anchored when previously missing history arrives', () => {
  const first = timeline(); first.read(350); const bookmark = first.capture(); first.view.unmount();
  const second = timeline({ original: ['e', 'f'], visible: ['e', 'f'], complete: false });
  second.restore(bookmark);
  act(() => { expect(second.scroll().reveal(second.box.querySelector<HTMLElement>('[data-entry-key="e"]')!)).toBe(true); });
  expect(second.capture().anchor?.key).toBe('e'); expect(second.scroll().getRestoreStatus()).toBe('idle');
  second.update({ original: ['a', 'b', 'c', 'd', 'e', 'f'], visible: ['a', 'b', 'c', 'd', 'e', 'f'], complete: true });
  expect(second.box.querySelector('[data-entry-key="e"]')!.getBoundingClientRect().top).toBe(0);
  expect(second.scroll().isFollowing()).toBe(false);
});

it('refuses explicit navigation into an inactive or foreign viewport and after an owner change', () => {
  const view = timeline({ active: false });
  const target = () => view.box.querySelector<HTMLElement>('[data-entry-key="e"]')!;
  expect(view.scroll().reveal(target())).toBe(false);
  view.update({ active: true }); const before = view.box.scrollTop;
  expect(view.scroll().reveal(document.createElement('div'))).toBe(false); expect(view.box.scrollTop).toBe(before);
  const retained = view.scroll().reveal;
  view.update({ identity: 'other-user/session/fence' });
  expect(retained(target())).toBe(false); expect(view.scroll().isFollowing()).toBe(true);
});
