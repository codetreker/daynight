import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { WorkerStore } from "../../../src/commands/worker/store.js";
import type { ClaimIdentity, WorkerProject } from "../../../src/commands/worker/types.js";

const root = fileURLToPath(new URL("../../../../../.tmp/worker-store-tests/", import.meta.url));
const directories: string[] = [];
const stores = new Set<WorkerStore>();
const connections = new Set<Database.Database>();
const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const claim: ClaimIdentity = { projectId: uuid(1), taskId: uuid(2), claimId: uuid(3) };
const open = (file: string): WorkerStore => { const store = openWorkerStore(file, { onMigration: () => {} }); stores.add(store); return store; };
const close = (store: WorkerStore): void => { store.close(); stores.delete(store); };
const connect = (file: string): Database.Database => { const database = new Database(file); connections.add(database); return database; };
const fixture = () => {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, "SQLite 用户 "));
  directories.push(directory);
  const file = path.join(directory, "state.sqlite");
  const store = open(file);
  const project: WorkerProject = { projectId: claim.projectId, repoUrl: "https://github.com/owner/repo.git", localPath: path.join(directory, "repo") };
  const register = () => { store.registerProject(project); return store.registerPending({ ...claim, agent: "codex" }); };
  return { directory, file, store, project, register };
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores) store.close();
  stores.clear();
  for (const connection of connections) if (connection.open) connection.close();
  connections.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("minimal worker SQLite schema", () => {
  it("creates the project mapping, task index and cleanup schedule with WAL/FULL", () => {
    const pragma = vi.spyOn(Database.prototype, "pragma");
    const { file, store } = fixture();
    const database = connect(file);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: "bot_executions" }, { name: "bots" }, { name: "claim_native_configurations" }, { name: "cleanup_schedules" }, { name: "projects" }, { name: "tasks" }]);
    expect((database.pragma("table_info(projects)") as { name: string }[]).map(({ name }) => name)).toEqual(["project_id", "repo_url", "local_path"]);
    expect((database.pragma("table_info(tasks)") as { name: string }[]).map(({ name }) => name)).toEqual(["project_id", "task_id", "claim_id", "status", "agent", "session_id", "agent_control_mode"]);
    expect((database.pragma("table_list") as { name: string; strict: number }[]).filter(({ name }) => name === "projects" || name === "tasks").every(({ strict }) => strict === 1)).toBe(true);
    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.pragma("user_version", { simple: true })).toBe(12);
    expect(pragma).toHaveBeenCalledWith("synchronous = FULL");
    expect(database.pragma("foreign_key_list(projects)")).toEqual([]);
    expect(database.pragma("foreign_key_list(tasks)")).toEqual([]);
    expect(store.listProjects()).toEqual([]);
    expect(store.listTasks()).toEqual([]);
  });

  it("initializes an empty database created by the instance lock", () => {
    const { file, store } = fixture();
    close(store);
    rmSync(file);
    const gate = connect(file);
    gate.close();
    expect(open(file).listTasks()).toEqual([]);
  });

  it("rejects the old schema without changing its records or adding migration state", () => {
    const { file, store } = fixture();
    close(store);
    const database = connect(file);
    database.exec("DROP TABLE projects; DROP TABLE tasks; CREATE TABLE projects(server_origin TEXT, project_id TEXT, repo_url TEXT, local_path TEXT); CREATE TABLE tasks(task_id TEXT, payload TEXT); INSERT INTO tasks VALUES ('old-task', 'retained')");
    database.pragma("user_version = 3");
    expect(() => open(file)).toThrow("unsupported-version");
    expect(database.prepare("SELECT * FROM tasks").all()).toEqual([{ task_id: "old-task", payload: "retained" }]);
    expect(database.pragma("user_version", { simple: true })).toBe(3);
  });

  it("rejects an unrelated or incomplete database", () => {
    const { file, store } = fixture();
    close(store);
    const database = connect(file);
    database.exec("DROP TABLE tasks; CREATE TABLE other(value TEXT); INSERT INTO other VALUES ('retained')");
    expect(() => open(file)).toThrow("invalid-format");
    expect(database.prepare("SELECT value FROM other").get()).toEqual({ value: "retained" });
  });

  it("rejects a missing task uniqueness index", () => {
    const { file, store } = fixture();
    close(store);
    connect(file).exec("DROP INDEX tasks_one_active_per_task");
    expect(() => open(file)).toThrow("invalid-format");
  });
});

