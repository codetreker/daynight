import { ProjectAccessBoundary } from "../projects/ProjectAccess";
import { useEffect, useRef, useState } from 'react';
import { navigateTaskDetail, type TaskDetailNavigation } from '../../app/router';
import { useTaskGraph } from '../projects/useTaskGraph';
import { TaskDetailSessionBoundary, useTaskDetailSessions } from './TaskDetailSession';
import { TaskDetailSurface } from './TaskDetailSurface';
import { useProjectAssigneeReceipt } from '../task-assignees/TaskAssignees';
import '../../styles/task-detail.css';

type TaskDetailPageProps = {
  readonly projectId: string;
  readonly taskId: string;
  readonly navigation: TaskDetailNavigation;
};

const TaskDetailPageContent = ({ projectId, taskId, navigation }: TaskDetailPageProps) => {
  const graph = useTaskGraph(projectId);
  const graphOwner = useRef(Symbol());
  useProjectAssigneeReceipt(projectId, graphOwner.current, graph.snapshot?.revision ?? 0);
  const [fullscreen, setFullscreen] = useState(false);
  const sessions = useTaskDetailSessions();
  useEffect(() => sessions.subscribeProject(projectId, graph.refresh), [sessions, projectId, graph.refresh]);
  const select = (nextTask: string, selection: TaskDetailNavigation) => {
    navigateTaskDetail(projectId, nextTask, selection);
  };
  return <div className="task-detail-page-container">
    <TaskDetailSurface key={`${projectId}/${taskId}`} presentation="page" fullscreen={{ active: fullscreen, onChange: setFullscreen }} projectId={projectId} taskId={taskId} snapshot={graph.snapshot} observation={{ kind: 'direct' }} graphError={graph.error} navigation={navigation} onNavigate={(selection) => select(taskId, selection)} onSelectTask={(id) => select(id, { tab: 'overview', path: null })} onRefreshGraph={graph.refresh} />
  </div>;
};

export const TaskDetailPage = (props: TaskDetailPageProps) => <ProjectAccessBoundary projectId={props.projectId}><TaskDetailSessionBoundary><TaskDetailPageContent {...props} /></TaskDetailSessionBoundary></ProjectAccessBoundary>;
