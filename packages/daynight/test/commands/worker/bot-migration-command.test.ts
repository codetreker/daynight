import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { CliContext } from "../../../src/cli/context.js";
import type { ServerCommand } from "../../../src/commands/server/runtime.js";
import { runWorkerCommand } from "../../../src/commands/worker/index.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { acquireInstanceLockSync } from "../../../src/platform/instance-lock.js";
import { sqliteFilename } from "../../../src/platform/sqlite-filename.js";
import { id, owner } from "./bot-execution-store.fixtures.js";

const mocks = vi.hoisted(() => ({ run: vi.fn(), migrate: vi.fn(), history: vi.fn() }));
vi.mock("../../../src/commands/server/runtime.js", () => ({ runServerCommand: mocks.run }));
vi.mock("../../../src/commands/worker/bots/migration.js", () => ({ migrateLegacyBot: mocks.migrate, readMigratedBotHistory: mocks.history }));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); mocks.run.mockReset(); mocks.migrate.mockReset(); mocks.history.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  const root = path.resolve(import.meta.dirname, "../../../../../.tmp/bot-migration-command-tests");
  mkdirSync(root, { recursive: true });
  const home = mkdtempSync(path.join(root, "case-")); roots.push(home);
  vi.stubEnv("DN_CONFIG_DIR", path.join(home, "config"));
  const paths = resolveWorkerPaths(home); mkdirSync(paths.workerDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configFile, `workerId: ${owner.workerId}\n`, { mode: 0o600 });
  new Database(sqliteFilename(paths.databaseFile)).close();
  let result: Awaited<ReturnType<ServerCommand>>;
  const output: string[] = [];
  const context: CliContext = { version: "1", packageDirectory: home, homeDirectory: () => home,
    workingDirectory: () => home, stdout: text => { output.push(text); }, stderr: () => {}, stdoutBytes: async () => {} };
  mocks.run.mockImplementation(async (_context: CliContext, command: ServerCommand) => {
    const operation = createOperation({ limits: { totalMs: 5000 } });
    try { result = await command({ api: { getCurrentUser: async () => ({ id: owner.ownerUserId }) }, operation, serverUrl: owner.serverOrigin } as never); }
    finally { operation.dispose(); }
  });
  mocks.migrate.mockResolvedValue({ botId: id(3), phase: "committed", registration: "pending", nativeRecovery: "missing" });
  mocks.history.mockReturnValue({ manifest: { botId: id(3), registration: "pending", nativeRecovery: "missing", original: { secret: "private fixture credential" } },
    snapshot: { sessionId: id(10), nativeSessionId: id(20), ipcSecret: "private fixture IPC" }, entries: [{ entryId: id(50) }] });
  return { paths, context, output, get result() { return result; } };
};

it("routes a confirmed migration with the authenticated service, account and original local Worker", async () => {
  const f = fixture();
  await runWorkerCommand(["migrate-bot", id(3), "--confirm"], f.context);
  expect(mocks.migrate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ owner, botId: id(3), stateDirectory: f.paths.stateDirectory, legacyDatabaseFile: f.paths.databaseFile }));
  expect(f.result).toMatchObject({ kind: "confirmed-mutation" });
  expect(existsSync(f.paths.lockFile)).toBe(false);
});

it("refuses an unconfirmed migration before authentication, lock acquisition or storage mutation", async () => {
  const f = fixture();
  await expect(runWorkerCommand(["migrate-bot", id(3)], f.context)).rejects.toThrow(/--confirm/);
  expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.migrate).not.toHaveBeenCalled();
  expect(existsSync(f.paths.lockFile)).toBe(false);
});

it("honors a live original Worker lock without invoking migration", async () => {
  const f = fixture(), lock = acquireInstanceLockSync(f.paths.lockFile, f.paths.databaseFile);
  try {
    await expect(runWorkerCommand(["migrate-bot", id(3), "--confirm"], f.context)).rejects.toThrow(/instance lock/i);
    expect(mocks.migrate).not.toHaveBeenCalled(); expect(existsSync(f.paths.lockFile)).toBe(true);
  } finally { lock.release(); }
});

it("routes history reads without a Worker lock and omits private migration evidence", async () => {
  const f = fixture(), lock = acquireInstanceLockSync(f.paths.lockFile, f.paths.databaseFile);
  try {
    await runWorkerCommand(["migrated-bot-history", id(3), "--json"], f.context);
    expect(mocks.history).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ owner, botId: id(3) }));
    expect(JSON.parse(f.result as string)).toEqual({ botId: id(3), registration: "pending", nativeRecovery: "missing", sessionId: id(10), nativeSessionId: id(20), entries: [{ entryId: id(50) }] });
    expect(f.result).not.toContain("private fixture"); expect(mocks.migrate).not.toHaveBeenCalled();
  } finally { lock.release(); }
});

it.each(["migrate-bot", "migrated-bot-history"])("prints %s help and rejects malformed identities before resources", async command => {
  const f = fixture();
  await runWorkerCommand([command, "--help"], f.context);
  expect(f.output.join("")).toMatch(/never starts|without starting/);
  await expect(runWorkerCommand([command, "not-a-uuid"], f.context)).rejects.toThrow();
  expect(mocks.run).not.toHaveBeenCalled();
});

it("refuses missing original Worker identity instead of discovering or creating one", async () => {
  const f = fixture(); writeFileSync(f.paths.configFile, "{}\n", { mode: 0o600 });
  await expect(runWorkerCommand(["migrate-bot", id(3), "--confirm"], f.context)).rejects.toThrow(/Worker ID/);
  expect(mocks.migrate).not.toHaveBeenCalled(); expect(existsSync(f.paths.lockFile)).toBe(false);
});
