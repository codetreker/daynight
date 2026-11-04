import { ApiError } from "../../../api/client.js";
import { createOperation, type Operation } from "../../../api/operation.js";
import { parseServerError, ProtocolError } from "../../../api/parse.js";
import { validateServerToken, validateTokenTransport } from "../../../config/server-token.js";
import { isNonemptyText } from "../../../platform/text.js";
import { parseControllerGrantResponse, parseRegistrationResponse, type ControllerGrantResponse } from "../../../session/controller-protocol.js";
import { parseSessionSnapshot, SESSION_PROTOCOL, sessionFence, type SessionSnapshot } from "../../../session/protocol.js";
import { controllerPayloadHash } from "../../controller/launch-ticket.js";
import { parseBot, parseBotOwner, parseBotRole, type BotDefinition, type BotOwner, type BotRecord } from "./types.js";

export type BotStartupResult = { state: "ready" | "failed"; code?: string | null; nativeSessionId?: string | null };
const same = (left: unknown, right: unknown): boolean => controllerPayloadHash(left) === controllerPayloadHash(right);

/** Lifecycle writes preserve the original registration and never retry an uncertain POST. */
export const createBotSessionApi = (options: { owner: BotOwner; serverToken: string }) => {
  const owner = Object.freeze(parseBotOwner(options.owner));
  const token = validateServerToken(options.serverToken);
  validateTokenTransport(owner.serverOrigin);
  const active = (record: BotRecord): BotDefinition => {
    if (!same(parseBotOwner(record.owner), owner)) throw new Error("Bot lifecycle owner differs from the original Worker binding.");
    const bot = parseBot(record.observed, owner);
    if (bot.id !== record.botId || bot.deletion !== null || record.definition === null) throw new Error("Bot lifecycle requires its original active definition.");
    if (!same(bot.resolvedConfiguration, record.definition.resolvedConfiguration)) throw new Error("Bot frozen configuration differs from its original definition.");
    return bot;
  };
  const intentOf = (record: BotRecord) => {
    const bot = active(record), intent = record.intent;
    if (intent === null || intent.registration.initialInput !== "none" || intent.registration.testExecutionId !== intent.executionId || intent.registration.provider !== bot.resolvedConfiguration.provider) throw new Error("Bot lifecycle requires its original durable launch intent.");
    if (bot.testExecutionId !== null && bot.testExecutionId !== intent.executionId || bot.sessionId !== null && intent.sessionId !== null && bot.sessionId !== intent.sessionId) throw new Error("Bot session differs from its original durable launch intent.");
    return intent;
  };
  const checkedBot = (value: unknown, record: BotRecord): BotDefinition => {
    const previous = active(record), bot = parseBot(value, owner);
    if (bot.deletion !== null || bot.id !== record.botId || BigInt(bot.version) < BigInt(previous.version) || !same(bot.resolvedConfiguration, previous.resolvedConfiguration)
      || previous.sessionId !== null && (bot.sessionId !== previous.sessionId || bot.testExecutionId !== previous.testExecutionId)
      || previous.roleConfiguration !== null && !same(bot.roleConfiguration, previous.roleConfiguration)) throw new ProtocolError("Bot lifecycle response conflicts with the original definition.");
    return bot;
  };
  const checkedSnapshot = (value: unknown, record: BotRecord, sessionId?: string): SessionSnapshot => {
    const intent = intentOf(record), snapshot = parseSessionSnapshot(value);
    const expectedSession = sessionId ?? intent.sessionId ?? active(record).sessionId;
    if (expectedSession !== null && snapshot.sessionId !== expectedSession || snapshot.testExecutionId !== intent.executionId
      || snapshot.executionGeneration !== intent.executionGeneration || snapshot.identity.ownerUserId !== owner.ownerUserId
      || snapshot.identity.provider !== intent.registration.provider || snapshot.identity.controllerId !== intent.registration.controllerId
      || snapshot.identity.controllerInstanceId !== intent.registration.controllerInstanceId || snapshot.initialInputState !== "not_required"
      || intent.nativeSessionId !== null && snapshot.identity.nativeSessionId !== intent.nativeSessionId) throw new ProtocolError("Bot Session snapshot conflicts with the original execution.");
    return snapshot;
  };
  const request = async (target: string, operation: Operation, body?: unknown): Promise<unknown> => {
    operation.check();
    const response = await fetch(`${owner.serverOrigin}${target}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([operation.signal, AbortSignal.timeout(operation.limits.requestMs)]),
    });
    try {
      if (response.headers.get("Daynight-User-ID") !== owner.ownerUserId) throw new ProtocolError("Bot lifecycle response principal does not match the Worker owner.");
      if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new ProtocolError("Bot lifecycle response must be JSON.");
      const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      if (reader !== undefined) {
        try {
          while (true) {
            operation.check();
            const item = await reader.read();
            if (item.done) break;
            operation.consume(item.value.byteLength); size += item.value.byteLength;
            if (size > operation.limits.responseBytes) throw new ProtocolError("Bot lifecycle response exceeds its byte limit.");
            chunks.push(item.value);
          }
        } finally { reader.releaseLock(); }
      }
      operation.check();
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw new ProtocolError("Bot lifecycle response contains invalid JSON or UTF-8."); }
      if (response.status !== 200) {
        const error = parseServerError(value);
        throw new ApiError({ operation: "worker.bots.lifecycle" }, "response", { status: response.status, serverError: error, cause: new Error("Bot lifecycle request failed; observe the original identity before another write.") });
      }
      return value;
    } finally { if (response.body !== null && !response.body.locked) await response.body.cancel(); }
  };
  const run = async <T>(signal: AbortSignal, action: (operation: Operation) => Promise<T>): Promise<T> => {
    const operation = createOperation({ signal, limits: { totalMs: 30_000, requestMs: 10_000, responseBytes: 2 * 1024 * 1024, totalBytes: 4 * 1024 * 1024 } });
    try { operation.check(); return await action(operation); }
    finally { operation.dispose(); }
  };
  const prefix = (record: BotRecord): string => { active(record); return `/api/v1/me/workers/${owner.workerId}/bots/${record.botId}`; };
  const read = async (record: BotRecord, operation: Operation): Promise<SessionSnapshot> => {
    const bot = active(record), intent = intentOf(record), sessionId = intent.sessionId ?? bot.sessionId;
    if (sessionId === null) throw new Error("Bot Session has not been registered.");
    const response = parseRegistrationResponse(await request(`/api/v1/test-sessions/${sessionId}`, operation));
    return checkedSnapshot(response.session, record, sessionId);
  };
  return {
    register: (record: BotRecord, signal: AbortSignal): Promise<{ bot: BotDefinition; snapshot: SessionSnapshot }> => run(signal, async operation => {
      const bot = active(record), intent = intentOf(record);
      if (intent.roleConfiguration === null) throw new Error("Bot role must be persisted before registration.");
      const roleConfiguration = parseBotRole(intent.roleConfiguration);
      if (bot.roleConfiguration !== null && !same(bot.roleConfiguration, roleConfiguration)) throw new Error("Bot server role differs from its persisted registration role.");
      const value = await request(`${prefix(record)}/register`, operation, { botVersion: intent.botVersion, registration: intent.registration, configuration: bot.resolvedConfiguration, roleConfiguration });
      if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "bot,session") throw new ProtocolError("Bot registration response is malformed.");
      const result = value as { bot: unknown; session: unknown }, registered = checkedBot(result.bot, record);
      if (registered.sessionId === null || registered.testExecutionId !== intent.executionId || !same(registered.roleConfiguration, roleConfiguration)) throw new ProtocolError("Bot registration response conflicts with the persisted role or execution.");
      return { bot: registered, snapshot: checkedSnapshot(result.session, record, registered.sessionId) };
    }),
    readSession: (record: BotRecord, signal: AbortSignal): Promise<SessionSnapshot> => run(signal, operation => read(record, operation)),
    grant: (record: BotRecord, signal: AbortSignal): Promise<ControllerGrantResponse> => run(signal, async operation => {
      const bot = active(record), intent = intentOf(record), snapshot = await read(record, operation);
      const grant = parseControllerGrantResponse(await request(`${prefix(record)}/grant`, operation, {
        botVersion: bot.version, nativeSessionId: snapshot.identity.nativeSessionId,
        grant: { protocol: SESSION_PROTOCOL, testExecutionId: intent.executionId, controllerId: intent.registration.controllerId, controllerInstanceId: intent.registration.controllerInstanceId, executionGeneration: intent.executionGeneration, kind: "reconnect", previousGeneration: null, stopProof: null },
      }));
      if (grant.sessionId !== snapshot.sessionId || grant.testExecutionId !== intent.executionId || grant.executionGeneration !== intent.executionGeneration
        || grant.controllerId !== intent.registration.controllerId || grant.controllerInstanceId !== intent.registration.controllerInstanceId || Date.parse(grant.expiresAt) <= Date.now()) throw new ProtocolError("Bot Controller grant conflicts with the original execution or is expired.");
      return grant;
    }),
    report: (record: BotRecord, result: BotStartupResult, signal: AbortSignal): Promise<BotDefinition> => run(signal, async operation => {
      const bot = active(record), code = result.code ?? null;
      if (result.state !== "ready" && result.state !== "failed" || result.state === "ready" && code !== null || result.state === "failed" && (!isNonemptyText(code) || code.trim() === "")) throw new Error("Bot startup result must be ready or failed with a nonempty error code.");
      let snapshot: SessionSnapshot | null = null;
      if (bot.sessionId !== null) snapshot = await read(record, operation);
      if (result.state === "ready" && (snapshot === null || !snapshot.synchronized || snapshot.connectionState !== "connected" || snapshot.lifecycle !== "active" || !["idle", "working", "waiting_input"].includes(snapshot.activity))) throw new Error("Bot ready report requires a synchronized active Session.");
      if (result.nativeSessionId !== undefined && result.nativeSessionId !== (snapshot?.identity.nativeSessionId ?? null)) throw new Error("Bot startup report native identity differs from the observed Session.");
      const reported = checkedBot(await request(`${prefix(record)}/report`, operation, {
        botVersion: bot.version, fence: snapshot === null ? null : { ...sessionFence(snapshot), connectionEpoch: snapshot.connectionEpoch },
        controllerId: snapshot?.identity.controllerId ?? "", controllerInstanceId: snapshot?.identity.controllerInstanceId ?? "",
        nativeSessionId: snapshot?.identity.nativeSessionId ?? null, result: { state: result.state, code },
      }), record);
      if (reported.startupResult.state !== result.state || reported.startupResult.code !== code) throw new ProtocolError("Bot startup report response does not confirm the requested result.");
      return reported;
    }),
  };
};
export type BotSessionApi = ReturnType<typeof createBotSessionApi>;
