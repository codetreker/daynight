import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, authRequestsPaused, getTask, isAbortError, setTaskAgentPermission, setTaskRequiredPlatform, setTaskStatus } from "../../api/client";
import { isTaskStale } from "./freshness";
import type { ExecutionPlatform, GraphTask, TaskDetail, TaskStatus } from "../../api/types";
import { TaskCacheError } from "../task-cache/database";
import { useTaskCacheScope } from "../task-cache/TaskCacheProvider";
import type { SyncTicket, TaskCacheScope } from "../task-cache/project-cache";
import { materializeDetail, readCachedDetail, saveDetail, validateDetailSummary, type DetailAdmission } from "./detail-cache";

export type TaskMutationOperation = { readonly action: "status"; readonly status: TaskStatus; readonly version: bigint } | { readonly action: "allowAgents"; readonly allowAgents: boolean; readonly version: bigint } | { readonly action: "requiredPlatform"; readonly requiredPlatform: ExecutionPlatform | null; readonly version: bigint };
export type TaskMutationState = {
  readonly operation: TaskMutationOperation | null;
  readonly phase: "idle" | "pending" | "confirmed" | "refused" | "conflict" | "unknown" | "reconciled";
  readonly error: unknown;
  readonly reconciling: boolean;
  readonly reconciliationError: unknown;
};
export type DetailState = {
  readonly revision: number;
  readonly loadedRevision: number | null;
  readonly detail: TaskDetail | null;
  readonly status: "loading" | "ready" | "error";
  readonly refreshing: boolean;
  readonly requiresFreshRead: boolean;
  readonly graphMismatch: boolean;
  readonly error: unknown;
  readonly mutation: TaskMutationState;
};
type Entry = {
  state: DetailState;
  generation: number;
  read: AbortController | null;
  committedVersion: bigint | null;
  queuedRevision: number | null;
  observedTask: GraphTask | undefined;
  observedVersion: bigint | null;
  observedGeneration: string | null;
  admitted: boolean;
  liveVersion: bigint | null;
  openingGeneration: number;
  liveOpeningGeneration: number;
  mismatch: TaskDetail | null;
  pending: { readonly detail: TaskDetail; readonly ticket: SyncTicket; readonly revision: number; readonly reconciliation: boolean; readonly generation: number | null; readonly writeGeneration: number | null; readonly readOpeningGeneration: number | null } | null;
  readonly listeners: Set<() => void>;
};
const preserveCollection = (previous: TaskDetail | null, detail: TaskDetail): TaskDetail => {
  if (previous === null) return detail;
  const old = previous.properties.pullRequests;
  const fresh = detail.properties.pullRequests;
  if (old === fresh) return detail;
  const unchanged = old.length === fresh.length && old.every((item, index) => item.url === fresh[index]!.url && item.title === fresh[index]!.title);
  return unchanged ? { ...detail, properties: { ...detail.properties, pullRequests: old } } : detail;
};
const idleMutation = (): TaskMutationState => ({ operation: null, phase: "idle", error: null, reconciling: false, reconciliationError: null });
const initialState = (): DetailState => ({ revision: 0, loadedRevision: null, detail: null, status: "loading", refreshing: false, requiresFreshRead: true, graphMismatch: false, error: null, mutation: idleMutation() });
const canMutate = (state: DetailState): boolean => state.detail !== null && state.status === "ready" &&
  state.mutation.phase !== "pending" && state.mutation.phase !== "unknown" && !state.mutation.reconciling && state.mutation.reconciliationError === null && !state.requiresFreshRead && state.error === null;
export const canSetStatus = (state: DetailState): boolean => canMutate(state);
export const canSetAgentPermission = (state: DetailState): boolean => state.detail !== null && state.detail.status !== "in_progress" && canMutate(state);
export const canSetRequiredPlatform = canSetAgentPermission;

const sameIds = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((id) => right.includes(id));
const workerDescriptor = (worker: TaskDetail["properties"]["worker"]): string => JSON.stringify(worker === null ? null : [
  worker.claimId, worker.state, worker.userId, worker.workerId, worker.machine.id, worker.machine.name,
  worker.platform, worker.agent, worker.worktreeId, worker.phase,
  worker.herdr === null ? null : [worker.herdr.session, worker.herdr.workspaceId, worker.herdr.paneId], worker.nativeSessionId, worker.claimedAt,
]);
const preservesMaterials = (before: TaskDetail, after: TaskDetail): boolean => before.title === after.title && before.description === after.description &&
  before.createdAt === after.createdAt && workerDescriptor(before.properties.worker) === workerDescriptor(after.properties.worker) &&
  before.properties.pullRequests.length === after.properties.pullRequests.length && before.properties.pullRequests.every((item, index) => {
    const other = after.properties.pullRequests[index]!;
    return item.url === other.url && item.title === other.title;
  }) && sameIds(before.dependsOn, after.dependsOn) && sameIds(before.externalDependsOn, after.externalDependsOn);
