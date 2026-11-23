import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { openSqliteDatabase, runSqliteImmediate, closeSqliteDatabase } from "../../platform/sqlite-access.js";
import { assertCurrentSqlite, inspectSqlite, type SqliteFormat } from "../../platform/sqlite-format.js";
import { loadSqliteSequence, sqliteSchemaSnapshots, type SqliteSchemaObject } from "../../platform/sqlite-sql.js";
import type { ExecutionOwnerKind, OwnerStopResult } from "./execution-scope.js";
import type { ClaimIdentity } from "./types.js";

/** A definite rejection before any resource reservation write has begun. */
export class LifecycleAdmissionError extends Error {
  constructor(message = "Worker lifecycle execution admission is closed.") { super(message); }
}

export type LifecycleJson = null | boolean | number | string | LifecycleJson[] | { [key: string]: LifecycleJson };
export type LifecycleIdentity = { serverOrigin: string; userId: string; workerId: string };
export type LifecycleBinding = LifecycleIdentity & { instanceId: string; instanceEpoch: string; localEpoch: string; intentVersion: string; scopeGeneration: string };
export type LifecycleStage = "reserved" | "running" | "stopped" | "not_dispatched" | "confirmed" | "unknown";
export type LifecycleOperation = {
  phase: "primary" | "activation";
  operationId: string; originOperationId: string | null; localEpoch: string; kind: string;
  status: "prepared" | "submitted" | "unknown" | "confirmed" | "rejected";
  request: LifecycleJson | null; requestHash: string | null; receipt: LifecycleJson | null;
};
export type LifecycleResource = {
  resourceId: string; ownerKind: ExecutionOwnerKind; identity: { [key: string]: LifecycleJson };
  instanceId: string; instanceEpoch: string; scopeGeneration: string; operationId: string;
  stage: LifecycleStage; processProof: LifecycleJson | null; stopProof: LifecycleJson | null;
  saveState: "pending" | "durable" | "failed"; error: string | null;
};
export type LifecycleActivation = { binding: LifecycleBinding; operationId: string; action: "resume" | "bootstrap" | "reconnect" };
export type LifecycleState = LifecycleIdentity & {
  formatVersion: 1; localEpoch: string; localVeto: boolean; intentVersion: string | null;
  desired: "enabled" | "disabled" | null; admission: "open" | "closed";
  instanceId: string | null; instanceEpoch: string | null; scopeGeneration: string;
  phase: "accepting" | "disabling" | "disabled" | "blocked" | "resuming";
  operationId: string | null; inventoryRevision: string; inventoryComplete: boolean; bootstrapConsumed: boolean;
  stop: "not_started" | "stopping" | "confirmed" | "unknown";
  save: "pending" | "durable" | "failed"; sync: "pending" | "complete" | "failed"; errorCode: string | null;
  activation: LifecycleActivation | null;
  stopProof: LifecycleJson | null;
};
export type LifecycleOutbox = {
  id: string; instanceEpoch: string; intentVersion: string; reportSequence: string; payload: LifecycleJson; hash: string;
  uploadState: "pending" | "unknown" | "confirmed" | "covered" | "failed"; receipt: LifecycleJson | null;
};
export type LifecycleSnapshot = {
  state: LifecycleState; resources: LifecycleResource[]; detailsComplete: boolean; inventoryComplete: boolean;
  inventoryRevision: string; inventoryDigest: string;
  counts: { total: number; stopped: number; pending: number; blocked: number };
};

