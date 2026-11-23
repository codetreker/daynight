import { readPullRequests, readTaskPaused, readWorkerClaim, sameTaskProperties } from "../../api/task-properties";
import { sameTaskTags } from "../../api/task-tags";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, authRequestsPaused, authRequestsPauseRevision, subscribeAuthPause, deleteTask, getTaskObservation, isAbortError, requestId, setTaskAgentPermission, setTaskAssignedTo, setTaskRequiredPlatform, setTaskStatus, unpauseTask, updateTaskFields, withdrawWorkerClaim } from "../../api/client";
import { isTaskStale } from "./freshness";
import type { ExecutionPlatform, GraphTask, TaskDetail, TaskStatus } from "../../api/types";
import { TaskCacheError } from "../task-cache/database";
import { useTaskCacheScope } from "../task-cache/TaskCacheProvider";
import { TaskCacheLifecycleChanged, isRetryableTaskCacheLifecycleChange, type SyncTicket, type TaskCacheScope, type TaskReadFence } from "../task-cache/project-cache";
import { materializeDetail, readCachedDetail, saveDetail, validateDetailSummary, type DetailAdmission } from "./detail-cache";
import type { CommittedTaskProjection } from '../projects/committed-task-projection';

const emptyCommittedTasks: ReadonlyMap<string, CommittedTaskProjection> = new Map();

export type TaskMutationOperation = { readonly action: "unpause"; readonly version: bigint } | { readonly action: "withdraw"; readonly claimId: string; readonly version: bigint } | { readonly action: "delete"; readonly version: bigint; readonly removeDepends: boolean } | { readonly action: "status"; readonly status: TaskStatus; readonly version: bigint; readonly cancelDescendants?: true } | { readonly action: "parent"; readonly parentId: string | null; readonly version: bigint } | { readonly action: "editGoal"; readonly title: string; readonly description: string; readonly version: bigint } | { readonly action: "tags"; readonly tagIds: readonly string[]; readonly version: bigint } | { readonly action: "allowAgents"; readonly allowAgents: boolean; readonly version: bigint } | { readonly action: "requiredPlatform"; readonly requiredPlatform: ExecutionPlatform | null; readonly version: bigint } | { readonly action: "assignedTo"; readonly assignedTo: string | null; readonly version: bigint };
export type TaskObservationInput = { readonly kind: "project-summary"; readonly revision: number; readonly task: GraphTask | undefined } | { readonly kind: "direct" };
type DirectTaskReceipt = { readonly fence: TaskReadFence; readonly epoch: string; readonly detail: TaskDetail };
const directQualification = Symbol("directQualification");
export type DirectQualification = { readonly [directQualification]: DirectTaskReceipt };
type ReadTicket = SyncTicket | TaskReadFence;
type TaskMutationReview = { readonly detail: TaskDetail; readonly cacheGeneration: string; readonly scopeRevision: number; readonly receipt: DirectTaskReceipt | null };
class TaskMutationReviewExpired extends Error {}
const abortableMutation = <T,>(signal: AbortSignal, work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
  const abort = () => { cleanup(); reject(signal.reason); };
  const cleanup = () => signal.removeEventListener("abort", abort);
  if (signal.aborted) { void work.catch(() => {}); reject(signal.reason); return; }
  signal.addEventListener("abort", abort, { once: true });
  work.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
});
export type TaskMutationState = {
  readonly operation: TaskMutationOperation | null;
  readonly phase: "idle" | "pending" | "confirmed" | "refused" | "conflict" | "unknown" | "reconciled";
  readonly error: unknown;
  readonly reconciling: boolean;
  readonly reconciliationError: unknown;
  readonly reconciledFrom?: "unknown" | "conflict";
  readonly publicationPending?: boolean;
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
  readonly projectId: string;
  readonly taskId: string;
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
  source: "project-summary" | "direct";
  receipt: DirectTaskReceipt | null;
  historyRetry: boolean;
  historyHintRetry: boolean;
  directAccessPending: boolean;
  directParentReadFailed: boolean;
  withdrawn: boolean;
  operationFence: TaskReadFence | null;
  operationTaskEpoch: string | null;
  liveOpeningGeneration: number;
  mismatch: TaskDetail | null;
  pending: { readonly detail: TaskDetail; readonly ticket: SyncTicket; readonly revision: number; readonly reconciliation: boolean; readonly generation: number | null; readonly writeGeneration: number | null; readonly readOpeningGeneration: number | null } | null;
  readonly listeners: Set<() => void>;
};
const preserveCollection = (previous: TaskDetail | null, detail: TaskDetail): TaskDetail => {
  if (previous === null) return detail;
  const old = readPullRequests(previous.properties);
  const fresh = readPullRequests(detail.properties);
  if (old === undefined || fresh === undefined || old === fresh) return detail;
  const unchanged = sameTaskProperties({ pullRequests: old }, { pullRequests: fresh });
  return unchanged ? { ...detail, properties: { ...detail.properties, pullRequests: old } } : detail;
};
const idleMutation = (): TaskMutationState => ({ operation: null, phase: "idle", error: null, reconciling: false, reconciliationError: null });
const initialState = (): DetailState => ({ revision: 0, loadedRevision: null, detail: null, status: "loading", refreshing: false, requiresFreshRead: true, graphMismatch: false, error: null, mutation: idleMutation() });
const canMutate = (state: DetailState): boolean => state.detail !== null && state.status === "ready" &&
  state.mutation.phase !== "pending" && state.mutation.phase !== "unknown" && !state.mutation.reconciling && state.mutation.reconciliationError === null && !state.requiresFreshRead && state.error === null;
export const canDeleteTask = (state: DetailState): boolean => canMutate(state);
export const canSetTags = (state: DetailState): boolean => canMutate(state);
export const canSetStatus = (state: DetailState): boolean => canMutate(state) && (state.detail!.type === "goal" || state.detail!.status !== "cancelled");
export const canUnpause = (state: DetailState): boolean => canMutate(state) && readTaskPaused(state.detail!.properties) === true;
export const canSetAgentPermission = (state: DetailState): boolean => state.detail !== null && state.detail.status !== "in_progress" && canMutate(state);
export const canSetRequiredPlatform = canSetAgentPermission;
export const canSetAssignedTo = (state: DetailState): boolean => canMutate(state) && (state.detail!.type === "goal" || state.detail!.status !== "in_progress");
export const canSetParent = (state: DetailState): boolean => canMutate(state) && state.detail!.type === "task" && state.detail!.parentTaskId == null;
export const canEditGoal = (state: DetailState): boolean => canMutate(state) && state.detail!.type === "goal";
export const canWithdrawClaim = (state: DetailState): boolean => {
  if (!canMutate(state) || state.detail!.status === "cancelled") return false;
  const worker = readWorkerClaim(state.detail!.properties);
  return worker?.state === "active";
};

const sameIds = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((id) => right.includes(id));
const preservesMaterials = (before: TaskDetail, after: TaskDetail, preserveWorker = true, preserveAssignment = true, preserveTags = true): boolean => before.title === after.title && before.description === after.description &&
  before.createdAt === after.createdAt && sameTaskProperties(before.properties, after.properties, !preserveWorker) && (!preserveTags || sameTaskTags(before.tags, after.tags)) &&
  (!preserveAssignment || before.assignedTo === after.assignedTo) &&
  sameIds(before.dependsOn, after.dependsOn) && sameIds(before.externalDependsOn, after.externalDependsOn);
const validStatusTiming = (before: TaskDetail, after: TaskDetail, target: TaskStatus): boolean => {
  if (before.status === target) return before.updatedAt === after.updatedAt && before.startedAt === after.startedAt && before.completedAt === after.completedAt && before.cancelledAt === after.cancelledAt;
  if (before.type === "goal") {
    if (target === "todo") return after.startedAt === null && after.completedAt === null && after.cancelledAt === null;
    if (target === "in_progress") return after.startedAt !== null && after.completedAt === null && after.cancelledAt === null;
    if (target === "done") return after.startedAt === before.startedAt && after.completedAt !== null && after.cancelledAt === null;
    if (target === "cancelled") return after.startedAt === before.startedAt && after.completedAt === null && after.cancelledAt !== null;
    return false;
  }
  if (target === "cancelled") return after.cancelledAt !== null && after.startedAt === before.startedAt && after.completedAt === before.completedAt;
  if (after.cancelledAt !== null) return false;
  if (target === "proposed" || target === "todo") return after.startedAt === null && after.completedAt === null;
  if (target === "in_progress") return after.startedAt !== null && after.completedAt === null;
  return after.completedAt !== null && after.startedAt === (before.status === "in_progress" ? before.startedAt : null);
};

