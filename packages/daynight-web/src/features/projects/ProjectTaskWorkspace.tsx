import { TaskSessionSummaryProvider } from "../task-session-summary/TaskSessionSummaryProvider";
import { TaskPauseCount, TaskPauseProvider } from "../task-pause/TaskPause";
import { pausedSummaryTaskIds } from "../task-pause/paused-summary";
import type { ComponentProps, ReactNode } from "react";
import { useI18n } from "../../i18n/LocaleProvider";
import { TaskExecutionClockProvider } from "../task-execution/TaskExecutionClock";
import { ChainList } from "../task-graph/ChainList";
import { ProjectTaskTabs } from "./ProjectTaskTabs";
import { StandaloneList } from "./StandaloneList";
import type { TaskView } from "./useProjectViewPreferences";
import type { GraphSnapshot } from "./useTaskGraph";
import type { TaskSessionSummaryStore } from "../task-session-summary/store";

export const ProjectTaskWorkspace = ({ projectId, snapshot, sessionStore, active = true, activeView, unfinishedStandaloneTaskCount, unfinishedChainTaskCount, onViewChange, filter, chains, standalone }: {
  readonly projectId: string;
  readonly active?: boolean;
  readonly filter?: ReactNode;
  readonly snapshot: GraphSnapshot;
  readonly sessionStore: TaskSessionSummaryStore;
  readonly activeView: TaskView;
  readonly unfinishedStandaloneTaskCount: number;
  readonly unfinishedChainTaskCount: number;
  readonly onViewChange: (view: TaskView) => void;
  readonly chains: Omit<ComponentProps<typeof ChainList>, "index" | "workerMachines">;
  readonly standalone: Omit<ComponentProps<typeof StandaloneList>, "index">;
}) => {
  const { messages: { workspace: { project: m, sections } } } = useI18n();
  return <>
    <div className="project-section-heading"><h2>{sections.tasks}</h2><TaskPauseCount count={pausedSummaryTaskIds(snapshot.graph.tasks, snapshot.pausedTaskIds).size} /></div>
    {snapshot.graph.summary.total === 0 ? <section className="state-box"><h2>{m.empty}</h2><p>{m.emptyDetail}</p></section> : (
      <TaskPauseProvider taskIds={snapshot.pausedTaskIds}><TaskExecutionClockProvider projectId={projectId} snapshot={snapshot}>
        <ProjectTaskTabs activeView={activeView} unfinishedStandaloneTaskCount={unfinishedStandaloneTaskCount}
          unfinishedChainTaskCount={unfinishedChainTaskCount} onViewChange={onViewChange} />
        {filter}
        <div role="tabpanel" id="project-task-panel-chains" aria-labelledby="project-task-tab-chains" hidden={activeView !== "chains"}>
          {activeView === "chains" && <TaskSessionSummaryProvider store={sessionStore} active={active}><section aria-label={m.chains}><ChainList index={snapshot.index} workerMachines={snapshot.workerMachines} {...chains} /></section></TaskSessionSummaryProvider>}
        </div>
        <div role="tabpanel" id="project-task-panel-standalone" aria-labelledby="project-task-tab-standalone" hidden={activeView !== "standalone"} tabIndex={-1}>
          {activeView === "standalone" && <StandaloneList index={snapshot.index} {...standalone} />}
        </div>
      </TaskExecutionClockProvider></TaskPauseProvider>
    )}
  </>;
};
