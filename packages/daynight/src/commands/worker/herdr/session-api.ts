import { assertTerminalBinding, parseSessionV2Message, parseSessionV2Owner, parseSessionV2Runs, parseTerminalBinding } from "../../../session/v2/protocol.js";
import { bool, canonicalSessionJson, choice, decodeStrictSessionJson, exact, integer, list, nullable, origin, seq, SESSION_V2_PROTOCOL, uuid } from "../../../session/v2/values.js";
import type { SessionV2Message, SessionV2Owner, SessionV2Payloads, TerminalBinding } from "../../../session/v2/types.js";

type Message<K extends SessionV2Message["type"]> = Extract<SessionV2Message, { type: K }>;
export type HerdrSessionStateIdentity = { owner: SessionV2Owner; sessionId: string; claimId: string };
export type HerdrCurrentSessionState = HerdrSessionState | { status: "not_registered"; protocol: typeof SESSION_V2_PROTOCOL; claimId: string; agentControlMode: "herdr" };
export class HerdrSessionHttpError extends Error {
  constructor(readonly status: number) { super(`Herdr Session request returned HTTP ${status}; read back the original identity before another write.`); this.name = "HerdrSessionHttpError"; }
}
export type HerdrSessionState = {
  status: "registered"; protocol: typeof SESSION_V2_PROTOCOL; schemaVersion: 2; projectionVersion: 1;
  sessionId: string; claimId: string; executionGeneration: string; agentControlMode: "herdr"; contentKind: "terminal_recording";
  owner: SessionV2Owner; binding: TerminalBinding; connectionEpoch: string; connected: boolean;
  capabilities: SessionV2Payloads["registration"]["capabilities"];
  control: SessionV2Payloads["control_state"] | null;
  snapshot: SessionV2Payloads["snapshot"] | null;
  ledger: SessionV2Payloads["generation_ledger"];
  archive: SessionV2Payloads["archive_status"];
  recording: { executionGeneration: string; responsibility: SessionV2Payloads["recording_responsibility"] | null; evidence: SessionV2Payloads["recording_evidence"] | null }[];
};
const same = (left: unknown, right: unknown): boolean => canonicalSessionJson(left) === canonicalSessionJson(right);
const reject = (message: string): never => { throw new Error(message); };
const fence = (message: Pick<SessionV2Message, "sessionId" | "claimId" | "executionGeneration">) => ({ protocol: SESSION_V2_PROTOCOL, schemaVersion: 2 as const, projectionVersion: 1 as const, agentControlMode: "herdr" as const, contentKind: "terminal_recording" as const, sessionId: uuid(message.sessionId), claimId: uuid(message.claimId), executionGeneration: seq(message.executionGeneration) });
const sameFence = (left: SessionV2Message, right: SessionV2Message): boolean => same(fence(left), fence(right));
const capabilities = (value: unknown) => { const c = exact(value, ["observe", "control", "archive"]); return { observe: bool(c.observe), control: bool(c.control), archive: bool(c.archive) }; };

