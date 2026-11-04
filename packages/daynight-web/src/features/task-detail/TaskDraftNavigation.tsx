import { createContext, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { browserNavigation, type DraftScope } from '../../app/navigation';
import { parseRoute } from '../../app/router';
import { useI18n } from '../../i18n/LocaleProvider';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { TaskConfirmation } from './TaskConfirmation';

type DraftContext = { readonly scope: DraftScope; readonly signal: AbortSignal; readonly survives: (url: URL) => boolean };
const Context = createContext<DraftContext | null>(null);

export const TaskDraftBoundary = ({ projectId, taskId, page, children }: {
  readonly projectId: string; readonly taskId: string; readonly page: boolean; readonly children: ReactNode;
}) => {
  const identity = useTaskCacheScope();
  const value = useMemo<DraftContext>(() => ({
    scope: { identity, projectId, taskId }, signal: identity.signal,
    survives: (url) => {
      const target = parseRoute(url.pathname, url.search);
      return page && (target.kind === 'task' || target.kind === 'attachment') && target.projectId === projectId && target.taskId === taskId;
    },
  }), [identity, projectId, taskId, page]);
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

export const useDraftNavigationDecision = () => {
  const owner = browserNavigation();
  return useSyncExternalStore(owner.subscribeDecision, owner.decision);
};

export const useRetireTaskDraft = (retired: boolean): void => {
  const context = useContext(Context)!;
  useLayoutEffect(() => { if (retired) browserNavigation().retireScope(context.scope); }, [retired, context]);
};

export const DraftNavigationConfirmation = ({ owner, fallbackFocus, taskTitle }: {
  readonly owner: RefObject<HTMLElement | null>; readonly fallbackFocus: RefObject<HTMLElement | null>; readonly taskTitle: string;
}) => {
  const decision = useDraftNavigationDecision();
  const { messages: { inspection: { draftNavigation: m } } } = useI18n();
  if (decision === null) return null;
  return <TaskConfirmation title={m.title} question={m.question} explanation={m.explanation} taskTitle={taskTitle}
    confirmLabel={m.discard} cancelLabel={m.keep} closeLabel={m.close} destructive owner={owner} fallbackFocus={fallbackFocus}
    onCancel={browserNavigation().cancel} onConfirm={browserNavigation().confirm} />;
};
