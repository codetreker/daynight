import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

type Reading = { readonly usage: string | null; readonly execution: string | null };
type Mode = 'hover' | 'focus' | 'touch';
type Active = { id: string; button: HTMLElement; anchor: HTMLElement; mode: Mode; reading: Reading };
type HintControl = {
  show: (id: string, button: HTMLElement, anchor: HTMLElement, mode: Mode, reading: Reading) => void;
  update: (id: string, reading: Reading) => void;
  leave: (id: string) => void;
  dismiss: (id?: string) => void;
  cancelLeave: () => void;
  reposition: () => void;
};
const Context = createContext<HintControl | null>(null);
export const useGraphReadingHint = () => {
  const value = useContext(Context);
  if (value === null) throw new Error('Graph reading requires its canvas provider.');
  return value;
};
const hasReading = (reading: Reading) => reading.usage !== null || reading.execution !== null;
const ownerOf = (element: Element | null) => element?.closest('dialog, [role="dialog"], [role="alertdialog"]') ?? null;

export const GraphReadingHintProvider = ({ children }: { children: ReactNode }) => {
  const [active, setActive] = useState<Active | null>(null);
  const current = useRef<Active | null>(null);
  const focused = useRef<{ id: string; button: HTMLElement } | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const schedulePosition = useRef<(() => void) | null>(null);
  const reposition = useCallback(() => schedulePosition.current?.(), []);
  const cancelLeave = useCallback(() => { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; }, []);
  const set = useCallback((value: Active | null) => { current.current = value; setActive(value); }, []);
  const dismiss = useCallback((id?: string) => {
    if (id === undefined || focused.current?.id === id) focused.current = null;
    if (id !== undefined && current.current?.id !== id) return;
    cancelLeave(); set(null);
  }, [cancelLeave, set]);
  const show = useCallback((id: string, button: HTMLElement, anchor: HTMLElement, mode: Mode, reading: Reading) => {
    cancelLeave();
    if (mode === 'focus') focused.current = { id, button };
    if (hasReading(reading)) set({ id, button, anchor, mode, reading });
    else if (current.current?.id === id) set(null);
  }, [cancelLeave, set]);
  const update = useCallback((id: string, reading: Reading) => {
    const value = current.current;
    const source = focused.current;
    if (value === null && source?.id === id && source.button.isConnected && document.activeElement === source.button && hasReading(reading)) {
      set({ id, button: source.button, anchor: source.button, mode: 'focus', reading });
      return;
    }
    if (value?.id !== id) return;
    if (!hasReading(reading)) { set(null); return; }
    if (value.reading.usage !== reading.usage || value.reading.execution !== reading.execution) set({ ...value, reading });
  }, [set]);
  const leave = useCallback((id: string) => {
    cancelLeave();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const value = current.current;
      if (value?.id !== id || value.mode !== 'hover') return;
      if (value.button.matches(':focus-visible')) set({ ...value, mode: 'focus', anchor: value.button });
      else dismiss(id);
    }, 120);
  }, [cancelLeave, dismiss, set]);
  const control = useMemo(() => ({ show, update, leave, dismiss, cancelLeave, reposition }), [show, update, leave, dismiss, cancelLeave, reposition]);
  useEffect(() => () => cancelLeave(), [cancelLeave]);
  useLayoutEffect(() => {
    const bubble = tip.current;
    if (!bubble) return;
    if (typeof bubble.showPopover === 'function') {
      if (active && !bubble.matches(':popover-open')) bubble.showPopover();
      if (!active && bubble.matches(':popover-open')) bubble.hidePopover();
    }
    return () => { if (typeof bubble.hidePopover === 'function' && bubble.matches(':popover-open')) bubble.hidePopover(); };
  }, [active !== null]);
  useLayoutEffect(() => {
    if (!active || !tip.current) return;
    const { button } = active;
    const bubble = tip.current;
    const owner = ownerOf(button);
    let frame = 0;
    const valid = () => button.isConnected && button.closest('[hidden], [inert]') === null && ownerOf(document.activeElement) === owner;
    const position = () => {
      frame = 0;
      if (!valid()) { dismiss(); return; }
      const viewport = window.visualViewport;
      let left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      let right = left + (viewport?.width ?? window.innerWidth), bottom = top + (viewport?.height ?? window.innerHeight);
      if (owner instanceof HTMLElement) {
        const box = owner.getBoundingClientRect();
        left = Math.max(left, box.left); top = Math.max(top, box.top); right = Math.min(right, box.right); bottom = Math.min(bottom, box.bottom);
      }
      bubble.style.maxWidth = `${Math.max(0, right - left - 16)}px`;
      bubble.style.maxHeight = `${Math.max(0, bottom - top - 16)}px`;
      const anchor = (current.current?.anchor ?? button).getBoundingClientRect();
      const box = bubble.getBoundingClientRect();
      bubble.style.left = `${Math.max(left + 8, Math.min(anchor.left, right - box.width - 8))}px`;
      bubble.style.top = `${anchor.bottom + box.height + 8 <= bottom ? anchor.bottom + 6 : Math.max(top + 8, anchor.top - box.height - 6)}px`;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(position); };
    schedulePosition.current = schedule;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && valid()) { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); dismiss(); return; }
      if (document.activeElement !== button || bubble.scrollHeight <= bubble.clientHeight) return;
      const amount = event.key === 'ArrowDown' ? 40 : event.key === 'ArrowUp' ? -40 : event.key === 'PageDown' ? bubble.clientHeight : event.key === 'PageUp' ? -bubble.clientHeight : 0;
      if (amount !== 0) { event.preventDefault(); event.stopPropagation(); bubble.scrollTop += amount; }
    };
    const pointerdown = (event: PointerEvent) => { if (event.target instanceof Node && !button.contains(event.target) && !bubble.contains(event.target)) dismiss(); };
    const focusin = (event: FocusEvent) => { if (event.target instanceof Element && ownerOf(event.target) !== owner) dismiss(); };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(button); observer?.observe(bubble);
    const mutation = new MutationObserver(() => { if (!valid()) dismiss(); else schedule(); });
    mutation.observe(document.body, { attributes: true, attributeFilter: ['inert', 'hidden'], childList: true, subtree: true });
    document.addEventListener('keydown', keydown, true); document.addEventListener('pointerdown', pointerdown, true); document.addEventListener('focusin', focusin, true);
    window.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule); window.visualViewport?.addEventListener('resize', schedule);
    schedule();
    return () => {
      schedulePosition.current = null;
      if (frame) cancelAnimationFrame(frame); observer?.disconnect(); mutation.disconnect();
      document.removeEventListener('keydown', keydown, true); document.removeEventListener('pointerdown', pointerdown, true); document.removeEventListener('focusin', focusin, true);
      window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule); window.visualViewport?.removeEventListener('resize', schedule);
    };
  }, [active, dismiss]);
  return <Context value={control}>{children}<div ref={tip} popover="manual" className="graph-reading-hint" role="tooltip"
    onPointerEnter={(event) => { if (event.pointerType !== 'touch') cancelLeave(); }}
    onPointerLeave={(event) => { if (event.pointerType !== 'touch' && current.current) leave(current.current.id); }}>
    {active?.reading.usage && <div>{active.reading.usage}</div>}{active?.reading.execution && <div>{active.reading.execution}</div>}
  </div></Context>;
};
