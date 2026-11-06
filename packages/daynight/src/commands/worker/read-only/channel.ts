import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { validateServerToken, validateTokenTransport } from "../../../config/server-token.js";
import type { WorkerDirectoryInput, WorkerDirectoryResult } from "./directory.js";
import { parseWorkerModelInput, type WorkerModelInput, type WorkerModelResult } from "./models.js";

export const WORKER_READONLY_PROTOCOL = "daynight.worker-readonly.v1";
/** Add operations with their own input validation and bounded executor; never accept shell commands. */
export interface WorkerReadOnlyOperations {
  "directory.list": { input: WorkerDirectoryInput; result: WorkerDirectoryResult };
  "model.list": { input: WorkerModelInput; result: WorkerModelResult };
}
export type WorkerReadOnlyOperation = keyof WorkerReadOnlyOperations;
type Fence = { protocol: typeof WORKER_READONLY_PROTOCOL; ownerUserId: string; workerId: string; connectionId: string; capabilityGeneration: string };
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const codes = new Set(["permission_denied", "not_found", "timeout", "cancelled", "invalid_path", "invalid_cursor", "io_error", "limit_exceeded", "unsupported", "busy", "invalid_input", "capability_error", "cleanup_unknown", "stale_configuration"]);
const validInput = (value: unknown): value is WorkerDirectoryInput => {
  if (!record(value) || Object.keys(value).some(key => !["path", "filter", "showHidden", "cursor", "limit"].includes(key))) return false;
  for (const key of ["path", "filter", "cursor"]) if (Object.hasOwn(value, key) && (typeof value[key] !== "string" || !value[key].isWellFormed() || value[key].includes("\0") || Buffer.byteLength(value[key]) > (key === "cursor" ? 16384 : 4096))) return false;
  return (!Object.hasOwn(value, "showHidden") || typeof value.showHidden === "boolean") && (!Object.hasOwn(value, "limit") || Number.isInteger(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 100);
};

/** A connection is ephemeral. Closing or changing configuration aborts requests and discards late results. */
export const createWorkerReadOnlyChannel = (options: {
  serverOrigin: string; serverToken: string; ownerUserId: string; workerId: string;
  configurationSignature(): string;
  execute<K extends WorkerReadOnlyOperation>(operation: K, input: WorkerReadOnlyOperations[K]["input"], signal: AbortSignal): Promise<WorkerReadOnlyOperations[K]["result"]>;
  onError(message: string): void;
  onInvalidate?(): void;
}) => {
  validateTokenTransport(options.serverOrigin);
  const token = validateServerToken(options.serverToken);
  if (!uuid(options.ownerUserId) || !uuid(options.workerId)) throw new TypeError("Worker read-only identity must use canonical UUIDs.");
  let socket: WebSocket | undefined, fence: Fence | undefined, stopped = false;
  let signature = "", generation = "", lastSeen = Date.now(), retryAt = 0;
  const pending = new Map<string, { controller: AbortController; timer: NodeJS.Timeout }>();
  // Retain admission slots until the executor settles, even after cancellation.
  const executing = new Set<Promise<unknown>>();
  const detach = (): void => {
    const old = socket; socket = undefined; fence = undefined;
    options.onInvalidate?.();
    for (const item of pending.values()) { clearTimeout(item.timer); item.controller.abort(); }
    pending.clear(); retryAt = Date.now() + 5000;
    old?.terminate();
  };
  const send = (ws: WebSocket, value: unknown): void => {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > 256 * 1024 || ws.bufferedAmount > 256 * 1024) throw new Error("Worker read-only channel output exceeds its bound.");
    ws.send(encoded);
  };
  const connect = (): void => {
    if (stopped || socket !== undefined || Date.now() < retryAt) return;
    signature = options.configurationSignature(); generation = randomUUID(); lastSeen = Date.now();
    const url = new URL(`/api/v1/me/workers/${options.workerId}/readonly/channel`, options.serverOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 10000, maxPayload: 256 * 1024, followRedirects: false });
    socket = ws;
    ws.on("open", () => {
      if (socket !== ws || stopped) return;
      send(ws, { type: "hello", protocol: WORKER_READONLY_PROTOCOL, capabilityGeneration: generation, operations: ["directory.list", "model.list"] });
    });
    ws.on("error", () => { if (socket === ws) { options.onError("Worker read-only channel is unavailable; reconnecting."); detach(); } });
    ws.on("close", () => { if (socket === ws) detach(); });
    ws.on("ping", () => { if (socket === ws) lastSeen = Date.now(); });
    ws.on("message", (data, binary) => {
      if (socket !== ws || stopped) return;
      try {
        if (binary || options.configurationSignature() !== signature) throw new Error("Stale Worker read-only configuration.");
        const text = data.toString();
        if (Buffer.byteLength(text) > 256 * 1024) throw new Error("Oversized Worker read-only request.");
        const value: unknown = JSON.parse(text);
        if (!record(value) || value.protocol !== WORKER_READONLY_PROTOCOL || value.ownerUserId !== options.ownerUserId || value.workerId !== options.workerId || value.capabilityGeneration !== generation || !uuid(value.connectionId)) throw new Error("Worker read-only identity mismatch.");
        lastSeen = Date.now();
        if (value.type === "ready") {
          if (fence !== undefined) throw new Error("Repeated Worker read-only ready message.");
          fence = { protocol: WORKER_READONLY_PROTOCOL, ownerUserId: options.ownerUserId, workerId: options.workerId, connectionId: value.connectionId, capabilityGeneration: generation };
          return;
        }
        if (!fence || value.connectionId !== fence.connectionId || !uuid(value.requestId)) throw new Error("Stale Worker read-only connection.");
        const requestId = value.requestId, requestFence = { ...fence };
        if (value.type === "cancel") {
          const item = pending.get(requestId);
          if (item) { pending.delete(requestId); clearTimeout(item.timer); item.controller.abort(); }
          return;
        }
        const timeoutMs = value.operation === "model.list" ? 30000 : 10000;
        if (value.type !== "request" || pending.has(requestId) || value.timeoutMs !== timeoutMs) throw new Error("Malformed Worker read-only request.");
        const reply = (body: unknown): void => {
          if (socket === ws && fence?.connectionId === requestFence.connectionId && options.configurationSignature() === signature) send(ws, { type: "result", ...requestFence, requestId, ...body as object });
        };
        if (value.operation !== "directory.list" && value.operation !== "model.list") { reply({ error: { code: "unsupported", message: "This Worker does not support the requested read-only operation." } }); return; }
        const operationName = value.operation;
        let input: WorkerDirectoryInput | WorkerModelInput;
        if (operationName === "directory.list") {
          if (!validInput(value.input)) { reply({ error: { code: "invalid_path", message: "Directory query input is invalid." } }); return; }
          input = value.input;
        } else {
          try { input = parseWorkerModelInput(value.input); }
          catch { reply({ error: { code: "invalid_input", message: "Model query input is invalid." } }); return; }
        }
        if (executing.size >= 16) { reply({ error: { code: "busy", message: "Worker read-only request capacity is unavailable." } }); return; }
        const controller = new AbortController();
        const item = { controller, timer: setTimeout(() => {
          if (pending.get(requestId) !== item) return;
          pending.delete(requestId); controller.abort(); reply({ error: { code: "timeout", message: "Worker read-only query timed out." } });
        }, timeoutMs) };
        pending.set(requestId, item);
        let operation: Promise<WorkerDirectoryResult | WorkerModelResult>;
        try { operation = options.execute(operationName, input, controller.signal); }
        catch (error) { operation = Promise.reject(error); }
        executing.add(operation);
        void operation.then(result => {
          if (pending.get(requestId) !== item) return;
          const entries = operationName === "directory.list" ? (result as WorkerDirectoryResult).entries : (result as WorkerModelResult).models;
          if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024 || entries.length > 100) reply({ error: { code: "limit_exceeded", message: "Read-only result exceeds its limit." } });
          else reply({ result });
        }, error => {
          const code = record(error) && typeof error.code === "string" && codes.has(error.code) ? error.code : "io_error";
          // Cleanup can finish after cancellation removed the response waiter.
          // Its owner still retains the proof; keep the failure observable too.
          if (code === "cleanup_unknown") options.onError("Worker model probe cleanup remains unconfirmed (cleanup_unknown).");
          if (pending.get(requestId) !== item) return;
          // Do not expose native exception text, filesystem details or credentials.
          reply({ error: { code, message: `Worker read-only query failed (${code}).` } });
        }).catch(() => { if (socket === ws) detach(); }).finally(() => {
          executing.delete(operation); clearTimeout(item.timer);
          if (pending.get(requestId) === item) pending.delete(requestId);
        });
      } catch { options.onError("Worker read-only channel received an invalid or stale frame."); detach(); }
    });
  };
  const timer = setInterval(() => {
    if (socket && (options.configurationSignature() !== signature || Date.now() - lastSeen > (fence ? 30000 : 10000))) detach();
    connect();
  }, 500);
  timer.unref();
  connect();
  return {
    connected: (): boolean => fence !== undefined,
    close: (): void => { if (stopped) return; stopped = true; clearInterval(timer); detach(); },
  };
};
