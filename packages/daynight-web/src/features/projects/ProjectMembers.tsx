import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { listMembers } from '../../api/auth';
import type { ProjectMember } from '../../api/auth-types';
import { isAbortError } from '../../api/client';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';

type Membership = {
  readonly projectId: string;
  readonly status: 'loading' | 'ready' | 'error';
  readonly members: readonly ProjectMember[];
  readonly error: unknown;
  readonly retry: () => void;
};
const Context = createContext<Membership | null>(null);

export const useProjectMembers = (projectId: string, enabled = true): Membership => {
  const inherited = useContext(Context);
  const shared = inherited?.projectId === projectId ? inherited : null;
  const scope = useTaskCacheScope();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Omit<Membership, 'retry'>>({ projectId, status: 'loading', members: [], error: null });
  useEffect(() => {
    if (shared !== null || !enabled) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    setState({ projectId, status: 'loading', members: [], error: null });
    void listMembers(projectId, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch }).then((members) => {
      if (!signal.aborted) setState({ projectId, status: 'ready', members, error: null });
    }).catch((error: unknown) => {
      if (!signal.aborted && !isAbortError(error)) setState({ projectId, status: 'error', members: [], error });
    });
    return () => controller.abort();
  }, [projectId, scope, attempt, shared, enabled]);
  return shared ?? { ...(state.projectId === projectId ? state : { projectId, status: 'loading' as const, members: [], error: null }), retry: () => setAttempt((value) => value + 1) };
};

export const ProjectMembersProvider = ({ projectId, children }: { readonly projectId: string; readonly children: ReactNode }) => {
  const membership = useProjectMembers(projectId);
  return <Context.Provider value={membership}>{children}</Context.Provider>;
};
