import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  it("creates exactly the project mapping and versioned seven-column task index with WAL/FULL", () => {
    const pragma = vi.spyOn(Database.prototype, "pragma");
    const { file, store } = fixture();
    const database = connect(file);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: "projects" }, { name: "tasks" }]);
    expect((database.pragma("table_info(projects)") as { name: string }[]).map(({ name }) => name)).toEqual(["project_id", "repo_url", "local_path"]);
    expect((database.pragma("table_info(tasks)") as { name: string }[]).map(({ name }) => name)).toEqual(["project_id", "task_id", "claim_id", "status", "agent", "session_id", "agent_control_mode"]);
    expect((database.pragma("table_list") as { name: string; strict: number }[]).filter(({ name }) => name === "projects" || name === "tasks").every(({ strict }) => strict === 1)).toBe(true);
    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.pragma("user_version", { simple: true })).toBe(5);
    expect(pragma).toHaveBeenCalledWith("synchronous = FULL");
    expect(database.pragma("foreign_key_list(projects)")).toEqual([]);
    expect(database.pragma("foreign_key_list(tasks)")).toEqual([]);
    expect(store.listProjects()).toEqual([]);
    expect(store.listTasks()).toEqual([]);
  });

  it("enforces state, agent, nullability and composite identity in actual SQLite", () => {
    const { file, register } = fixture();
    register();
    const database = connect(file);
    expect(database.prepare("SELECT status, agent, session_id FROM tasks").get()).toEqual({ status: "pending", agent: "codex", session_id: null });
    expect(() => database.exec("UPDATE tasks SET status = 'cleaning'")).toThrow("CHECK constraint failed");
    expect(() => database.exec("UPDATE tasks SET agent = 'other'")).toThrow("CHECK constraint failed");
    expect(() => database.exec("UPDATE tasks SET claim_id = NULL")).toThrow("NOT NULL constraint failed");
    expect(() => database.exec("INSERT INTO tasks SELECT * FROM tasks")).toThrow("UNIQUE constraint failed");
    expect(() => database.exec("UPDATE tasks SET session_id = 42")).not.toThrow();
    expect(() => database.exec("UPDATE tasks SET session_id = NULL")).not.toThrow();
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

  it("exposes invalid paths and connection options before opening a database", () => {
    const { file } = fixture();
    expect(() => openWorkerStore("relative.sqlite")).toThrow("must be absolute");
    for (const busyTimeoutMs of [0, -1, 1.5, 60_001, Number.NaN]) expect(() => openWorkerStore(file, { busyTimeoutMs })).toThrow("safe integer");
  });
});

describe("worker project mappings", () => {
  it("requires an actual project mapping before materializing its claim", () => {
    const { store, register, project } = fixture();
    expect(() => store.registerPending({ ...claim, agent: "codex" })).toThrow("project repository binding");
    register();
    expect(store.getProject(claim)).toEqual(project);
    expect(store.listProjects()).toEqual([project]);
  });

  it("keeps unfinished repository bindings stable and permits changes after cleanup", () => {
    const { directory, store, register, project } = fixture();
    register();
    expect(store.registerProject(project)).toEqual(project);
    const replacement = { ...project, repoUrl: "https://github.com/other/repo.git", localPath: path.join(directory, "other") };
    expect(() => store.registerProject(replacement)).toThrow("unfinished execution");
    store.activateTask(claim);
    expect(() => store.registerProject(replacement)).toThrow("unfinished execution");
    store.completeTask(claim);
    expect(store.registerProject(replacement)).toEqual(replacement);
  });

  it("validates identities, repository text and physical path input", () => {
    const { store, project } = fixture();
    expect(() => store.registerProject({ ...project, projectId: "bad" })).toThrow("UUID");
    expect(() => store.registerProject({ ...project, repoUrl: " " })).toThrow("nonempty");
    expect(() => store.registerProject({ ...project, localPath: "relative" })).toThrow("absolute");
    expect(store.getProject(project)).toBeNull();
  });
});