const validStatusTiming = (before: TaskDetail, after: TaskDetail, target: TaskStatus): boolean => {
  if (before.status === target) return before.updatedAt === after.updatedAt && before.startedAt === after.startedAt && before.completedAt === after.completedAt;
  if (target === "todo") return after.startedAt === null && after.completedAt === null;
  if (target === "in_progress") return after.startedAt !== null && after.completedAt === null;
  return after.completedAt !== null && after.startedAt === (before.status === "in_progress" ? before.startedAt : null);
};

export class TaskDetailSessions {
  private readonly entries = new Map<string, Entry>();
  private readonly projects = new Map<string, Set<() => void>>();
  private readonly projectGenerations = new Map<string, string | null>();
  private disposed = false;
  constructor(private readonly scope: TaskCacheScope) {}
  projectGeneration(projectId: string): string | null {
    if (this.scope.isInvalidated) return null;
    if (authRequestsPaused()) return this.projectGenerations.get(projectId) ?? null;
    const generation = this.scope.getAuthorizedProject(projectId)?.manifest.cacheGeneration ?? null;
    this.projectGenerations.set(projectId, generation);
    return generation;
  }
  hasCurrentGeneration(projectId: string, taskId: string): boolean {
    return this.entry(projectId, taskId).observedGeneration === this.projectGeneration(projectId);
  }
  summaryVersion(projectId: string, taskId: string): bigint | null {
    if (this.scope.isInvalidated) return null;
    if (authRequestsPaused()) return this.entries.get(`${projectId}/${taskId}`)?.observedVersion ?? null;
    return this.scope.getSummaryVersion(projectId, taskId);
  }

