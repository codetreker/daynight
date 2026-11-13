import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode, type RefCallback } from "react";
import { useI18n } from "../../i18n/LocaleProvider";
import type { CompletionValue } from "./useCompletionTime";
import "./completion.css";

type SourceState = { hover: boolean; tip: boolean; focus: boolean; pinned: boolean; dismissed: boolean };
const initialSources = (): SourceState => ({ hover: false, tip: false, focus: false, pinned: false, dismissed: false });
const ownerOf = (element: Element | null): Element | null => element?.closest('dialog, [role="dialog"], [role="alertdialog"]') ?? null;

// A tooltip stays in the source owner's DOM even though its popover is in the top layer.
const useHint = (value: CompletionValue | null, pinnable: boolean) => {
  const { messages: { completion } } = useI18n();
  const id = useId();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const tip = useRef<HTMLSpanElement | null>(null);
  const hoveredAnchor = useRef<HTMLElement | null>(null);
  const sources = useRef(initialSources());
  const touchPin = useRef(false);
  const timer = useRef<number | null>(null);
  const schedulePosition = useRef<(() => void) | null>(null);
  const [open, setOpen] = useState(false);
  const cancelTimer = useCallback(() => { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; }, []);
  const update = useCallback(() => {
    const s = sources.current;
    setOpen(!s.dismissed && (s.hover || s.tip || s.focus || s.pinned));
  }, []);
  const dismiss = useCallback(() => {
    cancelTimer();
    sources.current = { ...initialSources(), dismissed: true };
    touchPin.current = false;
    setOpen(false);
  }, [cancelTimer]);
  const deferUpdate = useCallback(() => {
    cancelTimer();
    timer.current = window.setTimeout(() => { timer.current = null; update(); }, 120);
  }, [cancelTimer, update]);
  const triggerRef: RefCallback<HTMLButtonElement> = useCallback((element) => { trigger.current = element; }, []);
  const labelEvents = {
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch") return;
      cancelTimer(); hoveredAnchor.current = event.currentTarget; sources.current.hover = true; sources.current.dismissed = false; update();
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch") return;
      sources.current.hover = false; deferUpdate();
    },
  };
  const triggerEvents = {
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => { touchPin.current = event.pointerType === "touch"; },
    onFocus: () => { cancelTimer(); sources.current.focus = true; sources.current.dismissed = false; update(); },
    onBlur: (_event: FocusEvent<HTMLButtonElement>) => dismiss(),
    onClick: () => {
      if (!pinnable) { dismiss(); return; }
      if (sources.current.pinned) { dismiss(); return; }
      cancelTimer(); sources.current.pinned = true; sources.current.dismissed = false; update(); schedulePosition.current?.();
    },
  };
  useEffect(() => () => cancelTimer(), [cancelTimer]);
  useLayoutEffect(() => { if (value === null) dismiss(); }, [value === null, dismiss]);
  useLayoutEffect(() => {
    const node = tip.current;
    if (node === null) return;
    if (typeof node.showPopover !== "function") return;
    if (open && value !== null) {
      if (!node.matches(":popover-open")) node.showPopover();
    } else if (node.matches(":popover-open")) node.hidePopover();
    return () => { if (node.matches(":popover-open")) node.hidePopover(); };
  }, [open, value !== null]);
  useLayoutEffect(() => {
    if (!open || value === null || trigger.current === null || tip.current === null) return;
    const button = trigger.current;
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
        left = Math.max(left, box.left); top = Math.max(top, box.top);
        right = Math.min(right, box.right); bottom = Math.min(bottom, box.bottom);
      }
      for (let ancestor = button.parentElement; ancestor !== null && ancestor !== owner; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const vertical = /(auto|scroll)/.test(style.overflowY) && ancestor.scrollHeight > ancestor.clientHeight;
        const horizontal = /(auto|scroll)/.test(style.overflowX) && ancestor.scrollWidth > ancestor.clientWidth;
        if (!vertical && !horizontal) continue;
        const bounds = ancestor.getBoundingClientRect();
        if (horizontal) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
        if (vertical) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
      }
      bubble.style.maxWidth = `${Math.max(0, right - left - 16)}px`;
      const anchor = (sources.current.hover || sources.current.tip ? hoveredAnchor.current : null)?.getBoundingClientRect() ?? button.getBoundingClientRect();
      const rect = bubble.getBoundingClientRect();
      const upperAnchor = pinnable && sources.current.pinned && touchPin.current ? button.closest('.chain-summary')?.getBoundingClientRect().top ?? anchor.top : anchor.top;
      bubble.style.left = `${Math.max(left + 8, Math.min(anchor.left, right - rect.width - 8))}px`;
      bubble.style.top = `${anchor.bottom + rect.height + 8 <= bottom ? anchor.bottom + 6 : Math.max(top + 8, upperAnchor - rect.height - 6)}px`;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(position); };
    schedulePosition.current = schedule;
    const competing = (event: Event) => { if ((event as CustomEvent<HTMLButtonElement>).detail !== button) dismiss(); };
    document.addEventListener("daynight:completion-hint", competing);
    document.dispatchEvent(new CustomEvent("daynight:completion-hint", { detail: button }));
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || sources.current.dismissed) return;
      if (!valid()) { dismiss(); return; }
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); dismiss();
    };
    const pointerdown = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !button.contains(event.target) && !bubble.contains(event.target)) dismiss();
    };
    const focusin = (event: globalThis.FocusEvent) => {
      if (event.target instanceof Element && ownerOf(event.target) !== owner) dismiss();
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(button); observer?.observe(bubble);
    const mutation = new MutationObserver(() => { if (!valid()) dismiss(); else schedule(); });
    mutation.observe(document.body, { attributes: true, attributeFilter: ["inert", "hidden"], childList: true, subtree: true });
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("pointerdown", pointerdown, true);
    document.addEventListener("focusin", focusin, true);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    schedule();
    return () => {
      schedulePosition.current = null;
      document.removeEventListener("daynight:completion-hint", competing);
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect(); mutation.disconnect();
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("pointerdown", pointerdown, true);
      document.removeEventListener("focusin", focusin, true);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, [open, value !== null, dismiss, pinnable]);
  useLayoutEffect(() => { schedulePosition.current?.(); }, [value?.label, value?.exact]);
  const hint: ReactNode = value === null ? null : <span id={id} ref={tip} role="tooltip" popover="manual" className="completion-hint"
    onPointerEnter={(event) => { if (event.pointerType !== "touch") { cancelTimer(); sources.current.tip = true; update(); } }}
    onPointerLeave={(event) => { if (event.pointerType !== "touch") { sources.current.tip = false; deferUpdate(); } }}>{completion.exact(value.exact)}</span>;
  return { triggerRef, descriptionId: value === null ? undefined : id, triggerEvents, labelEvents, hint };
};

export const useCompletionHint = (value: CompletionValue | null) => useHint(value, false);
export const useChainCompletionHint = (value: CompletionValue | null) => useHint(value, true);