const steps = loadSqliteSequence(new URL("./lifecycle-sqlite/", import.meta.url));
const schema = sqliteSchemaSnapshots(steps).get(1)!;
export const lifecycleStoreFormat: SqliteFormat = {
  name: "Worker lifecycle", baseline: { version: 1, create: db => { db.exec(steps[0].sql); } }, migrations: [],
  validateVersioned: (db, version) => {
    const objects = db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as SqliteSchemaObject[];
    if (version !== 1 || JSON.stringify(objects) !== JSON.stringify(schema)) throw new Error("Worker lifecycle SQLite schema is invalid.");
  },
};
const invalid = (message: string): never => { throw new Error(`Worker lifecycle ${message}.`); };
const uuid = (value: unknown): string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) && value !== "00000000-0000-0000-0000-000000000000" ? value : invalid("identity must be a canonical nonzero UUID");
const serial = (value: unknown): string => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n ? value : invalid("sequence must be a positive int64 string");
const next = (value: string): string => serial(String(BigInt(value) + 1n));
const integer = (value: unknown): string => typeof value === "bigint" ? serial(String(value)) : invalid("stored sequence is not an exact integer");
const boolean = (value: unknown): boolean => value === 0n ? false : value === 1n ? true : invalid("stored boolean is invalid");
const text = (value: unknown): string => typeof value === "string" && value.length > 0 && !value.includes("\0") ? value : invalid("text is invalid");
const choice = <T extends string>(value: unknown, values: readonly T[]): T => typeof value === "string" && values.includes(value as T) ? value as T : invalid("stored enum is invalid");
const optional = <T>(value: unknown, parse: (value: unknown) => T): T | null => value === null ? null : parse(value);
const identityValue = (value: LifecycleIdentity): LifecycleIdentity => {
  if (new URL(value.serverOrigin).origin !== value.serverOrigin || !/^https?:$/.test(new URL(value.serverOrigin).protocol)) invalid("service origin is not canonical");
  return { serverOrigin: value.serverOrigin, userId: uuid(value.userId), workerId: uuid(value.workerId) };
};
const bindingValue = (value: LifecycleBinding): LifecycleBinding => ({ ...identityValue(value), instanceId: uuid(value.instanceId), instanceEpoch: serial(value.instanceEpoch), localEpoch: serial(value.localEpoch), intentVersion: serial(value.intentVersion), scopeGeneration: serial(value.scopeGeneration) });
const jsonValue = (value: unknown, depth = 0): LifecycleJson => {
  if (depth > 64) invalid("JSON nesting exceeds its bound");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  if (Array.isArray(value)) return value.map(item => jsonValue(item, depth + 1));
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, jsonValue((value as Record<string, unknown>)[key], depth + 1)]));
  }
  return invalid("JSON contains an unsupported value");
};
const encode = (value: unknown): string => {
  return JSON.stringify(jsonValue(value));
};
const decode = (value: unknown): LifecycleJson => {
  const raw = text(value), parsed = jsonValue(JSON.parse(raw));
  if (encode(parsed) !== raw) invalid("stored JSON is not canonical");
  return parsed;
};
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const objectValue = (value: unknown): { [key: string]: LifecycleJson } => {
  const parsed = jsonValue(value);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object" || Object.keys(parsed).length === 0) return invalid("resource identity must be a nonempty JSON object");
  return parsed;
};
const parseActivation = (value: unknown): LifecycleActivation => {
  const parsed = objectValue(value);
  if (Object.keys(parsed).sort().join() !== "action,binding,operationId") return invalid("activation has invalid fields");
  const binding = objectValue(parsed.binding);
  if (Object.keys(binding).sort().join() !== "instanceEpoch,instanceId,intentVersion,localEpoch,scopeGeneration,serverOrigin,userId,workerId") invalid("activation binding has invalid fields");
  return { binding: bindingValue(binding as LifecycleBinding), operationId: uuid(parsed.operationId), action: choice(parsed.action, ["resume", "bootstrap", "reconnect"]) };
};
const stateValue = (row: Record<string, unknown> | undefined, expected: LifecycleIdentity): LifecycleState => {
  if (row === undefined) return invalid("authority row is missing");
  const identity = identityValue({ serverOrigin: text(row.server_origin), userId: uuid(row.user_id), workerId: uuid(row.worker_id) });
  if (encode(identity) !== encode(expected) || row.format_version !== 1n || row.singleton !== 1n) invalid("authority belongs to another identity or format");
  const state: LifecycleState = { ...identity, formatVersion: 1, localEpoch: integer(row.local_epoch), localVeto: boolean(row.local_veto),
    intentVersion: optional(row.intent_version, integer), desired: optional(row.desired, value => choice(value, ["enabled", "disabled"])),
    admission: choice(row.admission, ["open", "closed"]), instanceId: optional(row.instance_id, uuid), instanceEpoch: optional(row.instance_epoch, integer),
    scopeGeneration: integer(row.scope_generation), phase: choice(row.phase, ["accepting", "disabling", "disabled", "blocked", "resuming"]),
    operationId: optional(row.active_operation_id, uuid), inventoryRevision: integer(row.inventory_revision), inventoryComplete: boolean(row.inventory_complete),
    bootstrapConsumed: boolean(row.bootstrap_consumed), stop: choice(row.stop, ["not_started", "stopping", "confirmed", "unknown"]), save: choice(row.save, ["pending", "durable", "failed"]),
    sync: choice(row.sync, ["pending", "complete", "failed"]), errorCode: optional(row.error_code, text), activation: optional(row.activation_json, value => parseActivation(decode(value))), stopProof: optional(row.stop_proof_json, decode) };
  if ((state.instanceId === null) !== (state.instanceEpoch === null) || (state.desired === null) !== (state.intentVersion === null)
    || state.admission === "open" && (state.localVeto || state.desired !== "enabled" || state.instanceId === null || state.phase !== "accepting" || state.activation === null)
    || state.inventoryComplete && state.stopProof === null
    || state.phase === "disabled" && (state.admission !== "closed" || !state.inventoryComplete || state.stop !== "confirmed" || state.save !== "durable")) invalid("authority invariants are inconsistent");
  return state;
};
const resourceValue = (row: Record<string, unknown>): LifecycleResource => {
  const result: LifecycleResource = { resourceId: uuid(row.resource_id), ownerKind: choice(row.owner_kind, ["task", "bot", "assistant", "probe", "repository", "configuration", "controller"]),
    identity: objectValue(decode(row.identity_json)), instanceId: uuid(row.instance_id), instanceEpoch: integer(row.instance_epoch), scopeGeneration: integer(row.scope_generation),
    operationId: uuid(row.admission_operation_id), stage: choice(row.stage, ["reserved", "running", "stopped", "not_dispatched", "confirmed", "unknown"]),
    processProof: optional(row.process_proof_json, decode), stopProof: optional(row.stop_proof_json, decode), saveState: choice(row.save_state, ["pending", "durable", "failed"]), error: optional(row.last_error, text) };
  if (result.stage === "stopped" && result.stopProof === null || result.processProof !== null && ["confirmed", "not_dispatched"].includes(result.stage)) invalid("resource stop evidence is inconsistent");
  return result;
};
const terminal = (resource: LifecycleResource): boolean => ["stopped", "not_dispatched", "confirmed"].includes(resource.stage) && resource.saveState === "durable";
const historicalJson = (row: Record<string, unknown>): LifecycleJson => {
  if (!Buffer.isBuffer(row.payload)) return invalid("compressed history payload is invalid");
  const source = inflateRawSync(row.payload, { maxOutputLength: 256 * 1024 * 1024 }).toString("utf8");
  if (hash(source) !== row.content_hash) invalid("compressed history digest is invalid");
  return decode(source);
};
const historicalResource = (row: Record<string, unknown>): LifecycleResource => {
  const value = objectValue(historicalJson(row));
  if (Object.keys(value).sort().join() !== "error,identity,instanceEpoch,instanceId,operationId,ownerKind,processProof,resourceId,saveState,scopeGeneration,stage,stopProof" || row.resource_id !== value.resourceId) return invalid("compressed resource history has invalid fields");
  const resource = resourceValue({ resource_id: value.resourceId, owner_kind: value.ownerKind, identity_json: encode(value.identity), instance_id: value.instanceId,
    instance_epoch: BigInt(serial(value.instanceEpoch)), scope_generation: BigInt(serial(value.scopeGeneration)), admission_operation_id: value.operationId, stage: value.stage,
    process_proof_json: value.processProof === null ? null : encode(value.processProof), stop_proof_json: value.stopProof === null ? null : encode(value.stopProof), save_state: value.saveState, last_error: value.error });
  if (!terminal(resource)) invalid("compressed history contains unresolved resource responsibility");
  return resource;
};
const allResources = (db: Database.Database): LifecycleResource[] => {
  const live = (db.prepare("SELECT * FROM resource_owners ORDER BY resource_id").all() as Record<string, unknown>[]).map(resourceValue);
  const history = (db.prepare("SELECT * FROM resource_history ORDER BY resource_id").all() as Record<string, unknown>[]).map(historicalResource);
  const resources = [...live, ...history].sort((a, b) => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0);
  if (resources.some((resource, index) => index > 0 && resource.resourceId === resources[index - 1]!.resourceId)) invalid("resource exists in both live and compressed history");
  return resources;
};
const readState = (db: Database.Database, identity: LifecycleIdentity): LifecycleState => stateValue(db.prepare("SELECT * FROM lifecycle_state").get() as Record<string, unknown> | undefined, identity);
const snapshot = (db: Database.Database, identity: LifecycleIdentity, limit = 512, allDetails = false): LifecycleSnapshot => {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 512) invalid("detail limit must be between zero and 512");
  const state = readState(db, identity), resources = allResources(db).filter(resource => !terminal(resource) || BigInt(resource.scopeGeneration) >= BigInt(state.scopeGeneration)), stopped = resources.filter(terminal).length;
  const blocked = resources.filter(resource => resource.stage === "unknown" || resource.saveState === "failed").length;
  if (state.inventoryComplete && stopped !== resources.length) invalid("closed inventory contains unresolved responsibility");
  const digest = createHash("sha256").update("daynight.lifecycle.inventory.v1\n").update(encode({ identity, instanceId: state.instanceId, instanceEpoch: state.instanceEpoch, intentVersion: state.intentVersion, localEpoch: state.localEpoch, scopeGeneration: state.scopeGeneration, inventoryRevision: state.inventoryRevision })).update("\n");
  for (const resource of resources) digest.update(encode(resource)).update("\n");
  return { state, resources: allDetails ? resources : resources.slice(0, limit), detailsComplete: allDetails || resources.length <= limit, inventoryComplete: state.inventoryComplete,
    inventoryRevision: state.inventoryRevision, inventoryDigest: digest.digest("hex"), counts: { total: resources.length, stopped, pending: resources.length - stopped - blocked, blocked } };
};

