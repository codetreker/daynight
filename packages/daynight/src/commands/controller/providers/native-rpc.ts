import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { EventEmitter } from "node:events";

export type NativeObject = Record<string, unknown>;
export const record = (value: unknown): NativeObject => typeof value === "object" && value !== null && !Array.isArray(value) ? value as NativeObject : {};
export const string = (value: unknown): string => typeof value === "string" ? value : "";
export class NativeRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}
export class NativeRpc {
  private readonly lines: Interface;
  private sequence = 0;
  private closed = false;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  constructor(private readonly child: EventEmitter & { stdin: Writable; stdout: Readable }, onMessage: (value: NativeObject) => void, private readonly timeout = 30_000) {
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", line => {
      if (Buffer.byteLength(line) > 16 * 1024 * 1024) { this.fail(new Error("Native protocol frame exceeds limit.")); return; }
      let message: NativeObject;
      try { message = record(JSON.parse(line)); } catch { this.fail(new Error("Invalid native protocol frame.")); return; }
      if (typeof message.method === "string") { onMessage(message); return; }
      if (typeof message.id !== "number") return;
      const waiter = this.pending.get(message.id); if (!waiter) return;
      clearTimeout(waiter.timer); this.pending.delete(message.id);
      if (message.error !== undefined) { const error = record(message.error); waiter.reject(new NativeRpcError(typeof error.code === "number" ? error.code : -1, string(error.message) || "Native operation rejected.")); }
      else waiter.resolve(message.result);
    });
    child.once("error", error => this.fail(error));
    child.once("close", () => this.fail(new Error("Native process closed; unconfirmed operations remain unknown.")));
    child.stdin.on("error", error => this.fail(error));
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Native process is closed."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Native ${method} response timed out; result is unknown.`)); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method: string, params?: unknown): void { this.write({ method, ...(params === undefined ? {} : { params }) }); }
  respond(id: unknown, result: unknown): void { this.write({ id, result }); }
  reject(id: unknown, message: string): void { this.write({ id, error: { code: -32601, message } }); }
  private write(value: unknown): void { if (this.closed) throw new Error("Native process is closed."); this.child.stdin.write(JSON.stringify(value) + "\n"); }
  private fail(error: Error): void { this.closed = true; for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); } this.pending.clear(); }
  dispose(): void { this.fail(new Error("Native transport closed.")); this.lines.close(); }
}