export const parseHerdrSessionState = (value: unknown, expected: HerdrSessionStateIdentity): HerdrSessionState => {
  const o = exact(value, ["status", "protocol", "schemaVersion", "projectionVersion", "sessionId", "claimId", "executionGeneration", "agentControlMode", "contentKind", "owner", "binding", "connectionEpoch", "connected", "capabilities", "control", "snapshot", "ledger", "archive", "recording"]);
  if (o.status !== "registered" || o.protocol !== SESSION_V2_PROTOCOL || o.schemaVersion !== 2 || o.projectionVersion !== 1 || o.agentControlMode !== "herdr" || o.contentKind !== "terminal_recording") return reject("The service did not return a registered Herdr Session v2 state.");
  const owner = parseSessionV2Owner(o.owner), sessionId = uuid(o.sessionId), claimId = uuid(o.claimId), executionGeneration = seq(o.executionGeneration);
  if (!same(owner, parseSessionV2Owner(expected.owner)) || sessionId !== uuid(expected.sessionId) || claimId !== uuid(expected.claimId)) return reject("The observed Session state belongs to another original execution.");
  const base = fence({ sessionId, claimId, executionGeneration });
  const payload = <K extends SessionV2Message["type"]>(type: K, raw: unknown, generation = executionGeneration): Message<K>["payload"] => {
    const message = parseSessionV2Message({ ...base, executionGeneration: generation, type, payload: raw });
    if (message.type !== type) return reject("The Session state contains another message kind.");
    return message.payload as Message<K>["payload"];
  };
  const ledger = exact(o.ledger, ["runs", "finalizationId"]);
  const runs = Array.isArray(ledger.runs) && ledger.runs.length === 0 ? [] : parseSessionV2Runs(ledger.runs, executionGeneration, false);
  const finalizationId = nullable(ledger.finalizationId, uuid);
  if (runs.length === 0 && (executionGeneration !== "1" || finalizationId !== null) || runs.some(run => !same(run.owner, owner))) return reject("The service run ledger conflicts with original Session ownership.");
  if (finalizationId !== null && runs.some(run => run.stopProof === null)) return reject("A finalized Session cannot contain an unstopped run.");
  const binding = parseTerminalBinding(o.binding), connectionEpoch = seq(o.connectionEpoch);
  const current = runs.at(-1);
  if (current !== undefined) assertTerminalBinding(current.binding, binding);
  const control = o.control === null ? null : payload("control_state", o.control);
  const snapshot = o.snapshot === null ? null : payload("snapshot", o.snapshot);
  if (control !== null && control.connectionEpoch !== connectionEpoch || snapshot !== null && snapshot.connectionEpoch !== connectionEpoch) return reject("Session state contains a stale connection epoch.");
  if (snapshot !== null) {
    assertTerminalBinding(snapshot.binding, binding);
    if (!current?.segmentIds.includes(snapshot.segmentId)) return reject("The snapshot has no current registered segment.");
  }
  const recording = list(o.recording, value => {
    const r = exact(value, ["executionGeneration", "responsibility", "evidence"]), generation = seq(r.executionGeneration);
    if (!runs.some(run => run.executionGeneration === generation)) return reject("Recording evidence has no registered run.");
    const responsibility = r.responsibility === null ? null : payload("recording_responsibility", r.responsibility, generation);
    const evidence = r.evidence === null ? null : payload("recording_evidence", r.evidence, generation);
    if (evidence !== null && (responsibility === null || evidence.responsibilityId !== responsibility.responsibilityId)) return reject("Recording evidence belongs to another responsibility.");
    return { executionGeneration: generation, responsibility, evidence };
  });
  if (new Set(recording.map(record => record.executionGeneration)).size !== recording.length) return reject("The state repeats a recording responsibility.");
  return { status: "registered", ...base, owner, binding, connectionEpoch, connected: bool(o.connected), capabilities: capabilities(o.capabilities), control, snapshot, ledger: { runs, finalizationId }, archive: payload("archive_status", o.archive), recording };
};

