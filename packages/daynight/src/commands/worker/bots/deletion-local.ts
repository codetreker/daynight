import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ApiError } from "../../../api/client.js";
import { acquireInstanceLockSync, InstanceLockHeldError } from "../../../platform/instance-lock.js";
import { inspectSqlite } from "../../../platform/sqlite-format.js";
import { sqliteFilename } from "../../../platform/sqlite-filename.js";
import { resolveWorkerPaths } from "../paths.js";
import { readWorkerIdentity } from "../identity.js";
import { workerStoreFormat } from "../store-format.js";
import { resolveBotPaths } from "./paths.js";
import { botStoreFormat } from "./store-format.js";
import { assertMigrationPhysicalPath } from "./migration-state.js";
import { parseBot, parseBotOwner, type BotRecord, type BotDeleted } from "./types.js";
import { requiresBotDeletionRecovery, createBotDeletion } from "./delete.js";
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
type RecoveryInput = { homeDirectory: string; serverUrl: string; ownerUserId: string; botId: string; bot: BotDeleted; signal: AbortSignal };

/** Missing storage must not be created or migrated into recovery evidence. */
const preflight = async (input: RecoveryInput): Promise<string> => {
  input.signal.throwIfAborted();
  const paths = resolveWorkerPaths(input.homeDirectory);
  if (input.bot.id !== input.botId || input.bot.deletion.workerCleanup.state !== "failed"
    || input.bot.deletion.workerCleanup.code !== "execution_evidence_missing") throw new DeletionLocalError("deletion_changed");
  let localWorkerId: string;
  try { localWorkerId = await readWorkerIdentity(paths, input.signal); }
  catch (cause) { input.signal.throwIfAborted(); throw new DeletionLocalError("wrong_worker", { cause }); }
  const owner = parseBotOwner({ serverOrigin: input.serverUrl, ownerUserId: input.ownerUserId, workerId: input.bot.workerId });
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
      const deletion = record.observed.deletion;
      if (deletion !== null && (deletion.deletionId !== input.bot.deletion.deletionId
        || deletion.requestedVersion !== input.bot.deletion.requestedVersion)) throw new DeletionLocalError("deletion_changed");
    }
    if (record === undefined || record.migration !== undefined || record.cleanup?.stop?.stopProof.kind === "never_started"
      || record.cleanup?.stop == null && (record.intent === null || !executionRecordPresent
        && (!existsSync(record.intent.journalPath) || !existsSync(record.intent.ticketPath)))) throw new DeletionLocalError("evidence_missing");
  } catch (cause) {
    input.signal.throwIfAborted();
    if (cause instanceof DeletionLocalError) throw cause;
    throw new DeletionLocalError("storage_unreadable", { cause });
  }
  return localWorkerId;
};

/** Recovery borrows the original Worker and Bot locks; it cannot start an execution. */
export const recoverLocalBotDeletion = async (input: RecoveryInput & {
  packageDirectory: string; workingDirectory: string; serverToken: string;
}): Promise<{ receiptConfirmed: true }> => {
  const localWorkerId = await preflight(input);
  const paths = resolveWorkerPaths(input.homeDirectory);
  let lock: ReturnType<typeof acquireInstanceLockSync>;
  try { lock = acquireInstanceLockSync(paths.lockFile, paths.databaseFile, undefined, { fileMustExist: true }); }
  catch (cause) { throw new DeletionLocalError(lockIsHeld(cause) ? "worker_running" : "storage_unreadable", { cause }); }
  let local: ReturnType<typeof openLocalBotStores> | undefined, process: ReturnType<typeof createBotProcess> | undefined;
  let failure: unknown, failed = false, receiptConfirmed = false;
  try {
    const owner = parseBotOwner({ serverOrigin: input.serverUrl, ownerUserId: input.ownerUserId, workerId: localWorkerId });
    const originalOwner = { ...owner, workerId: input.bot.workerId };
    if (await readWorkerIdentity(paths, input.signal) !== owner.workerId) throw new DeletionLocalError("wrong_worker");
    const remote = createBotRemote({ owner, serverToken: input.serverToken });
    const bot = await remote.read(input.botId, input.signal, originalOwner);
    if (bot === null || bot.deletion === null || bot.deletion.deletionId !== input.bot.deletion.deletionId
      || bot.deletion.requestedVersion !== input.bot.deletion.requestedVersion || BigInt(bot.version) < BigInt(input.bot.version)
      || bot.deletion.workerCleanup.state !== "failed" || bot.deletion.workerCleanup.code !== "execution_evidence_missing") throw new DeletionLocalError("deletion_changed");
    local = openLocalBotStores({ stateDirectory: paths.stateDirectory, legacyDatabaseFile: paths.databaseFile, owner });
    if (local.store.get(originalOwner, input.botId) === null) throw new DeletionLocalError("evidence_missing");
    const record = local.store.observe(originalOwner, bot, Date.now());
    if (!requiresBotDeletionRecovery(record) || record.intent === null && record.cleanup?.stop == null) throw new DeletionLocalError("evidence_missing");
    const stores = local;
    const recoveryStore = openBotRecoveryStore({ stateDirectory: paths.stateDirectory, owner, assertLocked: stores.assertLocked });
    const hostingState = stores.isDedicated(record) ? recoveryStore.read(record) : null, receipt = hostingState?.current ?? hostingState?.registration;
    if (hostingState?.pending != null || receipt != null && (!receipt.current || receipt.receipt.workerId !== owner.workerId)
      || record.cleanup?.workerId !== undefined && record.cleanup.workerId !== owner.workerId) throw new DeletionLocalError("wrong_worker");
    const hosting = createBotReconciliation({ owner, store: recoveryStore,
      api: createBotRecoveryApi({ owner, serverToken: input.serverToken }), applicable: stores.isDedicated, canSubmit: () => false });
    // Cleanup can erase recovery.json. Its stopped, machine-bound responsibility
    // then permits only the saved targets and receipt, not control of a writer.
    const continuingCleanup = hostingState === null && record.cleanup?.workerId === owner.workerId
      && record.cleanup.stop !== null && record.cleanup.stop.stopProof.kind !== "never_started";
    if (!continuingCleanup && !hosting.ownsHosting(record)) throw new DeletionLocalError("wrong_worker");
    const sessionApi = createBotSessionApi({ owner, serverToken: input.serverToken, stateDirectory: paths.stateDirectory, recovery: hosting });
    process = createBotProcess({ homeDirectory: input.homeDirectory, packageDirectory: input.packageDirectory,
      store: local.store, executions: local.executions, sessionApi, recoveryLimit: 0, canControl: hosting.ownsHosting, canAdmitNewExecution: () => false });
    if (record.intent !== null && record.cleanup?.stop == null && local.executions.get(record) === null) {
      await process.withDeletion(record, input.signal, stop => stop({ recoverMissingExecution: true }));
      throw new DeletionLocalError("evidence_missing", { generationStopped: true });
    }
    await createBotDeletion({ homeDirectory: input.homeDirectory, store: local.store, executions: local.executions, process, sessionApi, remote,
      recoveryWorkerId: owner.workerId, onReceiptConfirmed: () => { receiptConfirmed = true; } })
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
