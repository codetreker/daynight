import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type TouchEvent, type WheelEvent } from 'react';
import type { useTimelineScroll } from '../../ui/useTimelineScroll';

type HistoryPagination = {
  readonly scroll: ReturnType<typeof useTimelineScroll>;
  readonly identity: string;
  readonly mode: string;
  readonly active: boolean;
  readonly ready: boolean;
  readonly generation: number;
  readonly revision: number;
  readonly hasOlder: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly load: () => Promise<void>;
};
type Request = { readonly revision: number; settled: boolean };

// Session owns pagination; the shared scroll hook remains the sole owner of
// text anchoring and latest-following behavior for every timeline.
export function useSessionHistoryPagination(options: HistoryPagination) {
  const current = useRef(options); current.current = options;
  const mounted = useRef(false), reading = useRef(false), fill = useRef(true);
  const request = useRef<Request | null>(null), frame = useRef<number | null>(null);
  const touchY = useRef<number | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const failure = useRef(localError); failure.current = localError;
  const failureIdentity = useRef({ identity: options.identity, generation: options.generation });
  const evaluate = useRef<() => void>(() => {});
  const cancelFrame = () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; };
  const schedule = () => {
    if (!mounted.current || frame.current !== null) return;
    // Let the tail placement, React commit and anchor observers settle before
    // inspecting geometry, including successful pages with no visible rows.
    frame.current = requestAnimationFrame(() => {
      frame.current = requestAnimationFrame(() => { frame.current = null; evaluate.current(); });
    });
  };
  const visible = () => {
    const o = current.current, box = o.scroll.viewport.current;
    return o.active && o.ready && document.visibilityState !== 'hidden' && box !== null && box.clientHeight > 0;
  };
  const start = () => {
    const o = current.current;
    if (!visible() || !o.hasOlder || o.loading || request.current !== null) return;
    if (!o.scroll.isFollowing()) o.scroll.pause();
    const pending: Request = { revision: o.revision, settled: false }; request.current = pending;
    void o.load().catch((error: unknown) => {
      if (mounted.current && request.current === pending) setLocalError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!mounted.current || request.current !== pending) return;
      pending.settled = true; schedule();
    });
  };
  evaluate.current = () => {
    const o = current.current, pending = request.current;
    if (pending) {
      if (!pending.settled || o.loading) return;
      // loadOlder catches failures itself. Only an observed successful page
      // revision permits automatic continuation, never Promise resolution.
      if (!o.error && !failure.current && pending.revision === o.revision) return;
      request.current = null;
    }
    if (!visible() || !o.hasOlder || o.loading || o.error || failure.current) return;
    const box = o.scroll.viewport.current!;
    const short = box.scrollHeight <= box.clientHeight + 1;
    const nearTop = box.scrollTop <= Math.min(240, box.clientHeight / 2);
    if (!nearTop || o.scroll.isFollowing()) reading.current = false;
    if (fill.current && short || reading.current && nearTop) start();
  };
  useLayoutEffect(() => {
    mounted.current = true;
    const box = current.current.scroll.viewport.current, body = current.current.scroll.content.current;
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    if (box) resize?.observe(box);
    if (body) resize?.observe(body);
    const visibility = () => {
      cancelFrame(); reading.current = document.visibilityState !== 'hidden' && !current.current.scroll.isFollowing();
      fill.current = true; schedule();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('resize', schedule);
    schedule();
    return () => { mounted.current = false; cancelFrame(); request.current = null; resize?.disconnect(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('resize', schedule); };
  }, []);
  useLayoutEffect(() => {
    cancelFrame(); request.current = null;
    if (failureIdentity.current.identity !== options.identity || failureIdentity.current.generation !== options.generation) {
      failureIdentity.current = { identity: options.identity, generation: options.generation };
      failure.current = null; setLocalError(null);
    }
    reading.current = options.active && options.ready && !options.scroll.isFollowing(); fill.current = true;
    schedule();
  }, [options.identity, options.generation, options.active, options.ready]);
  useLayoutEffect(() => { cancelFrame(); reading.current = false; fill.current = true; schedule(); }, [options.mode]);
  useLayoutEffect(schedule);
  const read = () => { if (!visible()) return; reading.current = true; fill.current = true; schedule(); };
  const scroll = options.scroll;
  return {
    error: options.error ?? localError,
    retry: () => {
      if (!visible() || current.current.loading || request.current && !request.current.settled) return;
      request.current = null; failure.current = null; setLocalError(null); reading.current = !scroll.isFollowing(); fill.current = true; start();
    },
    latest: () => { cancelFrame(); reading.current = false; fill.current = false; scroll.latest(); },
    onScroll: () => {
      const moved = scroll.onScroll();
      if (moved && !scroll.isFollowing()) reading.current = true;
      schedule();
    },
    onWheel: (event: WheelEvent<HTMLDivElement>) => { scroll.onWheel(event); if (!event.defaultPrevented && event.deltaY < 0) read(); },
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      scroll.onKeyDown(event);
      if (event.defaultPrevented || event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey && event.target === event.currentTarget) read();
    },
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      scroll.onPointerDown(event);
      if (event.pointerType === 'mouse' && event.target === event.currentTarget && event.clientX >= event.currentTarget.getBoundingClientRect().right - 16) read();
    },
    onTouchStart: (event: TouchEvent<HTMLDivElement>) => { touchY.current = event.touches[0]?.clientY ?? null; scroll.onTouchStart(event); },
    onTouchMove: (event: TouchEvent<HTMLDivElement>) => {
      scroll.onTouchMove(event); const y = event.touches[0]?.clientY;
      if (!event.defaultPrevented && y !== undefined && touchY.current !== null && y > touchY.current) read();
      touchY.current = y ?? null;
    },
  };
}
