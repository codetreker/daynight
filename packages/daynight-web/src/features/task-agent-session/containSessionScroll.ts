/** Keep boundary gestures from scrolling a Session's ancestors, without owning
 * the timeline, textarea or menu scroll position. */
export function containSessionScroll(root: HTMLElement, additionalBoundary: () => HTMLElement | null): () => void {
  let touch: { id: number; x: number; y: number } | null = null;
  const boundaryFor = (target: EventTarget | null) => {
    if (!(target instanceof Element) || root.closest('[hidden], [inert]') || target.closest('[hidden], [inert]')) return null;
    if (root.contains(target)) return root;
    const additional = additionalBoundary();
    return additional?.contains(target) ? additional : null;
  };
  const consumes = (target: Element, boundary: HTMLElement, x: number, y: number) => {
    const horizontal = Math.abs(x) > Math.abs(y), delta = horizontal ? x : y;
    if (delta === 0) return true;
    for (let element: Element | null = target; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (/(auto|scroll|overlay)/.test(horizontal ? style.overflowX : style.overflowY)) {
        const extent = horizontal ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight;
        const position = horizontal ? element.scrollLeft : element.scrollTop;
        // RTL scrollLeft ranges from -extent to zero in the supported engines.
        const rtl = horizontal && style.direction === 'rtl';
        if (extent > 0 && (delta < 0 ? position > (rtl ? -extent : 0) : position < (rtl ? 0 : extent) - 1)) return true;
      }
      if (element === boundary) break;
    }
    return false;
  };
  const start = (event: TouchEvent) => {
    const point = event.touches.length === 1 && boundaryFor(event.target) ? event.touches[0] : undefined;
    touch = point ? { id: point.identifier, x: point.clientX, y: point.clientY } : null;
  };
  const move = (event: TouchEvent) => {
    const previous = touch;
    start(event);
    const boundary = boundaryFor(event.target);
    if (!previous || !touch || touch.id !== previous.id || !boundary || event.defaultPrevented) return;
    const target = event.target as Element;
    // Native selection handles and range controls own their drag gestures.
    const editable = target.closest('textarea, input, [contenteditable="true"]');
    if (editable instanceof HTMLTextAreaElement || editable instanceof HTMLInputElement) {
      if (editable instanceof HTMLInputElement && editable.type === 'range' || editable.selectionStart !== editable.selectionEnd) return;
    } else if (editable && !window.getSelection()?.isCollapsed) return;
    if (!consumes(target, boundary, previous.x - touch.x, previous.y - touch.y) && event.cancelable) event.preventDefault();
  };
  const wheel = (event: WheelEvent) => {
    const boundary = boundaryFor(event.target);
    if (boundary && !event.ctrlKey && !event.defaultPrevented && !consumes(event.target as Element, boundary, event.deltaX, event.deltaY) && event.cancelable) event.preventDefault();
  };
  const end = () => { touch = null; };
  // React's delegated timeline handlers must see the gesture before its default
  // scrolling is cancelled: upward reading still pauses following/loads history.
  document.addEventListener('touchstart', start, { passive: true });
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
  document.addEventListener('wheel', wheel, { passive: false });
  return () => {
    document.removeEventListener('touchstart', start);
    document.removeEventListener('touchmove', move);
    document.removeEventListener('touchend', end);
    document.removeEventListener('touchcancel', end);
    document.removeEventListener('wheel', wheel);
  };
}
