import { useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type TouchEvent, type WheelEvent } from 'react';
import { captureReadingText, readingTextTop, type ReadingTextAnchor } from './reading-text-anchor';

export type TimelineDisplayOrder = {
  readonly originalKeys: readonly string[];
  readonly visibleKeys: readonly string[];
  readonly mode: string;
};

type ReadingAnchor = {
  readonly key: string;
  readonly top: number;
  readonly text?: ReadingTextAnchor;
  readonly previousKey?: string;
  readonly nextKey?: string;
};
/** A detached, constant-size reading position; identity includes the caller's ownership fence. */
export type TimelineReadingBookmark = {
  readonly identity: string;
  readonly historyEpoch: string;
  readonly following: boolean;
  readonly anchor: ReadingAnchor | null;
};
export type TimelineReadingOptions = {
  readonly historyEpoch: string;
  /** True only after the caller has confirmed the complete historical boundary. */
  readonly historyComplete: boolean;
};
export type TimelineRestoreStatus = 'idle' | 'restored' | 'pending' | 'rejected';

function copyAnchor(saved: ReadingAnchor): ReadingAnchor {
  return { key: saved.key, top: saved.top,
    ...(saved.text ? { text: { offset: saved.text.offset, quote: saved.text.quote, top: saved.text.top } } : {}),
    ...(saved.previousKey === undefined ? {} : { previousKey: saved.previousKey }),
    ...(saved.nextKey === undefined ? {} : { nextKey: saved.nextKey }),
  };
}
function neighboringKey(key: string, order: readonly string[], visibleKeys: readonly string[]): string | undefined {
  const index = order.indexOf(key), visible = new Set(visibleKeys);
  if (index < 0) return undefined;
  for (let i = index - 1; i >= 0; i--) if (visible.has(order[i]!)) return order[i];
  for (let i = index + 1; i < order.length; i++) if (visible.has(order[i]!)) return order[i];
  return undefined;
}

