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
  private readAbort: AbortController | null = null;
  private sequence = 0;
  private accepted = 0;
  private barrier = 0;
  private lastObservation = performance.now();
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(readonly projectId: string, readonly scope: TaskCacheScope, private active = true) {}
  snapshot = (): AccessState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private live = (): boolean => !this.lifetime.signal.aborted && !this.scope.isInvalidated;
  private update(state: AccessState): void {
    if (!this.live()) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  beginObservation = (): number => ++this.sequence;
  publishSync = (ticket: number, access: ProjectAccess): boolean => {
    if (!this.live() || ticket < this.barrier || ticket < this.accepted) return false;
    this.accepted = ticket;
    this.lastObservation = performance.now();
    this.update({ access, status: 'ready', refreshing: this.read !== null, error: null });
    this.schedule();
    return true;
  };
  publishMutation = (access: ProjectAccess | null): void => {
    if (!this.live()) return;
    this.barrier = this.beginObservation();
    this.accepted = this.barrier;
    this.lastObservation = performance.now();
    this.update({ access, status: access === null ? 'unavailable' : 'ready', refreshing: false, error: null });
    this.schedule();
  };
  private schedule = (): void => {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.live() || !this.active || document.visibilityState === 'hidden' || this.read !== null) return;
    this.timer = setTimeout(() => { this.timer = null; void this.revalidate(); }, Math.max(0, this.lastObservation + 30_000 - performance.now()));
  };
  revalidate = (): Promise<ProjectAccess | null> => {
    if (this.read !== null) return this.read;
    if (!this.live()) return Promise.resolve(null);
    this.barrier = this.beginObservation();
    this.update({ ...this.state, refreshing: true });
    const readAbort = new AbortController();
    this.readAbort = readAbort;
    const signal = AbortSignal.any([this.lifetime.signal, this.scope.signal, readAbort.signal]);
    let ticket = this.barrier;
    let cacheTicket: SyncTicket | null = null;
    const pending = Promise.resolve().then(async () => {
      try {
        await this.scope.ready(signal);
        cacheTicket = await this.scope.beginSync(this.projectId, signal);
        ticket = this.beginObservation();
        const access = await getProjectAccess(this.projectId, signal, { userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch });
        await this.scope.ready(signal);
        if (!this.live() || ticket < this.barrier || cacheTicket.scopeRevision !== this.scope.getProjectRevision(this.projectId)) return null;
        if (ticket >= this.accepted) {
          this.accepted = ticket;
          this.scope.resumeProject(this.projectId);
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
          const cleanup = this.scope.revokeProject(cacheTicket, signal, true, error as ApiError);
          const cleanupBarrier = this.barrier;
          try { await cleanup; }
          catch (failure) {
            if (this.live() && !isAbortError(failure) && this.barrier === cleanupBarrier) this.update({ ...this.state, status: 'error', error: failure });
          }
        }
        return null;
      } finally {
        if (this.read === pending) {
          this.read = null;
          if (this.readAbort === readAbort) this.readAbort = null;
          if (ticket >= this.barrier) this.lastObservation = performance.now();
          if (ticket >= this.barrier || this.accepted >= this.barrier) this.update({ ...this.state, refreshing: false });
          this.schedule();
        }
      }
    });
    this.read = pending;
    return pending;
  };
  revalidateAfterMutation = (): Promise<ProjectAccess | null> => {
    this.readAbort?.abort();
    this.readAbort = null;
    this.read = null;
    return this.revalidate();
  };
  setActive = (active: boolean): void => {
    if (this.active === active) return;
    this.active = active;
    if (!active) { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
    else if (document.visibilityState !== "hidden") void this.revalidate();
    else this.schedule();
  };
  start = (initialRead: boolean): (() => void) => {
    const refresh = () => { if (!this.active) return; if (document.visibilityState !== 'hidden') void this.revalidate(); else this.schedule(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const unsubscribe = this.scope.subscribe((event) => {
      if (event.projectId !== this.projectId || !event.accessRevoked) return;
      this.barrier = this.beginObservation();
      const previous = this.state.error;
      const knownDenial = event.error instanceof ApiError && event.error.kind === 'server' && event.error.status === 404 && event.error.code === 'not_found';
      const priorFailure = previous !== null && !(previous instanceof ApiError && previous.kind === 'server' && previous.status === 404 && previous.code === 'not_found');
      this.update({ access: null, status: 'unavailable', refreshing: false, error: knownDenial && priorFailure ? previous : event.error });
    });
    if (this.active && (initialRead || this.scope.isProjectSuspended(this.projectId)) && document.visibilityState !== 'hidden') void this.revalidate();
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
const Provider = ({ projectId, initialRead, active, children }: { readonly projectId: string; readonly initialRead: boolean; readonly active: boolean; readonly children: ReactNode }) => {
  const scope = useTaskCacheScope();
  const session = useMemo(() => new ProjectAccessSession(projectId, scope, active), [projectId, scope]);
  useEffect(() => session.start(initialRead), [session, initialRead]);
  useEffect(() => { session.setActive(active); }, [session, active]);
  return <Context.Provider value={session}>{children}</Context.Provider>;
};

export const ProjectAccessBoundary = ({ projectId, initialRead = false, active = true, children }: { readonly projectId: string; readonly initialRead?: boolean; readonly active?: boolean; readonly children: ReactNode }) => {
  const current = useContext(Context);
  const scope = useTaskCacheScope();
  return current?.projectId === projectId && current.scope === scope ? children : <Provider key={`${projectId}:${initialRead}`} projectId={projectId} initialRead={initialRead} active={active}>{children}</Provider>;
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