  private entry(projectId: string, taskId: string): Entry {
    const key = `${projectId}/${taskId}`;
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { state: initialState(), generation: 0, read: null, committedVersion: null, queuedRevision: null, observedTask: undefined, observedVersion: null, observedGeneration: null, admitted: false, liveVersion: null, openingGeneration: 0, liveOpeningGeneration: 0, mismatch: null, pending: null, listeners: new Set() };
      this.entries.set(key, entry);
    }
    return entry;
  }
  private publish(entry: Entry, state: DetailState): void {
    entry.state = state;
    for (const listener of entry.listeners) listener();
  }
  snapshot = (projectId: string, taskId: string): DetailState => this.entry(projectId, taskId).state;
  // A mutation result cannot satisfy a later opening's required live GET.
  requireOpeningRead(projectId: string, taskId: string): void {
    const entry = this.entry(projectId, taskId);
    entry.openingGeneration++;
    entry.liveVersion = null;
    this.publish(entry, { ...entry.state, requiresFreshRead: true });
  }
  requiresFreshRead(projectId: string, taskId: string, task: GraphTask | undefined): boolean {
    const entry = this.entry(projectId, taskId);
    return entry.state.requiresFreshRead || entry.liveOpeningGeneration !== entry.openingGeneration || entry.mismatch !== null || !entry.admitted ||
      entry.observedGeneration !== this.projectGeneration(projectId) ||
      entry.committedVersion !== null && entry.state.detail !== null && entry.state.detail.version < entry.committedVersion ||
      entry.state.detail !== null && (this.summaryVersion(projectId, taskId) !== entry.state.detail.version || task === undefined);
  }
  observe(projectId: string, taskId: string, task: GraphTask | undefined, admitted = true): boolean {
    const entry = this.entry(projectId, taskId);
    const version = this.summaryVersion(projectId, taskId);
    const cacheGeneration = this.projectGeneration(projectId);
    const lifecycleChanged = entry.observedGeneration !== cacheGeneration;
    if (lifecycleChanged) {
      this.cancelRead(projectId, taskId);
      entry.liveVersion = null; entry.committedVersion = null; entry.pending = null; entry.mismatch = null;
      this.publish(entry, { ...entry.state, detail: null, loadedRevision: null, status: "loading", refreshing: false,
        requiresFreshRead: true, graphMismatch: false, error: null,
        mutation: { ...entry.state.mutation, reconciling: false, reconciliationError: null } });
    }
    const changed = lifecycleChanged || entry.observedVersion !== version;
    entry.observedGeneration = cacheGeneration;
    entry.admitted = admitted;
    entry.observedVersion = version;
    entry.observedTask = task;
    if (entry.mismatch !== null && task !== undefined && !isTaskStale(task, entry.mismatch)) entry.mismatch = null;
    const matching = entry.state.detail !== null && entry.state.detail.version === version && task !== undefined;
    const detail = matching && (entry.state.detail!.ready !== task.ready || !sameIds(entry.state.detail!.blockedBy, task.blockedBy)) ? materializeDetail(entry.state.detail!, task) : entry.state.detail;
    const requiresFreshRead = entry.liveVersion !== version || entry.liveOpeningGeneration !== entry.openingGeneration || !admitted || entry.mismatch !== null || !matching ||
      entry.committedVersion !== null && entry.state.detail !== null && entry.state.detail.version < entry.committedVersion;
    if (detail !== entry.state.detail || requiresFreshRead !== entry.state.requiresFreshRead) this.publish(entry, { ...entry.state, detail, requiresFreshRead, graphMismatch: entry.mismatch !== null });
    if (entry.pending !== null && entry.pending.detail.version === version && task !== undefined && admitted) {
      const pending = entry.pending;
      entry.pending = null;
      void this.accept(projectId, taskId, pending.detail, pending.ticket, pending.revision, pending.reconciliation, this.scope.signal, pending.generation, pending.writeGeneration, pending.readOpeningGeneration)
        .catch((error: unknown) => { if (!this.disposed && !this.scope.isInvalidated && !isAbortError(error)) this.publish(entry, { ...entry.state, refreshing: false, error }); });
      return false;
    }
    return changed || entry.state.error !== null || entry.mismatch !== null || entry.read === null && entry.pending === null && (!matching || entry.liveVersion !== version || entry.liveOpeningGeneration !== entry.openingGeneration);
  }
  subscribe = (projectId: string, taskId: string, listener: () => void): (() => void) => {
    const entry = this.entry(projectId, taskId);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) this.releaseRead(projectId, taskId);
    };
  };
  subscribeProject = (projectId: string, listener: () => void): (() => void) => {
    let listeners = this.projects.get(projectId);
    if (listeners === undefined) {
      listeners = new Set();
      this.projects.set(projectId, listeners);
    }
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  private refreshProject(projectId: string): void {
    if (this.disposed || this.scope.isInvalidated) return;
    for (const listener of this.projects.get(projectId) ?? []) listener();
  }
  cancelRead(projectId: string, taskId: string): void {
    const entry = this.entry(projectId, taskId);
    entry.generation++;
    entry.queuedRevision = null;
    entry.read?.abort();
    entry.read = null;
  }
  releaseRead(projectId: string, taskId: string): void {
    if (!this.entry(projectId, taskId).state.mutation.reconciling) this.cancelRead(projectId, taskId);
  }
  load(projectId: string, taskId: string, revision: number, mode: "open" | "refresh" | "automatic" = "refresh"): void {
    const entry = this.entry(projectId, taskId);
    if (!entry.admitted || entry.state.mutation.phase === "pending" || entry.state.mutation.phase === "unknown" || entry.state.mutation.reconciling) return;
    if (mode === "automatic") {
      if (document.visibilityState === "hidden") return;
      if (entry.read !== null) { entry.queuedRevision = revision; return; }
    }
    void this.read(projectId, taskId, revision, false, mode !== "open", mode === "automatic");
  }
  reconcile(projectId: string, taskId: string): void {
    const entry = this.entry(projectId, taskId);
    if (entry.state.mutation.phase === "pending" || entry.state.mutation.reconciling) return;
    void this.read(projectId, taskId, entry.state.revision, true, true);
  }
  private async accept(projectId: string, taskId: string, detail: TaskDetail, ticket: SyncTicket, revision: number, reconciliation: boolean, signal: AbortSignal, generation: number | null = null, writeGeneration: number | null = null, readOpeningGeneration: number | null = null): Promise<void> {
    const entry = this.entry(projectId, taskId);
    if (signal.aborted || this.disposed || this.scope.isInvalidated || generation !== null && generation !== entry.generation) return;
    if (detail.projectId !== projectId || detail.id !== taskId || entry.committedVersion !== null && detail.version < entry.committedVersion) throw new ApiError("protocol");
    let admitted: DetailAdmission;
    let storageError: unknown = null;
    try { admitted = await saveDetail(this.scope, ticket, detail, signal); }
    catch (error) {
      if (!(error instanceof TaskCacheError) || error.category !== "storage" || signal.aborted || this.disposed || this.scope.isInvalidated) throw error;
      admitted = await this.scope.detailTransaction(ticket, signal, async (_store, _manifest, summaries) => {
        const summary = summaries.get(taskId);
        if (summary?.version !== detail.version) throw error;
        validateDetailSummary(detail, summary);
        return { kind: "matching" as const, detail };
      });
      storageError = error;
    }
    if (signal.aborted || this.disposed || this.scope.isInvalidated || generation !== null && generation !== entry.generation) return;
    if (admitted.kind === "older") {
      this.publish(entry, { ...entry.state, refreshing: false, requiresFreshRead: true,
        mutation: reconciliation ? { ...entry.state.mutation, reconciling: false, reconciliationError: new ApiError("protocol") } : entry.state.mutation });
      return;
    }
    if (admitted.kind === "newer") {
      entry.pending = { detail, ticket, revision, reconciliation, generation, writeGeneration, readOpeningGeneration };
      if (writeGeneration !== null) entry.mismatch = detail;
      this.publish(entry, { ...entry.state, refreshing: false, requiresFreshRead: true,
        ...(writeGeneration === null ? {} : { detail: preserveCollection(entry.state.detail, detail), status: "ready" as const, graphMismatch: true }) });
      this.refreshProject(projectId);
      return;
    }
    const node = entry.observedTask;
    if (node === undefined || !entry.admitted || this.summaryVersion(projectId, taskId) !== detail.version) return;
    // Compare the server fields before local materialization preserves dependency-race evidence.
    entry.mismatch = isTaskStale(node, detail) ? detail : null;
    if (writeGeneration === null || writeGeneration === entry.generation) entry.liveVersion = detail.version;
    if (readOpeningGeneration !== null) entry.liveOpeningGeneration = readOpeningGeneration;
    const mutation = reconciliation
      ? { ...entry.state.mutation, phase: entry.state.mutation.phase === "unknown" ? "reconciled" as const : entry.state.mutation.phase, reconciling: false, reconciliationError: null }
      : entry.state.mutation;
    this.publish(entry, { ...entry.state, revision, loadedRevision: revision,
      detail: preserveCollection(entry.state.detail, materializeDetail(admitted.detail, node)), status: "ready", refreshing: false,
      requiresFreshRead: entry.liveVersion !== detail.version || entry.liveOpeningGeneration !== entry.openingGeneration || entry.mismatch !== null, graphMismatch: entry.mismatch !== null, error: storageError, mutation });
    if (entry.mismatch !== null || reconciliation) this.refreshProject(projectId);
  }
  private async read(projectId: string, taskId: string, revision: number, reconciliation: boolean, retainLoaded: boolean, automatic = false): Promise<void> {
    if (this.disposed || this.scope.isInvalidated) return;
    const entry = this.entry(projectId, taskId);
    this.cancelRead(projectId, taskId);
    entry.pending = null;
    const controller = new AbortController();
    entry.read = controller;
    const signal = AbortSignal.any([controller.signal, this.scope.signal]);
    const generation = entry.generation;
    const openingGeneration = entry.openingGeneration;
    if (!automatic) entry.liveVersion = null;
    const retain = entry.state.detail !== null && (retainLoaded || entry.state.mutation.phase !== "idle");
    this.publish(entry, { ...entry.state, revision, loadedRevision: retain ? entry.state.loadedRevision : null, detail: retain ? entry.state.detail : null,
      requiresFreshRead: !automatic || entry.state.requiresFreshRead,
      status: retain ? "ready" : automatic && entry.state.error !== null ? "error" : "loading", refreshing: retain, error: automatic ? entry.state.error : null,
      mutation: reconciliation ? { ...entry.state.mutation, reconciling: true, reconciliationError: null } : entry.state.mutation });
    try {
      const ticket = await this.scope.beginSync(projectId, signal);
      if (!retain && entry.admitted) {
        const cached = await readCachedDetail(this.scope, ticket, taskId, signal);
        const node = entry.observedTask;
        if (cached !== null && node !== undefined && cached.version === this.summaryVersion(projectId, taskId) && generation === entry.generation && !signal.aborted) {
          this.publish(entry, { ...entry.state, detail: materializeDetail(cached, node), status: "ready", refreshing: true, requiresFreshRead: true });
        }
      }
      const detail = await getTask(projectId, taskId, signal, { userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch });
      if (signal.aborted || generation !== entry.generation || this.disposed) return;
      await this.accept(projectId, taskId, detail, ticket, revision, reconciliation, signal, generation, null, openingGeneration);
    } catch (error) {
      if (signal.aborted || generation !== entry.generation || this.disposed || !retain && !reconciliation && isAbortError(error)) return;
      const missing = error instanceof ApiError && error.kind === "server" && error.status === 404;
      const detail = missing ? null : entry.state.detail;
      this.publish(entry, { ...entry.state, detail, loadedRevision: missing ? null : entry.state.loadedRevision, status: detail !== null ? "ready" : "error", refreshing: false,
        error: reconciliation && detail !== null ? null : error,
        mutation: reconciliation ? { ...entry.state.mutation, reconciling: false, reconciliationError: error } : entry.state.mutation });
    } finally {
      if (generation === entry.generation) {
        entry.read = null;
        const queued = entry.queuedRevision !== null ? entry.queuedRevision
          : openingGeneration !== entry.openingGeneration ? entry.state.revision : null;
        entry.queuedRevision = null;
        if (queued !== null && entry.listeners.size > 0 && !this.disposed) this.load(projectId, taskId, queued, "automatic");
      }
    }
  }
  private writableState(projectId: string, taskId: string): DetailState {
    const entry = this.entry(projectId, taskId);
    return { ...entry.state, requiresFreshRead: this.scope.isInvalidated || this.requiresFreshRead(projectId, taskId, entry.observedTask) };
  }
  setStatus(projectId: string, taskId: string, status: TaskStatus, version: bigint): void {
    const state = this.writableState(projectId, taskId);
    if (!canSetStatus(state) || state.detail!.version !== version || !["todo", "in_progress", "done"].includes(status)) return;
    this.performMutation(projectId, taskId, { action: "status", status, version });
  }
  setAgentPermission(projectId: string, taskId: string, allowAgents: boolean, version: bigint): void {
    const state = this.writableState(projectId, taskId);
    if (!canSetAgentPermission(state) || state.detail!.version !== version || state.detail!.allowAgents === allowAgents) return;
    this.performMutation(projectId, taskId, { action: "allowAgents", allowAgents, version });
  }
  setRequiredPlatform(projectId: string, taskId: string, requiredPlatform: ExecutionPlatform | null, version: bigint): void {
    const state = this.writableState(projectId, taskId);
    if (!canSetRequiredPlatform(state) || state.detail!.version !== version || state.detail!.requiredPlatform === requiredPlatform) return;
    this.performMutation(projectId, taskId, { action: "requiredPlatform", requiredPlatform, version });
  }
  private performMutation(projectId: string, taskId: string, operation: TaskMutationOperation): void {
    const entry = this.entry(projectId, taskId);
    const previous = entry.state.detail!;
    this.cancelRead(projectId, taskId);
    const operationGeneration = entry.generation;
    this.publish(entry, { ...entry.state, refreshing: false, error: null, mutation: { operation, phase: "pending", error: null, reconciling: false, reconciliationError: null } });
    // Submitted writes outlive their dialog, while identity retirement still fences their result.
    void (async () => {
      let submitted = false;
      let confirmed = false;
      let validated = false;
      const changed = operation.action !== "status" || previous.status !== operation.status;
      const committedVersion = operation.version + (changed ? 1n : 0n);
      try {
        const signal = this.scope.signal;
        const ticket = await this.scope.beginSync(projectId, signal);
        await this.scope.detailTransaction(ticket, signal, async (_store, _manifest, summaries) => {
          if (summaries.get(taskId)?.version !== operation.version) throw new ApiError("protocol");
        });
        const admission = { userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch,
          onWriteConfirmed: () => {
            confirmed = true;
            if (this.projectGeneration(projectId) === ticket.cacheGeneration) entry.committedVersion = committedVersion;
          } };
        submitted = true;
        const detail = operation.action === "allowAgents"
          ? await setTaskAgentPermission(projectId, taskId, operation.allowAgents, operation.version, signal, admission)
          : operation.action === "requiredPlatform"
            ? await setTaskRequiredPlatform(projectId, taskId, operation.requiredPlatform, operation.version, signal, admission)
            : await setTaskStatus(projectId, taskId, operation.status, operation.version, signal, admission);
        if (this.scope.isInvalidated || signal.aborted) return;
        if (this.disposed) {
          entry.state = { ...entry.state, mutation: { operation, phase: "confirmed", error: null, reconciling: false, reconciliationError: null } };
          return;
        }
        const preservesTiming = detail.startedAt === previous.startedAt && detail.completedAt === previous.completedAt;
        const validResult = operation.action === "allowAgents"
          ? detail.status === previous.status && detail.allowAgents === operation.allowAgents && detail.requiredPlatform === previous.requiredPlatform && preservesTiming
          : operation.action === "requiredPlatform"
            ? detail.status === previous.status && detail.requiredPlatform === operation.requiredPlatform && detail.allowAgents === previous.allowAgents && preservesTiming
            : detail.status === operation.status && detail.allowAgents === previous.allowAgents && detail.requiredPlatform === previous.requiredPlatform && validStatusTiming(previous, detail, operation.status);
        if (detail.projectId !== projectId || detail.id !== taskId || !validResult || !preservesMaterials(previous, detail) || detail.version !== committedVersion) throw new ApiError("protocol");
        validated = true;
        confirmed = true;
        if (this.projectGeneration(projectId) === ticket.cacheGeneration) entry.committedVersion = detail.version;
        await this.accept(projectId, taskId, detail, ticket, entry.state.revision, false, signal, null, operationGeneration);
        if (this.disposed || this.scope.isInvalidated) return;
        this.publish(entry, { ...entry.state, mutation: { operation, phase: "confirmed", error: null, reconciling: false, reconciliationError: null } });
        this.refreshProject(projectId);
      } catch (error) {
        if (this.scope.isInvalidated) return;
        if (this.disposed) {
          const phase = confirmed ? "confirmed" : error instanceof ApiError && error.kind === "server" && error.status !== null && error.status >= 400 && error.status < 500
            ? error.code === "version_conflict" ? "conflict" : "refused" : "unknown";
          entry.state = { ...entry.state, mutation: { operation, phase, error: confirmed ? null : error, reconciling: false, reconciliationError: null } };
          return;
        }
        if (confirmed) {
          this.publish(entry, { ...entry.state, error, requiresFreshRead: true, refreshing: false,
            mutation: { operation, phase: "confirmed", error: null, reconciling: false, reconciliationError: null } });
          this.refreshProject(projectId);
          if (!validated) await this.read(projectId, taskId, entry.state.revision, true, true);
          return;
        }
        const phase = !submitted ? "refused" : error instanceof ApiError && error.kind === "server" && error.status !== null && error.status >= 400 && error.status < 500
          ? error.code === "version_conflict" ? "conflict" : "refused" : "unknown";
        this.publish(entry, { ...entry.state, mutation: { operation, phase, error, reconciling: false, reconciliationError: null } });
        if (phase === "conflict" || phase === "unknown") {
          if (phase === "conflict") this.refreshProject(projectId);
          if (!this.disposed) await this.read(projectId, taskId, entry.state.revision, true, true);
        }
      }
    })();
  }
  dispose(): void {
    this.disposed = true;
    this.projects.clear();
    this.projectGenerations.clear();
    for (const entry of this.entries.values()) {
      entry.generation++;
      entry.read?.abort();
      entry.listeners.clear();
    }
  }
}
const Context = createContext<TaskDetailSessions | null>(null);
export const TaskDetailSessionProvider = ({ children }: { readonly children: ReactNode }) => {
  const scope = useTaskCacheScope();
  const [sessions] = useState(() => new TaskDetailSessions(scope));
  useEffect(() => () => { sessions.dispose(); }, [sessions]);
  return <Context.Provider value={sessions}>{children}</Context.Provider>;
};
export const TaskDetailSessionBoundary = ({ children }: { readonly children: ReactNode }) =>
  useContext(Context) === null ? <TaskDetailSessionProvider>{children}</TaskDetailSessionProvider> : children;
export const useTaskDetailSessions = (): TaskDetailSessions => {
  const sessions = useContext(Context);
  if (sessions === null) throw new Error("Task detail sessions are required.");
  return sessions;
};
