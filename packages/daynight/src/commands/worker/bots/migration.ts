import { chmodSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { acquireInstanceLockSync } from "../../../platform/instance-lock.js";
import { ensureDurableDirectory, syncDurableDirectory } from "../../../platform/durable-directory.js";
import { openSqliteDatabase } from "../../../platform/sqlite-access.js";
import { inspectSqlite } from "../../../platform/sqlite-format.js";
import { sqliteFilename } from "../../../platform/sqlite-filename.js";
import { controllerExecutionDirectory, controllerPayloadHash, controllerTicketPath, parseLaunchTicket, readLaunchTicket, type ControllerLaunchTicket } from "../../controller/launch-ticket.js";
import { readCompatibleControllerSnapshot, readHistoricalStoppedControllerGeneration, validateWindowsControllerStopProof, type ControllerSnapshot } from "../../controller/lifecycle-store.js";
import { confirmControllerProcessesStopped } from "../../controller/process-proof.js";
import { isLinuxControllerLaunch } from "../../controller/linux-controller-launch.js";
import { acquireControllerStoragePermit, type ControllerStoragePermit } from "../../controller/storage-lock.js";
import { openTimelineStore, type TimelinePageQuery } from "../../controller/content/timeline-store.js";
import { inspectReadCompatibleControllerJournal } from "../../controller/journal-format.js";
import { preservesControllerProcessProof, preservesNativeProcessPrefix } from "../backends/orchestration.js";
import { workerStoreFormat } from "../store-format.js";
import { openBotStore } from "./store.js";
import { openBotExecutionStore, validateBotExecutionSnapshot, type BotExecution } from "./execution-store.js";
import { botStoreFormat } from "./store-format.js";
import { resolveBotControllerStateDirectory, resolveBotPaths } from "./paths.js";
import { botUUID, parseBot, parseBotOwner, type BotOwner, type BotRecord } from "./types.js";
import { assertMigrationPhysicalPath, botMigrationAliases, botMigrationHash, botMigrationManifestPath, migrationDestination, readBotMigrationManifest, type BotMigrationManifest, type BotMigrationPhase } from "./migration-state.js";
import { copyMigrationFile, copyMigrationTree, saveMigrationManifest, verifyMigrationFiles, verifyMigrationSources } from "./migration-files.js";
import type { BotRecoveryBinding } from "./recovery-protocol.js";

export type { BotMigrationManifest, BotMigrationPhase } from "./migration-state.js";
type Target = { stateDirectory: string; owner: BotOwner; botId: string };
export type BotMigrationOptions = Target & {
  homeDirectory: string; legacyDatabaseFile: string; signal?: AbortSignal;
  onPhase?: (phase: BotMigrationPhase) => void;
  /** Process observation is injectable; file, SQLite, identity and lock validation remain real. */
  confirmStopped?: (ticket: ControllerLaunchTicket, snapshot: ControllerSnapshot, signal: AbortSignal) => Promise<void>;
};
const predicate = "server_origin = @serverOrigin AND owner_user_id = @ownerUserId AND worker_id = @workerId AND bot_id = @botId";
const params = (target: Pick<Target, "owner" | "botId">) => ({ ...target.owner, botId: target.botId });
const originalRows = (db: Database.Database, target: Pick<Target, "owner" | "botId">) => {
  const record = db.prepare(`SELECT record FROM bots WHERE ${predicate}`).get(params(target)) as { record: string } | undefined;
  const execution = db.prepare(`SELECT record FROM bot_executions WHERE ${predicate}`).get(params(target)) as { record: string } | undefined;
  return { record: record === undefined ? null : JSON.parse(record.record) as BotRecord, execution: execution === undefined ? null : JSON.parse(execution.record) as BotExecution };
};
const assertSource = (db: Database.Database, manifest: BotMigrationManifest): void => {
  const current = originalRows(db, manifest);
  if (current.record === null || controllerPayloadHash(current.record) !== manifest.sourceRecordHash || controllerPayloadHash(current.execution) !== manifest.sourceExecutionHash) throw new Error("Bot migration original inventory or execution changed; original evidence was retained.");
};
const receipt = (db: Database.Database, target: Target): string | null => {
  const row = db.prepare(`SELECT manifest_hash FROM bot_migrations WHERE ${predicate}`).get(params(target)) as { manifest_hash: string } | undefined;
  return row?.manifest_hash ?? null;
};
const verifyDedicatedStore = (target: Target, manifest: BotMigrationManifest): void => {
  const paths = resolveBotPaths(target.stateDirectory, target.botId);
  assertMigrationPhysicalPath(paths.databaseFile, "file");
  for (const suffix of ["-wal", "-shm"]) if (existsSync(`${paths.databaseFile}${suffix}`)) assertMigrationPhysicalPath(`${paths.databaseFile}${suffix}`, "file");
  const db = new Database(sqliteFilename(paths.databaseFile), { readonly: true, fileMustExist: true });
  try {
    db.transaction(() => {
      if (inspectSqlite(db, botStoreFormat).kind !== "current") throw new Error("Bot migration destination schema is not current.");
      const identity = db.prepare("SELECT server_origin,owner_user_id,bot_id FROM bot_identity WHERE singleton=1").get();
      if (controllerPayloadHash(identity) !== controllerPayloadHash({ server_origin: target.owner.serverOrigin, owner_user_id: target.owner.ownerUserId, bot_id: target.botId })) throw new Error("Bot migration destination owner differs.");
      const rows = originalRows(db, target), expected: BotRecord = { ...manifest.original.record, migration: { state: "registration_pending", manifestPath: botMigrationManifestPath(target.stateDirectory, target.botId) } };
      const stable = (record: BotRecord) => ({ owner: record.owner, botId: record.botId, intent: record.intent, migration: record.migration, configuration: record.definition?.resolvedConfiguration ?? null });
      if (rows.record !== null) parseBot(rows.record.observed, target.owner);
      const matchesRecord = rows.record !== null && (manifest.phase === "committed" ? controllerPayloadHash(stable(rows.record)) === controllerPayloadHash(stable(expected)) : controllerPayloadHash(rows.record) === controllerPayloadHash(expected));
      if (!matchesRecord || controllerPayloadHash(rows.execution) !== manifest.sourceExecutionHash
        || (db.prepare("SELECT count(*) AS n FROM bots").get() as { n: number }).n !== 1
        || (db.prepare("SELECT count(*) AS n FROM bot_executions").get() as { n: number }).n !== (manifest.original.execution === null ? 0 : 1)) throw new Error("Bot migration destination records differ from the original identities.");
    }).deferred();
  } finally { db.close(); }
};
const copyDedicatedStore = (target: Target, manifest: BotMigrationManifest): void => {
  const paths = resolveBotPaths(target.stateDirectory, target.botId);
  const populate = (db: Database.Database): undefined => {
      db.prepare("INSERT INTO bot_identity VALUES(1,?,?,?)").run(target.owner.serverOrigin, target.owner.ownerUserId, target.botId);
      const record = { ...manifest.original.record, migration: { state: "registration_pending", manifestPath: botMigrationManifestPath(target.stateDirectory, target.botId) } };
      for (const [table, row] of [["bots", record], ["bot_executions", manifest.original.execution]] as const) {
        if (row !== null) db.prepare(`INSERT INTO ${table} VALUES(@serverOrigin,@ownerUserId,@workerId,@botId,@record)`).run({ ...params(target), record: JSON.stringify(row) });
      }
  };
  if (existsSync(paths.databaseFile)) {
    assertMigrationPhysicalPath(paths.databaseFile, "file");
    for (const suffix of ["-wal", "-shm"]) if (existsSync(`${paths.databaseFile}${suffix}`)) assertMigrationPhysicalPath(`${paths.databaseFile}${suffix}`, "file");
    const previous = new Database(sqliteFilename(paths.databaseFile), { readonly: true, fileMustExist: true });
    let empty: boolean;
    try { empty = inspectSqlite(previous, botStoreFormat).kind === "empty"; } finally { previous.close(); }
    if (!empty) { verifyDedicatedStore(target, manifest); return; }
  }
  // Schema, owner and records publish in the same migration transaction. A
  // process exit before commit leaves only this manifest-owned empty database.
  const format = { ...botStoreFormat, baseline: { ...botStoreFormat.baseline, create: (db: Database.Database): undefined => { botStoreFormat.baseline.create(db); populate(db); } } };
  const db = openSqliteDatabase({ file: paths.databaseFile, format, allowCreate: true });
  db.close();
  chmodSync(paths.databaseFile, 0o600); syncDurableDirectory(paths.directory);
};
const verifyTicket = (record: BotRecord, ticket: ControllerLaunchTicket): void => {
  const intent = record.intent!;
  if (ticket.claimId !== undefined || ticket.testExecutionId !== intent.executionId || ticket.executionId !== intent.executionId
    || ticket.launchId !== intent.launchId || ticket.sessionId !== intent.sessionId || ticket.controllerId !== intent.registration.controllerId
    || ticket.controllerInstanceId !== intent.controllerInstanceId || ticket.executionGeneration !== intent.executionGeneration
    || ticket.serverOrigin !== record.owner.serverOrigin || ticket.ownerUserId !== record.owner.ownerUserId || ticket.provider !== intent.registration.provider
    || ticket.credentialFile !== intent.credentialFile || ticket.initialOperationId !== intent.initialOperationId || ticket.initialInput !== "none"
    || ticket.resumeNativeSessionId !== intent.nativeSessionId || ticket.cwd !== record.definition?.resolvedConfiguration.cwd) throw new Error("Bot migration ticket differs from the original execution identity.");
};

/** The caller owns the original Worker lock; this operation never stops a process or obtains a new execution grant. */
export const migrateLegacyBot = async (options: BotMigrationOptions): Promise<BotMigrationManifest> => {
  const owner = parseBotOwner(options.owner), botId = botUUID(options.botId, "Bot ID"), target = { stateDirectory: options.stateDirectory, owner, botId };
  const paths = resolveBotPaths(options.stateDirectory, botId), signal = options.signal ?? AbortSignal.timeout(120_000);
  signal.throwIfAborted();
  if (options.legacyDatabaseFile !== path.join(options.stateDirectory, "worker", "state.sqlite")) throw new Error("Bot migration requires the original Worker database path.");
  assertMigrationPhysicalPath(options.stateDirectory, "directory");
  ensureDurableDirectory(path.dirname(paths.directory)); ensureDurableDirectory(paths.directory);
  assertMigrationPhysicalPath(paths.directory, "directory");
  for (const file of [paths.lockFile, paths.ownershipGateFile]) if (existsSync(file)) assertMigrationPhysicalPath(file, "file");
  const lock = acquireInstanceLockSync(paths.lockFile, paths.ownershipGateFile);
  let db: Database.Database | undefined, controllerPermit: ControllerStoragePermit | undefined;
  try {
    let manifest = readBotMigrationManifest(options.stateDirectory, owner, botId);
    if (manifest?.phase === "committed") {
      verifyMigrationFiles(options.stateDirectory, manifest); verifyDedicatedStore(target, manifest);
      if (existsSync(options.legacyDatabaseFile)) {
        assertMigrationPhysicalPath(options.legacyDatabaseFile, "file");
        for (const suffix of ["-wal", "-shm"]) if (existsSync(`${options.legacyDatabaseFile}${suffix}`)) assertMigrationPhysicalPath(`${options.legacyDatabaseFile}${suffix}`, "file");
        const source = new Database(sqliteFilename(options.legacyDatabaseFile), { readonly: true, fileMustExist: true });
        try {
          const format = inspectSqlite(source, workerStoreFormat);
          if (!(format.kind === "current" || format.kind === "outdated" && format.version >= 19)
            || receipt(source, target) !== botMigrationHash(manifest)
            || source.prepare("SELECT 1 FROM bots WHERE bot_id=? UNION ALL SELECT 1 FROM bot_executions WHERE bot_id=? LIMIT 1").get(botId, botId) !== undefined) throw new Error("Committed Bot migration conflicts with the retained original Worker authority or receipt.");
        } finally { source.close(); }
      }
      return manifest;
    }
    assertMigrationPhysicalPath(options.legacyDatabaseFile, "file");
    for (const suffix of ["-wal", "-shm"]) if (existsSync(`${options.legacyDatabaseFile}${suffix}`)) assertMigrationPhysicalPath(`${options.legacyDatabaseFile}${suffix}`, "file");
    db = openSqliteDatabase({ file: options.legacyDatabaseFile, format: workerStoreFormat, allowCreate: false });
    const savedReceipt = receipt(db, target);
    if (savedReceipt !== null) {
      if (manifest === null || manifest.phase !== "verified" || botMigrationHash(manifest) !== savedReceipt) throw new Error("Bot migration commit receipt has no matching verified manifest.");
      if (db.prepare("SELECT 1 FROM bots WHERE bot_id=? UNION ALL SELECT 1 FROM bot_executions WHERE bot_id=? LIMIT 1").get(botId, botId) !== undefined) throw new Error("Bot migration commit receipt conflicts with restored legacy authority.");
      verifyMigrationFiles(options.stateDirectory, manifest); verifyDedicatedStore(target, manifest);
      manifest = { ...manifest, phase: "committed" }; saveMigrationManifest(botMigrationManifestPath(options.stateDirectory, botId), manifest); options.onPhase?.("committed"); return manifest;
    }
    if (manifest !== null) assertSource(db, manifest);
    const stores = openBotStore(options.legacyDatabaseFile), executions = openBotExecutionStore(options.legacyDatabaseFile);
    let record: BotRecord, execution: BotExecution | null;
    try {
      const observed = stores.get(owner, botId); if (observed === null) throw new Error("Original Bot storage for this service, account and Worker is unavailable.");
      record = observed; execution = record.intent === null ? null : executions.get(record);
    } finally { executions.close(); stores.close(); }
    if (record.migration !== undefined || record.cleanup !== undefined || record.observed.deletion !== null) throw new Error("Bot migration cannot replace an existing migration or deletion responsibility.");
    const intent = record.intent;
    let ticket: ControllerLaunchTicket | null = null, snapshot: ControllerSnapshot | null = null;
    if (intent !== null) {
      if (resolveBotControllerStateDirectory(options.homeDirectory, record) !== undefined) throw new Error("Bot already uses dedicated Controller storage.");
      if (existsSync(intent.ticketPath)) { const originalTicket = await readLaunchTicket(options.homeDirectory, intent.launchId); verifyTicket(record, originalTicket); ticket = originalTicket; }
      if (existsSync(intent.journalPath)) {
        assertMigrationPhysicalPath(path.dirname(intent.journalPath), "directory");
        controllerPermit = acquireControllerStoragePermit(intent.journalPath, Date.now() + 10_000, { fileMustExist: true });
        if (ticket === null) throw new Error("Bot migration journal has no original launch ticket.");
        snapshot = readCompatibleControllerSnapshot(intent.journalPath, ticket);
        validateBotExecutionSnapshot(record, snapshot);
      }
      if (execution !== null && execution.launchSubmission !== "not-submitted") {
        if (ticket === null || snapshot === null || snapshot.lifecycle !== "stopped" || !snapshot.nativeStopped || snapshot.stoppedAt === null
          || snapshot.controllerProcess === null || execution.controllerProcess === null
          || !preservesControllerProcessProof(execution.controllerProcess, snapshot.controllerProcess, intent.launchId)
          || !preservesNativeProcessPrefix(execution.snapshot?.nativeProcesses ?? [], snapshot.nativeProcesses)
          || execution.snapshot?.nativeSessionId != null && snapshot.nativeSessionId !== execution.snapshot.nativeSessionId) throw new Error("Bot migration requires complete original process stop evidence.");
        const historical = isLinuxControllerLaunch(snapshot.controllerProcess) ? readHistoricalStoppedControllerGeneration(intent.journalPath, ticket, Date.now() + 10_000) : null;
        if (historical !== null && controllerPayloadHash(historical) !== controllerPayloadHash(snapshot)) throw new Error("Bot migration stopped boundary conflicts with its original journal.");
        if (historical !== null) { /* The ticket-bound stop has already settled the process boundary. */ }
        else if (options.confirmStopped !== undefined) await options.confirmStopped(ticket, snapshot, signal);
        else if (process.platform === "win32") validateWindowsControllerStopProof(snapshot, ticket, controllerPayloadHash(ticket));
        else if (!await confirmControllerProcessesStopped(snapshot.controllerProcess, snapshot.nativeProcesses, Date.now() + 10_000)) throw new Error("Bot original process tree is not proven stopped.");
      } else if (snapshot !== null || execution?.controllerProcess != null || execution?.snapshot != null || execution === null && ticket !== null || intent.nativeSessionId !== null || intent.executionGeneration !== "1") {
        throw new Error("Bot migration cannot infer an unsubmitted execution from incomplete process evidence.");
      }
    } else if (record.definition?.sessionId != null || record.definition?.testExecutionId != null) throw new Error("Bound Bot migration requires its original execution intent.");
    const aliases = botMigrationAliases(options.stateDirectory, botId, execution);
    signal.throwIfAborted();
    if (manifest === null) {
      if (existsSync(paths.databaseFile) || existsSync(path.join(paths.directory, "legacy"))) throw new Error("Bot migration destination already has unowned storage.");
      manifest = { schemaVersion: 1, owner, botId, phase: "prepared", sourceDatabase: options.legacyDatabaseFile,
        sourceRecordHash: controllerPayloadHash(record), sourceExecutionHash: controllerPayloadHash(execution), original: { record, execution }, files: [], journal: null, ticket: null,
        registration: "pending", nativeRecovery: snapshot?.nativeSessionId == null || ticket === null || !existsSync(ticket.nativeHome) ? "missing" : "unverified" };
      saveMigrationManifest(botMigrationManifestPath(options.stateDirectory, botId), manifest); options.onPhase?.("prepared");
    }
    if (manifest.phase === "prepared") {
      const files = [] as BotMigrationManifest["files"];
      let copiedJournal: string | null = null, copiedTicket: string | null = null;
      if (intent !== null) {
        const directory = controllerExecutionDirectory(options.homeDirectory, intent.executionId);
        if (existsSync(directory)) files.push(...await copyMigrationTree(directory, `legacy/controller/executions/${intent.executionId}`, options.stateDirectory, botId, signal));
        if (snapshot !== null) copiedJournal = `legacy/controller/executions/${intent.executionId}/journal.sqlite`;
        for (const launchId of [intent.launchId, ...(execution?.retainedLaunchIds ?? [])]) {
          const source = controllerTicketPath(options.homeDirectory, launchId);
          if (!existsSync(source)) { if (launchId !== intent.launchId) throw new Error("Retained Bot launch ticket is missing."); continue; }
          const historical = await readLaunchTicket(options.homeDirectory, launchId);
          if (historical.executionId !== intent.executionId || historical.testExecutionId !== intent.executionId || historical.sessionId !== intent.sessionId || historical.serverOrigin !== owner.serverOrigin || historical.ownerUserId !== owner.ownerUserId) throw new Error("Retained Bot ticket belongs to another execution.");
          const destination = `legacy/controller/launches/${launchId}.json`;
          files.push({ source, destination, kind: "file", ...await copyMigrationFile(source, migrationDestination(options.stateDirectory, botId, destination), "file", signal) });
          if (launchId === intent.launchId) copiedTicket = destination;
        }
        for (const alias of aliases) {
          files.push(...await copyMigrationTree(alias.source, alias.destination, options.stateDirectory, botId, signal));
        }
      }
      copyDedicatedStore(target, manifest);
      manifest = { ...manifest, phase: "copied", files, journal: copiedJournal, ticket: copiedTicket };
      saveMigrationManifest(botMigrationManifestPath(options.stateDirectory, botId), manifest); options.onPhase?.("copied");
    }
    verifyMigrationFiles(options.stateDirectory, manifest); verifyDedicatedStore(target, manifest);
    await verifyMigrationSources(options.stateDirectory, manifest, signal);
    assertSource(db, manifest); signal.throwIfAborted();
    if (manifest.phase === "copied") { manifest = { ...manifest, phase: "verified" }; saveMigrationManifest(botMigrationManifestPath(options.stateDirectory, botId), manifest); options.onPhase?.("verified"); }
    const verified = manifest;
    db.transaction(() => {
      assertSource(db!, verified);
      if (receipt(db!, target) !== null) throw new Error("Bot migration authority changed before commit.");
      db!.prepare(`INSERT INTO bot_migrations VALUES(@serverOrigin,@ownerUserId,@workerId,@botId,@hash)`).run({ ...params(target), hash: botMigrationHash(verified) });
      db!.prepare(`DELETE FROM bot_executions WHERE ${predicate}`).run(params(target));
      const removed = db!.prepare(`DELETE FROM bots WHERE ${predicate}`).run(params(target));
      if (removed.changes !== 1) throw new Error("Original Bot authority was not removed.");
    }).immediate();
    manifest = { ...manifest, phase: "committed" }; saveMigrationManifest(botMigrationManifestPath(options.stateDirectory, botId), manifest); options.onPhase?.("committed");
    return manifest;
  } finally { db?.close(); controllerPermit?.release(); lock.release(); }
};

/** Recover only the original binding; copied history never requires a live Session read. */
export const readMigratedBotRecoveryBinding = (options: Target): BotRecoveryBinding => {
  const manifest = readBotMigrationManifest(options.stateDirectory, options.owner, options.botId);
  if (manifest?.phase !== "committed") throw new Error("Bot recovery binding requires its committed migration authority.");
  verifyMigrationFiles(options.stateDirectory, manifest);
  const record = manifest.original.record, intent = record.intent, execution = manifest.original.execution;
  if (intent === null || intent.sessionId === null || record.definition === null
    || record.definition.sessionId !== intent.sessionId || record.definition.testExecutionId !== intent.executionId
    || intent.registration.testExecutionId !== intent.executionId) throw new Error("Migrated Bot recovery requires its original registered Session binding.");
  parseBot(record.observed, options.owner); parseBot(record.definition, options.owner);
  botUUID(intent.sessionId, "Migrated Bot Session"); botUUID(intent.executionId, "Migrated Bot execution");
  if (execution !== null && (execution.launchId !== intent.launchId || execution.executionId !== intent.executionId
    || execution.executionGeneration !== intent.executionGeneration)) throw new Error("Migrated Bot execution differs from its original launch intent.");
  let ticket: ControllerLaunchTicket | null = null;
  if (manifest.ticket !== null) {
    if (!manifest.files.some(file => file.destination === manifest.ticket && file.source === intent.ticketPath && file.kind === "file")) throw new Error("Migrated Bot ticket has no verified copy mapping.");
    const copiedTicket = parseLaunchTicket(JSON.parse(readFileSync(migrationDestination(options.stateDirectory, options.botId, manifest.ticket), "utf8")));
    verifyTicket(record, copiedTicket);
    ticket = copiedTicket;
  }
  if (manifest.journal === null) {
    if (execution === null || execution.launchSubmission !== "not-submitted" || execution.controllerProcess !== null || execution.snapshot !== null
      || intent.nativeSessionId !== null || intent.executionGeneration !== "1") throw new Error("Migrated Bot without a journal has no proven unsubmitted execution.");
    return { sessionId: intent.sessionId, testExecutionId: intent.executionId, nativeSessionId: null };
  }
  if (ticket === null || !manifest.files.some(file => file.destination === manifest.journal && file.source === intent.journalPath && file.kind === "sqlite")) throw new Error("Migrated Bot journal has no verified original ticket or copy mapping.");
  const snapshot = readCompatibleControllerSnapshot(migrationDestination(options.stateDirectory, options.botId, manifest.journal), ticket);
  validateBotExecutionSnapshot(record, snapshot);
  if (execution === null || execution.launchSubmission === "not-submitted" || snapshot.lifecycle !== "stopped" || !snapshot.nativeStopped
    || snapshot.stoppedAt === null || snapshot.controllerProcess === null || execution.controllerProcess === null
    || !preservesControllerProcessProof(execution.controllerProcess, snapshot.controllerProcess, intent.launchId)
    || !preservesNativeProcessPrefix(execution.snapshot?.nativeProcesses ?? [], snapshot.nativeProcesses)
    || execution.snapshot?.nativeSessionId != null && execution.snapshot.nativeSessionId !== snapshot.nativeSessionId) throw new Error("Migrated Bot recovery binding conflicts with its original stopped execution.");
  return { sessionId: intent.sessionId, testExecutionId: intent.executionId, nativeSessionId: snapshot.nativeSessionId };
};

/** Read the protected copy without starting a Controller, obtaining a grant or touching native history. */
export const readMigratedBotHistory = (options: Target & { query?: TimelinePageQuery }) => {
  const manifest = readBotMigrationManifest(options.stateDirectory, options.owner, options.botId);
  if (manifest?.phase !== "committed") throw new Error("Bot migration history requires its committed local authority.");
  verifyMigrationFiles(options.stateDirectory, manifest);
  if (manifest.journal === null || manifest.ticket === null) return { manifest, snapshot: null, entries: [] };
  const file = migrationDestination(options.stateDirectory, options.botId, manifest.journal);
  const ticket = parseLaunchTicket(JSON.parse(readFileSync(migrationDestination(options.stateDirectory, options.botId, manifest.ticket), "utf8")));
  verifyTicket(manifest.original.record, ticket);
  const snapshot = readCompatibleControllerSnapshot(file, ticket);
  const db = new Database(sqliteFilename(file), { readonly: true, fileMustExist: true });
  try {
    const entries = db.transaction(() => {
      inspectReadCompatibleControllerJournal(db);
      return openTimelineStore(db, { assertWrite: () => { throw new Error("Migrated Bot history is read-only."); } }).page(options.query ?? { direction: "tail", pivot: null, limit: 50 });
    }).deferred();
    return { manifest, snapshot, entries };
  } finally { db.close(); }
};
