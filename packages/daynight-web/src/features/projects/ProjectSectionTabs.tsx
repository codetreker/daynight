import { useEffect, useState, type KeyboardEvent } from "react";
import { useI18n } from "../../i18n/LocaleProvider";

export type ProjectSection = "overview" | "tasks";
const sections = ["overview", "tasks"] as const;

export const ProjectSectionTabs = ({ section, onChange }: {
  readonly section: ProjectSection;
  readonly onChange: (section: ProjectSection) => void;
}) => {
  const { messages: { workspace: { sections: m } } } = useI18n();
  const [horizontal, setHorizontal] = useState(() => window.innerWidth <= 740);
  useEffect(() => {
    const resize = () => { setHorizontal(window.innerWidth <= 740); };
    window.addEventListener("resize", resize);
    return () => { window.removeEventListener("resize", resize); };
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: ProjectSection) => {
    const position = sections.indexOf(current);
    const nextKey = horizontal ? "ArrowRight" : "ArrowDown";
    const previousKey = horizontal ? "ArrowLeft" : "ArrowUp";
    const target = event.key === nextKey ? sections[(position + 1) % sections.length]
      : event.key === previousKey ? sections[(position + sections.length - 1) % sections.length]
        : event.key === "Home" ? sections[0] : event.key === "End" ? sections[sections.length - 1] : undefined;
    if (target === undefined) return;
    event.preventDefault();
    onChange(target);
    document.getElementById(`project-section-tab-${target}`)!.focus({ preventScroll: true });
  };
  return <div className="project-section-tabs" role="tablist" aria-label={m.label} aria-orientation={horizontal ? "horizontal" : "vertical"}>
    {sections.map((value) => <button key={value} className="project-section-tab" type="button" role="tab"
      id={`project-section-tab-${value}`} aria-controls={`project-section-panel-${value}`} aria-selected={section === value}
      tabIndex={section === value ? 0 : -1} onClick={() => { onChange(value); }} onKeyDown={(event) => { onKeyDown(event, value); }}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        {value === "overview" ? <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M3 9h18M9 9v12" /></> : <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" strokeLinecap="round" strokeWidth="3" /></>}
      </svg>
      {m[value]}
    </button>)}
  </div>;
};
