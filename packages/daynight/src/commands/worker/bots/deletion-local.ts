import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ApiError } from "../../../api/client.js";
import { acquireInstanceLockSync, InstanceLockHeldError } from "../../../platform/instance-lock.js";
import { inspectSqlite } from "../../../platform/sqlite-format.js";
import { sqliteFilename } from "../../../platform/sqlite-filename.js";
import type { BotDeletionRecovery } from "../../bot/deletion-api.js";
import { resolveWorkerPaths } from "../paths.js";
import { readWorkerIdentity } from "../identity.js";
import { workerStoreFormat } from "../store-format.js";
import { resolveBotPaths } from "./paths.js";
import { botStoreFormat } from "./store-format.js";
import { assertMigrationPhysicalPath } from "./migration-state.js";
import { parseBot, parseBotOwner, type BotRecord } from "./types.js";
import { checkBotDeletionRecovery, createBotDeletion } from "./delete.js";
import { openLocalBotStores } from "./local-store.js";
import { createBotRemote } from "./remote.js";
import { createBotSessionApi } from "./session-api.js";
import { createBotProcess } from "./process.js";
import { createBotReconciliation } from "./reconciliation.js";
import { openBotRecoveryStore } from "./recovery-store.js";
import { createBotRecoveryApi } from "./recovery-api.js";

export class DeletionLocalError extends Error {
  constructor(readonly code: string, options: ErrorOptions & { receiptConfirmed?: boolean; generationStopped?: boolean } = {}) {
    super(`Bot deletion local recovery failed: ${code}.`, options);
    this.name = "DeletionLocalError";
    this.receiptConfirmed = options.receiptConfirmed === true;
    this.generationStopped = options.generationStopped === true;
  }
  readonly receiptConfirmed: boolean;
  readonly generationStopped: boolean;
}
const lockIsHeld = (cause: unknown, seen = new Set<unknown>()): boolean => {
  if (seen.has(cause)) return false;
  seen.add(cause);
  if (cause instanceof InstanceLockHeldError) return true;
  return cause instanceof AggregateError ? cause.errors.some(value => lockIsHeld(value, seen))
    : cause instanceof Error && lockIsHeld(cause.cause, seen);
};
type InspectionInput = { homeDirectory: string; serverUrl: string; ownerUserId: string; botId: string; recovery: BotDeletionRecovery; signal: AbortSignal };
export type LocalBotDeletionInspection = {
  botId: string; workerId: string; localWorkerId: string | null; originalWorkerMatched: boolean;
  hostingWorkerId: string; hostingWorkerMatched: boolean;
  storage: "missing" | "available" | "unreadable"; evidence: "missing" | "retained" | "stop_receipt";
  canRecover: boolean; localCompleted: boolean;
  checks: { bindingMatched: boolean; launchIntentPresent: boolean; executionRecordPresent: boolean; stopReceiptPresent: boolean; journalPresent: boolean; ticketPresent: boolean };
  localProcessState: "unverified";
};

