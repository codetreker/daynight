import path from "node:path";
import { openSqliteDatabase, closeSqliteDatabase, type SqliteMigrationReporter } from "../../platform/sqlite-access.js";
import { assertCurrentSqlite } from "../../platform/sqlite-format.js";
import { workerStoreFormat } from "./store-format.js";
import { canonicalId } from "../../api/parse.js";
import type { AgentControlMode, WorkerAgent } from "../../api/types.js";
import type { ClaimIdentity, CleanupSchedule, CleanupScheduleRecord, LocalTask, ProjectIdentity, ResourceOwner, WorkerProject } from "./types.js";

const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a nonempty string.`);
  return value;
};
const id = (value: unknown, name: string): string => {
  const result = canonicalId(text(value, name));
  if (result === null) throw new TypeError(`${name} must be a UUID.`);
  return result;
};
const absolutePath = (value: unknown, name: string): string => {
  const result = text(value, name);
  if (!path.isAbsolute(result)) throw new TypeError(`${name} must be absolute.`);
  return result;
};
const agent = (value: unknown): WorkerAgent => {
  if (value !== "copilot" && value !== "codex" && value !== "claude") throw new TypeError("Worker agent must be copilot, codex or claude.");
  return value;
};
const mode = (value: unknown): AgentControlMode => { if (value === undefined || value === "herdr") return "herdr"; if (value === "web") return "web"; throw new TypeError("Worker control mode must be herdr or web."); };
const projectKey = (value: ProjectIdentity): ProjectIdentity => ({ projectId: id(value.projectId, "Project ID") });
const claimKey = (value: ClaimIdentity): ClaimIdentity => ({ ...projectKey(value), taskId: id(value.taskId, "Task ID"), claimId: id(value.claimId, "Claim ID") });
const projectColumns = "project_id AS projectId, repo_url AS repoUrl, local_path AS localPath";
const taskColumns = "project_id AS projectId, task_id AS taskId, claim_id AS claimId, status, agent, session_id AS sessionId, agent_control_mode AS agentControlMode";
const cleanupColumns = "project_id AS projectId, task_id AS taskId, claim_id AS claimId, worktree_id AS worktreeId, deadline, notified, submitted, failures, next_attempt_at AS nextAttemptAt, stage, last_error AS lastError";
const nonnegativeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer.`);
  return value;
};
const asCleanupState = (value: CleanupSchedule): CleanupSchedule => {
  if (typeof value.notified !== "boolean" || typeof value.submitted !== "boolean") throw new TypeError("Cleanup notification and submission flags must be booleans.");
  if (value.submitted && !value.notified) throw new TypeError("Cleanup submission requires a recorded notification attempt.");
  return { deadline: nonnegativeInteger(value.deadline, "Cleanup deadline"), notified: value.notified, submitted: value.submitted,
    failures: nonnegativeInteger(value.failures, "Cleanup failures"), nextAttemptAt: nonnegativeInteger(value.nextAttemptAt, "Cleanup next attempt"),
    stage: text(value.stage, "Cleanup stage"), lastError: value.lastError === null ? null : text(value.lastError, "Cleanup scheduling error") };
};
type CleanupRow = Omit<CleanupScheduleRecord, "notified" | "submitted"> & { notified: number; submitted: number };
const asCleanupRecord = (row: CleanupRow): CleanupScheduleRecord => {
  if (![0, 1].includes(row.notified) || ![0, 1].includes(row.submitted)) throw new TypeError("Cleanup notification and submission flags must be zero or one.");
  return { ...claimKey(row), worktreeId: id(row.worktreeId, "Worktree ID"), ...asCleanupState({ ...row, notified: row.notified === 1, submitted: row.submitted === 1 }) };
};
const asProject = (row: WorkerProject): WorkerProject => ({ ...projectKey(row), repoUrl: text(row.repoUrl, "Repository URL"), localPath: absolutePath(row.localPath, "Project local path") });
const asTask = (row: LocalTask): LocalTask => {
  if (row.status !== "pending" && row.status !== "active" && row.status !== "done") throw new TypeError("Worker task status must be pending, active or done.");
  return { ...claimKey(row), status: row.status, agent: agent(row.agent), agentControlMode: mode(row.agentControlMode), sessionId: row.sessionId === null ? null : id(row.sessionId, "Native session ID") };
};
export const openWorkerStore = (databaseFile: string, options: { busyTimeoutMs?: number; onMigration?: SqliteMigrationReporter } = {}) => {
  absolutePath(databaseFile, "The SQLite database path");
  const busyTimeoutMs = options.busyTimeoutMs === undefined ? 5000 : options.busyTimeoutMs;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000) throw new TypeError("SQLite busy timeout must be a safe integer between 1 and 60000 milliseconds.");
  const db = openSqliteDatabase({ file: databaseFile, format: workerStoreFormat, allowCreate: true, timeoutMs: busyTimeoutMs,
    ...(options.onMigration === undefined ? {} : { onMigration: options.onMigration }) });
  const atomic = <T>(operation: () => T): T => {
    let guardFailure: unknown;
    try {
      return db.transaction(() => {
        try { assertCurrentSqlite(db, workerStoreFormat); }
        catch (error) { guardFailure = error; throw error; }
        return operation();
      }).immediate();
    } catch (error) {
      if (guardFailure !== undefined && error !== guardFailure) throw new AggregateError([guardFailure, error], "Worker SQLite format assertion and rollback failed.");
      throw error;
    }
  };
  const read = <T>(operation: () => T): T => {
    if (db.inTransaction) { assertCurrentSqlite(db, workerStoreFormat); return operation(); }
    return db.transaction(() => { assertCurrentSqlite(db, workerStoreFormat); return operation(); }).deferred();
  };
  const getProject = (identity: ProjectIdentity): WorkerProject | null => read(() => {
    const row = db.prepare(`SELECT ${projectColumns} FROM projects WHERE project_id = @projectId`).get(projectKey(identity)) as WorkerProject | undefined;
    return row === undefined ? null : asProject(row);
  });
  const getTask = (identity: ClaimIdentity): LocalTask | null => read(() => {
    const row = db.prepare(`SELECT ${taskColumns} FROM tasks WHERE project_id = @projectId AND task_id = @taskId AND claim_id = @claimId`).get(claimKey(identity)) as LocalTask | undefined;
    return row === undefined ? null : asTask(row);
  });
  const getCleanupSchedule = (identity: ClaimIdentity): CleanupScheduleRecord | null => read(() => {
    const row = db.prepare(`SELECT ${cleanupColumns} FROM cleanup_schedules WHERE project_id = @projectId AND task_id = @taskId AND claim_id = @claimId`).get(claimKey(identity)) as CleanupRow | undefined;
    return row === undefined ? null : asCleanupRecord(row);
  });
  const needTask = (identity: ClaimIdentity): LocalTask => {
    const task = getTask(identity);
    if (task === null) throw new Error("The claimed task is not registered.");
    return task;
  };
  return {
    close: (): void => { closeSqliteDatabase(db, { file: databaseFile, format: workerStoreFormat }); },
    getProject,
    listProjects: (): WorkerProject[] => read(() => (db.prepare(`SELECT ${projectColumns} FROM projects ORDER BY project_id`).all() as WorkerProject[]).map(asProject)),
    registerProject: (input: WorkerProject): WorkerProject => atomic(() => {
      const project = asProject(input);
      const existing = getProject(project);
      if (existing !== null && (existing.repoUrl !== project.repoUrl || existing.localPath !== project.localPath)) {
        const unfinished = db.prepare("SELECT 1 FROM tasks WHERE project_id = @projectId AND status <> 'done' LIMIT 1").get(project);
        if (unfinished !== undefined) throw new Error("An unfinished execution prevents changing its project repository binding.");
        if (db.prepare("SELECT 1 FROM cleanup_schedules WHERE project_id = @projectId LIMIT 1").get(project) !== undefined) throw new Error("Outstanding cleanup prevents changing its project repository binding.");
      }
      db.prepare(`INSERT INTO projects(project_id, repo_url, local_path) VALUES (@projectId, @repoUrl, @localPath)
        ON CONFLICT(project_id) DO UPDATE SET repo_url = excluded.repo_url, local_path = excluded.local_path`).run(project);
      return getProject(project)!;
    }),
    getCleanupSchedule,
    listCleanupSchedules: (): CleanupScheduleRecord[] => read(() => (db.prepare(`SELECT ${cleanupColumns} FROM cleanup_schedules ORDER BY project_id, task_id, claim_id`).all() as CleanupRow[]).map(asCleanupRecord)),
    saveCleanupSchedule: (owner: ResourceOwner, state: CleanupSchedule): CleanupScheduleRecord => atomic(() => {
      const record = { ...claimKey(owner), worktreeId: id(owner.worktreeId, "Worktree ID"), ...asCleanupState(state) };
      if (getProject(record) === null) throw new Error("The project repository binding must be registered before cleanup.");
      const previous = getCleanupSchedule(record);
      if (previous !== null) {
        if (previous.worktreeId !== record.worktreeId) throw new Error("The cleanup claim is already bound to a different worktree.");
        if (previous.deadline !== record.deadline) throw new Error("The original cleanup deadline cannot change.");
        if (previous.notified && !record.notified) throw new Error("The cleanup notification attempt cannot be reset.");
        if (previous.submitted && !record.submitted) throw new Error("The cleanup submission cannot be reset.");
      }
      db.prepare(`INSERT INTO cleanup_schedules(project_id, task_id, claim_id, worktree_id, deadline, notified, submitted, failures, next_attempt_at, stage, last_error)
        VALUES (@projectId, @taskId, @claimId, @worktreeId, @deadline, @notified, @submitted, @failures, @nextAttemptAt, @stage, @lastError)
        ON CONFLICT(project_id, task_id, claim_id) DO UPDATE SET notified = excluded.notified, submitted = excluded.submitted,
          failures = excluded.failures, next_attempt_at = excluded.next_attempt_at, stage = excluded.stage, last_error = excluded.last_error`)
        .run({ ...record, notified: Number(record.notified), submitted: Number(record.submitted) });
      return getCleanupSchedule(record)!;
    }),
    deleteCleanupSchedule: (identity: ClaimIdentity): void => atomic(() => {
      db.prepare("DELETE FROM cleanup_schedules WHERE project_id = @projectId AND task_id = @taskId AND claim_id = @claimId").run(claimKey(identity));
    }),
    getTask,
    listTasks: (): LocalTask[] => read(() => (db.prepare(`SELECT ${taskColumns} FROM tasks ORDER BY project_id, task_id, claim_id`).all() as LocalTask[]).map(asTask)),
    listUnfinishedTasks: (): LocalTask[] => read(() => (db.prepare(`SELECT ${taskColumns} FROM tasks WHERE status <> 'done' ORDER BY project_id, task_id, claim_id`).all() as LocalTask[]).map(asTask)),
    registerPending: (input: ClaimIdentity & { agent: WorkerAgent; agentControlMode?: AgentControlMode; sessionId?: string | null }): LocalTask => atomic(() => {
      const key = claimKey(input);
      const tool = agent(input.agent);
      const sessionId = input.sessionId === undefined || input.sessionId === null ? null : id(input.sessionId, "Native session ID");
      if (getProject(key) === null) throw new Error("The project repository binding must be registered before its claimed tasks.");
      const existing = getTask(key);
      if (existing !== null) {
        if (existing.agent !== tool || (input.agentControlMode !== undefined && existing.agentControlMode !== mode(input.agentControlMode))) throw new Error("The claimed task is already registered for a different agent.");
        return existing;
      }
      db.prepare(`INSERT INTO tasks(project_id, task_id, claim_id, status, agent, session_id, agent_control_mode)
        VALUES (@projectId, @taskId, @claimId, 'pending', @agent, @sessionId, @agentControlMode)`).run({ ...key, agent: tool, sessionId, agentControlMode: mode(input.agentControlMode) });
      return needTask(key);
    }),
    activateTask: (identity: ClaimIdentity): LocalTask => atomic(() => {
      const task = needTask(identity);
      if (task.status === "done") throw new Error("The local execution is already done.");
      db.prepare("UPDATE tasks SET status = 'active' WHERE project_id = @projectId AND task_id = @taskId AND claim_id = @claimId").run(claimKey(task));
      return needTask(task);
    }),
    completeTask: (identity: ClaimIdentity): LocalTask => atomic(() => {
      const task = needTask(identity);
      db.prepare("UPDATE tasks SET status = 'done' WHERE project_id = @projectId AND task_id = @taskId AND claim_id = @claimId").run(claimKey(task));
      return needTask(task);
    }),
    setSessionId: (identity: ClaimIdentity, sessionId: string): LocalTask => atomic(() => {
      const task = needTask(identity);
      if (task.status === "done") throw new Error("The local execution is already done.");
      const nativeSessionId = id(sessionId, "Native session ID");
      if (task.sessionId !== null) {
        if (task.sessionId !== nativeSessionId) throw new Error("The claimed task is already bound to a different native session.");
        return task;
      }
      db.prepare("UPDATE tasks SET session_id = @sessionId WHERE project_id = @projectId AND task_id = @taskId AND claim_id = @claimId").run({ ...claimKey(task), sessionId: nativeSessionId });
      return needTask(task);
    }),
  };
};

export type WorkerStore = ReturnType<typeof openWorkerStore>;
