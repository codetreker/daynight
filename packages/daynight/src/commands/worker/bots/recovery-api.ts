import { createHash } from "node:crypto";
import { ApiError } from "../../../api/client.js";
import { createOperation, OperationError, type OperationLimits } from "../../../api/operation.js";
import { parseServerError, ProtocolError } from "../../../api/parse.js";
import { validateServerToken, validateTokenTransport } from "../../../config/server-token.js";
import { controllerPayloadHash } from "../../controller/launch-ticket.js";
import { botUUID, parseBot, parseBotOwner, type BotDefinition, type BotOwner, type BotRecord } from "./types.js";
import { parseBotRecoveryGrant, parseBotRecoveryIdentity, parseBotRecoveryObservation, parseBotRecoveryRegistration, parseBotRecoveryReport, parseBotRecoveryResult,
  type BotRecoveryBinding, type BotRecoveryGrant, type BotRecoveryIdentity, type BotRecoveryObservationBinding, type BotRecoveryRegistration, type BotRecoveryReport, type BotRecoveryResult } from "./recovery-protocol.js";

const defaults: OperationLimits = { totalMs: 30_000, requestMs: 10_000, responseBytes: 2 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 };
const same = (left: unknown, right: unknown): boolean => controllerPayloadHash(left) === controllerPayloadHash(right);
const conflict = (): never => { throw new ProtocolError("Bot recovery response conflicts with the original operation."); };

/** Only the original recovery mutation's complete conflict response proves noncommit. */
export class BotRecoveryRejectedError extends ApiError {
  declare readonly status: 409;
  declare readonly code: "resource_conflict";
  declare readonly requestId: string;
  readonly writeOutcome = "not_committed";
  constructor(requestId: string) {
    super({ operation: "worker.bots.recovery" }, "response", { status: 409, confirmedRefusal: true,
      serverError: { code: "resource_conflict", requestId, message: "Bot recovery preconditions changed before commitment." },
      cause: new Error("The recovery mutation was rejected before commitment.") });
    this.name = "BotRecoveryRejectedError";
  }
}

