import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, authRequestsPaused, deleteTask, getTask, isAbortError, setTaskAgentPermission, setTaskRequiredPlatform, setTaskStatus, withdrawWorkerClaim } from "../../api/client";
import { isTaskStale } from "./freshness";
import type { ExecutionPlatform, GraphTask, TaskDetail, TaskStatus } from "../../api/types";
import { TaskCacheError } from "../task-cache/database";
import { useTaskCacheScope } from "../task-cache/TaskCacheProvider";
import type { SyncTicket, TaskCacheScope } from "../task-cache/project-cache";
import { materializeDetail, readCachedDetail, saveDetail, validateDetailSummary, type DetailAdmission } from "./detail-cache";

export type TaskMutationOperation = { readonly action: "withdraw"; readonly claimId: string; readonly version: bigint } | { readonly action: "delete"; readonly version: bigint; readonly removeDepends: boolean } | { readonly action: "status"; readonly status: TaskStatus; readonly version: bigint } | { readonly action: "allowAgents"; readonly allowAgents: boolean; readonly version: bigint } | { readonly action: "requiredPlatform"; readonly requiredPlatform: ExecutionPlatform | null; readonly version: bigint };
type TaskMutationReview = { readonly detail: TaskDetail; readonly cacheGeneration: string };
class TaskMutationReviewExpired extends Error {}
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
  readonly status: "loading" | "ready" | "error" | "deleted";
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
  queuedRead: { readonly revision: number; readonly reconciliation: boolean } | null;
  observedTask: GraphTask | undefined;
  observedVersion: bigint | null;
  observedGeneration: string | null;
  deletedGeneration: string | null;
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
export const canDeleteTask = (state: DetailState): boolean => canMutate(state);
export const canSetStatus = (state: DetailState): boolean => canMutate(state);
export const canSetAgentPermission = (state: DetailState): boolean => state.detail !== null && state.detail.status !== "in_progress" && canMutate(state);
export const canSetRequiredPlatform = canSetAgentPermission;
export const canWithdrawClaim = (state: DetailState): boolean => canMutate(state) && state.detail!.properties.worker !== null && state.detail!.properties.worker.state !== "completed";

