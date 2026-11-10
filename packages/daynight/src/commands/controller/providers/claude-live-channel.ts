import { randomUUID } from "node:crypto";
import { NativeRpcTimeoutError } from "./native-rpc.js";
type Wire = Record<string, unknown>;
export type ClaudeIpc = { readonly connected?: boolean; send?(value: unknown, callback?: (error: Error | null) => void): unknown; on(event: "message", callback: (value: unknown) => void): unknown; off(event: "message", callback: (value: unknown) => void): unknown };
const object = (value: unknown): Wire => value && typeof value === "object" && !Array.isArray(value) ? value as Wire : {};
const errorValue = (error: unknown) => ({ message: error instanceof Error ? error.message.slice(0, 4096) : "Claude helper operation failed.", ...(error instanceof Error && "errorClass" in error ? { errorClass: String(error.errorClass) } : {}), ...(error instanceof Error && "code" in error && typeof error.code === "number" ? { code: error.code } : {}) });

/** One bounded control/media frame per RPC, with cancellation and finite in-flight state. */
export class ClaudeLiveChannel {
  private closed = false;
  private readonly waiting = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private readonly running = new Map<string, AbortController>();
  constructor(private readonly ipc: ClaudeIpc, private readonly handle: (method: string, value: unknown, signal: AbortSignal) => Promise<unknown>, private readonly failed: (error: Error) => void) { ipc.on("message", this.receive); }
  private send(value: Wire): Promise<void> {
    if (this.closed || !this.ipc.connected || !this.ipc.send) return Promise.reject(new Error("Claude helper connection is closed."));
    if (Buffer.byteLength(JSON.stringify(value)) > 1_048_576) return Promise.reject(new Error("Claude helper metadata frame exceeds its bound."));
    return new Promise((resolve, reject) => this.ipc.send!(value, error => error ? reject(error) : resolve()));
  }
  call(method: string, value: unknown = null, signal?: AbortSignal, timeout = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Claude helper connection is closed; pending results are unknown."));
    if (this.waiting.size >= 128) return Promise.reject(new Error("Claude helper request budget is unavailable."));
    signal?.throwIfAborted(); const id = randomUUID();
    const cancel = () => { const waiter = this.waiting.get(id); if (!waiter) return; this.waiting.delete(id); clearTimeout(waiter.timer); waiter.reject(new Error("Claude helper request cancelled.")); void this.send({ kind: "cancel", id }).catch(() => {}); };
    signal?.addEventListener("abort", cancel, { once: true });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new NativeRpcTimeoutError("Claude helper response is unknown.")); void this.send({ kind: "cancel", id }).catch(() => {}); }, timeout);
      this.waiting.set(id, { resolve, reject, timer });
      void this.send({ kind: "request", id, method, value }).catch(error => { this.waiting.delete(id); clearTimeout(timer); reject(error); });
    }).finally(() => signal?.removeEventListener("abort", cancel));
  }
  private receive = (raw: unknown): void => {
    if (this.closed) return;
    const message = object(raw);
    try { if (typeof message.id !== "string" || message.id.length > 128 || Buffer.byteLength(JSON.stringify(message)) > 1_048_576) throw new Error("Claude helper frame is invalid."); }
    catch (error) { this.failed(error as Error); return; }
    const id = message.id;
    if (message.kind === "cancel") { this.running.get(id)?.abort(); return; }
    if (message.kind === "response") {
      const waiter = this.waiting.get(id); if (!waiter) return; this.waiting.delete(id); clearTimeout(waiter.timer);
      if (message.error) { const value = object(message.error), error = new Error(typeof value.message === "string" ? value.message : "Claude helper operation failed."); Object.assign(error, value); waiter.reject(error); }
      else waiter.resolve(message.value);
      return;
    }
    if (message.kind !== "request" || typeof message.method !== "string" || this.running.has(id) || this.running.size >= 128) { this.failed(new Error("Claude helper request is invalid.")); return; }
    const controller = new AbortController(); this.running.set(id, controller);
    void this.handle(message.method, message.value, controller.signal).then(value => this.send({ kind: "response", id, value: value ?? null }), error => this.send({ kind: "response", id, error: errorValue(error) })).catch(error => { if (!this.closed) this.failed(error as Error); }).finally(() => this.running.delete(id));
  };
  close(error = new Error("Claude helper stopped; pending results are unknown.")): void {
    if (this.closed) return; this.closed = true; this.ipc.off("message", this.receive);
    for (const waiter of this.waiting.values()) { clearTimeout(waiter.timer); waiter.reject(error); } this.waiting.clear();
    for (const controller of this.running.values()) controller.abort(error); this.running.clear();
  }
}