/** Sends one request; the caller durably records intent and reconciles unknown outcomes. */
export const createBotRecoveryApi = (options: { owner: BotOwner; serverToken: string; limits?: Partial<OperationLimits> }) => {
  const owner = Object.freeze(parseBotOwner(options.owner)), token = validateServerToken(options.serverToken);
  validateTokenTransport(owner.serverOrigin);
  const limits = { ...defaults, ...options.limits };
  for (const key of Object.keys(defaults) as (keyof OperationLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > defaults[key]) throw new RangeError("Bot recovery limits may only reduce the default budget.");
  }
  const active = (record: BotRecord, identity?: Pick<BotRecoveryIdentity, "serviceOrigin">): BotDefinition => {
    const original = parseBotOwner(record.owner);
    if (original.serverOrigin !== owner.serverOrigin || original.ownerUserId !== owner.ownerUserId || identity !== undefined && identity.serviceOrigin !== owner.serverOrigin) throw new Error("Bot recovery requires the original service and current account.");
    const bot = parseBot(record.observed, original);
    if (bot.id !== record.botId || bot.deletion !== null || record.definition === null || bot.sessionId === null || bot.testExecutionId === null
      || !same(bot.resolvedConfiguration, record.definition.resolvedConfiguration)) throw new Error("Bot recovery requires its original active bound definition.");
    const definition = parseBot(record.definition, original);
    if (definition.deletion !== null || definition.id !== bot.id || definition.sessionId !== bot.sessionId || definition.testExecutionId !== bot.testExecutionId) throw new Error("Bot recovery definition differs from the observed Session binding.");
    return bot;
  };
  const binding = (record: BotRecord, input: BotRecoveryIdentity & BotRecoveryBinding): void => {
    const bot = active(record, input);
    if (input.sessionId !== bot.sessionId || input.testExecutionId !== bot.testExecutionId
      || record.intent?.nativeSessionId != null && input.nativeSessionId !== null && input.nativeSessionId !== record.intent.nativeSessionId) throw new Error("Bot recovery request differs from its original Session binding.");
  };
  const request = async (record: BotRecord, workerId: string | null, action: string, body: BotRecoveryIdentity | undefined, signal: AbortSignal): Promise<unknown> => {
    active(record, body);
    if (workerId !== null) botUUID(workerId, "Bot recovery Worker");
    const operation = createOperation({ signal, limits });
    try {
      operation.check();
      const serialized = body === undefined ? undefined : JSON.stringify(body);
      if (serialized !== undefined && Buffer.byteLength(serialized) > 1024 * 1024) throw new OperationError("request_limit");
      const target = workerId === null ? `/api/v1/me/bots/${record.botId}/observation` : `/api/v1/me/workers/${workerId}/bots/${record.botId}/recovery/v1/${action}`;
      const response = await fetch(`${owner.serverOrigin}${target}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error", headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(serialized === undefined ? {} : { body: serialized }), signal: AbortSignal.any([operation.signal, AbortSignal.timeout(operation.limits.requestMs)]),
      });
      try {
        if (response.headers.get("Daynight-User-ID") !== owner.ownerUserId) throw new ProtocolError("Bot recovery response principal differs from the current account.");
        if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new ProtocolError("Bot recovery response must be JSON.");
        const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
        let size = 0;
        if (reader !== undefined) {
          try {
            while (true) {
              operation.check();
              const part = await reader.read();
              if (part.done) break;
              size += part.value.byteLength; operation.consume(part.value.byteLength);
              if (size > operation.limits.responseBytes) throw new ProtocolError("Bot recovery response exceeds its byte limit.");
              chunks.push(part.value);
            }
          } finally { reader.releaseLock(); }
        }
        operation.check();
        let value: unknown;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { throw new ProtocolError("Bot recovery response contains invalid JSON or UTF-8."); }
        if (response.status !== 200) {
          const error = parseServerError(value);
          if (["register", "grant", "takeover"].includes(action) && response.status === 409 && error.code === "resource_conflict") {
            const envelope = value as Record<string, unknown>, failure = envelope.error as Record<string, unknown>;
            const keys = Object.keys(failure);
            const details = failure.details;
            if (Object.keys(envelope).length === 1 && keys.every(key => ["code", "message", "requestId", "details"].includes(key))
              && (details === undefined || details !== null && typeof details === "object" && !Array.isArray(details)
                && Object.keys(details).length === 1 && (details as Record<string, unknown>).writeOutcome === "not_committed")) throw new BotRecoveryRejectedError(error.requestId);
          }
          // Recovery proofs and grant tokens must not be reflected by diagnostics.
          throw new ApiError({ operation: "worker.bots.recovery" }, "response", { status: response.status,
            serverError: { code: error.code, requestId: error.requestId, message: "Bot recovery request was rejected; observe the original operation." },
            cause: new Error("Bot recovery request did not return a confirmed result.") });
        }
        return value;
      } finally { if (response.body !== null && !response.body.locked) await response.body.cancel(); }
    } finally { operation.dispose(); }
  };
  const result = (value: unknown, record: BotRecord, workerId: string, operationId: string): BotRecoveryResult => {
    const parsed = parseBotRecoveryResult(value), receipt = parsed.receipt;
    if (receipt.operationId !== operationId || receipt.workerId !== workerId || receipt.sessionId !== record.definition?.sessionId
      || receipt.testExecutionId !== record.definition?.testExecutionId) return conflict();
    return parsed;
  };
  const grant = async (kind: "grant" | "takeover", record: BotRecord, value: BotRecoveryGrant, signal: AbortSignal): Promise<BotRecoveryResult> => {
    const input = parseBotRecoveryGrant(value); binding(record, input);
    const intent = record.intent;
    if (input.grant.testExecutionId !== input.testExecutionId || intent !== null && (input.grant.controllerId !== intent.registration.controllerId
      || input.grant.controllerInstanceId !== intent.controllerInstanceId || input.grant.executionGeneration !== intent.executionGeneration)) throw new Error("Bot recovery grant differs from its original execution.");
    const parsed = result(await request(record, owner.workerId, kind, input, signal), record, owner.workerId, input.operationId), receipt = parsed.receipt;
    if (receipt.kind !== kind || receipt.nativeSessionId !== input.nativeSessionId || receipt.executionGeneration !== input.grant.executionGeneration
      || receipt.controllerId !== input.grant.controllerId || receipt.controllerInstanceId !== input.grant.controllerInstanceId
      || receipt.hostingGeneration !== (BigInt(input.expectedHostingGeneration) + (kind === "takeover" ? 1n : 0n)).toString()
      || receipt.controllerTokenHash !== createHash("sha256").update(input.controllerToken).digest("hex")) return conflict();
    return parsed;
  };
  return {
    observation: async (record: BotRecord, signal: AbortSignal): Promise<BotRecoveryObservationBinding> => {
      const original = active(record), observed = parseBotRecoveryObservation(await request(record, null, "observation", undefined, signal));
      if (observed.botId !== record.botId || observed.provider !== original.resolvedConfiguration.provider
        || observed.sessionId !== original.sessionId || observed.testExecutionId !== original.testExecutionId
        || observed.sessionId === null || observed.testExecutionId === null || observed.executionGeneration === null
        || BigInt(observed.botVersion) < BigInt(original.version)
        || record.intent?.nativeSessionId != null && observed.nativeSessionId !== null && observed.nativeSessionId !== record.intent.nativeSessionId) return conflict();
      return { sessionId: observed.sessionId, testExecutionId: observed.testExecutionId, nativeSessionId: observed.nativeSessionId,
        executionGeneration: observed.executionGeneration, botVersion: observed.botVersion, workerId: observed.workerId,
        provider: observed.provider, hostingGeneration: observed.hostingGeneration };
    },
    register: async (record: BotRecord, value: BotRecoveryRegistration, signal: AbortSignal): Promise<BotRecoveryResult> => {
      const input = parseBotRecoveryRegistration(value); binding(record, input);
      const parsed = result(await request(record, record.owner.workerId, "register", input, signal), record, record.owner.workerId, input.operationId);
      if (parsed.receipt.kind !== "register" || parsed.receipt.hostingGeneration !== "1" || parsed.receipt.nativeSessionId !== input.nativeSessionId
        || parsed.receipt.botVersion !== (BigInt(input.botVersion) + 1n).toString()) return conflict();
      return parsed;
    },
    takeover: (record: BotRecord, input: BotRecoveryGrant, signal: AbortSignal) => grant("takeover", record, input, signal),
    grant: (record: BotRecord, input: BotRecoveryGrant, signal: AbortSignal) => grant("grant", record, input, signal),
    operation: async (record: BotRecord, originalWorkerId: string, operationId: string, value: BotRecoveryIdentity, signal: AbortSignal): Promise<BotRecoveryResult> => {
      const input = parseBotRecoveryIdentity(value); botUUID(operationId, "Bot recovery operation");
      return result(await request(record, originalWorkerId, `operations/${operationId}`, input, signal), record, originalWorkerId, operationId);
    },
    report: async (record: BotRecord, value: BotRecoveryReport, signal: AbortSignal): Promise<BotDefinition> => {
      const input = parseBotRecoveryReport(value), original = active(record, input), report = input.report;
      if (report.fence !== null && (report.fence.sessionId !== original.sessionId || report.fence.testExecutionId !== original.testExecutionId)) throw new Error("Bot recovery report differs from its original Session.");
      const bot = parseBot(await request(record, owner.workerId, "report", input, signal), record.owner);
      if (bot.deletion !== null || bot.id !== record.botId || BigInt(bot.version) < BigInt(original.version)
        || bot.sessionId !== original.sessionId || bot.testExecutionId !== original.testExecutionId
        || !same(bot.resolvedConfiguration, original.resolvedConfiguration) || !same(bot.roleConfiguration, original.roleConfiguration)
        || !same(bot.startupResult, report.result)) return conflict();
      return bot;
    },
  };
};
export type BotRecoveryApi = ReturnType<typeof createBotRecoveryApi>;
