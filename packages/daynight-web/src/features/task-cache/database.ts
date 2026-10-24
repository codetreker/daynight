import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Project, TaskDetail, TaskSummary } from "../../api/types";

export const TASK_CACHE_DATABASE = "daynight-task-cache";
export const TASK_CACHE_SCHEMA = 1;
export const TASK_CACHE_STORES = ["userScopes", "projects", "summaries", "details"] as const;
export type UserScopeRecord = { readonly userId: string; readonly userFence: string };
export type ProjectRecord = {
  readonly userId: string; readonly projectId: string; readonly userFence: string;
  readonly cacheGeneration: string; readonly state: "active" | "invalidated";
  readonly invalidatedBy: "access" | "corrupt" | "user" | null;
  readonly epoch: string | null; readonly project: Project | null;
  readonly maxUpdatedAt: string | null; readonly taskCount: number; readonly edgeCount: number;
};
export type SummaryRecord = {
  readonly userId: string; readonly projectId: string; readonly taskId: string;
  readonly summary: TaskSummary;
};
export type TaskIntrinsicDetail = Omit<TaskDetail, "ready" | "blockedBy">;
export type DetailRecord = {
  readonly userId: string; readonly projectId: string; readonly taskId: string;
  readonly userFence: string; readonly cacheGeneration: string;
  readonly detail: TaskIntrinsicDetail; readonly byteSize: number; readonly lastUsedAt: number;
};
export interface TaskCacheSchema extends DBSchema {
  userScopes: { key: string; value: UserScopeRecord };
  projects: { key: [string, string]; value: ProjectRecord; indexes: { "by-user": string } };
  summaries: { key: [string, string, string]; value: SummaryRecord; indexes: { "by-user": string; "by-project": [string, string] } };
  details: { key: [string, string, string]; value: DetailRecord; indexes: { "by-user": string; "by-project": [string, string] } };
}
export class TaskCacheError extends Error {
  constructor(readonly category: "storage" | "blocked" | "versionchange" | "closed" | "corrupt", cause?: unknown) {
    super(`The task cache ${category === "corrupt" ? "is inconsistent" : "is unavailable"}. Please try again.`, cause === undefined ? undefined : { cause });
    this.name = "TaskCacheError";
  }
}

export class TaskCacheDatabase {
  private connection: IDBPDatabase<TaskCacheSchema> | null = null;
  private opening: Promise<IDBPDatabase<TaskCacheSchema>> | null = null;
  private disposed = false;
  constructor(private readonly onFailure: (error: TaskCacheError) => void = () => {}, private readonly version = TASK_CACHE_SCHEMA) {}

  open(): Promise<IDBPDatabase<TaskCacheSchema>> {
    if (this.disposed) return Promise.reject(new DOMException("The task cache scope was released.", "AbortError"));
    if (this.connection !== null) return Promise.resolve(this.connection);
    if (this.opening !== null) return this.opening;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectBlocked: (error: TaskCacheError) => void;
    const blocked = new Promise<never>((_resolve, reject) => { rejectBlocked = reject; });
    let upgradeFailure: unknown;
    const opening = Promise.resolve().then(() => openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, this.version, {
      upgrade(database, oldVersion, _newVersion, transaction) {
        void transaction.done.catch(() => {});
        if (oldVersion === 0) {
          database.createObjectStore("userScopes", { keyPath: "userId" });
          database.createObjectStore("projects", { keyPath: ["userId", "projectId"] }).createIndex("by-user", "userId");
          for (const name of ["summaries", "details"] as const) {
            const store = database.createObjectStore(name, { keyPath: ["userId", "projectId", "taskId"] });
            store.createIndex("by-user", "userId");
            store.createIndex("by-project", ["userId", "projectId"]);
          }
        } else {
          const rebuild = async () => {
            for (const name of ["projects", "summaries", "details"] as const) await transaction.objectStore(name).clear();
            for await (const cursor of transaction.objectStore("userScopes")) await cursor.update({ userId: cursor.value.userId, userFence: crypto.randomUUID() });
          };
          void rebuild().catch((error: unknown) => { upgradeFailure = error; try { transaction.abort(); } catch { /* The failed upgrade may already be aborted. */ } });
        }
      },
      blocked: () => {
        if (timer !== undefined) return;
        timer = setTimeout(() => { timedOut = true; rejectBlocked(new TaskCacheError("blocked")); }, 5_000);
      },
      blocking: () => {
        this.connection?.close(); this.connection = null;
        this.onFailure(new TaskCacheError("versionchange"));
      },
      terminated: () => { this.connection = null; this.onFailure(new TaskCacheError("closed")); },
    })).then((database) => {
      if (timedOut || this.disposed) { database.close(); throw new DOMException("The task cache open was released.", "AbortError"); }
      this.connection = database;
      return database;
    });
    this.opening = Promise.race([opening, blocked]).catch((error: unknown) => {
      if (error instanceof TaskCacheError || this.disposed && error instanceof DOMException && error.name === "AbortError") throw error;
      throw new TaskCacheError("storage", upgradeFailure === undefined ? error : upgradeFailure);
    }).finally(() => { if (timer !== undefined) clearTimeout(timer); this.opening = null; });
    return this.opening;
  }

  close(): void { this.disposed = true; this.connection?.close(); this.connection = null; }
}