/** A lost response remains unknown; the caller reconciles its persisted request before another decision. */
export const createHerdrSessionApi = (serverOrigin: string, serverToken: string, options: { fetch?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number } = {}) => {
  const targetOrigin = origin(serverOrigin);
  if (!serverToken || /[\r\n]/.test(serverToken)) return reject("A valid Worker credential is required for Herdr Session registration.");
  const timeoutMs = integer(options.timeoutMs ?? 30_000, 1, 120_000), maxResponseBytes = integer(options.maxResponseBytes ?? 4 * 1024 * 1024, 1, 8 * 1024 * 1024);
  const send = options.fetch ?? fetch;
  const request = async (target: string, body: unknown, signal?: AbortSignal, epoch?: string): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("The Herdr Session request deadline elapsed; its result must be reconciled.")), timeoutMs);
    const cancel = (): void => { controller.abort(signal?.reason); }; signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
    let response: Response | undefined;
    try {
      controller.signal.throwIfAborted();
      const headers: Record<string, string> = { authorization: `Bearer ${serverToken}`, "Daynight-Session-Protocol": SESSION_V2_PROTOCOL };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (epoch !== undefined) headers["Daynight-Connection-Epoch"] = seq(epoch);
      response = await send(`${targetOrigin}${target}`, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: canonicalSessionJson(body) }), redirect: "error", signal: controller.signal });
      if (!response.ok) throw new HerdrSessionHttpError(response.status);
      const advertised = response.headers.get("content-length");
      if (advertised !== null && (!/^\d+$/.test(advertised) || BigInt(advertised) > BigInt(maxResponseBytes))) return reject("Herdr Session response exceeds its size limit.");
      const chunks: Uint8Array[] = []; let size = 0;
      if (response.body !== null) {
        const reader = response.body.getReader();
        try {
          while (true) {
            controller.signal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength; if (size > maxResponseBytes) { await reader.cancel(); return reject("Herdr Session response exceeds its size limit."); } chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      }
      return decodeStrictSessionJson(Buffer.concat(chunks), maxResponseBytes);
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", cancel);
      if (response?.body !== null && response?.body !== undefined && !response.bodyUsed) await response.body.cancel();
    }
  };
  const prefix = (owner: SessionV2Owner): string => {
    const parsed = parseSessionV2Owner(owner);
    if (parsed.serverOrigin !== targetOrigin) return reject("The Herdr Session owner is bound to another service.");
    return `/api/v1/projects/${parsed.projectId}/tasks/${parsed.taskId}/sessions`;
  };
  return {
    verifySupport: async (signal?: AbortSignal): Promise<void> => {
      const o = exact(await request("/api/v1/session-capabilities", undefined, signal), ["protocol", "schemaVersion", "projectionVersion", "providers", "backends", "recordingResponsibilityVersion", "controlDispatchVersion", "workerCapabilitiesRequired"]);
      if (o.protocol !== SESSION_V2_PROTOCOL || o.schemaVersion !== 2 || o.projectionVersion !== 1 || o.recordingResponsibilityVersion !== 1 || o.controlDispatchVersion !== 1 || o.workerCapabilitiesRequired !== true) return reject("The service does not support the required Herdr Session v2 contract.");
      const providers = list(o.providers, value => choice(value, ["codex", "claude", "copilot"])), backends = list(o.backends, value => choice(value, ["herdr"]));
      if (["codex", "claude", "copilot"].some(provider => !providers.includes(provider as "codex" | "claude" | "copilot")) || !backends.includes("herdr")) return reject("The service does not support the required Herdr providers.");
    },
    register: async (input: Message<"registration">, signal?: AbortSignal): Promise<Message<"registration_ack">> => {
      const message = parseSessionV2Message(input); if (message.type !== "registration") return reject("Expected a persisted Herdr registration request.");
      if (Object.values(message.payload.capabilities).some(Boolean)) return reject("Lifecycle registration cannot advertise combined preview, control or recording support.");
      const result = parseSessionV2Message(await request(prefix(message.payload.owner), message, signal));
      if (result.type !== "registration_ack" || !sameFence(message, result) || result.payload.registrationId !== message.payload.registrationId) return reject("The registration acknowledgement does not match the original execution.");
      const expectedEpoch = message.payload.connectionEpoch === null ? "1" : String(BigInt(message.payload.connectionEpoch) + 1n);
      if (result.payload.connectionEpoch !== expectedEpoch) return reject("The registration acknowledgement has an unexpected connection epoch.");
      return result;
    },
    ledger: async (input: Message<"generation_ledger">, epoch: string, signal?: AbortSignal): Promise<Message<"generation_ledger">> => {
      const message = parseSessionV2Message(input); if (message.type !== "generation_ledger" || message.payload.finalizationId !== null) return reject("Expected a nonfinal Herdr generation ledger.");
      const result = parseSessionV2Message(await request(`${prefix(message.payload.runs[0]!.owner)}/${message.sessionId}/worker-messages`, message, signal, epoch));
      if (result.type !== "generation_ledger" || !same(message, result)) return reject("The generation acknowledgement differs from the original ledger decision.");
      return result;
    },
    state: async (expected: HerdrSessionStateIdentity, signal?: AbortSignal): Promise<HerdrSessionState> => parseHerdrSessionState(await request(`${prefix(expected.owner)}/${uuid(expected.sessionId)}/state`, undefined, signal), expected),
    current: async (expected: Omit<HerdrSessionStateIdentity, "sessionId">, signal?: AbortSignal): Promise<HerdrCurrentSessionState> => {
      const value = await request(`${prefix(expected.owner)}/current`, undefined, signal);
      if (!value || typeof value !== "object" || Array.isArray(value)) return reject("The current Session response is invalid.");
      const record = value as Record<string, unknown>;
      if (record.status === "registered") return parseHerdrSessionState(value, { ...expected, sessionId: uuid(record.sessionId) });
      const o = exact(value, ["status", "protocol", "claimId", "agentControlMode"]);
      if (o.status !== "not_registered" || o.protocol !== SESSION_V2_PROTOCOL || o.agentControlMode !== "herdr" || uuid(o.claimId) !== uuid(expected.claimId)) return reject("The current Session response does not identify the original unregistered claim.");
      return { status: "not_registered", protocol: SESSION_V2_PROTOCOL, claimId: expected.claimId, agentControlMode: "herdr" };
    },
  };
};
export type HerdrSessionApi = ReturnType<typeof createHerdrSessionApi>;
