import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { TaskSessionSummaryStore } from './store';
import { aggregateSessionIndicators, type SessionIndicator, type TaskSessionSummary } from './summary';

const Context = createContext<TaskSessionSummaryStore | null>(null);
const empty: ReadonlyMap<string, TaskSessionSummary> = new Map();
const emptySnapshot = () => empty;
const noopSubscribe = () => () => {};

export function TaskSessionSummaryProvider({ projectId, active = true, children }: {
  readonly projectId: string; readonly active?: boolean; readonly children: ReactNode;
}) {
  const scope = useTaskCacheScope();
  const store = useMemo(() => new TaskSessionSummaryStore(scope, projectId), [scope, projectId]);
  useEffect(() => { store.setActive(active); store.start(); return () => store.dispose(); }, [store]);
  useEffect(() => { store.setActive(active); }, [store, active]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}

export function useTaskSessionSummary(taskId: string): TaskSessionSummary | null {
  const store = useContext(Context);
  const summaries = useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.snapshot ?? emptySnapshot);
  return summaries.get(taskId) ?? null;
}

export function useChainSessionSummary(memberIds: Iterable<string>): SessionIndicator | null {
  const store = useContext(Context);
  const summaries = useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.snapshot ?? emptySnapshot);
  return aggregateSessionIndicators([...memberIds].map((id) => summaries.get(id)?.indicator ?? null));
}

/** Observe the chain container, including its collapsed header and all members. */
export function useSessionChainVisibility(rootId: string, memberIds: Iterable<string>): (element: HTMLElement | null) => void {
  const store = useContext(Context);
  const memberKey = JSON.stringify([...memberIds].sort());
  const members = useMemo(() => JSON.parse(memberKey) as string[], [memberKey]);
  const observer = useRef<IntersectionObserver | null>(null);
  return useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect(); observer.current = null;
    store?.removeChain(rootId);
    if (element === null || store === null || typeof IntersectionObserver === 'undefined') return;
    const next = new IntersectionObserver((entries) => {
      if (observer.current !== next) return;
      const visible = entries.some((entry) => entry.target === element && entry.isIntersecting);
      store.setChain(rootId, members, visible);
    });
    observer.current = next; next.observe(element);
  }, [store, rootId, members]);
}
