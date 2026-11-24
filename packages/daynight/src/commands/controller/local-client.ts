import { sessionBinding, sessionBindingKeys, type SessionBinding } from "../../session/protocol.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createConnection } from "node:net";
import { canonicalId } from "../../api/parse.js";
import { controllerPayloadHash, MAX_INITIAL_PROMPT_BYTES, type ControllerLaunchTicket } from "./launch-ticket.js";
import type { ControllerSnapshot, ControllerOperation } from "./lifecycle-store.js";
export const MAX_CONTROLLER_IPC_FRAME_BYTES = 5 * 1024 * 1024;
export type WorkerInputAction = { readonly kind: "submit_worker_input"; readonly operationId: string; readonly prompt: string; readonly deadline: number };
export type WorkerInputResult =
  | { readonly kind: "operation"; readonly operation: ControllerOperation }
  | { readonly kind: "waiting"; readonly reason: "initializing" | "disconnected" | "working" | "waiting_input" | "cleaning" | "unavailable" | "expired" | "task_paused" | "claim_invalid" };
export type ControllerLocalAction =
  | { readonly kind: "observe" }
  | { readonly kind: "submit_initial"; readonly operationId: string }
  | WorkerInputAction
  | { readonly kind: "cleanup"; readonly operationId: string; readonly prompt: string; readonly deadline: number }
  | { readonly kind: "stop"; readonly deadline: number };
export type ControllerLocalRequest = SessionBinding & { readonly requestId: string; readonly executionId: string; readonly executionGeneration: string; readonly controllerInstanceId: string; readonly secret: string; readonly action: ControllerLocalAction };
export type ControllerLocalResponse = { readonly requestId: string; readonly ok: true; readonly snapshot: ControllerSnapshot; readonly operation?: ControllerOperation; readonly inputResult?: WorkerInputResult; readonly workerInputProtocol?: 1; readonly recoveredInitialInputProtocol?: 1 } | { readonly requestId: string; readonly ok: false; readonly error: string };
export class ControllerIpcFrameLimitError extends Error {
  constructor(readonly actualBytes: number, readonly maxBytes: number) { super("Controller IPC request exceeds its encoded frame limit."); }
}
export const encodeControllerLocalRequest = (value: ControllerLocalRequest): string => {
  const frame = `${JSON.stringify(value)}\n`, bytes = Buffer.byteLength(frame, "utf8");
  if (bytes > MAX_CONTROLLER_IPC_FRAME_BYTES) throw new ControllerIpcFrameLimitError(bytes, MAX_CONTROLLER_IPC_FRAME_BYTES);
  return frame;
};
export const validateControllerLocalRequest = (value: unknown, ticket: ControllerLaunchTicket): ControllerLocalRequest => {
  if (typeof value !== "object" || value === null) throw new Error("Invalid controller IPC request.");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join() !== ["requestId", "executionId", ...sessionBindingKeys(ticket), "executionGeneration", "controllerInstanceId", "secret", "action"].sort().join() || typeof data.secret !== "string" || data.secret.length !== ticket.ipcSecret.length || !timingSafeEqual(Buffer.from(data.secret), Buffer.from(ticket.ipcSecret)) || data.executionId !== ticket.executionId || data.claimId !== ticket.claimId || data.testExecutionId !== ticket.testExecutionId || data.executionGeneration !== ticket.executionGeneration || data.controllerInstanceId !== ticket.controllerInstanceId || typeof data.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(data.requestId)) throw new Error("Controller IPC authentication or identity mismatch.");
  const action = data.action as Record<string, unknown> | null;
  if (typeof action !== "object" || action === null || !["observe", "submit_initial", "submit_worker_input", "cleanup", "stop"].includes(String(action.kind))) throw new Error("Unsupported controller IPC action.");
  const keys = action.kind === "observe" ? ["kind"] : action.kind === "submit_initial" ? ["kind", "operationId"] : action.kind === "stop" ? ["kind", "deadline"] : ["kind", "operationId", "prompt", "deadline"];
  if (Object.keys(action).sort().join() !== keys.sort().join()) throw new Error("Controller IPC action has invalid fields.");
  if (action.kind === "submit_initial" && (ticket.initialInput === "none" || action.operationId !== ticket.initialOperationId)) throw new Error("Controller initial operation identity mismatch.");
  if ((action.kind === "cleanup" || action.kind === "submit_initial") && (typeof action.operationId !== "string" || !/^[a-f0-9-]{36}$/.test(action.operationId))) throw new Error("Controller operation identity is invalid.");
  if (action.kind === "cleanup" && (typeof action.prompt !== "string" || action.prompt.trim() === "" || Buffer.byteLength(action.prompt) > 4 * 1024 * 1024)) throw new Error("Controller cleanup prompt is invalid.");
  if (action.kind === "submit_worker_input") {
    if (ticket.claimId === undefined || ticket.testExecutionId !== undefined) throw new Error("Worker input requires a Worker claim ticket.");
    if (typeof action.operationId !== "string" || canonicalId(action.operationId) !== action.operationId) throw new Error("Controller operation identity is invalid.");
    if (typeof action.prompt !== "string" || action.prompt.trim() === "" || !action.prompt.isWellFormed() || Buffer.byteLength(action.prompt, "utf8") > MAX_INITIAL_PROMPT_BYTES) throw new Error("Controller Worker input prompt is invalid or too large.");
  }
  if ((action.kind === "stop" || action.kind === "cleanup" || action.kind === "submit_worker_input") && (typeof action.deadline !== "number" || !Number.isSafeInteger(action.deadline) || action.deadline < 0)) throw new Error("Controller deadline is invalid.");
  encodeControllerLocalRequest(value as ControllerLocalRequest);
  return value as ControllerLocalRequest;
};
// A missing transport response cannot establish whether an authenticated action
// reached the controller. Callers may observe its journal, but must not replay it.
export class ControllerIpcOutcomeUnknownError extends Error {}
export class ControllerIpcIdentityConflictError extends Error {}

