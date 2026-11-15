import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { GraphTask, TaskSummary } from '../../api/types';
import { observationFor, unobserved, type ProjectTaskObservationsStore, type ProjectTaskObservation } from './project-observations';

const Context = createContext<ProjectTaskObservationsStore | null>(null);
const empty: ReadonlyMap<string, ProjectTaskObservation> = new Map();
const emptySnapshot = () => empty;
const noopSubscribe = () => () => {};

export function ProjectTaskObservationsProvider({ store, active, children }: { readonly store: ProjectTaskObservationsStore; readonly active: boolean; readonly children: ReactNode }) {
  useEffect(() => { store.setActive(active); return () => store.setActive(false); }, [store, active]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useProjectTaskObservation(task: GraphTask, summary?: TaskSummary): ProjectTaskObservation | null {
  const store = useContext(Context);
  const view = useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.snapshot ?? emptySnapshot);
  if (task.status === 'in_progress' && summary !== undefined && !store?.matches(summary)) return unobserved;
  return observationFor(view, task);
}
