import { TaskCacheLifecycleChanged } from "../task-cache/project-cache";
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { listProjectPeople } from "../../api/auth";
import type { ProjectPeople, ProjectPerson, ProjectPersonVersion } from "../../api/auth-types";
import { ApiError, authRequestsPaused, isAbortError, requestId } from "../../api/client";
import { useTaskCacheScope } from "../task-cache/TaskCacheProvider";
import type { CachedProfile } from "../task-cache/database";
import type { CacheEvent, CachedProject, SyncTicket, TaskCacheScope } from "../task-cache/project-cache";

export type AssigneePeopleSnapshot = {
  readonly people: ReadonlyMap<string, ProjectPerson>;
  readonly unresolvedUserIds: ReadonlySet<string>;
  readonly error: unknown;
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly items: readonly ProjectPerson[];
};
type ProjectPeopleState = {
  generation: string | null;
  userFence: string | null;
  profiles: Map<string, CachedProfile>;
  dirtyProfiles: Map<string, CachedProfile>;
  hydrated: boolean;
  versions: ReadonlyMap<string, ProjectPersonVersion>;
  // A GET can observe newer content than its triggering sync; reuse it until the next successful graph observation.
  resolvedAgainst: Map<string, string>;
  unresolvedVersions: Map<string, string>;
  people: Map<string, ProjectPerson>;
  unresolved: Set<string>;
  demands: Map<symbol, readonly string[]>;
  demandIds: readonly string[];
  receipts: Map<symbol, number>;
  queued: boolean;
  resolving: boolean;
  refreshPending: boolean;
  catalogueRequested: boolean;
  catalogueStatus: AssigneePeopleSnapshot["status"];
  error: unknown;
  listeners: Set<() => void>;
  snapshot: AssigneePeopleSnapshot;
};
const emptySnapshot = (): AssigneePeopleSnapshot => ({ people: new Map(), unresolvedUserIds: new Set(), error: null, status: "idle", items: [] });
const sameIds = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((id, index) => id === right[index]);

