import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, vi } from "vitest";
import { openWebExecutionStore, type WebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import type { ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";

export const createWebStoreFixtures = (storage: "memory" | "file") => {
  const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

  const roots: string[] = [], stores = new Set<WebExecutionStore>(), databases = new Set<Database.Database>();

  const directory = (): string => {
    const base = path.resolve(import.meta.dirname, "../../../../../.tmp/web-store-tests");
    mkdirSync(base, { recursive: true });
    const root = mkdtempSync(path.join(base, "s-")); roots.push(root); return root;
  };

  const open = (file: string): WebExecutionStore => {
    const store = openWebExecutionStore(storage === "memory" ? connect(file) : file, { onMigration: () => {} }); stores.add(store); return store;
  };

  const close = (store: WebExecutionStore): void => { store.close(); stores.delete(store); };

  const memoryDatabases = new Map<string, Database.Database>();
  const connect = (file: string): Database.Database => {
    const existing = memoryDatabases.get(file);
    if (existing !== undefined) return existing;
    const db = storage === "memory" ? createMemoryDatabase() : new Database(file);
    if (storage === "memory") memoryDatabases.set(file, db);
    databases.add(db); return db;
  };

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
    memoryDatabases.clear();
    for (const store of stores) store.close(); stores.clear();
    for (const db of databases) if (db.open) db.close(); databases.clear();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const blockedInitialFixture = () => {
    const f = fixture();
    f.store.register({ ...f.claim, project: f.project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 3 }, userId: id(6) }, 1);
    f.store.initializeWebExecution(f.claim, 2);
    const controllerProcess = { pid: 123, parentPid: 1, processGroupId: 123, startedAt: "birth", commandHash: "a".repeat(64) };
    const nativeProcess = { pid: 124, parentPid: 123, processGroupId: 123, startedAt: "native", commandHash: "b".repeat(64) };
    const task = f.store.updateWebExecution(f.claim, { sessionId: id(8), controllerProcess, nativeProcesses: [nativeProcess], launchSubmission: "acknowledged", initialInputState: "unknown" }, 3);
    const execution = task.webExecution!;
    const observed: ControllerSnapshot = { executionId: execution.executionId, claimId: task.claimId, sessionId: execution.sessionId!, executionGeneration: "1", controllerInstanceId: execution.controllerInstanceId, lifecycle: "stopped", nativeSessionId: id(7), initialInputState: "confirmed", activity: "stopped", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, controllerProcess, nativeProcesses: [nativeProcess, { ...nativeProcess, pid: 125 }], nativeStopped: true, stoppedAt: new Date(0).toISOString(), error: null };
    const blocker = f.store.blockOrchestration(task, { source: "worktree", code: "branch_mismatch", message: "Original branch differs." }, 4);
    return { ...f, task, observed, blocker };
  };
  return { id, stores, directory, open, close, connect, externalContentFixture, fixture, blockedInitialFixture };
};
