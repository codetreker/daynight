import path from "node:path";
import { openSqliteDatabase, closeSqliteDatabase, type SqliteMigrationReporter } from "../../platform/sqlite-access.js";
import { assertCurrentSqlite } from "../../platform/sqlite-format.js";
import { workerStoreFormat } from "./store-format.js";
import { canonicalId } from "../../api/parse.js";
import type { AgentControlMode, WorkerAgent } from "../../api/types.js";
import type { ClaimIdentity, LocalTask, ProjectIdentity, WorkerProject } from "./types.js";

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
const asProject = (row: WorkerProject): WorkerProject => ({ ...projectKey(row), repoUrl: text(row.repoUrl, "Repository URL"), localPath: absolutePath(row.localPath, "Project local path") });
const asTask = (row: LocalTask): LocalTask => {
  if (row.status !== "pending" && row.status !== "active" && row.status !== "done") throw new TypeError("Worker task status must be pending, active or done.");
  return { ...claimKey(row), status: row.status, agent: agent(row.agent), agentControlMode: mode(row.agentControlMode), sessionId: row.sessionId === null ? null : id(row.sessionId, "Native session ID") };
};
export const openWorkerStore = (databaseFile: string, options: { busyTimeoutMs?: number; onMigration?: SqliteMigrationReporter } = {}) => {
  absolutePath(databaseFile, "The SQLite database path");
  const busyTimeoutMs = options.busyTimeoutMs === undefined ? 5000 : options.busyTimeoutMs;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000) throw new TypeError("SQLite busy timeout must be a safe integer between 1 and 60000 milliseconds.");
  const db = openSqliteDatabase({ file: databaseFile, format: workerStoreFormat, allowEmpty: true, timeoutMs: busyTimeoutMs,
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
      }
      db.prepare(`INSERT INTO projects(project_id, repo_url, local_path) VALUES (@projectId, @repoUrl, @localPath)
        ON CONFLICT(project_id) DO UPDATE SET repo_url = excluded.repo_url, local_path = excluded.local_path`).run(project);
      return getProject(project)!;
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
