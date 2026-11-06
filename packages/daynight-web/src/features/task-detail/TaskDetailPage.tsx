import { ProjectAccessBoundary, useProjectAccess } from "../projects/ProjectAccess";
import { useEffect, useRef, useState } from 'react';
import { navigate, navigateTaskDetail, type TaskDetailNavigation } from '../../app/router';
import { useI18n } from '../../i18n/LocaleProvider';
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
  const access = useProjectAccess(projectId);
  const { messages: { auth: { shell }, workspace: { app } } } = useI18n();
  const graphOwner = useRef(Symbol());
  useProjectAssigneeReceipt(projectId, graphOwner.current, graph.snapshot?.revision ?? 0);
  const [fullscreen, setFullscreen] = useState(false);
  const sessions = useTaskDetailSessions();
  useEffect(() => sessions.subscribeProject(projectId, graph.refresh), [sessions, projectId, graph.refresh]);
  const select = (nextTask: string, selection: TaskDetailNavigation) => {
    navigateTaskDetail(projectId, nextTask, selection);
  };
  return <div className="task-detail-page-container">
    {access.status === 'unavailable' && <section className="state-box" role="alert"><h1>{shell.accessUnavailable}</h1><p>{shell.accessUnavailableDetail}</p><a className="button primary" href="/projects" onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate('/projects'); }}>{app.returnToProjects}</a></section>}
    <div className="task-detail-page-content" hidden={access.status === 'unavailable'} inert={access.status === 'unavailable'}>
    <TaskDetailSurface key={`${projectId}/${taskId}`} presentation="page" fullscreen={{ active: fullscreen, onChange: setFullscreen }} projectId={projectId} taskId={taskId} snapshot={graph.snapshot} observation={{ kind: 'direct' }} graphError={graph.error} navigation={navigation} onNavigate={(selection) => select(taskId, selection)} onSelectTask={(id) => select(id, { tab: 'overview', path: null })} onRefreshGraph={graph.refresh} />
    </div>
  </div>;
};

export const TaskDetailPage = (props: TaskDetailPageProps) => <ProjectAccessBoundary projectId={props.projectId}><TaskDetailSessionBoundary><TaskDetailPageContent {...props} /></TaskDetailSessionBoundary></ProjectAccessBoundary>;