export class TaskDetailSessions {
  private readonly entries = new Map<string, Entry>();
  private readonly retiredMutations = new Map<TaskMutationOperation, { readonly projectId: string; readonly taskId: string; readonly fence: TaskReadFence | null; readonly taskEpoch: string | null; phase: "pending" | "confirmed" | "unknown" | "conflict" | "refused"; error: unknown; reconciling: boolean; committedVersion: bigint | null; historyRetries: number; historyConfirmRetries: number }>();
  private readonly mutationControllers = new Map<string, { readonly operation: TaskMutationOperation; readonly controller: AbortController; settle?: () => void; dispose?: () => void }>();
  private readonly receiptReadGenerations = new WeakMap<TaskMutationOperation, number>();
  private readonly projects = new Map<string, Set<() => void>>();
  private readonly committedTasks = new Map<string, ReadonlyMap<string, CommittedTaskProjection>>();
  private readonly committedListeners = new Map<string, Set<() => void>>();
  private readonly projectGenerations = new Map<string, string | null>();
  private disposed = false;
  private readonly releaseScope: () => void;
  private readonly onScopeRetired = (): void => {
    for (const projectId of this.committedTasks.keys()) this.clearCommittedTasks(projectId);
    for (const entry of this.entries.values()) {
      if (entry.source !== "direct") continue;
      this.cancelRead(entry.projectId, entry.taskId);
      entry.receipt = null; entry.liveVersion = null; entry.admitted = false; entry.pending = null;
      this.publish(entry, { ...initialState(), status: "error", error: new ApiError("protocol") });
    }
  };
  constructor(private readonly scope: TaskCacheScope) {
    this.releaseScope = scope.subscribe((event) => {
      if (event.historyChanged || event.accessRevoked || event.scopeSuspended) this.clearCommittedTasks(event.projectId);
      if (event.accessRevoked) this.projectGenerations.set(event.projectId, null);
      for (const entry of this.entries.values()) {
        if (entry.projectId !== event.projectId) continue;
        if (entry.source === "direct" && event.directAccessUncertain) {
          this.retireMutation(entry);
          this.cancelRead(event.projectId, entry.taskId);
          entry.openingGeneration++; entry.receipt = null; entry.liveVersion = null; entry.committedVersion = null;
          entry.pending = null; entry.mismatch = null; entry.admitted = false; entry.directAccessPending = true;
          this.publish(entry, { ...initialState(), revision: entry.state.revision, status: "loading" });
          continue;
        }
        if (entry.source === "direct" && event.directAccessRecheck && entry.directAccessPending) {
          if (event.error !== undefined) {
            if (!event.scopeSuspended) entry.admitted = true;
            this.publish(entry, { ...initialState(), revision: entry.state.revision, status: "error", error: event.error });
          }
          else {
            entry.directAccessPending = false; entry.admitted = true;
            if (entry.listeners.size > 0) queueMicrotask(() => {
              if (!this.disposed && entry.listeners.size > 0) void this.read(event.projectId, entry.taskId, entry.state.revision, false, false);
            });
          }
          continue;
        }
        if (entry.source === "direct" && event.accessRevoked && entry.directAccessPending) {
          if (event.error !== undefined) this.publish(entry, { ...entry.state, status: "error", error: event.error });
          continue;
        }
        if (event.historyChanged && entry.state.status === "deleted" && entry.state.mutation.operation?.action === "delete" && (entry.state.mutation.phase === "confirmed" || entry.state.mutation.phase === "reconciled")) continue;
        if (entry.source === "direct" && (event.historyChanged || event.accessRevoked)) {
          if (event.historyChanged && event.historyHint && entry.state.status === "deleted" && entry.operationTaskEpoch !== null && entry.state.mutation.phase === "reconciled") continue;
          const canRetry = event.historyChanged === true && (event.historyHint ? !entry.historyHintRetry : !entry.historyRetry) && entry.listeners.size > 0;
          this.retireMutation(entry);
          if (event.historyHint) entry.historyHintRetry = true;
          else if (event.historyChanged) entry.historyRetry = true;
          this.cancelRead(event.projectId, entry.taskId);
          entry.openingGeneration++; entry.receipt = null; entry.liveVersion = null; entry.committedVersion = null;
          entry.pending = null; entry.mismatch = null; entry.admitted = !event.accessRevoked; entry.directAccessPending = false;
          entry.observedGeneration = this.entryGeneration(entry);
          this.publish(entry, { ...initialState(), revision: entry.state.revision, status: canRetry ? "loading" : "error",
            error: canRetry ? null : event.error ?? new ApiError("protocol") });
          if (canRetry) queueMicrotask(() => {
            if (!this.disposed && entry.listeners.size > 0) void this.read(event.projectId, entry.taskId, entry.state.revision, false, false);
          });
          continue;
        }
        if (event.historyChanged === true) {
          const previousVersion = entry.observedVersion;
          this.observe(event.projectId, entry.taskId, undefined, false);
          // A complete later summary may still establish that a previously
          // observed task is absent, even though its old detail is retired.
          entry.observedVersion = previousVersion;
          continue;
        }
        if (event.accessRevoked) {
          this.observe(event.projectId, entry.taskId, undefined, false);
        }
      }
    });
    scope.signal.addEventListener("abort", this.onScopeRetired, { once: true });
  }
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
      entry = { projectId, taskId, state: initialState(), generation: 0, read: null, committedVersion: null, queuedRead: null, observedTask: undefined, observedVersion: null, observedGeneration: null, deletedGeneration: null, admitted: false, liveVersion: null, openingGeneration: 0, source: "project-summary", receipt: null, historyRetry: false, historyHintRetry: false, directAccessPending: false, directParentReadFailed: false, withdrawn: false, operationFence: null, operationTaskEpoch: null, liveOpeningGeneration: 0, mismatch: null, pending: null, listeners: new Set() };
      this.entries.set(key, entry);
    }
    return entry;
  }
  private entryGeneration(entry: Entry): string | null {
    return entry.source === "direct" ? `history:${this.scope.getHistoryGeneration(entry.projectId)}` : this.projectGeneration(entry.projectId);
  }
  private observedParentVersion(entry: Entry, allowAuthPaused = false): bigint | null {
    if (entry.source === "direct") return entry.receipt !== null && this.scope.isTaskReadCurrent(entry.receipt.fence, allowAuthPaused) &&
      entry.receipt.fence.openingSequence === entry.openingGeneration ? entry.receipt.detail.version : null;
    return this.summaryVersion(entry.projectId, entry.taskId);
  }
  private ticketCurrent(entry: Entry, ticket: ReadTicket, allowAuthPaused = false): boolean {
    return !this.scope.hasIdentityMismatch && ("historyGeneration" in ticket ? entry.source === "direct" && ticket.openingSequence === entry.openingGeneration && this.scope.isTaskReadCurrent(ticket, allowAuthPaused)
      : entry.source === "project-summary" && ticket.scopeRevision === this.scope.getProjectRevision(ticket.projectId) && this.projectGeneration(ticket.projectId) === ticket.cacheGeneration);
  }
  historyGeneration(projectId: string): number { return this.scope.getHistoryGeneration(projectId); }
  directRequiresFreshRead(projectId: string, taskId: string, allowAuthPaused = false): boolean {
    const entry = this.entry(projectId, taskId);
    return entry.source !== "direct" || entry.receipt === null || !this.ticketCurrent(entry, entry.receipt.fence, allowAuthPaused) || entry.state.requiresFreshRead ||
      this.hasRetiredWrite(projectId, taskId) ||
      entry.state.status !== "ready" || entry.state.error !== null || entry.state.detail?.version !== entry.receipt.detail.version ||
      entry.state.mutation.phase === "unknown" || entry.state.mutation.reconciling || entry.state.mutation.reconciliationError !== null ||
      entry.committedVersion !== null && entry.receipt.detail.version < entry.committedVersion;
  }
  private hasRetiredWrite(projectId: string, taskId: string): boolean {
    return [...this.retiredMutations.values()].some((retired) => retired.projectId === projectId && retired.taskId === taskId && retired.fence !== null && this.scope.isTaskHistoryPossiblyCurrent(retired.fence));
  }
  captureDirectQualification(projectId: string, taskId: string, allowAuthPaused = false): DirectQualification | null {
    const entry = this.entry(projectId, taskId);
    return this.directRequiresFreshRead(projectId, taskId, allowAuthPaused) || entry.state.mutation.phase === "pending" || entry.receipt === null ? null : { [directQualification]: entry.receipt };
  }
  isDirectQualificationCurrent(projectId: string, taskId: string, qualification: DirectQualification): boolean {
    const entry = this.entry(projectId, taskId);
    return entry.receipt === qualification[directQualification] && entry.state.mutation.phase !== "pending" && !this.directRequiresFreshRead(projectId, taskId);
  }
  directSessionCurrent(projectId: string, taskId: string, allowAuthPaused = false): boolean {
    const entry = this.entry(projectId, taskId);
    const receipt = entry.receipt;
    if (entry.source !== "direct" || receipt === null || !this.ticketCurrent(entry, receipt.fence, allowAuthPaused) || entry.directParentReadFailed || entry.withdrawn ||
      entry.state.status !== "ready" || entry.state.error !== null || entry.state.detail?.version !== receipt.detail.version) return false;
    const mutation = entry.state.mutation;
    return !this.directRequiresFreshRead(projectId, taskId, allowAuthPaused) && mutation.phase !== "pending";
  }
  captureDirectSessionQualification(projectId: string, taskId: string): DirectQualification | null {
    const entry = this.entry(projectId, taskId);
    return this.directSessionCurrent(projectId, taskId) && entry.receipt !== null ? { [directQualification]: entry.receipt } : null;
  }
  async captureDirectSessionHistoryTicket(projectId: string, taskId: string, qualification: DirectQualification, signal: AbortSignal): Promise<SyncTicket | null> {
    const current = () => this.directSessionCurrent(projectId, taskId) && this.entry(projectId, taskId).receipt === qualification[directQualification];
    if (!current()) return null;
    const receipt = qualification[directQualification];
    const ticket = await this.scope.getDirectHistoryTicket(receipt.fence, receipt.epoch, signal);
    return current() ? ticket : null;
  }
  async verifyDirectQualification(projectId: string, taskId: string, qualification: DirectQualification, signal: AbortSignal): Promise<boolean> {
    if (!this.isDirectQualificationCurrent(projectId, taskId, qualification)) return false;
    return await this.scope.verifyTaskRead(qualification[directQualification].fence, signal) && this.isDirectQualificationCurrent(projectId, taskId, qualification);
  }
  isDirectQualificationHistoryCurrent(projectId: string, taskId: string, qualification: DirectQualification): boolean {
    const entry = this.entry(projectId, taskId); const receipt = qualification[directQualification];
    const missing = entry.state.error instanceof ApiError && entry.state.error.kind === "server" && entry.state.error.status === 404;
    return entry.source === "direct" && entry.admitted && entry.state.status !== "deleted" && !missing &&
      entry.openingGeneration === receipt.fence.openingSequence && this.scope.isTaskReadCurrent(receipt.fence, true);
  }
  async verifyDirectQualificationHistory(projectId: string, taskId: string, qualification: DirectQualification, signal: AbortSignal): Promise<boolean> {
    if (!this.isDirectQualificationHistoryCurrent(projectId, taskId, qualification)) return false;
    return await this.scope.verifyTaskRead(qualification[directQualification].fence, signal) && this.isDirectQualificationHistoryCurrent(projectId, taskId, qualification);
  }
  async captureDirectHistoryTicket(projectId: string, taskId: string, qualification: DirectQualification, signal: AbortSignal): Promise<SyncTicket | null> {
    if (!this.isDirectQualificationCurrent(projectId, taskId, qualification)) return null;
    const receipt = qualification[directQualification];
    const ticket = await this.scope.getDirectHistoryTicket(receipt.fence, receipt.epoch, signal);
    return this.isDirectQualificationCurrent(projectId, taskId, qualification) ? ticket : null;
  }
  reportDirectHistoryDenied(projectId: string, taskId: string, qualification: DirectQualification, manifestAbsent = false, origin?: symbol): boolean {
    const receipt = qualification[directQualification];
    if (!this.isDirectQualificationHistoryCurrent(projectId, taskId, qualification)) return false;
    return this.scope.reportDirectSessionDenied(receipt.fence, receipt.epoch, manifestAbsent, origin);
  }
  openDirect(projectId: string, taskId: string): void {
    const entry = this.entry(projectId, taskId);
    this.retireMutation(entry, true);
    this.cancelRead(projectId, taskId);
    entry.source = "direct"; entry.openingGeneration++; entry.historyRetry = false; entry.historyHintRetry = false; entry.directAccessPending = false; entry.receipt = null; entry.admitted = true;
    entry.observedGeneration = this.entryGeneration(entry); entry.committedVersion = null; entry.deletedGeneration = null;
    entry.liveVersion = null; entry.pending = null; entry.mismatch = null;
    const isolation = this.scope.enrollDirectProject(projectId);
    if (isolation !== null) {
      entry.directAccessPending = true; entry.admitted = false;
      this.publish(entry, { ...initialState(), revision: 1, status: isolation.error === null ? "loading" : "error", error: isolation.error });
      return;
    }
    this.publish(entry, { ...initialState(), revision: 1 });
    this.load(projectId, taskId, 1, "open");
  }
  private publish(entry: Entry, state: DetailState): void {
    entry.state = state;
    for (const listener of entry.listeners) listener();
  }
  private async getParent(entry: Entry, ticket: SyncTicket, signal: AbortSignal): Promise<TaskDetail> {
    const admission = { userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch };
    const observation = await getTaskObservation(entry.projectId, entry.taskId, signal, admission);
    if (await this.scope.observeHistory(ticket, observation.epoch, signal) !== "current") throw new DOMException("The task history changed.", "AbortError");
    return observation.detail;
  }
  private taskVersionFloor(entry: Entry): bigint | null {
    const pending = entry.pending;
    const pendingVersion = pending !== null && pending.ticket.cacheGeneration === this.projectGeneration(entry.projectId) &&
      (pending.generation === null || pending.generation === entry.generation) ? pending.detail.version : null;
    const versions = [this.observedParentVersion(entry), entry.state.detail?.version ?? null, entry.committedVersion, pendingVersion];
    return versions.reduce<bigint | null>((floor, version) => version !== null && (floor === null || version > floor) ? version : floor, null);
  }
  snapshot = (projectId: string, taskId: string): DetailState => this.entry(projectId, taskId).state;
  // A mutation result cannot satisfy a later opening's required live GET.
  requireOpeningRead(projectId: string, taskId: string): void {
    const entry = this.entry(projectId, taskId);
    const switched = entry.source === "direct";
    if (switched) this.retireMutation(entry);
    entry.source = "project-summary"; entry.receipt = null;
    if (switched) this.publish(entry, initialState());
    if (entry.state.status === "deleted") { entry.deletedGeneration = null; this.publish(entry, initialState()); }
    entry.openingGeneration++;
    entry.liveVersion = null;
    this.publish(entry, { ...entry.state, requiresFreshRead: true });
  }
  requiresFreshRead(projectId: string, taskId: string, task: GraphTask | undefined): boolean {
    const entry = this.entry(projectId, taskId);
    if (entry.state.status === "deleted") return false;
    return entry.state.requiresFreshRead || entry.liveOpeningGeneration !== entry.openingGeneration || entry.mismatch !== null || !entry.admitted ||
      this.hasRetiredWrite(projectId, taskId) ||
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
    // The rendered graph can lag the already committed cache generation.
    const removed = admitted && cacheGeneration !== null && entry.observedVersion !== null && version === null &&
      this.scope.getAuthorizedProject(projectId)?.summaries.has(taskId) === false;
    if (removed && entry.state.status !== "deleted") {
      this.markDeleted(projectId, taskId, cacheGeneration, null, "reconciled");
    }
    if (entry.state.status === "deleted" && !restored) {
      entry.observedGeneration = cacheGeneration; entry.observedVersion = version; entry.observedTask = task; entry.admitted = admitted;
      if (lifecycleChanged) this.publish(entry, { ...entry.state });
      return false;
    }
    if (lifecycleChanged || restored) {
      this.cancelRead(projectId, taskId);
      entry.liveVersion = null; entry.committedVersion = null; entry.pending = null; entry.mismatch = null; entry.deletedGeneration = null;
      const deniedError = cacheGeneration === null ? entry.state.error : null;
      this.publish(entry, { ...entry.state, detail: null, loadedRevision: null, status: deniedError === null ? "loading" : "error", refreshing: false,
        requiresFreshRead: true, graphMismatch: false, error: deniedError,
        mutation: restored ? idleMutation() : { ...entry.state.mutation,
          reconciling: false, reconciliationError: cacheGeneration === null ? entry.state.mutation.reconciliationError : null } });
    }
    const changed = lifecycleChanged || restored || entry.observedVersion !== version;
    entry.observedGeneration = cacheGeneration;
    entry.admitted = admitted;
    entry.observedVersion = version;
    entry.observedTask = task;
    if (entry.mismatch !== null && task !== undefined && !isTaskStale(task, entry.mismatch, this.scope.getAuthorizedProject(projectId)?.summaries.get(taskId))) entry.mismatch = null;
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
  committedSnapshot = (projectId: string): ReadonlyMap<string, CommittedTaskProjection> => this.committedTasks.get(projectId) ?? emptyCommittedTasks;
  subscribeCommitted = (projectId: string, listener: () => void): (() => void) => {
    let listeners = this.committedListeners.get(projectId);
    if (listeners === undefined) { listeners = new Set(); this.committedListeners.set(projectId, listeners); }
    listeners.add(listener);
    return () => { listeners.delete(listener); if (listeners.size === 0) this.committedListeners.delete(projectId); };
  };
  private clearCommittedTasks(projectId: string): void {
    if (!this.committedTasks.delete(projectId)) return;
    for (const listener of this.committedListeners.get(projectId) ?? []) listener();
  }
  private publishCommittedTask(projectId: string, before: TaskDetail, detail: TaskDetail, fence: {
    readonly cacheGeneration: string | null; readonly scopeRevision: number; readonly historyGeneration: number;
  }, conflict = false): void {
    if (this.disposed || this.scope.isInvalidated || fence.cacheGeneration === null ||
      this.projectGeneration(projectId) !== fence.cacheGeneration || this.scope.getProjectRevision(projectId) !== fence.scopeRevision ||
      this.scope.getHistoryGeneration(projectId) !== fence.historyGeneration) return;
    const previous = this.committedTasks.get(projectId);
    if ((previous?.get(detail.id)?.detail.version ?? 0n) > detail.version) return;
    const next = new Map(previous);
    next.set(detail.id, { before, detail, cacheGeneration: fence.cacheGeneration, scopeRevision: fence.scopeRevision, historyGeneration: fence.historyGeneration, ...(conflict ? { conflict: true as const } : {}) });
    this.committedTasks.set(projectId, next);
    for (const listener of this.committedListeners.get(projectId) ?? []) listener();
  }
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
    const entry = this.entry(projectId, taskId);
    if (entry.source === "direct") {
      this.retireMutation(entry);
      this.cancelRead(projectId, taskId); entry.openingGeneration++; entry.receipt = null; entry.liveVersion = null;

      return;
    }
    if (!entry.state.mutation.reconciling) this.cancelRead(projectId, taskId);
  }
  private drainReads(projectId: string, taskId: string): void {
    const entry = this.entry(projectId, taskId);
    if (this.disposed || this.scope.isInvalidated || authRequestsPaused() || !entry.admitted || entry.read !== null || entry.state.mutation.phase === "pending") return;
    const queued = entry.queuedRead;
    if (queued === null) return;
    entry.queuedRead = null;
    if (queued.reconciliation) void this.read(projectId, taskId, queued.revision, true, true);
    else if (entry.listeners.size > 0) this.load(projectId, taskId, queued.revision, "automatic");
  }
  load(projectId: string, taskId: string, revision: number, mode: "open" | "refresh" | "automatic" = "refresh"): void {
    const entry = this.entry(projectId, taskId);
    if (authRequestsPaused()) return;
    if (mode === "refresh" && entry.source === "direct" && entry.directAccessPending) {
      this.scope.retryProjectVerification(projectId);
      return;
    }
    if (mode === "refresh") {
      for (const [operation, retired] of this.retiredMutations) if (retired.projectId === projectId && retired.taskId === taskId && retired.phase !== "pending" && !retired.reconciling) this.finishRetiredMutation(operation, retired.phase === "confirmed", retired.error);
    }
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
    if (authRequestsPaused()) return;
    const entry = this.entry(projectId, taskId);
    if (!entry.admitted || entry.state.status === "deleted" || entry.state.mutation.phase === "pending" || entry.state.mutation.reconciling) return;
    void this.read(projectId, taskId, entry.state.revision, entry.state.mutation.operation !== null, true);
  }
  private markDeleted(projectId: string, taskId: string, cacheGeneration: string, error: ApiError | null, phase: "confirmed" | "reconciled" = "confirmed"): void {
    if (this.scope.isInvalidated || this.scope.hasIdentityMismatch) return;
    const entry = this.entry(projectId, taskId);
    if (this.entryGeneration(entry) !== cacheGeneration) { this.refreshProject(projectId); return; }
    this.cancelRead(projectId, taskId);
    entry.deletedGeneration = cacheGeneration;
    entry.liveVersion = null; entry.pending = null; entry.queuedRead = null; entry.mismatch = null;
    const mutation = entry.state.mutation.operation?.action === "delete"
      ? { ...entry.state.mutation, phase, error: phase === "reconciled" ? entry.state.mutation.error : null, reconciling: false, reconciliationError: null }
      : phase === "reconciled" && entry.state.mutation.operation !== null
      ? { ...entry.state.mutation, phase: "reconciled" as const, ...(entry.state.mutation.phase === "unknown" ? { reconciledFrom: "unknown" as const } : {}), reconciling: false, reconciliationError: null }
      : { ...entry.state.mutation, reconciling: false, reconciliationError: null };
    const state: DetailState = { ...entry.state, detail: null, loadedRevision: null, status: "deleted", refreshing: false,
      requiresFreshRead: false, graphMismatch: false, error, mutation };
    if (this.disposed) entry.state = state;
    else this.publish(entry, state);
    this.refreshProject(projectId);
  }
  private failRead(entry: Entry, error: unknown, reconciliation: boolean): void {
    if (this.scope.hasIdentityMismatch) return;
    const missing = error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found";
    if (missing) entry.withdrawn = true;
    const detail = missing ? null : entry.state.detail;
    this.publish(entry, { ...entry.state, detail, loadedRevision: missing ? null : entry.state.loadedRevision, status: detail !== null ? "ready" : "error", refreshing: false,
      requiresFreshRead: reconciliation || entry.state.requiresFreshRead,
      error: reconciliation && detail !== null ? null : error,
      mutation: reconciliation ? { ...entry.state.mutation, reconciling: false, reconciliationError: error } : entry.state.mutation });
  }
  private async accept(projectId: string, taskId: string, detail: TaskDetail, ticket: SyncTicket, revision: number, reconciliation: boolean, signal: AbortSignal, generation: number | null = null, writeGeneration: number | null = null, readOpeningGeneration: number | null = null): Promise<void> {
    const entry = this.entry(projectId, taskId);
    const current = (): boolean => !signal.aborted && !this.disposed && !this.scope.isInvalidated && !this.scope.hasIdentityMismatch && entry.state.status !== "deleted" &&
      entry.admitted && ticket.scopeRevision === this.scope.getProjectRevision(projectId) && entry.observedGeneration === ticket.cacheGeneration && this.projectGeneration(projectId) === ticket.cacheGeneration &&
      (generation === null || generation === entry.generation);
    if (!current()) return;
    if (detail.projectId !== projectId || detail.id !== taskId) throw new ApiError("protocol");
    if (entry.committedVersion !== null && detail.version < entry.committedVersion) {
      throw new ApiError("protocol");
    }
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
    while (authRequestsPaused()) {
      try { await this.scope.ready(signal); }
      catch (error) { if (!isAbortError(error) || error instanceof TaskCacheLifecycleChanged && !error.retryable || signal.aborted || this.scope.isInvalidated) throw error; }
    }
    if (!current()) return;
    if (admitted.kind === "older") {
      this.publish(entry, { ...entry.state, refreshing: false, requiresFreshRead: true,
        mutation: reconciliation ? { ...entry.state.mutation, reconciling: false, reconciliationError: new ApiError("protocol") } : entry.state.mutation });
      return;
    }
    const summaryVersion = this.summaryVersion(projectId, taskId);
    // Another page may commit the summary before this page receives its cache hint.
    if (admitted.kind === "newer" || summaryVersion !== null && detail.version > summaryVersion) {
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
    entry.mismatch = isTaskStale(node, detail, this.scope.getAuthorizedProject(projectId)?.summaries.get(taskId)) ? detail : null;
    if (writeGeneration === null || writeGeneration === entry.generation) entry.liveVersion = detail.version;
    if (readOpeningGeneration !== null) entry.liveOpeningGeneration = readOpeningGeneration;
    entry.withdrawn = false;
    const currentMutation = entry.state.mutation;
    const receiptGeneration = currentMutation.operation === null ? undefined : this.receiptReadGenerations.get(currentMutation.operation);
    const published = currentMutation.phase === "confirmed" && currentMutation.publicationPending === true &&
      receiptGeneration !== undefined && generation !== null && generation > receiptGeneration && readOpeningGeneration === entry.openingGeneration &&
      (entry.committedVersion === null || detail.version >= entry.committedVersion) && entry.mismatch === null && storageError === null &&
      (entry.operationFence === null || this.scope.isTaskReadCurrent(entry.operationFence));
    const mutation = reconciliation
      ? { ...currentMutation, phase: currentMutation.phase === "unknown" ? "reconciled" as const : currentMutation.phase,
        ...(currentMutation.phase === "unknown" ? { reconciledFrom: "unknown" as const } : {}), reconciling: false, reconciliationError: null, ...(published ? { publicationPending: false } : {}) }
      : readOpeningGeneration !== null ? { ...currentMutation, reconciling: false, reconciliationError: null, ...(published ? { publicationPending: false } : {}) } : currentMutation;
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
    if (entry.source === "direct") return this.readDirect(entry, revision, reconciliation, retainLoaded, automatic);
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
      if (!retain && entry.admitted && !entry.withdrawn) {
        const cached = await readCachedDetail(this.scope, ticket, taskId, signal);
        const node = entry.observedTask;
        if (cached !== null && node !== undefined && cached.version === this.summaryVersion(projectId, taskId) && generation === entry.generation && !signal.aborted) {
          this.publish(entry, { ...entry.state, detail: materializeDetail(cached, node), status: "ready", refreshing: true, requiresFreshRead: true });
        }
      }
      const detail = await this.getParent(entry, ticket, signal);
      if (signal.aborted || generation !== entry.generation || this.disposed) return;
      if (openingGeneration === entry.openingGeneration && entry.admitted && !this.scope.hasIdentityMismatch &&
        entry.observedGeneration === ticket.cacheGeneration && this.projectGeneration(projectId) === ticket.cacheGeneration &&
        this.scope.canRevokeProject(ticket)) this.scope.markProjectReadable(projectId);
      await this.accept(projectId, taskId, detail, ticket, revision, reconciliation, signal, generation, null, openingGeneration);
    } catch (error) {
      if (signal.aborted || generation !== entry.generation || this.disposed || this.scope.hasIdentityMismatch || !retain && !reconciliation && isAbortError(error)) return;
      if (ticket !== null && error instanceof ApiError && error.kind === "server" && error.status === 410 && error.code === "task_deleted") {
        this.markDeleted(projectId, taskId, ticket.cacheGeneration, error, reconciliation ? "reconciled" : "confirmed");
        this.scope.fenceTaskHistory(projectId, ticket.epoch);
        return;
      }
      const denied = knownTask && ticket !== null && error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found";
      if (denied) {

        this.failRead(entry, error, reconciliation);
        this.scope.reportTaskNotFound(projectId);
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
  private async readDirect(entry: Entry, revision: number, reconciliation: boolean, retainLoaded: boolean, automatic: boolean): Promise<void> {
    const { projectId, taskId } = entry;
    const operationTaskEpoch = entry.state.mutation.operation === null ? null : entry.operationTaskEpoch;
    const observedEpoch = entry.receipt?.epoch ?? operationTaskEpoch ?? undefined;
    this.cancelRead(projectId, taskId);
    const controller = new AbortController(); entry.read = controller;
    const signal = AbortSignal.any([controller.signal, this.scope.signal]);
    const generation = entry.generation; const opening = entry.openingGeneration;
    const retain = entry.state.detail !== null && (retainLoaded || entry.state.mutation.phase !== "idle");
    this.publish(entry, { ...entry.state, revision, detail: retain ? entry.state.detail : null,
      status: retain ? "ready" : "loading", refreshing: retain, requiresFreshRead: !automatic || entry.state.requiresFreshRead,
      error: automatic ? entry.state.error : null,
      mutation: reconciliation ? { ...entry.state.mutation, reconciling: true, reconciliationError: null } : entry.state.mutation });
    let fence: TaskReadFence | null = null;
    try {
      fence = await this.scope.beginTaskRead(projectId, taskId, opening, generation, signal);
      const observation = await getTaskObservation(projectId, taskId, signal,
        { userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch });
      await this.scope.ready(signal);
      if (signal.aborted || this.disposed || generation !== entry.generation || opening !== entry.openingGeneration || !this.scope.isTaskReadCurrent(fence)) return;
      if (await this.scope.observeHistory(fence, observation.epoch, signal) !== "current") return;
      if (signal.aborted || generation !== entry.generation || opening !== entry.openingGeneration || !this.scope.isTaskReadCurrent(fence)) return;
      const floor = this.taskVersionFloor(entry);
      if (floor !== null && observation.detail.version < floor) {
        throw new ApiError("protocol");
      }
      entry.receipt = { fence, ...observation }; entry.liveVersion = observation.detail.version; entry.liveOpeningGeneration = opening;
      this.scope.markProjectReadable(projectId);
      this.scope.notifyTagColors(projectId);
      entry.historyRetry = false; entry.historyHintRetry = false; entry.withdrawn = false; entry.directParentReadFailed = false;
      const currentMutation = entry.state.mutation;
      const receiptGeneration = currentMutation.operation === null ? undefined : this.receiptReadGenerations.get(currentMutation.operation);
      const published = currentMutation.phase === "confirmed" && currentMutation.publicationPending === true &&
        receiptGeneration !== undefined && generation > receiptGeneration && (entry.committedVersion === null || observation.detail.version >= entry.committedVersion) &&
        entry.operationFence !== null && this.scope.isTaskReadCurrent(entry.operationFence);
      const mutation = reconciliation
        ? { ...currentMutation, phase: currentMutation.phase === "unknown" ? "reconciled" as const : currentMutation.phase,
          ...(currentMutation.phase === "unknown" ? { reconciledFrom: "unknown" as const } : {}), reconciling: false, reconciliationError: null, ...(published ? { publicationPending: false } : {}) }
        : { ...currentMutation, reconciling: false, reconciliationError: null, ...(published ? { publicationPending: false } : {}) };
      this.publish(entry, { ...entry.state, revision, loadedRevision: revision, detail: preserveCollection(entry.state.detail, observation.detail),
        status: "ready", refreshing: false, requiresFreshRead: false, graphMismatch: false, error: null, mutation });
      for (const [operation, retired] of this.retiredMutations) {
        if (retired.projectId === projectId && retired.taskId === taskId && retired.phase !== "pending" && !retired.reconciling) this.finishRetiredMutation(operation, retired.phase === "confirmed", retired.error, retired.committedVersion);
      }
    } catch (error) {
      if (signal.aborted || this.disposed || generation !== entry.generation || opening !== entry.openingGeneration) return;
      if (isRetryableTaskCacheLifecycleChange(error) && fence !== null && this.scope.isTaskReadCurrent(fence, true)) {
        if (!entry.historyRetry) {
          entry.historyRetry = true;
          queueMicrotask(() => { if (!this.disposed && entry.listeners.size > 0) void this.read(projectId, taskId, revision, reconciliation, retainLoaded); });
        } else { entry.directParentReadFailed = true; this.failRead(entry, new ApiError("protocol"), reconciliation); }
        return;
      }
      if (isAbortError(error)) return;
      const negative = error instanceof ApiError && error.kind === "server" && (error.status === 404 && error.code === "not_found" || error.status === 410 && error.code === "task_deleted");
      if (!negative) { try { await this.scope.ready(signal); } catch { return; } }
      if (signal.aborted || this.disposed || generation !== entry.generation || opening !== entry.openingGeneration) return;
      if (fence !== null && !this.scope.isTaskReadCurrent(fence, negative)) return;
      if (error instanceof ApiError && error.kind === "server" && error.status === 410 && error.code === "task_deleted") {
        this.markDeleted(projectId, taskId, this.entryGeneration(entry)!, error, reconciliation ? "reconciled" : "confirmed");
        this.scope.fenceTaskHistory(projectId, observedEpoch ?? null);
        return;
      }
      if (error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found") {
        entry.receipt = null; entry.liveVersion = null;

        this.scope.reportTaskNotFound(projectId);
      }
      entry.directParentReadFailed = true;
      this.failRead(entry, error, reconciliation);
    } finally {
      if (generation === entry.generation) { entry.read = null; this.drainReads(projectId, taskId); }
    }
  }
  private writableState(projectId: string, taskId: string): DetailState {
    const entry = this.entry(projectId, taskId);
    return { ...entry.state, requiresFreshRead: this.scope.isInvalidated || (entry.source === "direct" ? this.directRequiresFreshRead(projectId, taskId) : this.requiresFreshRead(projectId, taskId, entry.observedTask)) };
  }
  setStatus(projectId: string, taskId: string, status: TaskStatus, version: bigint, cancelDescendants?: true): void {
    const state = this.writableState(projectId, taskId);
    if (!canSetStatus(state) || state.detail!.version !== version || !["proposed", "todo", "in_progress", "done", "cancelled"].includes(status) || state.detail!.type === "goal" && status === "proposed" || status === "cancelled" && readWorkerClaim(state.detail!.properties)?.state === "active") return;
    if (cancelDescendants !== undefined && (cancelDescendants !== true || status !== "cancelled" || state.detail!.type !== "task")) return;
    this.performMutation(projectId, taskId, { action: "status", status, version, ...(cancelDescendants === undefined ? {} : { cancelDescendants }) });
  }
  setParent(projectId: string, taskId: string, parentId: string | null, version: bigint): void {
    const state = this.writableState(projectId, taskId);
    if (!canSetParent(state) || state.detail!.version !== version) return;
    this.performMutation(projectId, taskId, { action: "parent", parentId: parentId === null ? null : requestId(parentId), version });
  }
  editGoal(projectId: string, taskId: string, title: string, description: string, version: bigint): void {
    const state = this.writableState(projectId, taskId);
    if (!canEditGoal(state) || state.detail!.version !== version) return;
    this.performMutation(projectId, taskId, { action: "editGoal", title, description, version });
  }
  setTags(projectId: string, taskId: string, tagIds: readonly string[], version: bigint): void {
    const state = this.writableState(projectId, taskId);
    if (!canSetTags(state) || state.detail!.version !== version) return;
    const canonicalIds = [...new Set(tagIds.map(requestId))].sort();
    this.performMutation(projectId, taskId, { action: "tags", tagIds: canonicalIds, version });
  }
  setAgentPermission(projectId: string, taskId: string, allowAgents: boolean, version: bigint): void {
    const state = this.writableState(projectId, taskId);
    if (!canSetAgentPermission(state) || state.detail!.version !== version || state.detail!.allowAgents === allowAgents) return;
    this.performMutation(projectId, taskId, { action: "allowAgents", allowAgents, version });
  }
  unpause(projectId: string, taskId: string, version: bigint): void {
    const state = this.writableState(projectId, taskId);
    if (!canUnpause(state) || state.detail!.version !== version) return;
    this.performMutation(projectId, taskId, { action: "unpause", version });
  }
  setRequiredPlatform(projectId: string, taskId: string, requiredPlatform: ExecutionPlatform | null, version: bigint): void {
    const state = this.writableState(projectId, taskId);
    if (!canSetRequiredPlatform(state) || state.detail!.version !== version || state.detail!.requiredPlatform === requiredPlatform) return;
    this.performMutation(projectId, taskId, { action: "requiredPlatform", requiredPlatform, version });
  }
  setAssignedTo(projectId: string, taskId: string, assignedTo: string | null, version: bigint): void {
    const state = this.writableState(projectId, taskId);
    if (!canSetAssignedTo(state) || state.detail!.version !== version) return;
    const target = assignedTo === null ? null : requestId(assignedTo);
    this.performMutation(projectId, taskId, { action: "assignedTo", assignedTo: target, version });
  }
  withdrawClaim(projectId: string, taskId: string, claimId: string, version: bigint): void {
    const state = this.writableState(projectId, taskId);
    if (!canWithdrawClaim(state) || state.detail!.version !== version || readWorkerClaim(state.detail!.properties)!.claimId !== claimId) return;
    this.performMutation(projectId, taskId, { action: "withdraw", claimId, version });
  }
  deleteTask(projectId: string, taskId: string, version: bigint, removeDepends: boolean): void {
    const state = this.writableState(projectId, taskId);
    if (!canDeleteTask(state) || state.detail!.version !== version) return;
    this.performMutation(projectId, taskId, { action: "delete", version, removeDepends });
  }
  private retireMutation(entry: Entry, includeSummary = false): void {
    if (entry.source !== "direct" && !includeSummary) return;
    const mutation = entry.state.mutation;
    if (mutation.operation === null || mutation.phase !== "pending" && mutation.phase !== "unknown" && mutation.phase !== "conflict" && !(mutation.phase === "confirmed" && entry.state.requiresFreshRead)) return;
    if (!this.retiredMutations.has(mutation.operation)) this.retiredMutations.set(mutation.operation, { projectId: entry.projectId, taskId: entry.taskId,
      fence: entry.operationFence, taskEpoch: entry.operationTaskEpoch,
      phase: mutation.phase, error: mutation.error, reconciling: false, committedVersion: entry.committedVersion, historyRetries: 0, historyConfirmRetries: 0 });
    // The retired owner now exclusively tracks this operation, including when
    // it settles while no view is subscribed and the entry is later reopened.
    entry.state = { ...entry.state, mutation: idleMutation() };
    entry.operationFence = null;
    entry.operationTaskEpoch = null;
    if (mutation.phase !== "pending" && !authRequestsPaused()) this.finishRetiredMutation(mutation.operation, mutation.phase === "confirmed", mutation.error);
  }
  private finishRetiredMutation(operation: TaskMutationOperation, confirmed: boolean, error: unknown, committedVersion: bigint | null = null): void {
    const retired = this.retiredMutations.get(operation);
    if (retired === undefined || retired.reconciling) return;
    retired.phase = confirmed ? "confirmed" : error instanceof ApiError && error.kind === "server" && error.status !== null && error.status >= 400 && error.status < 500
      ? error.code === "version_conflict" ? "conflict" : "refused" : "unknown";
    retired.error = error;
    if (confirmed && committedVersion !== null) retired.committedVersion = committedVersion;
    if (this.scope.hasIdentityMismatch) return;
    if (error instanceof ApiError && error.kind === "server" && error.status === 410 && error.code === "task_deleted" &&
      retired.fence !== null && this.scope.isTaskReadCurrent(retired.fence, true)) {
      this.scope.fenceTaskHistory(retired.projectId, retired.taskEpoch);
    }
    if (error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found") {
      if (retired.fence === null || !this.scope.isTaskHistoryPossiblyCurrent(retired.fence)) { this.retiredMutations.delete(operation); return; }
      if (!this.scope.isTaskReadCurrent(retired.fence, true)) {
        retired.reconciling = true;
        void this.verifyRetiredTask(operation, retired);
        return;
      }
      const current = this.entries.get(`${retired.projectId}/${retired.taskId}`);
      if (!this.disposed && current !== undefined) {
        current.receipt = null; current.liveVersion = null; current.withdrawn = true;
        this.publish(current, { ...current.state, detail: null, loadedRevision: null, status: "error", refreshing: false, requiresFreshRead: true, error });
      }
      retired.reconciling = true;
      void this.scope.revalidateProjectAccess(retired.projectId).then(() => {
        this.retiredMutations.delete(operation); this.notifyRetiredSettlement(retired, true);
      }).catch(() => { retired.reconciling = false; });
      return;
    }
    if (retired.phase === "refused") { this.retiredMutations.delete(operation); this.notifyRetiredSettlement(retired, false); return; }
    retired.reconciling = true;
    // A retired owner reconciles independently and cannot publish into a later opening.
    void (async () => {
      let observedFence: TaskReadFence | null = null;
      try {
        const signal = this.scope.signal;
        const admission = { userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch };
        for (let attempt = 0; ; attempt++) {
          const fence = await this.scope.beginTaskRead(retired.projectId, retired.taskId, -1, -1, signal);
          observedFence = fence;
          const observation = await getTaskObservation(retired.projectId, retired.taskId, signal, admission);
          const history = await this.scope.observeHistory(fence, observation.epoch, signal);
          if (history !== "current") {
            retired.reconciling = false;
            const retry = history === "confirm" ? retired.historyConfirmRetries++ === 0 : retired.historyRetries++ === 0;
            if (retry) this.finishRetiredMutation(operation, confirmed, error, committedVersion);
            else retired.error = new ApiError("protocol");
            return;
          }
          const belowFloor = retired.fence !== null && this.scope.isTaskHistoryPossiblyCurrent(retired.fence) && retired.committedVersion !== null && observation.detail.version < retired.committedVersion;
          if (!belowFloor) break;
          if (attempt === 1) throw new ApiError("protocol");
        }
        this.retiredMutations.delete(operation);
        this.notifyRetiredSettlement(retired, true);
      } catch (failure) {
        if (failure instanceof ApiError && failure.kind === "server" && (failure.status === 404 || failure.status === 410)) {
          if (failure.status === 410 && failure.code === "task_deleted" && observedFence !== null && this.scope.isTaskReadCurrent(observedFence, true)) {
            this.scope.fenceTaskHistory(retired.projectId, retired.taskEpoch);
          }
          this.retiredMutations.delete(operation); this.notifyRetiredSettlement(retired, true);
        } else { retired.error = failure; retired.reconciling = false; }
      }
    })();
  }
  private async verifyRetiredTask(operation: TaskMutationOperation, retired: NonNullable<ReturnType<typeof this.retiredMutations.get>>): Promise<void> {
    const { projectId, taskId } = retired;
    const oldCurrent = (): boolean => retired.fence !== null && this.scope.isTaskHistoryPossiblyCurrent(retired.fence);
    const releaseOld = (): void => { this.retiredMutations.delete(operation); };
    try {
      if (!oldCurrent()) { releaseOld(); return; }
      const signal = this.scope.signal;
      const fence = await this.scope.beginTaskRead(projectId, taskId, -1, -1, signal);
      if (!oldCurrent()) { releaseOld(); return; }
      if (!await this.scope.verifyTaskRead(fence, signal)) { if (!oldCurrent()) releaseOld(); else retired.reconciling = false; return; }
      const owner = this.entries.get(`${projectId}/${taskId}`);
      const opening = owner?.openingGeneration;
      const generation = owner?.generation;
      let observation: Awaited<ReturnType<typeof getTaskObservation>>;
      try {
        observation = await getTaskObservation(projectId, taskId, signal, { userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch });
      } catch (failure) {
        const negative = failure instanceof ApiError && failure.kind === "server" &&
          (failure.status === 404 && failure.code === "not_found" || failure.status === 410 && failure.code === "task_deleted");
        if (!negative) {
          if (oldCurrent() && this.scope.isTaskReadCurrent(fence, true) && owner !== undefined && owner === this.entries.get(`${projectId}/${taskId}`) &&
            owner.openingGeneration === opening && owner.generation === generation && !this.disposed) {
            owner.directParentReadFailed = true;
            this.publish(owner, { ...owner.state });
          }
          throw failure;
        }
        if (!oldCurrent()) { releaseOld(); return; }
        if (!this.scope.isTaskReadCurrent(fence, true)) { if (!oldCurrent()) releaseOld(); else retired.reconciling = false; return; }
        // A later opening or read owns its own result, so retry rather than apply this receipt to it.
        if (owner !== this.entries.get(`${projectId}/${taskId}`) || owner?.openingGeneration !== opening || owner?.generation !== generation) {
          retired.reconciling = false; return;
        }
        if (owner !== undefined && !this.disposed) {
          if (failure.status === 410) this.markDeleted(projectId, taskId, this.entryGeneration(owner)!, failure);
          else {
            this.cancelRead(projectId, taskId);
            owner.receipt = null; owner.liveVersion = null; owner.withdrawn = true;
            this.publish(owner, { ...owner.state, detail: null, loadedRevision: null, status: "error", refreshing: false, requiresFreshRead: true, error: failure });
          }
        }
        if (failure.status === 404) await this.scope.revalidateProjectAccess(projectId);
        releaseOld();
        if (failure.status === 404) this.notifyRetiredSettlement(retired, true);
        return;
      }
      const history = await this.scope.observeHistory(fence, observation.epoch, signal);
      if (history !== "current") {
        if (!oldCurrent()) releaseOld();
        else if (history === "confirm" && retired.historyConfirmRetries++ === 0) void this.verifyRetiredTask(operation, retired);
        else retired.reconciling = false;
        return;
      }
      if (!oldCurrent()) { releaseOld(); return; }
      releaseOld(); this.notifyRetiredSettlement(retired, true);
    } catch {
      // Keep the original refusal and its lock so an explicit refresh can retry verification.
      retired.reconciling = false;
    }
  }
  private notifyRetiredSettlement(retired: { readonly projectId: string; readonly taskId: string; readonly fence: TaskReadFence | null }, refresh: boolean): void {
    if (this.disposed || this.scope.isInvalidated || retired.fence === null || !this.scope.isTaskHistoryConfirmedCurrent(retired.fence)) return;
    const entry = this.entries.get(`${retired.projectId}/${retired.taskId}`);
    if (entry === undefined || !entry.admitted || entry.listeners.size === 0) return;
    if (refresh) void this.read(retired.projectId, retired.taskId, entry.state.revision, false, true);
    else this.publish(entry, { ...entry.state });
  }
  private async runMutationStage<T>(projectId: string, taskId: string, operation: TaskMutationOperation, signal: AbortSignal, work: () => T | Promise<T>, retryPreparation?: () => boolean): Promise<{ readonly value: T } | null> {
    const entry = this.entry(projectId, taskId);
    while (!this.scope.isInvalidated && (entry.state.mutation.operation === operation || this.retiredMutations.has(operation))) {
      signal.throwIfAborted();
      try { await abortableMutation(signal, this.scope.ready(signal)); }
      catch (error) {
        if (this.scope.isInvalidated) return null;
        signal.throwIfAborted();
        if (authRequestsPaused() && !(error instanceof TaskCacheLifecycleChanged && !error.retryable)) continue;
        throw error;
      }
      signal.throwIfAborted();
      if (authRequestsPaused()) continue;
      if (this.scope.isInvalidated || entry.state.mutation.operation !== operation && !this.retiredMutations.has(operation)) return null;
      // Admission and its synchronous effects share the same unpaused turn.
      try { const value = await abortableMutation(signal, Promise.resolve(work())); signal.throwIfAborted(); return { value }; }
      catch (error) {
        signal.throwIfAborted();
        // A pause during asynchronous admission is not a rejection of the review.
        // Once dispatch starts, however, an operation must never be replayed.
        if (retryPreparation?.() && authRequestsPaused() && !this.scope.isInvalidated &&
          (isAbortError(error) && (!(error instanceof TaskCacheLifecycleChanged) || error.retryable) || error instanceof TaskMutationReviewExpired)) continue;
        throw error;
      }
    }
    return null;
  }
  private mutationIsCurrent(_projectId: string, entry: Entry, operation: TaskMutationOperation, ticket: ReadTicket): boolean {
    return !this.scope.isInvalidated && entry.state.mutation.operation === operation && this.ticketCurrent(entry, ticket);
  }
  private admitMutationOutcome(projectId: string, taskId: string, operation: TaskMutationOperation, ticket: ReadTicket | null, error: unknown = null, confirmed = false, committedVersion: bigint | null = null): boolean {
    const entry = this.entry(projectId, taskId);
    if (this.retiredMutations.has(operation)) { this.finishRetiredMutation(operation, confirmed, error, committedVersion); return false; }
    if (this.scope.isInvalidated || entry.state.mutation.operation !== operation) return false;
    if (ticket === null || this.mutationIsCurrent(projectId, entry, operation, ticket)) return true;
    if ("historyGeneration" in ticket) return false;
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
      if (!gone && entry.admitted && this.projectGeneration(projectId) !== null) {
        void this.read(projectId, taskId, entry.state.revision, true, true);
      }
    }
    return false;
  }
  private hasNewerObservation(entry: Entry, epoch: string, version: bigint): boolean {
    const { projectId, taskId } = entry;
    const project = this.scope.getAuthorizedProject(projectId);
    if (project?.manifest.epoch === epoch && (project.versions.get(taskId) ?? version) > version) return true;
    const receipt = entry.receipt;
    const currentDirect = receipt !== null && receipt.epoch === epoch && this.ticketCurrent(entry, receipt.fence);
    const currentSummary = entry.source === "project-summary" && entry.admitted && project?.manifest.epoch === epoch &&
      entry.observedGeneration === project.manifest.cacheGeneration;
    if (!currentDirect && !currentSummary) return false;
    if (currentDirect && receipt.detail.version > version || entry.committedVersion !== null && entry.committedVersion > version) return true;
    const pending = entry.pending;
    return currentSummary && pending !== null && pending.readOpeningGeneration === entry.openingGeneration &&
      (pending.generation === null || pending.generation === entry.generation) && pending.ticket.cacheGeneration === project.manifest.cacheGeneration &&
      pending.ticket.scopeRevision === this.scope.getProjectRevision(projectId) && pending.detail.version > version;
  }
  private assertMutationReview(projectId: string, taskId: string, operation: TaskMutationOperation, review: TaskMutationReview, ticket: ReadTicket): void {
    const entry = this.entry(projectId, taskId);
    if ("historyGeneration" in ticket) {
      const retired = this.retiredMutations.get(operation);
      if (retired !== undefined) {
        if (this.scope.isInvalidated || retired.fence !== ticket || review.receipt === null || review.receipt.fence !== ticket ||
          review.detail.version !== operation.version || review.receipt.detail.version !== operation.version ||
          !this.scope.isTaskReadCurrent(ticket)) throw new TaskMutationReviewExpired();
        // A newer opening may only invalidate this review; it cannot grant it.
        if (this.hasNewerObservation(entry, review.receipt.epoch, operation.version)) throw new TaskMutationReviewExpired();
        return;
      }
      if (this.scope.isInvalidated || entry.state.mutation.operation !== operation || entry.receipt !== review.receipt ||
        review.receipt === null || review.receipt.fence !== ticket || !this.ticketCurrent(entry, ticket) ||
        entry.state.detail !== review.detail || this.observedParentVersion(entry) !== operation.version) throw new TaskMutationReviewExpired();
      return;
    }
    const project = this.scope.getAuthorizedProject(projectId);
    const retired = this.retiredMutations.get(operation);
    if (this.scope.isInvalidated || (retired === undefined
      ? entry.state.mutation.operation !== operation || !entry.admitted || entry.observedGeneration !== review.cacheGeneration
      : retired.fence === null || !this.scope.isTaskReadCurrent(retired.fence)) || ticket.cacheGeneration !== review.cacheGeneration ||
      ticket.scopeRevision !== review.scopeRevision || this.scope.getProjectRevision(projectId) !== review.scopeRevision ||
      project?.manifest.cacheGeneration !== review.cacheGeneration || this.summaryVersion(projectId, taskId) !== operation.version ||
      isTaskStale(project.index.nodes.get(taskId), review.detail, project.summaries.get(taskId))) throw new TaskMutationReviewExpired();
    // A later direct observation can invalidate, but never authorize, the original summary review.
    if (retired !== undefined && project.manifest.epoch !== null && this.hasNewerObservation(entry, project.manifest.epoch, operation.version)) throw new TaskMutationReviewExpired();
  }
  private expireMutationReview(projectId: string, taskId: string, operation: TaskMutationOperation): void {
    const entry = this.entry(projectId, taskId);
    const retired = this.retiredMutations.get(operation);
    if (retired !== undefined) { this.retiredMutations.delete(operation); this.notifyRetiredSettlement(retired, true); return; }
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
      if (!gone && entry.admitted && this.projectGeneration(projectId) !== null) {
        void this.read(projectId, taskId, entry.state.revision, true, true);
      }
    }
  }
  private failDirectFence(entry: Entry, operation: TaskMutationOperation, error: unknown, submitted: boolean, confirmed: boolean, committedVersion: bigint | null): void {
    if (this.scope.isInvalidated || entry.state.mutation.operation !== operation) return;
    if (confirmed && committedVersion !== null) entry.committedVersion = committedVersion;
    entry.receipt = null; entry.liveVersion = null;
    const phase = confirmed ? "confirmed" : submitted ? "unknown" : "refused";
    this.publish(entry, { ...entry.state, detail: null, loadedRevision: null, status: "error", refreshing: false, requiresFreshRead: true, error,
      mutation: { operation, phase, error: confirmed ? null : error, reconciling: false, reconciliationError: confirmed || submitted ? error : null } });
  }
  // Local settlement does not acquire remote admission or change retained content.
  private settlePausedMutation(projectId: string, taskId: string, operation: TaskMutationOperation, outcome: { dispatched: boolean; confirmed: boolean; committedVersion: bigint | null; error: unknown; publicationPending: boolean }): void {
    const knownRejection = outcome.error instanceof ApiError && outcome.error.kind === "server" && outcome.error.status !== null && outcome.error.status >= 400 && outcome.error.status < 500;
    const phase = outcome.confirmed ? "confirmed" : knownRejection ? (outcome.error as ApiError).code === "version_conflict" ? "conflict" : "refused" : outcome.dispatched ? "unknown" : "refused";
    const retired = this.retiredMutations.get(operation);
    if (retired !== undefined) {
      retired.phase = phase; retired.error = outcome.confirmed ? null : outcome.error; retired.reconciling = false;
      if (outcome.committedVersion !== null) retired.committedVersion = outcome.committedVersion;
      return;
    }
    const entry = this.entries.get(`${projectId}/${taskId}`);
    if (entry === undefined || entry.state.mutation.operation !== operation) return;
    if (outcome.committedVersion !== null) entry.committedVersion = outcome.committedVersion;
    const state: DetailState = { ...entry.state, refreshing: false, requiresFreshRead: outcome.dispatched || entry.state.requiresFreshRead,
      mutation: { operation, phase, error: outcome.confirmed ? null : outcome.error, reconciling: false, reconciliationError: null, publicationPending: outcome.publicationPending } };
    if (this.disposed) entry.state = state; else this.publish(entry, state);
  }
  // The account owner invokes this only for the permanent account-refresh transition.
  suspendForAccountRefresh(): void {
    for (const owner of this.mutationControllers.values()) { owner.controller.abort(); owner.settle?.(); }
  }
  private performMutation(projectId: string, taskId: string, operation: TaskMutationOperation): void {
    const entry = this.entry(projectId, taskId);
    const previous = entry.state.detail!;
    const reviewedGeneration = this.entryGeneration(entry);
    if (reviewedGeneration === null) return;
    const review: TaskMutationReview = { detail: previous, cacheGeneration: reviewedGeneration, scopeRevision: this.scope.getProjectRevision(projectId), receipt: entry.receipt };
    const projectFence = { cacheGeneration: this.projectGeneration(projectId), scopeRevision: this.scope.getProjectRevision(projectId), historyGeneration: this.scope.getHistoryGeneration(projectId) };
    entry.operationFence = entry.receipt?.fence ?? this.scope.captureTaskHistoryFence(projectId, taskId, entry.openingGeneration, entry.generation);
    entry.operationTaskEpoch = entry.receipt?.epoch ?? null;
    this.cancelRead(projectId, taskId);
    const operationGeneration = entry.generation;
    const key = `${projectId}/${taskId}`;
    this.mutationControllers.get(key)?.controller.abort();
    const controller = new AbortController();
    this.mutationControllers.set(key, { operation, controller });
    const signal = AbortSignal.any([controller.signal, this.scope.signal, this.scope.mismatchSignal]);
    this.publish(entry, { ...entry.state, refreshing: false, error: null, mutation: { operation, phase: "pending", error: null, reconciling: false, reconciliationError: null } });
    // Submitted writes outlive their dialog, while identity retirement still fences their result.
    void (async () => {
      let submitted = false;
      let dispatched = false;
      let confirmed = false;
      let actualVersion: bigint | null = null;
      let outcomeKnown = false;
      let outcomeError: unknown = null;
      const owner = this.mutationControllers.get(key)!;
      owner.settle = () => {
        if (authRequestsPaused()) this.settlePausedMutation(projectId, taskId, operation, { dispatched, confirmed, committedVersion: actualVersion, error: outcomeKnown ? outcomeError : signal.reason, publicationPending: true });
      };
      owner.dispose = () => { if (!submitted || authRequestsPaused() || confirmed || outcomeKnown) controller.abort(); };
      const releasePause = subscribeAuthPause(() => {
        if (confirmed || outcomeKnown) this.settlePausedMutation(projectId, taskId, operation, { dispatched, confirmed, committedVersion: actualVersion, error: outcomeError, publicationPending: true });
      });
      let validated = false;
      const changed = operation.action === "status" ? previous.status !== operation.status
        : operation.action === "assignedTo" ? previous.assignedTo !== operation.assignedTo
        : operation.action === "parent" ? previous.parentId !== operation.parentId
        : operation.action === "editGoal" ? previous.title !== operation.title || previous.description !== operation.description
        : operation.action === "tags" ? !sameIds(previous.tags.map(tag => tag.id), operation.tagIds) : true;
      const committedVersion = operation.version + (changed ? 1n : 0n);
      let ticket: ReadTicket | null = null;
      // Verification can retire the owner while a known write outcome is in flight.
      const settleRetired = (error: unknown): boolean => {
        if (!this.retiredMutations.has(operation)) return false;
        if (!submitted) this.expireMutationReview(projectId, taskId, operation);
        else this.finishRetiredMutation(operation, confirmed, error, actualVersion);
        return true;
      };
      const runOutcome = async (outcomeTicket: ReadTicket | null, error: unknown, work: () => void | Promise<void>, before?: () => boolean, verify = true, onRetired?: () => Promise<void>): Promise<void> => {
        // Preserve the local result while publication waits for identity admission.
        outcomeKnown = true; outcomeError = error;
        if (authRequestsPaused()) this.settlePausedMutation(projectId, taskId, operation, { dispatched, confirmed, committedVersion: actualVersion, error, publicationPending: true });
        // Verify and admit in the same turn; retry only the read-only part.
        for (;;) {
          let admissionPauseRevision = authRequestsPauseRevision();
          let admitted = false;
          try {
            await this.runMutationStage(projectId, taskId, operation, signal, async () => {
              if (this.retiredMutations.has(operation)) {
                if (authRequestsPaused()) throw new TaskCacheLifecycleChanged();
                await onRetired?.(); signal.throwIfAborted();
                if (authRequestsPaused()) throw new TaskCacheLifecycleChanged();
                settleRetired(error); return;
              }
              if (before?.() === false) return;
              if (verify && outcomeTicket !== null && "historyGeneration" in outcomeTicket) {
                admissionPauseRevision = authRequestsPauseRevision();
                const current = await this.scope.verifyTaskRead(outcomeTicket, signal);
                signal.throwIfAborted();
                if (authRequestsPaused()) throw new TaskCacheLifecycleChanged();
                if (this.retiredMutations.has(operation)) {
                if (authRequestsPaused()) throw new TaskCacheLifecycleChanged();
                await onRetired?.(); signal.throwIfAborted();
                if (authRequestsPaused()) throw new TaskCacheLifecycleChanged();
                settleRetired(error); return;
              }
                if ((authRequestsPaused() || admissionPauseRevision !== authRequestsPauseRevision()) && this.scope.isTaskReadCurrent(outcomeTicket, true)) throw new TaskCacheLifecycleChanged();
                if (!current) return;
              }
              if (!this.admitMutationOutcome(projectId, taskId, operation, outcomeTicket, error, confirmed, actualVersion)) return;
              admitted = true;
              await work();
            }, () => !admitted);
            return;
          } catch (failure) {
            signal.throwIfAborted();
            if (!authRequestsPaused() && settleRetired(error)) return;
            // A pause can also end before the rejected transaction is observed.
            if (!admitted && isRetryableTaskCacheLifecycleChange(failure) && admissionPauseRevision !== authRequestsPauseRevision() &&
              (outcomeTicket === null || !("historyGeneration" in outcomeTicket) || this.scope.isTaskReadCurrent(outcomeTicket, true))) {
              continue;
            }
            throw failure;
          }
        }
      };
      try {
        if (review.receipt !== null) ticket = review.receipt.fence;
        else {
          const acquired = await this.runMutationStage(projectId, taskId, operation, signal, () => this.scope.beginSync(projectId, signal), () => !submitted);
          if (acquired === null) return;
          ticket = acquired.value;
        }
        const requestTicket = ticket;
        const prepared = await this.runMutationStage(projectId, taskId, operation, signal, () => {
          this.assertMutationReview(projectId, taskId, operation, review, requestTicket);
          if ("historyGeneration" in requestTicket) return this.scope.verifyTaskRead(requestTicket, signal).then((current) => { if (!current) throw new TaskMutationReviewExpired(); });
          return this.scope.detailTransaction(requestTicket, signal, async (_store, _manifest, summaries) => summaries.get(taskId)?.version === operation.version)
            .then((current) => { if (!current) throw new TaskMutationReviewExpired(); });
        }, () => !submitted);
        if (prepared === null) return;
        const verifySendReview = async () => {
          if ("historyGeneration" in requestTicket) {
            if (!await this.scope.verifyTaskRead(requestTicket, signal)) throw new TaskMutationReviewExpired();
          } else {
            const current = await this.scope.detailTransaction(requestTicket, signal, async (_store, _manifest, summaries) => summaries.get(taskId)?.version === operation.version);
            if (!current) throw new TaskMutationReviewExpired();
          }
        };
        let deletionReceiptPublished = false;
        const publishDeletionReceipt = () => {
          if (this.scope.hasIdentityMismatch || deletionReceiptPublished || operation.action !== "delete") return;
          if (!this.mutationIsCurrent(projectId, entry, operation, requestTicket)) return;
          deletionReceiptPublished = true;
          const generation = this.entryGeneration(entry);
          if (generation !== null && entry.state.mutation.operation === operation) this.markDeleted(projectId, taskId, generation, null);
          const reviewedEpoch = "historyGeneration" in requestTicket ? review.receipt?.epoch : requestTicket.epoch;
          this.scope.retireTaskHistory(projectId, reviewedEpoch ?? null);
        };
        const admission = { userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch,
          onDispatch: () => { dispatched = true; },
          onWriteRejected: (error: ApiError) => { outcomeKnown = true; outcomeError = error; },
          onWriteConfirmed: () => {
            confirmed = true;
            this.receiptReadGenerations.set(operation, entry.generation);
            if (!this.scope.hasIdentityMismatch && !authRequestsPaused() && !signal.aborted) publishDeletionReceipt();
            if (this.scope.hasIdentityMismatch || authRequestsPaused()) this.settlePausedMutation(projectId, taskId, operation, { dispatched, confirmed, committedVersion: actualVersion, error: null, publicationPending: true });
          } };
        if (operation.action === "delete") {
          const response = await this.runMutationStage(projectId, taskId, operation, signal, async () => {
            await verifySendReview();
            this.assertMutationReview(projectId, taskId, operation, review, requestTicket);
            signal.throwIfAborted();
            submitted = true;
            return deleteTask(projectId, taskId, operation.version, operation.removeDepends, signal, admission);
          }, () => !submitted);
          if (response === null) return;
          publishDeletionReceipt();
          if (deletionReceiptPublished) return;
          await runOutcome(requestTicket, null, () => {
            this.markDeleted(projectId, taskId, this.entryGeneration(entry)!, null);
            publishDeletionReceipt();
          }, undefined, true, async () => { publishDeletionReceipt(); });
          return;
        }
        const response = await this.runMutationStage(projectId, taskId, operation, signal, async () => {
          await verifySendReview();
          this.assertMutationReview(projectId, taskId, operation, review, requestTicket);
          signal.throwIfAborted();
          submitted = true;
          return operation.action === "withdraw"
            ? withdrawWorkerClaim(projectId, taskId, operation.claimId, operation.version, signal, admission)
            : operation.action === "allowAgents"
            ? setTaskAgentPermission(projectId, taskId, operation.allowAgents, operation.version, signal, admission)
            : operation.action === "unpause"
              ? unpauseTask(projectId, taskId, operation.version, signal, admission)
            : operation.action === "requiredPlatform"
              ? setTaskRequiredPlatform(projectId, taskId, operation.requiredPlatform, operation.version, signal, admission)
              : operation.action === "assignedTo"
              ? setTaskAssignedTo(projectId, taskId, operation.assignedTo, operation.version, signal, admission)
              : operation.action === "parent"
              ? updateTaskFields(projectId, taskId, { parentId: operation.parentId }, operation.version, signal, admission)
              : operation.action === "editGoal"
              ? updateTaskFields(projectId, taskId, { title: operation.title, description: operation.description }, operation.version, signal, admission)
              : operation.action === "tags"
              ? updateTaskFields(projectId, taskId, { tagIds: operation.tagIds }, operation.version, signal, admission)
              : operation.cancelDescendants === undefined
                ? setTaskStatus(projectId, taskId, operation.status, operation.version, signal, admission)
                : setTaskStatus(projectId, taskId, operation.status, operation.version, signal, admission, operation.cancelDescendants);
        }, () => !submitted);
        if (response === null) return;
        const detail = response.value;
        const validateResponse = (): void => {
          const preservesTiming = detail.startedAt === previous.startedAt && detail.completedAt === previous.completedAt && detail.cancelledAt === previous.cancelledAt;
          const validResult = operation.action === "withdraw"
            ? detail.status === "todo" && !detail.allowAgents && readWorkerClaim(detail.properties) === undefined && detail.startedAt === null && detail.completedAt === null && detail.requiredPlatform === previous.requiredPlatform
            : operation.action === "allowAgents"
            ? detail.status === previous.status && detail.allowAgents === operation.allowAgents && detail.requiredPlatform === previous.requiredPlatform && preservesTiming
            : operation.action === "unpause"
              ? detail.status === previous.status && readTaskPaused(detail.properties) === false && detail.allowAgents === previous.allowAgents && detail.requiredPlatform === previous.requiredPlatform && preservesTiming
            : operation.action === "requiredPlatform"
              ? detail.status === previous.status && detail.requiredPlatform === operation.requiredPlatform && detail.allowAgents === previous.allowAgents && preservesTiming
              : operation.action === "assignedTo"
              ? detail.status === previous.status && detail.assignedTo === operation.assignedTo && detail.requiredPlatform === previous.requiredPlatform &&
                detail.allowAgents === (changed ? false : previous.allowAgents) && preservesTiming && (changed || detail.updatedAt === previous.updatedAt)
              : operation.action === "parent" || operation.action === "editGoal" || operation.action === "tags"
              ? detail.status === previous.status && detail.allowAgents === previous.allowAgents && detail.requiredPlatform === previous.requiredPlatform && preservesTiming && (changed || detail.updatedAt === previous.updatedAt)
              : detail.status === operation.status && detail.allowAgents === previous.allowAgents && detail.requiredPlatform === previous.requiredPlatform && validStatusTiming(previous, detail, operation.status);
          const expectedMaterials = operation.action === "unpause" ? { ...previous, properties: { ...previous.properties, paused: false } }
            : operation.action === "editGoal" ? { ...previous, title: operation.title, description: operation.description } : previous;
          const expectedParent = operation.action === "parent" ? operation.parentId : previous.parentId;
          if (detail.projectId !== projectId || detail.id !== taskId || detail.type !== previous.type || detail.parentId !== expectedParent || previous.parentTaskId !== undefined && detail.parentTaskId !== previous.parentTaskId || !validResult ||
            operation.action === "tags" && !sameIds(detail.tags.map(tag => tag.id), operation.tagIds) ||
            !preservesMaterials(expectedMaterials, detail, operation.action !== "withdraw", operation.action !== "assignedTo", operation.action !== "tags") || detail.version !== committedVersion) throw new ApiError("protocol");
        };
        await runOutcome(requestTicket, null, async () => {
          if (confirmed && actualVersion !== null) entry.committedVersion = actualVersion;
          if (this.disposed) {
            entry.state = { ...entry.state, mutation: { operation, phase: "confirmed", error: null, reconciling: false, reconciliationError: null } };
            return;
          }
          validateResponse();
          validated = true;
          confirmed = true;
          if (!this.receiptReadGenerations.has(operation)) this.receiptReadGenerations.set(operation, entry.generation);
          actualVersion = detail.version;
          entry.committedVersion = detail.version;
          if ("historyGeneration" in requestTicket) {
            const projectReceipt = (operation.action === 'parent' || operation.action === 'editGoal') || operation.action === 'status' && (detail.type === 'goal' || detail.parentId !== null);
            this.publish(entry, { ...entry.state, ...(projectReceipt ? { detail: preserveCollection(entry.state.detail, detail), status: "ready" as const, graphMismatch: true } : {}), requiresFreshRead: true,
              mutation: { operation, phase: "confirmed", error: null, reconciling: false, reconciliationError: null, publicationPending: true } });
            if (projectReceipt) this.publishCommittedTask(projectId, previous, detail, projectFence);
            this.refreshProject(projectId);
            await this.read(projectId, taskId, entry.state.revision, false, true);
            return;
          }
          await this.accept(projectId, taskId, detail, requestTicket, entry.state.revision, false, signal, null, operationGeneration);
          await this.runMutationStage(projectId, taskId, operation, signal, () => {
            if (this.disposed || !this.admitMutationOutcome(projectId, taskId, operation, requestTicket, null, confirmed, actualVersion)) return;
            this.publish(entry, { ...entry.state, mutation: { operation, phase: "confirmed", error: null, reconciling: false, reconciliationError: null } });
            if ((operation.action === 'parent' || operation.action === 'editGoal') || operation.action === 'status' && (detail.type === 'goal' || detail.parentId !== null)) this.publishCommittedTask(projectId, previous, detail, projectFence);
            this.refreshProject(projectId);
          });
        }, undefined, true, async () => {
          if (operation.action !== "parent" && operation.action !== "editGoal" && (operation.action !== "status" || detail.type !== "goal" && detail.parentId === null) || !("historyGeneration" in requestTicket)) return;
          validateResponse();
          if (!await this.scope.verifyTaskRead(requestTicket, signal) || !this.scope.isTaskHistoryConfirmedCurrent(requestTicket)) return;
          const epoch = review.receipt?.epoch;
          if (epoch === undefined || this.hasNewerObservation(entry, epoch, detail.version)) return;
          const current = entry.receipt;
          if (current !== null && current.epoch === epoch && this.ticketCurrent(entry, current.fence) && current.detail.version === detail.version &&
            (current.detail.parentId !== detail.parentId || current.detail.parentTaskId !== undefined && detail.parentTaskId !== undefined && current.detail.parentTaskId !== detail.parentTaskId || current.detail.type !== detail.type || current.detail.status !== detail.status ||
              current.detail.allowAgents !== detail.allowAgents || current.detail.requiredPlatform !== detail.requiredPlatform ||
              current.detail.updatedAt !== detail.updatedAt || current.detail.startedAt !== detail.startedAt || current.detail.completedAt !== detail.completedAt ||
              current.detail.cancelledAt !== detail.cancelledAt || !preservesMaterials(detail, current.detail))) {
            this.publishCommittedTask(projectId, previous, detail, projectFence, true);
            this.refreshProject(projectId);
            return;
          }
          this.publishCommittedTask(projectId, previous, detail, projectFence);
          this.refreshProject(projectId);
        });
      } catch (error) {
        if (!signal.aborted || !outcomeKnown) { outcomeKnown = true; outcomeError = error; }
        if (this.scope.isInvalidated) return;
        if (signal.aborted || authRequestsPaused()) {
          this.settlePausedMutation(projectId, taskId, operation, { dispatched, confirmed, committedVersion: actualVersion, error: outcomeError, publicationPending: true });
          if (signal.aborted) return;
          // A temporary pause retains the result for its original owner's admission.
          try { await abortableMutation(signal, this.scope.ready(signal)); } catch {
            if (signal.aborted) this.settlePausedMutation(projectId, taskId, operation, { dispatched, confirmed, committedVersion: actualVersion, error, publicationPending: true });
            return;
          }
          if (signal.aborted || this.scope.isInvalidated || entry.state.mutation.operation !== operation && !this.retiredMutations.has(operation)) return;
        }
        if (this.scope.hasIdentityMismatch || error instanceof TaskCacheLifecycleChanged && !error.retryable) {
          this.settlePausedMutation(projectId, taskId, operation, { dispatched, confirmed, committedVersion: actualVersion, error: outcomeError, publicationPending: true });
          return;
        }
        if (settleRetired(error)) return;
        if (ticket !== null && "historyGeneration" in ticket && error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found" &&
          this.scope.isTaskReadCurrent(ticket, true) && entry.openingGeneration === ticket.openingSequence) {
          entry.receipt = null; entry.liveVersion = null; entry.withdrawn = true;
          this.publish(entry, { ...entry.state, detail: null, loadedRevision: null, status: "error", refreshing: false, requiresFreshRead: true, error,
            mutation: { operation, phase: "refused", error, reconciling: false, reconciliationError: null } });
          this.scope.reportTaskNotFound(projectId);
          return;
        }
        if (ticket !== null && "historyGeneration" in ticket && error instanceof TaskCacheError && error.category === "storage") {
          this.failDirectFence(entry, operation, error, submitted, confirmed, actualVersion); return;
        }
        const settleError = async (work: () => void | Promise<void>): Promise<void> => {
          const negative = error instanceof ApiError && error.kind === "server" && (error.status === 404 || error.status === 410);
          try {
            await runOutcome(ticket, error, work, () => {
              if (error instanceof TaskMutationReviewExpired || !submitted && (isAbortError(error) || ticket !== null && !this.mutationIsCurrent(projectId, entry, operation, ticket))) {
                this.expireMutationReview(projectId, taskId, operation);
                return false;
              }
              return true;
            }, !negative);
          } catch (failure) {
            if (signal.aborted || authRequestsPaused()) {
              this.settlePausedMutation(projectId, taskId, operation, { dispatched, confirmed, committedVersion: actualVersion, error, publicationPending: true });
              return;
            }
            if (settleRetired(error)) return;
            if (failure instanceof TaskCacheLifecycleChanged && !failure.retryable) { this.settlePausedMutation(projectId, taskId, operation, { dispatched, confirmed, committedVersion: actualVersion, error, publicationPending: true }); return; }
            if (ticket !== null && "historyGeneration" in ticket && (isRetryableTaskCacheLifecycleChange(failure) && this.scope.isTaskReadCurrent(ticket, true) || failure instanceof TaskCacheError && failure.category === "storage"))
              this.failDirectFence(entry, operation, failure, submitted, confirmed, actualVersion);
          }
        };
        // Access withdrawal belongs to the scope even while identity checks suspend positive admission.
        if (!confirmed && submitted && ticket !== null && !("historyGeneration" in ticket) && error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found") {
          if (entry.state.mutation.operation === operation) {
            const current = this.mutationIsCurrent(projectId, entry, operation, ticket);
            const state: DetailState = { ...entry.state, ...(current ? { detail: null, loadedRevision: null, status: "error" as const, error, requiresFreshRead: true } : {}), mutation: { operation, phase: "refused", error, reconciling: false, reconciliationError: null } };
            if (this.disposed) entry.state = state;
            else { this.publish(entry, state); if (current) entry.withdrawn = true; }
            if (current) {
              if (this.disposed || entry.listeners.size === 0) void this.scope.revalidateProjectAccess(projectId).catch(() => {});
              else this.scope.reportTaskNotFound(projectId);
            }
          }
          return;
        }
        await settleError(async () => {
          if (confirmed && actualVersion !== null) entry.committedVersion = actualVersion;
          if (submitted && ticket !== null && error instanceof ApiError && error.kind === "server" && error.status === 410 && error.code === "task_deleted") {
            this.markDeleted(projectId, taskId, this.entryGeneration(entry)!, error);
            const reviewedEpoch = "historyGeneration" in ticket ? review.receipt?.epoch : ticket.epoch;
            this.scope.fenceTaskHistory(projectId, reviewedEpoch ?? null);
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
              mutation: { operation, phase: "confirmed", error: null, reconciling: false, reconciliationError: null, publicationPending: true } });
            this.refreshProject(projectId);
            if (!validated) await this.read(projectId, taskId, entry.state.revision, true, true);
            return;
          }
          const phase = !submitted ? "refused" : error instanceof ApiError && error.kind === "server" && error.status !== null && error.status >= 400 && error.status < 500
            ? error.code === "version_conflict" ? "conflict" : "refused" : "unknown";
          this.publish(entry, { ...entry.state, mutation: { operation, phase, error, reconciling: false, reconciliationError: null } });
          if (phase === "conflict" || phase === "unknown" || entry.source === "direct" && error instanceof ApiError && error.status === 404) {
            if (phase === "conflict" || phase === "unknown" && entry.source === "direct") this.refreshProject(projectId);
            if (!this.disposed) await this.read(projectId, taskId, entry.state.revision, true, true);
          }
        });
      } finally {
        releasePause();
        if (this.mutationControllers.get(key)?.operation === operation) {
          this.mutationControllers.delete(key);
        }
        if (!signal.aborted && !authRequestsPaused()) this.drainReads(projectId, taskId);
      }
    })();
  }
  dispose(): void {
    this.disposed = true;
    for (const owner of this.mutationControllers.values()) owner.dispose?.();
    this.releaseScope();
    this.scope.signal.removeEventListener("abort", this.onScopeRetired);
    this.projects.clear();
    this.committedTasks.clear();
    this.committedListeners.clear();
    this.projectGenerations.clear();
    for (const entry of this.entries.values()) {
      this.retireMutation(entry);
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
export const useOptionalTaskDetailSessions = (): TaskDetailSessions | null => useContext(Context);
export const useTaskDetailSessions = (): TaskDetailSessions => {
  const sessions = useContext(Context);
  if (sessions === null) throw new Error("Task detail sessions are required.");
  return sessions;
};
