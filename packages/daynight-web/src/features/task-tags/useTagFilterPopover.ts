import { useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { nearestOverlayOwner } from '../../app/overlay';
import { isNativeSelectPopupOpen } from '../../ui/native-select/NativeSelect';

const filterOpened = 'daynight:tag-filter-opened';
const interactive = (element: HTMLElement): boolean => {
  if (!element.isConnected || element.closest('[hidden], [inert]') !== null) return false;
  const view = element.ownerDocument.defaultView;
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    const style = view?.getComputedStyle(node);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
  }
  return true;
};
const dialogOwner = (element: Element | null): Element | null => element?.closest('dialog, [role="dialog"], [role="alertdialog"]') ?? null;

export const useTagFilterPopover = (open: boolean, setOpen: (open: boolean) => void) => {
  const rootRef = useRef<HTMLDetailsElement>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<(() => void) | null>(null);
  const previousOpen = useRef(open);

  useLayoutEffect(() => {
    const opening = open && !previousOpen.current;
    previousOpen.current = open;
    const root = rootRef.current;
    const panel = panelRef.current;
    if (!open || root === null || panel === null) return;
    const doc = root.ownerDocument;
    const view = doc.defaultView;
    if (view === null) return;
    const ownsEscape = (target: EventTarget | null): boolean => {
      if (!(target instanceof Node) || isNativeSelectPopupOpen(target)) return false;
      if (dialogOwner(target instanceof Element ? target : null) !== dialogOwner(root)) return false;
      const overlay = nearestOverlayOwner(new Set(doc.querySelectorAll<HTMLElement>('*')));
      return overlay === null || overlay.contains(root);
    };
    const closeWithFocus = () => {
      setOpen(false);
      if (triggerRef.current !== null && interactive(triggerRef.current)) triggerRef.current.focus();
    };
    const competing = (event: Event) => {
      if ((event as CustomEvent<HTMLElement>).detail !== root && interactive(root)) setOpen(false);
    };
    const pointerdown = (event: PointerEvent) => {
      if (interactive(root) && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || !interactive(root) || !(event.target instanceof Node) || root.contains(event.target) || !ownsEscape(event.target)) return;
      event.preventDefault(); event.stopPropagation(); closeWithFocus();
    };
    doc.addEventListener(filterOpened, competing);
    if (interactive(root)) {
      doc.dispatchEvent(new CustomEvent(filterOpened, { detail: root }));
      if (opening && searchRef.current !== null && interactive(searchRef.current)) searchRef.current.focus();
    }
    doc.addEventListener('pointerdown', pointerdown, true);
    doc.addEventListener('keydown', keydown);

    const position = () => {
      const viewport = view.visualViewport;
      const x = viewport?.offsetLeft ?? 0;
      const y = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? doc.documentElement.clientWidth;
      const height = viewport?.height ?? doc.documentElement.clientHeight;
      const marginX = Math.min(16, Math.max(0, (width - 48) / 2));
      const marginY = Math.min(16, Math.max(0, (height - 48) / 2));
      const leftEdge = x + marginX, rightEdge = x + width - marginX;
      const topEdge = y + marginY, bottomEdge = y + height - marginY;
      const bounds = root.getBoundingClientRect();
      const trigger = triggerRef.current;
      if (trigger === null) return;
      const anchor = trigger.getBoundingClientRect();
      const selected = selectedRef.current;
      const chips = selected !== null && selected.getClientRects().length > 0 && interactive(selected) ? selected.getBoundingClientRect() : null;
      const anchorTop = chips === null ? anchor.top : Math.min(anchor.top, chips.top);
      const anchorBottom = chips === null ? anchor.bottom : Math.max(anchor.bottom, chips.bottom);
      const write = (property: 'left' | 'top' | 'maxWidth' | 'maxHeight', value: number) => {
        const next = `${Math.max(property.startsWith('max') ? 0 : -Infinity, value)}px`;
        if (panel.style[property] !== next) panel.style[property] = next;
      };
      const paddingX = `${Math.max(0, (rightEdge - leftEdge - 3) / 2)}px`;
      if (panel.style.getPropertyValue('--tag-filter-padding-x') !== paddingX) panel.style.setProperty('--tag-filter-padding-x', paddingX);
      write('maxWidth', rightEdge - leftEdge);
      const panelWidth = panel.getBoundingClientRect().width;
      const left = Math.max(leftEdge, Math.min(anchor.left, rightEdge - panelWidth));
      const naturalHeight = panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
      const gap = 5;
      let top: number, available: number;
      if (anchorBottom <= topEdge || anchorTop >= bottomEdge) {
        top = topEdge; available = bottomEdge - topEdge;
      } else {
        const belowStart = Math.max(topEdge, Math.min(bottomEdge, anchorBottom + gap));
        const aboveEnd = Math.max(topEdge, Math.min(bottomEdge, anchorTop - gap));
        const below = bottomEdge - belowStart, above = aboveEnd - topEdge;
        if (naturalHeight <= below || below >= above) {
          top = belowStart; available = below;
        } else {
          available = above; top = aboveEnd - Math.min(naturalHeight, above);
        }
      }
      // If neither side leaves a usable scrollport, overlap the anchor instead.
      if (available < 48) { top = topEdge; available = bottomEdge - topEdge; }
      const paddingY = `${Math.max(0, (available - 3) / 2)}px`;
      if (panel.style.getPropertyValue('--tag-filter-padding-y') !== paddingY) panel.style.setProperty('--tag-filter-padding-y', paddingY);
      write('left', left - bounds.left);
      write('top', top - bounds.top);
      write('maxHeight', available);
    };
    positionRef.current = position;
    position();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position);
    observer?.observe(root); observer?.observe(panel);
    if (triggerRef.current !== null) observer?.observe(triggerRef.current);
    if (selectedRef.current !== null) observer?.observe(selectedRef.current);
    if (root.parentElement !== null) observer?.observe(root.parentElement);
    const toolbar = root.closest('.task-list-filters');
    if (toolbar !== null) {
      observer?.observe(toolbar);
      for (const control of toolbar.children) observer?.observe(control);
    }
    view.addEventListener('resize', position);
    view.addEventListener('scroll', position, true);
    view.visualViewport?.addEventListener('resize', position);
    view.visualViewport?.addEventListener('scroll', position);
    return () => {
      positionRef.current = null;
      doc.removeEventListener(filterOpened, competing);
      doc.removeEventListener('pointerdown', pointerdown, true);
      doc.removeEventListener('keydown', keydown);
      observer?.disconnect();
      view.removeEventListener('resize', position);
      view.removeEventListener('scroll', position, true);
      view.visualViewport?.removeEventListener('resize', position);
      view.visualViewport?.removeEventListener('scroll', position);
    };
  }, [open, setOpen]);

  useLayoutEffect(() => { positionRef.current?.(); });

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDetailsElement>) => {
    const root = rootRef.current;
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || root === null || !root.open || !interactive(root)) return;
    if (isNativeSelectPopupOpen(event.target)) { event.stopPropagation(); return; }
    const target = event.target instanceof Element ? event.target : null;
    if (dialogOwner(target) !== dialogOwner(root)) return;
    const overlay = nearestOverlayOwner(new Set(root.ownerDocument.querySelectorAll<HTMLElement>('*')));
    if (overlay !== null && !overlay.contains(root)) return;
    event.preventDefault(); event.stopPropagation(); setOpen(false);
    if (triggerRef.current !== null && interactive(triggerRef.current)) triggerRef.current.focus();
  };
  return { rootRef, triggerRef, panelRef, searchRef, selectedRef, onKeyDown };
};
