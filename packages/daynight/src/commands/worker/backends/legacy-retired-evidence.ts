import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inflateRawSync } from "node:zlib";
import { nonzeroCanonicalId } from "../../../api/parse.js";
import { sqliteDatabaseIsMissing } from "../../../platform/sqlite-access.js";
import { sqliteFilename } from "../../../platform/sqlite-filename.js";
import { controllerExecutionDirectory, controllerPayloadHash, readLaunchTicket, type ControllerLaunchTicket } from "../../controller/launch-ticket.js";
import { resolveControllerStateDirectory } from "../../controller/paths.js";
import type { ProcessProof } from "../../controller/process-proof.js";
import { resolveWorkerPaths } from "../paths.js";

export type LegacyWorkerIdentity = { serverOrigin: string; userId: string; workerId: string };
export type LegacyJson = null | boolean | number | string | LegacyJson[] | { [key: string]: LegacyJson };
const owners = ["task", "bot", "assistant", "probe", "repository", "configuration", "controller"] as const;
const stages = ["reserved", "running", "stopped", "not_dispatched", "confirmed", "unknown"] as const;
const saves = ["pending", "durable", "failed"] as const;
export type LegacyWorkerResource = {
  resourceId: string; ownerKind: typeof owners[number]; identity: Record<string, LegacyJson>;
  instanceId: string; instanceEpoch?: string; scopeGeneration: string; operationId: string;
  stage: typeof stages[number]; saveState: typeof saves[number];
  processProof: LegacyJson; stopProof: LegacyJson; error: string | null;
};

const invalid = (detail: string): never => { throw new Error(`Invalid legacy Worker lifecycle evidence: ${detail}.`); };
const id = (value: unknown): string => typeof value === "string" ? nonzeroCanonicalId(value) : invalid("invalid identity");
const serial = (value: unknown): string => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n ? value : invalid("invalid sequence");
const choice = <T extends string>(value: unknown, choices: readonly T[]): T =>
  typeof value === "string" && choices.includes(value as T) ? value as T : invalid("invalid enumeration");