const validateWorkerInputResult = (response: ControllerLocalResponse & { ok: true }, action: WorkerInputAction, ticket: ControllerLaunchTicket): void => {
  const result = response.inputResult;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new ControllerIpcIdentityConflictError("Controller Worker input result is missing or invalid.");
  if (result.kind === "waiting") {
    if (Object.keys(result).sort().join() !== "kind,reason" || !["initializing", "disconnected", "working", "waiting_input", "cleaning", "unavailable", "expired", "task_paused", "claim_invalid"].includes(result.reason)) throw new ControllerIpcIdentityConflictError("Controller Worker input waiting result is invalid.");
    return;
  }
  if (result.kind !== "operation" || Object.keys(result).sort().join() !== "kind,operation") throw new ControllerIpcIdentityConflictError("Controller Worker input result is invalid.");
  const operation = result.operation;
  const payload = { content: [{ type: "text", text: action.prompt }], expectedTurnId: null, origin: "daynight" };
  if (!operation || typeof operation !== "object" || Array.isArray(operation) || Object.keys(operation).sort().join() !== "createdAt,error,executionGeneration,kind,operationId,payload,payloadHash,result,state,updatedAt" || operation.operationId !== action.operationId || operation.executionGeneration !== ticket.executionGeneration || operation.kind !== "worker_input" || operation.payloadHash !== controllerPayloadHash({ kind: "worker_input", payload }) || controllerPayloadHash(operation.payload) !== controllerPayloadHash(payload) || !["accepted", "offered", "dispatching", "provider_accepted", "confirmed", "failed", "rejected", "expired", "unknown"].includes(operation.state) || !(operation.error === null || typeof operation.error === "string") || !Number.isSafeInteger(operation.createdAt) || !Number.isSafeInteger(operation.updatedAt)) throw new ControllerIpcIdentityConflictError("Controller Worker input operation identity or content mismatch.");
};