/** Inspect committed records without creating, migrating or repairing local storage. */
export const inspectLocalBotDeletion = async (input: InspectionInput): Promise<LocalBotDeletionInspection> => {
  input.signal.throwIfAborted();
  const paths = resolveWorkerPaths(input.homeDirectory), recovery = input.recovery;
  if (recovery.botId !== input.botId) throw new DeletionLocalError("deletion_changed");
  let localWorkerId: string | null = null;
  try { localWorkerId = await readWorkerIdentity(paths, input.signal); }
  catch { input.signal.throwIfAborted(); }
  const result: LocalBotDeletionInspection = {
    botId: input.botId, workerId: recovery.workerId, localWorkerId, originalWorkerMatched: localWorkerId === recovery.workerId,
    hostingWorkerId: recovery.hostingWorkerId, hostingWorkerMatched: localWorkerId === recovery.hostingWorkerId,
    storage: "missing", evidence: "missing", canRecover: false, localCompleted: false,
    checks: { bindingMatched: false, launchIntentPresent: false, executionRecordPresent: false, stopReceiptPresent: false, journalPresent: false, ticketPresent: false },
    localProcessState: "unverified",
  };
  const owner = parseBotOwner({ serverOrigin: input.serverUrl, ownerUserId: input.ownerUserId, workerId: recovery.workerId });
  const dedicated = resolveBotPaths(paths.stateDirectory, input.botId).databaseFile;
  const records: BotRecord[] = [];
  let executionRecordPresent = false;
  try {
    for (const file of [dedicated, paths.databaseFile]) {
      if (!existsSync(file)) continue;
      input.signal.throwIfAborted();
      assertMigrationPhysicalPath(path.dirname(file), "directory");
      assertMigrationPhysicalPath(file, "file");
      for (const suffix of ["-wal", "-shm"]) if (existsSync(`${file}${suffix}`)) assertMigrationPhysicalPath(`${file}${suffix}`, "file");
      const db = new Database(sqliteFilename(file), { readonly: true, fileMustExist: true });
      try {
        db.transaction(() => {
          inspectSqlite(db, file === dedicated ? botStoreFormat : workerStoreFormat);
          const rows = db.prepare("SELECT record FROM bots WHERE server_origin = ? AND owner_user_id = ? AND worker_id = ? AND bot_id = ?")
            .all(owner.serverOrigin, owner.ownerUserId, owner.workerId, input.botId) as { record: string }[];
          for (const row of rows) {
            const record = JSON.parse(row.record) as BotRecord;
            if (record.botId !== input.botId || JSON.stringify(parseBotOwner(record.owner)) !== JSON.stringify(owner)) throw new Error("Local deletion owner differs.");
            parseBot(record.observed, owner);
            records.push(record);
            executionRecordPresent = db.prepare("SELECT 1 FROM bot_executions WHERE server_origin = ? AND owner_user_id = ? AND worker_id = ? AND bot_id = ?")
              .get(owner.serverOrigin, owner.ownerUserId, owner.workerId, input.botId) !== undefined;
          }
        }).deferred();
      } finally { db.close(); }
    }
    if (records.length > 1) throw new Error("Bot has multiple local authorities.");
    const record = records[0];
    if (record !== undefined) {
      result.storage = "available";
      // Inspection reports evidence availability, not a stopped process. The
      // locked recovery path independently validates each original record.
      if (record.observed.deletion === null) {
        record.observed = { id: input.botId, workerId: recovery.workerId, version: recovery.version,
          deletion: { deletionId: recovery.deletionId, requestedVersion: recovery.requestedVersion, workerCleanup: recovery.workerCleanup, serverCleanup: recovery.serverCleanup } };
      }
      checkBotDeletionRecovery(record, recovery);
      const bindingPresent = record.intent != null || record.cleanup?.stop != null;
      result.checks.bindingMatched = !recovery.requiresStopProof || bindingPresent;
      result.checks.launchIntentPresent = record.intent != null;
      result.checks.executionRecordPresent = executionRecordPresent;
      result.checks.stopReceiptPresent = record.cleanup?.stop != null;
      result.checks.journalPresent = record.intent != null && existsSync(record.intent.journalPath);
      result.checks.ticketPresent = record.intent != null && existsSync(record.intent.ticketPath);
      result.localCompleted = record.cleanup?.localCompleted === true;
      result.evidence = result.checks.stopReceiptPresent ? "stop_receipt" : result.checks.launchIntentPresent ? "retained" : "missing";
    }
    const rejectedNeverStarted = recovery.recoveryRequired && record?.cleanup?.stop?.stopProof.kind === "never_started";
    result.canRecover = result.hostingWorkerMatched && recovery.decision === null && record?.migration === undefined && !rejectedNeverStarted
      && (!recovery.requiresStopProof || result.checks.bindingMatched && (result.checks.stopReceiptPresent || executionRecordPresent
        || recovery.recoveryRequired && result.checks.launchIntentPresent && result.checks.journalPresent && result.checks.ticketPresent));
  } catch {
    input.signal.throwIfAborted();
    result.storage = "unreadable"; result.canRecover = false;
  }
  return result;
};

