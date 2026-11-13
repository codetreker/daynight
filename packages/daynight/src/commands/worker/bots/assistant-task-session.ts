import { SESSION_COMMAND_BYTES } from "../../../api/task-session.js";
import { fields, malformed } from "../../../api/validation.js";
import { validateServerToken, validateTokenTransport } from "../../../config/server-token.js";
import { assertSessionFence, parseSessionCommand, parseSessionOperation, type SessionCommand, type SessionOperation } from "../../../session/protocol.js";
import type { BotSessionApi } from "./session-api.js";
import { parseBot, parseBotOwner, type BotOwner, type BotRecord } from "./types.js";

export class AssistantTaskSessionError extends Error {
  constructor(readonly outcomeUnconfirmed: boolean, readonly code: string, readonly status?: number) {
    super(`Assistant notification Session request failed (${code}).${outcomeUnconfirmed ? " Query the original operation; do not resend." : ""}`);
    this.name = "AssistantTaskSessionError";
  }
}

const refusalCodes = new Set(["invalid_input", "unauthorized", "unauthenticated", "forbidden", "not_found", "not_current", "stale_execution", "stale_turn", "session_conflict", "not_ready", "disconnected", "controller_offline", "rate_limited", "operation_conflict", "unsupported", "expired"]);

/** The caller persists the complete command before send. Neither method retries a request. */
export const createAssistantTaskSessionTransport = (options: {
  owner: BotOwner; serverToken: string; sessionApi: Pick<BotSessionApi, "readSession">; fetch?: typeof globalThis.fetch;
}) => {
  const owner = Object.freeze(parseBotOwner(options.owner)), token = validateServerToken(options.serverToken);
  validateTokenTransport(owner.serverOrigin);
  const checkCommand = (record: BotRecord, input: SessionCommand, sending: boolean): SessionCommand => {
    const binding = parseBotOwner(record.owner);
    if (binding.serverOrigin !== owner.serverOrigin || binding.ownerUserId !== owner.ownerUserId || binding.workerId !== owner.workerId) throw new AssistantTaskSessionError(false, "identity_mismatch");
    const bot = parseBot(record.observed, owner), intent = record.intent, command = parseSessionCommand(input);
    if (bot.id !== record.botId || bot.deletion !== null || intent === null || record.definition === null
      || intent.sessionId !== bot.sessionId || intent.executionId !== bot.testExecutionId
      || record.definition.sessionId !== bot.sessionId || record.definition.testExecutionId !== bot.testExecutionId
      || command.sessionId !== intent.sessionId || command.testExecutionId !== intent.executionId
      || command.kind !== "send_message" || command.payload.origin !== "daynight" || command.payload.expectedTurnId !== null
      || command.payload.content.some(part => part.type !== "text")
      || (sending ? command.executionGeneration !== intent.executionGeneration : BigInt(command.executionGeneration) > BigInt(intent.executionGeneration))) {
      throw new AssistantTaskSessionError(false, "identity_mismatch");
    }
    return command;
  };
  const request = async (command: SessionCommand, signal: AbortSignal, sending: boolean): Promise<SessionOperation> => {
    const operationUrl = `/api/v1/test-sessions/${command.sessionId}/operations/${command.operationId}`;
    const body = sending ? JSON.stringify(command) : undefined;
    if (body !== undefined && Buffer.byteLength(body) > SESSION_COMMAND_BYTES) throw new AssistantTaskSessionError(false, "request_limit");
    let dispatched = false, response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancellation = new AbortController(), abort = () => cancellation.abort();
    const timer = setTimeout(abort, 10_000); timer.unref();
    signal.addEventListener("abort", abort, { once: true });
    let rejectAborted: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = () => reject(new AssistantTaskSessionError(sending && dispatched, "request_cancelled"));
      cancellation.signal.addEventListener("abort", rejectAborted, { once: true });
    });
    try {
      if (signal.aborted) throw new AssistantTaskSessionError(false, "request_cancelled");
      dispatched = true;
      response = await Promise.race([(options.fetch ?? globalThis.fetch)(`${owner.serverOrigin}${sending ? `/api/v1/test-sessions/${command.sessionId}/commands` : operationUrl}`, {
        method: sending ? "POST" : "GET", redirect: "manual", cache: "no-store", signal: cancellation.signal,
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(sending ? { "content-type": "application/json" } : {}) },
        ...(body === undefined ? {} : { body }),
      }), aborted]);
      if (response.headers.get("Daynight-User-ID") !== owner.ownerUserId || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw new AssistantTaskSessionError(sending, "invalid_response", response.status);
      const chunks: Uint8Array[] = []; let size = 0;
      if (response.body !== null) {
        reader = response.body.getReader();
        for (;;) {
          const part = await Promise.race([reader.read(), aborted]);
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 65_536) throw new AssistantTaskSessionError(sending, "response_limit", response.status);
          chunks.push(part.value);
        }
      }
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      if (JSON.stringify(value).includes(token)) throw new AssistantTaskSessionError(sending, "invalid_response", response.status);
      if (response.status !== (sending ? 202 : 200)) {
        const error = fields(fields(value, ["error"]).error, ["code", "message", "requestId", "details"]);
        const code = typeof error.code === "string" && refusalCodes.has(error.code) ? error.code : "invalid_response";
        const refused = response.status >= 400 && response.status < 500 && code !== "invalid_response" || response.status === 503 && code === "controller_offline";
        throw new AssistantTaskSessionError(sending && !refused, code, response.status);
      }
      const envelope = fields(value, sending ? ["operation", "operationUrl"] : ["operation"]);
      if (sending && (envelope.operationUrl !== operationUrl || response.headers.get("location") !== operationUrl)) return malformed();
      const receipt = parseSessionOperation(envelope.operation);
      assertSessionFence(receipt, command);
      if (receipt.operationId !== command.operationId || receipt.kind !== "send_message") return malformed();
      return receipt;
    } catch (error) {
      if (error instanceof AssistantTaskSessionError) throw error;
      throw new AssistantTaskSessionError(sending && dispatched, response === undefined ? "request_failed" : "invalid_response", response?.status);
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (rejectAborted !== undefined) cancellation.signal.removeEventListener("abort", rejectAborted);
      cancellation.abort();
      if (reader !== undefined) { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
      else if (response?.body != null) void response.body.cancel().catch(() => undefined);
    }
  };
  return {
    send: async (record: BotRecord, input: SessionCommand, signal: AbortSignal): Promise<SessionOperation> => {
      let command: SessionCommand;
      try {
        command = checkCommand(record, input, true);
        const snapshot = await options.sessionApi.readSession(record, signal);
        assertSessionFence(snapshot, command);
        if (!snapshot.synchronized || snapshot.connectionState !== "connected" || snapshot.lifecycle !== "active"
          || snapshot.activity !== "idle" || snapshot.currentTurnId !== null || !snapshot.operations.canSend) throw new AssistantTaskSessionError(false, "not_ready");
      } catch (error) {
        if (error instanceof AssistantTaskSessionError) throw error;
        throw new AssistantTaskSessionError(false, "preflight_failed");
      }
      return request(command, signal, true);
    },
    readOperation: (record: BotRecord, input: SessionCommand, signal: AbortSignal): Promise<SessionOperation> => request(checkCommand(record, input, false), signal, false),
  };
};
export type AssistantTaskSessionTransport = ReturnType<typeof createAssistantTaskSessionTransport>;
