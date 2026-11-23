import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useI18n } from "../../i18n/LocaleProvider";
import { projectSectionUrl } from "../../app/router";
import type { ProjectSection } from "./useProjectViewPreferences";

const sections = ["overview", "statistics", "tasks", "prs", "tags"] as const;

export const ProjectSectionTabs = ({ projectId, section, onChange }: {
  readonly projectId: string;
  readonly section: ProjectSection;
  readonly onChange: (section: ProjectSection, onCommit?: () => void) => void;
}) => {
  const { locale, messages: { workspace: { sections: m } } } = useI18n();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [horizontal, setHorizontal] = useState(() => window.innerWidth <= 740);
  useEffect(() => {
    const resize = () => { setHorizontal(window.innerWidth <= 740); };
    window.addEventListener("resize", resize);
    return () => { window.removeEventListener("resize", resize); };
  }, []);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !horizontal) return;
    const revealSelection = () => {
      const tab = scroller.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!tab) return;
      const bounds = scroller.getBoundingClientRect(), selected = tab.getBoundingClientRect();
      // Keep correction inside the tab strip so content position and focus survive.
      if (selected.left < bounds.left) scroller.scrollLeft += selected.left - bounds.left - 4;
      else if (selected.right > bounds.right) scroller.scrollLeft += selected.right - bounds.right + 4;
    };
    revealSelection();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(revealSelection);
    observer?.observe(scroller);
    for (const tab of scroller.children) observer?.observe(tab);
    return () => { observer?.disconnect(); };
  }, [horizontal, locale, projectId, section]);
  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>, current: ProjectSection) => {
    if (event.key === " ") { event.preventDefault(); onChange(current); return; }
    const position = sections.indexOf(current);
    const nextKey = horizontal ? "ArrowRight" : "ArrowDown";
    const previousKey = horizontal ? "ArrowLeft" : "ArrowUp";
    const target = event.key === nextKey ? sections[(position + 1) % sections.length]
      : event.key === previousKey ? sections[(position + sections.length - 1) % sections.length]
        : event.key === "Home" ? sections[0] : event.key === "End" ? sections[sections.length - 1] : undefined;
    if (target === undefined) return;
    event.preventDefault();
    if (target !== current) onChange(target, () => {
      const tab = document.getElementById(`project-section-tab-${target}`);
      tab?.focus({ preventScroll: true });
    });
  };
  const onClick = (event: MouseEvent<HTMLAnchorElement>, value: ProjectSection) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onChange(value);
  };
  return <div ref={scrollerRef} className="project-section-tabs" role="tablist" aria-label={m.label} aria-orientation={horizontal ? "horizontal" : "vertical"}>
    {sections.map((value) => <a key={value} className="project-section-tab" href={projectSectionUrl(projectId, value)} role="tab"
      id={`project-section-tab-${value}`} aria-controls={`project-section-panel-${value}`} aria-selected={section === value}
      tabIndex={section === value ? 0 : -1} onClick={(event) => { onClick(event, value); }} onKeyDown={(event) => { onKeyDown(event, value); }}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        {value === "overview" ? <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M3 9h18M9 9v12" /></> : value === "statistics" ? <><path d="M4 20V12h4v8M10 20V5h4v15M16 20V9h4v11M2 20h20" /></> : value === "tasks" ? <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" strokeLinecap="round" strokeWidth="3" /></> : value === "prs" ? <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="19" r="2" /><path d="M6 7v10M11 5h3a4 4 0 0 1 4 4v8M11 5l3-3M11 5l3 3" /></> : <><path d="M20 13 13 20a2 2 0 0 1-3 0L3 13V4h9l8 6a2 2 0 0 1 0 3Z" /><circle cx="7.5" cy="8.5" r="1" /></>}
      </svg>
      {m[value]}
    </a>)}
  </div>;
};
