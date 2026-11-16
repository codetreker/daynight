import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';

export const useTagFilterPopover = (open: boolean, setOpen: (open: boolean) => void, locale: string) => {
  const wrap = useRef<HTMLDivElement>(null);
  const details = useRef<HTMLDetailsElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if (open) search.current?.focus({ preventScroll: true });
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = wrap.current;
      const element = panel.current;
      if (anchor === null || element === null) return;
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft ?? 0) + 16;
      const topEdge = (viewport?.offsetTop ?? 0) + 16;
      const width = (viewport?.width ?? document.documentElement.clientWidth) - 32;
      const bottomEdge = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 16;
      const bounds = anchor.getBoundingClientRect();
      const panelWidth = Math.min(352, width);
      element.style.width = `${panelWidth}px`;
      element.style.left = `${Math.max(leftEdge, Math.min(bounds.left, leftEdge + width - panelWidth))}px`;
      const below = bottomEdge - bounds.bottom - 8;
      const above = bounds.top - 8 - topEdge;
      const useViewport = bounds.top < topEdge || bounds.bottom > bottomEdge || Math.max(below, above) < 240;
      const placeBelow = below >= Math.min(element.scrollHeight, 360) || below >= above;
      const available = useViewport ? bottomEdge - topEdge : placeBelow ? below : above;
      element.style.maxHeight = `${available}px`;
      element.style.top = `${useViewport ? topEdge : placeBelow ? Math.max(topEdge, bounds.bottom + 8) : Math.max(topEdge, bounds.top - 8 - element.getBoundingClientRect().height)}px`;
    };
    position();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position);
    if (wrap.current !== null) observer?.observe(wrap.current);
    if (panel.current !== null) observer?.observe(panel.current);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [open, locale]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrap.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open, setOpen]);

  const onKeyDown = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    trigger.current?.focus();
  };

  return { wrap, details, panel, search, trigger, onKeyDown };
};
