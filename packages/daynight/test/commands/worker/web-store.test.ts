import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { openWebExecutionStore, type WebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const roots: string[] = [], stores = new Set<WebExecutionStore>(), databases = new Set<Database.Database>();
const directory = (): string => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/web-store-tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "s-")); roots.push(root); return root;
};
const open = (file: string): WebExecutionStore => {
  const store = openWebExecutionStore(file, { onMigration: () => {} }); stores.add(store); return store;
};
const close = (store: WebExecutionStore): void => { store.close(); stores.delete(store); };
const connect = (file: string): Database.Database => { const db = new Database(file); databases.add(db); return db; };
const externalContentFixture = () => {
  const root = directory(), file = path.join(root, "state.sqlite"), db = connect(file);
  db.exec(`
    CREATE TABLE search_content(id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    INSERT INTO search_content VALUES(1, 'original searchable content'), (2, 'retained external row');
    CREATE VIRTUAL TABLE search USING fts5(body, content='search_content', content_rowid='id');
    INSERT INTO search(search) VALUES('rebuild');
  `);
  return { file, db };
};
const fixture = () => {
  const root = directory(), file = path.join(root, "state.sqlite"), store = open(file);
  const project = { serverOrigin: "https://daynight.example", projectId: id(1), repoUrl: "https://example.test/p.git", localPath: root };
  const claim = { ...project, taskId: id(2), claimId: id(3), workerId: id(4), worktreeId: id(5) };
  return { root, file, store, project, claim };
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores) store.close(); stores.clear();
  for (const db of databases) if (db.open) db.close(); databases.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("persists a distinct web execution without inventing Herdr resources or workspace closure", () => {
  const { file, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  const started = store.initializeWebExecution(claim, 3);
  expect(started.nativeExecution).toBeNull(); expect(started.resources.herdr).toBeNull();
  const operationId = started.webExecution!.initialOperationId;
  close(store); const reopened = open(file);
  expect(reopened.initializeWebExecution(claim, 4).webExecution!.initialOperationId).toBe(operationId);
  const cleaning = reopened.beginCleanup(claim, { kind: "shutdown", deadline: 100 }, 5);
  expect(cleaning.cleanup).toMatchObject({ mode: "web", workspaceClosed: null, backendResourcesClosed: false });
  reopened.confirmAgentStopped(claim, { agentStopped: true }, 6);
  reopened.confirmBackendResourcesClosed(claim, { controllerStopped: true, endpointClosed: true }, 7);
  expect(reopened.getTask(claim)?.cleanup).toMatchObject({ workspaceClosed: null, backendResourcesClosed: true });
  expect(connect(file).pragma("user_version", { simple: true })).toBe(1);
});

it("retains shutdown provenance across worker reopen without resetting recovery state", () => {
  const { file, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 0 }, userId: id(6) }, 1);
  store.initializeWebExecution(claim, 3);
  store.updateWebExecution(claim, { launchSubmission: "acknowledged" }, 4);
  store.bindNativeSession(claim, { source: "controller", sessionId: id(7) }, 5);
  store.beginCleanup(claim, { kind: "shutdown", deadline: 100 }, 6);
  store.recordCleanupResult(claim, "completed", null, 7);
  store.confirmAgentStopped(claim, { agentStopped: true }, 8);
  store.confirmBackendResourcesClosed(claim, { controllerStopped: true, endpointClosed: true }, 9);
  store.clearShutdown(claim, 10); close(store); const reopened = open(file);
  const task = reopened.getTask(claim)!;
  expect(task.webExecution).toHaveProperty("restartAfterShutdown", true);
  const next = reopened.beginWebGeneration(claim, { executionGeneration: task.webExecution!.executionGeneration, controllerInstanceId: task.webExecution!.controllerInstanceId, nativeSessionId: id(7), nativeStopped: true }, 11);
  expect(next.webExecution).toHaveProperty("restartAfterShutdown", false);
  expect(next.recovery).toEqual(task.recovery);
});