const sameIds = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((id) => right.includes(id));
const workerDescriptor = (worker: TaskDetail["properties"]["worker"]): string => JSON.stringify(worker === null ? null : [
  worker.claimId, worker.state, worker.userId, worker.workerId, worker.machine.id, worker.machine.name,
  worker.platform, worker.agent, worker.worktreeId, worker.phase,
  worker.herdr === null ? null : [worker.herdr.session, worker.herdr.workspaceId, worker.herdr.paneId], worker.nativeSessionId, worker.claimedAt,
]);
const preservesMaterials = (before: TaskDetail, after: TaskDetail, preserveWorker = true): boolean => before.title === after.title && before.description === after.description &&
  before.createdAt === after.createdAt && (!preserveWorker || workerDescriptor(before.properties.worker) === workerDescriptor(after.properties.worker)) &&
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
      entry = { state: initialState(), generation: 0, read: null, committedVersion: null, queuedRead: null, observedTask: undefined, observedVersion: null, observedGeneration: null, deletedGeneration: null, admitted: false, liveVersion: null, openingGeneration: 0, liveOpeningGeneration: 0, mismatch: null, pending: null, listeners: new Set() };
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
    if (entry.state.status === "deleted") return;
    entry.openingGeneration++;
    entry.liveVersion = null;
    this.publish(entry, { ...entry.state, requiresFreshRead: true });
  }
  requiresFreshRead(projectId: string, taskId: string, task: GraphTask | undefined): boolean {
    const entry = this.entry(projectId, taskId);
    if (entry.state.status === "deleted") return false;
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
    const restored = entry.state.status === "deleted" && admitted && cacheGeneration !== null &&
      cacheGeneration !== entry.deletedGeneration && version !== null && task !== undefined;
    const removed = admitted && cacheGeneration !== null && entry.observedVersion !== null && version === null && task === undefined;
    if (removed && entry.state.status !== "deleted") {
      this.cancelRead(projectId, taskId);
      this.markDeleted(projectId, taskId, cacheGeneration, null, "reconciled");
    }
    if (entry.state.status === "deleted" && !restored) {
      entry.observedGeneration = cacheGeneration; entry.observedVersion = version; entry.observedTask = task; entry.admitted = admitted;
      return false;
    }
    if (lifecycleChanged || restored) {
      this.cancelRead(projectId, taskId);
      entry.liveVersion = null; entry.committedVersion = null; entry.pending = null; entry.mismatch = null; entry.deletedGeneration = null;
      const deniedError = cacheGeneration === null ? entry.state.error : null;
      this.publish(entry, { ...entry.state, detail: null, loadedRevision: null, status: deniedError === null ? "loading" : "error", refreshing: false,
        requiresFreshRead: true, graphMismatch: false, error: deniedError,
        mutation: restored ? idleMutation() : { ...entry.state.mutation, reconciling: false, reconciliationError: null } });
    }
    const changed = lifecycleChanged || restored || entry.observedVersion !== version;
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
    // A current-state feed may skip the intermediate version held by a detail response.
    if (entry.pending !== null && version !== null && entry.pending.detail.version < version && task !== undefined && admitted) {
      const pending = entry.pending;
      entry.pending = null;
      entry.liveVersion = null;
      entry.queuedRead = { revision: pending.revision, reconciliation: pending.reconciliation };
      this.publish(entry, { ...entry.state, requiresFreshRead: true,
        mutation: pending.reconciliation ? { ...entry.state.mutation, reconciling: true, reconciliationError: null } : entry.state.mutation });
      this.drainReads(projectId, taskId);
      return false;
    }
    if (entry.pending !== null && entry.pending.detail.version === version && task !== undefined && admitted) {
      const pending = entry.pending;
      const generation = entry.generation;
      entry.pending = null;
      void this.accept(projectId, taskId, pending.detail, pending.ticket, pending.revision, pending.reconciliation, this.scope.signal, pending.generation, pending.writeGeneration, pending.readOpeningGeneration)
        .catch((error: unknown) => {
          if (this.disposed || this.scope.isInvalidated || isAbortError(error) || generation !== entry.generation ||
            this.projectGeneration(projectId) !== pending.ticket.cacheGeneration) return;
          this.failRead(entry, error, pending.reconciliation);
        });
      return false;
    }
    if (entry.pending !== null) return false;
    return changed || entry.state.error !== null || entry.mismatch !== null || entry.read === null && (!matching || entry.liveVersion !== version || entry.liveOpeningGeneration !== entry.openingGeneration);
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
    entry.queuedRead = null;
    entry.read?.abort();
    entry.read = null;
  }
  releaseRead(projectId: string, taskId: string): void {
    if (!this.entry(projectId, taskId).state.mutation.reconciling) this.cancelRead(projectId, taskId);
  }
  private drainReads(projectId: string, taskId: string): void {
    const entry = this.entry(projectId, taskId);
    if (this.disposed || this.scope.isInvalidated || !entry.admitted || entry.read !== null || entry.state.mutation.phase === "pending") return;
    const queued = entry.queuedRead;
    if (queued === null) return;
    entry.queuedRead = null;
    if (queued.reconciliation) void this.read(projectId, taskId, queued.revision, true, true);
    else if (entry.listeners.size > 0) this.load(projectId, taskId, queued.revision, "automatic");
  }
  load(projectId: string, taskId: string, revision: number, mode: "open" | "refresh" | "automatic" = "refresh"): void {
    const entry = this.entry(projectId, taskId);
    if (!entry.admitted || entry.state.status === "deleted" || entry.state.mutation.phase === "pending" || entry.state.mutation.phase === "unknown" || entry.state.mutation.reconciling) return;
    if (mode === "automatic") {
      if (document.visibilityState === "hidden") return;
      if (entry.read !== null) {
        if (entry.queuedRead === null || !entry.queuedRead.reconciliation) entry.queuedRead = { revision, reconciliation: false };
        return;
      }
    }
    void this.read(projectId, taskId, revision, false, mode !== "open", mode === "automatic");
  }
  reconcile(projectId: string, taskId: string): void {
    const entry = this.entry(projectId, taskId);
    if (!entry.admitted || entry.state.status === "deleted" || entry.state.mutation.phase === "pending" || entry.state.mutation.reconciling) return;
    void this.read(projectId, taskId, entry.state.revision, entry.state.mutation.operation !== null, true);
  }
  private async revokeAccess(ticket: SyncTicket, error: ApiError, signal: AbortSignal): Promise<void> {
    if (!this.scope.canRevokeProject(ticket)) return;
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(`${ticket.projectId}/`)) continue;
      entry.admitted = false; entry.liveVersion = null; entry.pending = null; entry.queuedRead = null; entry.mismatch = null;
      const state: DetailState = { ...entry.state, detail: null, loadedRevision: null, status: "error", refreshing: false, requiresFreshRead: true, graphMismatch: false, error,
        mutation: { ...entry.state.mutation, reconciling: false, reconciliationError: entry.state.mutation.reconciling ? error : entry.state.mutation.reconciliationError } };
      if (this.disposed) entry.state = state;
      else this.publish(entry, state);
    }
    await this.scope.revokeProject(ticket, signal, true, error);
  }
  private markDeleted(projectId: string, taskId: string, cacheGeneration: string, error: ApiError | null, phase: "confirmed" | "reconciled" = "confirmed"): void {
    if (this.scope.isInvalidated) return;
    if (this.projectGeneration(projectId) !== cacheGeneration) { this.refreshProject(projectId); return; }
    const entry = this.entry(projectId, taskId);
    entry.deletedGeneration = cacheGeneration;
    entry.liveVersion = null; entry.pending = null; entry.queuedRead = null; entry.mismatch = null;
    const mutation = entry.state.mutation.operation?.action === "delete"
      ? { ...entry.state.mutation, phase, error: phase === "reconciled" ? entry.state.mutation.error : null, reconciling: false, reconciliationError: null }
      : { ...entry.state.mutation, reconciling: false, reconciliationError: null };
    const state: DetailState = { ...entry.state, detail: null, loadedRevision: null, status: "deleted", refreshing: false,
      requiresFreshRead: false, graphMismatch: false, error, mutation };
    if (this.disposed) entry.state = state;
    else this.publish(entry, state);
    this.refreshProject(projectId);
  }
  private failRead(entry: Entry, error: unknown, reconciliation: boolean): void {
    const missing = error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found";
    const detail = missing ? null : entry.state.detail;
    this.publish(entry, { ...entry.state, detail, loadedRevision: missing ? null : entry.state.loadedRevision, status: detail !== null ? "ready" : "error", refreshing: false,
      requiresFreshRead: reconciliation || entry.state.requiresFreshRead,
      error: reconciliation && detail !== null ? null : error,
      mutation: reconciliation ? { ...entry.state.mutation, reconciling: false, reconciliationError: error } : entry.state.mutation });
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
    if (node === undefined || !entry.admitted || this.summaryVersion(projectId, taskId) !== detail.version) {
      if (reconciliation) this.failRead(entry, new ApiError("protocol"), true);
      return;
    }
    // Compare the server fields before local materialization preserves dependency-race evidence.
    entry.mismatch = isTaskStale(node, detail) ? detail : null;
    if (writeGeneration === null || writeGeneration === entry.generation) entry.liveVersion = detail.version;
    if (readOpeningGeneration !== null) entry.liveOpeningGeneration = readOpeningGeneration;
    const mutation = reconciliation
      ? { ...entry.state.mutation, phase: entry.state.mutation.phase === "unknown" ? "reconciled" as const : entry.state.mutation.phase, reconciling: false, reconciliationError: null }
      : readOpeningGeneration !== null ? { ...entry.state.mutation, reconciling: false, reconciliationError: null } : entry.state.mutation;
    this.publish(entry, { ...entry.state, revision, loadedRevision: revision,
      detail: preserveCollection(entry.state.detail, materializeDetail(admitted.detail, node)), status: "ready", refreshing: false,
      requiresFreshRead: entry.liveVersion !== detail.version || entry.liveOpeningGeneration !== entry.openingGeneration || entry.mismatch !== null, graphMismatch: entry.mismatch !== null, error: storageError, mutation });
    if (entry.mismatch !== null || reconciliation) this.refreshProject(projectId);
    if (entry.liveOpeningGeneration !== entry.openingGeneration) {
      if (entry.queuedRead === null) entry.queuedRead = { revision, reconciliation: false };
      this.drainReads(projectId, taskId);
    }
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
    let ticket: SyncTicket | null = null;
    let knownTask = false;
    try {
      ticket = await this.scope.beginSync(projectId, signal);
      knownTask = this.scope.getSummaryVersion(projectId, taskId) !== null;
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
      if (ticket !== null && error instanceof ApiError && error.kind === "server" && error.status === 410 && error.code === "task_deleted") {
        this.markDeleted(projectId, taskId, ticket.cacheGeneration, error, reconciliation ? "reconciled" : "confirmed");
        return;
      }
      const denied = knownTask && ticket !== null && error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found";
      if (denied) {
        try { await this.revokeAccess(ticket!, error, signal); }
        catch (storageError) { if (!isAbortError(storageError) && !this.disposed && !this.scope.isInvalidated && generation === entry.generation && this.scope.canRevokeProject(ticket!)) this.failRead(entry, storageError, reconciliation); }
        return;
      }
      this.failRead(entry, error, reconciliation);
    } finally {
      if (generation === entry.generation) {
        entry.read = null;
        if (entry.queuedRead === null && openingGeneration !== entry.openingGeneration) {
          entry.queuedRead = { revision: entry.state.revision, reconciliation: false };
        }
        this.drainReads(projectId, taskId);
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
  withdrawClaim(projectId: string, taskId: string, claimId: string, version: bigint): void {
    const state = this.writableState(projectId, taskId);
    if (!canWithdrawClaim(state) || state.detail!.version !== version || state.detail!.properties.worker!.claimId !== claimId) return;
    this.performMutation(projectId, taskId, { action: "withdraw", claimId, version });
  }
  deleteTask(projectId: string, taskId: string, version: bigint, removeDepends: boolean): void {
    const state = this.writableState(projectId, taskId);
    if (!canDeleteTask(state) || state.detail!.version !== version) return;
    this.performMutation(projectId, taskId, { action: "delete", version, removeDepends });
  }
  private async runMutationStage<T>(projectId: string, taskId: string, operation: TaskMutationOperation, work: () => T | Promise<T>): Promise<{ readonly value: T } | null> {
    const entry = this.entry(projectId, taskId);
    while (!this.scope.isInvalidated && entry.state.mutation.operation === operation) {
      try { await this.scope.ready(this.scope.signal); }
      catch (error) {
        if (this.scope.isInvalidated) return null;
        if (authRequestsPaused()) continue;
        throw error;
      }
      if (authRequestsPaused()) continue;
      if (this.scope.isInvalidated || entry.state.mutation.operation !== operation) return null;
      // Admission and its synchronous effects share the same unpaused turn.
      return { value: await work() };
    }
    return null;
  }
  private mutationIsCurrent(projectId: string, entry: Entry, operation: TaskMutationOperation, ticket: SyncTicket): boolean {
    return !this.scope.isInvalidated && entry.state.mutation.operation === operation && this.projectGeneration(projectId) === ticket.cacheGeneration;
  }
  private admitMutationOutcome(projectId: string, taskId: string, operation: TaskMutationOperation, ticket: SyncTicket | null, error: unknown = null): boolean {
    const entry = this.entry(projectId, taskId);
    if (this.scope.isInvalidated || entry.state.mutation.operation !== operation) return false;
    if (ticket === null || this.mutationIsCurrent(projectId, entry, operation, ticket)) return true;
    const project = this.scope.getAuthorizedProject(projectId);
    if (!this.disposed && project !== null && entry.observedGeneration !== project.manifest.cacheGeneration) {
      this.observe(projectId, taskId, project.index.nodes.get(taskId), true);
      if (entry.state.mutation.operation !== operation) return false;
    }
    // Another history's receipt cannot establish the current task, even at the same version.
    const gone = entry.state.status === "deleted";
    const state: DetailState = { ...entry.state, requiresFreshRead: !gone, refreshing: false,
      mutation: { operation, phase: gone ? "reconciled" : "unknown", error, reconciling: false, reconciliationError: null } };
    if (this.disposed) entry.state = state;
    else {
      this.publish(entry, state);
      this.refreshProject(projectId);
      if (!gone && entry.admitted && this.projectGeneration(projectId) !== null) void this.read(projectId, taskId, entry.state.revision, true, true);
    }
    return false;
  }
  private assertMutationReview(projectId: string, taskId: string, operation: TaskMutationOperation, review: TaskMutationReview, ticket: SyncTicket): void {
    const entry = this.entry(projectId, taskId);
    const project = this.scope.getAuthorizedProject(projectId);
    if (this.scope.isInvalidated || entry.state.mutation.operation !== operation || !entry.admitted ||
      entry.observedGeneration !== review.cacheGeneration || ticket.cacheGeneration !== review.cacheGeneration ||
      project?.manifest.cacheGeneration !== review.cacheGeneration || this.summaryVersion(projectId, taskId) !== operation.version ||
      isTaskStale(project.index.nodes.get(taskId), review.detail)) throw new TaskMutationReviewExpired();
  }
  private expireMutationReview(projectId: string, taskId: string, operation: TaskMutationOperation): void {
    const entry = this.entry(projectId, taskId);
    if (this.scope.isInvalidated || entry.state.mutation.operation !== operation) return;
    const project = this.scope.getAuthorizedProject(projectId);
    if (!this.disposed && project !== null && entry.observedGeneration !== project.manifest.cacheGeneration) {
      this.observe(projectId, taskId, project.index.nodes.get(taskId), true);
      if (entry.state.mutation.operation !== operation) return;
    }
    const gone = entry.state.status === "deleted";
    const state: DetailState = { ...entry.state, requiresFreshRead: !gone, refreshing: false,
      mutation: { operation, phase: gone ? "reconciled" : "conflict", error: null, reconciling: false, reconciliationError: null } };
    if (this.disposed) entry.state = state;
    else {
      this.publish(entry, state);
      this.refreshProject(projectId);
      if (!gone && entry.admitted && this.projectGeneration(projectId) !== null) void this.read(projectId, taskId, entry.state.revision, true, true);
    }
  }
  private performMutation(projectId: string, taskId: string, operation: TaskMutationOperation): void {
    const entry = this.entry(projectId, taskId);
    const previous = entry.state.detail!;
    const reviewedGeneration = this.projectGeneration(projectId);
    if (reviewedGeneration === null) return;
    const review: TaskMutationReview = { detail: previous, cacheGeneration: reviewedGeneration };
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
      const signal = this.scope.signal;
      let ticket: SyncTicket | null = null;
      try {
        ticket = await this.scope.beginSync(projectId, signal);
        const requestTicket = ticket;
        const prepared = await this.runMutationStage(projectId, taskId, operation, () => {
          this.assertMutationReview(projectId, taskId, operation, review, requestTicket);
          return this.scope.detailTransaction(requestTicket, signal, async (_store, _manifest, summaries) => {
            if (summaries.get(taskId)?.version !== operation.version) throw new ApiError("protocol");
          });
        });
        if (prepared === null) return;
        const admission = { userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch,
          onWriteConfirmed: () => { confirmed = true; } };
        if (operation.action === "delete") {
          const response = await this.runMutationStage(projectId, taskId, operation, () => {
            this.assertMutationReview(projectId, taskId, operation, review, requestTicket);
            submitted = true;
            return deleteTask(projectId, taskId, operation.version, operation.removeDepends, signal, admission);
          });
          if (response === null) return;
          await this.runMutationStage(projectId, taskId, operation, () => {
            if (this.admitMutationOutcome(projectId, taskId, operation, requestTicket)) this.markDeleted(projectId, taskId, requestTicket.cacheGeneration, null);
          });
          return;
        }
        const response = await this.runMutationStage(projectId, taskId, operation, () => {
          this.assertMutationReview(projectId, taskId, operation, review, requestTicket);
          submitted = true;
          return operation.action === "withdraw"
            ? withdrawWorkerClaim(projectId, taskId, operation.claimId, operation.version, signal, admission)
            : operation.action === "allowAgents"
            ? setTaskAgentPermission(projectId, taskId, operation.allowAgents, operation.version, signal, admission)
            : operation.action === "requiredPlatform"
              ? setTaskRequiredPlatform(projectId, taskId, operation.requiredPlatform, operation.version, signal, admission)
              : setTaskStatus(projectId, taskId, operation.status, operation.version, signal, admission);
        });
        if (response === null) return;
        const detail = response.value;
        await this.runMutationStage(projectId, taskId, operation, async () => {
          if (!this.admitMutationOutcome(projectId, taskId, operation, requestTicket)) return;
          if (confirmed) entry.committedVersion = committedVersion;
          if (this.disposed) {
            entry.state = { ...entry.state, mutation: { operation, phase: "confirmed", error: null, reconciling: false, reconciliationError: null } };
            return;
          }
          const preservesTiming = detail.startedAt === previous.startedAt && detail.completedAt === previous.completedAt;
          const validResult = operation.action === "withdraw"
            ? detail.status === "todo" && !detail.allowAgents && detail.properties.worker === null && detail.startedAt === null && detail.completedAt === null && detail.requiredPlatform === previous.requiredPlatform
            : operation.action === "allowAgents"
            ? detail.status === previous.status && detail.allowAgents === operation.allowAgents && detail.requiredPlatform === previous.requiredPlatform && preservesTiming
            : operation.action === "requiredPlatform"
              ? detail.status === previous.status && detail.requiredPlatform === operation.requiredPlatform && detail.allowAgents === previous.allowAgents && preservesTiming
              : detail.status === operation.status && detail.allowAgents === previous.allowAgents && detail.requiredPlatform === previous.requiredPlatform && validStatusTiming(previous, detail, operation.status);
          if (detail.projectId !== projectId || detail.id !== taskId || !validResult || !preservesMaterials(previous, detail, operation.action !== "withdraw") || detail.version !== committedVersion) throw new ApiError("protocol");
          validated = true;
          confirmed = true;
          entry.committedVersion = detail.version;
          await this.accept(projectId, taskId, detail, requestTicket, entry.state.revision, false, signal, null, operationGeneration);
          await this.runMutationStage(projectId, taskId, operation, () => {
            if (this.disposed || !this.admitMutationOutcome(projectId, taskId, operation, requestTicket)) return;
            this.publish(entry, { ...entry.state, mutation: { operation, phase: "confirmed", error: null, reconciling: false, reconciliationError: null } });
            this.refreshProject(projectId);
          });
        });
      } catch (error) {
        if (this.scope.isInvalidated) return;
        // Access withdrawal belongs to the scope even while identity checks suspend positive admission.
        if (!confirmed && submitted && ticket !== null && error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found") {
          if (entry.state.mutation.operation === operation) {
            const state: DetailState = { ...entry.state, mutation: { operation, phase: "refused", error, reconciling: false, reconciliationError: null } };
            if (this.disposed) entry.state = state;
            else this.publish(entry, state);
          }
          try { await this.revokeAccess(ticket, error, signal); }
          catch (storageError) { if (!isAbortError(storageError) && !this.disposed && !this.scope.isInvalidated && this.scope.canRevokeProject(ticket)) this.failRead(entry, storageError, false); }
          return;
        }
        await this.runMutationStage(projectId, taskId, operation, async () => {
          if (error instanceof TaskMutationReviewExpired || !submitted && (isAbortError(error) || ticket !== null && !this.mutationIsCurrent(projectId, entry, operation, ticket))) {
            this.expireMutationReview(projectId, taskId, operation);
            return;
          }
          if (!this.admitMutationOutcome(projectId, taskId, operation, ticket, error)) return;
          if (confirmed) entry.committedVersion = committedVersion;
          if (submitted && ticket !== null && error instanceof ApiError && error.kind === "server" && error.status === 410 && error.code === "task_deleted") {
            this.markDeleted(projectId, taskId, ticket.cacheGeneration, error);
            return;
          }
          if (entry.state.status === "deleted") {
            const state: DetailState = { ...entry.state, mutation: { operation, phase: "reconciled", error, reconciling: false, reconciliationError: null } };
            if (this.disposed) entry.state = state;
            else this.publish(entry, state);
            return;
          }
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
        });
      } finally { this.drainReads(projectId, taskId); }
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
