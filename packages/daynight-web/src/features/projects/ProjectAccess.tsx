import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { getProjectAccess } from '../../api/auth';
import type { ProjectAccess } from '../../api/auth-types';
import { ApiError, isAbortError } from '../../api/client';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';
import type { CacheEvent, SyncTicket } from '../task-cache/project-cache';
import { TaskCacheError } from '../task-cache/database';

type AccessState = {
  readonly access: ProjectAccess | null;
  readonly status: 'loading' | 'ready' | 'error' | 'unavailable';
  readonly refreshing: boolean;
  readonly error: unknown;
  readonly projectReadAvailable?: boolean;
};

export class ProjectAccessSession {
  private state: AccessState = { access: null, status: 'loading', refreshing: false, error: null };
  private readonly listeners = new Set<() => void>();
  private readonly projectReadRetries = new Set<(automatic: boolean) => void>();
  private readonly projectReadWithdrawals = new Set<() => void>();
  private activeProjectRead: symbol | null = null;
  private projectReadNeedsRecheck = false;
  private publishingProjectReadDenial = false;
  private projectReadRecovery: { readonly revision: number; readonly admission: number; readonly cleanupGeneration?: string } | null = null;
  private readonly activityWaiters = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private read: Promise<ProjectAccess | null> | null = null;
  private readAbort: AbortController | null = null;
  private protectedRead = false;
  private refreshAfterRead = false;
  private sequence = 0;
  private accepted = 0;
  private barrier = 0;
  private projectReadBarrier = 0;
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
  canObserveProjectRead = (): boolean => this.live();
  isProjectReadCleanupFailure = (event: CacheEvent): boolean => {
    const recovery = this.projectReadRecovery;
    return recovery !== null && event.error instanceof TaskCacheError && event.revokedGeneration !== undefined &&
      event.revokedGeneration === recovery.cleanupGeneration && recovery.revision === this.scope.getProjectRevision(this.projectId) &&
      recovery.admission === this.scope.getAdmissionRevision(this.projectId);
  };
  subscribeProjectReadRetry = (retry: (automatic: boolean) => void): (() => void) => { this.projectReadRetries.add(retry); return () => { this.projectReadRetries.delete(retry); }; };
  retryProjectRead = (): void => { for (const retry of this.projectReadRetries) retry(false); };
  private recheckProjectRead = (): void => { for (const retry of this.projectReadRetries) retry(true); };
  subscribeProjectReadWithdrawal = (withdraw: () => void): (() => void) => { this.projectReadWithdrawals.add(withdraw); return () => { this.projectReadWithdrawals.delete(withdraw); }; };
  requireProjectReadRecheck = (): void => { this.projectReadNeedsRecheck = true; };
  beginProjectRead = (): symbol => { const token = Symbol(); this.activeProjectRead = token; return token; };
  endProjectRead = (token: symbol): void => { if (this.activeProjectRead === token) { this.activeProjectRead = null; this.schedule(); } };
  projectReadInFlight = (): boolean => this.projectReadNeedsRecheck && this.activeProjectRead !== null;
  // Project GET is independently authorized. Order its receipts with access and
  // task-sync observations so an older denial cannot withdraw newer access.
  publishProjectRead = (ticket: number): boolean => {
    if (!this.live() || ticket < this.projectReadBarrier) return false;
    this.accepted = Math.max(this.accepted, ticket);
    this.scope.markProjectReadable(this.projectId);
    this.projectReadNeedsRecheck = false;
    this.update({ ...this.state, projectReadAvailable: true });
    if (this.read !== null) this.refreshAfterRead = true;
    return true;
  };
  withdrawProjectRead = (ticket: number, history: SyncTicket | null, error: ApiError): boolean => {
    if (!this.live() || ticket < this.barrier || ticket < this.accepted) return false;
    if (history !== null && !this.scope.canRevokeProject(history)) return false;
    this.publishingProjectReadDenial = true;
    try {
      if (history !== null) {
        // Revocation publishes its generation before asynchronous durable cleanup.
        void this.scope.revokeProject(history, this.scope.signal, true, error).catch(() => {});
      } else {
        // A cold read has no generation to withdraw safely; isolate locally until
        // access verification can identify its persistent generation.
        this.scope.suspendProject(this.projectId);
        this.scope.reportUnboundProjectDenial(this.projectId);
      }
    } finally { this.publishingProjectReadDenial = false; }
    this.projectReadRecovery = { revision: this.scope.getProjectRevision(this.projectId), admission: this.scope.getAdmissionRevision(this.projectId),
      ...(history === null ? {} : { cleanupGeneration: history.cacheGeneration }) };
    void this.revalidateAfterMutation(true);
    return true;
  };
  publishSync = (ticket: number, access: ProjectAccess, automatic = false): boolean => {
    if (!this.live() || automatic && this.projectReadInFlight() || ticket < this.barrier || ticket < this.accepted) return false;
    this.accepted = ticket;
    this.scope.markProjectReadable(this.projectId);
    this.lastObservation = performance.now();
    this.update({ access, status: 'ready', refreshing: this.read !== null, error: null, projectReadAvailable: this.state.projectReadAvailable ?? false });
    this.schedule();
    return true;
  };
  publishMutation = (access: ProjectAccess | null): void => {
    if (!this.live()) return;
    this.barrier = this.beginObservation();
    this.accepted = this.barrier;
    if (access === null) { this.projectReadRecovery = null; this.projectReadNeedsRecheck = true; this.projectReadBarrier = this.barrier; }
    this.lastObservation = performance.now();
    this.update({ access, status: access === null ? 'unavailable' : 'ready', refreshing: false, error: null, projectReadAvailable: access === null ? false : this.state.projectReadAvailable ?? false });
    if (access === null) {
      for (const withdraw of this.projectReadWithdrawals) withdraw();
      const barrier = this.barrier;
      queueMicrotask(() => { if (this.live() && barrier === this.barrier) this.recheckProjectRead(); });
    }
    this.schedule();
  };
  private schedule = (): void => {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.live() || !this.active || document.visibilityState === 'hidden' || this.read !== null) return;
    const delay = this.projectReadInFlight() ? 30_000 : Math.max(0, this.lastObservation + 30_000 - performance.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.projectReadInFlight()) this.schedule();
      else void this.revalidate();
    }, delay);
  };
  revalidate = (): Promise<ProjectAccess | null> => this.readAccess(false);
  waitForFreshAccess = async (signal: AbortSignal, requireActive = false): Promise<ProjectAccess | null> => {
    while (this.live()) {
      await this.scope.ready(signal);
      if (!this.live()) return null;
      if (requireActive && !this.active) {
        const lifetime = AbortSignal.any([signal, this.lifetime.signal, this.scope.signal]);
        lifetime.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => { this.activityWaiters.delete(resume); lifetime.removeEventListener('abort', abort); };
          const resume = () => { cleanup(); resolve(); };
          const abort = () => { cleanup(); reject(lifetime.reason); };
          this.activityWaiters.add(resume);
          lifetime.addEventListener('abort', abort, { once: true });
        });
        continue;
      }
      const current = this.read;
      if (current !== null) { await current; continue; }
      return this.state.status === 'ready' && !this.state.refreshing ? this.state.access : null;
    }
    return null;
  };
  private readAccess = (protectedRead: boolean, fromProjectDenial = false): Promise<ProjectAccess | null> => {
    if (this.read !== null) return this.read;
    if (!this.live()) return Promise.resolve(null);
    this.protectedRead = protectedRead;
    this.barrier = this.beginObservation();
    this.update({ ...this.state, refreshing: true });
    const readAbort = new AbortController();
    this.readAbort = readAbort;
    const signal = AbortSignal.any([this.lifetime.signal, this.scope.signal, readAbort.signal]);
    let ticket = this.barrier;
    let projectReadRevision = this.scope.getProjectReadRevision(this.projectId);
    let cacheTicket: SyncTicket | null = null;
    const pending = Promise.resolve().then(async () => {
      try {
        await this.scope.ready(signal);
        cacheTicket = await this.scope.beginSync(this.projectId, signal);
        ticket = this.beginObservation();
        projectReadRevision = this.scope.getProjectReadRevision(this.projectId);
        const access = await getProjectAccess(this.projectId, signal, { userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch });
        await this.scope.ready(signal);
        if (!this.live() || ticket < this.barrier || cacheTicket.scopeRevision !== this.scope.getProjectRevision(this.projectId)) return null;
        if (ticket >= this.accepted) {
          this.accepted = ticket;
          this.scope.markProjectReadable(this.projectId);
          this.scope.resumeProject(this.projectId);
          this.update({ access, status: 'ready', refreshing: true, error: null, projectReadAvailable: this.state.projectReadAvailable ?? false });
        }
        return this.state.access;
      } catch (error) {
        if (!this.live() || signal.aborted || isAbortError(error) || ticket < this.barrier) return null;
        if (ticket < this.accepted) return this.state.access;
        const denied = error instanceof ApiError && error.kind === 'server' && error.status === 404 && error.code === 'not_found';
        // A principal-bound denial withdraws its matching cache generation immediately;
        // the scope keeps persistent cleanup behind identity admission.
        if (denied && projectReadRevision !== this.scope.getProjectReadRevision(this.projectId)) {
          this.refreshAfterRead = true;
          return this.state.access;
        }
        const currentDenial = denied && cacheTicket !== null && this.scope.canRevokeProject(cacheTicket);
        if (!currentDenial) {
          try { await this.scope.ready(signal); } catch { return null; }
          if (!this.live() || signal.aborted || ticket < this.barrier) return null;
          if (ticket < this.accepted) return this.state.access;
        }
        if (denied && (cacheTicket !== null ? !this.scope.canRevokeProject(cacheTicket) : this.scope.getAuthorizedProject(this.projectId) !== null)) {
          this.update({ ...this.state, status: 'loading', error: null });
          return null;
        }
        this.barrier = this.beginObservation();
        this.lastObservation = performance.now();
        if (denied && cacheTicket !== null) {
          const denialBarrier = this.barrier;
          this.publishingProjectReadDenial = fromProjectDenial;
          let cleanup: Promise<boolean>;
          try { cleanup = this.scope.revokeProject(cacheTicket, this.scope.signal, true, error as ApiError); }
          finally { this.publishingProjectReadDenial = false; }
          if (cacheTicket.scopeRevision === this.scope.getProjectRevision(this.projectId) &&
            cacheTicket.admissionRevision === this.scope.getAdmissionRevision(this.projectId) &&
            (this.projectReadRecovery?.revision !== cacheTicket.scopeRevision || this.projectReadRecovery.admission !== cacheTicket.admissionRevision ||
              this.projectReadRecovery.cleanupGeneration !== cacheTicket.cacheGeneration)) {
            this.projectReadRecovery = { revision: cacheTicket.scopeRevision, admission: cacheTicket.admissionRevision, cleanupGeneration: cacheTicket.cacheGeneration };
          }
          // Scope listeners normally publish the withdrawal; avoid overwriting a newer observation.
          if (this.barrier === denialBarrier) this.update({ access: null, status: 'unavailable', refreshing: false, error });
          const cleanupBarrier = this.barrier;
          try { await cleanup; }
          catch (failure) {
            if (!this.live() || isAbortError(failure)) return null;
            try { await this.scope.ready(signal); } catch { return null; }
            if (this.live() && !signal.aborted && this.barrier === cleanupBarrier) this.update({ ...this.state, status: 'error', error: failure });
          }
        } else this.update({ ...this.state, access: denied ? null : this.state.access, status: denied ? 'unavailable' : 'error', refreshing: false, error, ...(denied ? { projectReadAvailable: false } : {}) });
        return null;
      } finally {
        if (this.read === pending) {
          this.read = null;
          if (this.readAbort === readAbort) this.readAbort = null;
          this.protectedRead = false;
          const refresh = this.refreshAfterRead && this.active && document.visibilityState !== 'hidden';
          this.refreshAfterRead = false;
          if (ticket >= this.barrier) this.lastObservation = performance.now();
          if (refresh) void this.revalidate();
          else {
            if (ticket >= this.barrier || this.accepted >= this.barrier) this.update({ ...this.state, refreshing: false });
            this.schedule();
          }
        }
      }
    });
    this.read = pending;
    return pending;
  };
  revalidateAfterMutation = (fromProjectDenial = false): Promise<ProjectAccess | null> => {
    this.readAbort?.abort();
    this.readAbort = null;
    this.read = null;
    this.refreshAfterRead = false;
    return this.readAccess(true, fromProjectDenial);
  };
  setActive = (active: boolean): void => {
    if (this.active === active) return;
    this.active = active;
    if (!active) {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      this.refreshAfterRead = false;
      if (!this.protectedRead) {
        this.barrier = this.beginObservation();
        this.readAbort?.abort();
        this.readAbort = null;
        this.read = null;
        this.update({ ...this.state, refreshing: false });
      }
    } else {
      if (document.visibilityState !== 'hidden') this.refreshVisible();
      for (const resume of this.activityWaiters) resume();
    }
  };
  private refreshVisible = (): void => {
    if (this.projectReadInFlight()) { this.schedule(); return; }
    if (this.read !== null && this.protectedRead) { this.refreshAfterRead = true; return; }
    if (this.read !== null) {
      // A foreground return must observe access after the preceding background read.
      this.barrier = this.beginObservation();
      this.readAbort?.abort();
      this.readAbort = null;
      this.read = null;
    }
    void this.revalidate();
  };
  start = (initialRead: boolean): (() => void) => {
    const refresh = () => { if (!this.active) return; if (document.visibilityState !== 'hidden') this.refreshVisible(); else this.schedule(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const unsubscribe = this.scope.subscribe((event) => {
      if (event.projectId !== this.projectId) return;
      if (event.accessRestored) {
        this.refreshVisible();
        queueMicrotask(() => { if (this.live()) this.recheckProjectRead(); });
        return;
      }
      if (event.directAccessRecheck && event.error !== undefined) {
        this.update({ ...this.state, status: 'error', error: event.error, projectReadAvailable: false });
        return;
      }
      if (event.taskNotFound) { void this.revalidateAfterMutation(); return; }
      if (!event.accessRevoked && !event.directAccessUncertain) return;
      if (this.isProjectReadCleanupFailure(event)) {
        this.update({ ...this.state, error: event.error });
        return;
      }
      this.projectReadNeedsRecheck = true;
      this.barrier = this.beginObservation();
      this.projectReadBarrier = this.barrier;
      const previous = this.state.error;
      const knownDenial = event.error instanceof ApiError && event.error.kind === 'server' && event.error.status === 404 && event.error.code === 'not_found';
      const recovery = { revision: this.scope.getProjectRevision(this.projectId), admission: this.scope.getAdmissionRevision(this.projectId),
        ...(event.revokedGeneration === undefined ? {} : { cleanupGeneration: event.revokedGeneration }) };
      this.projectReadRecovery = recovery;
      if (!event.directAccessUncertain && !this.publishingProjectReadDenial) queueMicrotask(() => {
        if (this.projectReadRecovery === recovery && this.canObserveProjectRead()) this.recheckProjectRead();
      });
      const priorFailure = previous !== null && !(previous instanceof ApiError && previous.kind === 'server' && previous.status === 404 && previous.code === 'not_found');
      this.update({ access: null, status: 'unavailable', refreshing: false, error: knownDenial && priorFailure ? previous : event.error, projectReadAvailable: false });
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
