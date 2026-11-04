import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBotStore } from "../../../src/commands/worker/bots/store.js";
import type { Bot, BotOwner } from "../../../src/commands/worker/bots/types.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";

const root = fileURLToPath(new URL("../../../../../.tmp/bot-store-tests/", import.meta.url));
const dirs: string[] = [];
const handles: { close(): void }[] = [];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner: BotOwner = { serverOrigin: "https://daynight.example", ownerUserId: id(1), workerId: id(2) };
const bot = (): Bot => ({ id: id(3), workerId: owner.workerId, version: "1", deletion: null, ownerUserId: owner.ownerUserId, name: "Assistant", creationOrder: "1", requestedOverrides: {}, resolvedConfiguration: { workerId: owner.workerId, cwd: root, provider: "codex", model: null, args: [] }, roleConfiguration: null, sessionId: null, testExecutionId: null, startupResult: { state: "pending", code: null }, createdAt: "2026-11-04T00:00:00Z", updatedAt: "2026-11-04T00:00:00Z" });
const fixture = () => {
  mkdirSync(root, { recursive: true }); const home = mkdtempSync(path.join(root, "case-")); dirs.push(home);
  const file = path.join(home, "state.sqlite");
  const open = () => { const store = openBotStore(file, { onMigration: () => {} }); handles.push(store); return store; };
  return { home, file, open, store: open() };
};
afterEach(() => { vi.restoreAllMocks(); for (const handle of handles.splice(0)) handle.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("durable Bot inventory", () => {
  it("retains one launch and registration intent across reopen and observation version changes", () => {
    const f = fixture(); f.store.observe(owner, bot(), 1);
    const intent = f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3 });
    expect(intent.registration).toMatchObject({ initialInput: "none", protocol: "daynight.session.v1", provider: "codex" });
    expect(intent.botVersion).toBe("1");
    expect(intent.sessionId).toBeNull();
    expect(intent.executionId).toBe(intent.registration.testExecutionId);
    expect(intent.journalPath).toContain(intent.executionId);
    const reopened = f.open(); reopened.observe(owner, { ...bot(), version: "2" }, 2);
    expect(reopened.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 99 })).toEqual(intent);
    expect(reopened.get(owner, id(3))?.observed.version).toBe("2");
  });

  it("keeps Bot records out of task inventory and cleanup budget", () => {
    const f = fixture(); const worker = openWorkerStore(f.file, { onMigration: () => {} }); handles.push(worker);
    worker.registerProject({ projectId: id(4), repoUrl: "https://example.test/repo", localPath: f.home });
    const claim = { projectId: id(4), taskId: id(5), claimId: id(6), agent: "codex" as const };
    worker.registerPending(claim); worker.saveCleanupSchedule({ ...claim, worktreeId: id(7) }, { deadline: 100, failures: 2, nextAttemptAt: 50, stage: "archive", lastError: "retained" });
    const before = { tasks: worker.listUnfinishedTasks(), cleanup: worker.listCleanupSchedules() };
    f.store.observe(owner, bot(), 1); f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3 });
    expect({ tasks: worker.listUnfinishedTasks(), cleanup: worker.listCleanupSchedules() }).toEqual(before);
    expect(f.store.list(owner)).toHaveLength(1);
  });

  it("preserves frozen definition and launch responsibility under deletion projection", () => {
    const f = fixture(); f.store.observe(owner, bot(), 1);
    const intent = f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3 });
    const deletion: Bot = { id: id(3), workerId: owner.workerId, version: "2", deletion: { deletionId: id(8), requestedVersion: "1", workerCleanup: { state: "pending", code: null }, serverCleanup: { state: "pending", code: null } } };
    f.store.observe(owner, deletion, 2);
    expect(f.store.get(owner, id(3))).toMatchObject({ definition: bot(), intent, observed: deletion });
    expect(() => f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3 })).toThrow(/delet/);
    expect(() => f.store.observe(owner, { ...bot(), version: "3" }, 3)).toThrow(/delet/);
  });

  it("rejects owner, configuration, stale-version and stable-session conflicts", () => {
    const f = fixture(); const original = bot(); f.store.observe(owner, original, 1);
    expect(() => f.store.observe(owner, { ...original, ownerUserId: id(9) } as Bot, 2)).toThrow(/owner/i);
    if (original.deletion !== null) throw new Error("fixture");
    expect(() => f.store.observe(owner, { ...original, version: "2", resolvedConfiguration: { ...original.resolvedConfiguration, cwd: "/different" } }, 2)).toThrow(/configuration/);
    f.store.observe(owner, { ...original, version: "2", sessionId: id(10), testExecutionId: id(11) }, 2);
    expect(() => f.store.observe(owner, original, 3)).toThrow(/version/);
    expect(() => f.store.observe(owner, { ...original, version: "3", sessionId: id(12), testExecutionId: id(11) }, 3)).toThrow(/session/i);
    expect(() => f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3 })).toThrow(/existing|bound/i);
    expect(f.store.list({ ...owner, ownerUserId: id(9) })).toEqual([]);
  });

  it("freezes local role before registration and rejects remote role disagreement", () => {
    const f = fixture(); const original = bot(); f.store.observe(owner, original, 1);
    f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3 });
    const role = { instructions: "Use Daynight CLI.", revision: "1", digest: createHash("sha256").update("Use Daynight CLI.").digest("hex") };
    f.store.freezeRole(owner, id(3), role);
    expect(f.open().get(owner, id(3))?.intent?.roleConfiguration).toEqual(role);
    f.store.freezeRole(owner, id(3), role);
    expect(() => f.store.freezeRole(owner, id(3), { ...role, revision: "2" })).toThrow(/role/i);
    expect(() => f.store.observe(owner, { ...original, version: "2", roleConfiguration: { ...role, revision: "2" } } as Bot, 2)).toThrow(/role/i);
  });

  it("binds the service-issued session to the original registration without replacing its request version", () => {
    const f = fixture(); const original = bot(); f.store.observe(owner, original, 1);
    const intent = f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3 });
    f.store.observe(owner, { ...original, version: "2", sessionId: id(10), testExecutionId: intent.registration.testExecutionId } as Bot, 2);
    expect(f.open().get(owner, id(3))?.intent).toEqual({ ...intent, sessionId: id(10) });
    const before = f.store.get(owner, id(3));
    expect(() => f.store.observe(owner, { ...original, version: "3", sessionId: id(10), testExecutionId: id(11) } as Bot, 3)).toThrow(/session|execution/i);
    expect(f.store.get(owner, id(3))).toEqual(before);
  });

  it("retains deletion-only responsibility without inventing a launch or original definition", () => {
    const f = fixture();
    const deletion: Bot = { id: id(3), workerId: owner.workerId, version: "2", deletion: { deletionId: id(8), requestedVersion: "1", workerCleanup: { state: "pending", code: null }, serverCleanup: { state: "completed", code: null } } };
    expect(f.store.observe(owner, deletion, 1)).toMatchObject({ definition: null, intent: null, observed: deletion });
    expect(f.open().list(owner)).toHaveLength(1);
    expect(() => f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3 })).toThrow(/delet/);
  });

  it("refuses malformed observations and a changed open database format without altering inventory", () => {
    const f = fixture(); f.store.observe(owner, bot(), 1); const before = f.store.get(owner, id(3));
    for (const changed of [{ version: "9007199254740993.0" }, { workerId: id(9) }, { sessionId: id(10), testExecutionId: null }]) {
      expect(() => f.store.observe(owner, { ...bot(), ...changed } as Bot, 2)).toThrow();
      expect(f.store.get(owner, id(3))).toEqual(before);
    }
    const db = new Database(f.file); handles.push(db); db.pragma("user_version = 9");
    expect(() => f.store.observe(owner, { ...bot(), version: "2" }, 2)).toThrow(/unsupported-version/);
    expect(() => f.store.list(owner)).toThrow(/unsupported-version/);
    db.pragma("user_version = 8"); expect(f.store.get(owner, id(3))).toEqual(before);
  });

  it("rolls back the Bot migration atomically without changing old task records", () => {
    mkdirSync(root, { recursive: true }); const home = mkdtempSync(path.join(root, "migration-")); dirs.push(home);
    const file = path.join(home, "state.sqlite"); const db = new Database(file); handles.push(db);
    for (const name of ["005-baseline.sql", "006-cleanup-schedules.sql", "007-resource-cleanup-intent.sql"]) db.exec(readFileSync(new URL(`../../../src/commands/worker/sqlite/${name}`, import.meta.url), "utf8"));
    db.pragma("user_version = 7"); db.prepare("INSERT INTO projects VALUES (?, ?, ?)").run(id(4), "https://example.test/repo", home);
    db.prepare("INSERT INTO tasks VALUES (?, ?, ?, 'active', 'codex', ?, 'web')").run(id(4), id(5), id(6), id(7));
    db.prepare("INSERT INTO cleanup_schedules VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id(4), id(5), id(6), id(8), 500, 2, 300, "archive", "retained");
    const schema = db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
    const rows = ["projects", "tasks", "cleanup_schedules"].map(table => db.prepare(`SELECT * FROM ${table}`).all());
    const exec = Database.prototype.exec;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function(this: Database.Database, sql: string) { const result = exec.call(this, sql); if (sql.includes("CREATE TABLE bots")) throw new Error("injected migration failure"); return result; });
    expect(() => openBotStore(file, { onMigration: () => {} })).toThrow(/migration/);
    expect(db.pragma("user_version", { simple: true })).toBe(7);
    expect(db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
    expect(["projects", "tasks", "cleanup_schedules"].map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(rows);
  });
});
