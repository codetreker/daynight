import type { IDBPObjectStore, IDBPTransaction } from "idb";
import { ApiError, authRequestsPaused, authRequestsPauseRevision, isAbortError, requestId, subscribeAuthPause, waitForAuthRequests } from "../../api/client";
import { getProjectAccess } from "../../api/auth";
import { canonicalId, record, string } from "../../api/parse";
import { parseProfileVersion } from "../../api/profile-version";
import type { ProjectPersonVersion } from "../../api/auth-types";
import { parseDependencyState, parseTaskSummary } from "../../api/task-sync";
import type { Project, TaskDependencyState, TaskSummary, TaskSync } from "../../api/types";
import { TASK_CACHE_STORES, TaskCacheDatabase, TaskCacheError, type CachedProfile, type ProjectRecord, type TaskCacheSchema } from "./database";
import { validateProjectManifest, validateUserScope } from "./lifecycle";
import { GraphDataError } from "../task-graph/model";
import { compareTimestamps, maxUpdatedAt, projectSummaries, sameProject, sameSummary, type TaskProjection } from "./projection";
import { taskExecutionBinding, type TaskExecutionBinding } from "./execution-binding";

type Transaction = IDBPTransaction<TaskCacheSchema, [...typeof TASK_CACHE_STORES], "readwrite">;
export type SyncTicket = {
  readonly userId: string; readonly projectId: string; readonly userFence: string;
  readonly cacheGeneration: string; readonly epoch: string | null; readonly maxUpdatedAt: string | null;
  readonly generationAncestors?: readonly string[]; readonly unknownAncestors?: boolean;
  readonly admissionRevision?: number;
  readonly scopeRevision: number;
};
export type TaskSyncTicket = SyncTicket & {
  readonly taskBindings: ReadonlyMap<string, TaskExecutionBinding>;
};
export type TaskReadFence = {
  readonly userId: string; readonly userFence: string; readonly projectId: string; readonly taskId: string;
  readonly scopeRevision: number; readonly historyGeneration: number; readonly openingSequence: number; readonly requestGeneration: number;
};
type DirectReadBaseline = { readonly known: boolean; readonly cacheGeneration: string | null };
export type SessionHistoryRotationDenial = {
  readonly taskId: string; readonly expectedToken: string | null; readonly expectedPaginationToken?: string | null;
  readonly expectedLeaseExpiresAt?: number | null; readonly marker: string; readonly requestToken: string; readonly origin?: symbol;
};
export type CachedProject = TaskProjection & {
  readonly manifest: ProjectRecord;
  readonly summaries: ReadonlyMap<string, TaskSummary>;
  readonly dependencyStates: ReadonlyMap<string, TaskDependencyState>;
  readonly assigneeVersions: readonly ProjectPersonVersion[] | null;
};
export type DetailStore = IDBPObjectStore<TaskCacheSchema, [...typeof TASK_CACHE_STORES], "details", "readwrite">;
export type SessionHistoryStore = IDBPObjectStore<TaskCacheSchema, [...typeof TASK_CACHE_STORES], "sessionHistory", "readwrite">;
type HistorySettlement = { readonly taskId: string; readonly token: string; readonly outcome: "saved" | "failed" | "cancelled" };
type HistoryUncertain = { readonly taskId: string; readonly expectedToken: string | null; readonly expectedPaginationToken?: string | null; readonly expectedLeaseExpiresAt?: number | null; readonly unbound?: true; readonly origin?: symbol };
export type CacheEvent = { readonly projectId: string; readonly error?: unknown; readonly accessRevoked?: true; readonly accessRestored?: true; readonly scopeSuspended?: true; readonly revokedGeneration?: string; readonly unknownAncestors?: true; readonly cacheGenerationChanged?: true; readonly historyChanged?: true; readonly historyHint?: true; readonly directAccessUncertain?: true; readonly directAccessRecheck?: true; readonly taskNotFound?: true; readonly sessionHistoryCleared?: { readonly taskId: string; readonly token: string; readonly origin?: symbol }; readonly sessionHistorySettled?: HistorySettlement; readonly sessionHistoryUncertain?: HistoryUncertain };
type Hint = { readonly userId: string; readonly projectId: string | null; readonly revokedGeneration?: string; readonly userFence?: string; readonly cacheGeneration?: string; readonly generationAncestors?: readonly string[]; readonly unknownAncestors?: boolean; readonly retiredEpoch?: string; readonly uncertainEpoch?: string; readonly sessionHistoryCleared?: { readonly taskId: string; readonly token: string }; readonly sessionHistorySettled?: HistorySettlement; readonly sessionHistoryUncertain?: HistoryUncertain; readonly directSessionDenied?: { readonly taskId: string; readonly epoch: string; readonly manifestAbsent?: true }; readonly unboundProjectDenial?: true; readonly authoritative?: true };
export class TaskCacheLifecycleChanged extends DOMException {
  constructor(readonly retryable = true) { super("The task cache lifecycle changed.", "AbortError"); }
}
export const isRetryableTaskCacheLifecycleChange = (error: unknown): error is TaskCacheLifecycleChanged =>
  error instanceof TaskCacheLifecycleChanged && error.retryable;
const released = (): never => { throw new TaskCacheLifecycleChanged(); };
const protocol = (): never => { throw new ApiError("protocol"); };
const invalidated = (userId: string, projectId: string, userFence: string, invalidatedBy: "access" | "corrupt" | "user" = "access", history?: { readonly generationAncestors: readonly string[]; readonly unknownAncestors: boolean }): ProjectRecord => ({
  userId, projectId, userFence, cacheGeneration: crypto.randomUUID(), state: "invalidated", invalidatedBy,
  ...(history === undefined ? {} : history),
  epoch: null, project: null, maxUpdatedAt: null, taskCount: 0, edgeCount: 0,
});
const edgeCount = (tasks: readonly TaskSummary[]): number => tasks.reduce((count, task) => count + task.dependsOn.length, 0);
type StoredTasks = { readonly tasks: readonly TaskSummary[]; readonly dependencyStates: ReadonlyMap<string, TaskDependencyState> };
const sameDependencyState = (left: TaskDependencyState | undefined, right: TaskDependencyState | undefined): boolean =>
  left === right || left !== undefined && right !== undefined && left.taskVersion === right.taskVersion && left.ready === right.ready &&
  left.blockedBy.length === right.blockedBy.length && left.blockedBy.every((id, index) => id === right.blockedBy[index]);
const validDependencyState = (task: TaskSummary, state: TaskDependencyState): boolean =>
  task.type === "task" && task.version === state.taskVersion &&
  state.blockedBy.every(id => task.dependsOn.includes(id)) &&
  state.ready === (task.status === "todo" && state.blockedBy.length === 0) &&
  !((task.status === "in_progress" || task.status === "done") && state.blockedBy.length !== 0);
const nextHistory = (manifest: ProjectRecord) => ({ generationAncestors: [manifest.cacheGeneration, ...(manifest.generationAncestors ?? [])], unknownAncestors: manifest.unknownAncestors === true });
const recoverHistory = (value: ProjectRecord | undefined, userId: string, projectId: string, userFence: string) => {
  if (value === undefined || value.userId !== userId || value.projectId !== projectId || value.userFence !== userFence ||
    typeof value.cacheGeneration !== "string" || canonicalId(value.cacheGeneration) !== value.cacheGeneration) return { generationAncestors: [], unknownAncestors: true };
  const ancestors = value.generationAncestors === undefined ? [] : value.generationAncestors;
  if (!Array.isArray(ancestors) || ancestors.some(item => typeof item !== "string" || canonicalId(item) !== item) ||
    new Set(ancestors).size !== ancestors.length || ancestors.includes(value.cacheGeneration) ||
    value.unknownAncestors !== undefined && typeof value.unknownAncestors !== "boolean") return { generationAncestors: [value.cacheGeneration], unknownAncestors: true };
  return nextHistory(value);
};

const mergeProject = (current: Project, incoming: Project): Project => {
  if (current.settings.version === incoming.settings.version && current.settings.executionWarningMinutes !== incoming.settings.executionWarningMinutes) return protocol();
  if (current.ownership.version === incoming.ownership.version && current.ownership.teamId !== incoming.ownership.teamId) return protocol();
  const base = compareTimestamps(current.updatedAt, incoming.updatedAt) > 0 ? current : incoming;
  const settings = current.settings.version > incoming.settings.version ? current.settings : incoming.settings;
  const ownership = current.ownership.version > incoming.ownership.version ? current.ownership : incoming.ownership;
  const merged = { ...base, settings, ownership };
  return sameProject(current, merged) ? current : merged;
};

export class TaskCacheScope {
  readonly userId: string;
  private readonly database: TaskCacheDatabase;
  private readonly channel: BroadcastChannel | null;
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<(event: CacheEvent) => void>();
  private readonly projectionListeners = new Set<(event: CacheEvent) => void>();
  private readonly projectionHints = new Set<Promise<void>>();
  private readonly projectionHintProjects = new Map<Promise<void>, string>();
  private readonly projections = new Map<string, CachedProject>();
  private readonly authorizedProjects = new Set<string>();
  private readonly admissionRevisions = new Map<string, number>();
  private readonly onlineGenerations = new Map<string, string>();
  private readonly historyPreviews = new Map<string, SyncTicket>();
  private readonly uncertainHistory = new Map<string, { readonly userFence: string; readonly cacheGeneration: string; readonly expectedToken: string | null; readonly expectedPaginationToken?: string | null; readonly expectedLeaseExpiresAt?: number | null; readonly unbound: boolean; readonly revision: number; readonly allowedToken: string | null }>();
  private uncertaintyRevision = 0;
  private readonly suspendedProjects = new Set<string>();
  private readonly unboundProjectDenials = new Map<string, { readonly revision: number; isolated: boolean; direct: boolean; error: unknown; timer: ReturnType<typeof setTimeout> | null; retry: (() => void) | null; inFlight: boolean; retryRequested: boolean }>();
  private readonly readableProjects = new Map<string, number>();
  private readonly projectReadRevisions = new Map<string, number>();
  private readonly pendingUnknownProjects = new Map<string, { count: number; readonly baseRevision: number; readonly isolationRevision: number }>();
  private readonly projectRevisions = new Map<string, number>();
  private readonly directRevisions = new Map<string, number>();
  private readonly directReadBaselines = new WeakMap<TaskReadFence, DirectReadBaseline>();
  private readonly directAuthorizedRevisions = new Map<string, number>();
  private readonly directProjects = new Set<string>();
  private readonly directHintCounts = new Map<string, number>();
  private readonly directRecheckPending = new Set<string>();
  private readonly directRecheckWorks = new Map<string, Promise<void>>();
  private readonly directRecheckErrors = new Map<string, unknown>();
  private readonly uncertainDirectRevisions = new Map<string, Set<number>>();
  private readonly histories = new Map<string, { epoch: string | null; generation: number }>();
  private readonly conflictingManifests = new Map<string, { readonly liveEpoch: string; readonly userFence: string; readonly cacheGeneration: string; readonly epoch: string }>();
  private readonly retiredEpochs = new Map<string, Set<string>>();
  private readonly historyVersions = new Map<string, number>();
  private readonly ticketHistoryVersions = new WeakMap<object, number>();
  private readonly uncertainHistories = new Set<string>();
  private readonly historyPurges = new Map<string, Promise<void>>();
  private readonly historyPurgeEpochs = new Map<string, string>();
  private readonly pending = new Set<Transaction>();
  private readonly admittedTransactions = new Set<Transaction>();
  // Retired generations also fence results whose transactions committed before access withdrawal.
  private readonly revokedGenerations = new Map<string, Set<string>>();
  private readonly withdrawnProjects = new Set<string>();
  private projectionFailure: TaskCacheError | null = null;
  private corruptProjectionProjects = new Set<string>();
  private readonly projectionSnapshotFailures = new WeakMap<ReadonlyMap<string, string>, TaskCacheError>();
  private readonly projectionSnapshotCorrupt = new WeakMap<ReadonlyMap<string, string>, ReadonlySet<string>>();
  private readonly projectionSnapshotSuspended = new WeakMap<ReadonlyMap<string, string>, ReadonlySet<string>>();
  private readonly projectionSnapshotAncestors = new WeakMap<ReadonlyMap<string, string>, ReadonlyMap<string, readonly string[]>>();
  private readonly deniedProjects = new Map<string, SyncTicket>();
  private readonly projectPurges = new Map<string, Promise<void>>();
  private invalidated = false;
  private identityMismatch = false;
  private readonly admission = new AbortController();
  get hasIdentityMismatch(): boolean { return this.identityMismatch; }
  private disposed = false;
  private purge: Promise<void> | null = null;
  private userFence: string | null = null;
  get isInvalidated(): boolean { return this.invalidated || this.disposed; }

