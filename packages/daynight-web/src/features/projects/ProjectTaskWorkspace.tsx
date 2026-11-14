import { TaskSessionSummaryProvider } from "../task-session-summary/TaskSessionSummaryProvider";
import { TaskPauseProvider } from "../task-pause/TaskPause";
import { ProjectPausedTasks } from "./ProjectPausedTasks";
import type { GraphTask } from "../../api/types";
import type { ComponentProps, ReactNode } from "react";
import { useI18n } from "../../i18n/LocaleProvider";
import { ChainList } from "../task-graph/ChainList";
import { ProjectTaskTabs } from "./ProjectTaskTabs";
import { StandaloneList } from "./StandaloneList";
import { GoalList } from "./GoalList";
import type { TaskView } from "./useProjectViewPreferences";
import type { GraphSnapshot } from "./useTaskGraph";
import type { TaskSessionSummaryStore } from "../task-session-summary/store";

export const ProjectTaskWorkspace = ({ snapshot, sessionStore, active = true, activeView, pausedTasks, onOpenPausedTask, onPausedFocusFallback, unfinishedStandaloneTaskCount, unfinishedChainCount, unfinishedGoalCount, onViewChange, filter, chains, standalone, goals }: {
  readonly active?: boolean;
  readonly filter?: ReactNode;
  readonly snapshot: GraphSnapshot;
  readonly sessionStore: TaskSessionSummaryStore;
  readonly activeView: TaskView;
  readonly pausedTasks: readonly GraphTask[];
  readonly onOpenPausedTask: (id: string, trigger: HTMLElement) => void;
  readonly onPausedFocusFallback: () => void;
  readonly unfinishedStandaloneTaskCount: number;
  readonly unfinishedChainCount: number;
  readonly unfinishedGoalCount: number;
  readonly onViewChange: (view: TaskView) => void;
  readonly chains: Omit<ComponentProps<typeof ChainList>, "index" | "workerMachines">;
  readonly standalone: Omit<ComponentProps<typeof StandaloneList>, "index">;
  readonly goals: Omit<ComponentProps<typeof GoalList>, "index" | "workerMachines">;
}) => {
  const { messages: { workspace: { project: m, sections } } } = useI18n();
  return <>
    <div className="project-section-heading"><h2>{sections.tasks}</h2><ProjectPausedTasks tasks={pausedTasks} active={active} onOpenTask={onOpenPausedTask} onFocusFallback={onPausedFocusFallback} /></div>
      <TaskPauseProvider taskIds={snapshot.pausedTaskIds}><TaskSessionSummaryProvider store={sessionStore} active={active}>
        <ProjectTaskTabs activeView={activeView} unfinishedStandaloneTaskCount={unfinishedStandaloneTaskCount}
          unfinishedChainCount={unfinishedChainCount} unfinishedGoalCount={unfinishedGoalCount} onViewChange={onViewChange} />
        {filter}
        <div role="tabpanel" id="project-task-panel-chains" aria-labelledby="project-task-tab-chains" hidden={activeView !== "chains"}>
          {activeView === "chains" && <section aria-label={m.chains}><ChainList index={snapshot.index} workerMachines={snapshot.workerMachines} {...chains} /></section>}
        </div>
        <div role="tabpanel" id="project-task-panel-standalone" aria-labelledby="project-task-tab-standalone" hidden={activeView !== "standalone"} tabIndex={-1}>
          {activeView === "standalone" && <StandaloneList index={snapshot.index} {...standalone} />}
        </div>
        <div role="tabpanel" id="project-task-panel-goals" aria-labelledby="project-task-tab-goals" hidden={activeView !== "goals"} tabIndex={-1}>
          {activeView === "goals" && <GoalList index={snapshot.index} workerMachines={snapshot.workerMachines} {...goals} />}
        </div>
      </TaskSessionSummaryProvider></TaskPauseProvider>
  </>;
};
