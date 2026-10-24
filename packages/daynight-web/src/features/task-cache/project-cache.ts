import type { IDBPObjectStore, IDBPTransaction } from "idb";
import { ApiError, authRequestsPaused, isAbortError, requestId, waitForAuthRequests } from "../../api/client";
import { canonicalId } from "../../api/parse";
import { parseTaskSummary } from "../../api/task-sync";
import type { Project, TaskSummary, TaskSync } from "../../api/types";
import { TASK_CACHE_STORES, TaskCacheDatabase, TaskCacheError, type ProjectRecord, type TaskCacheSchema } from "./database";
import { validateProjectManifest, validateUserScope } from "./lifecycle";
import { GraphDataError } from "../task-graph/model";
import { compareTimestamps, maxUpdatedAt, projectSummaries, sameProject, sameSummary, type TaskProjection } from "./projection";

type Transaction = IDBPTransaction<TaskCacheSchema, ["userScopes", "projects", "summaries", "details"], "readwrite">;
export type SyncTicket = {
  readonly userId: string; readonly projectId: string; readonly userFence: string;
  readonly cacheGeneration: string; readonly epoch: string | null; readonly maxUpdatedAt: string | null;
};
export type CachedProject = TaskProjection & {
  readonly manifest: ProjectRecord;
  readonly summaries: ReadonlyMap<string, TaskSummary>;
};
export type DetailStore = IDBPObjectStore<TaskCacheSchema, ["userScopes", "projects", "summaries", "details"], "details", "readwrite">;
export type CacheEvent = { readonly projectId: string; readonly error?: unknown };
type Hint = { readonly userId: string; readonly projectId: string | null };
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
  const base = compareTimestamps(current.updatedAt, incoming.updatedAt) > 0 ? current : incoming;
  const settings = current.settings.version > incoming.settings.version ? current.settings : incoming.settings;
  const merged = { ...base, settings };
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
  private readonly pending = new Set<Transaction>();
  private invalidated = false;
  private disposed = false;
  private purge: Promise<void> | null = null;
  private userFence: string | null = null;
  get isInvalidated(): boolean { return this.invalidated || this.disposed; }

  constructor(options: { readonly userId: string; readonly onIdentityMismatch: () => void }) {
    this.userId = requestId(options.userId);
    this.onIdentityMismatch = options.onIdentityMismatch;
    this.database = new TaskCacheDatabase((error) => {
      for (const projectId of this.authorizedProjects) this.emit({ projectId, error });
    });
    this.channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("daynight-task-cache");
    if (this.channel !== null) this.channel.onmessage = (event: MessageEvent<unknown>) => {
      const hint = event.data;
      if (typeof hint !== "object" || hint === null || !("userId" in hint) || hint.userId !== this.userId || !("projectId" in hint)) return;
      if (hint.projectId !== null && typeof hint.projectId !== "string") return;
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
    if (this.invalidated || this.disposed || authRequestsPaused()) return;
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
    for (const name of ["summaries", "details"] as const) {
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
  private materialize(manifest: ProjectRecord, tasks: readonly TaskSummary[]): CachedProject {
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
        graph: { ...previous.graph, project }, index: previous.index, versions: previous.versions,
      };
    } else projection = projectSummaries(project, tasks, project.updatedAt);
    const result: CachedProject = {
      ...projection, manifest,
      summaries: sameTasks ? previous.summaries : new Map(tasks.map((task) => [task.id, task])),
    };
    this.projections.set(manifest.projectId, result);
    return result;
  }
  async beginSync(projectId: string, signal: AbortSignal): Promise<SyncTicket> {
    projectId = requestId(projectId);
    await this.ready(signal);
    try {
      return await this.userTransaction(async (transaction, userFence) => {
        let manifest = await this.manifest(transaction, projectId, userFence);
        if (manifest === undefined) {
          manifest = invalidated(this.userId, projectId, userFence);
          await transaction.objectStore("projects").put(manifest);
        }
        if (manifest.state === "active") await this.stored(transaction, manifest);
        return { userId: this.userId, projectId, userFence, cacheGeneration: manifest.cacheGeneration, epoch: manifest.epoch, maxUpdatedAt: manifest.maxUpdatedAt };
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
    let result: { manifest: ProjectRecord; tasks: readonly TaskSummary[]; changed: boolean; changedTaskIds: readonly string[] };
    try {
      result = await this.userTransaction(async (transaction, userFence) => {
        const current = await this.manifest(transaction, ticket.projectId, userFence);
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
    this.assertLive(signal);
    this.authorizedProjects.add(ticket.projectId);
    const project = this.materialize(result.manifest, result.tasks);
    if (result.changed) { this.hint(ticket.projectId); this.emit({ projectId: ticket.projectId }); }
    return { project, changed: result.changed, changedTaskIds: result.changedTaskIds };
  }
  async readProject(projectId: string, signal: AbortSignal): Promise<CachedProject | null> {
    projectId = requestId(projectId);
    await this.ready(signal);
    const stored = await this.userTransaction(async (transaction, userFence) => {
      const manifest = await this.manifest(transaction, projectId, userFence);
      if (manifest?.state === "invalidated" && manifest.invalidatedBy === "corrupt") throw new TaskCacheError("corrupt");
      if (manifest === undefined || manifest.state === "invalidated") return null;
      return { manifest, tasks: await this.stored(transaction, manifest) };
    }, signal);
    this.assertLive(signal);
    if (stored === null) { this.projections.delete(projectId); return null; }
    return this.materialize(stored.manifest, stored.tasks);
  }
  async detailTransaction<T>(
    ticket: SyncTicket, signal: AbortSignal,
    work: (details: DetailStore, manifest: ProjectRecord, summaries: ReadonlyMap<string, TaskSummary>) => Promise<T>,
  ): Promise<T> {
    await this.ready(signal);
    if (ticket.userId !== this.userId) return released();
    return this.userTransaction(async (transaction, userFence) => {
      const manifest = await this.manifest(transaction, ticket.projectId, userFence);
      if (manifest === undefined || manifest.state !== "active" || userFence !== ticket.userFence ||
        manifest.cacheGeneration !== ticket.cacheGeneration) return released();
      const summaries = await this.stored(transaction, manifest);
      return work(transaction.objectStore("details"), manifest, new Map(summaries.map((summary) => [summary.id, summary])));
    }, signal);
  }
  getSummaryVersion(projectId: string, taskId: string): bigint | null {
    return this.getAuthorizedProject(projectId)?.versions.get(taskId) ?? null;
  }
  getAuthorizedProject(projectId: string): CachedProject | null {
    this.assertLive();
    return this.authorizedProjects.has(projectId) ? this.projections.get(projectId) ?? null : null;
  }
  private async clearProjectRows(transaction: Transaction, projectId: string): Promise<void> {
    for (const name of ["summaries", "details"] as const) {
      const index = transaction.objectStore(name).index("by-project");
      for await (const cursor of index.iterate([this.userId, projectId])) await cursor.delete();
    }
  }
  async invalidateProject(projectId: string, signal: AbortSignal, cause: "access" | "corrupt" = "access"): Promise<void> {
    projectId = requestId(projectId);
    await this.ready(signal);
    await this.userTransaction(async (transaction, fence) => {
      await this.clearProjectRows(transaction, projectId);
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
