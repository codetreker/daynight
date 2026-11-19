import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { writeDurableJson } from "../../../platform/durable-json.js";
import { controllerPayloadHash } from "../../controller/launch-ticket.js";
import { resolveBotPaths } from "./paths.js";
import { parseBotOwner, botUUID, type BotOwner, type BotRecord } from "./types.js";
import {
  parseBotRecoveryIdentity, parseBotRecoveryRegistration, parseBotRecoveryGrant, parseBotRecoveryResult,
  type BotRecoveryRegistration, type BotRecoveryGrant, type BotRecoveryResult,
} from "./recovery-protocol.js";

export type BotRecoveryOperation = {
  kind: "register" | "takeover" | "grant";
  workerId: string;
  body: BotRecoveryRegistration | BotRecoveryGrant;
  result: BotRecoveryResult | null;
};
export type BotRecoveryState = {
  schemaVersion: 1;
  owner: Pick<BotOwner, "serverOrigin" | "ownerUserId">;
  botId: string;
  recoveryIdentity: string;
  registration: BotRecoveryResult | null;
  current: BotRecoveryResult | null;
  currentOperation: BotRecoveryOperation | null;
  pending: BotRecoveryOperation | null;
};
const same = (left: unknown, right: unknown): boolean => controllerPayloadHash(left) === controllerPayloadHash(right);
const invalid = (): never => { throw new Error("Bot recovery state conflicts with its original identity or operation."); };
const exact = (input: unknown, keys: string[]): Record<string, unknown> => {
  if (input === null || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join() !== keys.sort().join()) return invalid();
  return input as Record<string, unknown>;
};
const checkedResult = (operation: Omit<BotRecoveryOperation, "result">, input: unknown): BotRecoveryResult => {
  const result = parseBotRecoveryResult(input), receipt = result.receipt, request = operation.body;
  if (receipt.operationId !== request.operationId || receipt.kind !== operation.kind || receipt.workerId !== operation.workerId
    || receipt.sessionId !== request.sessionId || receipt.testExecutionId !== request.testExecutionId
    || receipt.nativeSessionId !== request.nativeSessionId) return invalid();
  if (operation.kind === "register") {
    if (receipt.hostingGeneration !== "1" || receipt.botVersion !== (BigInt((request as BotRecoveryRegistration).botVersion) + 1n).toString()) return invalid();
  } else {
    const body = request as BotRecoveryGrant;
    if (receipt.hostingGeneration !== (BigInt(body.expectedHostingGeneration) + (operation.kind === "takeover" ? 1n : 0n)).toString()
      || receipt.executionGeneration !== body.grant.executionGeneration || receipt.controllerId !== body.grant.controllerId
      || receipt.controllerInstanceId !== body.grant.controllerInstanceId
      || receipt.controllerTokenHash !== createHash("sha256").update(body.controllerToken).digest("hex")) return invalid();
  }
  return result;
};

