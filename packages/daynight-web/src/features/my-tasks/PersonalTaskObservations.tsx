import { createContext, useContext, useLayoutEffect, useMemo, useReducer, type ReactNode } from 'react';
import type { PersonalTaskItem } from '../../api/personal-tasks';
import type { TaskRowSession } from '../task-row/model';
import { personalTaskSession, personalTaskSessionNextChange } from './personal-session';

const Context = createContext<ReadonlyMap<string, TaskRowSession> | null>(null);

export const PersonalTaskObservations = ({ items, children }: { readonly items: readonly PersonalTaskItem[]; readonly children: ReactNode }) => {
  const [revision, update] = useReducer((version: number) => version + 1, 0);
  const sample = useMemo(() => {
    const now = performance.now();
    const observations = new Map<string, TaskRowSession>();
    let remaining = Infinity;
    for (const item of items) {
      observations.set(item.task.id, personalTaskSession(item, now));
      const next = personalTaskSessionNextChange(item, now);
      if (next !== null) remaining = Math.min(remaining, next);
    }
    return { observations, remaining, sampledAt: now };
  }, [items, revision]);
  useLayoutEffect(() => {
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useLayoutEffect(() => {
    if (document.visibilityState === 'hidden' || !Number.isFinite(sample.remaining)) return;
    const remaining = sample.remaining - (performance.now() - sample.sampledAt);
    if (remaining <= 0) { update(); return; }
    const timer = setTimeout(update, Math.max(1, remaining));
    return () => clearTimeout(timer);
  }, [sample]);
  return <Context value={sample.observations}>{children}</Context>;
};

export const usePersonalTaskObservation = (id: string): TaskRowSession => {
  const observations = useContext(Context);
  const observation = observations?.get(id);
  if (observation === undefined) throw new Error('A personal Task requires its matching list observation.');
  return observation;
};
