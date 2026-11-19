import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openLocalBotStores } from "../../../src/commands/worker/bots/local-store.js";
import { openBotStore } from "../../../src/commands/worker/bots/store.js";
import { resolveBotPaths } from "../../../src/commands/worker/bots/paths.js";
import { resolveConfigurationPaths } from "../../../src/config/paths.js";
import { definition, id, owner, proof, snapshot, stopped } from "./bot-execution-store.fixtures.js";
import { frozenToolLaunch } from "../../helpers/tool-launch.js";

const root = fileURLToPath(new URL("../../../../../.tmp/bot-local-store-tests/", import.meta.url));
const directories: string[] = [], handles: { close(): void }[] = [];
afterEach(() => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const handle of handles.splice(0).reverse()) handle.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const fixture = (longRoot = false) => {
  mkdirSync(root, { recursive: true });
  const home = mkdtempSync(path.join(root, "case-")); directories.push(home);
  vi.stubEnv("DN_CONFIG_DIR", longRoot ? path.join(home, ...Array.from({ length: 6 }, () => "long-bot-configuration-directory"), "config") : path.join(home, "config"));
  const stateDirectory = resolveConfigurationPaths(home).stateDirectory;
  const legacyDatabaseFile = path.join(stateDirectory, "worker", "state.sqlite");
  const open = (identity = owner) => {
    const result = openLocalBotStores({ stateDirectory, legacyDatabaseFile, owner: identity, onMigration: () => {} });
    handles.push(result); return result;
  };
  const stores = open();
  return { home, stateDirectory, legacyDatabaseFile, open, ...stores };
};

