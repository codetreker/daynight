import path from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { createWebStoreFixtures } from "./web-store.fixtures.js";

const { id, directory, open, connect, externalContentFixture, fixture, blockedInitialFixture } = createWebStoreFixtures("memory");

it.each(["missing", "claim", "execution", "session", "generation", "controller", "test", "native", "process", "native-prefix", "empty-processes"] as const)("rejects %s evidence without rebinding a blocked first native identity", conflict => {
  const f = blockedInitialFixture();
  let observed = structuredClone(f.observed);
  if (conflict === "claim") observed = { ...observed, claimId: id(20) };
  if (conflict === "execution") observed.executionId = id(20);
  if (conflict === "session") observed.sessionId = id(20);
  if (conflict === "generation") observed.executionGeneration = "2";
  if (conflict === "controller") observed.controllerInstanceId = id(20);
  if (conflict === "test") observed = { ...observed, testExecutionId: id(20) } as unknown as typeof observed;
  if (conflict === "native") observed.nativeSessionId = id(20);
  if (conflict === "process") observed.controllerProcess = { ...observed.controllerProcess!, pid: 999 };
  if (conflict === "native-prefix") observed.nativeProcesses = observed.nativeProcesses.map((proof, index) => index === 0 ? { ...proof, commandHash: "c".repeat(64) } : proof);
  if (conflict === "empty-processes") observed.nativeProcesses = [];
  expect(() => f.store.bindNativeSession(f.task, { source: "controller", sessionId: id(7) }, 5, conflict === "missing" ? undefined : observed)).toThrow(/original generation/);
  expect(f.store.getTask(f.task)).toEqual(f.task);
  expect(f.store.getOrchestrationBlocker(f.task)).toEqual(f.blocker);
});

it("retains conflicting or previously drifted blocker identities and rolls back failed binding writes", () => {
  const f = blockedInitialFixture();
  expect(() => f.store.bindNativeSession(f.task, { source: "controller", sessionId: id(7) }, -1, f.observed)).toThrow();
  expect(f.store.getTask(f.task)).toEqual(f.task);
  expect(f.store.getOrchestrationBlocker(f.task)).toEqual(f.blocker);
  f.store.bindNativeSession(f.task, { source: "controller", sessionId: id(7) }, 5, f.observed);
  const bound = f.store.getTask(f.task)!;
  expect(() => f.store.bindNativeSession(f.task, { source: "controller", sessionId: id(9) }, 6, { ...f.observed, nativeSessionId: id(9) })).toThrow("cannot be replaced");
  const db = connect(f.file);
  db.prepare("UPDATE orchestration_blockers SET data=?").run(JSON.stringify(f.blocker));
  expect(() => f.store.bindNativeSession(f.task, { source: "controller", sessionId: id(7) }, 7, f.observed)).toThrow("another execution identity");
  expect(f.store.getTask(f.task)).toEqual(bound);
  expect(f.store.getOrchestrationBlocker(f.task)).toEqual(f.blocker);
});

it("rejects obsolete cleanup receipts in current-version records", () => {
  const { file, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  const task = store.beginCleanup(claim, { kind: "terminal", deadline: 100 }, 2);
  const db = connect(file);
  const data = JSON.stringify({ ...task, cleanup: { ...task.cleanup, agentStopped: true, backendResourcesClosed: true, worktreeDeleted: true } });
  db.prepare("UPDATE executions SET data=?").run(data);
  expect(() => store.getTask(claim)).toThrow("Cleanup intent has invalid fields");
  expect(db.prepare("SELECT data FROM executions").get()).toEqual({ data });
});

it.each(["not json", '{"stored":"private value"}'])("discards malformed unversioned records without parsing them: %s", data => {
  const root = directory(), file = path.join(root, "state.sqlite"), db = connect(file);
  db.exec("CREATE TABLE executions (identity TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;");
  db.pragma("ignore_check_constraints = ON");
  db.prepare("INSERT INTO executions VALUES(?,?)").run("another-claim", data);
  const rebuilt = open(file);
  expect(db.pragma("user_version", { simple: true })).toBe(4);
  expect(db.prepare("SELECT * FROM executions").all()).toEqual([]);
  expect(rebuilt.listUnfinishedTasks()).toEqual([]);
});

it("rebuilds an unknown unversioned schema with duplicate execution identities", () => {
  const root = directory(), file = path.join(root, "state.sqlite"), db = connect(file);
  db.exec("CREATE TABLE executions(identity TEXT, data TEXT); CREATE TABLE unrelated(value TEXT); INSERT INTO executions VALUES('duplicate', 'invalid'), ('duplicate', 'invalid'); INSERT INTO unrelated VALUES('discarded')");
  const rebuilt = open(file);
  expect(db.pragma("user_version", { simple: true })).toBe(4);
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()).toEqual([{ name: "executions" }, { name: "orchestration_blockers" }]);
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
  expect(db.pragma("user_version", { simple: true })).toBe(4);
  expect(db.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all()).toEqual([{ type: "table", name: "executions" }, { type: "table", name: "orchestration_blockers" }]);
  expect(db.prepare("SELECT * FROM executions").all()).toEqual([]);
  expect(rebuilt.listUnfinishedTasks()).toEqual([]);
});

it("validates current-version execution records during ordinary reads", () => {
  const { file, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  const db = connect(file), data = '{"stored":"private value"}';
  db.prepare("UPDATE executions SET data=?").run(data);
  expect(() => store.getTask(claim)).toThrow("Web execution record");
  expect(db.pragma("user_version", { simple: true })).toBe(4);
  expect(db.prepare("SELECT data FROM executions").get()).toEqual({ data });
});

it("fences an open Web connection before mutating a changed format", () => {
  const { file, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  const db = connect(file), data = (db.prepare("SELECT data FROM executions").get() as { data: string }).data;
  db.pragma("user_version=5");
  expect(() => store.initializeWebExecution(claim, 3)).toThrow("unsupported-version");
  expect(() => store.getTask(claim)).toThrow("unsupported-version");
  expect(() => store.listCompletedTasks()).toThrow("unsupported-version");
  expect(db.prepare("SELECT data FROM executions").get()).toEqual({ data });
});
