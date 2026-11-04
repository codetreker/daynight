import type { IDBPObjectStore, IDBPTransaction } from "idb";
import { ApiError, authRequestsPaused, isAbortError, requestId, waitForAuthRequests } from "../../api/client";
import { canonicalId, record, string } from "../../api/parse";
import { parseProfileVersion } from "../../api/profile-version";
import type { ProjectPersonVersion } from "../../api/auth-types";
import { parseTaskSummary } from "../../api/task-sync";
import type { Project, TaskSummary, TaskSync } from "../../api/types";
import { TASK_CACHE_STORES, TaskCacheDatabase, TaskCacheError, type CachedProfile, type ProjectRecord, type TaskCacheSchema } from "./database";
import { validateProjectManifest, validateUserScope } from "./lifecycle";
import { GraphDataError } from "../task-graph/model";
import { compareTimestamps, maxUpdatedAt, projectSummaries, sameProject, sameSummary, type TaskProjection } from "./projection";

type Transaction = IDBPTransaction<TaskCacheSchema, [...typeof TASK_CACHE_STORES], "readwrite">;
export type SyncTicket = {
  readonly userId: string; readonly projectId: string; readonly userFence: string;
  readonly cacheGeneration: string; readonly epoch: string | null; readonly maxUpdatedAt: string | null;
  readonly scopeRevision: number;
};
export type CachedProject = TaskProjection & {
  readonly manifest: ProjectRecord;
  readonly summaries: ReadonlyMap<string, TaskSummary>;
  readonly assigneeVersions: readonly ProjectPersonVersion[] | null;
};
export type DetailStore = IDBPObjectStore<TaskCacheSchema, [...typeof TASK_CACHE_STORES], "details", "readwrite">;
export type CacheEvent = { readonly projectId: string; readonly error?: unknown; readonly accessRevoked?: true; readonly accessRestored?: true; readonly scopeSuspended?: true; readonly revokedGeneration?: string };
type Hint = { readonly userId: string; readonly projectId: string | null; readonly revokedGeneration?: string; readonly userFence?: string };
class TaskCacheLifecycleChanged extends DOMException {
  constructor() { super("The task cache lifecycle changed.", "AbortError"); }
}
const released = (): never => { throw new TaskCacheLifecycleChanged(); };
const protocol = (): never => { throw new ApiError("protocol"); };
const invalidated = (userId: string, projectId: string, userFence: string, invalidatedBy: "access" | "corrupt" | "user" = "access"): ProjectRecord => ({
  userId, projectId, userFence, cacheGeneration: crypto.randomUUID(), state: "invalidated", invalidatedBy,
  epoch: null, project: null, maxUpdatedAt: null, taskCount: 0, edgeCount: 0,
});
const edgeCount = (tasks: readonly TaskSummary[]): number => tasks.reduce((count, task) => count + task.dependsOn.length, 0);

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
  private readonly projections = new Map<string, CachedProject>();
  private readonly authorizedProjects = new Set<string>();
  private readonly suspendedProjects = new Set<string>();
  private readonly projectRevisions = new Map<string, number>();
  private readonly pending = new Set<Transaction>();
  // Retired generations also fence results whose transactions committed before access withdrawal.
  private readonly revokedGenerations = new Map<string, Set<string>>();
  private readonly deniedProjects = new Map<string, SyncTicket>();
  private readonly projectPurges = new Map<string, Promise<void>>();
  private invalidated = false;
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
    this.channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("daynight-task-cache");
    if (this.channel !== null) this.channel.onmessage = (event: MessageEvent<unknown>) => {
      const hint = event.data;
      if (typeof hint !== "object" || hint === null || !("userId" in hint) || hint.userId !== this.userId || !("projectId" in hint)) return;
      if (hint.projectId !== null && typeof hint.projectId !== "string") return;
      if ("revokedGeneration" in hint) {
        if (typeof hint.projectId !== "string" || canonicalId(hint.projectId) !== hint.projectId || typeof hint.revokedGeneration !== "string" || canonicalId(hint.revokedGeneration) !== hint.revokedGeneration ||
          !("userFence" in hint) || typeof hint.userFence !== "string" || canonicalId(hint.userFence) !== hint.userFence) return;
        const current = this.projections.get(hint.projectId)?.manifest;
        if (this.userFence !== hint.userFence || current !== undefined && (current.cacheGeneration !== hint.revokedGeneration || current.userFence !== hint.userFence)) return;
        const ticket = { userId: this.userId, projectId: hint.projectId, userFence: hint.userFence, cacheGeneration: hint.revokedGeneration,
          epoch: current === undefined ? null : current.epoch, maxUpdatedAt: current === undefined ? null : current.maxUpdatedAt,
          scopeRevision: this.projectRevisions.get(hint.projectId) ?? 0 };
        void this.revokeProject(ticket, this.signal, false).catch((error: unknown) => {
          if (!isAbortError(error)) console.warn("Task cache access cleanup failed", { projectId: ticket.projectId, error_category: error instanceof TaskCacheError ? error.category : "protocol" });
        });
        return;
      }
      void this.receiveHint({ userId: this.userId, projectId: hint.projectId }).catch((error: unknown) => {
        if (!isAbortError(error)) for (const projectId of this.authorizedProjects) this.emit({ projectId, error });
      });
    };
  }
  private readonly onIdentityMismatch: () => void;
  private assertLive(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.invalidated || this.disposed || this.lifetime.signal.aborted || authRequestsPaused()) released();
  }
  get signal(): AbortSignal { return this.lifetime.signal; }
  async ready(signal: AbortSignal): Promise<void> {
    await waitForAuthRequests(AbortSignal.any([signal, this.lifetime.signal]));
    this.assertLive(signal);
  }
  principalMismatch = (): void => {
    this.invalidateScope();
    this.onIdentityMismatch();
  };
  subscribe = (listener: (event: CacheEvent) => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private emit(event: CacheEvent): void {
    if (this.invalidated || this.disposed || authRequestsPaused() && event.accessRevoked !== true) return;
    for (const listener of this.listeners) listener(event);
  }
  private hint(projectId: string | null): void {
    this.channel?.postMessage({ userId: this.userId, projectId } satisfies Hint);
  }
  private async receiveHint(hint: Hint): Promise<void> {
    await this.ready(this.lifetime.signal);
    const projects = hint.projectId === null ? [...this.authorizedProjects] : this.authorizedProjects.has(hint.projectId) ? [hint.projectId] : [];
    for (const projectId of projects) {
      // A hint carries no content or access grant; receivers read the committed stores.
      await this.readProject(projectId, this.lifetime.signal);
      this.assertLive();
      this.emit({ projectId });
    }
  }
  private async transaction<T>(work: (transaction: Transaction) => Promise<T>, signal?: AbortSignal, allowInvalidated = false): Promise<T> {
    if (!allowInvalidated) this.assertLive(signal);
    const database = await this.database.open();
    if (!allowInvalidated) this.assertLive(signal);
    let transaction: Transaction;
    try { transaction = database.transaction([...TASK_CACHE_STORES], "readwrite"); }
    catch (error) { throw new TaskCacheError("storage", error); }
    this.pending.add(transaction);
    const completion = transaction.done;
    void completion.catch(() => {});
    const abort = () => { try { transaction.abort(); } catch { /* A completed transaction has no pending publication. */ } };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await work(transaction);
      if (!allowInvalidated) this.assertLive(signal);
      await completion;
      return result;
    } catch (error) {
      abort();
      await completion.catch(() => {});
      if (error instanceof ApiError || error instanceof TaskCacheError || error instanceof TaskCacheLifecycleChanged ||
        signal?.aborted === true || !allowInvalidated && this.lifetime.signal.aborted) throw error;
      throw new TaskCacheError("storage", error);
    } finally {
      signal?.removeEventListener("abort", abort);
      this.pending.delete(transaction);
    }
  }
  private async replaceUserScope(transaction: Transaction, cause: "corrupt" | "user"): Promise<string> {
    const userFence = crypto.randomUUID();
    await transaction.objectStore("userScopes").put({ userId: this.userId, userFence });
    for (const name of ["summaries", "details", "profiles"] as const) {
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
    if (outcome.kind === "repaired" && !this.isInvalidated && !authRequestsPaused()) this.hint(null);
    if (this.userFence !== null && this.userFence !== outcome.userFence && !this.isInvalidated) {
      this.close(); this.onIdentityMismatch(); return released();
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
  private async stored(transaction: Transaction, manifest: ProjectRecord): Promise<readonly TaskSummary[]> {
    const rows = await transaction.objectStore("summaries").index("by-project").getAll([this.userId, manifest.projectId]);
    try {
      const tasks = rows.map((row) => {
        if (row.userId !== this.userId || row.projectId !== manifest.projectId || row.taskId !== row.summary.id || typeof row.summary.version !== "bigint") throw new Error("Invalid summary ownership");
        return parseTaskSummary({ ...row.summary, version: row.summary.version.toString() });
      });
      if (tasks.length !== manifest.taskCount || edgeCount(tasks) !== manifest.edgeCount ||
        maxUpdatedAt(tasks) !== manifest.maxUpdatedAt) throw new Error("Summary manifest does not match its complete set");
      projectSummaries(manifest.project!, tasks, manifest.project!.updatedAt);
      return tasks;
    } catch (error) { if (error instanceof TaskCacheError || isAbortError(error)) throw error; throw new TaskCacheError("corrupt", error); }
  }
  private materialize(manifest: ProjectRecord, tasks: readonly TaskSummary[], assigneeVersions?: readonly ProjectPersonVersion[]): CachedProject {
    const previous = this.projections.get(manifest.projectId);
    const sameTasks = previous !== undefined && previous.manifest.cacheGeneration === manifest.cacheGeneration &&
      previous.summaries.size === tasks.length && tasks.every((task) => {
        const existing = previous.summaries.get(task.id);
        return existing !== undefined && sameSummary(existing, task);
      });
    const project = manifest.project!;
    let projection: TaskProjection;
    if (sameTasks) {
      projection = sameProject(previous.graph.project, project) ? previous : {
        graph: { ...previous.graph, project }, index: previous.index, versions: previous.versions, pausedTaskIds: previous.pausedTaskIds,
      };
    } else projection = projectSummaries(project, tasks, project.updatedAt);
    const result: CachedProject = {
      ...projection, manifest,
      summaries: sameTasks ? previous.summaries : new Map(tasks.map((task) => [task.id, task])),
      assigneeVersions: assigneeVersions ?? (previous?.manifest.cacheGeneration === manifest.cacheGeneration ? previous.assigneeVersions : null),
    };
    this.projections.set(manifest.projectId, result);
    return result;
  }
  private assertProjectGeneration(projectId: string, cacheGeneration: string, signal?: AbortSignal, revision?: number): void {
    this.assertLive(signal);
    if (this.suspendedProjects.has(projectId) || revision !== undefined && revision !== (this.projectRevisions.get(projectId) ?? 0)) released();
    if (this.revokedGenerations.get(projectId)?.has(cacheGeneration) === true) released();
  }
  private clearDeniedProject(projectId: string): Promise<void> {
    const active = this.projectPurges.get(projectId);
    if (active !== undefined) return active;
    const ticket = this.deniedProjects.get(projectId);
    if (ticket === undefined) return Promise.resolve();
    // Cleanup belongs to the scope; the observing dialog can unmount as soon as access is withdrawn.
    const work = this.ready(this.signal).then(() => this.userTransaction(async (transaction, userFence) => {
      const manifest = await this.manifest(transaction, projectId, userFence);
      if (userFence !== ticket.userFence || manifest?.cacheGeneration !== ticket.cacheGeneration) return;
      await this.clearProjectRows(transaction, projectId, true);
      await transaction.objectStore("projects").put(invalidated(this.userId, projectId, userFence));
    }, this.signal)).then(() => {
      if (this.deniedProjects.get(projectId) === ticket) this.deniedProjects.delete(projectId);
      this.hint(projectId);
    }).catch((error: unknown) => {
      this.emit({ projectId, accessRevoked: true, revokedGeneration: ticket.cacheGeneration, error });
      throw error;
    }).finally(() => { if (this.projectPurges.get(projectId) === work) this.projectPurges.delete(projectId); });
    this.projectPurges.set(projectId, work);
    return work;
  }
  canRevokeProject(ticket: SyncTicket): boolean {
    if (this.isInvalidated || ticket.userId !== this.userId || ticket.userFence !== this.userFence || ticket.scopeRevision !== this.getProjectRevision(ticket.projectId)) return false;
    const denied = this.deniedProjects.get(ticket.projectId);
    if (denied !== undefined && (denied.userFence !== ticket.userFence || denied.cacheGeneration !== ticket.cacheGeneration)) return false;
    const current = this.projections.get(ticket.projectId);
    return current === undefined || current.manifest.userFence === ticket.userFence && current.manifest.cacheGeneration === ticket.cacheGeneration;
  }
  revokeProject(ticket: SyncTicket, signal: AbortSignal, broadcast = true, reason: ApiError = new ApiError("server", 404, "not_found")): Promise<boolean> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.isInvalidated) return Promise.reject(new TaskCacheLifecycleChanged());
    if (ticket.userId !== this.userId || ticket.userFence !== this.userFence) return Promise.reject(new ApiError("protocol"));
    if (!this.canRevokeProject(ticket)) return Promise.resolve(false);
    const denied = this.deniedProjects.get(ticket.projectId);
    let revoked = this.revokedGenerations.get(ticket.projectId);
    if (revoked === undefined) { revoked = new Set(); this.revokedGenerations.set(ticket.projectId, revoked); }
    revoked.add(ticket.cacheGeneration);
    if (denied === undefined) this.deniedProjects.set(ticket.projectId, ticket);
    this.projections.delete(ticket.projectId); this.authorizedProjects.delete(ticket.projectId);
    if (broadcast) this.channel?.postMessage({ userId: this.userId, projectId: ticket.projectId, userFence: ticket.userFence, revokedGeneration: ticket.cacheGeneration } satisfies Hint);
    this.emit({ projectId: ticket.projectId, accessRevoked: true, revokedGeneration: ticket.cacheGeneration, error: reason });
    return this.clearDeniedProject(ticket.projectId).then(() => true);
  }
  async beginSync(projectId: string, signal: AbortSignal): Promise<SyncTicket> {
    projectId = requestId(projectId);
    const scopeRevision = this.projectRevisions.get(projectId) ?? 0;
    await this.ready(signal);
    await this.clearDeniedProject(projectId);
    try {
      return await this.userTransaction(async (transaction, userFence) => {
        let manifest = await this.manifest(transaction, projectId, userFence);
        if (manifest === undefined) {
          manifest = invalidated(this.userId, projectId, userFence);
          await transaction.objectStore("projects").put(manifest);
        }
        if (manifest.state === "active") await this.stored(transaction, manifest);
        return { userId: this.userId, projectId, userFence, cacheGeneration: manifest.cacheGeneration, epoch: manifest.epoch, maxUpdatedAt: manifest.maxUpdatedAt, scopeRevision };
      }, signal);
    } catch (error) {
      if (!(error instanceof TaskCacheError) || error.category !== "corrupt") throw error;
      console.warn("Task cache rebuild", { projectId, error_category: "corrupt" });
      await this.invalidateProject(projectId, signal, "corrupt");
      return this.beginSync(projectId, signal);
    }
  }
  async applySync(ticket: SyncTicket, response: TaskSync, signal: AbortSignal): Promise<{ readonly project: CachedProject; readonly changed: boolean; readonly changedTaskIds: readonly string[] }> {
    await this.ready(signal);
    if (response.project.id !== ticket.projectId || ticket.userId !== this.userId) return protocol();
    this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
    let result: { manifest: ProjectRecord; tasks: readonly TaskSummary[]; changed: boolean; changedTaskIds: readonly string[] };
    try {
      result = await this.userTransaction(async (transaction, userFence) => {
        const current = await this.manifest(transaction, ticket.projectId, userFence);
        this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
        if (userFence !== ticket.userFence || current === undefined || current.cacheGeneration !== ticket.cacheGeneration) return released();
        const previous = current.state === "active" ? await this.stored(transaction, current) : [];
        if (response.mode === "delta" && (current.state !== "active" || response.epoch !== current.epoch || response.epoch !== ticket.epoch)) return protocol();
        if (response.mode === "snapshot" && ticket.epoch === response.epoch) return protocol();
        const replacing = response.mode === "snapshot";
        const merged = new Map((replacing ? [] : previous).map((task) => [task.id, task]));
        const changedTaskIds: string[] = [];
        for (const task of response.tasks) {
          const existing = merged.get(task.id);
          if (existing !== undefined && existing.version > task.version) continue;
          if (existing !== undefined && existing.version === task.version) {
            if (!sameSummary(existing, task)) return protocol();
            continue;
          }
          merged.set(task.id, task); changedTaskIds.push(task.id);
        }
        const tasks = [...merged.values()];
        const project = current.project === null || replacing ? response.project : mergeProject(current.project, response.project);
        try { projectSummaries(project, tasks, response.observedAt); }
        catch (error) { if (error instanceof GraphDataError) throw new ApiError("protocol", null, "protocol", null, undefined, error); throw error; }
        const manifest: ProjectRecord = {
          userId: this.userId, projectId: ticket.projectId, userFence: ticket.userFence,
          cacheGeneration: replacing ? crypto.randomUUID() : current.cacheGeneration,
          state: "active", invalidatedBy: null, epoch: response.epoch, project,
          maxUpdatedAt: maxUpdatedAt(tasks), taskCount: tasks.length, edgeCount: edgeCount(tasks),
        };
        this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
        const changed = replacing || changedTaskIds.length !== 0 || current.project === null || !sameProject(current.project, project);
        if (replacing) await this.clearProjectRows(transaction, ticket.projectId);
        for (const taskId of changedTaskIds) {
          const summary = merged.get(taskId)!;
          await transaction.objectStore("summaries").put({ userId: this.userId, projectId: ticket.projectId, taskId, summary });
          if (!replacing) await transaction.objectStore("details").delete([this.userId, ticket.projectId, taskId]);
        }
        if (changed) await transaction.objectStore("projects").put(manifest);
        return { manifest: changed ? manifest : current, tasks, changed, changedTaskIds };
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
    this.authorizedProjects.add(ticket.projectId);
    const project = this.materialize(result.manifest, result.tasks, response.assigneeVersions);
    if (result.changed) this.hint(ticket.projectId);
    if (result.changed || versionsChanged) this.emit({ projectId: ticket.projectId });
    return { project, changed: result.changed, changedTaskIds: result.changedTaskIds };
  }
  async readProject(projectId: string, signal: AbortSignal): Promise<CachedProject | null> {
    projectId = requestId(projectId);
    const revision = this.projectRevisions.get(projectId) ?? 0;
    await this.ready(signal);
    const stored = await this.userTransaction(async (transaction, userFence) => {
      const manifest = await this.manifest(transaction, projectId, userFence);
      if (manifest?.state === "invalidated" && manifest.invalidatedBy === "corrupt") throw new TaskCacheError("corrupt");
      if (manifest === undefined || manifest.state === "invalidated") return null;
      return { manifest, tasks: await this.stored(transaction, manifest) };
    }, signal);
    this.assertLive(signal);
    if (revision !== this.getProjectRevision(projectId) || this.suspendedProjects.has(projectId)) return released();
    if (stored === null) { this.projections.delete(projectId); return null; }
    this.assertProjectGeneration(projectId, stored.manifest.cacheGeneration, signal, revision);
    return this.materialize(stored.manifest, stored.tasks);
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
      const summaries = await this.stored(transaction, manifest);
      return work(transaction.objectStore("details"), manifest, new Map(summaries.map((summary) => [summary.id, summary])));
    }, signal);
    this.assertProjectGeneration(ticket.projectId, ticket.cacheGeneration, signal, ticket.scopeRevision);
    return result;
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
  isProjectSuspended(projectId: string): boolean { return this.suspendedProjects.has(projectId); }
  suspendProject(projectId: string): void {
    projectId = requestId(projectId);
    if (this.isInvalidated) return;
    this.projectRevisions.set(projectId, (this.projectRevisions.get(projectId) ?? 0) + 1);
    this.suspendedProjects.add(projectId);
    if (!this.revokedGenerations.has(projectId)) this.revokedGenerations.set(projectId, new Set());
    this.projections.delete(projectId); this.authorizedProjects.delete(projectId);
    this.emit({ projectId, accessRevoked: true, scopeSuspended: true });
  }
  resumeProject(projectId: string): void {
    if (!this.suspendedProjects.delete(projectId)) return;
    this.projectRevisions.set(projectId, (this.projectRevisions.get(projectId) ?? 0) + 1);
    this.emit({ projectId, accessRestored: true });
  }
  getSummaryVersion(projectId: string, taskId: string): bigint | null {
    return this.getAuthorizedProject(projectId)?.versions.get(taskId) ?? null;
  }
  canPreviewProject(projectId: string): boolean {
    this.assertLive();
    // A surviving replacement generation cannot undo this scope's observed access withdrawal.
    return !this.suspendedProjects.has(projectId) && (!this.revokedGenerations.has(projectId) || this.authorizedProjects.has(projectId));
  }
  getAuthorizedProject(projectId: string): CachedProject | null {
    this.assertLive();
    return !this.suspendedProjects.has(projectId) && this.authorizedProjects.has(projectId) ? this.projections.get(projectId) ?? null : null;
  }
  private async clearProjectRows(transaction: Transaction, projectId: string, includeProfiles = false): Promise<void> {
    const stores = includeProfiles ? ["summaries", "details", "profiles"] as const : ["summaries", "details"] as const;
    for (const name of stores) {
      const index = transaction.objectStore(name).index("by-project");
      for await (const cursor of index.iterate([this.userId, projectId])) await cursor.delete();
    }
  }
  async invalidateProject(projectId: string, signal: AbortSignal, cause: "access" | "corrupt" = "access"): Promise<void> {
    projectId = requestId(projectId);
    await this.ready(signal);
    await this.userTransaction(async (transaction, fence) => {
      await this.clearProjectRows(transaction, projectId, true);
      await transaction.objectStore("projects").put(invalidated(this.userId, projectId, fence, cause));
    }, signal);
    if (cause === "access") { this.projections.delete(projectId); this.authorizedProjects.delete(projectId); }
    this.hint(projectId); this.emit(cause === "corrupt" ? { projectId, error: new TaskCacheError("corrupt") } : { projectId });
  }
  invalidateScope(): Promise<void> {
    if (this.purge !== null) return this.purge;
    if (this.disposed) return Promise.resolve();
    this.invalidated = true;
    this.lifetime.abort();
    for (const transaction of this.pending) { try { transaction.abort(); } catch { /* Already committed. */ } }
    this.projections.clear(); this.authorizedProjects.clear(); this.listeners.clear();
    this.purge = this.transaction(async (transaction) => { await this.replaceUserScope(transaction, "user"); }, undefined, true)
      .then(() => { this.hint(null); }).finally(() => { this.close(); });
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
    for (const transaction of this.pending) { try { transaction.abort(); } catch { /* Already completed. */ } }
    this.pending.clear(); this.channel?.close(); this.database.close();
    this.projections.clear(); this.authorizedProjects.clear(); this.listeners.clear();
  }
}

export const createTaskCacheScope = (options: { readonly userId: string; readonly onIdentityMismatch: () => void }): TaskCacheScope => new TaskCacheScope(options);
