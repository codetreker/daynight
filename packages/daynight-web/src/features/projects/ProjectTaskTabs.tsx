import type { KeyboardEvent } from "react";
import { useI18n } from "../../i18n/LocaleProvider";
import type { TaskView } from "./useProjectViewPreferences";

const views = ["standalone", "chains", "goals"] as const;

type ProjectTaskTabsProps = {
  readonly activeView: TaskView;
  readonly unfinishedStandaloneTaskCount: number;
  readonly unfinishedChainCount: number;
  readonly goalCount: number;
  readonly onViewChange: (view: TaskView) => void;
};

export const ProjectTaskTabs = ({ activeView, unfinishedStandaloneTaskCount, unfinishedChainCount, goalCount, onViewChange }: ProjectTaskTabsProps) => {
  const { messages: { workspace: { tabs: m } }, format } = useI18n();
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, view: TaskView) => {
    const position = views.indexOf(view);
    const target = event.key === "ArrowRight" ? views[(position + 1) % views.length]
      : event.key === "ArrowLeft" ? views[(position + views.length - 1) % views.length]
        : event.key === "Home" ? views[0] : event.key === "End" ? views[views.length - 1] : undefined;
    if (target === undefined) return;
    event.preventDefault();
    onViewChange(target);
    document.getElementById(`project-task-tab-${target}`)!.focus({ preventScroll: true });
  };
  return <div className="project-task-tabs" role="tablist" aria-label={m.label}>{views.map((view) => (
    <button className="project-task-tab" type="button" role="tab" id={`project-task-tab-${view}`} key={view}
      aria-label={m[view]} aria-selected={activeView === view} aria-controls={`project-task-panel-${view}`} tabIndex={activeView === view ? 0 : -1}
      onClick={() => { onViewChange(view); }} onKeyDown={(event) => { onKeyDown(event, view); }}>
      {m[view]}<span className="graph-count-pill" title={view === "goals" ? m.goals : view === "chains" ? m.unfinishedChainCount : m.unfinishedCount} aria-hidden="true">{format.number(view === "standalone" ? unfinishedStandaloneTaskCount : view === "chains" ? unfinishedChainCount : goalCount)}</span>
    </button>
  ))}</div>;
};
