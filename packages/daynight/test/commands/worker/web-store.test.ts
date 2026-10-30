import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
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
const fixture = () => {
  const root = directory(), file = path.join(root, "state.sqlite"), store = open(file);
  const project = { serverOrigin: "https://daynight.example", projectId: id(1), repoUrl: "https://example.test/p.git", localPath: root };
  const claim = { ...project, taskId: id(2), claimId: id(3), workerId: id(4), worktreeId: id(5) };
  return { root, file, store, project, claim };
};
afterEach(() => {
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

const unversionedFixture = () => {
  const root = directory(), file = path.join(root, "state.sqlite"), db = connect(file);
  db.exec("CREATE TABLE executions (identity TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;");
  const claim = { projectId: id(1), taskId: id(2), claimId: id(3) };
  const task = {
    ...claim, worktreeId: id(5), serverOrigin: "https://daynight.example", workerId: id(4), userId: id(6), status: "active",
    repoUrl: "https://example.test/p.git", repositoryPath: root,
    configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 },
    resources: { mode: "web", worktree: null, herdr: null, nativeSession: { source: "controller", sessionId: id(7) } },
    nativeExecution: null,
    webExecution: {
      executionId: id(10), registrationId: id(11), controllerId: id(12), controllerInstanceId: id(13), launchId: id(14), sessionId: id(15),
      executionGeneration: "2", initialOperationId: id(16), initialPrompt: "original prompt", launchSubmission: "acknowledged",
      controllerProcess: null, nativeProcesses: [], cleanupOperationId: null, ticketPath: null,
    },
    recovery: { count: 1, pauseReason: null, retryAuthorized: false }, cleanup: null, control: null, createdAt: 1, updatedAt: 2,
  };
  const key = [claim.projectId, claim.taskId, claim.claimId].join("/"), data = JSON.stringify(task, null, 2);
  db.prepare("INSERT INTO executions VALUES(?,?)").run(key, data);
  return { file, db, claim, key, data, task };
};

it("adopts current unversioned JSON without rewriting missing optional fields or source bytes", () => {
  const { file, db, claim, key, data } = unversionedFixture();
  const events: unknown[] = [];
  const store = openWebExecutionStore(file, { onMigration: event => { events.push(event); } }); stores.add(store);
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  expect(db.prepare("SELECT data FROM executions WHERE identity=?").get(key)).toEqual({ data });
  expect(store.getTask(claim)?.webExecution).toMatchObject({ restartAfterShutdown: false, nativeHome: null, summary: null, initialInputState: "unknown", activity: "unknown", initialPrompt: "original prompt" });
  expect(store.getTask(claim)?.resources.nativeSession).toEqual({ source: "controller", sessionId: id(7) });
  expect(events).toHaveLength(2);
  close(store); events.length = 0;
  const reopened = openWebExecutionStore(file, { onMigration: event => { events.push(event); } }); stores.add(reopened);
  expect(events).toEqual([]);
  expect(db.prepare("SELECT data FROM executions WHERE identity=?").get(key)).toEqual({ data });
});

it("rejects malformed or mismatched unversioned records before writing version or journal mode", () => {
  const { file, db, key } = unversionedFixture();
  const invalid = '{"stored":"private value"}'; db.prepare("UPDATE executions SET data=? WHERE identity=?").run(invalid, key);
  expect(db.pragma("journal_mode", { simple: true })).toBe("delete");
  expect(() => open(file)).toThrow("invalid-format");
  expect(db.pragma("user_version", { simple: true })).toBe(0);
  expect(db.pragma("journal_mode", { simple: true })).toBe("delete");
  expect(db.prepare("SELECT data FROM executions").get()).toEqual({ data: invalid });
});

it("rejects a row whose SQL key differs from the original claim without rewriting it", () => {
  const { file, db, data } = unversionedFixture();
  db.prepare("UPDATE executions SET identity=?").run("another-claim");
  expect(() => open(file)).toThrow("invalid-format");
  expect(db.pragma("user_version", { simple: true })).toBe(0);
  expect(db.prepare("SELECT identity, data FROM executions").get()).toEqual({ identity: "another-claim", data });
});

it("rejects newer and unknown table formats without deleting state", () => {
  const { file, db, data } = unversionedFixture(); db.pragma("user_version=2");
  expect(() => open(file)).toThrow("unsupported-version");
  expect(db.pragma("user_version", { simple: true })).toBe(2);
  expect(db.prepare("SELECT data FROM executions").get()).toEqual({ data });
  db.pragma("user_version=0"); db.exec("CREATE TABLE unexpected(value TEXT)");
  expect(() => open(file)).toThrow("invalid-format");
  expect(db.prepare("SELECT data FROM executions").get()).toEqual({ data });
});

it("fences an open Web connection before mutating a changed format", () => {
  const { file, store, project, claim } = fixture();
  store.register({ ...claim, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, userId: id(6) }, 1);
  const db = connect(file), data = (db.prepare("SELECT data FROM executions").get() as { data: string }).data;
  db.pragma("user_version=2");
  expect(() => store.initializeWebExecution(claim, 3)).toThrow("unsupported-version");
  expect(() => store.getTask(claim)).toThrow("unsupported-version");
  expect(db.prepare("SELECT data FROM executions").get()).toEqual({ data });
});
