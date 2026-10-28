import { useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type TouchEvent, type WheelEvent } from 'react';
import { captureReadingText, readingTextTop, type ReadingTextAnchor } from './reading-text-anchor';

// Follow user reading intent rather than layout changes. Behavioral reference:
// https://github.com/xuangong/agent-remote-control/blob/7905c9e2d4a2beb28e84b954a29da3778094e384/packages/agent-remote-web/src/react/useTimelineScroll.ts
export function useSessionScroll(identity: string, active: boolean, revision: unknown) {
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const anchor = useRef<{ key: string; top: number; text?: ReadingTextAnchor } | null>(null);
  const touchY = useRef<number | null>(null), lastTop = useRef(0), expectedTop = useRef<number | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const capture = () => {
    const box = viewport.current;
    if (!box || !active || box.clientHeight === 0 || following.current) return;
    const bounds = box.getBoundingClientRect();
    const first = Array.from(box.querySelectorAll<HTMLElement>('[data-entry-key]')).find(entry => entry.getBoundingClientRect().bottom > bounds.top);
    if (first) {
      const text = captureReadingText(first, bounds);
      anchor.current = { key: first.dataset.entryKey!, top: first.getBoundingClientRect().top - bounds.top, ...(text ? { text } : {}) };
    }
  };
  const update = () => {
    const box = viewport.current;
    if (!box || !active || box.clientHeight === 0) return;
    if (following.current) box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
    else if (anchor.current) {
      const saved = anchor.current;
      const entry = Array.from(box.querySelectorAll<HTMLElement>('[data-entry-key]')).find(entry => entry.dataset.entryKey === saved.key);
      if (entry) {
        const textTop = saved.text && readingTextTop(entry, saved.text);
        const adjustment = (textTop ?? entry.getBoundingClientRect().top) - box.getBoundingClientRect().top - (textTop !== undefined ? saved.text!.top : saved.top);
        if (Math.abs(adjustment) > 1) box.scrollTop += adjustment;
      }
    }
    expectedTop.current = box.scrollTop; lastTop.current = box.scrollTop;
    setShowLatest(!following.current && box.scrollHeight - box.clientHeight - box.scrollTop > 64);
    capture();
  };
  const updateRef = useRef(update); updateRef.current = update;
  const identityRef = useRef(identity);
  useLayoutEffect(() => {
    if (identityRef.current !== identity) {
      identityRef.current = identity; following.current = true; anchor.current = null; touchY.current = null; expectedTop.current = null;
    }
    updateRef.current();
  }, [identity, active, revision]);
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
  const latest = () => { following.current = true; anchor.current = null; updateRef.current(); };
  const onScroll = () => {
    const box = viewport.current; if (!box || !active || box.clientHeight === 0) return;
    if (expectedTop.current !== null && Math.abs(box.scrollTop - expectedTop.current) < 1) return;
    if (!following.current && box.scrollTop > lastTop.current && box.scrollHeight - box.clientHeight - box.scrollTop < 2) following.current = true;
    expectedTop.current = null; lastTop.current = box.scrollTop;
    capture(); setShowLatest(!following.current && box.scrollHeight - box.clientHeight - box.scrollTop > 64);
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
  return { viewport, content, showLatest, latest, pause, capture, onScroll, onKeyDown, onFocus,
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