/** A replaced authority must never remain usable through an already-open SQLite handle. */
const privateDirectory = (file: string): void => {
  if (!path.isAbsolute(file) || path.normalize(file) !== file) invalid("database location must be canonical and absolute");
  const parent = path.dirname(file), directory = lstatSync(parent);
  if (realpathSync(parent) !== parent || directory.isSymbolicLink() || !directory.isDirectory()) invalid("database requires a physical private directory");
  if (process.platform !== "win32" && (directory.uid !== process.getuid!() || (directory.mode & 0o077) !== 0)) invalid("database directory must be private to the current user");
};
const privateFile = (file: string): { dev: string; ino: string } => {
  privateDirectory(file);
  const info = lstatSync(file, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile()) invalid("database requires a regular physical file");
  if (process.platform !== "win32" && (info.uid !== BigInt(process.getuid!()) || (info.mode & 0o077n) !== 0n)) invalid("database permissions must be private to the current user");
  for (const suffix of ["-wal", "-shm"]) {
    try {
      const sidecar = lstatSync(file + suffix, { bigint: true });
      if (!sidecar.isFile() || sidecar.isSymbolicLink() || process.platform !== "win32" && (sidecar.uid !== BigInt(process.getuid!()) || (sidecar.mode & 0o077n) !== 0n)) invalid("database sidecar is not private");
    } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
  // File identifiers may exceed the safe Number range on NTFS. Keep their exact bits.
  return { dev: String(info.dev), ino: String(info.ino) };
};

/** Pure local query: it neither initializes nor migrates an authority. */
export const readLifecycleSnapshot = (options: { file: string; identity: LifecycleIdentity; limit?: number; allResources?: boolean }): LifecycleSnapshot => {
  const identity = identityValue(options.identity), original = privateFile(options.file);
  const db = new Database(options.file, { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    db.defaultSafeIntegers(true);
    return db.transaction(() => {
      // PRAGMA user_version is deliberately read as Number by the format framework.
      db.defaultSafeIntegers(false); const source = inspectSqlite(db, lifecycleStoreFormat); db.defaultSafeIntegers(true);
      if (source.kind !== "current" || encode(privateFile(options.file)) !== encode(original)) invalid("authority changed during query");
      return snapshot(db, identity, options.limit, options.allResources);
    }).deferred();
  } finally { db.close(); }
};

/** Reads the original private identity without creating a Worker or authority. */
export const readLifecycleIdentity = (options: { file: string; serverOrigin: string; workerId: string }): LifecycleIdentity => {
  const original = privateFile(options.file), db = new Database(options.file, { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    return db.transaction(() => {
      if (inspectSqlite(db, lifecycleStoreFormat).kind !== "current" || encode(privateFile(options.file)) !== encode(original)) invalid("authority changed during identity query");
      const row = db.prepare("SELECT server_origin,user_id,worker_id FROM lifecycle_state").get() as Record<string, unknown> | undefined;
      if (row === undefined) return invalid("authority identity is missing");
      const identity = identityValue({ serverOrigin: text(row.server_origin), userId: uuid(row.user_id), workerId: uuid(row.worker_id) });
      if (identity.serverOrigin !== options.serverOrigin || identity.workerId !== options.workerId) invalid("authority belongs to another service or Worker");
      db.defaultSafeIntegers(true); stateValue(db.prepare("SELECT * FROM lifecycle_state").get() as Record<string, unknown>, identity);
      return identity;
    }).deferred();
  } finally { db.close(); }
};

export const openLifecycleStore = (options: { file: string; identity: LifecycleIdentity; allowCreate?: boolean }) => {
  const identity = identityValue(options.identity);
  privateDirectory(options.file);
  let created = false;
  if (options.allowCreate === true) {
    try {
      const handle = openSync(options.file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { fsyncSync(handle); created = true; } finally { closeSync(handle); }
    } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  }
  const original = privateFile(options.file);
  const db = openSqliteDatabase({ file: options.file, format: lifecycleStoreFormat, allowCreate: false, timeoutMs: 1000,
    assertMigrationAllowed: (_db, source) => { if (!created || source.kind !== "empty") invalid("missing or unrecognized authority cannot be initialized"); } });
  const check = (): void => {
    if (encode(privateFile(options.file)) !== encode(original)) invalid("authority file was replaced");
    assertCurrentSqlite(db, lifecycleStoreFormat);
  };
  const atomic = <T>(action: () => T): T => runSqliteImmediate(db, () => { check(); return action(); });
  const read = <T>(action: () => T): T => db.transaction(() => { check(); return action(); }).deferred();
  const state = (): LifecycleState => readState(db, identity);
  const bump = (): void => {
    const current = state();
    db.prepare("UPDATE lifecycle_state SET inventory_revision=?,inventory_complete=0,save='pending',stop=CASE WHEN admission='open' THEN 'not_started' ELSE 'stopping' END,phase=CASE WHEN phase='disabled' THEN 'disabling' ELSE phase END").run(BigInt(next(current.inventoryRevision)));
  };
  const getResource = (resourceId: string): LifecycleResource | null => {
    const row = db.prepare("SELECT * FROM resource_owners WHERE resource_id=?").get(uuid(resourceId)) as Record<string, unknown> | undefined;
    if (row !== undefined) return resourceValue(row);
    const historical = db.prepare("SELECT * FROM resource_history WHERE resource_id=?").get(resourceId) as Record<string, unknown> | undefined;
    return historical === undefined ? null : historicalResource(historical);
  };
  const operationValue = (row: Record<string, unknown>, phase: LifecycleOperation["phase"] = "primary"): LifecycleOperation => {
    const prefix = phase === "activation" ? "activation_" : "";
    const request = optional(row[`${prefix}request_json`], decode), requestHash = optional(row[`${prefix}request_hash`], text);
    if ((request === null) !== (requestHash === null) || request !== null && hash(encode(request)) !== requestHash) invalid("operation payload digest is invalid");
    return { phase, operationId: uuid(row.operation_id), originOperationId: optional(row.origin_operation_id, uuid), localEpoch: integer(row.local_epoch), kind: phase === "activation" ? "activation" : text(row.kind),
      status: choice(row[`${prefix}status`], ["prepared", "submitted", "unknown", "confirmed", "rejected"]), request, requestHash, receipt: optional(row[`${prefix}receipt_json`], decode) };
  };
  const operation = (operationId: string, phase: LifecycleOperation["phase"] = "primary"): LifecycleOperation | null => {
    const row = db.prepare("SELECT * FROM lifecycle_operations WHERE operation_id=?").get(uuid(operationId)) as Record<string, unknown> | undefined;
    return row === undefined || phase === "activation" && row.activation_status === null ? null : operationValue(row, phase);
  };
  const assertBinding = (binding: LifecycleBinding, current: LifecycleState, scope = true): void => {
    const frozen = bindingValue(binding);
    if (encode(identityValue(frozen)) !== encode(identity) || current.instanceId !== frozen.instanceId || current.instanceEpoch !== frozen.instanceEpoch
      || current.localEpoch !== frozen.localEpoch || current.intentVersion !== frozen.intentVersion || scope && current.scopeGeneration !== frozen.scopeGeneration) invalid("execution binding is stale");
  };
  const assertAdmission = (binding: LifecycleBinding): void => {
    const current = state();
    // Validate authority before classifying a request as definitely unreserved.
    const frozen = bindingValue(binding);
    if (encode(identityValue(frozen)) !== encode(identity) || current.instanceId !== frozen.instanceId || current.instanceEpoch !== frozen.instanceEpoch
      || current.localEpoch !== frozen.localEpoch || current.intentVersion !== frozen.intentVersion || current.scopeGeneration !== frozen.scopeGeneration) throw new LifecycleAdmissionError("Worker lifecycle execution binding is stale.");
    if (current.admission !== "open" || current.localVeto || current.desired !== "enabled" || current.phase !== "accepting") throw new LifecycleAdmissionError();
  };
  try {
    db.pragma("foreign_keys=ON");
    if (db.pragma("foreign_keys", { simple: true }) !== 1) invalid("foreign keys could not be enabled");
    if (created) atomic(() => {
      db.prepare("INSERT INTO lifecycle_state VALUES (1,?,?,?,1,1,0,NULL,NULL,'closed',NULL,NULL,1,'disabling',NULL,1,0,0,'not_started','pending','pending',NULL,NULL,NULL)").run(identity.serverOrigin, identity.userId, identity.workerId);
    });
    db.defaultSafeIntegers(true);
    // Statement-level safe integers preserve domain serials without changing PRAGMA's framework representation.
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => prepare(sql).safeIntegers(true)) as typeof db.prepare;
    db.defaultSafeIntegers(false);
    read(() => { state(); allResources(db); });
    if (created && process.platform !== "win32") {
      const directory = openSync(path.dirname(options.file), constants.O_RDONLY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } catch (error) { db.close(); throw error; }

  return {
    readState: (): LifecycleState => read(state),
    snapshot: (limit?: number): LifecycleSnapshot => read(() => snapshot(db, identity, limit)),
    assertAdmission: (binding: LifecycleBinding): void => read(() => assertAdmission(binding)),
    closeForRestart: (): LifecycleState => atomic(() => {
      const current = state();
      if (current.phase === "accepting") {
        if (current.localVeto || current.activation === null) invalid("normal restart has no completed activation");
        db.prepare("UPDATE lifecycle_state SET admission='closed'").run();
      }
      return state();
    }),
    readResource: (resourceId: string): LifecycleResource | null => read(() => getResource(resourceId)),
    getResource: (resourceId: string): LifecycleResource | null => read(() => getResource(resourceId)),
    listResources: (): LifecycleResource[] => read(() => allResources(db)),
    bindInstance: (input: { instanceId: string; instanceEpoch: string; intentVersion: string; desired: "enabled" | "disabled" }): LifecycleState => atomic(() => {
      const current = state(); uuid(input.instanceId); serial(input.instanceEpoch); serial(input.intentVersion); choice(input.desired, ["enabled", "disabled"]);
      if (current.instanceEpoch !== null && BigInt(input.instanceEpoch) <= BigInt(current.instanceEpoch) || current.intentVersion !== null && BigInt(input.intentVersion) < BigInt(current.intentVersion)) invalid("instance registration is stale");
      const completed = current.bootstrapConsumed && !current.localVeto && current.phase !== "resuming" && current.errorCode !== "resume_interrupted" && current.activation !== null && current.intentVersion === input.intentVersion && input.desired === "enabled";
      const errorCode = current.phase === "resuming" || current.errorCode === "resume_interrupted" ? "resume_interrupted" : current.errorCode === "authority_unavailable" ? null : current.errorCode;
      db.prepare("UPDATE lifecycle_state SET instance_id=?,instance_epoch=?,intent_version=?,desired=?,admission='closed',phase='disabling',inventory_complete=0,stop='not_started',save='pending',error_code=?,activation_json=?").run(input.instanceId, BigInt(input.instanceEpoch), BigInt(input.intentVersion), input.desired, errorCode, completed ? encode(current.activation) : null);
      bump(); return state();
    }),
    observeAuthority: (input: { intentVersion: string; desired: "enabled" | "disabled"; admission: "open" | "closed" }): LifecycleState => atomic(() => {
      const current = state(); serial(input.intentVersion); choice(input.desired, ["enabled", "disabled"]); choice(input.admission, ["open", "closed"]);
      if (current.intentVersion !== null && BigInt(input.intentVersion) < BigInt(current.intentVersion)) invalid("authority observation is stale");
      const changed = current.intentVersion !== input.intentVersion;
      if (input.desired === "disabled" || input.admission === "closed" || changed) {
        const completed = !changed && input.desired === "enabled" && current.bootstrapConsumed && !current.localVeto && current.phase !== "resuming" && current.errorCode !== "resume_interrupted";
        db.prepare("UPDATE lifecycle_state SET intent_version=?,desired=?,admission='closed',phase=CASE WHEN phase='disabled' THEN phase ELSE 'disabling' END,activation_json=?").run(BigInt(input.intentVersion), input.desired, completed && current.activation !== null ? encode(current.activation) : null);
        if (changed) bump();
      } else db.prepare("UPDATE lifecycle_state SET intent_version=?,desired=?").run(BigInt(input.intentVersion), input.desired);
      return state();
    }),
    closeAdmission: (input: { operationId: string; local: boolean }): LifecycleState => atomic(() => {
      const current = state(), operationId = uuid(input.operationId), old = operation(operationId);
      if (typeof input.local !== "boolean") invalid("disable source is invalid");
      if (old !== null) {
        const cloudDisable = !input.local && old.kind === "intent" && old.request !== null && typeof old.request === "object" && !Array.isArray(old.request) && old.request.action === "disable";
        if (old.kind !== (input.local ? "local_disable" : "disable") && !cloudDisable) invalid("disable operation conflicts with its original request");
        return current;
      }
      const epoch = input.local ? next(current.localEpoch) : current.localEpoch;
      db.prepare("INSERT INTO lifecycle_operations (operation_id,local_epoch,kind,status) VALUES (?,?,?,'prepared')").run(operationId, BigInt(epoch), input.local ? "local_disable" : "disable");
      db.prepare("UPDATE lifecycle_state SET local_epoch=?,local_veto=?,admission='closed',phase='disabling',active_operation_id=?,stop='stopping',save='pending',sync='pending',error_code=NULL,activation_json=NULL").run(BigInt(epoch), input.local || current.localVeto ? 1 : 0, operationId);
      bump(); return state();
    }),
    reserveExecution: (input: { binding: LifecycleBinding; resourceId: string; ownerKind: ExecutionOwnerKind; identity: { [key: string]: LifecycleJson }; operationId: string }): LifecycleResource => atomic(() => {
      assertAdmission(input.binding);
      const resourceId = uuid(input.resourceId), operationId = uuid(input.operationId), ownerKind = choice(input.ownerKind, ["task", "bot", "assistant", "probe", "repository", "configuration", "controller"]), originalIdentity = encode(objectValue(input.identity));
      if (getResource(resourceId) !== null) invalid("resource already has an original reservation");
      db.prepare("INSERT INTO resource_owners VALUES (?,?,?,?,?,?,?,'reserved',NULL,NULL,'durable',NULL)").run(resourceId, ownerKind, originalIdentity, input.binding.instanceId, BigInt(input.binding.instanceEpoch), BigInt(input.binding.scopeGeneration), operationId);
      bump(); return getResource(resourceId)!;
    }),
    adoptPreparedControllerInput: (input: { binding: LifecycleBinding; previous: LifecycleResource; identity: { [key: string]: LifecycleJson } }): LifecycleResource => atomic(() => {
      assertAdmission(input.binding);
      const previous = getResource(input.previous.resourceId);
      if (previous === null) return invalid("prepared Controller input reservation is missing");
      if (encode(previous) !== encode(input.previous) || previous.ownerKind !== "controller" || previous.stage !== "reserved"
        || previous.processProof !== null || previous.stopProof !== null || previous.saveState !== "durable" || previous.error !== null)
        invalid("prepared Controller input reservation changed or may have dispatched");
      if (db.prepare("SELECT resource_id FROM resource_history WHERE resource_id=?").get(previous.resourceId) !== undefined) invalid("archived input reservation cannot be adopted");
      db.prepare("UPDATE resource_owners SET identity_json=?,instance_id=?,instance_epoch=?,scope_generation=? WHERE resource_id=?")
        .run(encode(objectValue(input.identity)), input.binding.instanceId, BigInt(input.binding.instanceEpoch), BigInt(input.binding.scopeGeneration), previous.resourceId);
      bump(); return getResource(previous.resourceId)!;
    }),
    settlePreparedControllerInput: (expected: LifecycleResource): LifecycleResource => atomic(() => {
      if (state().admission !== "closed") invalid("prepared input settlement requires closed admission");
      const previous = getResource(expected.resourceId);
      if (previous === null) return invalid("prepared Controller input reservation is missing");
      if (encode(previous) !== encode(expected) || previous.ownerKind !== "controller" || previous.stage !== "reserved"
        || previous.processProof !== null || previous.stopProof !== null || previous.saveState !== "durable" || previous.error !== null)
        invalid("prepared Controller input reservation changed during stop verification");
      if (db.prepare("SELECT resource_id FROM resource_history WHERE resource_id=?").get(previous.resourceId) !== undefined) invalid("archived input reservation cannot be settled");
      db.prepare("UPDATE resource_owners SET stage='not_dispatched' WHERE resource_id=?").run(previous.resourceId);
      bump(); return getResource(previous.resourceId)!;
    }),
    reserveAfterSettledControllerInput: (input: { binding: LifecycleBinding; previous: LifecycleResource; resourceId: string; identity: { [key: string]: LifecycleJson } }): LifecycleResource => atomic(() => {
      assertAdmission(input.binding);
      const previous = getResource(input.previous.resourceId);
      if (previous === null || encode(previous) !== encode(input.previous) || previous.ownerKind !== "controller" || previous.stage !== "not_dispatched"
        || previous.processProof !== null || previous.stopProof !== null || previous.saveState !== "durable" || previous.error !== null)
        return invalid("settled Controller input reservation changed");
      const resourceId = uuid(input.resourceId);
      if (getResource(resourceId) !== null || allResources(db).some(resource => resource.operationId === previous.operationId && resource.stage !== "not_dispatched"))
        return invalid("Controller input has conflicting lifecycle responsibility");
      db.prepare("INSERT INTO resource_owners VALUES (?,?,?,?,?,?,?,'reserved',NULL,NULL,'durable',NULL)")
        .run(resourceId, "controller", encode(objectValue(input.identity)), input.binding.instanceId, BigInt(input.binding.instanceEpoch), BigInt(input.binding.scopeGeneration), previous.operationId);
      bump(); return getResource(resourceId)!;
    }),
    reserveCleanupCommand: (input: { binding: LifecycleBinding; task: ClaimIdentity; resourceId: string }): LifecycleResource => atomic(() => {
      const current = state(), frozen = bindingValue(input.binding);
      if (encode(identityValue(frozen)) !== encode(identity) || current.instanceId !== frozen.instanceId || current.instanceEpoch !== frozen.instanceEpoch
        || current.localEpoch !== frozen.localEpoch || current.intentVersion !== frozen.intentVersion || current.scopeGeneration !== frozen.scopeGeneration) throw new LifecycleAdmissionError("Worker lifecycle cleanup binding is stale.");
      const resourceId = uuid(input.resourceId), task = { projectId: uuid(input.task.projectId), taskId: uuid(input.task.taskId), claimId: uuid(input.task.claimId) };
      if (getResource(resourceId) !== null) invalid("cleanup command already has an original reservation");
      db.prepare("INSERT INTO resource_owners VALUES (?,?,?,?,?,?,?,'reserved',NULL,NULL,'durable',NULL)").run(resourceId, "repository", encode({ kind: "cleanup_command", ...task }), input.binding.instanceId, BigInt(input.binding.instanceEpoch), BigInt(input.binding.scopeGeneration), resourceId);
      bump(); return getResource(resourceId)!;
    }),
    importResource: (input: { binding: LifecycleBinding; resourceId: string; ownerKind: ExecutionOwnerKind; identity: { [key: string]: LifecycleJson }; operationId: string; stage?: LifecycleStage; processProof?: LifecycleJson | null; stopProof?: LifecycleJson | null; saveState?: LifecycleResource["saveState"]; error?: string | null }): LifecycleResource => atomic(() => {
      const current = state(); assertBinding(input.binding, current);
      if (current.admission !== "closed") invalid("retained resource import requires closed management admission");
      const resourceId = uuid(input.resourceId), operationId = uuid(input.operationId), ownerKind = choice(input.ownerKind, ["task", "bot", "assistant", "probe", "repository", "configuration", "controller"]), originalIdentity = encode(objectValue(input.identity));
      const previous = getResource(resourceId);
      if (previous !== null) {
        if (previous.operationId !== operationId || previous.ownerKind !== ownerKind || encode(previous.identity) !== originalIdentity
          || input.processProof !== undefined && input.processProof !== null && previous.processProof !== null && encode(previous.processProof) !== encode(input.processProof)) invalid("retained resource conflicts with its original reservation");
        return previous;
      }
      const stage = choice(input.stage ?? "unknown", ["reserved", "running", "stopped", "not_dispatched", "confirmed", "unknown"]), proof = input.processProof == null ? null : encode(input.processProof), stopProof = input.stopProof == null ? null : encode(input.stopProof);
      const save = choice(input.saveState ?? "durable", ["pending", "durable", "failed"]), error = input.error == null ? null : text(input.error);
      if (proof !== null && ["not_dispatched", "confirmed"].includes(stage) || stage === "stopped" && stopProof === null) invalid("retained resource lacks original stopping evidence");
      db.prepare("INSERT INTO resource_owners VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(resourceId, ownerKind, originalIdentity, input.binding.instanceId, BigInt(input.binding.instanceEpoch), BigInt(input.binding.scopeGeneration), operationId, stage, proof, stopProof, save, error);
      bump(); return getResource(resourceId)!;
    }),
    recordResource: (input: { resourceId: string; stage: LifecycleStage; processProof?: LifecycleJson | null; stopProof?: LifecycleJson | null; saveState?: LifecycleResource["saveState"]; error?: string | null }): LifecycleResource => atomic(() => {
      const previous = getResource(input.resourceId); if (previous === null) return invalid("resource has no original reservation");
      const stage = choice(input.stage, ["reserved", "running", "stopped", "not_dispatched", "confirmed", "unknown"]), proof = input.processProof === undefined ? previous.processProof : jsonValue(input.processProof), stopProof = input.stopProof === undefined ? previous.stopProof : jsonValue(input.stopProof);
      const save = input.saveState === undefined ? previous.saveState : choice(input.saveState, ["pending", "durable", "failed"]), error = input.error === undefined ? previous.error : optional(input.error, text);
      if (previous.processProof !== null && encode(previous.processProof) !== encode(proof)) invalid("resource cannot replace its original birth proof");
      if (terminal(previous) && (stage !== previous.stage || encode(proof) !== encode(previous.processProof) || encode(stopProof) !== encode(previous.stopProof) || save !== previous.saveState)) invalid("terminal responsibility cannot be reopened or rewritten");
      if (stage === "reserved" && previous.stage !== "reserved" || stage === "not_dispatched" && proof !== null || stage === "confirmed" && proof !== null || stage === "stopped" && stopProof === null) invalid("resource transition lacks original stopping evidence");
      if (terminal(previous) && error === previous.error) return previous;
      if (db.prepare("SELECT resource_id FROM resource_history WHERE resource_id=?").get(input.resourceId) !== undefined) invalid("compressed terminal resource cannot be rewritten");
      db.prepare("UPDATE resource_owners SET stage=?,process_proof_json=?,stop_proof_json=?,save_state=?,last_error=? WHERE resource_id=?").run(stage, proof === null ? null : encode(proof), stopProof === null ? null : encode(stopProof), save, error, input.resourceId);
      bump(); return getResource(input.resourceId)!;
    }),
    markStopped: (input: { localEpoch: string; inventoryRevision: string; owners?: readonly OwnerStopResult[] }): LifecycleSnapshot => atomic(() => {
      const current = state(); serial(input.localEpoch); serial(input.inventoryRevision);
      if (current.localEpoch !== input.localEpoch || current.inventoryRevision !== input.inventoryRevision || current.admission !== "closed") invalid("stop inventory fence is stale");
      if (!allResources(db).every(terminal)) invalid("stop inventory retains unresolved responsibility");
      if (input.owners?.some(owner => owner.stop !== "confirmed" || owner.save !== "durable")) invalid("scope owners retain unresolved responsibility");
      const currentInventory = snapshot(db, identity, 0);
      const stopProof = { identity, instanceId: current.instanceId, instanceEpoch: current.instanceEpoch, intentVersion: current.intentVersion, localEpoch: current.localEpoch, scopeGeneration: current.scopeGeneration,
        inventoryRevision: current.inventoryRevision, inventoryDigest: currentInventory.inventoryDigest,
        owners: (input.owners ?? []).map(owner => ({ resourceId: owner.resourceId, ownerKind: owner.ownerKind, generation: owner.generation, stop: owner.stop, save: owner.save, ...(owner.identity === undefined ? {} : { identity: owner.identity }) })) };
      db.prepare("UPDATE lifecycle_state SET phase='disabled',stop='confirmed',save='durable',inventory_complete=1,error_code=CASE WHEN error_code IN ('stop_unknown','stop_timeout','save_failed','persistence_failed') THEN NULL ELSE error_code END,stop_proof_json=?").run(encode(stopProof));
      return snapshot(db, identity);
    }),
    markBlocked: (errorCode: string): LifecycleState => atomic(() => {
      db.prepare("UPDATE lifecycle_state SET admission='closed',phase='blocked',stop='unknown',save='pending',inventory_complete=0,error_code=?").run(text(errorCode)); return state();
    }),
    markManagementFailure: (): LifecycleState => atomic(() => {
      const current = state();
      if (current.stop === "confirmed" && current.save === "durable" && current.inventoryComplete) {
        db.prepare("UPDATE lifecycle_state SET admission='closed',sync='failed',error_code=CASE WHEN error_code IS NULL OR error_code='authority_unavailable' THEN 'authority_unavailable' ELSE error_code END").run();
      } else {
        db.prepare("UPDATE lifecycle_state SET admission='closed',phase='blocked',sync='failed',error_code=CASE WHEN error_code IS NULL OR error_code='authority_unavailable' THEN 'authority_unavailable' ELSE error_code END").run();
      }
      return state();
    }),
    confirmManagementAuthority: (binding: LifecycleBinding): LifecycleState => atomic(() => {
      assertBinding(binding, state());
      db.prepare("UPDATE lifecycle_state SET error_code=NULL WHERE error_code='authority_unavailable'").run();
      return state();
    }),
    setBlocked: (errorCode: string): LifecycleState => atomic(() => {
      db.prepare("UPDATE lifecycle_state SET admission='closed',phase='blocked',stop='unknown',save='pending',inventory_complete=0,error_code=?").run(text(errorCode)); return state();
    }),
    prepareActivation: (input: LifecycleActivation): LifecycleState => atomic(() => {
      const activation = parseActivation(jsonValue(input)), current = state(); assertBinding(activation.binding, current, false);
      if (current.admission !== "closed" || !current.inventoryComplete || current.stop !== "confirmed" || current.save !== "durable" || !allResources(db).every(terminal)) invalid("activation requires a closed durable inventory");
      if (current.desired !== "enabled" || (activation.action === "bootstrap" && !current.bootstrapConsumed ? BigInt(activation.binding.scopeGeneration) < BigInt(current.scopeGeneration) : BigInt(activation.binding.scopeGeneration) <= BigInt(current.scopeGeneration))) invalid("activation must prepare a new enabled scope");
      if (activation.action === "bootstrap" && (current.bootstrapConsumed || current.localVeto) || activation.action === "reconnect" && current.localVeto) invalid("internal activation cannot clear a local veto");
      if (activation.action !== "resume" && current.errorCode !== null) invalid("internal activation cannot clear an independent lifecycle blocker");
      const operations = db.prepare("SELECT * FROM lifecycle_operations").all() as Record<string, unknown>[];
      if (operations.some(row => ["submitted", "unknown"].includes(String(row.status)) || ["submitted", "unknown"].includes(String(row.activation_status)))) invalid("activation is blocked by an unresolved lifecycle operation");
      if (activation.action === "bootstrap" && operations.some(row => ["intent", "disable", "local_disable", "resume"].includes(String(row.kind)))) invalid("bootstrap cannot erase prior lifecycle intent");
      db.prepare("UPDATE lifecycle_state SET scope_generation=?,phase='resuming',active_operation_id=?,activation_json=?,error_code=NULL").run(BigInt(activation.binding.scopeGeneration), activation.operationId, encode(activation));
      return state();
    }),
    commitActivation: (input: LifecycleActivation & { receipt: LifecycleJson }): LifecycleState => atomic(() => {
      const activation = parseActivation({ binding: input.binding, operationId: input.operationId, action: input.action }), current = state(); assertBinding(activation.binding, current);
      if (current.phase !== "resuming" || current.admission !== "closed" || current.desired !== "enabled" || encode(current.activation) !== encode(activation)
        || !current.inventoryComplete || !allResources(db).every(terminal)) invalid("activation receipt does not match the current closed scope");
      const receipt = objectValue(input.receipt);
      for (const [key, expected] of Object.entries({ protocolVersion: 1, admission: "open", action: activation.action, workerId: identity.workerId, operationId: activation.operationId, instanceEpoch: activation.binding.instanceEpoch, intentVersion: activation.binding.intentVersion, localEpoch: activation.binding.localEpoch, scopeGeneration: activation.binding.scopeGeneration })) if (receipt[key] !== expected) invalid("activation receipt binding is invalid");
      db.prepare("UPDATE lifecycle_state SET local_veto=0,admission='open',phase='accepting',bootstrap_consumed=1,error_code=NULL").run();
      return state();
    }),
    prepareOperation: (input: { operationId: string; originOperationId?: string | null; kind: string; request: LifecycleJson | null; localEpoch?: string; phase?: LifecycleOperation["phase"] }): LifecycleOperation => atomic(() => {
      const phase = choice(input.phase ?? "primary", ["primary", "activation"]), operationId = uuid(input.operationId), kind = text(input.kind), request = input.request === null ? null : encode(input.request), originOperationId = input.originOperationId == null ? null : uuid(input.originOperationId), epoch = serial(input.localEpoch ?? state().localEpoch), previous = operation(operationId, phase);
      if (previous !== null) {
        if (previous.kind !== kind || previous.originOperationId !== originOperationId || previous.localEpoch !== epoch || encode(previous.request) !== encode(input.request)) invalid("operation conflicts with its frozen original payload");
        return previous;
      }
      if (phase === "activation") {
        const primary = operation(operationId);
        const isResume = (value: LifecycleJson | null): boolean => value !== null && typeof value === "object" && !Array.isArray(value) && value.action === "resume";
        if (primary === null || !(primary.kind === "resume" || primary.kind === "intent" && (isResume(primary.request) || isResume(primary.receipt))) || primary.status !== "confirmed" || primary.localEpoch !== epoch || kind !== "activation") invalid("activation stage requires its confirmed original resume intent");
        db.prepare("UPDATE lifecycle_operations SET activation_request_json=?,activation_request_hash=?,activation_status='prepared' WHERE operation_id=?").run(request, request === null ? null : hash(request), operationId);
      } else db.prepare("INSERT INTO lifecycle_operations (operation_id,origin_operation_id,local_epoch,request_json,request_hash,kind,status) VALUES (?,?,?,?,?,?,'prepared')").run(operationId, originOperationId, BigInt(epoch), request, request === null ? null : hash(request), kind);
      return operation(operationId, phase)!;
    }),
    recordOperation: (input: { operationId: string; status: LifecycleOperation["status"]; receipt?: LifecycleJson | null; phase?: LifecycleOperation["phase"] }): LifecycleOperation => atomic(() => {
      const phase = choice(input.phase ?? "primary", ["primary", "activation"]), previous = operation(input.operationId, phase); if (previous === null) return invalid("operation has no frozen request");
      const status = choice(input.status, ["prepared", "submitted", "unknown", "confirmed", "rejected"]), receipt = input.receipt === undefined ? previous.receipt : input.receipt;
      if (["confirmed", "rejected"].includes(previous.status) && (status !== previous.status || encode(receipt) !== encode(previous.receipt)) || previous.status !== "prepared" && status === "prepared"
        || previous.status === "unknown" && status === "submitted") invalid("operation cannot overwrite an original outcome");
      if ((status === "confirmed" || status === "rejected") && receipt === null) invalid("definite operation outcome requires its receipt");
      db.prepare(phase === "activation" ? "UPDATE lifecycle_operations SET activation_status=?,activation_receipt_json=? WHERE operation_id=?" : "UPDATE lifecycle_operations SET status=?,receipt_json=? WHERE operation_id=?").run(status, receipt === null ? null : encode(receipt), input.operationId); return operation(input.operationId, phase)!;
    }),
    readOperation: (operationId: string, phase: LifecycleOperation["phase"] = "primary"): LifecycleOperation | null => read(() => operation(operationId, choice<LifecycleOperation["phase"]>(phase, ["primary", "activation"]))),
    listOperations: (): LifecycleOperation[] => read(() => (db.prepare("SELECT * FROM lifecycle_operations ORDER BY operation_id").all() as Record<string, unknown>[]).flatMap(row => [operationValue(row), ...(row.activation_status === null ? [] : [operationValue(row, "activation")])])),
    appendOutbox: (input: Omit<LifecycleOutbox, "hash" | "uploadState" | "receipt">): void => atomic(() => {
      const id = uuid(input.id), payload = encode(input.payload), instanceEpoch = serial(input.instanceEpoch), intentVersion = serial(input.intentVersion), sequence = serial(input.reportSequence);
      const old = db.prepare("SELECT * FROM lifecycle_outbox WHERE id=?").get(id) as Record<string, unknown> | undefined;
      if (db.prepare("SELECT id FROM outbox_history WHERE id=?").get(id) !== undefined) invalid("outbox ID already belongs to compressed history");
      if (old !== undefined) {
        if (old.payload !== payload || integer(old.instance_epoch) !== instanceEpoch || integer(old.intent_version) !== intentVersion || integer(old.report_sequence) !== sequence) invalid("outbox conflicts with its frozen original report");
        return;
      }
      db.prepare("INSERT INTO lifecycle_outbox VALUES (?,?,?,?,?,?,'pending',NULL)").run(id, BigInt(instanceEpoch), BigInt(intentVersion), BigInt(sequence), payload, hash(payload));
    }),
    ackOutbox: (id: string, status: Exclude<LifecycleOutbox["uploadState"], "covered">, receipt?: LifecycleJson): void => atomic(() => {
      uuid(id); choice(status, ["pending", "unknown", "confirmed", "failed"]);
      const old = db.prepare("SELECT * FROM lifecycle_outbox WHERE id=?").get(id) as Record<string, unknown> | undefined;
      if (old === undefined || old.upload_state === "confirmed" && status !== "confirmed" || old.upload_state === "covered") invalid("outbox receipt cannot be changed");
      if (status === "confirmed") {
        const confirmed = objectValue(receipt);
        if (confirmed.protocolVersion !== 1 || confirmed.accepted !== true || confirmed.instanceEpoch !== integer(old!.instance_epoch)
          || confirmed.intentVersion !== integer(old!.intent_version) || confirmed.reportSequence !== integer(old!.report_sequence)
          || typeof confirmed.receivedAt !== "string" || !Number.isFinite(Date.parse(confirmed.receivedAt))) invalid("outbox receipt does not identify its original report");
      }
      db.prepare("UPDATE lifecycle_outbox SET upload_state=?,receipt_json=? WHERE id=?").run(status, receipt === undefined ? null : encode(receipt), id);
      const current = state();
      const reports = db.prepare("SELECT upload_state FROM lifecycle_outbox WHERE instance_epoch=? AND intent_version=?").all(current.instanceEpoch === null ? null : BigInt(current.instanceEpoch), current.intentVersion === null ? null : BigInt(current.intentVersion)) as { upload_state: string }[];
      db.prepare("UPDATE lifecycle_state SET sync=?").run(reports.some(report => report.upload_state === "failed") ? "failed" : reports.length > 0 && reports.every(report => ["confirmed", "covered"].includes(report.upload_state)) ? "complete" : "pending");
    }),
    coverOutbox: (id: string, authority: { instanceEpoch: string; intentVersion: string; reportSequence: string | null; receivedAt: string }): void => atomic(() => {
      const row = db.prepare("SELECT * FROM lifecycle_outbox WHERE id=?").get(uuid(id)) as Record<string, unknown> | undefined;
      if (row === undefined) invalid("outbox coverage has no original report");
      const original = row!;
      serial(authority.instanceEpoch); serial(authority.intentVersion); if (authority.reportSequence !== null) serial(authority.reportSequence);
      if (!Number.isFinite(Date.parse(authority.receivedAt))) invalid("outbox coverage has no authority observation time");
      const newer = BigInt(authority.instanceEpoch) > BigInt(integer(original.instance_epoch))
        || authority.instanceEpoch === integer(original.instance_epoch) && (BigInt(authority.intentVersion) > BigInt(integer(original.intent_version))
          || authority.intentVersion === integer(original.intent_version) && authority.reportSequence !== null && BigInt(authority.reportSequence) > BigInt(integer(original.report_sequence)));
      if (!newer) invalid("outbox coverage does not supersede its original report");
      if (original.upload_state === "confirmed" || original.upload_state === "covered") return;
      db.prepare("UPDATE lifecycle_outbox SET upload_state='covered',receipt_json=? WHERE id=?").run(encode(authority), id);
    }),
    listOutbox: (): LifecycleOutbox[] => read(() => (db.prepare("SELECT * FROM lifecycle_outbox ORDER BY instance_epoch,report_sequence").all() as Record<string, unknown>[]).map(row => {
      const payload = decode(row.payload), digest = text(row.hash); if (hash(encode(payload)) !== digest) invalid("outbox digest is invalid");
      return { id: uuid(row.id), instanceEpoch: integer(row.instance_epoch), intentVersion: integer(row.intent_version), reportSequence: integer(row.report_sequence), payload, hash: digest, uploadState: choice(row.upload_state, ["pending", "unknown", "confirmed", "covered", "failed"]), receipt: optional(row.receipt_json, decode) };
    })),
    readOutboxHistory: (id: string): LifecycleJson | null => read(() => {
      const row = db.prepare("SELECT * FROM outbox_history WHERE id=?").get(uuid(id)) as Record<string, unknown> | undefined;
      return row === undefined ? null : historicalJson(row);
    }),
    compactHistory: (input: { beforeScopeGeneration?: string } = {}): { resources: number; outbox: number } => atomic(() => {
      const current = state(); let resources = 0, outbox = 0;
      if (input.beforeScopeGeneration !== undefined) {
        const before = serial(input.beforeScopeGeneration);
        if (current.admission !== "closed" || !current.inventoryComplete || current.stop !== "confirmed" || current.save !== "durable" || BigInt(before) > BigInt(current.scopeGeneration) + 1n) invalid("resource compression requires complete closed inventory");
        for (const row of db.prepare("SELECT * FROM resource_owners WHERE scope_generation < ? ORDER BY resource_id").all(BigInt(before)) as Record<string, unknown>[]) {
          const resource = resourceValue(row); if (!terminal(resource)) invalid("unresolved resource cannot enter history");
          const source = encode(resource);
          db.prepare("INSERT INTO resource_history VALUES (?,?,?)").run(resource.resourceId, hash(source), deflateRawSync(source));
          db.prepare("DELETE FROM resource_owners WHERE resource_id=?").run(resource.resourceId); resources++;
        }
      }
      const latest = db.prepare("SELECT id FROM lifecycle_outbox WHERE instance_epoch=? ORDER BY report_sequence DESC LIMIT 1").get(current.instanceEpoch === null ? null : BigInt(current.instanceEpoch)) as { id: string } | undefined;
      for (const row of db.prepare("SELECT * FROM lifecycle_outbox WHERE upload_state IN ('confirmed','covered') ORDER BY instance_epoch,report_sequence").all() as Record<string, unknown>[]) {
        if (row.id === latest?.id) continue;
        const value = { id: uuid(row.id), instanceEpoch: integer(row.instance_epoch), intentVersion: integer(row.intent_version), reportSequence: integer(row.report_sequence), payload: decode(row.payload), hash: text(row.hash), uploadState: row.upload_state, receipt: optional(row.receipt_json, decode) };
        const source = encode(value);
        db.prepare("INSERT INTO outbox_history VALUES (?,?,?)").run(value.id, hash(source), deflateRawSync(source));
        db.prepare("DELETE FROM lifecycle_outbox WHERE id=?").run(value.id); outbox++;
      }
      return { resources, outbox };
    }),
    close: (): void => closeSqliteDatabase(db, { file: options.file, format: lifecycleStoreFormat }),
  };
};
export type LifecycleStore = ReturnType<typeof openLifecycleStore>;
