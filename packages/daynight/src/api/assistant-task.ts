import { randomUUID } from "node:crypto";
import { validateServerToken, validateTokenTransport } from "../config/server-token.js";
import type { Operation } from "./operation.js";
import { fields, malformed, text, timestamp } from "./validation.js";
import * as P from "./assistant-task-parse.js";
import type * as T from "./assistant-task-types.js";
export * from "./assistant-task-types.js";
export * from "./assistant-task-parse.js";

// Do not retain response or transport causes: either can echo credentials.
export class AssistantTaskApiError extends Error {
  constructor(readonly outcomeUnconfirmed: boolean, readonly code?: string, readonly status?: number, readonly confirmedRefusal = false, readonly details?: { holderBotId?: string; claimGeneration?: string; leaseUntil?: string }) {
    super(`Assistant task request failed${code === undefined ? "." : ` (${code}).`}${details?.holderBotId === undefined ? "" : ` Holder: ${details.holderBotId}; generation: ${details.claimGeneration}; lease: ${details.leaseUntil}.`}${status === 401 ? " Run daynight login to authenticate." : ""}${outcomeUnconfirmed ? " Write outcome is unknown. Use daynight assistant-task show and read the original operation before deciding another write; the request was not retried." : ""}`);
    this.name = "AssistantTaskApiError";
  }
}
export type AssistantTaskClientOptions = {
  serverUrl: string; serverToken?: string; expectedUserId: string; botId?: string; operation: Operation; fetch?: typeof globalThis.fetch;
};
export const createAssistantTaskClient = (options: AssistantTaskClientOptions) => {
  const origin = new URL(options.serverUrl);
  if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("serverUrl must be an HTTP(S) service origin.");
  const token = options.serverToken === undefined ? undefined : validateServerToken(options.serverToken);
  if (token !== undefined) validateTokenTransport(origin.origin);
  const ownerId = P.assistantTaskId(options.expectedUserId), botId = options.botId === undefined ? undefined : P.assistantTaskId(options.botId);
  const request = async <V>(path: string, method: string, body: unknown, parse: (value: unknown) => V): Promise<V> => {
    const operation = options.operation;
    let dispatched = false, response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let detachAbort: (() => void) | undefined;
    const controller = new AbortController();
    const mutable = method !== "GET";
    try {
      operation.check();
      const payload = body === undefined ? undefined : P.stringifyAssistantTaskJson(body);
      if (payload !== undefined && Buffer.byteLength(payload) > 1024 * 1024) throw new AssistantTaskApiError(false, "request_limit");
      const cancel = () => controller.abort();
      operation.signal.addEventListener("abort", cancel, { once: true });
      const remaining = Math.min(operation.remainingMs(), operation.limits.requestMs);
      timer = setTimeout(cancel, remaining); timer.unref();
      const aborted = new Promise<never>((_resolve, reject) => {
        const fail = () => reject(new AssistantTaskApiError(mutable && dispatched, "request_cancelled"));
        controller.signal.addEventListener("abort", fail, { once: true });
        detachAbort = () => { controller.signal.removeEventListener("abort", fail); operation.signal.removeEventListener("abort", cancel); };
      });
      operation.check();
      if (controller.signal.aborted) throw new AssistantTaskApiError(false, "request_cancelled");
      dispatched = true;
      response = await Promise.race([(options.fetch ?? globalThis.fetch)(new URL(`/api/v1${path}`, origin), {
        method, headers: { Accept: "application/json", "X-Request-ID": randomUUID(), ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }), ...(botId === undefined ? {} : { "X-Daynight-Bot-Id": botId }), ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(payload === undefined ? {} : { body: payload }), redirect: "manual", cache: "no-store", signal: controller.signal,
      }), aborted]);
      const principal = response.headers.get("Daynight-User-ID");
      if (response.status !== 401 && principal !== ownerId || response.status === 401 && principal !== null && principal !== ownerId) throw new AssistantTaskApiError(mutable, "identity_mismatch", response.status);
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw new AssistantTaskApiError(mutable, "invalid_response", response.status);
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const chunks: string[] = []; let bytes = 0;
      if (response.body !== null) {
        reader = response.body.getReader();
        while (true) {
          operation.check();
          const part = await Promise.race([reader.read(), aborted]);
          if (part.done) break;
          bytes += part.value.byteLength;
          operation.consume(part.value.byteLength);
          if (bytes > operation.limits.responseBytes) throw new AssistantTaskApiError(mutable, "response_limit", response.status);
          chunks.push(decoder.decode(part.value, { stream: true }));
        }
      }
      operation.check();
      chunks.push(decoder.decode());
      const source = chunks.join("");
      const value = P.parseAssistantTaskJson(source);
      const secrets = [token, body !== null && typeof body === "object" && "claimToken" in body ? body.claimToken : undefined].filter((secret): secret is string => typeof secret === "string" && secret.length > 0);
      const containsSecret = (v: unknown): boolean => typeof v === "string" ? secrets.some(secret => v.includes(secret)) : Array.isArray(v) ? v.some(containsSecret) : v !== null && typeof v === "object" ? Object.entries(v).some(([k, x]) => containsSecret(k) || containsSecret(x)) : false;
      if (containsSecret(value)) throw new AssistantTaskApiError(mutable, "invalid_response", response.status);
      if (response.status !== 200) {
        let code: string | undefined;
        let details: { holderBotId?: string; claimGeneration?: string; leaseUntil?: string } | undefined;
        try {
          const error = fields(fields(value, ["error"]).error, ["code", "message", "requestId", "details"]);
          const candidate = text(error.code);
          // Only fixed codes are safe when the endpoint has received a secret.
          if (["invalid_input", "unauthorized", "forbidden", "not_found", "task_deleted", "version_conflict", "claim_held", "claim_lost", "operation_conflict", "claim_outcome_unknown", "write_outcome_unknown", "internal_error", "already_exists", "proposal_conflict", "inquiry_closed", "identity_mismatch", "task_paused", "invalid_transition", "version_exhausted"].includes(candidate)) code = candidate;
          text(error.message); text(error.requestId);
          if (error.details !== undefined) {
            const d = fields(error.details, ["holderBotId", "claimGeneration", "leaseUntil"]);
            details = { ...(d.holderBotId === undefined ? {} : { holderBotId: P.assistantTaskId(d.holderBotId) }), ...(d.claimGeneration === undefined ? {} : { claimGeneration: P.assistantTaskInteger(d.claimGeneration, true) }), ...(d.leaseUntil === undefined ? {} : { leaseUntil: timestamp(d.leaseUntil) }) };
          }
        } catch { code = undefined; details = undefined; }
        const refused = code !== undefined && response.status >= 400 && response.status < 500;
        throw new AssistantTaskApiError(mutable && !refused, code ?? "invalid_response", response.status, refused, details);
      }
      return parse(value);
    } catch (error) {
      if (error instanceof AssistantTaskApiError) throw error;
      throw new AssistantTaskApiError(mutable && dispatched, response === undefined ? "request_failed" : "invalid_response", response?.status);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      detachAbort?.();
      controller.abort();
      if (reader !== undefined) { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
      else if (response?.body !== null && response?.body !== undefined) void response.body.cancel().catch(() => undefined);
    }
  };
  const taskPath = (taskId: string) => `/assistant-tasks/${P.assistantTaskId(taskId)}`;
  const entryPath = (taskId: string, collection: string, id: string) => `${taskPath(taskId)}/${collection}/${P.assistantTaskId(id)}`;
  const queryPath = (path: string, query: T.AssistantTaskQuery = {}) => {
    const params = new URLSearchParams();
    if (query.limit !== undefined) { if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200) throw new Error("limit must be an integer from 1 to 200."); params.set("limit", String(query.limit)); }
    for (const key of ["cursor", "state", "itemId", "targetBotId"] as const) if (query[key] !== undefined) params.set(key, key.endsWith("Id") ? P.assistantTaskId(query[key]) : text(query[key], true));
    return params.size === 0 ? path : `${path}?${params}`;
  };
  const list = <V>(path: string, query: T.AssistantTaskQuery | undefined, parse: (value: unknown) => V) => request(queryPath(path, query), "GET", undefined, v => P.parseAssistantTaskPage(v, parse));
  return {
    getTask: (taskId: string) => request(taskPath(taskId), "GET", undefined, v => P.parseAssistantTask(v, taskId, ownerId)),
    listTasks: (query?: T.AssistantTaskQuery) => list("/assistant-tasks", query, v => P.parseAssistantTask(v, undefined, ownerId)),
    createTask: (input: T.CreateAssistantTaskInput) => request("/assistant-tasks", "POST", input, v => P.parseAssistantTask(v, input.id, ownerId)),
    updateTask: (taskId: string, input: T.UpdateAssistantTaskInput) => request(taskPath(taskId), "PATCH", input, v => P.parseAssistantTask(v, taskId, ownerId)),
    deleteTask: (taskId: string, ifVersion: string) => request(taskPath(taskId), "DELETE", { ifVersion }, v => P.parseAssistantTask(v, taskId, ownerId)),
    claim: (taskId: string, kind: T.AssistantTaskClaimKind, input: T.AssistantTaskClaimInput) => {
      if (!["claim", "transfer", "bind", "renew", "release"].includes(kind)) return Promise.reject(new Error("Invalid claim operation kind."));
      const requestFingerprint = P.assistantTaskClaimFingerprint({ ...input, kind, ownerUserId: ownerId, taskId, actorBotId: botId ?? null });
      return request(`${taskPath(taskId)}/${kind === "bind" ? "claim/bind" : kind}`, "POST", input, v => {
        const result = P.parseAssistantTaskClaimResult(v, taskId, input.operationId, { kind, actorBotId: botId ?? null, requestFingerprint });
        const generation = BigInt(kind === "renew" ? input.claimGeneration! : input.expectedGeneration!);
        if (BigInt(result.operation.resultingGeneration) !== generation + (["claim", "transfer", "release"].includes(kind) ? 1n : 0n) || kind === "transfer" && result.operation.holderBotId !== input.targetBotId) return malformed();
        return result;
      });
    },
    getClaimOperation: (taskId: string, operationId: string, expected?: T.AssistantTaskClaimExpectation) => request(entryPath(taskId, "claim-operations", operationId), "GET", undefined, v => P.parseAssistantTaskClaimResult(v, taskId, operationId, expected)),
    getManual: (taskId: string, version?: string) => request(`${taskPath(taskId)}/manual${version === undefined ? "" : `/versions/${P.assistantTaskInteger(version)}`}`, "GET", undefined, v => P.parseAssistantTaskManual(v, taskId, version)),
    listManuals: (taskId: string, query?: T.AssistantTaskQuery) => list(`${taskPath(taskId)}/manual/versions`, query, v => P.parseAssistantTaskManual(v, taskId)),
    rollback: (taskId: string, input: { ifVersion: string; manualVersion: string }) => request(`${taskPath(taskId)}/manual/rollback`, "POST", input, v => P.parseAssistantTaskManual(v, taskId)),
    listAppendix: (taskId: string, query?: T.AssistantTaskQuery) => list(`${taskPath(taskId)}/appendix`, query, v => P.parseAssistantTaskAppendix(v, taskId)),
    addAppendix: (taskId: string, input: T.AddAssistantTaskAppendixInput) => request(`${taskPath(taskId)}/appendix`, "POST", input, v => P.parseAssistantTaskAppendix(v, taskId, input.id)),
    updateAppendix: (taskId: string, id: string, input: T.UpdateAssistantTaskAppendixInput) => request(entryPath(taskId, "appendix", id), "PATCH", input, v => P.parseAssistantTaskAppendix(v, taskId, id)),
    deleteAppendix: (taskId: string, id: string, ifVersion: string) => request(entryPath(taskId, "appendix", id), "DELETE", { ifVersion }, v => P.parseAssistantTaskAppendix(v, taskId, id)),
    listProposals: (taskId: string, query?: T.AssistantTaskQuery) => list(`${taskPath(taskId)}/proposals`, query, v => P.parseAssistantTaskProposal(v, taskId)),
    propose: (taskId: string, input: T.ProposeAssistantTaskInput): Promise<T.AssistantTaskProposalResult> => request(`${taskPath(taskId)}/proposals`, "POST", input, v => { const d = fields(v, ["proposal", "rejectedMatches"]); if (!Array.isArray(d.rejectedMatches)) return malformed(); return { proposal: P.parseAssistantTaskProposal(d.proposal, taskId, input.id), rejectedMatches: d.rejectedMatches.map(x => P.parseAssistantTaskProposal(x, taskId)) }; }),
    decide: (taskId: string, id: string, input: T.DecideAssistantTaskInput) => request(`${entryPath(taskId, "proposals", id)}/decision`, "POST", input, v => P.parseAssistantTaskProposal(v, taskId, id)),
    listItems: (taskId: string, query?: T.AssistantTaskQuery) => list(`${taskPath(taskId)}/items`, query, v => P.parseAssistantTaskItem(v, taskId)),
    getItem: (taskId: string, id: string) => request(entryPath(taskId, "items", id), "GET", undefined, v => P.parseAssistantTaskItem(v, taskId, id)),
    saveItem: (taskId: string, input: T.SaveAssistantTaskItemInput, id?: string) => request(id === undefined ? `${taskPath(taskId)}/items` : entryPath(taskId, "items", id), id === undefined ? "POST" : "PATCH", input, v => P.parseAssistantTaskItem(v, taskId, id ?? input.id)),
    listRecords: (taskId: string, query?: T.AssistantTaskQuery) => list(`${taskPath(taskId)}/records`, query, v => P.parseAssistantTaskRecord(v, taskId)),
    addRecord: (taskId: string, input: T.AddAssistantTaskRecordInput) => request(`${taskPath(taskId)}/records`, "POST", input, v => P.parseAssistantTaskRecord(v, taskId, input.id)),
    listEvents: (taskId?: string, query?: T.AssistantTaskQuery) => list(taskId === undefined ? "/assistant-task-events" : `${taskPath(taskId)}/events`, query, v => P.parseAssistantTaskEvent(v, taskId)),
    addEvent: (taskId: string, input: T.AddAssistantTaskEventInput) => request(`${taskPath(taskId)}/events`, "POST", input, v => P.parseAssistantTaskEvent(v, taskId, input.id)),
    ackEvent: (taskId: string, id: string, input: { operationId: string; state?: "delivered" | "expired" }) => request(`${entryPath(taskId, "events", id)}/ack`, "POST", input, v => { const event = P.parseAssistantTaskEvent(v, taskId, id); if (event.ackOperationId !== input.operationId) return malformed(); return event; }),
    clearAttention: (targetBotId: string) => request("/assistant-task-events/attention", "POST", { targetBotId }, v => { const d = fields(v, ["targetBotId"]); if (P.assistantTaskId(d.targetBotId) !== targetBotId) return malformed(); return { targetBotId }; }),
    listInquiries: (taskId: string, query?: T.AssistantTaskQuery) => list(`${taskPath(taskId)}/inquiries`, query, v => P.parseAssistantTaskInquiry(v, taskId)),
    ask: (taskId: string, input: T.AskAssistantTaskInput) => request(`${taskPath(taskId)}/inquiries`, "POST", input, v => P.parseAssistantTaskInquiry(v, taskId, input.id)),
    answer: (taskId: string, id: string, input: T.AssistantTaskCredential & { answer: string }) => request(`${entryPath(taskId, "inquiries", id)}/answer`, "POST", input, v => P.parseAssistantTaskInquiry(v, taskId, id)),
  };
};
export type AssistantTaskClient = ReturnType<typeof createAssistantTaskClient>;