/** Recovery borrows the original Worker and Bot locks; it cannot start an execution. */
export const recoverLocalBotDeletion = async (input: InspectionInput & {
  packageDirectory: string; workingDirectory: string; serverToken: string;
}): Promise<{ receiptConfirmed: true }> => {
  const inspection = await inspectLocalBotDeletion(input);
  if (!inspection.hostingWorkerMatched) throw new DeletionLocalError("wrong_worker");
  if (inspection.storage === "unreadable") throw new DeletionLocalError("storage_unreadable");
  if (!inspection.canRecover) throw new DeletionLocalError("evidence_missing");
  const paths = resolveWorkerPaths(input.homeDirectory);
  let lock: ReturnType<typeof acquireInstanceLockSync>;
  try { lock = acquireInstanceLockSync(paths.lockFile, paths.databaseFile, undefined, { fileMustExist: true }); }
  catch (cause) { throw new DeletionLocalError(lockIsHeld(cause) ? "worker_running" : "storage_unreadable", { cause }); }
  let local: ReturnType<typeof openLocalBotStores> | undefined, process: ReturnType<typeof createBotProcess> | undefined;
  let failure: unknown, failed = false, receiptConfirmed = false;
  try {
    const owner = parseBotOwner({ serverOrigin: input.serverUrl, ownerUserId: input.ownerUserId, workerId: input.recovery.hostingWorkerId });
    const originalOwner = { ...owner, workerId: input.recovery.workerId };
    if (await readWorkerIdentity(paths, input.signal) !== owner.workerId) throw new DeletionLocalError("wrong_worker");
    const remote = createBotRemote({ owner, serverToken: input.serverToken });
    const bot = await remote.read(input.botId, input.signal, originalOwner);
    const recovery = await remote.readDeletionRecovery!(input.botId, input.signal, originalOwner);
    if (bot === null || bot.deletion === null || recovery === null || recovery.decision !== null
      || recovery.hostingWorkerId !== owner.workerId || bot.deletion.deletionId !== input.recovery.deletionId || recovery.deletionId !== input.recovery.deletionId) throw new DeletionLocalError("deletion_changed");
    local = openLocalBotStores({ stateDirectory: paths.stateDirectory, legacyDatabaseFile: paths.databaseFile, owner });
    const record = local.store.observe(originalOwner, bot, Date.now());
    checkBotDeletionRecovery(record, recovery);
    if (recovery.requiresStopProof && record.intent === null && record.cleanup?.stop == null) throw new DeletionLocalError("evidence_missing");
    const stores = local;
    const hosting = createBotReconciliation({ owner, store: openBotRecoveryStore({ stateDirectory: paths.stateDirectory, owner, assertLocked: stores.assertLocked }),
      api: createBotRecoveryApi({ owner, serverToken: input.serverToken }), applicable: stores.isDedicated, canSubmit: () => false });
    if (!hosting.ownsHosting(record)) throw new DeletionLocalError("wrong_worker");
    const sessionApi = createBotSessionApi({ owner, serverToken: input.serverToken, stateDirectory: paths.stateDirectory, recovery: hosting });
    process = createBotProcess({ homeDirectory: input.homeDirectory, packageDirectory: input.packageDirectory,
      store: local.store, executions: local.executions, sessionApi, recoveryLimit: 0, canControl: hosting.ownsHosting, canAdmitNewExecution: () => false });
    if (record.intent !== null && record.cleanup?.stop == null && local.executions.get(record) === null) {
      await process.withDeletion(record, input.signal, stop => stop({ recoverMissingExecution: true }));
      throw new DeletionLocalError("evidence_missing", { generationStopped: true });
    }
    await createBotDeletion({ homeDirectory: input.homeDirectory, store: local.store, executions: local.executions, process, sessionApi, remote, onReceiptConfirmed: () => { receiptConfirmed = true; } })
      .advance(record, input.signal, { recover: true });
    const current = local.store.get(originalOwner, input.botId)!;
    if (current.observed.deletion?.workerCleanup.state !== "completed") throw new DeletionLocalError("stop_unproven");
    receiptConfirmed = true;
  } catch (cause) { failed = true; failure = cause; }
  const cleanups: unknown[] = [];
  try { await process?.close(); } catch (cause) { cleanups.push(cause); }
  try { local?.close(); } catch (cause) { cleanups.push(cause); }
  try { lock.release(); } catch (cause) { cleanups.push(cause); }
  if (cleanups.length) throw new DeletionLocalError("local_cleanup_failed", { receiptConfirmed, cause: new AggregateError([...(failed ? [failure] : []), ...cleanups]) });
  if (failed) {
    if (receiptConfirmed) throw new DeletionLocalError("local_cleanup_failed", { receiptConfirmed, cause: failure });
    if (failure instanceof ApiError || failure instanceof DeletionLocalError) throw failure;
    throw new DeletionLocalError("stop_unproven", { cause: failure });
  }
  return { receiptConfirmed: true };
};
