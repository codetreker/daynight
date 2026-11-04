import { decodeSessionV2Message, parseSessionV2Message, parseSessionV2Owner } from "../../../session/v2/protocol.js";
import { canonicalSessionJson, decodeStrictSessionJson, integer, origin, seq, SESSION_V2_PROTOCOL, uuid } from "../../../session/v2/values.js";
import type { SessionV2Message } from "../../../session/v2/types.js";
import { createHerdrSessionApi, type HerdrSessionStateIdentity } from "./session-api.js";

export type HerdrArchiveIdentity = HerdrSessionStateIdentity & { executionGeneration: string };
type Message<K extends SessionV2Message["type"]> = Extract<SessionV2Message, { type: K }>;
export class HerdrArchiveHttpError extends Error {
  constructor(readonly status: number, readonly code: string | null = null) {
    super(`Herdr archive request returned HTTP ${status}${code ? ` (${code})` : ""}; reconcile the original operation before retrying.`);
    this.name = "HerdrArchiveHttpError";
  }
}
const same = (left: unknown, right: unknown) => canonicalSessionJson(left) === canonicalSessionJson(right);

/** Sends exactly one request. A transport failure never implies that the service rolled back. */
export const createHerdrArchiveApi = (serverOrigin: string, token: string, options: { fetch?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number } = {}) => {
  const service = origin(serverOrigin), send = options.fetch ?? fetch;
  if (!token || /[\r\n]/.test(token)) throw new Error("An original Worker credential is required.");
  const timeoutMs = integer(options.timeoutMs ?? 30_000, 1, 300_000), maxBytes = integer(options.maxResponseBytes ?? 4 * 1024 * 1024, 1, 8 * 1024 * 1024);
  const session = createHerdrSessionApi(service, token, { ...options, archiveState: true });
  const prefix = (expected: HerdrArchiveIdentity): string => {
    const owner = parseSessionV2Owner(expected.owner);
    if (owner.serverOrigin !== service) throw new Error("The archive owner belongs to another service.");
    uuid(expected.claimId); seq(expected.executionGeneration);
    return `/api/v1/projects/${owner.projectId}/tasks/${owner.taskId}/sessions/${uuid(expected.sessionId)}`;
  };
  const assertFence = (message: SessionV2Message, expected: HerdrArchiveIdentity): void => {
    if (message.sessionId !== expected.sessionId || message.claimId !== expected.claimId || message.executionGeneration !== expected.executionGeneration || message.agentControlMode !== "herdr") throw new Error("The archive response belongs to another original execution.");
  };
  const request = async (expected: HerdrArchiveIdentity, suffix: string, method: "GET" | "POST" | "PUT", body?: string, epoch?: string, signal?: AbortSignal): Promise<SessionV2Message> => {
    const target = `${service}${prefix(expected)}${suffix}`;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error("Archive request deadline elapsed; its outcome requires observation.")), timeoutMs);
    const cancel = () => controller.abort(signal?.reason); signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
    let response: Response | undefined;
    try {
      controller.signal.throwIfAborted();
      response = await send(target, { method, redirect: "error", signal: controller.signal, headers: { authorization: `Bearer ${token}`, "Daynight-Session-Protocol": SESSION_V2_PROTOCOL, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(epoch === undefined ? {} : { "Daynight-Connection-Epoch": seq(epoch) }) }, ...(body === undefined ? {} : { body }) });
      const advertised = response.headers.get("content-length");
      if (advertised !== null && (!/^\d+$/.test(advertised) || BigInt(advertised) > BigInt(maxBytes))) throw new Error("The archive response exceeds its bounded size.");
      let size = 0; const chunks: Uint8Array[] = [];
      if (response.body) {
        const reader = response.body.getReader();
        try { while (true) { controller.signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > maxBytes) { await reader.cancel(); throw new Error("The archive response exceeds its bounded size."); } chunks.push(part.value); } }
        finally { reader.releaseLock(); }
      }
      const raw = Buffer.concat(chunks);
      if (!response.ok) {
        let code: string | null = null;
        try { const value = decodeStrictSessionJson(raw, maxBytes) as { error?: { code?: unknown }; code?: unknown }; const candidate = value.error?.code ?? value.code; if (typeof candidate === "string") code = candidate; } catch { /* The HTTP status still identifies authentication and transient failures. */ }
        throw new HerdrArchiveHttpError(response.status, code);
      }
      const result = await decodeSessionV2Message(raw); assertFence(result, expected); return result;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); if (response?.body && !response.bodyUsed) await response.body.cancel(); }
  };
  const receipt = async (expected: HerdrArchiveIdentity, method: "GET" | "POST" | "PUT", body?: string, signal?: AbortSignal): Promise<Message<"receipt">> => {
    const result = await request(expected, method === "GET" ? "/archive/receipt" : "/archive", method, body, undefined, signal);
    if (result.type !== "receipt") throw new Error("The service did not return an immutable archive receipt.");
    return result;
  };
  return {
    state: async (expected: HerdrArchiveIdentity, signal?: AbortSignal) => { prefix(expected); return session.state(expected, signal); },
    recording: async <K extends "recording_responsibility" | "recording_evidence">(expected: HerdrArchiveIdentity, message: Message<K>, epoch: string, signal?: AbortSignal): Promise<Message<K>> => {
      const parsed = parseSessionV2Message(message); assertFence(parsed, expected);
      const result = await request(expected, "/worker-messages", "POST", canonicalSessionJson(parsed), epoch, signal);
      if (!same(result, parsed)) throw new Error("The recording acknowledgement differs from the original persisted request.");
      return result as Message<K>;
    },
    finalize: async (expected: HerdrArchiveIdentity, message: Message<"finalization">, epoch: string, signal?: AbortSignal): Promise<Message<"generation_ledger">> => {
      const parsed = parseSessionV2Message(message); assertFence(parsed, expected);
      const result = await request(expected, "/worker-messages", "POST", canonicalSessionJson(parsed), epoch, signal);
      if (result.type !== "generation_ledger" || result.payload.finalizationId !== message.payload.finalizationId || !same(result.payload.runs, message.payload.runs)) throw new Error("The service did not confirm the original finalization decision.");
      return result;
    },
    receipt: (expected: HerdrArchiveIdentity, signal?: AbortSignal) => receipt(expected, "GET", undefined, signal),
    upload: (expected: HerdrArchiveIdentity, body: string, signal?: AbortSignal) => receipt(expected, "PUT", body, signal),
    unavailable: (expected: HerdrArchiveIdentity, message: Message<"receipt">, signal?: AbortSignal) => {
      const parsed = parseSessionV2Message(message); assertFence(parsed, expected);
      if (message.payload.disposition !== "unavailable") throw new Error("Only an unavailable receipt can be submitted without content.");
      return receipt(expected, "POST", canonicalSessionJson(parsed), signal);
    },
    failed: async (expected: HerdrArchiveIdentity, message: Message<"archive_status">, signal?: AbortSignal): Promise<Message<"archive_status">> => {
      const parsed = parseSessionV2Message(message); assertFence(parsed, expected);
      if (message.payload.state !== "failed") throw new Error("Expected a permanent archive failure.");
      const result = await request(expected, "/archive", "POST", canonicalSessionJson(parsed), undefined, signal);
      if (result.type !== "archive_status") throw new Error("The service did not return archive status.");
      return result;
    },
  };
};
export type HerdrArchiveApi = ReturnType<typeof createHerdrArchiveApi>;