it("keeps completed versioned executions available for archive backfill after reopening", () => {
  const { file, store, project, claim } = fixture();
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
  store.register({ ...claim, project, configuration, userId: id(6) }, 1);
  const started = store.initializeWebExecution(claim, 2);
  store.updateWebExecution(claim, { launchSubmission: "acknowledged", sessionId: id(7) }, 3);
  store.beginCleanup(claim, { kind: "terminal", deadline: 100 }, 4);
  store.recordCleanupResult(claim, "completed", null, 5);
  store.confirmAgentStopped(claim, { agentStopped: true }, 6);
  store.confirmBackendResourcesClosed(claim, { controllerStopped: true, endpointClosed: true }, 7);
  store.confirmWorktreeDeleted(claim, { worktreeDeleted: true }, 8);
  const completed = store.completeTask(claim, 9);
  const active = { ...claim, claimId: id(8), taskId: id(9), worktreeId: id(10) };
  store.register({ ...active, project, configuration, userId: id(6) }, 10);
  close(store);
  const reopened = open(file);
  expect(reopened.listCompletedTasks()).toEqual([completed]);
  expect(reopened.listCompletedTasks()[0]?.webExecution).toMatchObject({ executionId: started.webExecution!.executionId, launchSubmission: "acknowledged", sessionId: id(7) });
  expect(reopened.listUnfinishedTasks().map(task => task.claimId)).toEqual([active.claimId]);
});

it("rebuilds the current unversioned schema and discards its execution records", () => {
  const { file, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  store.initializeWebExecution(claim, 2);
  close(store);
  const db = connect(file); db.pragma("user_version = 0");
  const events: unknown[] = [];
  const rebuilt = openWebExecutionStore(file, { onMigration: event => { events.push(event); } }); stores.add(rebuilt);
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  expect(db.prepare("SELECT * FROM executions").all()).toEqual([]);
  expect(rebuilt.getTask(claim)).toBeNull();
  expect(events).toMatchObject([{ kind: "started", fromVersion: 0, toVersion: 1 }, { kind: "completed", fromVersion: 0, toVersion: 1 }]);
  close(rebuilt); events.length = 0;
  const reopened = openWebExecutionStore(file, { onMigration: event => { events.push(event); } }); stores.add(reopened);
  expect(events).toEqual([]);
});

it.each(["not json", '{"stored":"private value"}'])("discards malformed unversioned records without parsing them: %s", data => {
  const root = directory(), file = path.join(root, "state.sqlite"), db = connect(file);
  db.exec("CREATE TABLE executions (identity TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;");
  db.pragma("ignore_check_constraints = ON");
  db.prepare("INSERT INTO executions VALUES(?,?)").run("another-claim", data);
  const rebuilt = open(file);
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  expect(db.prepare("SELECT * FROM executions").all()).toEqual([]);
  expect(rebuilt.listUnfinishedTasks()).toEqual([]);
});

it("rebuilds an unknown unversioned schema with duplicate execution identities", () => {
  const root = directory(), file = path.join(root, "state.sqlite"), db = connect(file);
  db.exec("CREATE TABLE executions(identity TEXT, data TEXT); CREATE TABLE unrelated(value TEXT); INSERT INTO executions VALUES('duplicate', 'invalid'), ('duplicate', 'invalid'); INSERT INTO unrelated VALUES('discarded')");
  const rebuilt = open(file);
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()).toEqual([{ name: "executions" }]);
  expect(rebuilt.listUnfinishedTasks()).toEqual([]);
  expect(() => db.exec("INSERT INTO executions VALUES('invalid', 'not json')")).toThrow("CHECK constraint failed");
});

