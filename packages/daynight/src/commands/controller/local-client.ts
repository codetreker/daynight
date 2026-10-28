import { sessionBinding, sessionBindingKeys, type SessionBinding } from "../../session/protocol.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createConnection } from "node:net";
import type { ControllerLaunchTicket } from "./launch-ticket.js";
import type { ControllerSnapshot, ControllerOperation } from "./lifecycle-store.js";
export type ControllerLocalAction =
  | { readonly kind: "observe" }
  | { readonly kind: "submit_initial"; readonly operationId: string }
  | { readonly kind: "cleanup"; readonly operationId: string; readonly prompt: string; readonly deadline: number }
  | { readonly kind: "stop"; readonly deadline: number };
export type ControllerLocalRequest = SessionBinding & { readonly requestId: string; readonly executionId: string; readonly executionGeneration: string; readonly controllerInstanceId: string; readonly secret: string; readonly action: ControllerLocalAction };
export type ControllerLocalResponse = { readonly requestId: string; readonly ok: true; readonly snapshot: ControllerSnapshot; readonly operation?: ControllerOperation } | { readonly requestId: string; readonly ok: false; readonly error: string };
export const validateControllerLocalRequest = (value: unknown, ticket: ControllerLaunchTicket): ControllerLocalRequest => {
  if (typeof value !== "object" || value === null) throw new Error("Invalid controller IPC request.");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join() !== ["requestId", "executionId", ...sessionBindingKeys(ticket), "executionGeneration", "controllerInstanceId", "secret", "action"].sort().join() || typeof data.secret !== "string" || data.secret.length !== ticket.ipcSecret.length || !timingSafeEqual(Buffer.from(data.secret), Buffer.from(ticket.ipcSecret)) || data.executionId !== ticket.executionId || data.claimId !== ticket.claimId || data.testExecutionId !== ticket.testExecutionId || data.executionGeneration !== ticket.executionGeneration || data.controllerInstanceId !== ticket.controllerInstanceId || typeof data.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(data.requestId)) throw new Error("Controller IPC authentication or identity mismatch.");
  const action = data.action as Record<string, unknown> | null;
  if (typeof action !== "object" || action === null || !["observe", "submit_initial", "cleanup", "stop"].includes(String(action.kind))) throw new Error("Unsupported controller IPC action.");
  const keys = action.kind === "observe" ? ["kind"] : action.kind === "submit_initial" ? ["kind", "operationId"] : action.kind === "stop" ? ["kind", "deadline"] : ["kind", "operationId", "prompt", "deadline"];
  if (Object.keys(action).sort().join() !== keys.sort().join()) throw new Error("Controller IPC action has invalid fields.");
  if (action.kind === "submit_initial" && (ticket.initialInput === "none" || action.operationId !== ticket.initialOperationId)) throw new Error("Controller initial operation identity mismatch.");
  if ((action.kind === "cleanup" || action.kind === "submit_initial") && (typeof action.operationId !== "string" || !/^[a-f0-9-]{36}$/.test(action.operationId))) throw new Error("Controller operation identity is invalid.");
  if (action.kind === "cleanup" && (typeof action.prompt !== "string" || action.prompt.trim() === "" || Buffer.byteLength(action.prompt) > 4 * 1024 * 1024)) throw new Error("Controller cleanup prompt is invalid.");
  if ((action.kind === "stop" || action.kind === "cleanup") && (typeof action.deadline !== "number" || !Number.isSafeInteger(action.deadline) || action.deadline < 0)) throw new Error("Controller deadline is invalid.");
  return value as ControllerLocalRequest;
};
// A missing transport response cannot establish whether an authenticated action
// reached the controller. Callers may observe its journal, but must not replay it.
export class ControllerIpcOutcomeUnknownError extends Error {}

export const requestController = (ticket: ControllerLaunchTicket, action: ControllerLocalAction, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ControllerLocalResponse & { ok: true }> => new Promise((resolve, reject) => {
  const request: ControllerLocalRequest = { requestId: randomUUID(), executionId: ticket.executionId, ...sessionBinding(ticket), executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, secret: ticket.ipcSecret, action };
  validateControllerLocalRequest(request, ticket);
  const socket = createConnection(ticket.ipcEndpoint); let text = ""; let settled = false;
  const finish = (error?: unknown, result?: ControllerLocalResponse & { ok: true }): void => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); socket.destroy(); if (error !== undefined) reject(error); else resolve(result!); };
  const cancel = (): void => finish(options.signal?.reason ?? new Error("Controller IPC cancelled."));
  const timer = setTimeout(() => finish(new ControllerIpcOutcomeUnknownError("Controller IPC outcome is unknown after its deadline.")), options.timeoutMs ?? 10000);
  socket.setEncoding("utf8"); socket.once("error", cause => finish(new ControllerIpcOutcomeUnknownError("Controller IPC transport failed; outcome is unknown.", { cause }))); socket.once("end", () => { if (!settled) finish(new ControllerIpcOutcomeUnknownError("Controller IPC closed before its response; outcome is unknown.")); });
  socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  socket.on("data", (chunk: string) => {
    text += chunk; if (Buffer.byteLength(text) > 8 * 1024 * 1024) { finish(new Error("Controller IPC response exceeds its limit.")); return; }
    const newline = text.indexOf("\n"); if (newline < 0) return;
    try {
      const response = JSON.parse(text.slice(0, newline)) as ControllerLocalResponse;
      if (response.requestId !== request.requestId || (response.ok !== true && response.ok !== false)) throw new Error("Controller IPC response identity mismatch.");
      if (!response.ok) throw new Error(response.error);
      if (response.snapshot.executionId !== ticket.executionId || response.snapshot.claimId !== ticket.claimId || response.snapshot.testExecutionId !== ticket.testExecutionId || response.snapshot.executionGeneration !== ticket.executionGeneration || response.snapshot.controllerInstanceId !== ticket.controllerInstanceId) throw new Error("Controller IPC snapshot fence mismatch.");
      finish(undefined, response);
    } catch (error) { finish(error); }
  });
  options.signal?.addEventListener("abort", cancel, { once: true }); if (options.signal?.aborted) cancel();
});