export const requestController = (ticket: ControllerLaunchTicket, action: ControllerLocalAction, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ControllerLocalResponse & { ok: true }> => new Promise((resolve, reject) => {
  const request: ControllerLocalRequest = { requestId: randomUUID(), executionId: ticket.executionId, ...sessionBinding(ticket), executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, secret: ticket.ipcSecret, action };
  validateControllerLocalRequest(request, ticket);
  const frame = encodeControllerLocalRequest(request);
  const socket = createConnection(ticket.ipcEndpoint); let text = ""; let settled = false;
  const finish = (error?: unknown, result?: ControllerLocalResponse & { ok: true }): void => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); socket.destroy(); if (error !== undefined) reject(error); else resolve(result!); };
  const cancel = (): void => finish(options.signal?.reason ?? new Error("Controller IPC cancelled."));
  const timer = setTimeout(() => finish(new ControllerIpcOutcomeUnknownError("Controller IPC outcome is unknown after its deadline.")), options.timeoutMs ?? (action.kind === "submit_worker_input" ? 70_000 : 10_000));
  socket.setEncoding("utf8"); socket.once("error", cause => finish(new ControllerIpcOutcomeUnknownError("Controller IPC transport failed; outcome is unknown.", { cause }))); socket.once("end", () => { if (!settled) finish(new ControllerIpcOutcomeUnknownError("Controller IPC closed before its response; outcome is unknown.")); });
  socket.once("connect", () => socket.write(frame));
  socket.on("data", (chunk: string) => {
    text += chunk; if (Buffer.byteLength(text) > 8 * 1024 * 1024) { finish(new Error("Controller IPC response exceeds its limit.")); return; }
    const newline = text.indexOf("\n"); if (newline < 0) return;
    try {
      const response = JSON.parse(text.slice(0, newline)) as ControllerLocalResponse;
      if (response === null || typeof response !== "object" || response.requestId !== request.requestId || (response.ok !== true && response.ok !== false)) throw new ControllerIpcIdentityConflictError("Controller IPC response identity mismatch.");
      if (!response.ok) throw new Error(response.error);
      if (response.snapshot === null || typeof response.snapshot !== "object" || response.snapshot.executionId !== ticket.executionId || response.snapshot.claimId !== ticket.claimId || response.snapshot.testExecutionId !== ticket.testExecutionId || response.snapshot.executionGeneration !== ticket.executionGeneration || response.snapshot.controllerInstanceId !== ticket.controllerInstanceId || response.snapshot.sessionId !== ticket.sessionId) throw new ControllerIpcIdentityConflictError("Controller IPC snapshot fence mismatch.");
      if (action.kind === "submit_worker_input") {
        // The original v2 Controller can still report its retired capability.
        const fields = Object.keys(response).filter(key => !(ticket.schemaVersion === 2 && key === "workerLifecycleProtocol"));
        if (fields.sort().join() !== "inputResult,ok,requestId,snapshot") throw new ControllerIpcIdentityConflictError("Controller Worker input response fields are invalid.");
        validateWorkerInputResult(response, action, ticket);
      }
      if (action.kind === "observe" && Object.hasOwn(response, "workerInputProtocol") && response.workerInputProtocol !== 1) throw new ControllerIpcIdentityConflictError("Controller Worker input protocol is unsupported.");
      if (action.kind === "observe" && Object.hasOwn(response, "recoveredInitialInputProtocol") && response.recoveredInitialInputProtocol !== 1) throw new ControllerIpcIdentityConflictError("Controller recovered initial input protocol is unsupported.");
      finish(undefined, response);
    } catch (error) { finish(error); }
  });
  options.signal?.addEventListener("abort", cancel, { once: true }); if (options.signal?.aborted) cancel();
});