export class TaskAssignees {
  private readonly projects = new Map<string, ProjectPeopleState>();
  private readonly lifetime = new AbortController();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly scope: TaskCacheScope) {
    this.unsubscribe = scope.subscribe(this.onCacheEvent);
    scope.signal.addEventListener("abort", this.onScopeAbort, { once: true });
  }
  private project(projectId: string): ProjectPeopleState {
    projectId = requestId(projectId);
    let state = this.projects.get(projectId);
    if (state === undefined) {
      state = {
        generation: null, userFence: null, profiles: new Map(), dirtyProfiles: new Map(), hydrated: false,
        versions: new Map(), resolvedAgainst: new Map(), unresolvedVersions: new Map(), people: new Map(), unresolved: new Set(),
        demands: new Map(), demandIds: [], receipts: new Map(), queued: false, resolving: false, refreshPending: false,
        catalogueRequested: false, catalogueStatus: "idle", error: null, listeners: new Set(), snapshot: emptySnapshot(),
      };
      this.projects.set(projectId, state);
    }
    return state;
  }
  snapshot = (projectId: string): AssigneePeopleSnapshot => this.project(projectId).snapshot;
  subscribe = (projectId: string, listener: () => void): (() => void) => {
    const state = this.project(projectId);
    state.listeners.add(listener);
    return () => { state.listeners.delete(listener); };
  };
  private emit(state: ProjectPeopleState): void {
    state.snapshot = {
      people: state.people, unresolvedUserIds: state.unresolved, error: state.error, status: state.catalogueStatus,
      items: state.catalogueRequested ? [...state.versions.keys()].flatMap((id) => {
        const person = state.people.get(id);
        return person === undefined ? [] : [person];
      }) : [],
    };
    for (const listener of state.listeners) listener();
  }
  private clear(state: ProjectPeopleState): void {
    state.profiles.clear(); state.dirtyProfiles.clear(); state.resolvedAgainst.clear(); state.unresolvedVersions.clear();
    state.hydrated = false; state.versions = new Map(); state.people = new Map(); state.unresolved = new Set();
    state.catalogueStatus = "idle"; state.error = null;
    this.emit(state);
  }
  private readonly onScopeAbort = (): void => {
    for (const state of this.projects.values()) this.clear(state);
  };
  private readonly onCacheEvent = (event: CacheEvent): void => {
    const state = this.projects.get(event.projectId);
    if (state === undefined) return;
    if (event.accessRevoked === true) {
      if (!event.scopeSuspended && event.revokedGeneration !== state.generation && state.generation !== null) return;
      this.clear(state); state.error = event.error ?? null; this.emit(state);
      return;
    }
    if (this.scope.isInvalidated || authRequestsPaused()) return;
    const current = this.scope.getAuthorizedProject(event.projectId);
    if (current === null) this.withdrawPresentation(state);
    else this.adoptHistory(state, current);
    this.schedule(event.projectId, state);
  };
  private reconcile(state: ProjectPeopleState, versions: readonly ProjectPersonVersion[]): void {
    const current = new Map(versions.map((person) => [person.userId, person]));
    for (const [id, version] of state.resolvedAgainst) if (current.get(id)?.version !== version) state.resolvedAgainst.delete(id);
    for (const [id, version] of state.unresolvedVersions) if (current.get(id)?.version !== version) state.unresolvedVersions.delete(id);
    const people = new Map<string, ProjectPerson>();
    for (const [id, version] of current) {
      const profile = state.profiles.get(id);
      if (profile === undefined || profile.version !== version.version && state.resolvedAgainst.get(id) !== version.version) continue;
      const previous = state.people.get(id);
      people.set(id, previous?.version === profile.version && previous.hasProjectAccess === version.hasProjectAccess
        ? previous : { ...profile, hasProjectAccess: version.hasProjectAccess });
    }
    state.versions = current; state.people = people;
    state.unresolved = new Set([...state.demandIds.filter((id) => !current.has(id)), ...state.unresolvedVersions.keys()]);
  }
  private withdrawPresentation(state: ProjectPeopleState): void {
    const status = state.catalogueRequested ? "loading" : "idle";
    const changed = state.versions.size !== 0 || state.people.size !== 0 || state.unresolved.size !== 0 || state.catalogueStatus !== status || state.error !== null;
    state.versions = new Map(); state.people = new Map(); state.unresolved = new Set();
    state.resolvedAgainst.clear(); state.unresolvedVersions.clear();
    state.catalogueStatus = status; state.error = null;
    if (changed) this.emit(state);
  }
  private adoptHistory(state: ProjectPeopleState, current: CachedProject): SyncTicket | null {
    const { userFence, cacheGeneration, epoch, maxUpdatedAt, projectId, generationAncestors, unknownAncestors } = current.manifest;
    const ticket = { userId: this.scope.userId, projectId, userFence, cacheGeneration, epoch, maxUpdatedAt, scopeRevision: this.scope.getProjectRevision(projectId), admissionRevision: this.scope.getAdmissionRevision(projectId), generationAncestors: generationAncestors ?? [], unknownAncestors: unknownAncestors === true };
    if (state.userFence !== ticket.userFence) this.clear(state);
    if (state.generation !== ticket.cacheGeneration) { state.resolvedAgainst.clear(); state.unresolvedVersions.clear(); }
    state.generation = ticket.cacheGeneration; state.userFence = ticket.userFence;
    if (current.assigneeVersions === null) { this.withdrawPresentation(state); return null; }
    this.reconcile(state, current.assigneeVersions);
    return ticket;
  }
  private async ready<T>(signal: AbortSignal, work: () => T): Promise<T | null> {
    while (!this.disposed && !this.scope.isInvalidated && !signal.aborted) {
      try {
        await this.scope.ready(signal);
        if (this.scope.hasIdentityMismatch) throw new TaskCacheLifecycleChanged(false);
        if (authRequestsPaused()) continue;
        if (this.disposed || this.scope.isInvalidated || signal.aborted) return null;
        return work();
      } catch (error) {
        if (this.disposed || this.scope.isInvalidated || signal.aborted) return null;
        if (authRequestsPaused() && !(error instanceof TaskCacheLifecycleChanged && !error.retryable)) continue;
        throw error;
      }
    }
    return null;
  }
  private capture(projectId: string, state: ProjectPeopleState, signal: AbortSignal): Promise<SyncTicket | null> {
    return this.ready(signal, () => {
      const current = this.scope.getAuthorizedProject(projectId);
      if (current === null) { this.withdrawPresentation(state); return null; }
      return this.adoptHistory(state, current);
    });
  }
  private matches(state: ProjectPeopleState, ticket: SyncTicket): boolean {
    const current = this.scope.getAuthorizedProject(ticket.projectId)?.manifest;
    return ticket.scopeRevision === this.scope.getProjectRevision(ticket.projectId) && state.generation === ticket.cacheGeneration && state.userFence === ticket.userFence &&
      current?.cacheGeneration === ticket.cacheGeneration && current.userFence === ticket.userFence;
  }
  private async request(ticket: SyncTicket, userIds: readonly string[], signal: AbortSignal): Promise<ProjectPeople> {
    const projectReadRevision = this.scope.getProjectReadRevision(ticket.projectId);
    try {
      return await listProjectPeople(ticket.projectId, { kind: "resolve", userIds }, signal, { userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch });
    } catch (error) {
      // Parent-project denial survives presentation changes; the scope fences its captured history.
      if (error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found" && this.scope.canRevokeProjectRead(ticket, projectReadRevision)) {
        await this.scope.revokeProject(ticket, this.scope.signal, true, error);
      }
      throw error;
    }
  }
  private publish(state: ProjectPeopleState, ticket: SyncTicket, response: ProjectPeople, requested: ReadonlyMap<string, string>, observation: ReadonlyMap<symbol, number>): void {
    if (!this.matches(state, ticket)) return;
    const current = this.scope.getAuthorizedProject(ticket.projectId)!;
    if (current.assigneeVersions === null) return;
    this.scope.markProjectReadable(ticket.projectId);
    this.reconcile(state, current.assigneeVersions);
    for (const person of response.items) {
      const expected = requested.get(person.userId), live = state.versions.get(person.userId);
      if (live === undefined || live.version !== person.version && (live.version !== expected || state.receipts !== observation)) continue;
      const { hasProjectAccess: _access, ...profile } = person;
      state.profiles.set(person.userId, profile); state.dirtyProfiles.set(person.userId, profile);
      state.resolvedAgainst.set(person.userId, live.version); state.unresolvedVersions.delete(person.userId);
    }
    for (const id of response.unresolvedUserIds) if (state.receipts === observation && state.versions.get(id)?.version === requested.get(id)) state.unresolvedVersions.set(id, requested.get(id)!);
    this.reconcile(state, current.assigneeVersions);
    this.emit(state);
  }
  private async persist(state: ProjectPeopleState, ticket: SyncTicket, signal: AbortSignal): Promise<void> {
    if (state.dirtyProfiles.size === 0) return;
    const profiles = [...state.dirtyProfiles.values()];
    await this.scope.writeProfiles(ticket, profiles, signal);
    if (!this.matches(state, ticket)) return;
    for (const profile of profiles) if (state.dirtyProfiles.get(profile.userId) === profile) state.dirtyProfiles.delete(profile.userId);
  }
  setDemand(projectId: string, owner: symbol, userIds: readonly string[]): void {
    const state = this.project(projectId);
    state.demands.set(owner, [...new Set(userIds.map(requestId))].sort());
    this.updateDemand(projectId, state);
  }
  removeDemand(projectId: string, owner: symbol): void {
    const state = this.project(projectId);
    state.demands.delete(owner); this.updateDemand(projectId, state);
  }
  private updateDemand(projectId: string, state: ProjectPeopleState): void {
    const ids = [...new Set([...state.demands.values()].flat())].sort();
    if (sameIds(ids, state.demandIds)) return;
    state.demandIds = ids; this.schedule(projectId, state);
  }
  receipt(projectId: string, owner: symbol, revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) return;
    const state = this.project(projectId);
    if (revision === 0) { state.receipts.delete(owner); return; }
    if (state.receipts.get(owner) === revision) return;
    state.receipts = new Map(state.receipts).set(owner, revision);
    state.resolvedAgainst.clear(); state.unresolvedVersions.clear();
    this.schedule(projectId, state);
  }
  removeReceipt(projectId: string, owner: symbol): void { this.project(projectId).receipts.delete(owner); }
  private schedule(projectId: string, state: ProjectPeopleState): void {
    if (this.disposed || this.scope.isInvalidated || state.queued) return;
    state.queued = true;
    queueMicrotask(() => {
      state.queued = false;
      if (!this.disposed && !this.scope.isInvalidated) void this.resolve(projectId, state);
    });
  }
  private async resolve(projectId: string, state: ProjectPeopleState): Promise<void> {
    if (state.resolving) { state.refreshPending = true; return; }
    if (!state.catalogueRequested && (state.demandIds.length === 0 || state.receipts.size === 0)) return;
    state.resolving = true; state.refreshPending = false;
    const signal = AbortSignal.any([this.lifetime.signal, this.scope.signal]);
    try {
      const ticket = await this.capture(projectId, state, signal);
      if (ticket === null) return;
      if (!state.hydrated) {
        const profiles = await this.scope.readProfiles(ticket, signal);
        await this.ready(signal, () => {
          if (!this.matches(state, ticket)) return;
          for (const profile of profiles) state.profiles.set(profile.userId, profile);
          state.hydrated = true;
        });
      }
      const admitted = await this.capture(projectId, state, signal);
      if (admitted === null || admitted.cacheGeneration !== ticket.cacheGeneration) return;
      await this.persist(state, ticket, signal);
      const desired = state.catalogueRequested ? [...state.versions.keys()] : state.demandIds;
      const ids = desired.filter((id) => state.versions.has(id) && !state.people.has(id) && !state.unresolved.has(id));
      if (state.catalogueRequested && ids.length !== 0) state.catalogueStatus = "loading";
      this.emit(state);
      const batches: Promise<unknown>[] = [];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const userIds = ids.slice(offset, offset + 100);
        const requested = new Map(userIds.map((id) => [id, state.versions.get(id)!.version]));
        const observation = state.receipts;
        batches.push(this.request(ticket, userIds, signal).then(async (response) => {
          await this.ready(signal, () => this.publish(state, ticket, response, requested, observation));
        }));
      }
      const outcomes = await Promise.allSettled(batches);
      await this.ready(signal, () => {
        if (!this.matches(state, ticket)) return;
        const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected" && !isAbortError(outcome.reason));
        state.error = failure?.reason ?? null;
        if (state.catalogueRequested) state.catalogueStatus = failure === undefined ? "ready" : "error";
        this.emit(state);
      });
      if (this.matches(state, ticket)) await this.persist(state, ticket, signal);
    } catch (error) {
      if (!signal.aborted && !isAbortError(error) && !this.disposed) {
        state.error = error; if (state.catalogueRequested) state.catalogueStatus = "error"; this.emit(state);
      }
    } finally {
      state.resolving = false;
      if (state.refreshPending) { state.refreshPending = false; this.schedule(projectId, state); }
    }
  }
  openCatalogue(projectId: string): void {
    const state = this.project(projectId);
    if (state.catalogueRequested) return;
    state.catalogueRequested = true; state.catalogueStatus = "loading";
    this.emit(state); this.schedule(projectId, state);
  }
  retryCatalogue(projectId: string): void {
    const state = this.project(projectId);
    state.catalogueRequested = true; state.catalogueStatus = "loading"; state.error = null;
    this.emit(state); this.schedule(projectId, state);
  }
  dispose(): void {
    this.disposed = true; this.lifetime.abort(); this.unsubscribe();
    this.scope.signal.removeEventListener("abort", this.onScopeAbort);
    for (const state of this.projects.values()) state.listeners.clear();
  }
}