it("discards FTS5 external content classified as a shadow table when rebuilding an unversioned Web store", () => {
  const { file, db } = externalContentFixture();
  expect(db.pragma("main.table_list")).toContainEqual(expect.objectContaining({ name: "search_content", type: "shadow" }));
  expect(db.prepare("SELECT rowid, body FROM search WHERE search MATCH 'searchable'").all()).toEqual([{ rowid: 1, body: "original searchable content" }]);
  const exec = Database.prototype.exec;
  let baselineReached = false;
  vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
    if (sql.includes("CREATE TABLE executions (")) {
      expect(this.pragma("writable_schema", { simple: true })).toBe(0);
      baselineReached = true;
    }
    return exec.call(this, sql);
  });
  const rebuilt = open(file);
  expect(baselineReached).toBe(true);
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  expect(db.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all()).toEqual([{ type: "table", name: "executions" }]);
  expect(db.prepare("SELECT * FROM executions").all()).toEqual([]);
  expect(rebuilt.listUnfinishedTasks()).toEqual([]);
});

it("restores FTS5 external content and its index when the Web baseline fails after cleanup", () => {
  const { file, db } = externalContentFixture();
  const schema = db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all();
  const rows = db.prepare("SELECT * FROM search_content ORDER BY id").all();
  const matches = db.prepare("SELECT rowid, body FROM search WHERE search MATCH 'searchable OR retained' ORDER BY rowid").all();
  expect(matches).toEqual([{ rowid: 1, body: "original searchable content" }, { rowid: 2, body: "retained external row" }]);
  const failure = new Error("Web baseline failed"), exec = Database.prototype.exec;
  let cleaned = false;
  vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
    if (sql.includes("CREATE TABLE executions (")) {
      expect(this.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all()).toEqual([]);
      expect(this.pragma("writable_schema", { simple: true })).toBe(0);
      cleaned = true;
      exec.call(this, sql);
      throw failure;
    }
    return exec.call(this, sql);
  });
  expect(() => open(file)).toThrow("migration-failed");
  expect(cleaned).toBe(true);
  expect(db.pragma("user_version", { simple: true })).toBe(0);
  expect(db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
  expect(db.prepare("SELECT * FROM search_content ORDER BY id").all()).toEqual(rows);
  expect(db.prepare("SELECT rowid, body FROM search WHERE search MATCH 'searchable OR retained' ORDER BY rowid").all()).toEqual(matches);
});

it("rejects newer and unknown nonzero table formats without deleting state", () => {
  const { file, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  close(store);
  const db = connect(file), before = db.prepare("SELECT * FROM executions").all();
  db.pragma("user_version=2");
  expect(() => open(file)).toThrow("unsupported-version");
  expect(db.pragma("user_version", { simple: true })).toBe(2);
  expect(db.prepare("SELECT * FROM executions").all()).toEqual(before);
  db.pragma("user_version=1"); db.exec("CREATE TABLE unexpected(value TEXT); INSERT INTO unexpected VALUES('retained')");
  expect(() => open(file)).toThrow("invalid-format");
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  expect(db.prepare("SELECT * FROM executions").all()).toEqual(before);
  expect(db.prepare("SELECT value FROM unexpected").get()).toEqual({ value: "retained" });
});

it("validates current-version execution records during ordinary reads", () => {
  const { file, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  const db = connect(file), data = '{"stored":"private value"}';
  db.prepare("UPDATE executions SET data=?").run(data);
  expect(() => store.getTask(claim)).toThrow("Web execution record");
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  expect(db.prepare("SELECT data FROM executions").get()).toEqual({ data });
});

it("fences an open Web connection before mutating a changed format", () => {
  const { file, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  const db = connect(file), data = (db.prepare("SELECT data FROM executions").get() as { data: string }).data;
  db.pragma("user_version=2");
  expect(() => store.initializeWebExecution(claim, 3)).toThrow("unsupported-version");
  expect(() => store.getTask(claim)).toThrow("unsupported-version");
  expect(() => store.listCompletedTasks()).toThrow("unsupported-version");
  expect(db.prepare("SELECT data FROM executions").get()).toEqual({ data });
});
