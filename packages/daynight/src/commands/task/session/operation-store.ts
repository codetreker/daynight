import { createHash } from "node:crypto";
import path from "node:path";
import { jsonContainerSources } from "../../../api/json-source.js";
import { fields, id, text, timestamp } from "../../../api/validation.js";
import { choice, decimalSequence } from "../../../api/task-observation.js";
import type { TaskSessionInspection, TaskSessionOperationTarget } from "../../../api/task-session.js";
import type { SessionOperation } from "../../../session/protocol.js";
import { loadOperationFiles } from "./private-files.js";
import type { PrivateOperationFiles, PrivateOperationDirectory } from "./private-files.js";

export type SessionOperationRecord = TaskSessionOperationTarget & {
  readonly schemaVersion: 1;
  readonly origin: string;
  readonly actorId: string;
  readonly fence: TaskSessionInspection["fence"];
  readonly expectedTurnId: string | null;
  readonly bodySha256: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly phase: "prepared" | "dispatch_unknown" | "receipt";
  readonly receipt: { readonly state: SessionOperation["state"]; readonly providerResult: SessionOperation["providerResult"]; readonly errorCode: string | null } | null;
};
export const sessionBodyHash = (body: string): string => createHash("sha256").update(body, "utf8").digest("hex");
const safeCodes = ["stale_execution", "stale_turn", "not_current", "not_found", "forbidden", "expired", "unsupported", "provider_error", "invalid_input", "not_ready", "disconnected", "operation_conflict"];
export const operationRecordReceipt = (record: SessionOperationRecord, operation: SessionOperation): SessionOperationRecord => ({ ...record, phase: "receipt", updatedAt: new Date().toISOString(), receipt: { state: operation.state, providerResult: operation.providerResult, errorCode: operation.error === null ? null : safeCodes.includes(operation.error.code) ? operation.error.code : "operation_error" } });
export const parseOperationRecord = (value: unknown, origin: string, actorId: string, operationId: string): SessionOperationRecord => {
  const data = fields(value, ["schemaVersion", "origin", "actorId", "projectId", "taskId", "sessionId", "operationId", "fence", "expectedTurnId", "bodySha256", "createdAt", "updatedAt", "phase", "receipt"]);
  if (data.schemaVersion !== 1 || data.origin !== origin || data.actorId !== actorId || data.operationId !== operationId) throw new Error("Operation recovery record identity mismatch.");
  const fence = fields(data.fence, ["sessionId", "claimId", "executionGeneration", "connectionEpoch"]);
  const parsedFence = { sessionId: id(fence.sessionId), claimId: id(fence.claimId), executionGeneration: decimalSequence(fence.executionGeneration), connectionEpoch: decimalSequence(fence.connectionEpoch) };
  const hash = text(data.bodySha256);
  if (!/^[a-f0-9]{64}$/.test(hash) || parsedFence.sessionId !== id(data.sessionId)) throw new Error("Invalid operation recovery record.");
  const receipt = data.receipt === null ? null : fields(data.receipt, ["state", "providerResult", "errorCode"]);
  const parsedReceipt = receipt === null ? null : {
    state: choice(receipt.state, ["accepted", "offered", "dispatching", "provider_accepted", "confirmed", "failed", "rejected", "expired", "unknown"]),
    providerResult: receipt.providerResult === null ? null : choice(receipt.providerResult, ["started", "queued", "handled"]),
    errorCode: receipt.errorCode === null ? null : choice(receipt.errorCode, [...safeCodes, "operation_error"]),
  };
  const phase = choice(data.phase, ["prepared", "dispatch_unknown", "receipt"]);
  if ((phase === "receipt") !== (parsedReceipt !== null)) throw new Error("Invalid operation recovery phase.");
  return { schemaVersion: 1, origin, actorId: id(actorId), projectId: id(data.projectId), taskId: id(data.taskId), sessionId: id(data.sessionId), operationId: id(operationId), fence: parsedFence,
    expectedTurnId: data.expectedTurnId === null ? null : text(data.expectedTurnId, true), bodySha256: hash,
    createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt), phase, receipt: parsedReceipt };
};
export type OperationStore = {
  read(): Promise<SessionOperationRecord | undefined>;
  acquire(): Promise<void>;
  write(record: SessionOperationRecord): Promise<void>;
  close(): Promise<void>;
};
export const createOperationStore = async (stateDirectory: string, serverUrl: string, actorId: string, operationId: string, files?: PrivateOperationFiles): Promise<OperationStore> => {
  const origin = new URL(serverUrl).origin;
  id(actorId); id(operationId);
  const directory = path.join(stateDirectory, "session-operations", sessionBodyHash(origin), actorId);
  const filesystem = files ?? await loadOperationFiles();
  let held: PrivateOperationDirectory | undefined, release: (() => Promise<void>) | undefined;
  const name = `${operationId}.json`;
  const parse = (bytes: Buffer | undefined): SessionOperationRecord | undefined => {
    if (bytes === undefined) return undefined;
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    jsonContainerSources(source);
    return parseOperationRecord(JSON.parse(source) as unknown, origin, actorId, operationId);
  };
  return {
    read: async () => {
      if (held !== undefined) return parse(await held.read(name));
      const handle = await filesystem.open(directory, false);
      if (handle === undefined) return undefined;
      try { return parse(await handle.read(name)); } finally { await handle.close(); }
    },
    acquire: async () => {
      if (held !== undefined) throw new Error("Operation submission lock already acquired.");
      held = await filesystem.open(directory, true);
      if (held === undefined) throw new Error("Operation recovery directory is unavailable.");
      release = await held.lock(`${operationId}.lock`);
    },
    write: async record => {
      if (held === undefined || release === undefined) throw new Error("Operation submission lock is required.");
      const parsed = parseOperationRecord(record, origin, actorId, operationId);
      await held.replace(name, Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8"));
    },
    close: async () => {
      const failures: unknown[] = [];
      try { await release?.(); } catch (error) { failures.push(error); } finally { release = undefined; }
      try { await held?.close(); } catch (error) { failures.push(error); } finally { held = undefined; }
      if (failures.length) throw new AggregateError(failures, "Operation store cleanup failed.");
    },
  };
};