const Context = createContext<TaskAssignees | null>(null);
export const TaskAssigneesProvider = ({ children }: { readonly children: ReactNode }) => {
  const scope = useTaskCacheScope();
  const [owner] = useState(() => new TaskAssignees(scope));
  useEffect(() => () => owner.dispose(), [owner]);
  return <Context.Provider value={owner}>{children}</Context.Provider>;
};
const useOwner = (): TaskAssignees => {
  const owner = useContext(Context);
  if (owner === null) throw new Error("An authenticated task assignee owner is required.");
  return owner;
};
const usePeople = (owner: TaskAssignees, projectId: string): AssigneePeopleSnapshot => {
  const subscribe = useCallback((listener: () => void) => owner.subscribe(projectId, listener), [owner, projectId]);
  const snapshot = useCallback(() => owner.snapshot(projectId), [owner, projectId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
};
export const useTaskAssigneeDemand = (projectId: string, userIds: readonly (string | null)[]): AssigneePeopleSnapshot => {
  const owner = useOwner(), token = useRef(Symbol());
  const ids = [...new Set(userIds.filter((id): id is string => id !== null).map(requestId))].sort();
  const key = ids.join(",");
  useEffect(() => {
    owner.setDemand(projectId, token.current, key === "" ? [] : key.split(","));
    return () => owner.removeDemand(projectId, token.current);
  }, [owner, projectId, key]);
  return usePeople(owner, projectId);
};
export const useProjectAssigneeReceipt = (projectId: string, graphOwner: symbol, revision: number): void => {
  const owner = useOwner();
  useEffect(() => { owner.receipt(projectId, graphOwner, revision); }, [owner, projectId, graphOwner, revision]);
  useEffect(() => () => owner.removeReceipt(projectId, graphOwner), [owner, projectId, graphOwner]);
};
export const useProjectAssigneeCatalogue = (projectId: string) => {
  const owner = useOwner();
  const snapshot = usePeople(owner, projectId);
  const open = useCallback(() => owner.openCatalogue(projectId), [owner, projectId]);
  const retry = useCallback(() => owner.retryCatalogue(projectId), [owner, projectId]);
  return { ...snapshot, open, retry };
};
