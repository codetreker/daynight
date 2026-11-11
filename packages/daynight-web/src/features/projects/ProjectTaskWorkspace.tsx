import { TaskSessionSummaryProvider } from "../task-session-summary/TaskSessionSummaryProvider";
import { TaskPauseCount, TaskPauseProvider } from "../task-pause/TaskPause";
import { pausedSummaryTaskIds } from "../task-pause/paused-summary";
import type { ComponentProps, ReactNode } from "react";
import { useI18n } from "../../i18n/LocaleProvider";
import { TaskExecutionClockProvider } from "../task-execution/TaskExecutionClock";
import { ChainList } from "../task-graph/ChainList";
import { ProjectTaskTabs } from "./ProjectTaskTabs";
import { StandaloneList } from "./StandaloneList";
import { GoalList } from "./GoalList";
import type { TaskView } from "./useProjectViewPreferences";
import type { GraphSnapshot } from "./useTaskGraph";
import type { TaskSessionSummaryStore } from "../task-session-summary/store";

export const ProjectTaskWorkspace = ({ projectId, snapshot, sessionStore, active = true, activeView, unfinishedStandaloneTaskCount, unfinishedChainTaskCount, goalCount, onViewChange, filter, chains, standalone, goals }: {
  readonly projectId: string;
  readonly active?: boolean;
  readonly filter?: ReactNode;
  readonly snapshot: GraphSnapshot;
  readonly sessionStore: TaskSessionSummaryStore;
  readonly activeView: TaskView;
  readonly unfinishedStandaloneTaskCount: number;
  readonly unfinishedChainTaskCount: number;
  readonly goalCount: number;
  readonly onViewChange: (view: TaskView) => void;
  readonly chains: Omit<ComponentProps<typeof ChainList>, "index" | "workerMachines">;
  readonly standalone: Omit<ComponentProps<typeof StandaloneList>, "index">;
  readonly goals: Omit<ComponentProps<typeof GoalList>, "index">;
}) => {
  const { messages: { workspace: { project: m, sections } } } = useI18n();
  return <>
    <div className="project-section-heading"><h2>{sections.tasks}</h2><TaskPauseCount count={pausedSummaryTaskIds(snapshot.graph.tasks, snapshot.pausedTaskIds).size} /></div>
      <TaskPauseProvider taskIds={snapshot.pausedTaskIds}><TaskExecutionClockProvider projectId={projectId} snapshot={snapshot}>
        <ProjectTaskTabs activeView={activeView} unfinishedStandaloneTaskCount={unfinishedStandaloneTaskCount}
          unfinishedChainTaskCount={unfinishedChainTaskCount} goalCount={goalCount} onViewChange={onViewChange} />
        {filter}
        <div role="tabpanel" id="project-task-panel-chains" aria-labelledby="project-task-tab-chains" hidden={activeView !== "chains"}>
          {activeView === "chains" && <TaskSessionSummaryProvider store={sessionStore} active={active}><section aria-label={m.chains}><ChainList index={snapshot.index} workerMachines={snapshot.workerMachines} {...chains} /></section></TaskSessionSummaryProvider>}
        </div>
        <div role="tabpanel" id="project-task-panel-standalone" aria-labelledby="project-task-tab-standalone" hidden={activeView !== "standalone"} tabIndex={-1}>
          {activeView === "standalone" && <StandaloneList index={snapshot.index} {...standalone} />}
        </div>
        <div role="tabpanel" id="project-task-panel-goals" aria-labelledby="project-task-tab-goals" hidden={activeView !== "goals"} tabIndex={-1}>
          {activeView === "goals" && <GoalList index={snapshot.index} {...goals} />}
        </div>
      </TaskExecutionClockProvider></TaskPauseProvider>
  </>;
};
