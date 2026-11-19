import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { vi } from "vitest";
import { resolveConfigurationPaths } from "../../../src/config/paths.js";
import { acquireInstanceLockSync } from "../../../src/platform/instance-lock.js";
import { sqliteFilename } from "../../../src/platform/sqlite-filename.js";
import { openBotStore } from "../../../src/commands/worker/bots/store.js";
import { openBotExecutionStore } from "../../../src/commands/worker/bots/execution-store.js";
import { openControllerLifecycleStore, type ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import { writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { definition, id, owner, proof } from "./bot-execution-store.fixtures.js";

export { id, owner };
const cleanups: (() => void)[] = [];
export const cleanupMigrations = () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
};
const retain = <T extends { close(): void }>(handle: T): T => {
  let closed = false;
  const original = handle.close.bind(handle);
  handle.close = () => { if (!closed) { original(); closed = true; } };
  cleanups.push(() => handle.close()); return handle;
};

export const migrationFixture = async (options: { submitted?: boolean; nativeSessionId?: string | null; keepWal?: boolean } = {}) => {
  const root = path.resolve(import.meta.dirname, "../../../../../.tmp/bot-migration-tests");
  mkdirSync(root, { recursive: true });
  const homeDirectory = mkdtempSync(path.join(root, "case-"));
  cleanups.push(() => rmSync(homeDirectory, { recursive: true, force: true }));
  vi.stubEnv("DN_CONFIG_DIR", path.join(homeDirectory, "config"));
  const stateDirectory = resolveConfigurationPaths(homeDirectory).stateDirectory;
  const legacyDatabaseFile = path.join(stateDirectory, "worker", "state.sqlite");
  mkdirSync(path.dirname(legacyDatabaseFile), { recursive: true, mode: 0o700 });
  const bots = retain(openBotStore(legacyDatabaseFile, { onMigration: () => {} }));
  const executions = retain(openBotExecutionStore(legacyDatabaseFile, { onMigration: () => {} }));
  const lock = acquireInstanceLockSync(path.join(path.dirname(legacyDatabaseFile), "instance.lock"), legacyDatabaseFile);
  let released = false;
  const releaseWorker = () => { if (!released) { lock.release(); released = true; } };
  cleanups.push(releaseWorker);
  const bot = { ...definition(), resolvedConfiguration: { ...definition().resolvedConfiguration, cwd: homeDirectory } };
  bots.observe(owner, bot, 1);
  bots.prepare(owner, bot.id, { homeDirectory, recoveryLimit: 3 });
  const intent = bots.get(owner, bot.id)!.intent!;
  const record = bots.observe(owner, { ...bot, version: "2", sessionId: id(10), testExecutionId: intent.executionId }, 2);
  executions.prepare(record);
  const ticket: ControllerLaunchTicket = {
    schemaVersion: 1, launchId: intent.launchId, executionId: intent.executionId,
    testExecutionId: intent.executionId, controllerId: intent.registration.controllerId,
    controllerInstanceId: intent.controllerInstanceId, sessionId: record.intent!.sessionId!,
    executionGeneration: "1", serverOrigin: owner.serverOrigin, ownerUserId: owner.ownerUserId,
    provider: "codex", cwd: homeDirectory, nativeHome: path.join(homeDirectory, "native-home"),
    configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 3 },
    initialOperationId: intent.initialOperationId, initialPrompt: "", initialInput: "none",
    resumeNativeSessionId: null, credentialFile: intent.credentialFile,
    ipcEndpoint: path.join(homeDirectory, "controller.sock"), ipcSecret: "a".repeat(64),
    createdAt: "2026-11-19T00:00:00Z",
  };
  await writeLaunchTicket(homeDirectory, ticket);
  mkdirSync(path.dirname(intent.journalPath), { recursive: true, mode: 0o700 });
  writeFileSync(intent.credentialFile, "original credential fixture", { mode: 0o600 });
  const journal = retain(openControllerLifecycleStore(intent.journalPath, ticket, { contentOwnedLocally: true }));
  const pin = options.keepWal ? retain(new Database(sqliteFilename(intent.journalPath), { readonly: true })) : null;
  pin?.exec("BEGIN; SELECT * FROM execution");
  const entry = { entryId: id(50), revision: "1", kind: "assistant_message" as const, content: [{ type: "text" as const, text: "Original history 中文 🐈" }] };
  journal.projectTimeline(entry);
  journal.prepareOperation({ operationId: id(51), kind: "send_message", payload: { text: "original unknown dispatch" } });
  journal.markDispatching(id(51));
  const nativeSessionId = options.nativeSessionId === undefined ? id(20) : options.nativeSessionId;
  const snapshot = journal.patchSnapshot({
    nativeSessionId, controllerProcess: { ...proof, jobObjectName: `Local\\Daynight-${intent.launchId}` },
    lifecycle: "stopped", activity: "stopped", nativeStopped: true, stoppedAt: "2026-11-19T00:00:01Z",
  });
  journal.close();
  if (options.submitted !== false) executions.update(record, {
    launchSubmission: "acknowledged", controllerProcess: snapshot.controllerProcess,
    snapshot,
  });
  const execution = executions.get(record)!;
  const openRaw = (file: string, readonly = true) => retain(new Database(sqliteFilename(file), { readonly, fileMustExist: true }));
  const confirmStopped = vi.fn(async (_ticket: ControllerLaunchTicket, observed: ControllerSnapshot) => {
    if (observed.lifecycle !== "stopped" || !observed.nativeStopped) throw new Error("fixture execution has not stopped");
  });
  return { homeDirectory, stateDirectory, legacyDatabaseFile, owner, botId: bot.id, bots, executions,
    record, execution, ticket, snapshot, entry, pin, openRaw, confirmStopped, releaseWorker,
    input: { homeDirectory, stateDirectory, legacyDatabaseFile, owner, botId: bot.id, confirmStopped },
  };
};