describe("worker claim and native session index", () => {
  it("materializes a pending claim without a session and preserves repeated registration", () => {
    const { store, register } = fixture();
    expect(register()).toEqual({ ...claim, status: "pending", agent: "codex", agentControlMode: "herdr" as const, sessionId: null });
    store.activateTask(claim);
    store.setSessionId(claim, uuid(8));
    expect(store.registerPending({ ...claim, agent: "codex", agentControlMode: "herdr" as const, sessionId: uuid(9) })).toEqual({ ...claim, status: "active", agent: "codex", agentControlMode: "herdr" as const, sessionId: uuid(8) });
    expect(() => store.registerPending({ ...claim, agent: "copilot" })).toThrow("different agent");
  });

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

  it("isolates active slots by project and task", () => {
    const { store, project, register } = fixture();
    register();
    const anotherTask = { ...claim, taskId: uuid(10), agent: "codex" as const };
    const anotherProject = { ...claim, projectId: uuid(11), agent: "copilot" as const };
    store.registerProject({ ...project, projectId: anotherProject.projectId });
    store.registerPending(anotherTask);
    store.registerPending(anotherProject);
    for (const identity of [claim, anotherTask, anotherProject]) expect(store.activateTask(identity).status).toBe("active");
    expect(store.listUnfinishedTasks()).toHaveLength(3);
  });

  it("retains completed rows and never silently reactivates them", () => {
    const { store, register } = fixture();
    register();
    expect(store.completeTask(claim).status).toBe("done");
    expect(store.completeTask(claim).status).toBe("done");
    expect(store.registerPending({ ...claim, agent: "codex" }).status).toBe("done");
    expect(() => store.activateTask(claim)).toThrow("already done");
    expect(() => store.setSessionId(claim, uuid(8))).toThrow("already done");
    expect(store.listUnfinishedTasks()).toEqual([]);
    expect(store.listTasks()).toHaveLength(1);
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

  it("reports missing or malformed task identities", () => {
    const { store, register } = fixture();
    expect(store.getTask(claim)).toBeNull();
    expect(() => store.activateTask(claim)).toThrow("not registered");
    expect(() => store.completeTask(claim)).toThrow("not registered");
    expect(() => store.setSessionId(claim, uuid(8))).toThrow("not registered");
    register();
    expect(() => store.getTask({ ...claim, taskId: "bad" })).toThrow("UUID");
    expect(() => store.registerPending({ ...claim, claimId: "bad", agent: "codex" })).toThrow("UUID");
    expect(() => store.registerPending({ ...claim, agent: "codex", agentControlMode: "herdr" as const, sessionId: "bad" })).toThrow("UUID");
  });
});

it("migrates the previous minimal index to frozen Herdr mode without reinterpreting rich schemas", () => {
  const f = fixture(); close(f.store);
  const legacy = connect(f.file);
  legacy.exec("DROP TABLE tasks; CREATE TABLE tasks (project_id TEXT NOT NULL, task_id TEXT NOT NULL, claim_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'done')), agent TEXT NOT NULL CHECK(agent IN ('copilot', 'codex')), session_id TEXT, PRIMARY KEY(project_id,task_id,claim_id)) STRICT; CREATE UNIQUE INDEX tasks_one_active_per_task ON tasks(project_id,task_id) WHERE status='active'; PRAGMA user_version=0;");
  legacy.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run(claim.projectId, claim.taskId, claim.claimId, "active", "codex", uuid(30));
  legacy.close(); connections.delete(legacy);
  const migrated = open(f.file);
  expect(migrated.getTask(claim)).toMatchObject({ status: "active", agent: "codex", agentControlMode: "herdr", sessionId: uuid(30) });
  expect(() => migrated.registerPending({ ...claim, agent: "codex", agentControlMode: "web" })).toThrow();
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

it("adopts unversioned minimal records once and preserves every claim and nullable session", () => {
  const { file, db, rows } = legacyFixture();
  const events: unknown[] = [];
  const migrated = openWorkerStore(file, { onMigration: event => { events.push(event); } }); stores.add(migrated);
  expect(db.pragma("user_version", { simple: true })).toBe(5);
  expect(db.prepare("SELECT project_id,task_id,claim_id,status,agent,session_id FROM tasks ORDER BY task_id").all()).toEqual(rows.map(([project_id, task_id, claim_id, status, agent, session_id]) => ({ project_id, task_id, claim_id, status, agent, session_id })));
  expect(migrated.listTasks().map(task => task.agentControlMode)).toEqual(["herdr", "herdr", "herdr"]);
  close(migrated);
  events.length = 0;
  const reopened = openWorkerStore(file, { onMigration: event => { events.push(event); } }); stores.add(reopened);
  expect(events).toEqual([]);
});

it("rolls back a failing six-column table replacement together with its version", () => {
  const { file, db, rows } = legacyFixture();
  const exec = Database.prototype.exec;
  vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
    if (sql.startsWith("INSERT INTO tasks(project_id, task_id, claim_id, status, agent, session_id) SELECT")) throw new Error("copy failed");
    return exec.call(this, sql);
  });
  expect(() => openWorkerStore(file, { onMigration: () => {} })).toThrow("migration-failed");
  expect(db.pragma("user_version", { simple: true })).toBe(0);
  expect((db.pragma("table_info(tasks)") as { name: string }[]).map(row => row.name)).toEqual(["project_id", "task_id", "claim_id", "status", "agent", "session_id"]);
  expect(db.prepare("SELECT * FROM tasks ORDER BY task_id").all()).toHaveLength(rows.length);
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='legacy_tasks'").get()).toBeUndefined();
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='tasks_one_active_per_task'").get()).toBeDefined();
});

it("registers the current unversioned seven-column layout without rewriting its rows", () => {
  const { file, store, register } = fixture();
  register(); store.activateTask(claim); store.setSessionId(claim, uuid(30)); close(store);
  const db = connect(file), before = db.prepare("SELECT * FROM tasks").all(); db.pragma("user_version = 0");
  const adopted = open(file);
  expect(db.prepare("SELECT * FROM tasks").all()).toEqual(before);
  expect(db.pragma("user_version", { simple: true })).toBe(5);
  expect(adopted.getTask(claim)?.sessionId).toBe(uuid(30));
});

it("rejects newer formats and altered constraints without mutating their records", () => {
  const { file, store, register } = fixture(); register(); close(store);
  const db = connect(file), before = db.prepare("SELECT * FROM tasks").all();
  db.pragma("user_version = 6");
  expect(() => open(file)).toThrow("unsupported-version");
  expect(db.prepare("SELECT * FROM tasks").all()).toEqual(before);
  expect(db.pragma("user_version", { simple: true })).toBe(6);
  db.pragma("user_version = 5");
  db.exec("DROP INDEX tasks_one_active_per_task; CREATE UNIQUE INDEX tasks_one_active_per_task ON tasks(project_id, task_id) WHERE status = 'pending'");
  expect(() => open(file)).toThrow("invalid-format");
  expect(db.prepare("SELECT * FROM tasks").all()).toEqual(before);
});

it("fences an open worker connection before writing a subsequently changed format", () => {
  const { file, store, register } = fixture(); register(); const db = connect(file); db.pragma("user_version = 6");
  expect(() => store.activateTask(claim)).toThrow("unsupported-version");
  expect(() => store.getTask(claim)).toThrow("unsupported-version");
  expect(db.prepare("SELECT status FROM tasks").get()).toEqual({ status: "pending" });
});