/** The responsibility ID must already be durable locally before this call. */
export const ensureHerdrRecordingResponsibility = async (api: HerdrArchiveApi, expected: HerdrArchiveIdentity, responsibility: Message<"recording_responsibility">["payload"], signal?: AbortSignal): Promise<void> => {
  const observed = await api.state(expected, signal);
  const original = observed.recording.find(run => run.executionGeneration === expected.executionGeneration)?.responsibility;
  if (original !== null && original !== undefined) {
    if (!same(original, responsibility)) throw new Error("The original recording responsibility differs from the persisted intent.");
    return;
  }
  if (observed.executionGeneration !== expected.executionGeneration || observed.ledger.finalizationId !== null || !observed.ledger.runs.some(run => run.executionGeneration === expected.executionGeneration && run.stopProof === null)) throw new Error("Recording responsibility requires the original active run.");
  const message: Message<"recording_responsibility"> = { protocol: SESSION_V2_PROTOCOL, schemaVersion: 2, projectionVersion: 1, sessionId: expected.sessionId, claimId: expected.claimId, executionGeneration: expected.executionGeneration, agentControlMode: "herdr", contentKind: "terminal_recording", type: "recording_responsibility", payload: responsibility };
  let failure: unknown;
  try { await api.recording(expected, message, observed.connectionEpoch, signal); } catch (error) { failure = error; }
  const after = await api.state(expected, signal);
  if (!same(after.recording.find(run => run.executionGeneration === expected.executionGeneration)?.responsibility ?? null, responsibility)) throw new Error("The persisted recording responsibility remains unconfirmed; its request was not repeated.", { cause: failure });
};