describe("worker claim and native session index", () => {
  it("retains a known native identity and rejects a different observed session", () => {
    const { file, store, project } = fixture();
    store.registerProject(project);
    expect(store.registerPending({ ...claim, agent: "copilot", agentControlMode: "herdr" as const, sessionId: uuid(8) }).sessionId).toBe(uuid(8));
    const concurrent = open(file);
    expect(store.setSessionId(claim, uuid(8)).sessionId).toBe(uuid(8));
    expect(() => concurrent.setSessionId(claim, uuid(9))).toThrow("different native session");
    expect(() => store.setSessionId(claim, "bad")).toThrow("Native session ID must be a UUID");
    expect(store.getTask(claim)?.sessionId).toBe(uuid(8));
    expect(concurrent.getTask(claim)?.sessionId).toBe(uuid(8));
  });

  it("permits only one active claim for the same project and task across connections", () => {
    const { file, store, register } = fixture();
    register();
    const newer = { ...claim, claimId: uuid(4), agent: "codex" as const };
    store.registerPending(newer);
    const concurrent = open(file);
    store.activateTask(claim);
    expect(() => concurrent.activateTask(newer)).toThrow("UNIQUE constraint failed");
    expect(concurrent.getTask(newer)?.status).toBe("pending");
    store.completeTask(claim);
    expect(concurrent.activateTask(newer).status).toBe("active");
    expect(store.listTasks()).toEqual([
      { ...claim, status: "done", agent: "codex", agentControlMode: "herdr" as const, sessionId: null },
      { ...newer, status: "active", agentControlMode: "herdr", sessionId: null },
    ]);
  });

  it("persists only task identity, status, agent and native session across reopen", () => {
    const { file, store, register, project } = fixture();
    register();
    store.activateTask(claim);
    store.setSessionId(claim, uuid(8));
    close(store);
    const recovered = open(file);
    expect(recovered.getProject(project)).toEqual(project);
    expect(recovered.getTask(claim)).toEqual({ ...claim, status: "active", agent: "codex", agentControlMode: "herdr" as const, sessionId: uuid(8) });
    expect(Object.keys(recovered.getTask(claim)!)).toEqual(["projectId", "taskId", "claimId", "status", "agent", "agentControlMode", "sessionId"]);
  });
});

it("freezes the selected Web routing mode across reopen and later configuration changes", () => {
  const f = fixture(); f.store.registerProject(f.project);
  f.store.registerPending({ ...claim, agent: "claude", agentControlMode: "web" }); close(f.store);
  const reopened = open(f.file);
  expect(reopened.getTask(claim)).toMatchObject({ agent: "claude", agentControlMode: "web" });
  expect(() => reopened.registerPending({ ...claim, agent: "claude", agentControlMode: "herdr" })).toThrow();
});

const legacyFixture = () => {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, "legacy-")); directories.push(directory);
  const file = path.join(directory, "state.sqlite"), db = connect(file);
  db.exec(`CREATE TABLE projects (project_id TEXT PRIMARY KEY NOT NULL, repo_url TEXT NOT NULL, local_path TEXT NOT NULL) STRICT;
    CREATE TABLE tasks (project_id TEXT NOT NULL, task_id TEXT NOT NULL, claim_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'done')),
      agent TEXT NOT NULL CHECK(agent IN ('copilot', 'codex')), session_id TEXT,
      PRIMARY KEY(project_id, task_id, claim_id)) STRICT;
    CREATE UNIQUE INDEX tasks_one_active_per_task ON tasks(project_id, task_id) WHERE status = 'active';`);
  db.prepare("INSERT INTO projects VALUES(?,?,?)").run(claim.projectId, "https://example.test/repo.git", directory);
  const rows = [
    [claim.projectId, claim.taskId, claim.claimId, "active", "codex", uuid(30)],
    [claim.projectId, uuid(21), uuid(22), "pending", "copilot", null],
    [claim.projectId, uuid(23), uuid(24), "done", "codex", uuid(31)],
  ];
  for (const row of rows) db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?)").run(...row);
  return { file, db, rows };
};

