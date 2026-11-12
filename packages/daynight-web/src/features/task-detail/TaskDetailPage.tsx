import { ProjectAccessBoundary, useProjectAccess } from "../projects/ProjectAccess";
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { navigate, navigateTaskDetail, type TaskDetailNavigation } from '../../app/router';
import { useResourceHistory } from '../../app/use-page-history';
import { useI18n } from '../../i18n/LocaleProvider';
import { useTaskGraph } from '../projects/useTaskGraph';
import { TaskDetailSessionBoundary, useTaskDetailSessions } from './TaskDetailSession';
import { TypedDetail } from './TypedDetail';
import { TaskDetailDialog } from './TaskDetailDialog';
import { TaskExecutionClockProvider } from '../task-execution/TaskExecutionClock';
import { useProjectAssigneeReceipt } from '../task-assignees/TaskAssignees';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { ResourceExternalDraftHost, ResourcePageDraftHost } from './TaskDraftNavigation';
import '../../styles/task-detail.css';

type TaskDetailPageProps = {
  readonly projectId: string;
  readonly taskId: string;
  readonly navigation: TaskDetailNavigation;
};

const TaskDetailPageContent = ({ projectId, taskId, navigation }: TaskDetailPageProps) => {
  const graph = useTaskGraph(projectId);
  const access = useProjectAccess(projectId);
  const { locale, messages: { auth: { shell }, workspace: { app } } } = useI18n();
  const identity = useTaskCacheScope();
  const history = useResourceHistory(identity.userId, projectId, taskId, true, identity);
  const graphOwner = useRef(Symbol());
  useProjectAssigneeReceipt(projectId, graphOwner.current, graph.snapshot?.revision ?? 0);
  const [fullscreen, setFullscreen] = useState(false);
  const targetTrigger = useRef<HTMLElement | null>(null);
  const requestedTarget = history.selection.externalGoal;
  const admittedTarget = useRef<string | null>(null);
  if (requestedTarget === null) admittedTarget.current = null;
  else if (admittedTarget.current !== requestedTarget.id) admittedTarget.current = graph.snapshot?.index.nodes.get(requestedTarget.witness)?.parentId === requestedTarget.id ? requestedTarget.id : null;
  const target = requestedTarget !== null && admittedTarget.current === requestedTarget.id ? requestedTarget : null;
  const sessions = useTaskDetailSessions();
  useEffect(() => sessions.subscribeProject(projectId, graph.refresh), [sessions, projectId, graph.refresh]);
  const select = (nextTask: string, selection: TaskDetailNavigation) => {
    navigateTaskDetail(projectId, nextTask, selection);
  };
  const navigateExternalTask = (id: string, trigger: HTMLElement) => {
    const node = graph.snapshot?.index.nodes.get(id);
    if (node === undefined) { graph.refresh(); return; }
    if (node.parentId === null) { navigate(`/projects/${encodeURIComponent(projectId)}#task=${encodeURIComponent(id)}`); return; }
    targetTrigger.current = trigger;
    history.select({ goalChildren: null, externalGoal: { id: node.parentId, witness: id, navigation: { tab: 'description', path: null }, goalChildren: { graphRootId: null, task: { id, navigation: { tab: 'overview', path: null } } } } });
  };
  const navigateExternalChain = (id: string, trigger: HTMLElement) => {
    const node = graph.snapshot?.index.nodes.get(id);
    if (node === undefined || graph.snapshot === null) { graph.refresh(); return; }
    const representative = graph.snapshot.index.componentByTask.get(id)!;
    if (graph.snapshot.index.components.get(representative)!.memberIds.size === 1) {
      if (node.parentId === null) select(id, { tab: 'overview', path: null });
      else navigateExternalTask(id, trigger);
      return;
    }
    if (node.parentId === null) { navigate(`/projects/${encodeURIComponent(projectId)}#chain=${encodeURIComponent(id)}`); return; }
    targetTrigger.current = trigger;
    history.select({ goalChildren: null, externalGoal: { id: node.parentId, witness: id, navigation: { tab: 'description', path: null }, goalChildren: { graphRootId: representative, task: null } } });
  };
  const returnToRoot = (href: string) => {
    history.select({ goalChildren: null, externalGoal: null }, true, () => {
      // URL entries inherit the retained selection; publish the cleared view first.
      flushSync(() => {});
      navigate(href);
    });
  };
  return <TaskExecutionClockProvider projectId={projectId} snapshot={graph.snapshot}><div className="task-detail-page-container">
    {access.status === 'unavailable' && <section className="state-box" role="alert"><h1>{shell.accessUnavailable}</h1><p>{shell.accessUnavailableDetail}</p><a className="button primary" href="/projects" onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate('/projects'); }}>{app.returnToProjects}</a></section>}
    {history.error && <div className="notice error" role="alert">{locale === 'zh-CN' ? '页面导航状态无效。' : 'Invalid page navigation state.'}</div>}
    <div className="task-detail-page-content" hidden={access.status === 'unavailable' || history.error} inert={access.status === 'unavailable' || history.error}>
    <ResourcePageDraftHost projectId={projectId} taskId={taskId}>
    <TypedDetail key={`${projectId}/${taskId}`} presentation="page" fullscreen={{ active: fullscreen, onChange: setFullscreen }} projectId={projectId} taskId={taskId} snapshot={graph.snapshot} observation={{ kind: 'direct' }} graphError={graph.error} goalGraphError={graph.error} navigation={navigation} onNavigate={(selection) => select(taskId, selection)} onSelectTask={(id) => select(id, { tab: 'overview', path: null })} onRefreshGraph={graph.refresh} onNavigateExternalTask={navigateExternalTask} onNavigateExternalChain={navigateExternalChain} onNavigateParent={returnToRoot} goalChildren={history.selection.goalChildren ?? { graphRootId: null, task: null }} onGoalChildrenChange={(goalChildren, options) => history.select({ ...history.selection, goalChildren }, options?.replace)} />
    {target !== null && <ResourceExternalDraftHost parentId={target.id}><TaskDetailDialog key={target.id} projectId={projectId} taskId={target.id} snapshot={graph.snapshot} goalGraphError={graph.error} navigation={target.navigation} onNavigate={(navigation) => history.select({ ...history.selection, externalGoal: { ...target, navigation } })} goalChildren={target.goalChildren ?? { graphRootId: null, task: null }} onGoalChildrenChange={(goalChildren, options) => history.select({ ...history.selection, externalGoal: { ...target, goalChildren } }, options?.replace)} onNavigateExternalTask={navigateExternalTask} onNavigateExternalChain={navigateExternalChain} onNavigateParent={returnToRoot} onRefreshGraph={graph.refresh} onSelectTask={(id) => select(id, { tab: 'overview', path: null })} onClose={() => history.select({ ...history.selection, externalGoal: null }, true)} onRestoreFocus={() => { const trigger = targetTrigger.current; if (trigger?.isConnected && !trigger.closest('[hidden], [inert]')) trigger.focus(); else document.querySelector<HTMLElement>('.goal-detail-surface .task-detail-title')?.focus(); }} /></ResourceExternalDraftHost>}
    </ResourcePageDraftHost>
    </div>
  </div></TaskExecutionClockProvider>;
};

export const TaskDetailPage = (props: TaskDetailPageProps) => <ProjectAccessBoundary projectId={props.projectId}><TaskDetailSessionBoundary><TaskDetailPageContent {...props} /></TaskDetailSessionBoundary></ProjectAccessBoundary>;
