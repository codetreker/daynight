import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { navigateTaskDetail, type TaskDetailNavigation } from '../../app/router';
import { useI18n } from '../../i18n/LocaleProvider';
import { ProjectGraphErrorDetail, projectGraphErrorTitle } from '../projects/ProjectGraphError';
import { useTaskGraph } from '../projects/useTaskGraph';
import { TaskDetailSessionBoundary, useTaskDetailSessions } from './TaskDetailSession';
import { TaskDetailPageBar, TaskDetailSurface } from './TaskDetailSurface';
import '../../styles/task-detail.css';

type TaskDetailPageProps = {
  readonly projectId: string;
  readonly taskId: string;
  readonly navigation: TaskDetailNavigation;
};

const TaskDetailPageContent = ({ projectId, taskId, navigation }: TaskDetailPageProps) => {
  const graph = useTaskGraph(projectId);
  const [fullscreen, setFullscreen] = useState(false);
  const sessions = useTaskDetailSessions();
  const main = useRef<HTMLElement>(null);
  const { messages: { inspection: { detail: m }, workspace: { project: projectMessages, projects } } } = useI18n();
  useEffect(() => sessions.subscribeProject(projectId, graph.refresh), [sessions, projectId, graph.refresh]);
  useLayoutEffect(() => { main.current?.focus(); }, [graph.snapshot === null]);
  const select = (nextTask: string, selection: TaskDetailNavigation) => {
    navigateTaskDetail(projectId, nextTask, selection);
  };
  if (graph.snapshot === null) return <main className="task-detail-page" tabIndex={-1} ref={main} aria-label={m.title}>
    <TaskDetailPageBar projectId={projectId} /><header className="task-detail-header"><h1 className="task-detail-title">{m.title}</h1></header>
    {graph.status === 'loading' ? <div className="task-detail-state" role="status"><span className="spinner" aria-hidden="true" /><p>{projectMessages.loading}</p></div> : <div className="task-detail-state" role="alert"><h2>{projectGraphErrorTitle(graph.error, projectMessages)}</h2><ProjectGraphErrorDetail error={graph.error} /><button className="button primary" type="button" onClick={graph.refresh}>{projects.retry}</button></div>}
  </main>;
  return <div className="task-detail-page-container">
    <TaskDetailSurface key={`${projectId}/${taskId}`} presentation="page" fullscreen={{ active: fullscreen, onChange: setFullscreen }} projectId={projectId} taskId={taskId} snapshot={graph.snapshot} graphError={graph.error} navigation={navigation} onNavigate={(selection) => select(taskId, selection)} onSelectTask={(id) => select(id, { tab: 'overview', path: null })} onRefreshGraph={graph.refresh} />
  </div>;
};

export const TaskDetailPage = (props: TaskDetailPageProps) => <TaskDetailSessionBoundary><TaskDetailPageContent {...props} /></TaskDetailSessionBoundary>;
