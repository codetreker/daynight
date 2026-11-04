import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { listMembers } from '../../api/auth';
import type { ProjectParticipant } from '../../api/auth-types';
import { isAbortError } from '../../api/client';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';

type Membership = {
  readonly projectId: string;
  readonly scope: TaskCacheScope;
  readonly status: 'loading' | 'ready' | 'error';
  readonly members: readonly ProjectParticipant[];
  readonly error: unknown;
  readonly retry: () => void;
};
const Context = createContext<Membership | null>(null);

export const useProjectMembers = (projectId: string, enabled = true): Membership => {
  const inherited = useContext(Context);
  const scope = useTaskCacheScope();
  const shared = inherited?.projectId === projectId && inherited.scope === scope ? inherited : null;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Omit<Membership, 'retry'>>({ projectId, scope, status: 'loading', members: [], error: null });
  useEffect(() => {
    if (shared !== null || !enabled) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    setState({ projectId, scope, status: 'loading', members: [], error: null });
    void listMembers(projectId, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch }).then((members) => {
      if (!signal.aborted) setState({ projectId, scope, status: 'ready', members, error: null });
    }).catch((error: unknown) => {
      if (!signal.aborted && !isAbortError(error)) setState({ projectId, scope, status: 'error', members: [], error });
    });
    return () => controller.abort();
  }, [projectId, scope, attempt, shared, enabled]);
  return shared ?? { ...(state.projectId === projectId && state.scope === scope ? state : { projectId, scope, status: 'loading' as const, members: [], error: null }), retry: () => setAttempt((value) => value + 1) };
};

export const ProjectMembersProvider = ({ projectId, children }: { readonly projectId: string; readonly children: ReactNode }) => {
  const membership = useProjectMembers(projectId);
  return <Context.Provider value={membership}>{children}</Context.Provider>;
};
