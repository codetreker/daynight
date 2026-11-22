import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { openSqliteDatabase, closeSqliteDatabase, type SqliteMigrationReporter } from "../../../platform/sqlite-access.js";
import { sqliteFilename } from "../../../platform/sqlite-filename.js";
import { inspectSqlite } from "../../../platform/sqlite-format.js";
import { acquireInstanceLockSync } from "../../../platform/instance-lock.js";
import { canonicalId } from "../../../api/parse.js";
import { resolveBotPaths } from "./paths.js";
import { botStoreFormat } from "./store-format.js";
import { openBotStore, type BotStore } from "./store.js";
import { openBotExecutionStore, type BotExecutionStore } from "./execution-store.js";
import { parseBot, parseBotOwner, type BotOwner, type BotRecord } from "./types.js";
import { botMigrationHash, readBotMigrationManifest } from "./migration-state.js";

type LocalIdentity = { server_origin: string; owner_user_id: string; bot_id: string; worker_id?: string };
type Stores = { owner: BotOwner; store: BotStore; executions: BotExecutionStore; storeClosed: boolean; executionsClosed: boolean; assertLocked(): void; release(): void };
const physicalDirectory = (directory: string): void => {
  const entry = lstatSync(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(directory) !== directory
    || process.platform !== "win32" && (entry.uid !== process.getuid!() || (entry.mode & 0o077) !== 0)) throw new Error("Bot storage requires a private physical directory owned by the current operating-system user.");
};
const regularFile = (file: string): void => {
  let entry;
  try { entry = lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!entry.isFile() || entry.isSymbolicLink() || process.platform !== "win32" && entry.uid !== process.getuid!()) throw new Error("Bot storage files must be owned regular files without symbolic links.");
};
const sameAccount = (identity: LocalIdentity, owner: BotOwner) => identity.server_origin === owner.serverOrigin && identity.owner_user_id === owner.ownerUserId;

