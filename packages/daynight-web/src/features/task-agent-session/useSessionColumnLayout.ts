import { useLayoutEffect, type RefObject } from 'react';

/** Keep the composer on the rendered reading column, including scrollbar space. */
export function useSessionColumnLayout(sectionRef: RefObject<HTMLElement | null>, identity: string | null) {
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!identity || !section) return;
    const viewport = section.querySelector<HTMLElement>('.session-timeline');
    const content = section.querySelector<HTMLElement>('.session-timeline-content');
    const composer = section.querySelector<HTMLElement>('.session-composer');
    if (!viewport || !content || !composer) return;
    const align = () => {
      const column = content.getBoundingClientRect(), form = composer.getBoundingClientRect();
      // Hidden panels have no usable geometry; observe them until they return.
      if (column.width <= 0 || form.width <= 0) return;
      const style = getComputedStyle(composer);
      const left = Math.max(0, column.left - form.left - (Number.parseFloat(style.borderLeftWidth) || 0));
      const right = Math.max(0, form.right - column.right - (Number.parseFloat(style.borderRightWidth) || 0));
      composer.style.setProperty('--session-column-left', `${left}px`);
      composer.style.setProperty('--session-column-right', `${right}px`);
    };
    align();
    let frame: number | undefined;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      // Match textarea sizing: do not change observed dimensions during delivery.
      frame = requestAnimationFrame(() => { frame = undefined; align(); });
    });
    observer?.observe(section);
    observer?.observe(viewport);
    observer?.observe(content);
    return () => {
      observer?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      composer.style.removeProperty('--session-column-left');
      composer.style.removeProperty('--session-column-right');
    };
  }, [sectionRef, identity]);
}
