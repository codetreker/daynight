import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { getProjectAccess } from '../../api/auth';
import type { ProjectAccess } from '../../api/auth-types';
import { ApiError, isAbortError } from '../../api/client';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';
import type { SyncTicket } from '../task-cache/project-cache';

type AccessState = {
  readonly access: ProjectAccess | null;
  readonly status: 'loading' | 'ready' | 'error' | 'unavailable';
  readonly refreshing: boolean;
  readonly error: unknown;
};

export class ProjectAccessSession {
  private state: AccessState = { access: null, status: 'loading', refreshing: false, error: null };
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private read: Promise<ProjectAccess | null> | null = null;
  private sequence = 0;
  private accepted = 0;
  private barrier = 0;
  private lastObservation = performance.now();
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(readonly projectId: string, readonly scope: TaskCacheScope) {}
  snapshot = (): AccessState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private live = (): boolean => !this.lifetime.signal.aborted && !this.scope.isInvalidated;
  private update(state: AccessState): void {
    if (!this.live()) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  beginObservation = (): number => ++this.sequence;
  publishSync = (ticket: number, access: ProjectAccess): void => {
    if (!this.live() || ticket < this.barrier || ticket < this.accepted) return;
    this.accepted = ticket;
    this.lastObservation = performance.now();
    this.update({ access, status: 'ready', refreshing: this.read !== null, error: null });
    this.schedule();
  };
  private schedule = (): void => {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.live() || document.visibilityState === 'hidden' || this.read !== null) return;
    this.timer = setTimeout(() => { this.timer = null; void this.revalidate(); }, Math.max(0, this.lastObservation + 30_000 - performance.now()));
  };
  revalidate = (): Promise<ProjectAccess | null> => {
    if (this.read !== null) return this.read;
    if (!this.live()) return Promise.resolve(null);
    this.barrier = this.beginObservation();
    this.update({ ...this.state, refreshing: true });
    const signal = AbortSignal.any([this.lifetime.signal, this.scope.signal]);
    let ticket = this.barrier;
    let cacheTicket: SyncTicket | null = null;
    const pending = Promise.resolve().then(async () => {
      try {
        await this.scope.ready(signal);
        const project = this.scope.getAuthorizedProject(this.projectId);
        if (project !== null) {
          const { userFence, cacheGeneration, epoch, maxUpdatedAt } = project.manifest;
          cacheTicket = { userId: this.scope.userId, projectId: this.projectId, userFence, cacheGeneration, epoch, maxUpdatedAt };
        }
        ticket = this.beginObservation();
        const access = await getProjectAccess(this.projectId, signal, { userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch });
        await this.scope.ready(signal);
        if (!this.live() || ticket < this.barrier) return null;
        if (ticket >= this.accepted) {
          this.accepted = ticket;
          this.update({ access, status: 'ready', refreshing: true, error: null });
        }
        return this.state.access;
      } catch (error) {
        if (!this.live() || signal.aborted || isAbortError(error) || ticket < this.barrier) return null;
        if (ticket < this.accepted) return this.state.access;
        const denied = error instanceof ApiError && error.kind === 'server' && error.status === 404 && error.code === 'not_found';
        if (denied && (cacheTicket !== null ? !this.scope.canRevokeProject(cacheTicket) : this.scope.getAuthorizedProject(this.projectId) !== null)) {
          this.update({ ...this.state, status: 'loading', error: null });
          return null;
        }
        this.barrier = this.beginObservation();
        this.lastObservation = performance.now();
        this.update({ access: denied ? null : this.state.access, status: denied ? 'unavailable' : 'error', refreshing: false, error });
        if (denied && cacheTicket !== null) {
          try {
            await this.scope.revokeProject(cacheTicket, signal, true, error as ApiError);
          } catch (failure) {
            if (this.live() && !isAbortError(failure) && ticket >= this.barrier) this.update({ ...this.state, error: failure });
          }
        }
        return null;
      } finally {
        if (this.read === pending) {
          this.read = null;
          if (ticket >= this.barrier) this.lastObservation = performance.now();
          if (ticket >= this.barrier || this.accepted >= this.barrier) this.update({ ...this.state, refreshing: false });
          this.schedule();
        }
      }
    });
    this.read = pending;
    return pending;
  };
  start = (initialRead: boolean): (() => void) => {
    const refresh = () => { if (document.visibilityState !== 'hidden') void this.revalidate(); else this.schedule(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const unsubscribe = this.scope.subscribe((event) => {
      if (event.projectId !== this.projectId || !event.accessRevoked) return;
      this.barrier = this.beginObservation();
      this.update({ access: null, status: 'unavailable', refreshing: false, error: event.error });
    });
    if (initialRead && document.visibilityState !== 'hidden') void this.revalidate();
    else this.schedule();
    return () => {
      this.lifetime.abort();
      if (this.timer !== null) clearTimeout(this.timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      unsubscribe();
    };
  };
}

const Context = createContext<ProjectAccessSession | null>(null);
const Provider = ({ projectId, initialRead, children }: { readonly projectId: string; readonly initialRead: boolean; readonly children: ReactNode }) => {
  const scope = useTaskCacheScope();
  const session = useMemo(() => new ProjectAccessSession(projectId, scope), [projectId, scope]);
  useEffect(() => session.start(initialRead), [session, initialRead]);
  return <Context.Provider value={session}>{children}</Context.Provider>;
};

export const ProjectAccessBoundary = ({ projectId, initialRead = false, children }: { readonly projectId: string; readonly initialRead?: boolean; readonly children: ReactNode }) => {
  const current = useContext(Context);
  const scope = useTaskCacheScope();
  return current?.projectId === projectId && current.scope === scope ? children : <Provider key={`${projectId}:${initialRead}`} projectId={projectId} initialRead={initialRead}>{children}</Provider>;
};

export const useProjectAccess = (projectId: string) => {
  const session = useContext(Context);
  const scope = useTaskCacheScope();
  if (session === null || session.projectId !== projectId || session.scope !== scope) throw new Error('Project access requires the current authenticated project boundary.');
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  return { ...state, session, ready: state.status === 'ready' && !state.refreshing };
};

export const useProjectAccessSession = (projectId: string): ProjectAccessSession | null => {
  const session = useContext(Context);
  const scope = useTaskCacheScope();
  return session?.projectId === projectId && session.scope === scope ? session : null;
};
