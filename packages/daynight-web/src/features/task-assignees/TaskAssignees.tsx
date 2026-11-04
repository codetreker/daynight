import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { listProjectPeople } from "../../api/auth";
import type { ProjectPeople, ProjectPeopleQuery, ProjectPerson } from "../../api/auth-types";
import { ApiError, authRequestsPaused, isAbortError, requestId } from "../../api/client";
import { useTaskCacheScope } from "../task-cache/TaskCacheProvider";
import type { CacheEvent, SyncTicket, TaskCacheScope } from "../task-cache/project-cache";

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
  people: Map<string, ProjectPerson>;
  unresolved: Set<string>;
  sequences: Map<string, number>;
  sequence: number;
  demands: Map<symbol, readonly string[]>;
  demandIds: readonly string[];
  demandRevision: number;
  receipts: Map<symbol, number>;
  queued: boolean;
  resolving: boolean;
  refreshPending: boolean;
  catalogueOperation: number;
  catalogueIds: readonly string[];
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
        generation: null, userFence: null, people: new Map(), unresolved: new Set(), sequences: new Map(), sequence: 0,
        demands: new Map(), demandIds: [], demandRevision: 0, receipts: new Map(), queued: false, resolving: false,
        refreshPending: false, catalogueOperation: 0, catalogueIds: [], catalogueStatus: "idle", error: null,
        listeners: new Set(), snapshot: emptySnapshot(),
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
      items: state.catalogueIds.flatMap((id) => {
        const person = state.people.get(id);
        return person === undefined || state.unresolved.has(id) ? [] : [person];
      }),
    };
    for (const listener of state.listeners) listener();
  }
  private clear(state: ProjectPeopleState): void {
    state.people = new Map(); state.unresolved = new Set(); state.sequences.clear();
    state.catalogueIds = []; state.catalogueStatus = "idle"; state.error = null;
    state.demandRevision += 1;
    this.emit(state);
  }
  private readonly onScopeAbort = (): void => {
    for (const state of this.projects.values()) this.clear(state);
  };
  private readonly onCacheEvent = (event: CacheEvent): void => {
    const state = this.projects.get(event.projectId);
    if (state === undefined) return;
    if (event.accessRevoked === true) {
      if (event.revokedGeneration !== state.generation) return;
      this.clear(state);
      state.error = event.error ?? null;
      this.emit(state);
      return;
    }
    if (this.scope.isInvalidated || authRequestsPaused()) return;
    const current = this.scope.getAuthorizedProject(event.projectId);
    if (current !== null) {
      const { userFence, cacheGeneration, epoch, maxUpdatedAt } = current.manifest;
      this.adoptHistory(state, { userId: this.scope.userId, projectId: event.projectId, userFence, cacheGeneration, epoch, maxUpdatedAt });
    }
  };
  private adoptHistory(state: ProjectPeopleState, ticket: SyncTicket): void {
    if (state.generation === ticket.cacheGeneration && state.userFence === ticket.userFence) return;
    this.clear(state);
    state.generation = ticket.cacheGeneration; state.userFence = ticket.userFence;
  }
  private async ready<T>(signal: AbortSignal, work: () => T): Promise<T | null> {
    while (!this.disposed && !this.scope.isInvalidated && !signal.aborted) {
      try {
        await this.scope.ready(signal);
        if (authRequestsPaused()) continue;
        if (this.disposed || this.scope.isInvalidated || signal.aborted) return null;
        return work();
      } catch (error) {
        if (this.disposed || this.scope.isInvalidated || signal.aborted) return null;
        if (authRequestsPaused()) continue;
        throw error;
      }
    }
    return null;
  }
  private capture(projectId: string, state: ProjectPeopleState, signal: AbortSignal): Promise<SyncTicket | null> {
    return this.ready(signal, () => {
      const current = this.scope.getAuthorizedProject(projectId);
      if (current === null) return null;
      const { userFence, cacheGeneration, epoch, maxUpdatedAt } = current.manifest;
      const ticket = { userId: this.scope.userId, projectId, userFence, cacheGeneration, epoch, maxUpdatedAt };
      this.adoptHistory(state, ticket);
      return ticket;
    });
  }
  private matches(state: ProjectPeopleState, ticket: SyncTicket): boolean {
    const current = this.scope.getAuthorizedProject(ticket.projectId)?.manifest;
    return state.generation === ticket.cacheGeneration && state.userFence === ticket.userFence &&
      current?.cacheGeneration === ticket.cacheGeneration && current.userFence === ticket.userFence;
  }
  private async request(ticket: SyncTicket, query: ProjectPeopleQuery, signal: AbortSignal): Promise<ProjectPeople> {
    try {
      return await listProjectPeople(ticket.projectId, query, signal, { userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch });
    } catch (error) {
      // Parent-project denial survives presentation changes; the scope fences its captured history.
      if (error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found" && this.scope.canRevokeProject(ticket)) {
        await this.scope.revokeProject(ticket, this.scope.signal, true, error);
      }
      throw error;
    }
  }
  private publish(state: ProjectPeopleState, response: ProjectPeople, sequence: number): void {
    const people = new Map(state.people), unresolved = new Set(state.unresolved);
    for (const person of response.items) {
      if (sequence < (state.sequences.get(person.userId) ?? 0)) continue;
      state.sequences.set(person.userId, sequence); people.set(person.userId, person); unresolved.delete(person.userId);
    }
    for (const id of response.unresolvedUserIds) {
      if (sequence < (state.sequences.get(id) ?? 0)) continue;
      state.sequences.set(id, sequence); unresolved.add(id);
    }
    state.people = people; state.unresolved = unresolved;
    this.emit(state);
  }
  setDemand(projectId: string, owner: symbol, userIds: readonly string[]): void {
    const state = this.project(projectId);
    state.demands.set(owner, [...new Set(userIds.map(requestId))].sort());
    this.updateDemand(projectId, state);
  }
  removeDemand(projectId: string, owner: symbol): void {
    const state = this.project(projectId);
    state.demands.delete(owner);
    this.updateDemand(projectId, state);
  }
  private updateDemand(projectId: string, state: ProjectPeopleState): void {
    const ids = [...new Set([...state.demands.values()].flat())].sort();
    if (sameIds(ids, state.demandIds)) return;
    state.demandIds = ids; state.demandRevision += 1;
    this.schedule(projectId, state);
  }
  receipt(projectId: string, owner: symbol, revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) return;
    const state = this.project(projectId);
    if (revision === 0) { state.receipts.delete(owner); return; }
    if (state.receipts.get(owner) === revision) return;
    state.receipts.set(owner, revision);
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
    if (state.demandIds.length === 0 || state.receipts.size === 0) return;
    state.resolving = true; state.refreshPending = false;
    const signal = AbortSignal.any([this.lifetime.signal, this.scope.signal]);
    try {
      const ticket = await this.capture(projectId, state, signal);
      if (ticket === null || state.demandIds.length === 0 || state.receipts.size === 0) return;
      const demandRevision = state.demandRevision, ids = state.demandIds;
      const batches: Promise<unknown>[] = [];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const userIds = ids.slice(offset, offset + 100), sequence = ++state.sequence;
        batches.push(this.request(ticket, { kind: "resolve", userIds }, signal).then(async (response) => {
          await this.ready(signal, () => {
            if (state.demandRevision === demandRevision && this.matches(state, ticket)) this.publish(state, response, sequence);
          });
        }));
      }
      const outcomes = await Promise.allSettled(batches);
      await this.ready(signal, () => {
        if (state.demandRevision !== demandRevision || !this.matches(state, ticket)) return;
        const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected" && !isAbortError(outcome.reason));
        state.error = failure?.reason ?? null;
        this.emit(state);
      });
    } catch (error) {
      if (!signal.aborted && !isAbortError(error) && !this.disposed) { state.error = error; this.emit(state); }
    } finally {
      state.resolving = false;
      if (state.refreshPending) { state.refreshPending = false; this.schedule(projectId, state); }
    }
  }
  openCatalogue(projectId: string): void {
    const state = this.project(projectId), operation = ++state.catalogueOperation;
    state.catalogueStatus = "loading"; state.error = null; this.emit(state);
    const signal = AbortSignal.any([this.lifetime.signal, this.scope.signal]);
    void (async () => {
      const ticket = await this.capture(projectId, state, signal);
      if (ticket === null || operation !== state.catalogueOperation) return;
      state.catalogueStatus = "loading"; this.emit(state);
      const sequence = ++state.sequence;
      try {
        const response = await this.request(ticket, { kind: "catalogue" }, signal);
        await this.ready(signal, () => {
          if (operation !== state.catalogueOperation || !this.matches(state, ticket)) return;
          state.catalogueIds = response.items.map((person) => person.userId);
          state.catalogueStatus = "ready"; state.error = null;
          this.publish(state, response, sequence);
        });
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        await this.ready(signal, () => {
          if (operation !== state.catalogueOperation || !this.matches(state, ticket)) return;
          state.catalogueStatus = "error"; state.error = error; this.emit(state);
        });
      }
    })().catch((error: unknown) => {
      if (!signal.aborted && !isAbortError(error) && !this.disposed && operation === state.catalogueOperation) {
        state.catalogueStatus = "error"; state.error = error; this.emit(state);
      }
    });
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
  return { ...snapshot, open, retry: open };
};