/** The Bot's instance lock must outlive this store and every pending operation. */
export const openBotRecoveryStore = (options: {
  stateDirectory: string; owner: BotOwner; assertLocked(record: BotRecord): void;
}) => {
  const owner = parseBotOwner(options.owner);
  const identity = (record: BotRecord): void => {
    const original = parseBotOwner(record.owner);
    botUUID(record.botId, "Bot ID");
    if (original.serverOrigin !== owner.serverOrigin || original.ownerUserId !== owner.ownerUserId || record.observed.id !== record.botId) return invalid();
    options.assertLocked(record);
  };
  const file = (record: BotRecord): string => path.join(resolveBotPaths(options.stateDirectory, record.botId).directory, "recovery.json");
  const physical = (target: string, directory: boolean): void => {
    const entry = lstatSync(target);
    if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile()) || realpathSync(target) !== target
      || process.platform !== "win32" && (entry.uid !== process.getuid!() || (entry.mode & 0o077) !== 0)) {
      throw new Error("Bot recovery requires private physical files owned by the current operating-system user.");
    }
    if (!directory && entry.size > 256 * 1024) throw new Error("Bot recovery state exceeds its byte limit.");
  };
  const parse = (record: BotRecord, input: unknown): BotRecoveryState => {
    const value = exact(input, ["schemaVersion", "owner", "botId", "recoveryIdentity", "registration", "current", "currentOperation", "pending"]);
    const account = exact(value.owner, ["serverOrigin", "ownerUserId"]);
    if (value.schemaVersion !== 1 || value.botId !== record.botId || account.serverOrigin !== owner.serverOrigin || account.ownerUserId !== owner.ownerUserId) return invalid();
    const proof = parseBotRecoveryIdentity({ botRecoveryVersion: 1, serviceOrigin: owner.serverOrigin, recoveryIdentity: value.recoveryIdentity });
    const registration = value.registration === null ? null : parseBotRecoveryResult(value.registration);
    const current = value.current === null ? null : parseBotRecoveryResult(value.current);
    if (registration !== null && registration.receipt.kind !== "register") return invalid();
    if (current !== null && registration === null) return invalid();
    for (const result of [registration, current]) {
      if (result === null) continue;
      if (record.definition?.sessionId != null && result.receipt.sessionId !== record.definition.sessionId
        || record.definition?.testExecutionId != null && result.receipt.testExecutionId !== record.definition.testExecutionId) return invalid();
    }
    const parseOperation = (input: unknown): BotRecoveryOperation | null => {
      if (input === null) return null;
      const saved = exact(input, ["kind", "workerId", "body", "result"]);
      if (saved.kind !== "register" && saved.kind !== "takeover" && saved.kind !== "grant") return invalid();
      const workerId = botUUID(saved.workerId, "Bot recovery Worker");
      const body = saved.kind === "register" ? parseBotRecoveryRegistration(saved.body) : parseBotRecoveryGrant(saved.body);
      if (body.serviceOrigin !== proof.serviceOrigin || body.recoveryIdentity !== proof.recoveryIdentity) return invalid();
      if (record.definition?.sessionId != null && body.sessionId !== record.definition.sessionId
        || record.definition?.testExecutionId != null && body.testExecutionId !== record.definition.testExecutionId) return invalid();
      const operation: Omit<BotRecoveryOperation, "result"> = { kind: saved.kind, workerId, body };
      const result = saved.result === null ? null : checkedResult(operation, saved.result);
      return { ...operation, result };
    };
    const pending = parseOperation(value.pending), currentOperation = parseOperation(value.currentOperation);
    if ((current === null) !== (currentOperation === null) || currentOperation !== null && (currentOperation.result === null || !same(currentOperation.result, current))) return invalid();
    return { schemaVersion: 1, owner: { serverOrigin: owner.serverOrigin, ownerUserId: owner.ownerUserId }, botId: record.botId,
      recoveryIdentity: proof.recoveryIdentity, registration, current, currentOperation, pending };
  };
  const read = (record: BotRecord): BotRecoveryState | null => {
    identity(record);
    const target = file(record);
    physical(path.dirname(target), true);
    try { physical(target, false); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null; throw cause; }
    let value: unknown;
    try { value = JSON.parse(readFileSync(target, "utf8")); }
    catch { throw new Error("Bot recovery state is unreadable; its original evidence was retained."); }
    return parse(record, value);
  };
  const write = (record: BotRecord, state: BotRecoveryState): BotRecoveryState => {
    identity(record);
    const checked = parse(record, state), target = file(record);
    physical(path.dirname(target), true);
    try { physical(target, false); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    // Publication errors may follow a successful rename. The next decision reads
    // the original file; callers must not infer rollback or replace the operation.
    writeDurableJson(target, checked);
    return read(record)!;
  };
  const required = (record: BotRecord): BotRecoveryState => read(record) ?? invalid();
  return {
    read,
    bound: read,
    ensureIdentity: (record: BotRecord): BotRecoveryState => read(record) ?? write(record, {
      schemaVersion: 1, owner: { serverOrigin: owner.serverOrigin, ownerUserId: owner.ownerUserId }, botId: record.botId,
      recoveryIdentity: randomBytes(32).toString("base64url"), registration: null, current: null, currentOperation: null, pending: null,
    }),
    /** Persisting intent consumes the one permitted submission, even before HTTP. */
    prepare: (record: BotRecord, operation: Omit<BotRecoveryOperation, "result">): BotRecoveryState => {
      const state = required(record);
      // A repeated call cannot prove that its earlier submission never started.
      // Only querying and finishing that original operation may clear pending.
      if (state.pending !== null) return invalid();
      if (operation.kind === "register" && state.registration !== null
        || operation.kind !== "register" && state.registration === null
        || operation.body.operationId === state.registration?.receipt.operationId
        || operation.body.operationId === state.current?.receipt.operationId) return invalid();
      return write(record, { ...state, pending: { ...operation, result: null } });
    },
    recordResult: (record: BotRecord, operationId: string, input: BotRecoveryResult): BotRecoveryState => {
      const state = required(record), operation = state.pending;
      if (operation === null || operation.body.operationId !== operationId) return invalid();
      const result = checkedResult(operation, input);
      if (operation.result !== null && !same(operation.result.receipt, result.receipt)) return invalid();
      return write(record, { ...state, registration: operation.kind === "register" ? result : state.registration,
        current: result, currentOperation: { ...operation, result }, pending: { ...operation, result } });
    },
    /** Only a confirmed receipt can end an operation's pending responsibility. */
    finishOperation: (record: BotRecord, operationId: string): BotRecoveryState => {
      const state = required(record);
      if (state.pending?.body.operationId !== operationId || state.pending.result === null) return invalid();
      return write(record, { ...state, pending: null });
    },
  };
};
export type BotRecoveryStore = ReturnType<typeof openBotRecoveryStore>;
