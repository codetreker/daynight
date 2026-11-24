import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { vi } from "vitest";
import { resolveConfigurationPaths } from "../../../src/config/paths.js";
import { acquireInstanceLockSync } from "../../../src/platform/instance-lock.js";
import { sqliteFilename } from "../../../src/platform/sqlite-filename.js";
import { openBotStore } from "../../../src/commands/worker/bots/store.js";
import { openBotExecutionStore } from "../../../src/commands/worker/bots/execution-store.js";
import { openControllerLifecycleStore, recordStoppedControllerGeneration, type ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import type { ControllerJobLease } from "../../../src/commands/controller/windows-job.js";
import { writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { resolveBotPaths } from "../../../src/commands/worker/bots/paths.js";
import { frozenToolLaunch } from "../../helpers/tool-launch.js";
import { definition, id, owner, proof } from "./bot-execution-store.fixtures.js";

export { id, owner };
const cleanups: (() => void)[] = [];
export const cleanupMigrationResources = (resources: (() => void)[]) => {
  for (const cleanup of resources.splice(0).reverse()) cleanup();
};
export const cleanupMigrations = () => {
  cleanupMigrationResources(cleanups);
  vi.restoreAllMocks(); vi.unstubAllEnvs();
};
const retain = <T extends { close(): void }>(handle: T, resources = cleanups): T => {
  let closed = false;
  const original = handle.close.bind(handle);
  handle.close = () => { if (!closed) { original(); closed = true; } };
  resources.push(() => handle.close()); return handle;
};

export const migrationFixture = async (options: { submitted?: boolean; nativeSessionId?: string | null; keepWal?: boolean; originalTicketVersion?: 2; aliasRoot?: "shared" | "bot" } = {}, resources = cleanups) => {
  const root = path.resolve(import.meta.dirname, "../../../../../.tmp/bot-migration-tests");
  mkdirSync(root, { recursive: true });
  const homeDirectory = mkdtempSync(path.join(root, "case-"));
  resources.push(() => rmSync(homeDirectory, { recursive: true, force: true }));
  vi.stubEnv("DN_CONFIG_DIR", path.join(homeDirectory, "config"));
  const stateDirectory = resolveConfigurationPaths(homeDirectory).stateDirectory;
  const legacyDatabaseFile = path.join(stateDirectory, "worker", "state.sqlite");
  mkdirSync(path.dirname(legacyDatabaseFile), { recursive: true, mode: 0o700 });
  const bots = retain(openBotStore(legacyDatabaseFile, { onMigration: () => {} }), resources);
  const executions = retain(openBotExecutionStore(legacyDatabaseFile, { onMigration: () => {} }), resources);
  const lock = acquireInstanceLockSync(path.join(path.dirname(legacyDatabaseFile), "instance.lock"), legacyDatabaseFile);
  let released = false;
  const releaseWorker = () => { if (!released) { lock.release(); released = true; } };
  resources.push(releaseWorker);
  const bot = { ...definition(), resolvedConfiguration: { ...definition().resolvedConfiguration, cwd: homeDirectory } };
  bots.observe(owner, bot, 1);
  bots.prepare(owner, bot.id, { homeDirectory, recoveryLimit: 3 });
  const intent = bots.get(owner, bot.id)!.intent!;
  const record = bots.observe(owner, { ...bot, version: "2", sessionId: id(10), testExecutionId: intent.executionId }, 2);
  executions.prepare(record);
  const version = options.originalTicketVersion === 2
    ? { schemaVersion: 2 as const, lifecycleBinding: { serverOrigin: owner.serverOrigin, userId: owner.ownerUserId, workerId: owner.workerId,
      instanceId: id(98), instanceEpoch: "1", intentVersion: "1", localEpoch: "1", scopeGeneration: "1" } }
    : { schemaVersion: 1 as const };
  const ticket: ControllerLaunchTicket = {
    ...version, launchId: intent.launchId, executionId: intent.executionId,
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
  if (ticket.schemaVersion === 2) {
    mkdirSync(path.dirname(intent.ticketPath), { recursive: true, mode: 0o700 });
    writeFileSync(intent.ticketPath, `${JSON.stringify(ticket)}\n`, { mode: 0o600 });
  } else await writeLaunchTicket(homeDirectory, ticket);
  mkdirSync(path.dirname(intent.journalPath), { recursive: true, mode: 0o700 });
  writeFileSync(intent.credentialFile, "original credential fixture", { mode: 0o600 });
  const journal = retain(openControllerLifecycleStore(intent.journalPath, ticket, { contentOwnedLocally: true }), resources);
  const pin = options.keepWal ? retain(new Database(sqliteFilename(intent.journalPath), { readonly: true }), resources) : null;
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
  let aliasDirectory: string | null = null;
  if (options.aliasRoot !== undefined) {
    const aliasRoot = options.aliasRoot === "shared" ? stateDirectory : resolveBotPaths(stateDirectory, bot.id).directory;
    aliasDirectory = path.join(aliasRoot, "agent-cli-aliases", "execution-original");
    mkdirSync(aliasDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(aliasDirectory, "daynight.cmd"), "original shared alias bytes", { mode: 0o600 });
  }
  if (options.submitted !== false) executions.update(record, {
    launchSubmission: "acknowledged", controllerProcess: snapshot.controllerProcess,
    snapshot, aliasDirectory,
  });
  const execution = executions.get(record)!;
  const openRaw = (file: string, readonly = true) => retain(new Database(sqliteFilename(file), { readonly, fileMustExist: true }), resources);
  const confirmStopped = vi.fn(async (_ticket: ControllerLaunchTicket, observed: ControllerSnapshot) => {
    if (observed.lifecycle !== "stopped" || !observed.nativeStopped) throw new Error("fixture execution has not stopped");
  });
  return { homeDirectory, stateDirectory, legacyDatabaseFile, owner, botId: bot.id, bots, executions,
    record, execution, ticket, snapshot, entry, pin, openRaw, confirmStopped, releaseWorker,
    input: { homeDirectory, stateDirectory, legacyDatabaseFile, owner, botId: bot.id, confirmStopped },
  };
};

/** Old Controller paths survive a recovery while new aliases use the Bot root. */
export const recoveredAliasFixture = async () => {
  const f = await migrationFixture({ aliasRoot: "shared" });
  let stopped = f.snapshot;
  if (process.platform === "win32") {
    const confirm = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
    try { stopped = await recordStoppedControllerGeneration(f.record.intent!.journalPath, f.ticket, { jobLease: {} as ControllerJobLease }); }
    finally { confirm.mockRestore(); }
  }
  const record = f.executions.beginRecovery(f.record, stopped, f.homeDirectory, frozenToolLaunch());
  const intent = record.intent!;
  const ticket: ControllerLaunchTicket = { ...f.ticket, launchId: intent.launchId, controllerInstanceId: intent.controllerInstanceId,
    executionGeneration: intent.executionGeneration, resumeNativeSessionId: intent.nativeSessionId };
  await writeLaunchTicket(f.homeDirectory, ticket);
  const journal = retain(openControllerLifecycleStore(intent.journalPath, ticket, { contentOwnedLocally: true, onMigration: () => {} }));
  const snapshot = journal.patchSnapshot({ lifecycle: "stopped", activity: "stopped", nativeStopped: true, stoppedAt: "2026-11-19T00:00:02Z",
    controllerProcess: { ...proof, jobObjectName: `Local\\Daynight-${intent.launchId}` } });
  journal.close();
  const aliasDirectory = path.join(resolveBotPaths(f.stateDirectory, f.botId).directory, "agent-cli-aliases", "execution-original");
  mkdirSync(aliasDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(aliasDirectory, "daynight.cmd"), "recovered Bot-owned alias bytes", { mode: 0o600 });
  const execution = f.executions.update(record, { launchSubmission: "acknowledged", snapshot, controllerProcess: snapshot.controllerProcess, aliasDirectory });
  return { ...f, record, ticket, snapshot, execution };
};