it("rebuilds the unversioned six-column index and discards every project and claim", () => {
  const { file, db } = legacyFixture();
  const events: unknown[] = [];
  const rebuilt = openWorkerStore(file, { onMigration: event => { events.push(event); } }); stores.add(rebuilt);
  expect(db.pragma("user_version", { simple: true })).toBe(12);
  expect(rebuilt.listProjects()).toEqual([]);
  expect(rebuilt.listTasks()).toEqual([]);
  expect((db.pragma("table_info(tasks)") as { name: string }[]).map(row => row.name)).toEqual(["project_id", "task_id", "claim_id", "status", "agent", "session_id", "agent_control_mode"]);
  expect(events).toMatchObject([{ kind: "started", fromVersion: 0, toVersion: 12 }, { kind: "completed", fromVersion: 0, toVersion: 12 }]);
  close(rebuilt);
  events.length = 0;
  const reopened = openWorkerStore(file, { onMigration: event => { events.push(event); } }); stores.add(reopened);
  expect(events).toEqual([]);
});

it("restores the entire unversioned index when rebuilding the baseline fails", () => {
  const { file, db, rows } = legacyFixture();
  const schema = db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all();
  const projects = db.prepare("SELECT * FROM projects").all();
  const exec = Database.prototype.exec;
  vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
    const tasksStart = sql.indexOf("CREATE TABLE tasks (");
    if (sql.includes("agent_control_mode") && tasksStart !== -1) { exec.call(this, sql.slice(0, tasksStart)); throw new Error("baseline failed"); }
    return exec.call(this, sql);
  });
  expect(() => openWorkerStore(file, { onMigration: () => {} })).toThrow("migration-failed");
  expect(db.pragma("user_version", { simple: true })).toBe(0);
  expect(db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
  expect(db.prepare("SELECT * FROM projects").all()).toEqual(projects);
  expect(db.prepare("SELECT * FROM tasks ORDER BY task_id").all()).toEqual(rows.map(([project_id, task_id, claim_id, status, agent, session_id]) => ({ project_id, task_id, claim_id, status, agent, session_id })));
});

it("rejects newer formats and altered constraints without mutating their records", () => {
  const { file, store, register } = fixture(); register(); close(store);
  const db = connect(file), before = db.prepare("SELECT * FROM tasks").all();
  db.pragma("user_version = 13");
  expect(() => open(file)).toThrow("unsupported-version");
  expect(db.prepare("SELECT * FROM tasks").all()).toEqual(before);
  expect(db.pragma("user_version", { simple: true })).toBe(13);
  db.pragma("user_version = 12");
  db.exec("DROP INDEX tasks_one_active_per_task; CREATE UNIQUE INDEX tasks_one_active_per_task ON tasks(project_id, task_id) WHERE status = 'pending'");
  expect(() => open(file)).toThrow("invalid-format");
  expect(db.prepare("SELECT * FROM tasks").all()).toEqual(before);
});

describe("worker cleanup schedules", () => {
  const owner = { ...claim, worktreeId: uuid(70) };
  const schedule = { deadline: 600_000, failures: 2, nextAttemptAt: 12_000, stage: "worktree", lastError: "EACCES: denied" };

  it("retains independent resource retry policy across reopen without changing task rows", () => {
    const f = fixture(); f.register();
    const original = f.store.getTask(claim);
    expect(f.store.saveCleanupSchedule(owner, schedule)).toEqual({ ...owner, ...schedule });
    const second = { ...owner, claimId: uuid(71), worktreeId: uuid(72) };
    f.store.saveCleanupSchedule(second, { ...schedule, failures: 0, nextAttemptAt: 0 });
    close(f.store);
    const recovered = open(f.file);
    expect(recovered.getCleanupSchedule(owner)).toEqual({ ...owner, ...schedule });
    expect(recovered.listCleanupSchedules()).toHaveLength(2);
    expect(recovered.getTask(claim)).toEqual(original);
    recovered.deleteCleanupSchedule(owner);
    expect(recovered.getCleanupSchedule(owner)).toBeNull();
    expect(recovered.getCleanupSchedule(second)).toMatchObject({ failures: 0, nextAttemptAt: 0 });
  });

  it("rejects changed resource ownership and deadline atomically", () => {
    const f = fixture(); f.register(); f.store.saveCleanupSchedule(owner, schedule);
    const concurrent = open(f.file);
    expect(() => concurrent.saveCleanupSchedule({ ...owner, worktreeId: uuid(73) }, schedule)).toThrow("worktree");
    expect(() => concurrent.saveCleanupSchedule(owner, { ...schedule, deadline: schedule.deadline + 1 })).toThrow("deadline");
    f.store.saveCleanupSchedule(owner, { ...schedule, failures: 3 });
    expect(f.store.getCleanupSchedule(owner)).toEqual({ ...owner, ...schedule, failures: 3 });
  });
});
