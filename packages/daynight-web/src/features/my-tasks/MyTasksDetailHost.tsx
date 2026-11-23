import { useEffect, useRef } from 'react';
import { navigate, navigateTaskDetail } from '../../app/router';
import type { MyTasksReading } from '../../app/page-history';
import { ProjectAccessBoundary } from '../projects/ProjectAccess';
import { useTaskGraph } from '../projects/useTaskGraph';
import { useProjectAssigneeReceipt } from '../task-assignees/TaskAssignees';
import { MyTasksDraftHost } from '../task-detail/TaskDraftNavigation';
import { TaskDetailDialog } from '../task-detail/TaskDetailDialog';
import { TaskDetailSessionBoundary, useTaskDetailSessions } from '../task-detail/TaskDetailSession';
import { TaskExecutionClockProvider } from '../task-execution/TaskExecutionClock';

type Selection = NonNullable<MyTasksReading['detail']>;
type Props = {
  readonly detail: Selection;
  readonly select: (detail: Selection | null, replace?: boolean) => void;
  readonly refreshList: () => void;
  readonly restoreFocus: () => void;
};

const Content = ({ detail, select, refreshList, restoreFocus }: Props) => {
  const { projectId } = detail;
  const graph = useTaskGraph(projectId);
  const owner = useRef(Symbol());
  useProjectAssigneeReceipt(projectId, owner.current, graph.snapshot?.revision ?? 0);
  const sessions = useTaskDetailSessions();
  useEffect(() => sessions.subscribeProject(projectId, () => { graph.refresh(); refreshList(); }), [sessions, projectId, graph.refresh, refreshList]);

  const openTask = (id: string) => {
    const node = graph.snapshot?.index.nodes.get(id);
    if (node === undefined) { navigateTaskDetail(projectId, id, { tab: 'overview', path: null }); return; }
    if (node.parentId === null) select({ projectId, id, navigation: { tab: 'overview', path: null }, goalChildren: null });
    else select({ projectId, id: node.parentId, navigation: { tab: 'description', path: null }, goalChildren: { graphRootId: null, task: { id, navigation: { tab: 'overview', path: null } } } });
  };
  const openChain = (id: string) => {
    const snapshot = graph.snapshot;
    const node = snapshot?.index.nodes.get(id);
    if (snapshot === null || node === undefined) { navigate(`/projects/${encodeURIComponent(projectId)}#chain=${encodeURIComponent(id)}`); return; }
    const representative = snapshot.index.componentByTask.get(id);
    if (representative === undefined) { navigate(`/projects/${encodeURIComponent(projectId)}#chain=${encodeURIComponent(id)}`); return; }
    if (snapshot.index.components.get(representative)!.memberIds.size === 1) { openTask(id); return; }
    if (node.parentId === null) { navigate(`/projects/${encodeURIComponent(projectId)}#chain=${encodeURIComponent(id)}`); return; }
    select({ projectId, id: node.parentId, navigation: { tab: 'description', path: null }, goalChildren: { graphRootId: representative, task: null } });
  };
  return <TaskExecutionClockProvider projectId={projectId} snapshot={graph.snapshot}>
    <MyTasksDraftHost projectId={projectId} taskId={detail.id}>
      <TaskDetailDialog key={detail.id} projectId={projectId} taskId={detail.id} snapshot={graph.snapshot} observation={{ kind: 'direct' }}
        graphError={graph.error} goalGraphError={graph.error} navigation={detail.navigation}
        onNavigate={navigation => select({ ...detail, navigation })}
        goalChildren={detail.goalChildren ?? { graphRootId: null, task: null }}
        onGoalChildrenChange={(goalChildren, options) => select({ ...detail, goalChildren }, options?.replace)}
        onSelectTask={openTask} onNavigateExternalTask={openTask} onNavigateExternalChain={openChain}
        onNavigateParent={navigate} onRefreshGraph={graph.refresh} onClose={() => select(null, true)} onRestoreFocus={restoreFocus} />
    </MyTasksDraftHost>
  </TaskExecutionClockProvider>;
};

export const MyTasksDetailHost = (props: Props) => <ProjectAccessBoundary projectId={props.detail.projectId} initialRead><TaskDetailSessionBoundary><Content {...props} /></TaskDetailSessionBoundary></ProjectAccessBoundary>;
