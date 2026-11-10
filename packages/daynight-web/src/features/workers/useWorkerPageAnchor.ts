import { useLayoutEffect, useRef } from 'react';
import { captureReadingText, readingTextTop, type ReadingTextAnchor } from '../../ui/reading-text-anchor';

type Anchor = { node: HTMLElement; top: number; text?: ReadingTextAnchor };

// Track visible items as the user scrolls. A response can remove the first item,
// so keep several candidates and restore the first survivor after the commit.
export const useWorkerPageAnchor = (revision: unknown, error: unknown, workerRevision: unknown, ageClass: string) => {
  const page = useRef<HTMLDivElement>(null);
  const saved = useRef<Anchor[]>([]);
  const capture = () => {
    if (window.scrollY <= 0 || !page.current) { saved.current = []; return; }
    const viewport = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    saved.current = Array.from(page.current.querySelectorAll<HTMLElement>('[data-worker-reading]')).flatMap(node => {
      const box = node.getBoundingClientRect();
      if (box.bottom <= 0 || box.top >= window.innerHeight) return [];
      const text = captureReadingText(node, viewport);
      return [{ node, top: box.top, ...(text ? { text } : {}) }];
    });
  };
  const captureRef = useRef(capture); captureRef.current = capture;
  useLayoutEffect(() => {
    const onScroll = () => captureRef.current();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); };
  }, []);
  useLayoutEffect(() => {
    for (const anchor of saved.current) {
      if (!anchor.node.isConnected) continue;
      const top = anchor.text ? readingTextTop(anchor.node, anchor.text) ?? anchor.node.getBoundingClientRect().top : anchor.node.getBoundingClientRect().top;
      const expected = anchor.text ? anchor.text.top : anchor.top;
      if (Math.abs(top - expected) > 1) window.scrollBy(0, top - expected);
      break;
    }
    captureRef.current();
  }, [revision, error, workerRevision, ageClass]);
  return page;
};