/** Each Bot lock outlives both database connections and all users of their records. */
export const openLocalBotStores = (options: { stateDirectory: string; legacyDatabaseFile: string; owner: BotOwner; onMigration?: SqliteMigrationReporter }) => {
  const owner = parseBotOwner(options.owner), opened = new Map<string, Stores>();
  const migration = options.onMigration === undefined ? {} : { onMigration: options.onMigration };
  const legacyStore = existsSync(options.legacyDatabaseFile) ? openBotStore(options.legacyDatabaseFile, migration) : undefined;
  let legacyExecutions: BotExecutionStore | undefined;
  try { if (legacyStore !== undefined) legacyExecutions = openBotExecutionStore(options.legacyDatabaseFile, migration); }
  catch (error) {
    try { legacyStore?.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Legacy Bot storage initialization and cleanup failed."); }
    throw error;
  }
  let closed = false, closing = false, legacyStoreClosed = false, legacyExecutionsClosed = false;
  const assertOwner = (value: BotOwner) => {
    if (closed || closing) throw new Error("Bot storage has closed or is closing.");
    const checked = parseBotOwner(value);
    if (checked.serverOrigin !== owner.serverOrigin || checked.ownerUserId !== owner.ownerUserId) throw new Error("Bot storage requires its original service and account.");
  };
  const localIdentity = (botId: string): LocalIdentity | null => {
    const paths = resolveBotPaths(options.stateDirectory, botId);
    for (const file of [paths.databaseFile, `${paths.databaseFile}-wal`, `${paths.databaseFile}-shm`]) regularFile(file);
    if (!existsSync(paths.databaseFile)) return null;
    physicalDirectory(paths.directory);
    const db = new Database(sqliteFilename(paths.databaseFile), { readonly: true, fileMustExist: true });
    try {
      if (inspectSqlite(db, botStoreFormat).kind === "empty") return null;
      const identity = db.prepare("SELECT server_origin, owner_user_id, bot_id FROM bot_identity WHERE singleton = 1").get() as LocalIdentity | undefined;
      if (identity === undefined) {
        botStoreFormat.validateVersioned(db, db.pragma("user_version", { simple: true }) as number);
        if (db.prepare("SELECT 1 FROM bots UNION ALL SELECT 1 FROM bot_executions LIMIT 1").get() !== undefined) throw new Error("Bot storage has lost its durable service/account identity.");
        return null;
      }
      if (identity.bot_id !== botId) throw new Error("Bot storage has lost its durable service/account identity.");
      const workers = db.prepare("SELECT worker_id FROM bots UNION SELECT worker_id FROM bot_executions").all() as { worker_id: string }[];
      if (workers.length > 1) throw new Error("Bot storage retains inconsistent original Worker bindings.");
      return { ...identity, ...(workers[0] === undefined ? {} : { worker_id: workers[0].worker_id }) };
    } finally { db.close(); }
  };
  const local = (botId: string, create: boolean): Stores | null => {
    assertOwner(owner);
    const cached = opened.get(botId); if (cached !== undefined) return cached;
    const paths = resolveBotPaths(options.stateDirectory, botId);
    const identity = localIdentity(botId);
    if (identity !== null && !sameAccount(identity, owner)) throw new Error("Bot directory belongs to another service or account.");
    if (identity === null && !create) return null;
    const originalOwner = parseBotOwner({ ...owner, workerId: identity?.worker_id ?? owner.workerId });
    mkdirSync(path.dirname(paths.directory), { recursive: true, mode: 0o700 });
    physicalDirectory(path.dirname(paths.directory));
    mkdirSync(paths.directory, { mode: 0o700, recursive: true }); physicalDirectory(paths.directory);
    for (const file of [paths.databaseFile, `${paths.databaseFile}-wal`, `${paths.databaseFile}-shm`, paths.lockFile, paths.ownershipGateFile, `${paths.ownershipGateFile}-wal`, `${paths.ownershipGateFile}-shm`, `${paths.ownershipGateFile}-journal`]) regularFile(file);
    const lock = acquireInstanceLockSync(paths.lockFile, paths.ownershipGateFile);
    let store: BotStore | undefined, executions: BotExecutionStore | undefined;
    try {
      const identityFormat = { ...botStoreFormat, baseline: { ...botStoreFormat.baseline, create: (db: Database.Database): undefined => {
        botStoreFormat.baseline.create(db);
        db.prepare("INSERT INTO bot_identity VALUES (1, ?, ?, ?)").run(owner.serverOrigin, owner.ownerUserId, botId);
      } } };
      const db = openSqliteDatabase({ file: paths.databaseFile, format: identityFormat, allowCreate: true, ...migration,
        assertMigrationAllowed: (_db, source) => { if (source.kind === "unversioned") throw new Error("Unversioned Bot data cannot be reset; explicit migration is required."); } });
      try {
        db.transaction(() => {
          const saved = db.prepare("SELECT server_origin, owner_user_id, bot_id FROM bot_identity WHERE singleton = 1").get() as LocalIdentity | undefined;
          if (saved !== undefined && (!sameAccount(saved, owner) || saved.bot_id !== botId)) throw new Error("Bot directory identity changed before storage acquisition.");
          if (saved === undefined) {
            if (db.prepare("SELECT 1 FROM bots UNION ALL SELECT 1 FROM bot_executions LIMIT 1").get() !== undefined) throw new Error("Bot records have no durable owner identity.");
            db.prepare("INSERT INTO bot_identity VALUES (1, ?, ?, ?)").run(owner.serverOrigin, owner.ownerUserId, botId);
          }
          for (const table of ["bots", "bot_executions"]) {
            const other = db.prepare(`SELECT 1 FROM ${table} WHERE server_origin <> ? OR owner_user_id <> ? OR bot_id <> ? OR worker_id <> ? LIMIT 1`).get(owner.serverOrigin, owner.ownerUserId, botId, originalOwner.workerId);
            if (other !== undefined) throw new Error("Bot storage identity changed before storage acquisition.");
          }
        }).immediate();
      } finally { closeSqliteDatabase(db, { file: paths.databaseFile, format: botStoreFormat }); }
      store = openBotStore(paths.databaseFile, { ...migration, format: botStoreFormat, storageStateDirectory: paths.controllerStateDirectory });
      executions = openBotExecutionStore(paths.databaseFile, { ...migration, format: botStoreFormat });
      const assertLocked = (): void => {
        if (JSON.parse(readFileSync(paths.lockFile, "utf8")).owner !== lock.owner) throw new Error("Bot storage no longer holds its original instance lock.");
      };
      const stores = { owner: originalOwner, store, executions, storeClosed: false, executionsClosed: false, assertLocked, release: lock.release };
      opened.set(botId, stores); return stores;
    } catch (error) {
      const failures = [error];
      let connectionsClosed = true;
      try { executions?.close(); } catch (failure) { failures.push(failure); connectionsClosed = false; }
      try { store?.close(); } catch (failure) { failures.push(failure); connectionsClosed = false; }
      if (connectionsClosed) try { lock.release(); } catch (failure) { failures.push(failure); }
      if (failures.length > 1) throw new AggregateError(failures, "Bot storage initialization and cleanup failed.");
      throw error;
    }
  };
  const selected = (value: BotOwner, botId: string, create = false): Pick<Stores, "owner" | "store" | "executions"> | null => {
    assertOwner(value);
    const held = opened.get(botId), identity = held === undefined ? localIdentity(botId) : null;
    const originalOwner = held?.owner ?? (identity?.worker_id === undefined ? value : parseBotOwner({ ...value, workerId: identity.worker_id }));
    if (value.workerId !== owner.workerId && value.workerId !== originalOwner.workerId) throw new Error("Bot storage requires the current or original Worker identity.");
    const manifest = readBotMigrationManifest(options.stateDirectory, originalOwner, botId);
    if (manifest !== null && manifest.phase !== "committed") throw new Error("Bot migration is incomplete; run worker migrate-bot for the original Bot before any storage writes.");
    if (legacyStore !== undefined) {
      const db = new Database(sqliteFilename(options.legacyDatabaseFile), { readonly: true, fileMustExist: true });
      try {
        const receipt = db.prepare("SELECT manifest_hash FROM bot_migrations WHERE bot_id = ?").get(botId) as { manifest_hash: string } | undefined;
        if (receipt !== undefined && (manifest === null || receipt.manifest_hash !== botMigrationHash(manifest))) throw new Error("Bot migration source receipt requires its original committed manifest.");
      } finally { db.close(); }
    }
    const original = legacyStore?.get(value, botId);
    if (original != null) {
      if (value.workerId !== owner.workerId) throw new Error("Legacy Bot storage requires its original Worker; explicit migration is required.");
      if (localIdentity(botId) !== null) throw new Error("Bot has both legacy and dedicated storage; migration must establish one authoritative location.");
      return { owner: value, store: legacyStore!, executions: legacyExecutions! };
    }
    if (legacyStore !== undefined) {
      const db = new Database(sqliteFilename(options.legacyDatabaseFile), { readonly: true, fileMustExist: true });
      try {
        if (db.prepare("SELECT 1 FROM bots WHERE bot_id = ? LIMIT 1").get(botId) !== undefined) throw new Error("Bot retains a legacy service/account/Worker binding; explicit migration or takeover is required.");
      } finally { db.close(); }
    }
    const result = local(botId, create);
    result?.assertLocked();
    const migrated = result?.store.get(result.owner, botId)?.migration;
    if (migrated !== undefined && manifest === null || manifest !== null && (result === null || migrated?.state !== "registration_pending")) throw new Error("Bot migration storage has lost its authority fence.");
    return result;
  };
  const required = (record: BotRecord) => {
    const stores = selected(record.owner, record.botId);
    if (stores === null) throw new Error("Bot storage has no original record.");
    return stores;
  };
  const close = (): void => {
    if (closed) return;
    closing = true;
    const failures: unknown[] = [];
    for (const [botId, stores] of opened) {
      if (!stores.executionsClosed) try { stores.executions.close(); stores.executionsClosed = true; } catch (error) { failures.push(error); }
      if (!stores.storeClosed) try { stores.store.close(); stores.storeClosed = true; } catch (error) { failures.push(error); }
      if (stores.executionsClosed && stores.storeClosed) { try { stores.release(); opened.delete(botId); } catch (error) { failures.push(error); } }
    }
    if (!legacyExecutionsClosed) try { legacyExecutions?.close(); legacyExecutionsClosed = true; } catch (error) { failures.push(error); }
    if (!legacyStoreClosed) try { legacyStore?.close(); legacyStoreClosed = true; } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Bot storage shutdown failed; unconfirmed locks are retained.");
    closed = true;
  };
  const scan = (value: BotOwner = owner): { records: BotRecord[]; errors: { botId: string; message: string }[] } => {
      assertOwner(value);
      const records = legacyStore?.list(value) ?? [], root = path.join(options.stateDirectory, "bots");
      const errors: { botId: string; message: string }[] = [];
      for (const record of records) selected(value, record.botId);
      if (!existsSync(root)) return { records, errors };
      physicalDirectory(root);
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (canonicalId(entry.name) !== entry.name || entry.name === "00000000-0000-0000-0000-000000000000") continue;
        try {
          const identity = localIdentity(entry.name);
          if (identity === null || !sameAccount(identity, owner)) continue;
          if (records.some(record => record.botId === entry.name)) throw new Error("Bot has both legacy and dedicated storage; explicit migration is required.");
          const selectedStore = selected(value, entry.name)!;
          const record = selectedStore.store.get(selectedStore.owner, entry.name);
          if (record !== null) records.push(record);
        } catch (cause) {
          errors.push({ botId: entry.name, message: cause instanceof Error ? cause.message : "Bot storage discovery failed." });
        }
      }
      return { records: records.sort((left, right) => left.botId.localeCompare(right.botId)), errors };
  };
  const store: BotStore = {
    close,
    get: (value, botId) => { const selectedStore = selected(value, botId); return selectedStore?.store.get(selectedStore.owner, botId) ?? null; },
    list: value => scan(value).records,
    observe: (value, bot, observedAt) => {
      parseBot(bot, value);
      const existing = selected(value, bot.id);
      if (existing !== null && existing.owner.workerId !== value.workerId) throw new Error("Bot observations must preserve their original Worker binding.");
      if (existing === null && value.workerId !== owner.workerId) throw new Error("Only the current Worker may initialize Bot storage.");
      if (existing === null && bot.deletion === null && (bot.sessionId !== null || bot.testExecutionId !== null)) throw new Error("An existing bound Bot requires its original storage or explicit migration.");
      return (existing ?? selected(value, bot.id, true)!).store.observe(value, bot, observedAt);
    },
    prepare: (value, botId, input) => selected(value, botId)!.store.prepare(value, botId, input),
    freezeRole: (value, botId, role) => selected(value, botId)!.store.freezeRole(value, botId, role),
    freezeToolLaunch: (record, launch, observation) => required(record).store.freezeToolLaunch(record, launch, observation),
    prepareDeletion: (record, stop, targets) => required(record).store.prepareDeletion(record, stop, targets),
    completeDeletionTarget: (record, file) => required(record).store.completeDeletionTarget(record, file),
    finishDeletion: record => required(record).store.finishDeletion(record),
  };
  const executions: BotExecutionStore = {
    close: () => {},
    get: record => required(record).executions.get(record),
    prepare: record => required(record).executions.prepare(record),
    update: (record, patch) => required(record).executions.update(record, patch),
    markShutdown: (record, eligible) => required(record).executions.markShutdown(record, eligible),
    resumeObserved: record => required(record).executions.resumeObserved(record),
    blockRecovery: (record, reason) => required(record).executions.blockRecovery(record, reason),
    replaceUnsubmittedLaunch: (record, launchId, home) => required(record).executions.replaceUnsubmittedLaunch(record, launchId, home),
    beginRecovery: (record, stopped, home, launch) => required(record).executions.beginRecovery(record, stopped, home, launch),
  };
  const assertLocked = (record: BotRecord): void => {
    assertOwner(record.owner);
    const selectedStore = selected(record.owner, record.botId);
    const held = opened.get(record.botId);
    if (selectedStore === null || held === undefined || held.owner.workerId !== record.owner.workerId) throw new Error("Bot recovery requires its dedicated storage and original instance lock.");
    held.assertLocked();
  };
  const isDedicated = (record: BotRecord): boolean => {
    assertOwner(record.owner);
    selected(record.owner, record.botId);
    return opened.has(record.botId);
  };
  return { store, executions, close, assertLocked, isDedicated, scan };
};
