import { createApiClient } from "../../api/client.js";
import { createAssistantTaskClient } from "../../api/assistant-task.js";
import type { AssistantTaskClaimKind } from "../../api/assistant-task-types.js";
import { createOperation } from "../../api/operation.js";
import { lifecycleId, lifecycleVersion } from "../../api/worker-lifecycle.js";
import { fields } from "../../api/validation.js";
import { jsonObjectSources } from "../../api/json-source.js";
import { normalizeServerUrl } from "../../config/server.js";
import { validateServerToken, validateTokenTransport } from "../../config/server-token.js";
import { assertSessionFence, parseSessionOperation, type SessionOperation } from "../../session/protocol.js";
import type { LifecycleIdentity, LifecycleJson, LifecycleResource } from "./lifecycle-store.js";
import type { LifecycleReservationSettlement } from "./lifecycle-context.js";

export type LifecycleRequestRecovery =
  | { kind: "settled"; stage: "confirmed" | "not_dispatched"; receipt: LifecycleJson }
  | { kind: "pending"; reasonCode: "missing_identity" | "no_result_protocol" | "receipt_unavailable" | "operation_pending" | "receipt_conflict"; receipt?: LifecycleJson };
const pending = (reasonCode: Extract<LifecycleRequestRecovery, { kind: "pending" }>["reasonCode"]): LifecycleRequestRecovery => ({ kind: "pending", reasonCode });
const fingerprint = (value: unknown): string => { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Original request fingerprint is missing."); return value; };
const json = (value: unknown): LifecycleJson => JSON.parse(JSON.stringify(value)) as LifecycleJson;

/** Dispatch acknowledgement is not native stop evidence; the native owner remains independently responsible. */
export const classifyLifecycleSessionOperation = (input: SessionOperation): LifecycleReservationSettlement => {
  const operation = parseSessionOperation(input);
  const receipt: LifecycleJson = { kind: "session_operation", sessionId: operation.sessionId, operationId: operation.operationId, executionGeneration: operation.executionGeneration,
    ...(operation.claimId === undefined ? { testExecutionId: operation.testExecutionId } : { claimId: operation.claimId }),
    operationKind: operation.kind, state: operation.state, providerResult: operation.providerResult, errorCode: operation.error?.code ?? null };
  if (operation.state === "rejected" || operation.state === "expired") return { stage: "not_dispatched", receipt };
  if (["confirmed", "failed", "provider_accepted"].includes(operation.state)) return { stage: "confirmed", receipt };
  return { stage: "unknown", receipt };
};
const sessionResult = (operation: SessionOperation): LifecycleRequestRecovery => {
  const result = classifyLifecycleSessionOperation(operation);
  return result.stage === "unknown" ? { kind: "pending", reasonCode: "operation_pending", receipt: result.receipt! } : { kind: "settled", stage: result.stage, receipt: result.receipt! };
};

/** Only original result protocols can close an unknown external reservation. Resource equality is not a receipt. */
export const reconcileLifecycleRequest = async (options: { resource: LifecycleResource; identity: LifecycleIdentity; serverToken: string; signal: AbortSignal; fetch?: typeof globalThis.fetch }): Promise<LifecycleRequestRecovery> => {
  const { resource } = options, source = resource.identity;
  if (resource.ownerKind !== "assistant" || resource.processProof !== null) return pending("missing_identity");
  const kind = source.kind;
  if (!["assistant_api", "assistant_input", "watchdog_input"].includes(String(kind))) return pending("no_result_protocol");
  if (kind === "assistant_api" && !["claim", "ackEvent", "enableInbox", "disableInbox", "rotateInbox"].includes(String(source.method))) return pending("no_result_protocol");
  let operationId: string, botId: string | undefined, assistantTaskId: string | undefined, sessionId: string | undefined, executionGeneration: string | undefined, executionId: string | undefined, projectId: string | undefined, taskId: string | undefined, claimId: string | undefined;
  try {
    operationId = lifecycleId(resource.operationId);
    if (kind === "assistant_api") {
      assistantTaskId = lifecycleId(source.assistantTaskId);
      if (source.botId !== null) botId = lifecycleId(source.botId);
      if (source.method === "claim") { if (!["claim", "transfer", "bind", "renew", "release"].includes(String(source.claimKind))) return pending("missing_identity"); fingerprint(source.requestFingerprint); }
      else if (source.method === "ackEvent") { lifecycleId(source.eventId); if (botId === undefined || !["delivered", "expired"].includes(String(source.eventState))) return pending("missing_identity"); }
      else { fingerprint(source.requestFingerprint); if (!["inbox_enable", "inbox_disable", "inbox_rotate_overlap", "inbox_rotate_immediate"].includes(String(source.inboxKind))) return pending("missing_identity"); }
    } else {
      sessionId = lifecycleId(source.sessionId); executionGeneration = lifecycleVersion(source.executionGeneration);
      if (kind === "assistant_input") { botId = lifecycleId(source.botId); executionId = lifecycleId(source.executionId); }
      else { projectId = lifecycleId(source.projectId); taskId = lifecycleId(source.taskId); claimId = lifecycleId(source.claimId); }
    }
  } catch { return pending("missing_identity"); }
  const operation = createOperation({ signal: options.signal, limits: { totalMs: 10_000, requestMs: 10_000, responseBytes: 256 * 1024, totalBytes: 1024 * 1024 } });
  let detachAbort = (): void => {};
  try {
    operation.check();
    const common = { serverUrl: options.identity.serverOrigin, serverToken: options.serverToken, expectedUserId: options.identity.userId, operation, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) };
    if (kind === "assistant_api") {
      const api = createAssistantTaskClient({ ...common, ...(botId === undefined ? {} : { botId }) });
      if (source.method === "claim") {
        const result = await api.getClaimOperation(assistantTaskId!, operationId, { kind: source.claimKind as AssistantTaskClaimKind, actorBotId: botId ?? null, requestFingerprint: fingerprint(source.requestFingerprint) });
        return { kind: "settled", stage: "confirmed", receipt: { kind: "assistant_claim_operation", operation: json(result.operation) } };
      }
      if (source.method !== "ackEvent") {
        const result = await api.getInboxOperation(assistantTaskId!, operationId);
        if (result.operation.kind !== source.inboxKind || result.operation.requestFingerprint !== source.requestFingerprint) return pending("receipt_conflict");
        return { kind: "settled", stage: "confirmed", receipt: { kind: "assistant_inbox_operation", operation: json(result.operation) } };
      }
      const cursors = new Set<string>(); let cursor: string | undefined;
      for (;;) {
        operation.check();
        const page = await api.listEvents(assistantTaskId!, { limit: 200, ...(cursor === undefined ? {} : { cursor }) });
        const event = page.items.find(event => event.id === source.eventId);
        if (event !== undefined) {
          if (event.targetBotId !== botId || event.ackOperationId !== operationId || event.state !== source.eventState) return pending("receipt_conflict");
          return { kind: "settled", stage: "confirmed", receipt: { kind: "assistant_event_ack", taskId: event.taskId, eventId: event.id, targetBotId: event.targetBotId, operationId, state: event.state } };
        }
        if (page.nextCursor === null || cursors.has(page.nextCursor)) return pending("receipt_unavailable");
        cursor = page.nextCursor; cursors.add(cursor);
      }
    }
    if (kind === "watchdog_input") {
      const result = await createApiClient(common).readTaskSessionOperation({ projectId: projectId!, taskId: taskId!, sessionId: sessionId!, operationId }, { claimId: claimId!, executionGeneration: executionGeneration!, kind: "send_message" }, 10_000);
      return sessionResult(result.operation);
    }
    const origin = normalizeServerUrl(options.identity.serverOrigin), token = validateServerToken(options.serverToken); validateTokenTransport(origin);
    // The public Test Session result endpoint reads an original execution without
    // adopting a current Bot holder or renewing its application lease.
    const aborted = new Promise<never>((_, reject) => {
      const abort = (): void => reject(operation.signal.reason);
      operation.signal.addEventListener("abort", abort, { once: true });
      detachAbort = () => operation.signal.removeEventListener("abort", abort);
      if (operation.signal.aborted) abort();
    });
    operation.check();
    const response = await Promise.race([(options.fetch ?? globalThis.fetch)(`${origin}/api/v1/test-sessions/${sessionId!}/operations/${operationId}`, { method: "GET", redirect: "manual", cache: "no-store", signal: operation.signal, headers: { authorization: `Bearer ${token}`, accept: "application/json" } }).then(response => {
      if (operation.signal.aborted) { void response.body?.cancel().catch(() => {}); operation.check(); }
      return response;
    }), aborted]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      operation.check();
      if (response.status !== 200 || response.headers.get("Daynight-User-ID") !== options.identity.userId || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || response.body === null) return pending("receipt_unavailable");
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const part = await Promise.race([reader.read(), aborted]); operation.check(); if (part.done) break; size += part.value.byteLength; if (size > 65_536) return pending("receipt_unavailable"); operation.consume(part.value.byteLength); chunks.push(part.value); }
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); if (raw.includes(token)) return pending("receipt_unavailable"); jsonObjectSources(raw);
      const result = parseSessionOperation(fields(JSON.parse(raw), ["operation"]).operation);
      assertSessionFence(result, { sessionId: sessionId!, testExecutionId: executionId!, executionGeneration: executionGeneration! });
      if (result.operationId !== operationId || result.kind !== "send_message") return pending("receipt_conflict");
      return sessionResult(result);
    } finally {
      if (reader !== undefined) { const originalReader = reader; void originalReader.cancel().catch(() => {}).finally(() => { try { originalReader.releaseLock(); } catch { /* Preserve the original result when cancellation remains pending. */ } }); }
      else if (response.body !== null) void response.body.cancel().catch(() => {});
    }
  } catch { return pending("receipt_unavailable"); }
  finally { detachAbort(); operation.dispose(); }
};
