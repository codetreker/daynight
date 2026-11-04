import { readPullRequests, readTaskPaused, readWorkerClaim, sameTaskProperties } from "../../api/task-properties";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, authRequestsPaused, deleteTask, getTask, isAbortError, requestId, setTaskAgentPermission, setTaskAssignedTo, setTaskRequiredPlatform, setTaskStatus, unpauseTask, withdrawWorkerClaim } from "../../api/client";
import { getTaskSteps, setTaskStepStatus, type StepStatus, type StepsResource } from "../../api/task-steps";
import { isTaskStale } from "./freshness";
import type { ExecutionPlatform, GraphTask, TaskDetail, TaskStatus } from "../../api/types";
import { TaskCacheError } from "../task-cache/database";
import { useTaskCacheScope } from "../task-cache/TaskCacheProvider";
import type { SyncTicket, TaskCacheScope } from "../task-cache/project-cache";
import { materializeDetail, readCachedDetail, saveDetail, validateDetailSummary, type DetailAdmission } from "./detail-cache";

export type TaskMutationOperation = { readonly action: "unpause"; readonly version: bigint } | { readonly action: "withdraw"; readonly claimId: string; readonly version: bigint } | { readonly action: "delete"; readonly version: bigint; readonly removeDepends: boolean } | { readonly action: "status"; readonly status: TaskStatus; readonly version: bigint } | { readonly action: "stepStatus"; readonly stepId: string; readonly status: StepStatus; readonly version: bigint; readonly requestId: string } | { readonly action: "allowAgents"; readonly allowAgents: boolean; readonly version: bigint } | { readonly action: "requiredPlatform"; readonly requiredPlatform: ExecutionPlatform | null; readonly version: bigint } | { readonly action: "assignedTo"; readonly assignedTo: string | null; readonly version: bigint };
type TaskMutationReview = { readonly detail: TaskDetail; readonly cacheGeneration: string };
class TaskMutationReviewExpired extends Error {}
export type TaskMutationState = {
  readonly operation: TaskMutationOperation | null;
  readonly phase: "idle" | "pending" | "confirmed" | "refused" | "conflict" | "unknown" | "reconciled";
  readonly error: unknown;
  readonly reconciling: boolean;
  readonly reconciliationError: unknown;
  readonly reconciledFrom?: "unknown" | "conflict";
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
export type TaskStepsState = {
  readonly resource: StepsResource | null;
  readonly status: "loading" | "waiting" | "ready" | "error" | "deleted";
  readonly refreshing: boolean;
  readonly stale: boolean;
  readonly error: unknown;
};
export const emptyTaskStepsState: TaskStepsState = { resource: null, status: "loading", refreshing: false, stale: true, error: null };
type StepsRead = {
  state: TaskStepsState;
  generation: number;
  recoveryReads: number;
  parentRetry: { readonly floor: bigint; readonly opening: number } | null;
  parentRequested: { readonly floor: bigint; readonly opening: number } | null;
  cacheGeneration: string | null;
  // Verified versions remain a lower bound after their full collections are released.
  floor: bigint | null;
  retriedFloor: bigint | null;
  read: AbortController | null;
  queued: boolean;
  admission: AbortController | null;
  pending: { readonly resource: StepsResource; readonly ticket: SyncTicket; readonly generation: number } | null;
  readonly projectId: string;
  readonly taskId: string;
  readonly listeners: Set<() => void>;
};
type Entry = {
  state: DetailState;
  readonly steps: StepsRead;
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
export const canSetStatus = (state: DetailState): boolean => canMutate(state);
export const canUnpause = (state: DetailState): boolean => canMutate(state) && readTaskPaused(state.detail!.properties) === true;
export const canSetAgentPermission = (state: DetailState): boolean => state.detail !== null && state.detail.status !== "in_progress" && canMutate(state);
export const canSetRequiredPlatform = canSetAgentPermission;
export const canSetAssignedTo = canSetAgentPermission;
export const canWithdrawClaim = (state: DetailState): boolean => {
  if (!canMutate(state)) return false;
  const worker = readWorkerClaim(state.detail!.properties);
  return worker !== undefined && worker.state !== "completed";
};

const sameIds = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((id) => right.includes(id));
const preservesMaterials = (before: TaskDetail, after: TaskDetail, preserveWorker = true, preserveAssignment = true): boolean => before.title === after.title && before.description === after.description &&
  before.createdAt === after.createdAt && sameTaskProperties(before.properties, after.properties, !preserveWorker) &&
  (!preserveAssignment || before.assignedTo === after.assignedTo) &&
  sameIds(before.dependsOn, after.dependsOn) && sameIds(before.externalDependsOn, after.externalDependsOn);
const validStatusTiming = (before: TaskDetail, after: TaskDetail, target: TaskStatus): boolean => {
  if (before.status === target) return before.updatedAt === after.updatedAt && before.startedAt === after.startedAt && before.completedAt === after.completedAt;
  if (target === "todo") return after.startedAt === null && after.completedAt === null;
  if (target === "in_progress") return after.startedAt !== null && after.completedAt === null;
  return after.completedAt !== null && after.startedAt === (before.status === "in_progress" ? before.startedAt : null);
};

const sameSteps = (before: StepsResource, after: StepsResource): boolean => before.steps.length === after.steps.length && before.steps.every((step, index) => {
  const other = after.steps[index]!;
  return step.id === other.id && step.title === other.title && step.description === other.description && step.status === other.status && step.createdAt === other.createdAt && step.updatedAt === other.updatedAt;
});

export class TaskDetailSessions {
  private readonly entries = new Map<string, Entry>();
  private readonly projects = new Map<string, Set<() => void>>();
  private readonly projectGenerations = new Map<string, string | null>();
  private disposed = false;
  private readonly releaseScope: () => void;
  private readonly onScopeRetired = (): void => {
    for (const entry of this.entries.values()) this.clearSteps(entry.steps, emptyTaskStepsState);
  };
  constructor(private readonly scope: TaskCacheScope) {
    this.releaseScope = scope.subscribe((event) => {
      for (const entry of this.entries.values()) {
        if (entry.steps.projectId !== event.projectId) continue;
        if (event.accessRevoked) this.clearSteps(entry.steps, { ...emptyTaskStepsState, status: "error", error: event.error });
        else this.synchronizeSteps(entry);
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
      entry = { steps: { state: emptyTaskStepsState, generation: 0, recoveryReads: 0, parentRetry: null, parentRequested: null, cacheGeneration: null, floor: null, retriedFloor: null, read: null, queued: false, admission: null, pending: null, projectId, taskId, listeners: new Set() }, state: initialState(), generation: 0, read: null, committedVersion: null, queuedRead: null, observedTask: undefined, observedVersion: null, observedGeneration: null, deletedGeneration: null, admitted: false, liveVersion: null, openingGeneration: 0, liveOpeningGeneration: 0, mismatch: null, pending: null, listeners: new Set() };
      this.entries.set(key, entry);
    }
    return entry;
  }
  private publish(entry: Entry, state: DetailState): void {
    entry.state = state;
    this.synchronizeSteps(entry);
    this.finishStepReconciliation(entry);
    for (const listener of entry.listeners) listener();
  }
  private publishSteps(steps: StepsRead, state: TaskStepsState): void {
    steps.state = state;
    const entry = this.entry(steps.projectId, steps.taskId);
    const finished = this.finishStepReconciliation(entry);
    for (const listener of steps.listeners) listener();
    if (finished) for (const listener of entry.listeners) listener();
  }
  private clearSteps(steps: StepsRead, state: TaskStepsState, retire = true): void {
    steps.generation++;
    steps.read?.abort(); steps.read = null;
    steps.admission?.abort(); steps.admission = null;
    steps.pending = null; steps.queued = false; steps.retriedFloor = null;
    if (retire) steps.floor = null;
    this.publishSteps(steps, state);
  }
  stepsSnapshot = (projectId: string, taskId: string): TaskStepsState => this.entry(projectId, taskId).steps.state;
  subscribeSteps = (projectId: string, taskId: string, listener: () => void): (() => void) => {
    const entry = this.entry(projectId, taskId);
    const steps = entry.steps;
    steps.listeners.add(listener);
    return () => {
      steps.listeners.delete(listener);
      // Large collections belong only to views that currently need them.
      if (steps.listeners.size === 0 && !this.stepOperationNeedsResource(entry)) this.clearSteps(steps, emptyTaskStepsState, false);
    };
  };
  private stepOperationNeedsResource(entry: Entry): boolean {
    const mutation = entry.state.mutation;
    return mutation.operation?.action === "stepStatus" && (mutation.phase === "pending" || mutation.reconciling);
  }
  private stepRecoveryId(entry: Entry): string | undefined {
    const mutation = entry.state.mutation;
    return mutation.operation?.action === "stepStatus" && mutation.reconciling ? `${mutation.operation.requestId}.r${++entry.steps.recoveryReads}` : undefined;
  }
  private getParent(entry: Entry, signal: AbortSignal): Promise<TaskDetail> {
    const admission = { userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch };
    const correlationId = this.stepRecoveryId(entry);
    return correlationId === undefined ? getTask(entry.steps.projectId, entry.steps.taskId, signal, admission)
      : getTask(entry.steps.projectId, entry.steps.taskId, signal, admission, correlationId);
  }
  private finishStepReconciliation(entry: Entry): boolean {
    const mutation = entry.state.mutation;
    const steps = entry.steps;
    const version = steps.state.resource?.version;
    if (mutation.operation?.action !== "stepStatus" || !mutation.reconciling || steps.state.stale || steps.state.error !== null || version === undefined ||
      entry.state.detail?.version !== version || this.summaryVersion(steps.projectId, steps.taskId) !== version || entry.state.requiresFreshRead || entry.state.error !== null) return false;
    entry.state = { ...entry.state, mutation: { ...mutation, phase: mutation.phase === "unknown" || mutation.phase === "conflict" ? "reconciled" : mutation.phase,
      ...(mutation.phase === "unknown" || mutation.phase === "conflict" ? { reconciledFrom: mutation.phase } : {}), reconciling: false, reconciliationError: null } };
    if (steps.listeners.size === 0) this.clearSteps(steps, emptyTaskStepsState, false);
    return true;
  }
  private stepsFloor(entry: Entry): bigint | null {
    const pending = entry.pending;
    const pendingVersion = pending !== null && pending.ticket.cacheGeneration === this.projectGeneration(entry.steps.projectId) &&
      (pending.generation === null || pending.generation === entry.generation) ? pending.detail.version : null;
    const versions = [this.summaryVersion(entry.steps.projectId, entry.steps.taskId), entry.state.detail?.version ?? null,
      entry.committedVersion, pendingVersion, entry.steps.floor, entry.steps.state.resource?.version ?? null, entry.steps.pending?.resource.version ?? null];
    return versions.reduce<bigint | null>((floor, version) => version !== null && (floor === null || version > floor) ? version : floor, null);
  }
  private synchronizeSteps(entry: Entry): void {
    const steps = entry.steps;
    if (this.disposed || this.scope.isInvalidated) return;
    const generation = this.projectGeneration(steps.projectId);
    if (steps.cacheGeneration !== generation) {
      steps.cacheGeneration = generation;
      const denied = generation === null ? steps.state.error : null;
      this.clearSteps(steps, denied === null ? emptyTaskStepsState : { ...emptyTaskStepsState, status: "error", error: denied });
    }
    if (entry.state.status === "deleted") {
      if (steps.state.status !== "deleted") this.clearSteps(steps, { ...emptyTaskStepsState, status: "deleted", stale: false });
      return;
    }
    if (!entry.admitted || generation === null || entry.observedGeneration !== generation) {
      if (steps.state.resource !== null || steps.pending !== null || steps.read !== null) this.clearSteps(steps, emptyTaskStepsState, false);
      return;
    }
    const floor = this.stepsFloor(entry);
    const advanced = steps.floor !== floor;
    if (advanced) { steps.floor = floor; steps.retriedFloor = null; }
    this.scheduleStepParent(entry, floor);
    if (steps.state.resource !== null && floor !== null && steps.state.resource.version < floor && !steps.state.stale) {
      this.publishSteps(steps, { ...steps.state, stale: true });
    }
    if (steps.pending !== null) {
      const pending = steps.pending;
      if (floor !== null && pending.resource.version < floor) {
        steps.pending = null;
        steps.queued = true;
      } else if (pending.resource.version === this.summaryVersion(steps.projectId, steps.taskId)) {
        steps.pending = null;
        steps.admission = new AbortController();
        const signal = AbortSignal.any([steps.admission.signal, this.scope.signal]);
        void this.acceptSteps(entry, pending.resource, pending.ticket, pending.generation, signal)
          .catch((error: unknown) => {
            if (!this.disposed && !this.scope.isInvalidated && pending.generation === steps.generation && !isAbortError(error)) this.failSteps(steps, error);
          }).finally(() => {
            if (pending.generation !== steps.generation) return;
            steps.admission = null;
            if (steps.queued && steps.state.error === null) this.loadSteps(steps.projectId, steps.taskId);
          });
        return;
      }
    }
    if ((steps.listeners.size > 0 || this.stepOperationNeedsResource(entry)) && steps.pending === null && (advanced || steps.state.stale && steps.state.error === null)) this.loadSteps(steps.projectId, steps.taskId);
  }
  private scheduleStepParent(entry: Entry, floor: bigint | null): void {
    const steps = entry.steps;
    const opening = entry.openingGeneration;
    const currentDetail = entry.state.detail !== null && entry.state.detail.version >= (floor ?? 0n) && entry.liveOpeningGeneration === opening;
    const currentPending = entry.pending !== null && entry.pending.detail.version >= (floor ?? 0n) && entry.pending.readOpeningGeneration === opening;
    if (entry.state.mutation.operation?.action !== "stepStatus" || !entry.state.mutation.reconciling || floor === null || currentDetail || currentPending ||
      steps.parentRequested?.floor === floor && steps.parentRequested.opening === opening) return;
    // Each floor and opening shares a read; an obsolete response gets one bounded retry.
    steps.parentRequested = { floor, opening };
    entry.queuedRead = { revision: entry.state.revision, reconciliation: false };
    this.drainReads(steps.projectId, steps.taskId);
  }
  loadSteps(projectId: string, taskId: string, force = false): void {
    const entry = this.entry(projectId, taskId);
    const steps = entry.steps;
    if (this.disposed || this.scope.isInvalidated || entry.state.mutation.phase === "pending" && entry.state.mutation.operation?.action === "stepStatus" || steps.listeners.size === 0 && !this.stepOperationNeedsResource(entry) || !entry.admitted || entry.state.status === "deleted" ||
      entry.observedGeneration !== this.projectGeneration(projectId) || this.projectGeneration(projectId) === null) return;
    if (steps.admission !== null || steps.read !== null) { if (force || steps.state.stale) steps.queued = true; return; }
    if (!force && steps.pending !== null) return;
    if (!force && !steps.state.stale) return;
    if (force) { steps.pending = null; steps.retriedFloor = null; }
    void this.readSteps(entry);
  }
  private failSteps(steps: StepsRead, error: unknown): void {
    this.publishSteps(steps, { ...steps.state, status: steps.state.resource === null ? "error" : "ready", refreshing: false, stale: true, error });
    const entry = this.entry(steps.projectId, steps.taskId);
    if (entry.state.mutation.operation?.action === "stepStatus" && entry.state.mutation.reconciling) {
      this.publish(entry, { ...entry.state, mutation: { ...entry.state.mutation, reconciling: false, reconciliationError: error } });
      if (steps.listeners.size === 0) this.clearSteps(steps, emptyTaskStepsState, false);
    }
  }
  private async acceptSteps(entry: Entry, resource: StepsResource, ticket: SyncTicket, generation: number, signal: AbortSignal): Promise<void> {
    const steps = entry.steps;
    const current = () => !this.disposed && !this.scope.isInvalidated && !signal.aborted && generation === steps.generation &&
      (steps.listeners.size > 0 || this.stepOperationNeedsResource(entry)) && entry.admitted && entry.observedGeneration === ticket.cacheGeneration && this.projectGeneration(steps.projectId) === ticket.cacheGeneration;
    await this.scope.ready(signal);
    if (!current()) return;
    const observed = this.stepsFloor(entry);
    const received = observed === null || resource.version > observed ? resource.version : observed;
    if (steps.floor !== received) { steps.floor = received; steps.retriedFloor = null; }
    this.scheduleStepParent(entry, received);
    const summaryVersion = await this.scope.detailTransaction(ticket, signal, async (_details, _manifest, summaries) => summaries.get(steps.taskId)?.version ?? null);
    while (authRequestsPaused()) {
      try { await this.scope.ready(signal); }
      catch (error) { if (!isAbortError(error) || signal.aborted || this.scope.isInvalidated) throw error; }
    }
    if (!current()) return;
    const floor = this.stepsFloor(entry);
    if (floor !== null && resource.version < floor) {
      if (steps.retriedFloor === floor) throw new ApiError("protocol");
      steps.retriedFloor = floor;
      steps.queued = true;
      return;
    }
    if (summaryVersion !== resource.version || this.summaryVersion(steps.projectId, steps.taskId) !== resource.version) {
      steps.pending = { resource, ticket, generation };
      this.publishSteps(steps, { ...steps.state, status: steps.state.resource === null ? "waiting" : "ready", refreshing: false, stale: true });
      this.refreshProject(steps.projectId);
      this.load(steps.projectId, steps.taskId, entry.state.revision, "automatic");
      return;
    }
    const previous = steps.state.resource;
    if (previous !== null && previous.version === resource.version && !sameSteps(previous, resource)) throw new ApiError("protocol");
    this.publishSteps(steps, { resource: previous !== null && previous.version === resource.version ? previous : resource, status: "ready", refreshing: false, stale: false, error: null });
  }
  private async readSteps(entry: Entry): Promise<void> {
    const steps = entry.steps;
    const controller = new AbortController();
    steps.read = controller;
    steps.queued = false;
    const generation = steps.generation;
    const signal = AbortSignal.any([controller.signal, this.scope.signal]);
    this.publishSteps(steps, { ...steps.state, status: steps.state.resource === null ? "loading" : "ready", refreshing: steps.state.resource !== null, stale: true, error: null });
    let ticket: SyncTicket | null = null;
    try {
      ticket = await this.scope.beginSync(steps.projectId, signal);
      const resource = await getTaskSteps(steps.projectId, steps.taskId, signal, { userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch }, this.stepRecoveryId(entry));
      await this.acceptSteps(entry, resource, ticket, generation, signal);
    } catch (error) {
      if (signal.aborted || this.disposed || this.scope.isInvalidated || generation !== steps.generation || isAbortError(error)) return;
      if (ticket !== null && this.projectGeneration(steps.projectId) !== ticket.cacheGeneration) return;
      if (ticket !== null && error instanceof ApiError && error.kind === "server" && error.status === 410 && error.code === "task_deleted") {
        this.markDeleted(steps.projectId, steps.taskId, ticket.cacheGeneration, error);
        return;
      }
      if (ticket !== null && error instanceof ApiError && error.kind === "server" && error.status === 404) {
        // A missing Steps route or item does not establish that the parent is inaccessible.
        try {
          const detail = await this.getParent(entry, signal);
          await this.accept(steps.projectId, steps.taskId, detail, ticket, entry.state.revision, false, signal);
        } catch (parentError) {
          if (signal.aborted || this.disposed || this.scope.isInvalidated || generation !== steps.generation || isAbortError(parentError)) return;
          if (parentError instanceof ApiError && parentError.kind === "server" && parentError.status === 410 && parentError.code === "task_deleted") {
            this.markDeleted(steps.projectId, steps.taskId, ticket.cacheGeneration, parentError);
            return;
          }
          if (parentError instanceof ApiError && parentError.kind === "server" && parentError.status === 404 && parentError.code === "not_found") {
            try { await this.revokeAccess(ticket, parentError, this.scope.signal); }
            catch (storageError) { if (!this.scope.isInvalidated && !isAbortError(storageError)) this.failSteps(steps, storageError); }
            return;
          }
          this.failSteps(steps, parentError);
          return;
        }
      }
      if (generation === steps.generation) this.failSteps(steps, error);
    } finally {
      if (generation === steps.generation) {
        steps.read = null;
        if (steps.queued && steps.state.error === null && steps.pending === null) this.loadSteps(steps.projectId, steps.taskId);
      }
    }
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
    // The rendered graph can lag the already committed cache generation.
    const removed = admitted && cacheGeneration !== null && entry.observedVersion !== null && version === null &&
      this.scope.getAuthorizedProject(projectId)?.index.nodes.has(taskId) === false;
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
        mutation: restored ? idleMutation() : { ...entry.state.mutation, reconciling: false, reconciliationError: null } });
    }
    const changed = lifecycleChanged || restored || entry.observedVersion !== version;
    entry.observedGeneration = cacheGeneration;
    entry.admitted = admitted;
    entry.observedVersion = version;
    entry.observedTask = task;
    this.synchronizeSteps(entry);
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
    else if (entry.state.mutation.operation?.action === "stepStatus" && entry.state.mutation.reconciling) void this.read(projectId, taskId, queued.revision, false, true);
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
    if (entry.state.mutation.operation?.action === "stepStatus") {
      this.reconcileSteps(entry);
      return;
    }
    void this.read(projectId, taskId, entry.state.revision, entry.state.mutation.operation !== null, true);
  }
  private reconcileSteps(entry: Entry): void {
    const floor = this.stepsFloor(entry);
    entry.steps.parentRequested = floor === null ? null : { floor, opening: entry.openingGeneration };
    entry.steps.parentRetry = null;
    this.publish(entry, { ...entry.state, requiresFreshRead: true, mutation: { ...entry.state.mutation, reconciling: true, reconciliationError: null } });
    this.refreshProject(entry.steps.projectId);
    void this.read(entry.steps.projectId, entry.steps.taskId, entry.state.revision, false, true);
    this.loadSteps(entry.steps.projectId, entry.steps.taskId, true);
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
    this.cancelRead(projectId, taskId);
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
    if (entry.steps.pending !== null) this.failSteps(entry.steps, error);
    const stepReconciliation = entry.state.mutation.operation?.action === "stepStatus" && entry.state.mutation.reconciling;
    if (stepReconciliation) entry.queuedRead = null;
    const missing = error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found";
    const detail = missing ? null : entry.state.detail;
    this.publish(entry, { ...entry.state, detail, loadedRevision: missing ? null : entry.state.loadedRevision, status: detail !== null ? "ready" : "error", refreshing: false,
      requiresFreshRead: reconciliation || entry.state.requiresFreshRead,
      error: reconciliation && detail !== null ? null : error,
      mutation: reconciliation || stepReconciliation ? { ...entry.state.mutation, reconciling: false, reconciliationError: error } : entry.state.mutation });
    if (stepReconciliation && entry.steps.listeners.size === 0) this.clearSteps(entry.steps, emptyTaskStepsState, false);
  }
  private async accept(projectId: string, taskId: string, detail: TaskDetail, ticket: SyncTicket, revision: number, reconciliation: boolean, signal: AbortSignal, generation: number | null = null, writeGeneration: number | null = null, readOpeningGeneration: number | null = null): Promise<void> {
    const entry = this.entry(projectId, taskId);
    const current = (): boolean => !signal.aborted && !this.disposed && !this.scope.isInvalidated && entry.state.status !== "deleted" &&
      entry.admitted && entry.observedGeneration === ticket.cacheGeneration && this.projectGeneration(projectId) === ticket.cacheGeneration &&
      (generation === null || generation === entry.generation);
    if (!current()) return;
    if (detail.projectId !== projectId || detail.id !== taskId) throw new ApiError("protocol");
    if (entry.committedVersion !== null && detail.version < entry.committedVersion) {
      if (this.retryStepParent(entry, revision, readOpeningGeneration)) return;
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
      catch (error) { if (!isAbortError(error) || signal.aborted || this.scope.isInvalidated) throw error; }
    }
    if (!current()) return;
    const requested = entry.steps.parentRequested;
    if (requested !== null && detail.version >= requested.floor && readOpeningGeneration === requested.opening && requested.opening === entry.openingGeneration && entry.queuedRead?.reconciliation === false && entry.state.mutation.operation?.action === "stepStatus") entry.queuedRead = null;
    if (admitted.kind === "older") {
      if (this.retryStepParent(entry, revision, readOpeningGeneration)) return;
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
      : readOpeningGeneration !== null && entry.state.mutation.operation?.action !== "stepStatus" ? { ...entry.state.mutation, reconciling: false, reconciliationError: null } : entry.state.mutation;
    this.publish(entry, { ...entry.state, revision, loadedRevision: revision,
      detail: preserveCollection(entry.state.detail, materializeDetail(admitted.detail, node)), status: "ready", refreshing: false,
      requiresFreshRead: entry.liveVersion !== detail.version || entry.liveOpeningGeneration !== entry.openingGeneration || entry.mismatch !== null, graphMismatch: entry.mismatch !== null, error: storageError, mutation });
    if (entry.mismatch !== null || reconciliation) this.refreshProject(projectId);
    if (entry.liveOpeningGeneration !== entry.openingGeneration) {
      if (entry.queuedRead === null) entry.queuedRead = { revision, reconciliation: false };
      this.drainReads(projectId, taskId);
    }
  }
  private retryStepParent(entry: Entry, revision: number, readOpeningGeneration: number | null): boolean {
    if (entry.state.mutation.operation?.action !== "stepStatus" || !entry.state.mutation.reconciling) return false;
    const floor = this.stepsFloor(entry);
    if (floor === null) throw new ApiError("protocol");
    if (readOpeningGeneration === entry.openingGeneration) {
      if (entry.steps.parentRetry?.floor === floor && entry.steps.parentRetry.opening === entry.openingGeneration) throw new ApiError("protocol");
      entry.steps.parentRetry = { floor, opening: entry.openingGeneration };
    }
    entry.queuedRead = { revision, reconciliation: false };
    this.drainReads(entry.steps.projectId, entry.steps.taskId);
    return true;
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
      const detail = await this.getParent(entry, signal);
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
        if (entry.queuedRead === null && openingGeneration !== entry.openingGeneration &&
          !(entry.state.mutation.operation?.action === "stepStatus" && entry.state.mutation.reconciliationError !== null)) {
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
  canSetStepStatus(projectId: string, taskId: string): boolean {
    const entry = this.entry(projectId, taskId);
    const state = this.writableState(projectId, taskId);
    const steps = entry.steps.state;
    return canMutate(state) && steps.resource !== null && !steps.stale && !steps.refreshing && steps.error === null && steps.resource.version === state.detail!.version && this.summaryVersion(projectId, taskId) === steps.resource.version;
  }
  setStepStatus(projectId: string, taskId: string, stepId: string, status: StepStatus, version: bigint): void {
    const entry = this.entry(projectId, taskId);
    const target = stepId.toLowerCase();
    if (!this.canSetStepStatus(projectId, taskId) || !["todo", "in_progress", "done", "skipped"].includes(status) || entry.steps.state.resource?.version !== version || !entry.steps.state.resource.steps.some((step) => step.id === target) || !/^[0-9a-f]{8}$/.test(target)) return;
    this.performMutation(projectId, taskId, { action: "stepStatus", stepId: target, status, version, requestId: crypto.randomUUID() });
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
      if (!gone && entry.admitted && this.projectGeneration(projectId) !== null) {
        if (operation.action === "stepStatus") this.reconcileSteps(entry);
        else void this.read(projectId, taskId, entry.state.revision, true, true);
      }
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
      if (!gone && entry.admitted && this.projectGeneration(projectId) !== null) {
        if (operation.action === "stepStatus") this.reconcileSteps(entry);
        else void this.read(projectId, taskId, entry.state.revision, true, true);
      }
    }
  }
  private performMutation(projectId: string, taskId: string, operation: TaskMutationOperation): void {
    const entry = this.entry(projectId, taskId);
    const previous = entry.state.detail!;
    const previousSteps = operation.action === "stepStatus" ? entry.steps.state.resource : null;
    const reviewedGeneration = this.projectGeneration(projectId);
    if (reviewedGeneration === null) return;
    const review: TaskMutationReview = { detail: previous, cacheGeneration: reviewedGeneration };
    this.cancelRead(projectId, taskId);
    if (operation.action === "stepStatus") {
      entry.steps.recoveryReads = 0;
      entry.steps.parentRetry = null;
      entry.steps.parentRequested = null;
      entry.steps.generation++;
      entry.steps.read?.abort(); entry.steps.read = null;
      entry.steps.admission?.abort(); entry.steps.admission = null;
      entry.steps.pending = null; entry.steps.queued = false;
    }
    const operationGeneration = entry.generation;
    this.publish(entry, { ...entry.state, refreshing: false, error: null, mutation: { operation, phase: "pending", error: null, reconciling: false, reconciliationError: null } });
    // Submitted writes outlive their dialog, while identity retirement still fences their result.
    void (async () => {
      let submitted = false;
      let confirmed = false;
      let validated = false;
      const changed = operation.action === "stepStatus" ? previousSteps?.steps.find((step) => step.id === operation.stepId)?.status !== operation.status
        : operation.action === "status" ? previous.status !== operation.status
        : operation.action === "assignedTo" ? previous.assignedTo !== operation.assignedTo : true;
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
        if (operation.action === "stepStatus") {
          const response = await this.runMutationStage(projectId, taskId, operation, () => {
            this.assertMutationReview(projectId, taskId, operation, review, requestTicket);
            if (previousSteps === null || entry.steps.state.resource !== previousSteps || entry.steps.state.stale || previousSteps.version !== operation.version) throw new TaskMutationReviewExpired();
            submitted = true;
            return setTaskStepStatus(projectId, taskId, operation.stepId, operation.status, operation.version, signal, admission, operation.requestId);
          });
          if (response === null) return;
          await this.runMutationStage(projectId, taskId, operation, async () => {
            if (!this.admitMutationOutcome(projectId, taskId, operation, requestTicket)) return;
            const result = response.value;
            const oldTarget = previousSteps!.steps.find((step) => step.id === operation.stepId)!;
            const valid = result.version === committedVersion && result.steps.length === previousSteps!.steps.length && result.steps.every((step, index) => {
              const old = previousSteps!.steps[index]!;
              return step.id === old.id && step.title === old.title && step.description === old.description && step.createdAt === old.createdAt &&
                (step.id === operation.stepId ? step.status === operation.status && (changed || step.updatedAt === oldTarget.updatedAt) : step.status === old.status && step.updatedAt === old.updatedAt);
            });
            if (!valid) throw new ApiError("protocol");
            validated = true;
            entry.committedVersion = result.version;
            if (this.disposed) return;
            const floor = this.stepsFloor(entry);
            entry.steps.parentRequested = floor === null ? null : { floor, opening: entry.openingGeneration };
            this.publish(entry, { ...entry.state, requiresFreshRead: true, mutation: { operation, phase: "confirmed", error: null, reconciling: true, reconciliationError: null } });
            await this.acceptSteps(entry, result, requestTicket, entry.steps.generation, signal);
            this.refreshProject(projectId);
            void this.read(projectId, taskId, entry.state.revision, false, true);
          });
          return;
        }
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
            : operation.action === "unpause"
              ? unpauseTask(projectId, taskId, operation.version, signal, admission)
            : operation.action === "requiredPlatform"
              ? setTaskRequiredPlatform(projectId, taskId, operation.requiredPlatform, operation.version, signal, admission)
              : operation.action === "assignedTo"
              ? setTaskAssignedTo(projectId, taskId, operation.assignedTo, operation.version, signal, admission)
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
              : detail.status === operation.status && detail.allowAgents === previous.allowAgents && detail.requiredPlatform === previous.requiredPlatform && validStatusTiming(previous, detail, operation.status);
          const expectedMaterials = operation.action === "unpause" ? { ...previous, properties: { ...previous.properties, paused: false } } : previous;
          if (detail.projectId !== projectId || detail.id !== taskId || !validResult || !preservesMaterials(expectedMaterials, detail, operation.action !== "withdraw", operation.action !== "assignedTo") || detail.version !== committedVersion) throw new ApiError("protocol");
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
        if (operation.action === "stepStatus") {
          await this.runMutationStage(projectId, taskId, operation, async () => {
            if (error instanceof TaskMutationReviewExpired || !submitted && (isAbortError(error) || ticket !== null && !this.mutationIsCurrent(projectId, entry, operation, ticket))) {
              this.expireMutationReview(projectId, taskId, operation);
              return;
            }
            if (!this.admitMutationOutcome(projectId, taskId, operation, ticket, error)) return;
            if (ticket !== null && error instanceof ApiError && error.kind === "server" && error.status === 410 && error.code === "task_deleted") { this.markDeleted(projectId, taskId, ticket.cacheGeneration, error); return; }
            const phase = !submitted ? "refused" : error instanceof ApiError && error.kind === "server" && error.status !== null && error.status >= 400 && error.status < 500 ? error.code === "version_conflict" ? "conflict" : "refused" : "unknown";
            this.publish(entry, { ...entry.state, mutation: { operation, phase, error, reconciling: false, reconciliationError: null } });
            if (confirmed || phase === "unknown" || phase === "conflict" || error instanceof ApiError && error.kind === "server" && error.status === 404) this.reconcileSteps(entry);
            else if (entry.steps.listeners.size === 0) this.clearSteps(entry.steps, emptyTaskStepsState, false);
          });
          return;
        }
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
    this.releaseScope();
    this.scope.signal.removeEventListener("abort", this.onScopeRetired);
    this.projects.clear();
    this.projectGenerations.clear();
    for (const entry of this.entries.values()) {
      this.clearSteps(entry.steps, emptyTaskStepsState);
      entry.steps.listeners.clear();
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
