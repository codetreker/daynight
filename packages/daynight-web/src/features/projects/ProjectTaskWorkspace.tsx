import type { ComponentProps } from "react";
import { useI18n } from "../../i18n/LocaleProvider";
import { TaskExecutionClockProvider } from "../task-execution/TaskExecutionClock";
import { ChainList } from "../task-graph/ChainList";
import { ProjectTaskTabs } from "./ProjectTaskTabs";
import { StandaloneList } from "./StandaloneList";
import type { TaskView } from "./useProjectViewPreferences";
import type { GraphSnapshot } from "./useTaskGraph";

export const ProjectTaskWorkspace = ({ projectId, snapshot, activeView, unfinishedStandaloneTaskCount, unfinishedChainTaskCount, onViewChange, chains, standalone }: {
  readonly projectId: string;
  readonly snapshot: GraphSnapshot;
  readonly activeView: TaskView;
  readonly unfinishedStandaloneTaskCount: number;
  readonly unfinishedChainTaskCount: number;
  readonly onViewChange: (view: TaskView) => void;
  readonly chains: Omit<ComponentProps<typeof ChainList>, "index">;
  readonly standalone: Omit<ComponentProps<typeof StandaloneList>, "index">;
}) => {
  const { messages: { workspace: { project: m, sections } } } = useI18n();
  return <>
    <div className="project-section-heading"><h2>{sections.tasks}</h2></div>
    {snapshot.graph.summary.total === 0 ? <section className="state-box"><h2>{m.empty}</h2><p>{m.emptyDetail}</p></section> : (
      <TaskExecutionClockProvider projectId={projectId} snapshot={snapshot}>
        <ProjectTaskTabs activeView={activeView} unfinishedStandaloneTaskCount={unfinishedStandaloneTaskCount}
          unfinishedChainTaskCount={unfinishedChainTaskCount} onViewChange={onViewChange} />
        <div role="tabpanel" id="project-task-panel-chains" aria-labelledby="project-task-tab-chains" hidden={activeView !== "chains"}>
          {activeView === "chains" && <section aria-label={m.chains}><ChainList index={snapshot.index} {...chains} /></section>}
        </div>
        <div role="tabpanel" id="project-task-panel-standalone" aria-labelledby="project-task-tab-standalone" hidden={activeView !== "standalone"} tabIndex={-1}>
          {activeView === "standalone" && <StandaloneList index={snapshot.index} {...standalone} />}
        </div>
      </TaskExecutionClockProvider>
    )}
  </>;
};
