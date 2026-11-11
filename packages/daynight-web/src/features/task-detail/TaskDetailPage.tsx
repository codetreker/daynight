import { ProjectAccessBoundary, useProjectAccess } from "../projects/ProjectAccess";
import { useEffect, useRef, useState } from 'react';
import { navigate, navigateTaskDetail, type TaskDetailNavigation } from '../../app/router';
import { useI18n } from '../../i18n/LocaleProvider';
import { useTaskGraph } from '../projects/useTaskGraph';
import { TaskDetailSessionBoundary, useTaskDetailSessions } from './TaskDetailSession';
import { TypedDetail } from './TypedDetail';
import { TaskDetailDialog } from './TaskDetailDialog';
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
  const [target, setTarget] = useState<{ readonly parentId: string; readonly witness: string; readonly trigger: HTMLElement } | null>(null);
  useEffect(() => { setTarget(null); }, [projectId, taskId]);
  const sessions = useTaskDetailSessions();
  useEffect(() => sessions.subscribeProject(projectId, graph.refresh), [sessions, projectId, graph.refresh]);
  const select = (nextTask: string, selection: TaskDetailNavigation) => {
    navigateTaskDetail(projectId, nextTask, selection);
  };
  const navigateExternalTask = (id: string, trigger: HTMLElement) => {
    const node = graph.snapshot?.index.nodes.get(id);
    if (node === undefined) { graph.refresh(); return; }
    if (node.parentId === null) { navigate(`/projects/${encodeURIComponent(projectId)}#task=${encodeURIComponent(id)}`); return; }
    setTarget({ parentId: node.parentId, witness: id, trigger });
  };
  return <div className="task-detail-page-container">
    {access.status === 'unavailable' && <section className="state-box" role="alert"><h1>{shell.accessUnavailable}</h1><p>{shell.accessUnavailableDetail}</p><a className="button primary" href="/projects" onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate('/projects'); }}>{app.returnToProjects}</a></section>}
    <div className="task-detail-page-content" hidden={access.status === 'unavailable'} inert={access.status === 'unavailable'}>
    <TypedDetail key={`${projectId}/${taskId}`} presentation="page" fullscreen={{ active: fullscreen, onChange: setFullscreen }} projectId={projectId} taskId={taskId} snapshot={graph.snapshot} observation={{ kind: 'direct' }} graphError={graph.error} navigation={navigation} onNavigate={(selection) => select(taskId, selection)} onSelectTask={(id) => select(id, { tab: 'overview', path: null })} onRefreshGraph={graph.refresh} onNavigateExternalTask={navigateExternalTask} />
    {target !== null && <TaskDetailDialog key={target.parentId} projectId={projectId} taskId={target.parentId} snapshot={graph.snapshot} initialWitness={target.witness} onNavigateExternalTask={navigateExternalTask} onRefreshGraph={graph.refresh} onSelectTask={(id) => select(id, { tab: 'overview', path: null })} onClose={() => setTarget(null)} onRestoreFocus={() => { if (target.trigger.isConnected && !target.trigger.closest('[hidden], [inert]')) target.trigger.focus(); else document.querySelector<HTMLElement>('.goal-detail-surface .task-detail-title')?.focus(); }} />}
    </div>
  </div>;
};

export const TaskDetailPage = (props: TaskDetailPageProps) => <ProjectAccessBoundary projectId={props.projectId}><TaskDetailSessionBoundary><TaskDetailPageContent {...props} /></TaskDetailSessionBoundary></ProjectAccessBoundary>;
