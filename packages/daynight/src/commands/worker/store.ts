import path from "node:path";
import Database from "better-sqlite3";
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
const schema = `
  CREATE TABLE projects (
    project_id TEXT PRIMARY KEY NOT NULL,
    repo_url TEXT NOT NULL,
    local_path TEXT NOT NULL
  ) STRICT;
  CREATE TABLE tasks (
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'done')),
    agent TEXT NOT NULL CHECK(agent IN ('copilot', 'codex', 'claude')),
    session_id TEXT,
    agent_control_mode TEXT NOT NULL DEFAULT 'herdr' CHECK(agent_control_mode IN ('herdr', 'web')),
    PRIMARY KEY(project_id, task_id, claim_id)
  ) STRICT;
  CREATE UNIQUE INDEX tasks_one_active_per_task ON tasks(project_id, task_id) WHERE status = 'active';
`;
const expectedColumns = {
  projects: ["project_id", "repo_url", "local_path"],
  tasks: ["project_id", "task_id", "claim_id", "status", "agent", "session_id", "agent_control_mode"],
};
const unsupportedSchema = (): Error => new Error("The worker SQLite schema is incompatible. Stop the worker and delete its old state.sqlite before starting this version.");

export const openWorkerStore = (databaseFile: string, options: { busyTimeoutMs?: number } = {}) => {
  absolutePath(databaseFile, "The SQLite database path");
  const busyTimeoutMs = options.busyTimeoutMs === undefined ? 5000 : options.busyTimeoutMs;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000) throw new TypeError("SQLite busy timeout must be a safe integer between 1 and 60000 milliseconds.");
  const db = new Database(databaseFile, { timeout: busyTimeoutMs });
  try {
    if (db.pragma("journal_mode = WAL", { simple: true }) !== "wal") throw new Error("SQLite refused WAL mode.");
    db.pragma("synchronous = FULL");
    if (db.pragma("synchronous", { simple: true }) !== 2) throw new Error("SQLite refused synchronous=FULL.");
    db.transaction(() => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
      if (tables.length === 0) db.exec(schema);
      else {
        if (tables.length !== 2 || tables[0]!.name !== "projects" || tables[1]!.name !== "tasks") throw unsupportedSchema();
        const taskColumns = db.pragma("table_info(tasks)") as { name: string }[];
        if (taskColumns.map(column => column.name).join(",") === "project_id,task_id,claim_id,status,agent,session_id") {
          db.exec("ALTER TABLE tasks RENAME TO legacy_tasks; DROP INDEX tasks_one_active_per_task;");
          db.exec(schema.slice(schema.indexOf("CREATE TABLE tasks")));
          db.exec("INSERT INTO tasks(project_id, task_id, claim_id, status, agent, session_id) SELECT project_id, task_id, claim_id, status, agent, session_id FROM legacy_tasks; DROP TABLE legacy_tasks;");
        }
        for (const [table, expected] of Object.entries(expectedColumns)) {
          const columns = db.pragma(`table_info(${table})`) as { name: string }[];
          if (columns.length !== expected.length || columns.some((column, index) => column.name !== expected[index])) throw unsupportedSchema();
        }
        const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'tasks_one_active_per_task'").get() as { sql: string } | undefined;
        if (index === undefined) throw unsupportedSchema();
      }
    }).immediate();
  } catch (error) {
    try { db.close(); } catch (closeError) { throw new AggregateError([error, closeError], "Worker SQLite startup and connection cleanup failed."); }
    throw error;
  }
  const atomic = <T>(operation: () => T): T => db.transaction(operation).immediate();
  const getProject = (identity: ProjectIdentity): WorkerProject | null => {
    const row = db.prepare(`SELECT ${projectColumns} FROM projects WHERE project_id = @projectId`).get(projectKey(identity)) as WorkerProject | undefined;
    return row === undefined ? null : asProject(row);
  };
  const getTask = (identity: ClaimIdentity): LocalTask | null => {
    const row = db.prepare(`SELECT ${taskColumns} FROM tasks WHERE project_id = @projectId AND task_id = @taskId AND claim_id = @claimId`).get(claimKey(identity)) as LocalTask | undefined;
    return row === undefined ? null : asTask(row);
  };
  const needTask = (identity: ClaimIdentity): LocalTask => {
    const task = getTask(identity);
    if (task === null) throw new Error("The claimed task is not registered.");
    return task;
  };
  return {
    close: (): void => { db.close(); },
    getProject,
    listProjects: (): WorkerProject[] => (db.prepare(`SELECT ${projectColumns} FROM projects ORDER BY project_id`).all() as WorkerProject[]).map(asProject),
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
    listTasks: (): LocalTask[] => (db.prepare(`SELECT ${taskColumns} FROM tasks ORDER BY project_id, task_id, claim_id`).all() as LocalTask[]).map(asTask),
    listUnfinishedTasks: (): LocalTask[] => (db.prepare(`SELECT ${taskColumns} FROM tasks WHERE status <> 'done' ORDER BY project_id, task_id, claim_id`).all() as LocalTask[]).map(asTask),
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
