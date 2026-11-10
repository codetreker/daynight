import { useLayoutEffect, useRef, useState } from 'react';
import type { useTimelineScroll } from '../../ui/useTimelineScroll';

type PendingInteraction = { readonly entryId: string; readonly title: string };
type Target = PendingInteraction & { readonly direction: 'up' | 'down' };

// Visibility and local response state belong to the rendered card. A provider
// snapshot can still say pending after the card has submitted its response.
export function usePendingInteractionLocator(scroll: ReturnType<typeof useTimelineScroll>, active: boolean, pending: readonly PendingInteraction[]) {
  const [target, setTarget] = useState<Target | null>(null);
  const current = useRef({ scroll, active, pending }); current.current = { scroll, active, pending };
  const cards = () => {
    const { scroll, active, pending } = current.current, box = scroll.viewport.current;
    if (!active || !box || box.clientHeight === 0 || !pending.length) return [];
    const requests = new Map(pending.map(request => [request.entryId, request]));
    return Array.from(box.querySelectorAll<HTMLElement>('[data-entry-key]')).flatMap(row => {
      const request = requests.get(row.dataset.entryKey!);
      if (!request) return [];
      const card = row.querySelector<HTMLElement>('.session-interaction');
      const controls = card?.querySelector<HTMLFieldSetElement>('form > fieldset');
      return card && controls && !controls.disabled ? [{ ...request, card }] : [];
    });
  };
  const measure = () => {
    const available = cards();
    const bounds = available.length ? current.current.scroll.viewport.current?.getBoundingClientRect() : undefined;
    let next: Target | null = null;
    if (bounds && bounds.height > 0) {
      for (const request of available) {
        const rect = request.card.getBoundingClientRect();
        // A visible portion is sufficient even when a form is taller than the
        // viewport. Ignore tiny edge slivers that do not expose usable content.
        const inset = Math.min(24, bounds.height / 4, rect.height / 2);
        if (rect.height > 0 && (rect.bottom <= bounds.top + inset || rect.top >= bounds.bottom - inset)) {
          next = { entryId: request.entryId, title: request.title, direction: rect.top < bounds.top ? 'up' : 'down' };
          break;
        }
      }
    }
    setTarget(previous => previous?.entryId === next?.entryId && previous?.title === next?.title && previous?.direction === next?.direction ? previous : next);
  };
  const measureRef = useRef(measure); measureRef.current = measure;
  useLayoutEffect(() => { measureRef.current(); }, [active, pending, scroll.showLatest]);
  const observing = active && pending.length > 0;
  useLayoutEffect(() => {
    const box = scroll.viewport.current, body = scroll.content.current;
    if (!observing || !box || !body) return;
    const notify = () => measureRef.current();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(notify);
    resize?.observe(box); resize?.observe(body);
    const mutation = new MutationObserver(notify);
    mutation.observe(body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'open', 'hidden'] });
    box.addEventListener('scroll', notify);
    window.addEventListener('resize', notify);
    return () => { resize?.disconnect(); mutation.disconnect(); box.removeEventListener('scroll', notify); window.removeEventListener('resize', notify); };
  }, [observing, scroll.viewport, scroll.content]);
  const reveal = () => {
    const { scroll } = current.current, box = scroll.viewport.current;
    const request = cards().find(request => request.entryId === target?.entryId);
    if (!box || !request) { measureRef.current(); return; }
    if (scroll.reveal(request.card, 12)) request.card.focus({ preventScroll: true });
    measureRef.current();
  };
  return { target, reveal };
}