const jsonValue = (value: unknown, depth = 0): LegacyJson => {
  if (depth > 64) return invalid("JSON nesting exceeds its bound");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  if (Array.isArray(value)) return value.map(item => jsonValue(item, depth + 1));
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, jsonValue((value as Record<string, unknown>)[key], depth + 1)]));
  return invalid("unsupported JSON value");
};
const decode = (source: unknown): LegacyJson => {
  if (typeof source !== "string") return invalid("invalid JSON storage");
  const value = jsonValue(JSON.parse(source));
  if (JSON.stringify(value) !== source) return invalid("noncanonical JSON storage");
  return value;
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0
    ? value as Record<string, unknown> : invalid("expected a nonempty object");
const resource = (data: Record<string, unknown>, version: 1 | 2): LegacyWorkerResource => {
  const identity = object(jsonValue(data.identity)) as Record<string, LegacyJson>;
  const stage = choice(data.stage, stages), saveState = choice(data.saveState, saves);
  const processProof = jsonValue(data.processProof), stopProof = jsonValue(data.stopProof);
  if (stage === "stopped" && stopProof === null || processProof !== null && (stage === "confirmed" || stage === "not_dispatched"))
    return invalid("inconsistent resource stop evidence");
  const error = data.error;
  if (error !== null && (typeof error !== "string" || error.length === 0 || error.includes("\0"))) return invalid("invalid resource error");
  return { resourceId: id(data.resourceId), ownerKind: choice(data.ownerKind, owners), identity,
    instanceId: id(data.instanceId), ...(version === 1 ? { instanceEpoch: serial(data.instanceEpoch) } : {}), scopeGeneration: serial(data.scopeGeneration),
    operationId: id(data.operationId), stage, saveState, processProof, stopProof, error };
};
export const isDurableLegacyResource = (value: LegacyWorkerResource): boolean =>
  (value.stage === "stopped" || value.stage === "not_dispatched" || value.stage === "confirmed") && value.saveState === "durable";

const readHistory = (row: Record<string, unknown>, version: 1 | 2): LegacyWorkerResource => {
  if (!Buffer.isBuffer(row.payload)) return invalid("invalid compressed resource");
  const source = inflateRawSync(row.payload, { maxOutputLength: 256 * 1024 * 1024 });
  if (createHash("sha256").update(source).digest("hex") !== row.content_hash) return invalid("invalid compressed resource digest");
  const data = object(decode(source.toString("utf8")));
  if (Object.keys(data).sort().join() !== `error,identity,${version === 1 ? "instanceEpoch," : ""}instanceId,operationId,ownerKind,processProof,resourceId,saveState,scopeGeneration,stage,stopProof`
    || data.resourceId !== row.resource_id) return invalid("invalid compressed resource fields");
  const value = resource(data, version);
  if (!isDurableLegacyResource(value)) return invalid("unresolved compressed resource");
  return value;
};

export const readLegacyLifecycleVersion = (db: Database.Database): 1 | 2 => {
  const version = db.pragma("user_version", { simple: true });
  if (version !== 1 && version !== 2) return invalid("unsupported database format");
  const hasEpoch = db.prepare("SELECT 1 FROM pragma_table_info('resource_owners') WHERE name = 'instance_epoch'").get() !== undefined;
  if ((version === 1) !== hasEpoch) return invalid("resource schema conflicts with its database format");
  return version;
};

/** Read the original Worker inventory, including committed WAL data, without opening a writer or migrating its format. */
export const readLegacyWorkerResources = (homeDirectory: string, identity: LegacyWorkerIdentity, ownerKind: LegacyWorkerResource["ownerKind"]): LegacyWorkerResource[] => {
  const file = path.join(resolveWorkerPaths(homeDirectory).workerDirectory, "lifecycle.sqlite");
  const sidecars = [`${file}-wal`, `${file}-shm`, `${file}-journal`];
  if (sqliteDatabaseIsMissing(file)) {
    if (sidecars.some(sidecar => !sqliteDatabaseIsMissing(sidecar))) return invalid("database sidecar has no original database");
    return [];
  }
  for (const candidate of [file, ...sidecars]) {
    const stat = lstatSync(candidate, { throwIfNoEntry: false });
    if (stat === undefined && candidate !== file) continue;
    if (!stat?.isFile()) return invalid("database and sidecars must be ordinary files");
  }
  const db = new Database(sqliteFilename(file), { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    return db.transaction(() => {
      const version = readLegacyLifecycleVersion(db);
      const state = db.prepare("SELECT singleton, server_origin, user_id, worker_id, format_version FROM lifecycle_state").all() as Record<string, unknown>[];
      const original = state[0];
      if (state.length !== 1 || original?.singleton !== 1 || original.format_version !== 1 || original.server_origin !== identity.serverOrigin
        || original.user_id !== identity.userId || original.worker_id !== identity.workerId) return invalid("database belongs to another Worker identity or format");
      const seen = new Set<string>();
      const results: LegacyWorkerResource[] = [];
      const add = (value: LegacyWorkerResource): void => {
        if (seen.has(value.resourceId)) return invalid("resource appears in both live and compressed history");
        seen.add(value.resourceId);
        if (value.ownerKind === ownerKind) results.push(value);
      };
      const live = db.prepare(`SELECT resource_id, owner_kind, identity_json, instance_id, ${version === 1 ? "instance_epoch," : ""} scope_generation,
        admission_operation_id, stage, process_proof_json, stop_proof_json, save_state, last_error FROM resource_owners`).safeIntegers();
      for (const row of live.iterate() as Iterable<Record<string, unknown>>) {
        if (version === 1 && typeof row.instance_epoch !== "bigint" || typeof row.scope_generation !== "bigint") return invalid("stored sequence is not an exact integer");
        add(resource({ resourceId: row.resource_id, ownerKind: row.owner_kind, identity: decode(row.identity_json),
          instanceId: row.instance_id, ...(version === 1 ? { instanceEpoch: String(row.instance_epoch) } : {}), scopeGeneration: String(row.scope_generation), operationId: row.admission_operation_id,
          stage: row.stage, saveState: row.save_state, processProof: row.process_proof_json === null ? null : decode(row.process_proof_json),
          stopProof: row.stop_proof_json === null ? null : decode(row.stop_proof_json), error: row.last_error }, version));
      }
      for (const row of db.prepare("SELECT resource_id, content_hash, payload FROM resource_history ORDER BY resource_id").iterate() as Iterable<Record<string, unknown>>)
        add(readHistory(row, version));
      return results.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
    }).deferred();
  } finally { db.close(); }
};

const unavailable = (): never => { throw new Error("Original lifecycle Controller ticket location or identity is unavailable."); };

/** Read only the ticket paired with the reservation's original journal and owner. */
export const readLegacyControllerLocation = async (homeDirectory: string, owner: LegacyWorkerIdentity, resource: LegacyWorkerResource): Promise<{
  ticket: ControllerLaunchTicket; storageStateDirectory: string; journalFile: string;
}> => {
  const identity = resource.identity;
  if (resource.ownerKind !== "controller" || typeof identity.launchId !== "string" || typeof identity.executionId !== "string"
    || typeof identity.journalFile !== "string" || !path.isAbsolute(identity.journalFile) || path.resolve(identity.journalFile) !== identity.journalFile) return unavailable();
  // Older reservations retained the journal's full location. Invert that exact
  // layout and validate it; searching other roots could select another owner.
  const originalRoot = identity.storageStateDirectory === undefined
    ? path.dirname(path.dirname(path.dirname(path.dirname(identity.journalFile))))
    : typeof identity.storageStateDirectory === "string" ? identity.storageStateDirectory : unavailable();
  const root = resolveControllerStateDirectory(homeDirectory, originalRoot);
  if (identity.journalFile !== path.join(controllerExecutionDirectory(homeDirectory, identity.executionId, root), "journal.sqlite")) return unavailable();
  const ticket = await readLaunchTicket(homeDirectory, identity.launchId, root), binding = ticket.lifecycleBinding;
  if (binding === undefined || binding.serverOrigin !== owner.serverOrigin || binding.userId !== owner.userId || binding.workerId !== owner.workerId
    || binding.instanceId !== resource.instanceId || resource.instanceEpoch !== undefined && binding.instanceEpoch !== resource.instanceEpoch || binding.scopeGeneration !== resource.scopeGeneration
    || ticket.executionId !== identity.executionId || ticket.sessionId !== identity.sessionId || ticket.executionGeneration !== identity.executionGeneration
    || ticket.controllerInstanceId !== identity.controllerInstanceId || ticket.serverOrigin !== owner.serverOrigin
    || identity.controllerId !== undefined && identity.controllerId !== ticket.controllerId
    || identity.ticketHash !== undefined && identity.ticketHash !== controllerPayloadHash(ticket)) return unavailable();
  if (ticket.claimId === undefined || ticket.claimId !== identity.claimId || ticket.projectId !== identity.projectId || ticket.taskId !== identity.taskId
    || ticket.worktreeId !== identity.worktreeId || ticket.workerId !== owner.workerId || ticket.userId !== owner.userId || identity.testExecutionId !== undefined) return unavailable();
  if (identity.kind === "launch" && (resource.resourceId !== ticket.launchId || resource.operationId !== ticket.launchId)
    || identity.kind === "provider" && (resource.resourceId !== ticket.controllerInstanceId || resource.operationId !== ticket.launchId)
    || identity.kind !== "launch" && identity.kind !== "provider" && identity.kind !== "input") return unavailable();
  return { ticket, storageStateDirectory: root, journalFile: identity.journalFile };
};

/** The original launch owner persisted this only after stopping its unreleased gate. */
export const hasLegacyUnreleasedControllerGateProof = (ticket: ControllerLaunchTicket, resource: LegacyWorkerResource, process: ProcessProof | null): boolean => {
  const saved = resource.stopProof, binding = ticket.lifecycleBinding;
  if (binding === undefined) return false;
  // Database v2 migrated the receipt binding without changing immutable tickets.
  const { instanceEpoch, ...instanceBinding } = binding;
  const expectedBinding = resource.instanceEpoch === undefined ? instanceBinding : binding;
  return resource.ownerKind === "controller" && resource.identity.kind === "launch" && resource.stage === "stopped" && resource.saveState === "durable"
    && saved !== null && typeof saved === "object" && !Array.isArray(saved)
    && resource.resourceId === ticket.launchId && resource.operationId === ticket.launchId
    && resource.instanceId === binding.instanceId && (resource.instanceEpoch === undefined || resource.instanceEpoch === instanceEpoch)
    && resource.scopeGeneration === binding.scopeGeneration
    && Object.keys(saved).sort().join() === "binding,boundaryEmpty,controllerInstanceId,gateReleased,kind,launchId,originalProcessProof,pid"
    && saved.kind === "controller_unreleased_gate" && saved.launchId === ticket.launchId && saved.controllerInstanceId === ticket.controllerInstanceId
    && typeof saved.pid === "number" && Number.isSafeInteger(saved.pid) && saved.pid > 0 && saved.pid <= 2_147_483_647
    && (process === null || saved.pid === process.pid) && saved.gateReleased === false && saved.boundaryEmpty === true
    && isDeepStrictEqual(saved.binding, expectedBinding) && isDeepStrictEqual(saved.originalProcessProof, process)
    && isDeepStrictEqual(resource.processProof, process);
};