// Follow user reading intent rather than layout changes. Behavioral reference:
// https://github.com/xuangong/agent-remote-control/blob/7905c9e2d4a2beb28e84b954a29da3778094e384/packages/agent-remote-web/src/react/useTimelineScroll.ts
export function useTimelineScroll(identity: string, active: boolean, revision: unknown, onIntent?: (following: boolean, anchor: string | null) => void, display?: TimelineDisplayOrder, reading?: TimelineReadingOptions) {
  const intent = useRef(onIntent); intent.current = onIntent;
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const anchor = useRef<(ReadingAnchor & { readonly order?: readonly string[] }) | null>(null);
  const pendingBookmark = useRef<TimelineReadingBookmark | null>(null), restoreStatus = useRef<TimelineRestoreStatus>('idle');
  const touchY = useRef<number | null>(null), lastTop = useRef(0), expectedTop = useRef<number | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const capture = () => {
    const box = viewport.current;
    if (!box || !active || box.clientHeight === 0 || following.current || pendingBookmark.current) return;
    const bounds = box.getBoundingClientRect();
    const first = Array.from(box.querySelectorAll<HTMLElement>('[data-entry-key]')).find(entry => entry.getBoundingClientRect().bottom > bounds.top);
    if (first) {
      const text = captureReadingText(first, bounds);
      intent.current?.(false, first.dataset.entryKey!);
      anchor.current = { key: first.dataset.entryKey!, top: first.getBoundingClientRect().top - bounds.top, ...(text ? { text } : {}), ...(display ? { order: display.originalKeys } : {}) };
    }
  };
  const update = () => {
    const box = viewport.current;
    if (!box || !active || box.clientHeight === 0) return;
    const pending = pendingBookmark.current;
    if (pending) {
      let saved = pending.anchor;
      if (!pending.following && saved) {
        const domKeys = Array.from(box.querySelectorAll<HTMLElement>('[data-entry-key]'), entry => entry.dataset.entryKey!);
        const original = display?.originalKeys ?? domKeys, visible = display?.visibleKeys ?? domKeys;
        if (!visible.includes(saved.key)) {
          // Absence from a tail page is not deletion. The Session owner loads
          // earlier pages; ordinary pagination capture must retain this target.
          if (!original.includes(saved.key) && !reading?.historyComplete) return;
          const replacement = original.includes(saved.key)
            ? neighboringKey(saved.key, original, visible)
            : [saved.previousKey, saved.nextKey].find(key => key !== undefined && visible.includes(key)) ?? visible[0];
          if (replacement === undefined) return;
          saved = { key: replacement, top: 0 };
        }
        if (!domKeys.includes(saved.key)) return;
      }
      anchor.current = saved && { ...copyAnchor(saved), ...(display ? { order: display.originalKeys } : {}) };
      pendingBookmark.current = null; restoreStatus.current = 'restored';
    }
    let recapture = anchor.current === null;
    if (following.current) { box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight); intent.current?.(true, null); }
    else if (anchor.current) {
      let saved = anchor.current;
      if (display && !display.visibleKeys.includes(saved.key)) {
        // The removed row is no longer in the DOM. Keep its original order with
        // the reading anchor so filtering and inactive renders cannot erase it.
        const order = display.originalKeys.includes(saved.key) ? display.originalKeys : saved.order ?? [];
        const replacement = neighboringKey(saved.key, order, display.visibleKeys);
        if (replacement !== undefined) {
          saved = { key: replacement, top: 0, order: display.originalKeys };
          anchor.current = saved;
        }
      }
      const entry = Array.from(box.querySelectorAll<HTMLElement>('[data-entry-key]')).find(entry => entry.dataset.entryKey === saved.key);
      if (entry) {
        const textTop = saved.text && readingTextTop(entry, saved.text);
        recapture = textTop === undefined;
        const entryBounds = entry.getBoundingClientRect();
        // Cold remounts collapse details. If the old text is gone and its row
        // offset would hide the entire shorter row, retain the row at its top.
        const rowTop = pending && saved.text && textTop === undefined && saved.top <= -entryBounds.height ? 0 : saved.top;
        const adjustment = (textTop ?? entryBounds.top) - box.getBoundingClientRect().top - (textTop !== undefined ? saved.text!.top : rowTop);
        if (Math.abs(adjustment) > 1) box.scrollTop += adjustment;
      }
    }
    expectedTop.current = box.scrollTop; lastTop.current = box.scrollTop;
    setShowLatest(!following.current && box.scrollHeight - box.clientHeight - box.scrollTop > 64);
    // Layout may move an earlier character onto the anchored line. Recapturing
    // that line would replace the reading offset and drift on the return resize.
    if (recapture) capture();
  };
  const updateRef = useRef(update); updateRef.current = update;
  const identityRef = useRef(identity), historyEpochRef = useRef(reading?.historyEpoch);
  useLayoutEffect(() => {
    if (identityRef.current !== identity || historyEpochRef.current !== reading?.historyEpoch) {
      identityRef.current = identity; following.current = true; anchor.current = null; touchY.current = null; expectedTop.current = null;
      historyEpochRef.current = reading?.historyEpoch; pendingBookmark.current = null; restoreStatus.current = 'idle';
    }
    updateRef.current();
  }, [identity, active, revision, display?.mode, display?.originalKeys, display?.visibleKeys, reading?.historyEpoch, reading?.historyComplete]);
  useLayoutEffect(() => {
    const box = viewport.current, body = content.current;
    if (!box || !body) return;
    const notify = () => updateRef.current();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(notify);
    resize?.observe(box); resize?.observe(body);
    const observer = new MutationObserver(notify); observer.observe(body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['open', 'hidden'] });
    window.addEventListener('resize', notify);
    return () => { resize?.disconnect(); observer.disconnect(); window.removeEventListener('resize', notify); };
  }, []);
  const pause = () => { following.current = false; expectedTop.current = null; lastTop.current = viewport.current?.scrollTop ?? 0; capture(); };
  const latest = () => { pendingBookmark.current = null; restoreStatus.current = 'idle'; following.current = true; intent.current?.(true, null); anchor.current = null; updateRef.current(); };
  const captureBookmark = (): TimelineReadingBookmark | null => {
    if (!reading || identityRef.current !== identity || historyEpochRef.current !== reading.historyEpoch) return null;
    const pending = pendingBookmark.current;
    if (pending) return { identity: pending.identity, historyEpoch: pending.historyEpoch, following: pending.following, anchor: pending.anchor && copyAnchor(pending.anchor) };
    // Reflow can put an earlier character on the same line. Export the retained
    // offset instead of recapturing it and introducing resize drift.
    if (!anchor.current) capture();
    const saved = following.current ? null : anchor.current;
    const order = saved?.order ?? display?.originalKeys ?? [], index = saved ? order.indexOf(saved.key) : -1;
    const previousKey = index > 0 ? order[index - 1] : saved?.previousKey, nextKey = index >= 0 ? order[index + 1] : saved?.nextKey;
    return { identity, historyEpoch: reading.historyEpoch, following: following.current,
      anchor: saved ? { ...copyAnchor(saved), ...(previousKey === undefined ? {} : { previousKey }), ...(nextKey === undefined ? {} : { nextKey }) } : null,
    };
  };
  // Pending means the viewport is inactive, the display is empty, or earlier
  // history still needs loading. This hook never performs network requests.
  const restoreBookmark = (bookmark: TimelineReadingBookmark): Exclude<TimelineRestoreStatus, 'idle'> => {
    if (!reading || identityRef.current !== identity || historyEpochRef.current !== reading.historyEpoch || bookmark.identity !== identity || bookmark.historyEpoch !== reading.historyEpoch) {
      if (!pendingBookmark.current) restoreStatus.current = 'rejected';
      return 'rejected';
    }
    pendingBookmark.current = { identity: bookmark.identity, historyEpoch: bookmark.historyEpoch, following: bookmark.following, anchor: bookmark.anchor && copyAnchor(bookmark.anchor) };
    following.current = bookmark.following; touchY.current = null; expectedTop.current = null; restoreStatus.current = 'pending';
    // A pending target may be outside the loaded tail even when that tail is
    // already at the bottom. Keep an explicit way to abandon restoration.
    setShowLatest(!bookmark.following);
    updateRef.current();
    return restoreStatus.current as 'pending' | 'restored';
  };
  const onScroll = () => {
    const box = viewport.current; if (!box || !active || box.clientHeight === 0 || pendingBookmark.current) return false;
    if (expectedTop.current !== null && Math.abs(box.scrollTop - expectedTop.current) < 1) return false;
    if (!following.current && display?.visibleKeys.length !== 0 && box.scrollTop > lastTop.current && box.scrollHeight - box.clientHeight - box.scrollTop < 2) following.current = true;
    expectedTop.current = null; lastTop.current = box.scrollTop;
    capture(); setShowLatest(!following.current && box.scrollHeight - box.clientHeight - box.scrollTop > 64);
    return true;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]'))) return;
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey && event.target === event.currentTarget) pause();
  };
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) return;
    const box = event.currentTarget, bounds = box.getBoundingClientRect(), target = event.target.getBoundingClientRect();
    if (box.scrollTop < lastTop.current || target.top < bounds.top || target.bottom > bounds.bottom) pause();
  };
  return { viewport, content, isFollowing: () => following.current, captureBookmark, restoreBookmark, getRestoreStatus: () => restoreStatus.current, showLatest, latest, pause, capture, onScroll, onKeyDown, onFocus,
    onWheel: (event: WheelEvent<HTMLDivElement>) => { if (!event.defaultPrevented && event.deltaY < 0) pause(); },
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => { if (event.pointerType === 'mouse' && event.target === event.currentTarget && event.clientX >= event.currentTarget.getBoundingClientRect().right - 16) pause(); },
    onTouchStart: (event: TouchEvent<HTMLDivElement>) => { touchY.current = event.touches[0]?.clientY ?? null; },
    onTouchMove: (event: TouchEvent<HTMLDivElement>) => {
      const y = event.touches[0]?.clientY;
      if (!event.defaultPrevented && y !== undefined && touchY.current !== null && y > touchY.current) pause();
      touchY.current = y ?? null;
    },
  };
}