  constructor(options: { readonly userId: string; readonly onIdentityMismatch: () => void }) {
    this.userId = requestId(options.userId);
    this.onIdentityMismatch = options.onIdentityMismatch;
    this.database = new TaskCacheDatabase((error) => {
      if (error.category === "versionchange") {
        const projects = [...this.authorizedProjects];
        const listeners = [...this.listeners];
        this.close();
        for (const projectId of projects) for (const listener of listeners) listener({ projectId, error });
        return;
      }
      for (const projectId of this.authorizedProjects) this.emit({ projectId, error });
    });
    // Cache hints are optional; blocked channel creation must not prevent the
    // confirmed account from opening its local scope.
    let channel: BroadcastChannel | null = null;
    try { if (typeof BroadcastChannel !== "undefined") channel = new BroadcastChannel("daynight-task-cache"); } catch { /* Local cache remains available without hints. */ }
    this.channel = channel;
    if (this.channel !== null) this.channel.onmessage = (event: MessageEvent<unknown>) => {
      const hint = event.data;
      if (typeof hint !== "object" || hint === null || !("userId" in hint) || hint.userId !== this.userId || !("projectId" in hint)) return;
      if (hint.projectId !== null && typeof hint.projectId !== "string") return;
      if (this.identityMismatch && !("revokedGeneration" in hint) && !("unboundProjectDenial" in hint)) return;
      if ("unboundProjectDenial" in hint) {
        if (hint.unboundProjectDenial !== true || typeof hint.projectId !== "string" || canonicalId(hint.projectId) !== hint.projectId) return;
        this.receiveUnboundProjectDenial(hint.projectId);
        return;
      }
      if ("uncertainEpoch" in hint) {
        if (typeof hint.projectId !== "string" || canonicalId(hint.projectId) !== hint.projectId ||
          !("userFence" in hint) || hint.userFence !== this.userFence || typeof hint.uncertainEpoch !== "string" || canonicalId(hint.uncertainEpoch) !== hint.uncertainEpoch) return;
        this.fenceGoalEpoch(hint.projectId);
        return;
      }
      if ("retiredEpoch" in hint) {
        if (typeof hint.projectId !== "string" || canonicalId(hint.projectId) !== hint.projectId ||
          !("userFence" in hint) || hint.userFence !== this.userFence || typeof hint.retiredEpoch !== "string" || canonicalId(hint.retiredEpoch) !== hint.retiredEpoch) return;
        this.retireKnownEpoch(hint.projectId, hint.retiredEpoch);
        return;
      }
      if ("directSessionDenied" in hint) {
        const denied = hint.directSessionDenied;
        if (typeof hint.projectId !== "string" || canonicalId(hint.projectId) !== hint.projectId ||
          !("userFence" in hint) || typeof hint.userFence !== "string" || canonicalId(hint.userFence) !== hint.userFence ||
          typeof denied !== "object" || denied === null || !("taskId" in denied) || typeof denied.taskId !== "string" || canonicalId(denied.taskId) !== denied.taskId ||
          !("epoch" in denied) || typeof denied.epoch !== "string" || canonicalId(denied.epoch) !== denied.epoch ||
          "manifestAbsent" in denied && denied.manifestAbsent !== true) return;
        void this.receiveDirectSessionDenied(hint.projectId, hint.userFence, denied.taskId, denied.epoch, "manifestAbsent" in denied).catch(() => {});
        return;
      }
      if ("sessionHistoryUncertain" in hint) {
        const marker = hint.sessionHistoryUncertain;
        if (typeof hint.projectId !== "string" || canonicalId(hint.projectId) !== hint.projectId ||
          !("userFence" in hint) || typeof hint.userFence !== "string" || canonicalId(hint.userFence) !== hint.userFence ||
          !("cacheGeneration" in hint) || typeof hint.cacheGeneration !== "string" || canonicalId(hint.cacheGeneration) !== hint.cacheGeneration ||
          typeof marker !== "object" || marker === null || !("taskId" in marker) || typeof marker.taskId !== "string" || canonicalId(marker.taskId) !== marker.taskId ||
          !("expectedToken" in marker) || marker.expectedToken !== null && (typeof marker.expectedToken !== "string" || canonicalId(marker.expectedToken) !== marker.expectedToken) ||
          "expectedPaginationToken" in marker && marker.expectedPaginationToken !== null && (typeof marker.expectedPaginationToken !== "string" || canonicalId(marker.expectedPaginationToken) !== marker.expectedPaginationToken) ||
          "expectedLeaseExpiresAt" in marker && marker.expectedLeaseExpiresAt !== null && (typeof marker.expectedLeaseExpiresAt !== "number" || !Number.isSafeInteger(marker.expectedLeaseExpiresAt) || marker.expectedLeaseExpiresAt < 0) ||
          "unbound" in marker && marker.unbound !== true) return;
        void this.receiveHistoryUncertain(hint.projectId, hint.userFence, hint.cacheGeneration, marker.taskId, marker.expectedToken, "unbound" in marker,
          "expectedPaginationToken" in marker ? marker.expectedPaginationToken as string | null : undefined,
          "expectedLeaseExpiresAt" in marker ? marker.expectedLeaseExpiresAt as number | null : undefined).catch(() => {});
        return;
      }
      if ("sessionHistorySettled" in hint) {
        const marker = hint.sessionHistorySettled;
        if (typeof hint.projectId !== "string" || canonicalId(hint.projectId) !== hint.projectId ||
          !("userFence" in hint) || typeof hint.userFence !== "string" || canonicalId(hint.userFence) !== hint.userFence ||
          !("cacheGeneration" in hint) || typeof hint.cacheGeneration !== "string" || canonicalId(hint.cacheGeneration) !== hint.cacheGeneration ||
          typeof marker !== "object" || marker === null || !("taskId" in marker) || typeof marker.taskId !== "string" || canonicalId(marker.taskId) !== marker.taskId ||
          !("token" in marker) || typeof marker.token !== "string" || canonicalId(marker.token) !== marker.token ||
          !("outcome" in marker) || marker.outcome !== "saved" && marker.outcome !== "failed" && marker.outcome !== "cancelled") return;
        void this.receiveHistorySettlement(hint.projectId, hint.userFence, hint.cacheGeneration, { taskId: marker.taskId, token: marker.token, outcome: marker.outcome }).catch((error: unknown) => {
          if (!isAbortError(error)) this.emit({ projectId: hint.projectId as string, error });
        });
        return;
      }
      if ("sessionHistoryCleared" in hint) {
        const marker = hint.sessionHistoryCleared;
        if (typeof hint.projectId !== "string" || canonicalId(hint.projectId) !== hint.projectId ||
          !("userFence" in hint) || typeof hint.userFence !== "string" || canonicalId(hint.userFence) !== hint.userFence ||
          !("cacheGeneration" in hint) || typeof hint.cacheGeneration !== "string" || canonicalId(hint.cacheGeneration) !== hint.cacheGeneration ||
          typeof marker !== "object" || marker === null || !("taskId" in marker) || typeof marker.taskId !== "string" || canonicalId(marker.taskId) !== marker.taskId ||
          !("token" in marker) || typeof marker.token !== "string" || canonicalId(marker.token) !== marker.token) return;
        void this.receiveHistoryClear(hint.projectId, hint.userFence, hint.cacheGeneration, marker.taskId, marker.token).catch((error: unknown) => {
          if (!isAbortError(error) && !this.identityMismatch) {
            const projectId = hint.projectId as string;
            this.historyPreviews.delete(projectId); this.projections.delete(projectId);
            this.projectRevisions.set(projectId, this.getProjectRevision(projectId) + 1);
            this.emit({ projectId, cacheGenerationChanged: true, error });
          }
        });
        return;
      }
      if ("revokedGeneration" in hint) {
        if (typeof hint.projectId !== "string" || canonicalId(hint.projectId) !== hint.projectId || typeof hint.revokedGeneration !== "string" || canonicalId(hint.revokedGeneration) !== hint.revokedGeneration ||
          !("userFence" in hint) || typeof hint.userFence !== "string" || canonicalId(hint.userFence) !== hint.userFence ||
          "authoritative" in hint && hint.authoritative !== true) return;
        const ancestors = "generationAncestors" in hint ? hint.generationAncestors : [];
        if (!Array.isArray(ancestors) || ancestors.some((value: unknown) => typeof value !== "string" || canonicalId(value) !== value) || new Set(ancestors).size !== ancestors.length || ancestors.includes(hint.revokedGeneration) ||
          "unknownAncestors" in hint && typeof hint.unknownAncestors !== "boolean") return;
        if (this.userFence !== hint.userFence) {
          if (this.userFence === null) {
            if ("authoritative" in hint) this.suspendProject(hint.projectId);
            else if (this.readableProjects.has(hint.projectId)) this.receiveUnboundProjectDenial(hint.projectId);
          }
          return;
        }
        if (this.identityMismatch && this.readableProjects.has(hint.projectId) && !this.projections.has(hint.projectId) && !this.historyPreviews.has(hint.projectId) && !this.directProjects.has(hint.projectId)) this.receiveUnboundProjectDenial(hint.projectId);
        else if (this.identityMismatch) this.receiveRetainedNegative(hint.projectId, hint.revokedGeneration, ancestors, "unknownAncestors" in hint && hint.unknownAncestors === true);
        else if ("authoritative" in hint && !this.projections.has(hint.projectId) && !this.historyPreviews.has(hint.projectId)) this.suspendProject(hint.projectId);
        else if (!("authoritative" in hint) && this.readableProjects.has(hint.projectId) && !this.projections.has(hint.projectId) && !this.historyPreviews.has(hint.projectId) && !this.directProjects.has(hint.projectId)) this.receiveUnboundProjectDenial(hint.projectId);
        else this.receiveNegative(hint.projectId, hint.userFence, hint.revokedGeneration, ancestors, "unknownAncestors" in hint && hint.unknownAncestors === true);
        return;
      }
      void this.receiveHint({ userId: this.userId, projectId: hint.projectId }).catch((error: unknown) => {
        if (!isAbortError(error)) for (const projectId of this.authorizedProjects) this.emit({ projectId, error });
      });
    };
  }
  // A peer's independently confirmed withdrawal remains authoritative for a
  // retained projection, but must not reopen this scope's durable admission.
  private receiveRetainedNegative(projectId: string, generation: string, history: readonly string[], unknownAncestors: boolean): void {
    const current = this.projections.get(projectId)?.manifest ?? this.historyPreviews.get(projectId);
    const matches = current !== undefined && (current.cacheGeneration === generation || history.includes(current.cacheGeneration));
    const incomparable = unknownAncestors && current !== undefined && !(current.generationAncestors ?? []).includes(generation);
    const direct = this.directProjects.has(projectId);
    let retired = this.revokedGenerations.get(projectId);
    if (retired === undefined) { retired = new Set(); this.revokedGenerations.set(projectId, retired); }
    const newlyRetired = [...new Set([generation, ...history])].filter(value => !retired!.has(value));
    for (const value of newlyRetired) retired.add(value);
    if (newlyRetired.length === 0 && !direct) return;
    if (direct) this.fenceUncertainDirectHistory(projectId);
    if (matches || incomparable) {
      this.projectRevisions.set(projectId, this.getProjectRevision(projectId) + 1);
      this.projections.delete(projectId); this.authorizedProjects.delete(projectId); this.historyPreviews.delete(projectId);
      this.withdrawnProjects.add(projectId); this.clearProjectHistoryUncertainty(projectId);
    }
    const event: CacheEvent = { projectId, ...(matches || incomparable ? { accessRevoked: true as const } : {}),
      ...(direct ? { directAccessUncertain: true as const } : {}), revokedGeneration: generation,
      ...(unknownAncestors ? { unknownAncestors: true as const } : {}), error: new ApiError("server", 404, "not_found") };
    if (matches || incomparable || direct) for (const listener of this.listeners) listener(event);
    for (const value of newlyRetired) for (const listener of this.projectionListeners) listener({ projectId, accessRevoked: true, revokedGeneration: value,
      ...(unknownAncestors ? { unknownAncestors: true as const } : {}), error: new ApiError("server", 404, "not_found") });
  }
  private receiveNegative(projectId: string, userFence: string, generation: string, history: readonly string[] = [], unknownAncestors = false): void {
    let retired = this.revokedGenerations.get(projectId);
    if (retired === undefined) { retired = new Set(); this.revokedGenerations.set(projectId, retired); }
    const newlyRetired = [...new Set([generation, ...history])].filter(value => !retired!.has(value));
    const directAmbiguous = this.directProjects.has(projectId);
    if (newlyRetired.length === 0 && !directAmbiguous) return;
    for (const value of newlyRetired) retired.add(value);
    const current = this.projections.get(projectId)?.manifest ?? this.historyPreviews.get(projectId);
    const matchesCurrent = current !== undefined && (current.cacheGeneration === generation || history.includes(current.cacheGeneration));
    if (directAmbiguous) {
      const count = this.directHintCounts.get(projectId) ?? 0;
      this.directHintCounts.set(projectId, count + 1);
      if (count === 0) this.fenceUncertainDirectHistory(projectId);
      if (matchesCurrent) {
        this.projectRevisions.set(projectId, this.getProjectRevision(projectId) + 1);
        this.projections.delete(projectId); this.authorizedProjects.delete(projectId); this.historyPreviews.delete(projectId);
        this.withdrawnProjects.add(projectId); this.clearProjectHistoryUncertainty(projectId);
      }
      if (count === 0 || matchesCurrent) this.emit({ projectId, directAccessUncertain: true, ...(matchesCurrent ? { accessRevoked: true as const, error: new ApiError("server", 404, "not_found") } : {}) }, true, true);
    }
    let unknownNotified = false, provisional = false;
    let ticket: SyncTicket = { userId: this.userId, projectId, userFence, cacheGeneration: generation,
      epoch: current?.epoch ?? null, maxUpdatedAt: current?.maxUpdatedAt ?? null,
      generationAncestors: history, unknownAncestors, scopeRevision: this.getProjectRevision(projectId), admissionRevision: this.getAdmissionRevision(projectId) };
    const isolateUnknown = (): void => {
      if (!unknownAncestors || unknownNotified || this.isInvalidated || this.identityMismatch) return;
      unknownNotified = true;
      provisional = !matchesCurrent && (current === undefined || !(current.generationAncestors ?? []).includes(generation));
      if (provisional) {
        let pending = this.pendingUnknownProjects.get(projectId);
        if (pending === undefined) {
          const revision = this.getProjectRevision(projectId);
          pending = { count: 0, baseRevision: revision, isolationRevision: revision + 1 };
          this.pendingUnknownProjects.set(projectId, pending);
          this.projectRevisions.set(projectId, pending.isolationRevision);
          this.fenceUncertainDirectHistory(projectId);
        }
        pending.count++;
        // Hints captured before this shared isolation may adopt only its own
        // revision, never an intervening suspension or replacement history.
        if (ticket.scopeRevision === pending.baseRevision && this.getProjectRevision(projectId) === pending.isolationRevision) {
          ticket = { ...ticket, scopeRevision: pending.isolationRevision };
        }
      }
      const event = { projectId, accessRevoked: true as const, scopeSuspended: true as const, revokedGeneration: generation, unknownAncestors: true as const, ...(directAmbiguous ? { directAccessUncertain: true as const } : {}) };
      if (provisional) this.emit(event); else this.emitProjection(event);
    };
    let unsubscribePause = unknownAncestors ? subscribeAuthPause(isolateUnknown) : null;
    const stopPause = (): void => { const stop = unsubscribePause; unsubscribePause = null; stop?.(); };
    const releaseProvisional = (): boolean => {
      if (!provisional) return true;
      const pending = this.pendingUnknownProjects.get(projectId);
      if (pending !== undefined && pending.count > 1) { pending.count--; return false; }
      this.pendingUnknownProjects.delete(projectId); return true;
    };
    // Exact generations can be withdrawn immediately. An unknown predecessor is
    // resolved against durable state before it can affect an incomparable history.
    const immediate = matchesCurrent
      ? this.revokeProject(ticket, this.signal, false, new ApiError("server", 404, "not_found"), false).then(() => {})
      : Promise.resolve();
    const action = immediate.then(async () => {
      if (!unknownAncestors && current !== undefined) return;
      let matches: boolean;
      for (;;) {
        try {
          await this.ready(this.signal);
          matches = await this.userTransaction(async (transaction, fence) => {
            const manifest = await this.manifest(transaction, projectId, fence);
            return fence === userFence && (manifest?.cacheGeneration === generation ||
              manifest?.state === "invalidated" && manifest.invalidatedBy === "access" && manifest.generationAncestors?.[0] === generation);
          }, this.signal);
          break;
        } catch (error) {
          // A new foreground check may interrupt the durable read; retain the
          // provisional isolation until the same live scope can check again.
          if (isRetryableTaskCacheLifecycleChange(error) && !this.isInvalidated && !this.signal.aborted) continue;
          if (!unknownAncestors || isAbortError(error)) throw error;
          stopPause();
          this.emitProjection({ projectId, accessRevoked: true, revokedGeneration: generation, unknownAncestors: true, error });
          releaseProvisional();
          if (!matchesCurrent) void this.revokeProject(ticket, this.signal, false, new ApiError("server", 404, "not_found"), false).catch(() => {});
          throw error;
        }
      }
      stopPause();
      const released = releaseProvisional();
      if (directAmbiguous) {
        const latest = this.projections.get(projectId)?.manifest ?? this.historyPreviews.get(projectId);
        if (matches && unknownAncestors && !matchesCurrent && current !== undefined && latest?.userFence === current.userFence &&
          latest.cacheGeneration === current.cacheGeneration && ticket.admissionRevision === this.getAdmissionRevision(projectId) &&
          ticket.scopeRevision === this.getProjectRevision(projectId) && this.canRevokeProject(ticket)) {
          const cleanup = this.revokeProject(ticket, this.signal, false, new ApiError("server", 404, "not_found"), false);
          this.emitProjection({ projectId, accessRevoked: true, revokedGeneration: generation,
            unknownAncestors: true, error: new ApiError("server", 404, "not_found") });
          await cleanup;
        }
        return;
      }
      if (!matches) {
        if (released && provisional) this.emit({ projectId, accessRestored: true });
        else if (unknownNotified && !provisional) this.emitProjection({ projectId, accessRestored: true });
        return;
      }
      if (unknownAncestors && !unknownNotified) this.emitProjection({ projectId, accessRevoked: true, revokedGeneration: generation, unknownAncestors: true, error: new ApiError("server", 404, "not_found") });
      if (!matchesCurrent) {
        const revoked = await this.revokeProject(ticket, this.signal, false, new ApiError("server", 404, "not_found"), false);
        if (!revoked && released && provisional) this.emit({ projectId, accessRestored: true });
      }
    });
    const work = action.catch((error: unknown) => {
      if (!isAbortError(error)) {
        for (const value of newlyRetired) this.emitProjection({ projectId, accessRevoked: true, revokedGeneration: value, error });
        console.warn("Task cache access cleanup failed", { projectId, error_category: error instanceof TaskCacheError ? error.category : "protocol" });
      }
    }).finally(() => {
      stopPause(); this.projectionHints.delete(work); this.projectionHintProjects.delete(work);
      if (directAmbiguous && !this.isInvalidated) {
        const count = this.directHintCounts.get(projectId) ?? 0;
        if (count > 1) this.directHintCounts.set(projectId, count - 1);
        else { this.directHintCounts.delete(projectId); this.directRecheckPending.add(projectId); this.requestDirectAccessRecheck(projectId); }
      }
    });
    this.projectionHints.add(work);
    this.projectionHintProjects.set(work, projectId);
    if (authRequestsPaused()) isolateUnknown();
    for (const value of newlyRetired) this.emitProjection({ projectId, accessRevoked: true, revokedGeneration: value, error: new ApiError("server", 404, "not_found") });
  }
  private readonly onIdentityMismatch: () => void;
  private assertLive(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.invalidated || this.disposed || this.lifetime.signal.aborted || authRequestsPaused()) released();
  }
  get signal(): AbortSignal { return this.lifetime.signal; }
  get mismatchSignal(): AbortSignal { return this.admission.signal; }
  private assertAdmitted(signal?: AbortSignal): void {
    if (this.identityMismatch) throw new TaskCacheLifecycleChanged(false);
    this.assertLive(signal);
  }
  async ready(signal: AbortSignal): Promise<void> {
    if (this.identityMismatch) throw new TaskCacheLifecycleChanged(false);
    await waitForAuthRequests(AbortSignal.any([signal, this.lifetime.signal, this.admission.signal]));
    this.assertAdmitted(signal);
  }
  principalMismatch = (): void => {
    if (this.identityMismatch) return;
    this.identityMismatch = true;
    try { this.onIdentityMismatch(); }
    finally {
      this.admission.abort(new TaskCacheLifecycleChanged(false));
      for (const transaction of this.admittedTransactions) { try { transaction.abort(); } catch { /* Already committed. */ } }
    }
  };
  subscribe = (listener: (event: CacheEvent) => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  subscribeProjection = (listener: (event: CacheEvent) => void): (() => void) => {
    this.projectionListeners.add(listener);
    return () => { this.projectionListeners.delete(listener); };
  };
  private emitProjection(event: CacheEvent): void {
    if (this.invalidated || this.disposed || this.identityMismatch) return;
    for (const listener of this.projectionListeners) listener(event);
  }
  private emit(event: CacheEvent, notifyProjection = true, allowAuthPaused = false): void {
    if (this.invalidated || this.disposed || this.identityMismatch || !allowAuthPaused && authRequestsPaused() && event.accessRevoked !== true && event.sessionHistoryUncertain?.unbound !== true) return;
    for (const listener of this.listeners) listener(event);
    if (notifyProjection && (event.accessRevoked || event.accessRestored)) this.emitProjection(event);
  }
  async prepareProjection(signal: AbortSignal): Promise<ReadonlyMap<string, string>> {
    for (;;) {
      try { return await this.prepareProjectionOnce(signal); }
      catch (error) {
        // A foreground identity check can interrupt the durable snapshot without
        // retiring this scope or the caller's request.
        if (isRetryableTaskCacheLifecycleChange(error) && !signal.aborted && !this.isInvalidated) continue;
        throw error;
      }
    }
  }
  private async prepareProjectionOnce(signal: AbortSignal): Promise<ReadonlyMap<string, string>> {
    await this.ready(signal);
    // A read started after a negative hint must wait for its cleanup, including failures.
    await Promise.allSettled([...this.projectionHints, ...this.projectPurges.values()]);
    await Promise.allSettled([...this.deniedProjects.keys()].map((projectId) => this.clearDeniedProject(projectId)));
    try {
      const { generations, corrupt, histories } = await this.userTransaction(async (transaction, fence) => {
        const rows = await transaction.objectStore("projects").index("by-user").getAll(this.userId);
        const generations = new Map<string, string>();
        const histories = new Map<string, readonly string[]>();
        const corrupt = new Set<string>();
        for (const row of rows) {
          if (typeof row.projectId !== "string" || canonicalId(row.projectId) !== row.projectId) continue;
          const history = row.generationAncestors === undefined ? [] : row.generationAncestors;
          if (row.userId !== this.userId || row.userFence !== fence || typeof row.cacheGeneration !== "string" || canonicalId(row.cacheGeneration) !== row.cacheGeneration ||
            !Array.isArray(history) || history.some(value => typeof value !== "string" || canonicalId(value) !== value) || new Set(history).size !== history.length || history.includes(row.cacheGeneration) ||
            row.unknownAncestors !== undefined && typeof row.unknownAncestors !== "boolean") corrupt.add(row.projectId);
          else { generations.set(row.projectId, row.cacheGeneration); histories.set(row.projectId, history); }
        }
        return { generations, corrupt, histories };
      }, signal);
      this.projectionFailure = null;
      this.corruptProjectionProjects = corrupt;
      this.projectionSnapshotCorrupt.set(generations, corrupt);
      this.projectionSnapshotSuspended.set(generations, new Set([...this.suspendedProjects, ...[...this.unboundProjectDenials].filter(([, value]) => value.isolated).map(([id]) => id), ...this.pendingUnknownProjects.keys()]));
      this.projectionSnapshotAncestors.set(generations, histories);
      return generations;
    } catch (error) {
      if (!(error instanceof TaskCacheError)) throw error;
      this.projectionFailure = error;
      const failed = new Map<string, string>();
      this.projectionSnapshotFailures.set(failed, error);
      return failed;
    }
  }
  projectionSnapshotFailed(snapshot: ReadonlyMap<string, string>): boolean { return this.projectionSnapshotFailures.has(snapshot); }
  projectionEventMatches(snapshot: ReadonlyMap<string, string> | null, event: CacheEvent): boolean {
    if (snapshot === null || event.revokedGeneration === undefined) return true;
    const observed = snapshot.get(event.projectId);
    if (observed === undefined || observed === event.revokedGeneration) return true;
    if (!event.unknownAncestors) return false;
    return this.projectionSnapshotAncestors.get(snapshot)?.get(event.projectId)?.includes(event.revokedGeneration) !== true;
  }
  projectionSnapshotDenied(snapshot: ReadonlyMap<string, string>, projectId: string): boolean {
    return this.projectionSnapshotFailed(snapshot) || this.projectionSnapshotCorrupt.get(snapshot)?.has(projectId) === true ||
      this.projectionSnapshotSuspended.get(snapshot)?.has(projectId) === true || this.isProjectionDenied(projectId);
  }
  projectionSnapshotHasDenials(snapshot: ReadonlyMap<string, string>): boolean {
    return this.projectionSnapshotFailed(snapshot) || (this.projectionSnapshotCorrupt.get(snapshot)?.size ?? 0) > 0 ||
      (this.projectionSnapshotSuspended.get(snapshot)?.size ?? 0) > 0 || this.hasProjectionDenials;
  }
  projectionSnapshotError(snapshot: ReadonlyMap<string, string>): TaskCacheError | null {
    return this.projectionSnapshotFailures.get(snapshot) ?? ((this.projectionSnapshotCorrupt.get(snapshot)?.size ?? 0) > 0 ? new TaskCacheError("corrupt") : this.projectionError);
  }
  get projectionError(): TaskCacheError | null { return this.projectionFailure ?? (this.corruptProjectionProjects.size ? new TaskCacheError("corrupt") : null); }
  get hasGlobalProjectionFailure(): boolean { return this.projectionFailure !== null; }
  isProjectionDenied(projectId: string): boolean { return this.projectionFailure !== null || this.corruptProjectionProjects.has(projectId) || this.deniedProjects.has(projectId) || this.isProjectSuspended(projectId); }
  get hasProjectionDenials(): boolean { return this.projectionFailure !== null || this.corruptProjectionProjects.size !== 0 || this.deniedProjects.size !== 0 || this.suspendedProjects.size !== 0 || [...this.unboundProjectDenials.values()].some(value => value.isolated) || this.pendingUnknownProjects.size !== 0; }
  reportTaskNotFound(projectId: string): void {
    if (this.identityMismatch) return;
    projectId = requestId(projectId);
    if (authRequestsPaused()) {
      void this.ready(this.signal).then(() => { this.emit({ projectId, taskNotFound: true }); }).catch(() => {});
    } else this.emit({ projectId, taskNotFound: true });
  }
  reportDirectSessionDenied(fence: TaskReadFence, epoch: string, manifestAbsent = false, origin?: symbol): boolean {
    if (!this.isTaskReadCurrent(fence, true) || this.histories.get(fence.projectId)?.epoch !== epoch) return false;
    this.channel?.postMessage({ userId: this.userId, projectId: fence.projectId, userFence: fence.userFence,
      directSessionDenied: { taskId: fence.taskId, epoch, ...(manifestAbsent ? { manifestAbsent: true } : {}) } } satisfies Hint);
    void this.receiveDirectSessionDenied(fence.projectId, fence.userFence, fence.taskId, epoch, manifestAbsent, origin).catch(() => {});
    return true;
  }
  private async receiveDirectSessionDenied(projectId: string, userFence: string, taskId: string, epoch: string, manifestAbsent = false, origin?: symbol): Promise<void> {
    const history = this.histories.get(projectId); const revision = this.getDirectRevision(projectId);
    if (this.isInvalidated || this.identityMismatch || this.userFence !== userFence || history?.epoch !== epoch || this.isDirectProjectBlocked(projectId)) return;
    if (manifestAbsent) {
      try {
        // Negative receipts can be checked during the identity gate without
        // admitting positive data or changing the stored scope.
        const manifest = await this.transaction(async (transaction) => {
          const current = validateUserScope(await transaction.objectStore("userScopes").get(this.userId), this.userId);
          if (current.userFence !== userFence) return null;
          return this.manifest(transaction, projectId, current.userFence);
        }, this.signal, true);
        if (manifest === null || this.isInvalidated || this.userFence !== userFence || revision !== this.getDirectRevision(projectId) ||
          this.histories.get(projectId)?.generation !== history.generation || manifest?.state === "active") return;
        this.emit({ projectId, sessionHistoryUncertain: { taskId, expectedToken: null, unbound: true, ...(origin === undefined ? {} : { origin }) } });
      } catch {
        if (!this.isInvalidated && this.userFence === userFence && revision === this.getDirectRevision(projectId) &&
          this.histories.get(projectId)?.generation === history.generation) this.emit({ projectId, sessionHistoryUncertain: { taskId, expectedToken: null, unbound: true, ...(origin === undefined ? {} : { origin }) } });
      }
      return;
    }
    if (!manifestAbsent) this.emit({ projectId, sessionHistoryUncertain: { taskId, expectedToken: null, unbound: true, ...(origin === undefined ? {} : { origin }) } });
    try {
      await this.ready(this.signal);
      if (revision !== this.getDirectRevision(projectId) || this.histories.get(projectId)?.generation !== history.generation) return;
      const manifest = await this.userTransaction(async (transaction, currentFence) => {
        if (currentFence !== userFence) return undefined;
        return this.manifest(transaction, projectId, currentFence);
      }, this.signal);
      if (revision !== this.getDirectRevision(projectId) || this.histories.get(projectId)?.generation !== history.generation ||
        this.userFence !== userFence) return;
      if (manifest?.state !== "active" || manifest.epoch !== epoch) return;
      const ticket: SyncTicket = { userId: this.userId, projectId, userFence, cacheGeneration: manifest.cacheGeneration, epoch,
        maxUpdatedAt: manifest.maxUpdatedAt, scopeRevision: this.getProjectRevision(projectId) };
      await this.observeHistoryUncertain(ticket, taskId, null, this.signal, true, undefined, undefined, origin);
    } catch (error) { if (isAbortError(error)) throw error; }
  }
  async revalidateProjectAccess(projectId: string, broadcast = true): Promise<boolean> {
    const revision = this.getDirectRevision(projectId);
    const ticket = await this.beginSync(projectId, this.signal);
    const projectReadRevision = this.getProjectReadRevision(projectId);
    try {
      await getProjectAccess(projectId, this.signal, { userId: this.userId, onPrincipalMismatch: this.principalMismatch });
      if (revision !== this.getDirectRevision(projectId)) return released();
      this.markProjectReadable(projectId);
    }
    catch (error) {
      if (error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found") {
        if (revision !== this.getDirectRevision(projectId) || !this.canRevokeProjectRead(ticket, projectReadRevision)) return released();
        if (!await this.revokeProject(ticket, this.signal, broadcast, error)) return released();
        return false;
      }
      throw error;
    }
    return true;
  }
  private requestDirectAccessRecheck(projectId: string): void {
    if (this.isInvalidated || this.identityMismatch || this.isProjectSuspended(projectId) || this.directHintCounts.has(projectId) || this.directRecheckWorks.has(projectId) || !this.directRecheckPending.delete(projectId)) return;
    const work = (async () => {
      try {
        for (;;) {
          const pauseRevision = authRequestsPauseRevision();
          try {
            const revision = this.getDirectRevision(projectId);
            // This check follows a peer's negative hint. Its result still
            // withdraws local data, but must not echo the same hint back.
            const accessible = await this.revalidateProjectAccess(projectId, false);
            if (accessible && (revision !== this.getDirectRevision(projectId) || this.directHintCounts.has(projectId) || this.isProjectAccessBlocked(projectId) || this.directRecheckPending.has(projectId))) {
              if (this.directHintCounts.has(projectId) || this.isProjectAccessBlocked(projectId) || this.directRecheckPending.has(projectId)) this.directRecheckPending.add(projectId);
              else {
                const error = new ApiError("protocol"); this.directRecheckErrors.set(projectId, error);
                this.emit({ projectId, directAccessRecheck: true, error }, true, true);
              }
              return;
            }
            if (accessible) {
              this.directRecheckErrors.delete(projectId);
              this.emit({ projectId, accessRestored: true, directAccessRecheck: true }, true, true);
            } else {
              const error = new ApiError("server", 404, "not_found");
              this.directRecheckErrors.set(projectId, error);
              this.emit({ projectId, directAccessRecheck: true, error }, true, true);
            }
            return;
          } catch (error) {
            if (!this.isInvalidated && (this.directHintCounts.has(projectId) || this.isProjectSuspended(projectId) || this.directRecheckPending.has(projectId))) {
              this.directRecheckPending.add(projectId); return;
            }
            if (isRetryableTaskCacheLifecycleChange(error) && !this.isInvalidated && pauseRevision !== authRequestsPauseRevision()) continue;
            throw error;
          }
        }
      } catch (error) {
        if (!this.isInvalidated && (!isAbortError(error) || isRetryableTaskCacheLifecycleChange(error))) {
          const failure = isRetryableTaskCacheLifecycleChange(error) ? new ApiError("protocol") : error;
          this.directRecheckErrors.set(projectId, failure);
          this.emit({ projectId, directAccessRecheck: true, error: failure }, true, true);
        }
      }
    })().finally(() => { this.directRecheckWorks.delete(projectId); this.requestDirectAccessRecheck(projectId); });
    this.directRecheckWorks.set(projectId, work);
  }
  private hint(projectId: string | null): void {
    this.channel?.postMessage({ userId: this.userId, projectId } satisfies Hint);
  }
  private async receiveHint(hint: Hint): Promise<void> {
    await this.ready(this.lifetime.signal);
    const observed = new Set([...this.authorizedProjects, ...this.historyPreviews.keys(), ...this.histories.keys()]);
    const projects = hint.projectId === null ? [...observed] : observed.has(hint.projectId) ? [hint.projectId] : [];
    for (const projectId of projects) {
      // Preserve a locally confirmed view until an unordered peer denial is rechecked.
      const pendingDenial = this.unboundProjectDenials.get(projectId);
      if (pendingDenial !== undefined && !pendingDenial.isolated) continue;
      // A hint carries no content or access grant; receivers read the committed stores.
      const previous = this.historyPreviews.get(projectId) ?? this.projections.get(projectId)?.manifest;
      let project: CachedProject | null;
      try { project = await this.readProjectState(projectId, this.lifetime.signal, true); }
      catch (error) {
        if (isAbortError(error)) throw error;
        this.historyPreviews.delete(projectId); this.projections.delete(projectId);
        this.projectRevisions.set(projectId, this.getProjectRevision(projectId) + 1);
        this.emit({ projectId, cacheGenerationChanged: true, error });
        continue;
      }
      this.assertLive();
      const history = this.histories.get(projectId);
      const epoch = project?.manifest.epoch ?? null;
      const conflict = history !== undefined && history.epoch !== null && epoch !== null && history.epoch !== epoch && project !== null;
      const seen = this.conflictingManifests.get(projectId);
      const historyChanged = conflict && (seen === undefined || seen.liveEpoch !== history.epoch || seen.userFence !== project!.manifest.userFence ||
        seen.cacheGeneration !== project!.manifest.cacheGeneration || seen.epoch !== epoch);
      const changed = previous !== undefined && (project === null || previous.userFence !== project.manifest.userFence || previous.cacheGeneration !== project.manifest.cacheGeneration);
      if (changed || historyChanged) {
        this.historyPreviews.delete(projectId);
        this.clearProjectHistoryUncertainty(projectId);
        this.projectRevisions.set(projectId, this.getProjectRevision(projectId) + 1);
      }
      if (historyChanged) {
        this.conflictingManifests.set(projectId, { liveEpoch: history.epoch!, userFence: project!.manifest.userFence, cacheGeneration: project!.manifest.cacheGeneration, epoch: epoch! });
        this.uncertainHistories.add(projectId);
        this.historyVersions.set(projectId, (this.historyVersions.get(projectId) ?? 0) + 1);
        this.fenceUncertainDirectHistory(projectId);
        // A peer may commit a response obtained before this scope's live
        // observation. Fence current receipts and re-read, but do not infer
        // history ordering from the stored manifest alone.
        this.projections.delete(projectId); this.authorizedProjects.delete(projectId);
      }
      this.emit(historyChanged ? { projectId, historyChanged: true, historyHint: true, cacheGenerationChanged: true } : changed ? { projectId, cacheGenerationChanged: true } : { projectId });
    }
  }
  private async receiveHistoryClear(projectId: string, userFence: string, cacheGeneration: string, taskId: string, token: string): Promise<void> {
    await this.ready(this.lifetime.signal);
    const observed = this.historyPreviews.get(projectId) ?? this.projections.get(projectId)?.manifest;
    const history = this.histories.get(projectId); const expectedEpoch = history?.epoch ?? observed?.epoch ?? null;
    const revision = this.getDirectRevision(projectId);
    if (expectedEpoch === null || this.userFence !== userFence || this.isDirectProjectBlocked(projectId)) return;
    const matches = await this.userTransaction(async (transaction, currentFence) => {
      if (currentFence !== userFence) return false;
      const manifest = await this.manifest(transaction, projectId, currentFence);
      if (manifest?.state !== "active" || manifest.epoch !== expectedEpoch || manifest.cacheGeneration !== cacheGeneration) return false;
      const row = await transaction.objectStore("sessionHistory").get([this.userId, projectId, taskId]);
      return row !== undefined && row.userId === this.userId && row.projectId === projectId && row.taskId === taskId &&
        row.userFence === userFence && row.cacheGeneration === cacheGeneration && row.clearedToken === token && row.page === null;
    }, this.lifetime.signal);
    if (matches && !this.isDirectProjectBlocked(projectId) && this.userFence === userFence && revision === this.getDirectRevision(projectId) &&
      (history === undefined || this.histories.get(projectId)?.generation === history.generation)) this.emit({ projectId, sessionHistoryCleared: { taskId, token } });
  }
  private async receiveHistorySettlement(projectId: string, userFence: string, cacheGeneration: string, settlement: HistorySettlement): Promise<void> {
    await this.ready(this.lifetime.signal);
    if (!this.authorizedProjects.has(projectId) && !this.historyPreviews.has(projectId)) return;
    const observed = this.historyPreviews.get(projectId) ?? this.projections.get(projectId)?.manifest;
    if (observed === undefined || observed.userFence !== userFence || observed.cacheGeneration !== cacheGeneration) return;
    const project = await this.readProject(projectId, this.lifetime.signal);
    if (project === null || project.manifest.userFence !== userFence || project.manifest.cacheGeneration !== cacheGeneration) return;
    const ticket: SyncTicket = { userId: this.userId, projectId, userFence, cacheGeneration, epoch: project.manifest.epoch,
      maxUpdatedAt: project.manifest.maxUpdatedAt, scopeRevision: this.getProjectRevision(projectId), admissionRevision: this.getAdmissionRevision(projectId),
      generationAncestors: project.manifest.generationAncestors ?? [], unknownAncestors: project.manifest.unknownAncestors === true };
    const matches = await this.sessionHistoryTransaction(ticket, this.lifetime.signal, async store => {
      const row = await store.get([this.userId, projectId, settlement.taskId]);
      return row !== undefined && row.userId === this.userId && row.projectId === projectId && row.taskId === settlement.taskId &&
        row.userFence === userFence && row.cacheGeneration === cacheGeneration && row.requestToken === settlement.token &&
        row.leaseExpiresAt === null && row.settled === settlement.outcome;
    });
    if (matches) {
      if (settlement.outcome === "saved") this.clearHistoryUncertain(ticket, settlement.taskId, settlement.token);
      this.emit({ projectId, sessionHistorySettled: settlement });
    }
  }
  private historyKey(projectId: string, taskId: string): string { return `${projectId}/${taskId}`; }
  private clearProjectHistoryUncertainty(projectId: string): void {
    for (const key of this.uncertainHistory.keys()) if (key.startsWith(`${projectId}/`)) this.uncertainHistory.delete(key);
  }
  isHistoryUncertain(ticket: SyncTicket, taskId: string): boolean {
    const marker = this.uncertainHistory.get(this.historyKey(ticket.projectId, taskId));
    return marker !== undefined && marker.userFence === ticket.userFence && marker.cacheGeneration === ticket.cacheGeneration;
  }
  canSaveHistoryAfterUncertain(ticket: SyncTicket, taskId: string, token: string | null): boolean {
    const marker = this.uncertainHistory.get(this.historyKey(ticket.projectId, taskId));
    return marker === undefined || marker.userFence !== ticket.userFence || marker.cacheGeneration !== ticket.cacheGeneration ||
      (marker.unbound ? token !== null && token === marker.allowedToken : marker.expectedToken !== token);
  }
  getHistoryUncertaintyRevision(ticket: SyncTicket, taskId: string): number | null {
    const marker = this.uncertainHistory.get(this.historyKey(ticket.projectId, taskId));
    return marker?.userFence === ticket.userFence && marker.cacheGeneration === ticket.cacheGeneration ? marker.revision : null;
  }
  allowHistoryUncertainToken(ticket: SyncTicket, taskId: string, revision: number | null, token: string): void {
    const key = this.historyKey(ticket.projectId, taskId); const marker = this.uncertainHistory.get(key);
    if (marker?.unbound && marker.userFence === ticket.userFence && marker.cacheGeneration === ticket.cacheGeneration && marker.revision === revision)
      this.uncertainHistory.set(key, { ...marker, allowedToken: token });
  }
  async inspectHistoryUncertain(ticket: SyncTicket, taskId: string, expectedToken: string | null, signal: AbortSignal, expectedPaginationToken?: string | null, expectedLeaseExpiresAt?: number | null): Promise<{ current: boolean; refreshing: boolean }> {
    const key = this.historyKey(ticket.projectId, taskId);
    const marker = this.uncertainHistory.get(key);
    if (marker === undefined || marker.userFence !== ticket.userFence || marker.cacheGeneration !== ticket.cacheGeneration || marker.expectedToken !== expectedToken || marker.expectedPaginationToken !== expectedPaginationToken || marker.expectedLeaseExpiresAt !== expectedLeaseExpiresAt) return { current: false, refreshing: false };
    try {
      const state = await this.sessionHistoryTransaction(ticket, signal, async store => {
        const row = await store.get([this.userId, ticket.projectId, taskId]);
        if (row === undefined) return null;
        if (row.userId !== this.userId || row.projectId !== ticket.projectId || row.taskId !== taskId || row.userFence !== ticket.userFence || row.cacheGeneration !== ticket.cacheGeneration ||
          typeof row.requestToken !== "string" || canonicalId(row.requestToken) !== row.requestToken ||
          row.paginationToken !== null && (typeof row.paginationToken !== "string" || canonicalId(row.paginationToken) !== row.paginationToken)) throw new TaskCacheError("corrupt");
        return row;
      });
      const current = this.uncertainHistory.get(key);
      if (current === undefined || current.userFence !== ticket.userFence || current.cacheGeneration !== ticket.cacheGeneration || current.expectedToken !== expectedToken || current.expectedPaginationToken !== expectedPaginationToken || current.expectedLeaseExpiresAt !== expectedLeaseExpiresAt || current.revision !== marker.revision) return { current: false, refreshing: false };
      if (state !== null && marker.unbound) {
        if (state.requestToken === marker.allowedToken && state.leaseExpiresAt === null && state.settled === "saved") {
          this.clearHistoryUncertain(ticket, taskId, state.requestToken);
          return { current: false, refreshing: false };
        }
        return { current: true, refreshing: state.requestToken === marker.allowedToken && typeof state.leaseExpiresAt === "number" && state.leaseExpiresAt > Date.now() };
      }
      if (state !== null && state.requestToken !== expectedToken) {
        if (state.leaseExpiresAt === null && state.settled === "saved") {
          this.clearHistoryUncertain(ticket, taskId, state.requestToken);
          return { current: false, refreshing: false };
        }
        return { current: true, refreshing: typeof state.leaseExpiresAt === "number" && state.leaseExpiresAt > Date.now() };
      }
      if (state !== null && expectedLeaseExpiresAt !== undefined && state.leaseExpiresAt !== expectedLeaseExpiresAt) {
        if (state.leaseExpiresAt === null && state.settled === "saved") {
          if (this.uncertainHistory.get(key)?.revision === marker.revision) this.uncertainHistory.delete(key);
          return { current: false, refreshing: false };
        }
        return { current: true, refreshing: typeof state.leaseExpiresAt === "number" && state.leaseExpiresAt > Date.now() };
      }
      if (state !== null && expectedPaginationToken !== undefined && state.paginationToken !== expectedPaginationToken)
        return { current: true, refreshing: state.paginationToken !== null };
    } catch (error) { if (isAbortError(error)) throw error; }
    return { current: true, refreshing: false };
  }
  clearHistoryUncertain(ticket: SyncTicket, taskId: string, token: string): void {
    const key = this.historyKey(ticket.projectId, taskId);
    const marker = this.uncertainHistory.get(key);
    if (marker !== undefined && marker.userFence === ticket.userFence && marker.cacheGeneration === ticket.cacheGeneration &&
      (marker.unbound ? marker.allowedToken === token : marker.expectedToken !== token)) this.uncertainHistory.delete(key);
  }
  private async observeHistoryUncertain(ticket: SyncTicket, taskId: string, expectedToken: string | null, signal: AbortSignal, unbound = false, expectedPaginationToken?: string | null, expectedLeaseExpiresAt?: number | null, origin?: symbol): Promise<boolean> {
    try {
      const current = await this.sessionHistoryTransaction(ticket, signal, async store => {
        const row = await store.get([this.userId, ticket.projectId, taskId]);
        if (row === undefined) return null;
        if (row.userId !== this.userId || row.projectId !== ticket.projectId || row.taskId !== taskId || row.userFence !== ticket.userFence ||
          row.cacheGeneration !== ticket.cacheGeneration || typeof row.requestToken !== "string" || canonicalId(row.requestToken) !== row.requestToken) throw new TaskCacheError("corrupt");
        if (row.paginationToken !== null && (typeof row.paginationToken !== "string" || canonicalId(row.paginationToken) !== row.paginationToken)) throw new TaskCacheError("corrupt");
        if (row.leaseExpiresAt !== null && (!Number.isSafeInteger(row.leaseExpiresAt) || row.leaseExpiresAt < 0)) throw new TaskCacheError("corrupt");
        return { token: row.requestToken, paginationToken: row.paginationToken, leaseExpiresAt: row.leaseExpiresAt };
      });
      if (!unbound && ((current?.token ?? null) !== expectedToken || expectedPaginationToken !== undefined && (current?.paginationToken ?? null) !== expectedPaginationToken ||
        expectedLeaseExpiresAt !== undefined && (current?.leaseExpiresAt ?? null) !== expectedLeaseExpiresAt)) return false;
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
    }
    const key = this.historyKey(ticket.projectId, taskId); const prior = this.uncertainHistory.get(key);
    const conservative = unbound || prior?.unbound === true && prior.userFence === ticket.userFence && prior.cacheGeneration === ticket.cacheGeneration;
    const marker = { userFence: ticket.userFence, cacheGeneration: ticket.cacheGeneration, expectedToken: conservative ? null : expectedToken,
      ...(!conservative && expectedPaginationToken !== undefined ? { expectedPaginationToken } : {}), ...(!conservative && expectedLeaseExpiresAt !== undefined ? { expectedLeaseExpiresAt } : {}),
      unbound: conservative, revision: ++this.uncertaintyRevision, allowedToken: null };
    this.uncertainHistory.set(key, marker);
    this.emit({ projectId: ticket.projectId, sessionHistoryUncertain: { taskId, expectedToken: marker.expectedToken, ...('expectedPaginationToken' in marker ? { expectedPaginationToken: marker.expectedPaginationToken } : {}),
      ...('expectedLeaseExpiresAt' in marker ? { expectedLeaseExpiresAt: marker.expectedLeaseExpiresAt } : {}), ...(marker.unbound ? { unbound: true } : {}), ...(origin === undefined ? {} : { origin }) } });
    return true;
  }
  async reportHistoryUncertain(ticket: SyncTicket, taskId: string, expectedToken: string | null, signal: AbortSignal, unbound = false, expectedPaginationToken?: string | null, expectedLeaseExpiresAt?: number | null, origin?: symbol): Promise<boolean> {
    const marked = await this.observeHistoryUncertain(ticket, taskId, expectedToken, signal, unbound, expectedPaginationToken, expectedLeaseExpiresAt, origin);
    if (marked)
      this.channel?.postMessage({ userId: this.userId, projectId: ticket.projectId, userFence: ticket.userFence, cacheGeneration: ticket.cacheGeneration,
        sessionHistoryUncertain: { taskId, expectedToken, ...(expectedPaginationToken !== undefined ? { expectedPaginationToken } : {}),
          ...(expectedLeaseExpiresAt !== undefined ? { expectedLeaseExpiresAt } : {}), ...(unbound ? { unbound: true } : {}) } } satisfies Hint);
    return marked;
  }
  private async receiveHistoryUncertain(projectId: string, userFence: string, cacheGeneration: string, taskId: string, expectedToken: string | null, unbound: boolean, expectedPaginationToken?: string | null, expectedLeaseExpiresAt?: number | null): Promise<void> {
    await this.ready(this.lifetime.signal);
    let observed = this.historyPreviews.get(projectId) ?? this.projections.get(projectId)?.manifest;
    if (observed === undefined) {
      const history = this.histories.get(projectId); const revision = this.getProjectRevision(projectId);
      if (history?.epoch == null || this.userFence !== userFence) return;
      const manifest = await this.userTransaction(async (transaction, currentFence) => {
        if (currentFence !== userFence) return undefined;
        return this.manifest(transaction, projectId, currentFence);
      }, this.lifetime.signal);
      if (revision !== this.getProjectRevision(projectId) || this.histories.get(projectId)?.generation !== history.generation ||
        manifest?.state !== "active" || manifest.epoch !== history.epoch) return;
      observed = manifest;
    }
    if (observed === undefined || observed.userFence !== userFence || observed.cacheGeneration !== cacheGeneration || this.userFence !== userFence) return;
    const ticket: SyncTicket = { userId: this.userId, projectId, userFence, cacheGeneration, epoch: observed.epoch,
      maxUpdatedAt: observed.maxUpdatedAt, scopeRevision: this.getProjectRevision(projectId), admissionRevision: this.getAdmissionRevision(projectId),
      generationAncestors: observed.generationAncestors ?? [], unknownAncestors: observed.unknownAncestors === true };
    await this.observeHistoryUncertain(ticket, taskId, expectedToken, this.lifetime.signal, unbound, expectedPaginationToken, expectedLeaseExpiresAt);
  }
  private async transaction<T>(work: (transaction: Transaction) => Promise<T>, signal?: AbortSignal, allowInvalidated = false): Promise<T> {
    if (!allowInvalidated) this.assertAdmitted(signal);
    const database = await this.database.open();
    if (!allowInvalidated) this.assertAdmitted(signal);
    let transaction: Transaction;
    try { transaction = database.transaction([...TASK_CACHE_STORES], "readwrite"); }
    catch (error) { throw new TaskCacheError("storage", error); }
    this.pending.add(transaction);
    if (!allowInvalidated) this.admittedTransactions.add(transaction);
    const completion = transaction.done;
    void completion.catch(() => {});
    const abort = () => { try { transaction.abort(); } catch { /* A completed transaction has no pending publication. */ } };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await work(transaction);
      if (!allowInvalidated) this.assertAdmitted(signal);
      await completion;
      if (!allowInvalidated) this.assertAdmitted(signal);
      return result;
    } catch (error) {
      abort();
      await completion.catch(() => {});
      if (!allowInvalidated && this.identityMismatch && !this.isInvalidated) throw new TaskCacheLifecycleChanged(false);
      if (error instanceof ApiError || error instanceof TaskCacheError || error instanceof TaskCacheLifecycleChanged ||
        signal?.aborted === true || !allowInvalidated && this.lifetime.signal.aborted) throw error;
      throw new TaskCacheError("storage", error);
    } finally {
      signal?.removeEventListener("abort", abort);
      this.pending.delete(transaction);
      this.admittedTransactions.delete(transaction);
    }
  }
  private async replaceUserScope(transaction: Transaction, cause: "corrupt" | "user"): Promise<string> {
    const userFence = crypto.randomUUID();
    await transaction.objectStore("userScopes").put({ userId: this.userId, userFence });
    for (const name of ["summaries", "details", "profiles", "sessionHistory"] as const) {
      for await (const cursor of transaction.objectStore(name).index("by-user").iterate(this.userId)) await cursor.delete();
    }
    for await (const cursor of transaction.objectStore("projects").index("by-user").iterate(this.userId)) {
      const projectId = cursor.primaryKey[1];
      if (canonicalId(projectId) === projectId) await cursor.update(invalidated(this.userId, projectId, userFence, cause));
      else await cursor.delete();
    }
    return userFence;
  }
  private async userTransaction<T>(work: (transaction: Transaction, userFence: string) => Promise<T>, signal: AbortSignal): Promise<T> {
    const outcome = await this.transaction(async (transaction) => {
      const stored = await transaction.objectStore("userScopes").get(this.userId);
      let userFence: string;
      try { userFence = validateUserScope(stored, this.userId).userFence; }
      catch (error) {
        if (!(error instanceof TaskCacheError) || error.category !== "corrupt") throw error;
        return { kind: "repaired" as const, userFence: await this.replaceUserScope(transaction, "corrupt") };
      }
      if (this.userFence !== null && this.userFence !== userFence) return { kind: "changed" as const, userFence };
      return { kind: "result" as const, userFence, value: await work(transaction, userFence) };
    }, signal);
    // Lifecycle changes become visible only after their transaction is durable.
    this.assertAdmitted(signal);
    if (outcome.kind === "repaired" && !this.isInvalidated && !authRequestsPaused()) this.hint(null);
    if (this.userFence !== null && this.userFence !== outcome.userFence && !this.isInvalidated) {
      this.principalMismatch();
      // Unlike a temporary gate interruption, a replaced fence cannot be retried by this scope.
      throw new TaskCacheLifecycleChanged(false);
    }
    this.assertLive(signal);
    this.userFence = outcome.userFence;
    if (outcome.kind === "repaired") return this.userTransaction(work, signal);
    if (outcome.kind === "changed") return released();
    return outcome.value;
  }
  private async manifest(transaction: Transaction, projectId: string, userFence: string): Promise<ProjectRecord | undefined> {
    const value = await transaction.objectStore("projects").get([this.userId, projectId]);
    return value === undefined ? undefined : validateProjectManifest(value, this.userId, projectId, userFence);
  }
  private async stored(transaction: Transaction, manifest: ProjectRecord): Promise<StoredTasks> {
    const rows = await transaction.objectStore("summaries").index("by-project").getAll([this.userId, manifest.projectId]);
    try {
      const dependencyStates = new Map<string, TaskDependencyState>();
      const tasks = rows.map((row) => {
        if (row.userId !== this.userId || row.projectId !== manifest.projectId || row.taskId !== row.summary.id || typeof row.summary.version !== "bigint") throw new Error("Invalid summary ownership");
        const task = parseTaskSummary({ ...row.summary, version: row.summary.version.toString() });
        if (task.type === "goal") {
          if (row.dependencyState !== null) throw new Error("Invalid goal dependency state");
        } else {
          if (row.dependencyState == null || typeof row.dependencyState.taskVersion !== "bigint") throw new Error("Missing dependency state");
          const state = parseDependencyState({ ...row.dependencyState, taskVersion: row.dependencyState.taskVersion.toString() });
          if (!validDependencyState(task, state)) throw new Error("Invalid dependency state");
          dependencyStates.set(task.id, state);
        }
        return task;
      });
      if (tasks.length !== manifest.taskCount || edgeCount(tasks) !== manifest.edgeCount ||
        maxUpdatedAt(tasks) !== manifest.maxUpdatedAt) throw new Error("Summary manifest does not match its complete set");
      projectSummaries(manifest.project!, tasks, dependencyStates, manifest.project!.updatedAt);
      return { tasks, dependencyStates };
    } catch (error) { if (error instanceof TaskCacheError || isAbortError(error)) throw error; throw new TaskCacheError("corrupt", error); }
  }
  private materialize(manifest: ProjectRecord, stored: StoredTasks, assigneeVersions?: readonly ProjectPersonVersion[], install = true): CachedProject {
    const { tasks, dependencyStates } = stored;
    const previous = this.projections.get(manifest.projectId);
    const sameTasks = previous !== undefined && previous.manifest.cacheGeneration === manifest.cacheGeneration &&
      previous.summaries.size === tasks.length && tasks.every((task) => {
        const existing = previous.summaries.get(task.id);
        return existing !== undefined && sameSummary(existing, task) && sameDependencyState(previous.dependencyStates.get(task.id), dependencyStates.get(task.id));
      });
    const project = manifest.project!;
    let projection: TaskProjection;
    if (sameTasks) {
      projection = sameProject(previous.graph.project, project) ? previous : {
        graph: { ...previous.graph, project }, index: previous.index, versions: previous.versions, pausedTaskIds: previous.pausedTaskIds, workerMachines: previous.workerMachines,
      };
    } else projection = projectSummaries(project, tasks, dependencyStates, project.updatedAt);
    const result: CachedProject = {
      ...projection, manifest,
      summaries: sameTasks ? previous.summaries : new Map(tasks.map((task) => [task.id, task])),
      dependencyStates: sameTasks ? previous.dependencyStates : dependencyStates,
      assigneeVersions: assigneeVersions ?? (previous?.manifest.cacheGeneration === manifest.cacheGeneration ? previous.assigneeVersions : null),
    };
    if (install) this.projections.set(manifest.projectId, result);
    return result;
  }
  private assertProjectGeneration(projectId: string, cacheGeneration: string, signal?: AbortSignal, revision?: number): void {
    this.assertAdmitted(signal);
    if (this.isProjectSuspended(projectId) || revision !== undefined && revision !== (this.projectRevisions.get(projectId) ?? 0)) released();
    if (this.revokedGenerations.get(projectId)?.has(cacheGeneration) === true) released();
  }
  private clearDeniedProject(projectId: string, notifyFailure = true, signal: AbortSignal = this.signal): Promise<void> {
    const active = this.projectPurges.get(projectId);
    if (active !== undefined) return active;
    const ticket = this.deniedProjects.get(projectId);
    if (ticket === undefined) return Promise.resolve();
    // Cleanup belongs to the scope; the observing dialog can unmount as soon as access is withdrawn.
    const lifetime = AbortSignal.any([signal, this.signal]);
    const work = this.ready(lifetime).then(() => this.userTransaction(async (transaction, userFence) => {
      const manifest = await this.manifest(transaction, projectId, userFence);
      if (userFence !== ticket.userFence || manifest?.cacheGeneration !== ticket.cacheGeneration) return;
      await this.clearProjectRows(transaction, projectId, true);
      await transaction.objectStore("projects").put(invalidated(this.userId, projectId, userFence, "access", nextHistory(manifest)));
    }, lifetime)).then(() => {
      if (this.deniedProjects.get(projectId) === ticket) this.deniedProjects.delete(projectId);
      this.hint(projectId);
    }).catch((error: unknown) => {
      if (notifyFailure) {
        this.emit({ projectId, accessRevoked: true, revokedGeneration: ticket.cacheGeneration, ...(ticket.unknownAncestors ? { unknownAncestors: true as const } : {}), error });
        for (const ancestor of ticket.generationAncestors ?? []) this.emitProjection({ projectId, accessRevoked: true, revokedGeneration: ancestor, error });
      }
      throw error;
    }).finally(() => { if (this.projectPurges.get(projectId) === work) this.projectPurges.delete(projectId); });
    this.projectPurges.set(projectId, work);
    return work;
  }
  canRevokeProject(ticket: SyncTicket): boolean {
    if (this.isInvalidated || this.identityMismatch || ticket.userId !== this.userId || ticket.userFence !== this.userFence || ticket.scopeRevision !== this.getProjectRevision(ticket.projectId)) return false;
    const denied = this.deniedProjects.get(ticket.projectId);
    if (denied !== undefined && (denied.userFence !== ticket.userFence || denied.cacheGeneration !== ticket.cacheGeneration)) return false;
    const manifest = this.projections.get(ticket.projectId)?.manifest ?? this.historyPreviews.get(ticket.projectId);
    if (manifest === undefined) return ticket.admissionRevision === undefined || ticket.admissionRevision === this.getAdmissionRevision(ticket.projectId);
    if (manifest.cacheGeneration !== ticket.cacheGeneration && ticket.admissionRevision !== undefined &&
      ticket.admissionRevision !== this.getAdmissionRevision(ticket.projectId)) return false;
    return manifest.userFence === ticket.userFence && (manifest.cacheGeneration === ticket.cacheGeneration ||
      (ticket.generationAncestors ?? []).includes(manifest.cacheGeneration) ||
      ticket.unknownAncestors === true && !(manifest.generationAncestors ?? []).includes(ticket.cacheGeneration));
  }
  revokeProject(ticket: SyncTicket, signal: AbortSignal, broadcast = true, reason: ApiError = new ApiError("server", 404, "not_found"), notifyProjection = true, onWithdrawn?: () => void, options?: { readonly confirmedDeletion?: boolean }): Promise<boolean> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.isInvalidated) return Promise.reject(new TaskCacheLifecycleChanged());
    if (ticket.userId !== this.userId || ticket.userFence !== this.userFence) return Promise.reject(new ApiError("protocol"));
    if (!this.canRevokeProject(ticket)) return Promise.resolve(false);
    this.projectReadRevisions.set(ticket.projectId, this.getProjectReadRevision(ticket.projectId) + 1);
    this.fenceUncertainDirectHistory(ticket.projectId);
    const denied = this.deniedProjects.get(ticket.projectId);
    let revoked = this.revokedGenerations.get(ticket.projectId);
    if (revoked === undefined) { revoked = new Set(); this.revokedGenerations.set(ticket.projectId, revoked); }
    revoked.add(ticket.cacheGeneration);
    const current = this.projections.get(ticket.projectId)?.manifest ?? this.historyPreviews.get(ticket.projectId);
    if (current !== undefined && current.cacheGeneration !== ticket.cacheGeneration) revoked.add(current.cacheGeneration);
    this.withdrawnProjects.add(ticket.projectId);
    this.readableProjects.delete(ticket.projectId);
    if (denied === undefined) this.deniedProjects.set(ticket.projectId, ticket);
    onWithdrawn?.();
    this.projections.delete(ticket.projectId); this.authorizedProjects.delete(ticket.projectId); this.historyPreviews.delete(ticket.projectId); this.clearProjectHistoryUncertainty(ticket.projectId);
    if (broadcast) this.channel?.postMessage({ userId: this.userId, projectId: ticket.projectId, userFence: ticket.userFence, revokedGeneration: ticket.cacheGeneration,
      generationAncestors: ticket.generationAncestors ?? [], unknownAncestors: ticket.unknownAncestors === true, ...(options?.confirmedDeletion ? { authoritative: true as const } : {}) } satisfies Hint);
    this.emit({ projectId: ticket.projectId, accessRevoked: true, revokedGeneration: ticket.cacheGeneration, ...(ticket.unknownAncestors ? { unknownAncestors: true as const } : {}), error: reason }, notifyProjection);
    if (notifyProjection) for (const ancestor of ticket.generationAncestors ?? []) {
      revoked.add(ancestor);
      this.emitProjection({ projectId: ticket.projectId, accessRevoked: true, revokedGeneration: ancestor, error: reason });
    }
    return this.clearDeniedProject(ticket.projectId).then(() => true);
  }
  // A retry only clears the originally denied generation; it must not emit a
  // second withdrawal into an editor opened after the original receipt.
  retryDeniedProjectCleanup(ticket: SyncTicket, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.isInvalidated) return Promise.reject(new TaskCacheLifecycleChanged());
    const denied = this.deniedProjects.get(ticket.projectId);
    if (denied === undefined || denied.userId !== ticket.userId || denied.projectId !== ticket.projectId ||
      denied.userFence !== ticket.userFence || denied.cacheGeneration !== ticket.cacheGeneration || !this.canRevokeProject(ticket)) return Promise.resolve(false);
    return this.waitForScopeWork(this.clearDeniedProject(ticket.projectId, false, signal), signal).then(() => true);
  }
  async beginSync(projectId: string, signal: AbortSignal): Promise<TaskSyncTicket> {
    projectId = requestId(projectId);
    const scopeRevision = this.projectRevisions.get(projectId) ?? 0;
    await this.ready(signal);
    await Promise.allSettled([...this.projectionHints]);
    await this.ensureHistoryPurged(projectId);
    await this.clearDeniedProject(projectId);
    try {
      const ticket = await this.userTransaction(async (transaction, userFence) => {
        let manifest = await this.manifest(transaction, projectId, userFence);
        if (manifest === undefined) {
          manifest = invalidated(this.userId, projectId, userFence);
          await transaction.objectStore("projects").put(manifest);
        }
        const tasks = manifest.state === "active" ? (await this.stored(transaction, manifest)).tasks : [];
        return { userId: this.userId, projectId, userFence, cacheGeneration: manifest.cacheGeneration, epoch: manifest.epoch, maxUpdatedAt: manifest.maxUpdatedAt,
          generationAncestors: manifest.generationAncestors ?? [], unknownAncestors: manifest.unknownAncestors === true, scopeRevision,
          taskBindings: new Map(tasks.map((task) => [task.id, taskExecutionBinding(task)])) };
      }, signal);
      if (scopeRevision !== this.getProjectRevision(projectId)) return released();
      if (!this.histories.has(projectId)) this.histories.set(projectId, { epoch: ticket.epoch, generation: 0 });
      const admitted = { ...ticket, admissionRevision: this.getAdmissionRevision(projectId) };
      this.ticketHistoryVersions.set(admitted, this.historyVersions.get(projectId) ?? 0);
      return admitted;
    } catch (error) {
      if (!(error instanceof TaskCacheError) || error.category !== "corrupt") throw error;
      console.warn("Task cache rebuild", { projectId, error_category: "corrupt" });
      await this.invalidateProject(projectId, signal, "corrupt");
      return this.beginSync(projectId, signal);
    }
  }
  private async waitForScopeWork(work: Promise<unknown>, signal: AbortSignal): Promise<void> {
    const lifetime = AbortSignal.any([signal, this.signal]);
    lifetime.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => lifetime.removeEventListener("abort", abort);
      const abort = () => { cleanup(); reject(lifetime.reason); };
      lifetime.addEventListener("abort", abort, { once: true });
      void work.then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
    });
  }
  async beginTaskRead(projectId: string, taskId: string, openingSequence: number, requestGeneration: number, signal: AbortSignal): Promise<TaskReadFence> {
    projectId = requestId(projectId); taskId = requestId(taskId);
    await this.ready(signal);
    // Independent task reads must wait only for this project's negative hints;
    // a denied project must not block other projects' direct views.
    await this.waitForScopeWork(Promise.allSettled([...this.projectionHintProjects].filter(([, id]) => id === projectId).map(([work]) => work)), signal);
    await this.waitForScopeWork(this.clearDeniedProject(projectId), signal);
    if (this.directRecheckErrors.has(projectId)) this.directRecheckPending.add(projectId);
    this.requestDirectAccessRecheck(projectId);
    const recheck = this.directRecheckWorks.get(projectId);
    if (recheck !== undefined) await this.waitForScopeWork(recheck, signal);
    if (this.directRecheckErrors.has(projectId)) throw this.directRecheckErrors.get(projectId);
    await this.waitForScopeWork(this.ensureHistoryPurged(projectId), signal);
    await this.ready(signal);
    const scopeRevision = this.getDirectRevision(projectId);
    if (this.isDirectProjectBlocked(projectId)) return released();
    let observed: { userFence: string; manifest: ProjectRecord | undefined; known: boolean };
    try {
      observed = await this.userTransaction(async (transaction, userFence) => {
        try { return { userFence, manifest: await this.manifest(transaction, projectId, userFence), known: true }; }
        catch (error) {
          // A malformed optional manifest cannot provide history evidence. The
          // normal cache path retains its strict validation and recovery rules.
          if (error instanceof TaskCacheError && error.category === "corrupt") return { userFence, manifest: undefined, known: false };
          throw error;
        }
      }, signal);
    } catch (error) {
      if (!(error instanceof TaskCacheError) || error.category !== "storage" || this.userFence === null) throw error;
      observed = { userFence: this.userFence, manifest: undefined, known: false };
    }
    if (this.isDirectProjectBlocked(projectId) || scopeRevision !== this.getDirectRevision(projectId)) return released();
    if (!this.histories.has(projectId)) this.histories.set(projectId, { epoch: observed.manifest?.epoch ?? null, generation: 0 });
    const fence = { userId: this.userId, userFence: observed.userFence, projectId, taskId, scopeRevision,
      historyGeneration: this.histories.get(projectId)!.generation, openingSequence, requestGeneration };
    this.directReadBaselines.set(fence, { known: observed.known, cacheGeneration: observed.manifest?.cacheGeneration ?? null });
    this.directProjects.add(projectId);
    this.ticketHistoryVersions.set(fence, this.historyVersions.get(projectId) ?? 0);
    return fence;
  }
  isTaskReadCurrent(fence: TaskReadFence, allowAuthPaused = false): boolean {
    return !this.isInvalidated && !this.identityMismatch && (allowAuthPaused || !authRequestsPaused()) && !this.isDirectProjectBlocked(fence.projectId) && fence.userId === this.userId &&
      fence.userFence === this.userFence && fence.scopeRevision === this.getDirectRevision(fence.projectId) &&
      fence.historyGeneration === (this.histories.get(fence.projectId)?.generation ?? 0);
  }
  isTaskHistoryPossiblyCurrent(fence: TaskReadFence): boolean {
    return this.isTaskReadCurrent(fence, true) || !this.isInvalidated && !this.identityMismatch &&
      fence.userId === this.userId && fence.userFence === this.userFence &&
      fence.historyGeneration === (this.histories.get(fence.projectId)?.generation ?? 0) &&
      this.uncertainDirectRevisions.get(fence.projectId)?.has(fence.scopeRevision) === true;
  }
  isTaskHistoryConfirmedCurrent(fence: TaskReadFence): boolean {
    return !this.uncertainHistories.has(fence.projectId) && !this.isDirectProjectBlocked(fence.projectId) &&
      (!this.withdrawnProjects.has(fence.projectId) || this.directAuthorizedRevisions.get(fence.projectId) === this.getDirectRevision(fence.projectId)) &&
      this.isTaskHistoryPossiblyCurrent(fence);
  }
  async verifyTaskRead(fence: TaskReadFence, signal: AbortSignal): Promise<boolean> {
    await this.ready(signal);
    if (!this.isTaskReadCurrent(fence)) return false;
    await this.userTransaction(async (_transaction, userFence) => { if (userFence !== fence.userFence) return released(); }, signal);
    return this.isTaskReadCurrent(fence);
  }
  getHistoryGeneration(projectId: string): number { return this.histories.get(projectId)?.generation ?? 0; }
  // A confirmed Goal deletion rotates the project epoch even before a new
  // snapshot is available. Fence old content immediately, including peers.
  retireGoalHistory(projectId: string, epoch: string): void {
    if (this.userFence === null || this.identityMismatch) return;
    this.channel?.postMessage({ userId: this.userId, projectId, userFence: this.userFence, retiredEpoch: epoch } satisfies Hint);
    this.retireKnownEpoch(projectId, epoch);
  }
  // A 410 does not report its epoch. Fence rather than retire a potentially
  // current history, and require an observation started after the response.
  fenceGoalHistory(projectId: string, epoch: string): void {
    if (this.userFence === null || this.identityMismatch) return;
    this.channel?.postMessage({ userId: this.userId, projectId, userFence: this.userFence, uncertainEpoch: epoch } satisfies Hint);
    this.fenceGoalEpoch(projectId);
  }
  private fenceGoalEpoch(projectId: string): void {
    if (this.isInvalidated || this.identityMismatch) return;
    this.uncertainHistories.add(projectId);
    this.historyVersions.set(projectId, (this.historyVersions.get(projectId) ?? 0) + 1);
    this.projectRevisions.set(projectId, this.getProjectRevision(projectId) + 1);
    this.fenceUncertainDirectHistory(projectId);
    this.projections.delete(projectId); this.authorizedProjects.delete(projectId); this.historyPreviews.delete(projectId); this.clearProjectHistoryUncertainty(projectId);
    this.emit({ projectId, historyChanged: true, historyHint: true, cacheGenerationChanged: true });
  }
  private retireKnownEpoch(projectId: string, epoch: string): void {
    const old = this.histories.get(projectId);
    if (this.isInvalidated || this.identityMismatch) return;
    if (old?.epoch == null) { this.fenceGoalEpoch(projectId); return; }
    if (old.epoch !== epoch) { this.fenceGoalEpoch(projectId); return; }
    let retired = this.retiredEpochs.get(projectId);
    if (retired === undefined) { retired = new Set(); this.retiredEpochs.set(projectId, retired); }
    retired.add(epoch);
    this.uncertainHistories.delete(projectId); this.uncertainDirectRevisions.delete(projectId);
    this.historyVersions.set(projectId, (this.historyVersions.get(projectId) ?? 0) + 1);
    this.histories.set(projectId, { epoch: null, generation: old.generation + 1 });
    this.projectRevisions.set(projectId, this.getProjectRevision(projectId) + 1);
    this.directRevisions.set(projectId, this.getDirectRevision(projectId) + 1);
    this.projections.delete(projectId); this.authorizedProjects.delete(projectId); this.historyPreviews.delete(projectId); this.clearProjectHistoryUncertainty(projectId);
    this.historyPurgeEpochs.set(projectId, epoch);
    const purge = this.ensureHistoryPurged(projectId);
    this.emit({ projectId, historyChanged: true, cacheGenerationChanged: true });
    void purge.catch(() => {});
  }
  captureTaskHistoryFence(projectId: string, taskId: string, openingSequence: number, requestGeneration: number): TaskReadFence | null {
    if (this.isInvalidated || this.userFence === null || this.isDirectProjectBlocked(projectId)) return null;
    return { userId: this.userId, userFence: this.userFence, projectId, taskId, scopeRevision: this.getDirectRevision(projectId),
      historyGeneration: this.getHistoryGeneration(projectId), openingSequence, requestGeneration };
  }
  async getDirectHistoryTicket(fence: TaskReadFence, epoch: string, signal: AbortSignal): Promise<SyncTicket | null> {
    await this.ready(signal);
    if (!this.isTaskReadCurrent(fence) || canonicalId(epoch) !== epoch) return released();
    const cacheRevision = this.getProjectRevision(fence.projectId);
    const admissionRevision = this.getAdmissionRevision(fence.projectId);
    const manifest = await this.userTransaction(async (transaction, userFence) => {
      if (userFence !== fence.userFence) return released();
      return this.manifest(transaction, fence.projectId, userFence);
    }, signal);
    if (!this.isTaskReadCurrent(fence) || cacheRevision !== this.getProjectRevision(fence.projectId) || admissionRevision !== this.getAdmissionRevision(fence.projectId)) return released();
    if (manifest === undefined || manifest.state !== "active" || manifest.epoch !== epoch) return null;
    return { userId: fence.userId, projectId: fence.projectId, userFence: fence.userFence, scopeRevision: cacheRevision,
      cacheGeneration: manifest.cacheGeneration, epoch: manifest.epoch, maxUpdatedAt: manifest.maxUpdatedAt, admissionRevision,
      generationAncestors: manifest.generationAncestors ?? [], unknownAncestors: manifest.unknownAncestors === true };
  }
  async observeHistory(ticket: SyncTicket | TaskReadFence, epoch: string, signal: AbortSignal): Promise<"current" | "retired" | "confirm"> {
    if (canonicalId(epoch) !== epoch) return protocol();
    await this.ready(signal);
    if ("historyGeneration" in ticket) {
      if (!await this.verifyTaskRead(ticket, signal)) return released();
      const baseline = this.directReadBaselines.get(ticket);
      if (baseline?.known) {
        const valid = await this.userTransaction(async (transaction, userFence) => {
          if (userFence !== ticket.userFence) return released();
          const current = await this.manifest(transaction, ticket.projectId, userFence);
          return current?.state !== "invalidated" || current.invalidatedBy !== "access" || current.cacheGeneration === baseline.cacheGeneration;
        }, signal);
        if (!valid || !this.isTaskReadCurrent(ticket)) return released();
      }
    }
    if (ticket.userId !== this.userId || ticket.userFence !== this.userFence || this.isDirectProjectBlocked(ticket.projectId) ||
      ("historyGeneration" in ticket ? !this.isTaskReadCurrent(ticket) : ticket.scopeRevision !== this.getProjectRevision(ticket.projectId))) return released();
    const old = this.histories.get(ticket.projectId) ?? { epoch: null, generation: 0 };
    const version = this.ticketHistoryVersions.get(ticket);
    if (version === undefined || this.retiredEpochs.get(ticket.projectId)?.has(epoch) === true) return released();
    const currentVersion = this.historyVersions.get(ticket.projectId) ?? 0;
    if (old.epoch === null || old.epoch === epoch) {
      this.histories.set(ticket.projectId, { ...old, epoch });
      if (currentVersion === 0 || this.uncertainHistories.delete(ticket.projectId)) this.historyVersions.set(ticket.projectId, currentVersion + 1);
      if ("historyGeneration" in ticket) this.directAuthorizedRevisions.set(ticket.projectId, ticket.scopeRevision);
      return "current";
    }
    const projectId = ticket.projectId;
    if (currentVersion === 0 || version !== currentVersion) {
      // Overlapping reads and cached manifests cannot order server snapshots.
      // Fence both candidates and obtain a new observation before retirement.
      this.uncertainHistories.add(projectId);
      this.historyVersions.set(projectId, currentVersion + 1);
      this.projectRevisions.set(projectId, this.getProjectRevision(projectId) + 1);
      this.fenceUncertainDirectHistory(projectId);
      this.projections.delete(projectId); this.authorizedProjects.delete(projectId); this.historyPreviews.delete(projectId); this.clearProjectHistoryUncertainty(projectId);
      this.emit({ projectId, historyChanged: true, historyHint: true, cacheGenerationChanged: true });
      return "confirm";
    }
    let retired = this.retiredEpochs.get(projectId);
    if (retired === undefined) { retired = new Set(); this.retiredEpochs.set(projectId, retired); }
    retired.add(old.epoch);
    this.uncertainHistories.delete(projectId);
    this.uncertainDirectRevisions.delete(projectId);
    this.historyVersions.set(projectId, currentVersion + 1);
    this.histories.set(projectId, { epoch, generation: old.generation + 1 });
    this.projectRevisions.set(projectId, this.getProjectRevision(projectId) + 1);
    this.directRevisions.set(projectId, this.getDirectRevision(projectId) + 1);
    this.projections.delete(projectId); this.authorizedProjects.delete(projectId); this.historyPreviews.delete(projectId); this.clearProjectHistoryUncertainty(projectId);
    this.historyPurgeEpochs.set(projectId, old.epoch);
    const purge = this.ensureHistoryPurged(projectId);
    this.emit({ projectId, historyChanged: true, cacheGenerationChanged: true });
    await purge;
    return "retired";
  }
  private ensureHistoryPurged(projectId: string): Promise<void> {
    const active = this.historyPurges.get(projectId);
    if (active !== undefined) return active;
    const oldEpoch = this.historyPurgeEpochs.get(projectId);
    if (oldEpoch === undefined) return Promise.resolve();
    const purge = this.userTransaction(async (transaction, userFence) => {
      const manifest = await this.manifest(transaction, projectId, userFence);
      // An access tombstone may have been committed by a peer while this
      // history purge was queued. Keep its immediate predecessor for late hints.
      if (manifest?.state === "invalidated" && manifest.invalidatedBy === "access") return;
      if (manifest !== undefined && manifest.epoch !== null && manifest.epoch !== oldEpoch) return;
      await this.clearProjectRows(transaction, projectId);
      await transaction.objectStore("projects").put(invalidated(this.userId, projectId, userFence, "access", recoverHistory(manifest, this.userId, projectId, userFence)));
    }, this.signal).then(() => {
      if (this.historyPurgeEpochs.get(projectId) === oldEpoch) this.historyPurgeEpochs.delete(projectId);
      this.hint(projectId);
    }).finally(() => { if (this.historyPurges.get(projectId) === purge) this.historyPurges.delete(projectId); });
    this.historyPurges.set(projectId, purge);
    return purge;
  }
  async applySync(ticket: SyncTicket, response: TaskSync, signal: AbortSignal): Promise<{ readonly project: CachedProject; readonly changed: boolean; readonly changedTaskIds: readonly string[] }> {
    await this.ready(signal);
    if (response.project.id !== ticket.projectId || ticket.userId !== this.userId) return protocol();
    if (this.uncertainHistories.has(ticket.projectId)) return released();
    this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
    let result: { manifest: ProjectRecord; stored: StoredTasks; changed: boolean; changedTaskIds: readonly string[] };
    try {
      result = await this.userTransaction(async (transaction, userFence) => {
        const current = await this.manifest(transaction, ticket.projectId, userFence);
        this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
        if (userFence !== ticket.userFence || current === undefined || current.cacheGeneration !== ticket.cacheGeneration) return released();
        const previous = current.state === "active" ? await this.stored(transaction, current) : { tasks: [], dependencyStates: new Map<string, TaskDependencyState>() };
        if (response.mode === "delta" && (current.state !== "active" || response.epoch !== current.epoch || response.epoch !== ticket.epoch)) return protocol();
        if (response.mode === "snapshot" && ticket.epoch === response.epoch) return protocol();
        const replacing = response.mode === "snapshot";
        const merged = new Map((replacing ? [] : previous.tasks).map((task) => [task.id, task]));
        const states = new Map(replacing ? [] : previous.dependencyStates);
        const changedTaskIds = new Set<string>();
        const intrinsicChanged = new Set<string>();
        for (const task of response.tasks) {
          const incoming = response.dependencyStates[task.id];
          if (task.type === "task" ? incoming === undefined || !validDependencyState(task, incoming) : incoming !== undefined) return protocol();
          const existing = merged.get(task.id);
          if (existing !== undefined && existing.version > task.version) continue;
          if (existing !== undefined && existing.version === task.version) {
            if (!sameSummary(existing, task)) return protocol();
            continue;
          }
          merged.set(task.id, task); changedTaskIds.add(task.id); intrinsicChanged.add(task.id);
          states.delete(task.id);
        }
        for (const [taskId, state] of Object.entries(response.dependencyStates)) {
          const task = merged.get(taskId);
          if (task === undefined || task.version !== state.taskVersion) continue;
          if (!validDependencyState(task, state)) return protocol();
          if (!sameDependencyState(states.get(taskId), state)) { states.set(taskId, state); changedTaskIds.add(taskId); }
        }
        const tasks = [...merged.values()];
        if (tasks.some(task => task.type === "task" && !states.has(task.id))) return protocol();
        if (replacing && Object.keys(response.dependencyStates).length !== states.size) return protocol();
        const project = current.project === null || replacing ? response.project : mergeProject(current.project, response.project);
        try { projectSummaries(project, tasks, states, response.observedAt); }
        catch (error) { if (error instanceof GraphDataError) throw new ApiError("protocol", null, "protocol", null, error); throw error; }
        const manifest: ProjectRecord = {
          userId: this.userId, projectId: ticket.projectId, userFence: ticket.userFence,
          cacheGeneration: replacing ? crypto.randomUUID() : current.cacheGeneration,
          ...(replacing ? nextHistory(current) : { generationAncestors: current.generationAncestors ?? [], unknownAncestors: current.unknownAncestors === true }),
          state: "active", invalidatedBy: null, epoch: response.epoch, project,
          maxUpdatedAt: maxUpdatedAt(tasks), taskCount: tasks.length, edgeCount: edgeCount(tasks),
        };
        this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
        const changed = replacing || changedTaskIds.size !== 0 || current.project === null || !sameProject(current.project, project);
        if (replacing) await this.clearProjectRows(transaction, ticket.projectId);
        for (const taskId of changedTaskIds) {
          const summary = merged.get(taskId)!;
          await transaction.objectStore("summaries").put({ userId: this.userId, projectId: ticket.projectId, taskId, summary, dependencyState: states.get(taskId) ?? null });
          if (!replacing && intrinsicChanged.has(taskId)) await transaction.objectStore("details").delete([this.userId, ticket.projectId, taskId]);
        }
        if (changed) await transaction.objectStore("projects").put(manifest);
        return { manifest: changed ? manifest : current, stored: { tasks, dependencyStates: states }, changed, changedTaskIds: [...changedTaskIds] };
      }, signal);
    } catch (error) {
      if (error instanceof TaskCacheError && error.category === "corrupt") await this.invalidateProject(ticket.projectId, signal, "corrupt");
      throw error;
    }
    this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
    this.assertProjectGeneration(ticket.projectId, result.manifest.cacheGeneration, signal, ticket.scopeRevision);
    const previousVersions = this.projections.get(ticket.projectId)?.assigneeVersions;
    const versionsChanged = previousVersions === undefined || previousVersions === null || previousVersions.length !== response.assigneeVersions.length ||
      previousVersions.some((person, index) => {
        const next = response.assigneeVersions[index]!;
        return person.userId !== next.userId || person.version !== next.version || person.hasProjectAccess !== next.hasProjectAccess;
      });
    if (!this.authorizedProjects.has(ticket.projectId) || this.onlineGenerations.get(ticket.projectId) !== result.manifest.cacheGeneration) {
      this.admissionRevisions.set(ticket.projectId, this.getAdmissionRevision(ticket.projectId) + 1);
      this.onlineGenerations.set(ticket.projectId, result.manifest.cacheGeneration);
    }
    this.authorizedProjects.add(ticket.projectId);
    const project = this.materialize(result.manifest, result.stored, response.assigneeVersions);
    if (result.changed) this.hint(ticket.projectId);
    if (result.changed || versionsChanged) this.emit({ projectId: ticket.projectId });
    return { project, changed: result.changed, changedTaskIds: result.changedTaskIds };
  }
  async readProject(projectId: string, signal: AbortSignal): Promise<CachedProject | null> {
    return this.readProjectState(projectId, signal, false);
  }
  private async readProjectState(projectId: string, signal: AbortSignal, allowConflictingHistory: boolean): Promise<CachedProject | null> {
    projectId = requestId(projectId);
    const revision = this.projectRevisions.get(projectId) ?? 0;
    await this.ready(signal);
    const stored = await this.userTransaction(async (transaction, userFence) => {
      const manifest = await this.manifest(transaction, projectId, userFence);
      if (manifest?.state === "invalidated" && manifest.invalidatedBy === "corrupt") throw new TaskCacheError("corrupt");
      if (manifest === undefined || manifest.state === "invalidated") return null;
      return { manifest, tasks: await this.stored(transaction, manifest) };
    }, signal);
    this.assertAdmitted(signal);
    if (revision !== this.getProjectRevision(projectId) || this.isProjectSuspended(projectId)) return released();
    if (stored === null) { this.projections.delete(projectId); return null; }
    const history = this.histories.get(projectId);
    const conflict = this.uncertainHistories.has(projectId) || history?.epoch !== null && history?.epoch !== undefined && stored.manifest.epoch !== history.epoch;
    if (!allowConflictingHistory && conflict) return null;
    this.assertProjectGeneration(projectId, stored.manifest.cacheGeneration, signal, revision);
    return this.materialize(stored.manifest, stored.tasks, undefined, !conflict);
  }
  async detailTransaction<T>(
    ticket: SyncTicket, signal: AbortSignal,
    work: (details: DetailStore, manifest: ProjectRecord, summaries: ReadonlyMap<string, TaskSummary>) => Promise<T>,
  ): Promise<T> {
    await this.ready(signal);
    if (ticket.userId !== this.userId) return released();
    this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
    const result = await this.userTransaction(async (transaction, userFence) => {
      const manifest = await this.manifest(transaction, ticket.projectId, userFence);
      if (manifest === undefined || manifest.state !== "active" || userFence !== ticket.userFence ||
        manifest.cacheGeneration !== ticket.cacheGeneration) return released();
      this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
      const { tasks } = await this.stored(transaction, manifest);
      return work(transaction.objectStore("details"), manifest, new Map(tasks.map((summary) => [summary.id, summary])));
    }, signal);
    this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
    return result;
  }
  async sessionHistoryTransaction<T>(
    ticket: SyncTicket, signal: AbortSignal,
    work: (store: SessionHistoryStore, manifest: ProjectRecord, summaries: ReadonlyMap<string, TaskSummary>) => Promise<T>,
  ): Promise<T> {
    await this.ready(signal);
    if (ticket.userId !== this.userId) return released();
    this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
    const result = await this.userTransaction(async (transaction, userFence) => {
      const manifest = await this.manifest(transaction, ticket.projectId, userFence);
      if (manifest === undefined || manifest.state !== "active" || userFence !== ticket.userFence ||
        manifest.cacheGeneration !== ticket.cacheGeneration) return released();
      this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
      const { tasks } = await this.stored(transaction, manifest);
      return work(transaction.objectStore("sessionHistory"), manifest, new Map(tasks.map((summary) => [summary.id, summary])));
    }, signal);
    this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
    this.historyPreviews.set(ticket.projectId, ticket);
    return result;
  }
  isSessionHistoryTicketCurrent(ticket: SyncTicket): boolean {
    if (this.isInvalidated || this.identityMismatch || authRequestsPaused() || !this.canPreviewProject(ticket.projectId) || ticket.userId !== this.userId ||
      ticket.scopeRevision !== this.getProjectRevision(ticket.projectId)) return false;
    const current = this.historyPreviews.get(ticket.projectId);
    return current !== undefined && current.userFence === ticket.userFence && current.cacheGeneration === ticket.cacheGeneration && current.scopeRevision === ticket.scopeRevision;
  }
  async rotateSessionHistoryGeneration(ticket: SyncTicket, markerLimit: number, signal: AbortSignal, denial?: SessionHistoryRotationDenial): Promise<boolean> {
    await this.ready(signal);
    if (ticket.userId !== this.userId) return released();
    if (denial !== undefined && (canonicalId(denial.taskId) !== denial.taskId || canonicalId(denial.marker) !== denial.marker ||
      canonicalId(denial.requestToken) !== denial.requestToken || denial.expectedToken !== null && canonicalId(denial.expectedToken) !== denial.expectedToken ||
      denial.expectedPaginationToken != null && canonicalId(denial.expectedPaginationToken) !== denial.expectedPaginationToken ||
      denial.expectedLeaseExpiresAt != null && (!Number.isSafeInteger(denial.expectedLeaseExpiresAt) || denial.expectedLeaseExpiresAt < 0))) return protocol();
    this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
    const result = await this.userTransaction(async (transaction, userFence) => {
      const manifest = await this.manifest(transaction, ticket.projectId, userFence);
      if (manifest === undefined || manifest.state !== "active" || userFence !== ticket.userFence || manifest.cacheGeneration !== ticket.cacheGeneration) return released();
      this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
      const rows = await transaction.objectStore("sessionHistory").index("by-project").getAll([this.userId, ticket.projectId]);
      if (rows.length !== markerLimit || !rows.every(row => row.userId === this.userId && row.projectId === ticket.projectId &&
        row.userFence === ticket.userFence && row.cacheGeneration === ticket.cacheGeneration && row.clearedToken !== null &&
        typeof row.clearedToken === "string" && canonicalId(row.clearedToken) === row.clearedToken && row.page === null &&
        (row.leaseExpiresAt === null || typeof row.leaseExpiresAt === "number" && Number.isSafeInteger(row.leaseExpiresAt) && row.leaseExpiresAt <= Date.now()))) return null;
      if (denial !== undefined) {
        const existing = rows.find(row => row.taskId === denial.taskId);
        if ((existing?.requestToken ?? null) !== denial.expectedToken ||
          denial.expectedPaginationToken !== undefined && (existing?.paginationToken ?? null) !== denial.expectedPaginationToken ||
          denial.expectedLeaseExpiresAt !== undefined && (existing?.leaseExpiresAt ?? null) !== denial.expectedLeaseExpiresAt) return null;
      }
      const tasks = await this.stored(transaction, manifest);
      for (const name of ["details", "sessionHistory"] as const)
        for await (const cursor of transaction.objectStore(name).index("by-project").iterate([this.userId, ticket.projectId])) await cursor.delete();
      const next = { ...manifest, ...nextHistory(manifest), cacheGeneration: crypto.randomUUID() };
      await transaction.objectStore("projects").put(next);
      if (denial !== undefined) await transaction.objectStore("sessionHistory").put({ userId: this.userId, projectId: ticket.projectId,
        taskId: denial.taskId, userFence, cacheGeneration: next.cacheGeneration, requestToken: denial.requestToken, clearedToken: denial.marker,
        leaseExpiresAt: null, settled: "cancelled", paginationToken: null, page: null, confirmedCompleteEmpty: false, observedNonEmpty: false,
        byteSize: 0, lastUsedAt: Date.now() });
      return { manifest: next, tasks };
    }, signal);
    if (result === null) return false;
    this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
    this.historyPreviews.delete(ticket.projectId);
    this.clearProjectHistoryUncertainty(ticket.projectId);
    this.projectRevisions.set(ticket.projectId, this.getProjectRevision(ticket.projectId) + 1);
    this.materialize(result.manifest, result.tasks, this.projections.get(ticket.projectId)?.assigneeVersions ?? undefined);
    this.hint(ticket.projectId);
    this.emit({ projectId: ticket.projectId, cacheGenerationChanged: true });
    if (denial !== undefined) {
      const current: SyncTicket = { userId: this.userId, projectId: ticket.projectId, userFence: ticket.userFence,
        cacheGeneration: result.manifest.cacheGeneration, epoch: result.manifest.epoch, maxUpdatedAt: result.manifest.maxUpdatedAt,
        scopeRevision: this.getProjectRevision(ticket.projectId) };
      this.sessionHistoryCleared(current, denial.taskId, denial.marker, signal, denial.origin);
    }
    return true;
  }
  sessionHistorySettled(ticket: SyncTicket, taskId: string, token: string, outcome: "saved" | "failed" | "cancelled", signal: AbortSignal): void {
    this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
    const sessionHistorySettled: HistorySettlement = { taskId, token, outcome };
    this.channel?.postMessage({ userId: this.userId, projectId: ticket.projectId, userFence: ticket.userFence,
      cacheGeneration: ticket.cacheGeneration, sessionHistorySettled } satisfies Hint);
    this.emit({ projectId: ticket.projectId, sessionHistorySettled });
  }
  sessionHistoryCleared(ticket: SyncTicket, taskId: string, token: string, signal: AbortSignal, origin?: symbol): void {
    this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
    this.channel?.postMessage({ userId: this.userId, projectId: ticket.projectId, userFence: ticket.userFence,
      cacheGeneration: ticket.cacheGeneration, sessionHistoryCleared: { taskId, token } } satisfies Hint);
    this.emit({ projectId: ticket.projectId, sessionHistoryCleared: { taskId, token, ...(origin === undefined ? {} : { origin }) } });
  }
  async readProfiles(ticket: SyncTicket, signal: AbortSignal): Promise<readonly CachedProfile[]> {
    const outcome = await this.profileTransaction(ticket, signal, async (transaction) => {
      const rows = await transaction.objectStore("profiles").index("by-project").getAll([this.userId, ticket.projectId]);
      try {
        const profiles = rows.map((row) => {
          const profile = record(row.profile);
          if (row.userId !== this.userId || row.projectId !== ticket.projectId || row.userFence !== ticket.userFence ||
            canonicalId(row.profileUserId) !== row.profileUserId || profile.userId !== row.profileUserId) throw new Error("Invalid cached profile ownership.");
          return { userId: row.profileUserId, version: parseProfileVersion(profile.version),
            name: profile.name === null ? null : string(profile.name), avatarUrl: profile.avatarUrl === null ? null : string(profile.avatarUrl) };
        });
        return { kind: "profiles" as const, profiles };
      } catch (error) {
        for await (const cursor of transaction.objectStore("profiles").index("by-project").iterate([this.userId, ticket.projectId])) await cursor.delete();
        return { kind: "corrupt" as const, error: new TaskCacheError("corrupt", error) };
      }
    });
    if (outcome.kind === "corrupt") throw outcome.error;
    return outcome.profiles;
  }
  async writeProfiles(ticket: SyncTicket, profiles: readonly CachedProfile[], signal: AbortSignal): Promise<void> {
    return this.profileTransaction(ticket, signal, async (transaction) => {
      for (const profile of profiles) await transaction.objectStore("profiles").put({ userId: this.userId, projectId: ticket.projectId,
        profileUserId: profile.userId, userFence: ticket.userFence, profile });
    });
  }
  private async profileTransaction<T>(ticket: SyncTicket, signal: AbortSignal, work: (transaction: Transaction) => Promise<T>): Promise<T> {
    await this.ready(signal);
    if (ticket.userId !== this.userId || !this.authorizedProjects.has(ticket.projectId)) return released();
    this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
    const result = await this.userTransaction(async (transaction, userFence) => {
      const manifest = await this.manifest(transaction, ticket.projectId, userFence);
      if (manifest === undefined || manifest.state !== "active" || userFence !== ticket.userFence || manifest.cacheGeneration !== ticket.cacheGeneration) return released();
      this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
      return work(transaction);
    }, signal);
    this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
    return result;
  }
  getProjectRevision(projectId: string): number { return this.projectRevisions.get(projectId) ?? 0; }
  getAdmissionRevision(projectId: string): number { return this.admissionRevisions.get(projectId) ?? 0; }
  private getDirectRevision(projectId: string): number { return this.directRevisions.get(projectId) ?? 0; }
  private fenceUncertainDirectHistory(projectId: string): void {
    const revision = this.getDirectRevision(projectId);
    let previous = this.uncertainDirectRevisions.get(projectId);
    if (previous === undefined) { previous = new Set(); this.uncertainDirectRevisions.set(projectId, previous); }
    previous.add(revision);
    this.directRevisions.set(projectId, revision + 1);
  }
  getObservedHistoryTicket(projectId: string): SyncTicket | null {
    projectId = requestId(projectId);
    if (this.isInvalidated || this.identityMismatch || authRequestsPaused() || !this.canPreviewProject(projectId)) return null;
    const project = this.getAuthorizedProject(projectId);
    const manifest = project?.manifest;
    if (manifest !== undefined && manifest.userFence === this.userFence) return { userId: this.userId, projectId, userFence: manifest.userFence,
      cacheGeneration: manifest.cacheGeneration, epoch: manifest.epoch, maxUpdatedAt: manifest.maxUpdatedAt, scopeRevision: this.getProjectRevision(projectId),
      generationAncestors: manifest.generationAncestors ?? [], unknownAncestors: manifest.unknownAncestors === true, admissionRevision: this.getAdmissionRevision(projectId) };
    const preview = this.historyPreviews.get(projectId);
    return preview !== undefined && preview.userFence === this.userFence && preview.scopeRevision === this.getProjectRevision(projectId) ? preview : null;
  }
  isProjectSuspended(projectId: string): boolean { return this.suspendedProjects.has(projectId) || this.unboundProjectDenials.get(projectId)?.isolated === true || this.pendingUnknownProjects.has(projectId); }
  private isProjectAccessBlocked(projectId: string): boolean { return this.isProjectSuspended(projectId) || this.deniedProjects.has(projectId); }
  private isDirectProjectBlocked(projectId: string): boolean {
    return this.isProjectAccessBlocked(projectId) || this.directHintCounts.has(projectId) || this.directRecheckPending.has(projectId) || this.directRecheckWorks.has(projectId) || this.directRecheckErrors.has(projectId);
  }
  markProjectReadable(projectId: string): void {
    if (this.isInvalidated || this.identityMismatch) return;
    const revision = this.getProjectReadRevision(projectId) + 1;
    this.readableProjects.set(projectId, revision);
    this.projectReadRevisions.set(projectId, revision);
  }
  getProjectReadRevision(projectId: string): number { return this.projectReadRevisions.get(projectId) ?? 0; }
  canRevokeProjectRead(ticket: SyncTicket, revision: number): boolean {
    return revision === this.getProjectReadRevision(ticket.projectId) && this.canRevokeProject(ticket);
  }
  reportUnboundProjectDenial(projectId: string): void {
    projectId = requestId(projectId);
    if (this.isInvalidated || this.identityMismatch) return;
    this.channel?.postMessage({ userId: this.userId, projectId, unboundProjectDenial: true } satisfies Hint);
  }
  enrollDirectProject(projectId: string): { readonly error: unknown } | null {
    this.directProjects.add(projectId);
    const denial = this.unboundProjectDenials.get(projectId);
    if (denial === undefined) return null;
    if (!denial.direct) {
      denial.direct = true;
      this.emit({ projectId, directAccessUncertain: true }, true, true);
    }
    return { error: denial.error };
  }
  retryProjectVerification(projectId: string): void {
    const denial = this.unboundProjectDenials.get(projectId);
    if (denial !== undefined) {
      if (denial.inFlight || denial.retry === null) { denial.retryRequested = true; return; }
      if (denial.timer !== null) clearTimeout(denial.timer);
      denial.timer = null; denial.retry();
    } else if (this.directRecheckErrors.has(projectId) || this.directHintCounts.has(projectId) || this.directRecheckPending.has(projectId) || this.directRecheckWorks.has(projectId)) {
      this.directRecheckPending.add(projectId); this.requestDirectAccessRecheck(projectId);
    }
  }
  private receiveUnboundProjectDenial(projectId: string): void {
    if (this.isInvalidated) return;
    const prior = this.unboundProjectDenials.get(projectId);
    if (prior?.timer !== null && prior?.timer !== undefined) clearTimeout(prior.timer);
    const observed = !this.identityMismatch && !authRequestsPaused() ? this.getObservedHistoryTicket(projectId) : null;
    // An unbound hint cannot prove which generation it affects.
    const isolated = true;
    const direct = this.directProjects.has(projectId);
    const revision = this.getProjectRevision(projectId) + (isolated ? 1 : 0);
    const history = observed === null ? null : { ...observed, scopeRevision: revision };
    const denial = { revision, isolated, direct, error: null as unknown, timer: null as ReturnType<typeof setTimeout> | null, retry: null as (() => void) | null, inFlight: false, retryRequested: false };
    this.unboundProjectDenials.set(projectId, denial);
    if (isolated) {
      this.projectRevisions.set(projectId, revision);
      this.fenceUncertainDirectHistory(projectId);
      this.withdrawnProjects.add(projectId);
      this.projections.delete(projectId); this.authorizedProjects.delete(projectId); this.historyPreviews.delete(projectId); this.clearProjectHistoryUncertainty(projectId);
      const event: CacheEvent = { projectId, accessRevoked: true, scopeSuspended: true, ...(direct ? { directAccessUncertain: true as const } : {}) };
      if (this.identityMismatch) {
        for (const listener of this.listeners) listener(event);
        for (const listener of this.projectionListeners) listener(event);
      } else this.emit(event);
    }
    const check = () => {
      if (this.isInvalidated || this.unboundProjectDenials.get(projectId) !== denial || denial.inFlight) return;
      denial.timer = null;
      denial.inFlight = true;
      denial.retryRequested = false;
      const admission = this.getAdmissionRevision(projectId);
      const readable = this.readableProjects.get(projectId);
      const readRevision = this.getProjectReadRevision(projectId);
      let confirmedDenial = false;
      const unchanged = () => this.getProjectRevision(projectId) === revision && this.getAdmissionRevision(projectId) === admission && this.readableProjects.get(projectId) === readable && this.getProjectReadRevision(projectId) === readRevision;
      const superseded = () => {
        if (this.suspendedProjects.has(projectId) || this.pendingUnknownProjects.has(projectId) || this.getProjectRevision(projectId) !== revision || this.getAdmissionRevision(projectId) !== admission || !this.readableProjects.has(projectId) || this.readableProjects.get(projectId) === readable) return false;
        this.unboundProjectDenials.delete(projectId);
        this.projectRevisions.set(projectId, revision + 1);
        this.emit({ projectId, accessRestored: true, ...(denial.direct ? { directAccessRecheck: true as const } : {}) });
        return true;
      };
      void (async () => {
        await this.ready(this.signal);
        let captured = history;
        if (captured === null) {
          const preparing = new AbortController();
          const signal = AbortSignal.any([this.signal, preparing.signal]);
          let timer: ReturnType<typeof setTimeout> | null = null;
          try {
            captured = await Promise.race([
              this.beginSync(projectId, signal).catch(() => null),
              new Promise<null>(resolve => { timer = setTimeout(() => { preparing.abort(); resolve(null); }, 5_000); }),
            ]);
          } finally { if (timer !== null) clearTimeout(timer); preparing.abort(); }
        }
        if (this.isInvalidated || this.unboundProjectDenials.get(projectId) !== denial) return;
        if (!unchanged()) { if (!superseded()) this.receiveUnboundProjectDenial(projectId); return; }
        try {
          await getProjectAccess(projectId, this.signal, { userId: this.userId, onPrincipalMismatch: this.principalMismatch });
        } catch (error) {
          if (this.unboundProjectDenials.get(projectId) === denial && unchanged() && error instanceof ApiError && error.kind === "server" && error.status === 404 && error.code === "not_found") {
            if (captured !== null && this.canRevokeProject(captured)) {
              confirmedDenial = true;
              void this.revokeProject(captured, this.signal, true, error).catch(() => {});
            } else if (captured === null && denial.isolated) {
              confirmedDenial = true;
            } else if (captured === null && !denial.isolated) {
              confirmedDenial = true;
              denial.isolated = true;
              this.readableProjects.delete(projectId);
              this.projectRevisions.set(projectId, revision + 1);
              this.fenceUncertainDirectHistory(projectId);
              this.withdrawnProjects.add(projectId);
              this.projections.delete(projectId); this.authorizedProjects.delete(projectId); this.historyPreviews.delete(projectId); this.clearProjectHistoryUncertainty(projectId);
              this.emit({ projectId, accessRevoked: true, scopeSuspended: true, error });
            }
          }
          throw error;
        }
        await this.ready(this.signal);
        if (this.isInvalidated || this.unboundProjectDenials.get(projectId) !== denial) return;
        if (!unchanged()) { if (!superseded()) this.receiveUnboundProjectDenial(projectId); return; }
        if (this.deniedProjects.has(projectId)) {
          await this.clearDeniedProject(projectId);
          await this.ready(this.signal);
          if (this.isInvalidated || this.unboundProjectDenials.get(projectId) !== denial) return;
          if (!unchanged()) { if (!superseded()) this.receiveUnboundProjectDenial(projectId); return; }
        }
        if (this.suspendedProjects.has(projectId) || this.pendingUnknownProjects.has(projectId)) {
          denial.timer = setTimeout(check, 30_000); return;
        }
        this.markProjectReadable(projectId);
        this.unboundProjectDenials.delete(projectId);
        if (denial.isolated) {
          this.projectRevisions.set(projectId, revision + 1);
          if (!this.isProjectSuspended(projectId)) this.emit({ projectId, accessRestored: true, ...(denial.direct ? { directAccessRecheck: true as const } : {}) });
        }
        this.requestDirectAccessRecheck(projectId);
      })().catch(error => {
        if (this.isInvalidated || this.unboundProjectDenials.get(projectId) !== denial) return;
        if (confirmedDenial) {
          denial.error = error;
          this.emit({ projectId, accessRevoked: true, scopeSuspended: true, error, ...(denial.direct ? { directAccessRecheck: true as const } : {}) });
          denial.timer = setTimeout(check, 30_000);
          return;
        }
        if (!unchanged()) {
          if (superseded()) return;
          if (denial.isolated) denial.timer = setTimeout(() => this.receiveUnboundProjectDenial(projectId), 30_000);
          else this.receiveUnboundProjectDenial(projectId);
          return;
        }
        if (!isAbortError(error)) {
          denial.error = error;
          this.emit(denial.isolated ? { projectId, accessRevoked: true, scopeSuspended: true, error, ...(denial.direct ? { directAccessRecheck: true as const } : {}) } : { projectId, error });
        }
        denial.timer = setTimeout(check, 30_000);
      }).finally(() => {
        denial.inFlight = false;
        if (this.isInvalidated || this.unboundProjectDenials.get(projectId) !== denial || !denial.retryRequested) return;
        if (denial.timer !== null) clearTimeout(denial.timer);
        denial.timer = null;
        check();
      });
    };
    denial.retry = check;
    check();
  }
  suspendProject(projectId: string): void {
    projectId = requestId(projectId);
    if (this.isInvalidated) return;
    this.projectRevisions.set(projectId, (this.projectRevisions.get(projectId) ?? 0) + 1);
    this.fenceUncertainDirectHistory(projectId);
    this.suspendedProjects.add(projectId);
    this.readableProjects.delete(projectId);
    this.withdrawnProjects.add(projectId);
    if (!this.revokedGenerations.has(projectId)) this.revokedGenerations.set(projectId, new Set());
    this.projections.delete(projectId); this.authorizedProjects.delete(projectId); this.historyPreviews.delete(projectId); this.clearProjectHistoryUncertainty(projectId);
    this.emit({ projectId, accessRevoked: true, scopeSuspended: true });
  }
  resumeProject(projectId: string): void {
    if (!this.suspendedProjects.delete(projectId)) return;
    this.projectRevisions.set(projectId, (this.projectRevisions.get(projectId) ?? 0) + 1);
    this.directRevisions.set(projectId, this.getDirectRevision(projectId) + 1);
    if (!this.isProjectSuspended(projectId)) this.emit({ projectId, accessRestored: true });
    if (this.unboundProjectDenials.has(projectId)) this.retryProjectVerification(projectId);
    this.requestDirectAccessRecheck(projectId);
  }
  getSummaryVersion(projectId: string, taskId: string): bigint | null {
    return this.getAuthorizedProject(projectId)?.versions.get(taskId) ?? null;
  }
  canPreviewProject(projectId: string): boolean {
    this.assertLive();
    // A surviving replacement generation cannot undo this scope's observed access withdrawal.
    return !this.uncertainHistories.has(projectId) && !this.isProjectSuspended(projectId) && (!this.withdrawnProjects.has(projectId) || this.authorizedProjects.has(projectId));
  }
  getAuthorizedProject(projectId: string): CachedProject | null {
    this.assertLive();
    return !this.isProjectSuspended(projectId) && this.authorizedProjects.has(projectId) ? this.projections.get(projectId) ?? null : null;
  }
  private async clearProjectRows(transaction: Transaction, projectId: string, includeProfiles = false): Promise<void> {
    const stores = includeProfiles ? ["summaries", "details", "profiles", "sessionHistory"] as const : ["summaries", "details", "sessionHistory"] as const;
    for (const name of stores) {
      const index = transaction.objectStore(name).index("by-project");
      for await (const cursor of index.iterate([this.userId, projectId])) await cursor.delete();
    }
  }
  async invalidateProject(projectId: string, signal: AbortSignal, cause: "access" | "corrupt" = "access"): Promise<void> {
    projectId = requestId(projectId);
    await this.ready(signal);
    await this.userTransaction(async (transaction, fence) => {
      const current = await transaction.objectStore("projects").get([this.userId, projectId]);
      await this.clearProjectRows(transaction, projectId, true);
      await transaction.objectStore("projects").put(invalidated(this.userId, projectId, fence, cause, recoverHistory(current, this.userId, projectId, fence)));
    }, signal);
    if (cause === "access") { this.projections.delete(projectId); this.authorizedProjects.delete(projectId); }
    this.hint(projectId); this.emit(cause === "corrupt" ? { projectId, error: new TaskCacheError("corrupt") } : { projectId });
  }
  invalidateScope(): Promise<void> {
    if (this.purge !== null) return this.purge;
    if (this.disposed) return Promise.resolve();
    this.invalidated = true;
    this.lifetime.abort();
    for (const denial of this.unboundProjectDenials.values()) if (denial.timer !== null) clearTimeout(denial.timer);
    this.unboundProjectDenials.clear();
    this.directProjects.clear(); this.directAuthorizedRevisions.clear(); this.directHintCounts.clear(); this.directRecheckPending.clear(); this.directRecheckWorks.clear(); this.directRecheckErrors.clear();
    for (const transaction of this.pending) { try { transaction.abort(); } catch { /* Already committed. */ } }
    this.projections.clear(); this.authorizedProjects.clear(); this.historyPreviews.clear(); this.uncertainHistory.clear(); this.listeners.clear(); this.projectionListeners.clear();
    this.purge = this.transaction(async (transaction) => {
      const stored = await transaction.objectStore("userScopes").get(this.userId);
      let currentFence: string | null = null;
      try { currentFence = validateUserScope(stored, this.userId).userFence; }
      catch (error) { if (!(error instanceof TaskCacheError) || error.category !== "corrupt") throw error; }
      if (this.userFence !== null && currentFence !== null && this.userFence !== currentFence) return false;
      await this.replaceUserScope(transaction, "user");
      return true;
    }, undefined, true).then((cleared) => { if (cleared) this.hint(null); }).finally(() => { this.close(); });
    // Session clearing is synchronous; storage failure remains observable without blocking identity removal.
    void this.purge.catch((error: unknown) => { console.error("Task cache user cleanup failed", { error_category: error instanceof TaskCacheError ? error.category : "storage" }); });
    return this.purge;
  }
  dispose(): void {
    if (this.purge !== null) return;
    this.close();
  }
  private close(): void {
    this.disposed = true; this.lifetime.abort();
    for (const denial of this.unboundProjectDenials.values()) if (denial.timer !== null) clearTimeout(denial.timer);
    this.unboundProjectDenials.clear();
    this.directProjects.clear(); this.directAuthorizedRevisions.clear(); this.directHintCounts.clear(); this.directRecheckPending.clear(); this.directRecheckWorks.clear(); this.directRecheckErrors.clear();
    for (const transaction of this.pending) { try { transaction.abort(); } catch { /* Already completed. */ } }
    this.pending.clear(); this.channel?.close(); this.database.close();
    this.projections.clear(); this.authorizedProjects.clear(); this.historyPreviews.clear(); this.uncertainHistory.clear(); this.listeners.clear(); this.projectionListeners.clear();
  }
}

export const createTaskCacheScope = (options: { readonly userId: string; readonly onIdentityMismatch: () => void }): TaskCacheScope => new TaskCacheScope(options);
