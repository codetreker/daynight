import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { TaskSummary } from '../../api/types';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { GoalRelationSession } from './relation-session';

export const useGoalRelationSession = (projectId: string, summaries: ReadonlyMap<string, TaskSummary> | null, focusId: string | null = null) => {
  const scope = useTaskCacheScope();
  const session = useMemo(() => new GoalRelationSession(scope, projectId), [scope, projectId]);
  useEffect(() => () => session.dispose(), [session]);
  useEffect(() => session.setRoots(summaries, focusId), [session, summaries, focusId]);
  useEffect(() => {
    const reenter = () => { if (document.visibilityState !== 'hidden') session.reenter(); };
    window.addEventListener('focus', reenter); document.addEventListener('visibilitychange', reenter);
    return () => { window.removeEventListener('focus', reenter); document.removeEventListener('visibilitychange', reenter); };
  }, [session]);
  const snapshot = useSyncExternalStore(session.subscribe, session.snapshot);
  return { snapshot, retry: session.retry, inspect: session.inspect, expand: session.expand };
};