describe("Bot dedicated storage", () => {
  it("keeps independent Bot databases discoverable after all public indexes are removed", () => {
    const f = fixture();
    f.store.observe(owner, definition(), 1);
    f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3, toolLaunch: frozenToolLaunch() });
    const initial = f.store.get(owner, id(3))!;
    f.executions.prepare(initial); f.executions.update(initial, { launchSubmission: "unknown" });
    f.store.observe(owner, { ...definition(), id: id(4), name: "Other assistant" }, 2);
    const paths = resolveBotPaths(f.stateDirectory, id(3));
    expect(initial.intent!.ticketPath.startsWith(paths.directory + path.sep)).toBe(true);
    expect(initial.intent!.journalPath.startsWith(paths.directory + path.sep)).toBe(true);
    expect(existsSync(f.legacyDatabaseFile)).toBe(false);
    mkdirSync(path.dirname(f.legacyDatabaseFile), { recursive: true });
    writeFileSync(f.legacyDatabaseFile, "discardable public index");
    mkdirSync(path.join(f.stateDirectory, "controller"), { recursive: true });
    writeFileSync(path.join(f.stateDirectory, "controller", "public-cache"), "discardable");
    f.close();
    rmSync(path.dirname(f.legacyDatabaseFile), { recursive: true });
    rmSync(path.join(f.stateDirectory, "controller"), { recursive: true });
    const reopened = f.open();
    expect(reopened.store.list(owner).map(record => record.botId)).toEqual([id(3), id(4)]);
    expect(reopened.store.get(owner, id(3))).toEqual(initial);
    expect(reopened.executions.get(initial)?.launchSubmission).toBe("unknown");
    const db = new Database(paths.databaseFile, { readonly: true });
    try { expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()).toEqual([{ name: "bot_executions" }, { name: "bot_identity" }, { name: "bots" }]); }
    finally { db.close(); }
  });

  it("creates and reopens dedicated storage beneath a long configuration root", () => {
    const f = fixture(true), paths = resolveBotPaths(f.stateDirectory, id(3));
    expect(paths.databaseFile.length).toBeGreaterThan(300);
    f.store.observe(owner, definition(), 1);
    f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 2 });
    const original = f.store.get(owner, id(3))!;
    f.executions.prepare(original); f.executions.update(original, { launchSubmission: "unknown" });
    f.close();
    mkdirSync(path.dirname(f.legacyDatabaseFile), { recursive: true });
    const legacy = openBotStore(f.legacyDatabaseFile, { onMigration: () => {} });
    try { legacy.observe(owner, { ...definition(), id: id(4) }, 1); } finally { legacy.close(); }
    const reopened = f.open();
    expect(reopened.store.get(owner, id(3))).toEqual(original);
    expect(reopened.executions.get(original)?.launchSubmission).toBe("unknown");
    expect(reopened.store.list(owner).map(record => record.botId)).toEqual([id(3), id(4)]);
  });

  it("refuses concurrent owners and never replaces an original lock", () => {
    const f = fixture(); f.store.observe(owner, definition(), 1);
    const paths = resolveBotPaths(f.stateDirectory, id(3)), lock = readFileSync(paths.lockFile, "utf8");
    const competitor = f.open();
    expect(() => competitor.store.get(owner, id(3))).toThrow(/instance lock/i);
    expect(readFileSync(paths.lockFile, "utf8")).toBe(lock);
    f.close();
    expect(competitor.store.get(owner, id(3))?.botId).toBe(id(3));
  });

  it("refuses a redirected Bot directory before writing into the target", () => {
    const f = fixture(), paths = resolveBotPaths(f.stateDirectory, id(3)), target = path.join(f.home, "unrelated");
    mkdirSync(target, { mode: 0o700 }); mkdirSync(path.dirname(paths.directory), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(target, "keep"), "unrelated bytes");
    symlinkSync(target, paths.directory, process.platform === "win32" ? "junction" : "dir");
    expect(() => f.store.observe(owner, definition(), 1)).toThrow(/physical directory/);
    expect(readFileSync(path.join(target, "keep"), "utf8")).toBe("unrelated bytes");
    expect(existsSync(path.join(target, "store.sqlite"))).toBe(false);
  });

  it("retains a changed lock on close and permits retry after its original identity is restored", () => {
    const f = fixture(); f.store.observe(owner, definition(), 1);
    const paths = resolveBotPaths(f.stateDirectory, id(3)), original = readFileSync(paths.lockFile, "utf8");
    writeFileSync(paths.lockFile, JSON.stringify({ owner: "replacement", pid: process.pid, startedAt: new Date().toISOString() }));
    try {
      expect(() => f.close()).toThrow(/shutdown failed/);
      expect(existsSync(paths.lockFile)).toBe(true);
      expect(() => f.store.get(owner, id(3))).toThrow(/closing/);
    } finally { writeFileSync(paths.lockFile, original); }
    f.close(); expect(existsSync(paths.lockFile)).toBe(false);
    expect(f.open().store.get(owner, id(3))?.botId).toBe(id(3));
  });

  it("rejects service, account and Worker changes while preserving original records", () => {
    const f = fixture(); f.store.observe(owner, definition(), 1); f.close();
    for (const changed of [{ ...owner, serverOrigin: "https://other.example" }, { ...owner, ownerUserId: id(90) }]) {
      const other = f.open(changed);
      expect(other.store.list(changed)).toEqual([]);
      expect(() => other.store.get(changed, id(3))).toThrow(/another service or account/);
    }
    const rebuilt = { ...owner, workerId: id(91) }, otherWorker = f.open(rebuilt);
    expect(() => otherWorker.store.list(rebuilt)).toThrow(/verified takeover/);
    const reopened = f.open(); expect(reopened.store.get(owner, id(3))?.observed).toEqual(definition());
  });

  it("commits recovery intent and execution evidence together in the Bot database", () => {
    const f = fixture(); f.store.observe(owner, definition(), 1);
    f.store.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 3, toolLaunch: frozenToolLaunch() });
    const intent = f.store.get(owner, id(3))!.intent!;
    const record = f.store.observe(owner, { ...definition(), version: "2", sessionId: id(10), testExecutionId: intent.executionId }, 2);
    f.executions.prepare(record);
    f.executions.update(record, { launchSubmission: "acknowledged", controllerProcess: proof, snapshot: snapshot(record) });
    const paths = resolveBotPaths(f.stateDirectory, id(3));
    const db = new Database(paths.databaseFile);
    try {
      // A real SQLite trigger aborts the second write inside the recovery transaction.
      db.exec("CREATE TRIGGER reject_recovery BEFORE UPDATE ON bot_executions BEGIN SELECT RAISE(ABORT, 'recovery interruption'); END");
      expect(() => f.executions.beginRecovery(record, stopped(record), f.home)).toThrow(/recovery interruption/);
      expect(f.store.get(owner, id(3))).toEqual(record);
      expect(f.executions.get(record)?.executionGeneration).toBe("1");
      db.exec("DROP TRIGGER reject_recovery");
    } finally { db.close(); }
    const next = f.executions.beginRecovery(record, stopped(record), f.home);
    expect(next.intent?.executionGeneration).toBe("2");
    expect(next.intent!.ticketPath.startsWith(paths.directory + path.sep)).toBe(true);
    f.close();
    const reopened = f.open();
    expect(reopened.store.get(owner, id(3))).toEqual(next);
    expect(reopened.executions.get(next)?.previous?.launchId).toBe(intent.launchId);
  });

  it("recovers an empty interrupted initialization without adopting unidentified records", () => {
    const f = fixture(), paths = resolveBotPaths(f.stateDirectory, id(3));
    mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
    new Database(paths.databaseFile).close();
    expect(f.store.observe(owner, definition(), 1).botId).toBe(id(3));
    f.close();
    const db = new Database(paths.databaseFile);
    try { db.exec("DELETE FROM bot_identity"); } finally { db.close(); }
    const reopened = f.open();
    expect(() => reopened.store.get(owner, id(3))).toThrow(/durable service\/account identity/);
  });

  it("retains only deletion responsibility for the target Bot and leaves its neighbor intact", () => {
    const f = fixture(); f.store.observe(owner, definition(), 1);
    const neighbor = f.store.observe(owner, { ...definition(), id: id(4) }, 1);
    const deleted = f.store.observe(owner, { id: id(3), workerId: owner.workerId, version: "2", deletion: { deletionId: id(80), requestedVersion: "1", workerCleanup: { state: "pending", code: null }, serverCleanup: { state: "pending", code: null } } }, 2);
    const prepared = f.store.prepareDeletion(deleted, null, []);
    const completed = f.store.finishDeletion(prepared);
    expect(completed).toMatchObject({ intent: null, definition: null, cleanup: { localCompleted: true, targets: [] } });
    f.close(); const reopened = f.open();
    expect(reopened.store.get(owner, id(3))).toEqual(completed);
    expect(reopened.store.get(owner, id(4))).toEqual(neighbor);
  });

  it("preserves legacy authority and refuses a bound Bot whose original data is absent", () => {
    const f = fixture(); f.close();
    mkdirSync(path.dirname(f.legacyDatabaseFile), { recursive: true });
    const legacy = openBotStore(f.legacyDatabaseFile, { onMigration: () => {} });
    legacy.observe(owner, definition(), 1); legacy.prepare(owner, id(3), { homeDirectory: f.home, recoveryLimit: 2 });
    const original = legacy.get(owner, id(3)); legacy.close();
    const reopened = f.open();
    expect(reopened.store.get(owner, id(3))).toEqual(original);
    expect(existsSync(resolveBotPaths(f.stateDirectory, id(3)).databaseFile)).toBe(false);
    expect(() => reopened.store.observe(owner, { ...definition(), id: id(4), sessionId: id(10), testExecutionId: id(11) }, 2)).toThrow(/original storage/);
    expect(existsSync(resolveBotPaths(f.stateDirectory, id(4)).databaseFile)).toBe(false);
  });
});
