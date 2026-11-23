import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "./horizontal-tab-list.css";

export const HorizontalTabList = ({ children, label, revealKey, className }: {
  readonly children: ReactNode;
  readonly label: string;
  readonly revealKey: string;
  readonly className: string;
}) => {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ start: false, end: false });
  const updateOverflow = () => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const start = scroller.scrollLeft > 1;
    const end = scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft > 1;
    setOverflow(current => current.start === start && current.end === end ? current : { start, end });
  };
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const revealSelection = () => {
      const selected = scroller.querySelector<HTMLElement>('[aria-selected="true"]');
      if (selected !== null) {
        const bounds = scroller.getBoundingClientRect(), tab = selected.getBoundingClientRect();
        const padding = getComputedStyle(scroller);
        const left = bounds.left + parseFloat(padding.paddingLeft);
        const right = bounds.right - parseFloat(padding.paddingRight);
        // Change only this strip's scroll position; ancestor scrolling loses the content position.
        if (tab.left < left) scroller.scrollLeft += tab.left - left;
        else if (tab.right > right) scroller.scrollLeft += tab.right - right;
      }
      updateOverflow();
    };
    revealSelection();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(revealSelection);
    observer?.observe(scroller);
    for (const tab of scroller.children) observer?.observe(tab);
    return () => { observer?.disconnect(); };
  }, [revealKey]);
  return <div className={`horizontal-tab-list ${className}`} data-overflow-start={overflow.start} data-overflow-end={overflow.end}>
    <div ref={scrollerRef} className="horizontal-tab-list-track tabs" role="tablist" aria-label={label} aria-orientation="horizontal" onScroll={updateOverflow}>
      {children}
    </div>
  </div>;
};
