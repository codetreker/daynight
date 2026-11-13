import { createContext, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { nearestOverlayOwner } from '../../app/overlay';
import { browserNavigation, type DraftScope } from '../../app/navigation';
import { parseAuthRoute, parseRoute } from '../../app/router';
import { readMyTasksHistory, readProjectHistory, readResourceHistory } from '../../app/page-history';
import { isRetiredMyTasksEntry, isRetiredResourceEntry } from '../../app/use-page-history';
import { useI18n } from '../../i18n/LocaleProvider';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { TaskConfirmation } from './TaskConfirmation';

type ResourceHost = { readonly projectId: string; readonly rootId: string; readonly kind: 'root' | 'root-child' | 'external' | 'external-child'; readonly parentId?: string };
const ResourceHostContext = createContext<ResourceHost | null>(null);
type ProjectHost = { readonly projectId: string; readonly rootId: string; readonly child: boolean; readonly source: 'summary' | 'direct'; readonly summaryType: 'task' | 'goal' | null | undefined; readonly insideProjectGraph: boolean; readonly graphWitness: string | null };
const ProjectHostContext = createContext<ProjectHost | null>(null);
type MyTasksHost = { readonly projectId: string; readonly rootId: string; readonly child: boolean };
const MyTasksHostContext = createContext<MyTasksHost | null>(null);

export const MyTasksDraftHost = ({ projectId, taskId, children }: { readonly projectId: string; readonly taskId: string; readonly children: ReactNode }) => {
  const host = useMemo<MyTasksHost>(() => ({ projectId, rootId: taskId, child: false }), [projectId, taskId]);
  return <MyTasksHostContext.Provider value={host}>{children}</MyTasksHostContext.Provider>;
};

export const ProjectDraftHost = ({ projectId, taskId, source, summaryType, insideProjectGraph, graphWitness, children }: {
  readonly projectId: string; readonly taskId: string; readonly source: 'summary' | 'direct'; readonly summaryType: 'task' | 'goal' | null | undefined; readonly insideProjectGraph: boolean; readonly graphWitness: string | null; readonly children: ReactNode;
}) => {
  const host = useMemo<ProjectHost>(() => ({ projectId, rootId: taskId, child: false, source, summaryType, insideProjectGraph, graphWitness }), [projectId, taskId, source, summaryType, insideProjectGraph, graphWitness]);
  return <ProjectHostContext.Provider value={host}>{children}</ProjectHostContext.Provider>;
};

export const ResourcePageDraftHost = ({ projectId, taskId, children }: { readonly projectId: string; readonly taskId: string; readonly children: ReactNode }) => {
  const host = useMemo<ResourceHost>(() => ({ projectId, rootId: taskId, kind: 'root' }), [projectId, taskId]);
  return <ResourceHostContext.Provider value={host}>{children}</ResourceHostContext.Provider>;
};

export const ResourceExternalDraftHost = ({ parentId, children }: { readonly parentId: string; readonly children: ReactNode }) => {
  const host = useContext(ResourceHostContext);
  const value = useMemo<ResourceHost | null>(() => host === null ? null : { ...host, kind: 'external', parentId }, [host, parentId]);
  return <ResourceHostContext.Provider value={value}>{children}</ResourceHostContext.Provider>;
};

export const ResourceChildDraftHost = ({ children }: { readonly children: ReactNode }) => {
  const host = useContext(ResourceHostContext);
  const value = useMemo<ResourceHost | null>(() => host === null ? null : { ...host, kind: host.kind === 'root' ? 'root-child' : 'external-child' }, [host]);
  const projectHost = useContext(ProjectHostContext);
  const projectValue = useMemo<ProjectHost | null>(() => projectHost === null ? null : { ...projectHost, child: true }, [projectHost]);
  const myTasksHost = useContext(MyTasksHostContext);
  const myTasksValue = useMemo<MyTasksHost | null>(() => myTasksHost === null ? null : { ...myTasksHost, child: true }, [myTasksHost]);
  return <MyTasksHostContext.Provider value={myTasksValue}><ProjectHostContext.Provider value={projectValue}><ResourceHostContext.Provider value={value}>{children}</ResourceHostContext.Provider></ProjectHostContext.Provider></MyTasksHostContext.Provider>;
};

type DraftContext = { readonly scope: DraftScope; readonly signal: AbortSignal; readonly survives: (url: URL, view?: unknown, entryId?: string) => boolean };
const Context = createContext<DraftContext | null>(null);

export const TaskDraftBoundary = ({ projectId, taskId, page, projectSourceSensitive = true, children }: {
  readonly projectId: string; readonly taskId: string; readonly page: boolean; readonly projectSourceSensitive?: boolean; readonly children: ReactNode;
}) => {
  const identity = useTaskCacheScope();
  const host = useContext(ResourceHostContext);
  const projectHost = useContext(ProjectHostContext);
  const myTasksHost = useContext(MyTasksHostContext);
  const value = useMemo<DraftContext>(() => ({
    scope: { identity, projectId, taskId }, signal: identity.signal,
    survives: (url, view, entryId) => {
      const target = parseRoute(url.pathname, url.search);
      if (myTasksHost !== null) {
        if (parseAuthRoute(url.pathname, url.search).kind !== 'myTasks' || myTasksHost.projectId !== projectId || view === undefined) return false;
        try {
          const selection = readMyTasksHistory(view, identity.userId);
          if (selection === null || entryId !== undefined && isRetiredMyTasksEntry(identity, projectId, entryId)) return false;
          const detail = selection.detail;
          if (detail === null || detail.projectId !== projectId || detail.id !== myTasksHost.rootId) return false;
          return myTasksHost.child ? detail.goalChildren?.task?.id === taskId : taskId === myTasksHost.rootId;
        } catch { return false; }
      }
      if (projectHost !== null) {
        if (target.kind !== 'project' || target.projectId !== projectId || projectHost.projectId !== projectId || view === undefined) return false;
        try {
          const selection = readProjectHistory(view, identity.userId, projectId);
          if (selection === null || entryId !== undefined && isRetiredResourceEntry(identity, projectId, entryId)) return false;
          const detail = selection.detail;
          if (detail === null || detail.id !== projectHost.rootId || !projectHost.child && projectSourceSensitive && detail.source !== projectHost.source || detail.insideProjectGraph !== projectHost.insideProjectGraph ||
              projectHost.insideProjectGraph && selection.projectGraphWitness !== projectHost.graphWitness) return false;
          // A Goal reader keeps its direct-qualified owner when the graph is absent,
          // but an available graph must still identify the summary target as a Goal.
          if (detail.source !== projectHost.source && detail.source === 'summary' &&
              (projectHost.child || !projectSourceSensitive) && projectHost.summaryType !== undefined && projectHost.summaryType !== 'goal') return false;
          return projectHost.child ? detail.goalChildren?.task?.id === taskId : taskId === projectHost.rootId;
        } catch { return false; }
      }
      const samePage = (target.kind === 'task' || target.kind === 'attachment') && target.projectId === projectId;
      if (host === null) return page && samePage && target.taskId === taskId;
      if (!samePage || target.taskId !== host.rootId || host.projectId !== projectId) return false;
      if (host.kind === 'root') return page && taskId === host.rootId;
      // Same-resource URL entries carry the current nested readers when initialized.
      if (view === undefined) return true;
      try {
        const selection = readResourceHistory(view, identity.userId, projectId, host.rootId);
        if (selection === null) return false;
        if (entryId !== undefined && isRetiredResourceEntry(identity, projectId, entryId)) return false;
        if (host.kind === 'root-child') return selection.goalChildren?.task?.id === taskId;
        const external = selection.externalGoal;
        if (external === null || external.id !== host.parentId) return false;
        return host.kind === 'external' ? taskId === host.parentId : external.goalChildren?.task?.id === taskId;
      } catch { return false; }
    },
  }), [identity, projectId, taskId, page, host, projectHost, myTasksHost, projectSourceSensitive]);
  useLayoutEffect(() => identity.subscribe((event) => {
    if (event.projectId === projectId && event.accessRevoked) browserNavigation().retireScope(value.scope);
  }), [identity, projectId, value]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
};

/** Keep this hook mounted with the draft workspace, including when its reading tab is hidden. */
export const useDirtyTaskDraft = (draft: { readonly isDirty: () => boolean; readonly discard: () => void }): void => {
  const context = useContext(Context);
  if (context === null) throw new Error('Task drafts require the current task draft boundary.');
  const current = useRef(draft);
  current.current = draft;
  useLayoutEffect(() => browserNavigation().register({ ...context,
    isDirty: () => current.current.isDirty(), discard: () => current.current.discard(),
  }), [context]);
};

export const useRequestTaskDraftAction = () => {
  const context = useContext(Context);
  if (context === null) throw new Error('Task drafts require the current task draft boundary.');
  return (action: () => void): void => browserNavigation().requestScopeAction(context.scope, action);
};

export const useDraftNavigationDecision = () => {
  const owner = browserNavigation();
  return useSyncExternalStore(owner.subscribeDecision, owner.decision);
};

export const useRetireTaskDraft = (retired: boolean): void => {
  const context = useContext(Context)!;
  useLayoutEffect(() => { if (retired) browserNavigation().retireScope(context.scope); }, [retired, context]);
};

const confirmationOwners = new Set<HTMLElement>();

export const DraftNavigationConfirmation = ({ owner, fallbackFocus, taskTitle }: {
  readonly owner: RefObject<HTMLElement | null>; readonly fallbackFocus: RefObject<HTMLElement | null>; readonly taskTitle: string;
}) => {
  const decision = useDraftNavigationDecision();
  useLayoutEffect(() => { const element = owner.current; if (element === null) return; confirmationOwners.add(element); return () => { confirmationOwners.delete(element); }; }, [owner]);
  const { messages: { inspection: { draftNavigation: m } } } = useI18n();
  if (decision === null || owner.current === null || nearestOverlayOwner(confirmationOwners) !== owner.current) return null;
  return <TaskConfirmation title={m.title} question={m.question} explanation={m.explanation} taskTitle={taskTitle}
    confirmLabel={m.discard} cancelLabel={m.keep} closeLabel={m.close} destructive owner={owner} fallbackFocus={fallbackFocus}
    onCancel={browserNavigation().cancel} onConfirm={browserNavigation().confirm} />;
};
