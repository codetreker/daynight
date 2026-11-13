import type { Readable, Writable } from "node:stream";
import type { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { CodexJsonDecoder, type CodexRpcLimits, type CodexSpoolFactory } from "./codex-rpc-json.js";
import { NativeRpcError, NativeRpcTimeoutError, record, string, type NativeObject } from "./native-rpc.js";

export type CodexRpcOptions = {
  createSpool: CodexSpoolFactory;
  timeoutMs?: number;
  limits?: Partial<CodexRpcLimits>;
  onFatalError?(error: Error): void;
};
export type CodexLateResponse = { readonly result: unknown } | { readonly error: NativeRpcError };
type LateObserver = (response: CodexLateResponse) => void;

/** Codex owns this transport; the other providers keep their native framing. */
export class CodexRpc {
  readonly stopped: Promise<void>;
  private readonly decoder: CodexJsonDecoder;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; observer?: LateObserver }>();
  private readonly late = new Map<number, LateObserver>();
  private observerCount = 0;
  private sequence = 0;
  private closed = false;
  private nativeClosed = false;
  private frameTimer: NodeJS.Timeout | null = null;
  private readonly onError = (error: Error) => this.fail(error);
  // Child close revokes writes, while the reader still owns received stdout.
  // EOF validates and settles that output before reporting unknown operations.
  private readonly onClose = () => { this.nativeClosed = true; };
  constructor(private readonly child: EventEmitter & { stdin: Writable; stdout: Readable }, private readonly onMessage: (value: NativeObject) => void, private readonly options: CodexRpcOptions) {
    this.decoder = new CodexJsonDecoder(options.createSpool, options.limits);
    child.once("error", this.onError); child.once("close", this.onClose); child.stdin.on("error", this.onError);
    this.stopped = this.read();
  }
  private armDeadline(): void {
    if (this.frameTimer) { clearTimeout(this.frameTimer); this.frameTimer = null; }
    const started = this.decoder.frameStartedAt;
    if (started !== null) this.frameTimer = setTimeout(() => this.fail(new Error("Native protocol frame deadline exceeded; unconfirmed operations remain unknown.")), Math.max(1, this.decoder.limits.frameMs - (Date.now() - started)));
  }
  private async yieldToIo(): Promise<boolean> {
    if (this.closed) return false;
    this.armDeadline();
    await setImmediate();
    return !this.closed;
  }
  private async consumeChunk(bytes: Uint8Array): Promise<void> {
    for (let offset = 0; offset < bytes.length; offset += this.decoder.limits.bufferBytes) {
      for (const frame of this.decoder.write(bytes.subarray(offset, offset + this.decoder.limits.bufferBytes))) {
        try {
          this.deliver(frame.value);
          // Promise consumers can retain a private image lease before the
          // frame releases its own reference. No service capture is awaited.
          await Promise.resolve();
        } finally { frame.release(); }
        if (!await this.yieldToIo()) return;
      }
      if (!await this.yieldToIo()) return;
    }
  }
  private async read(): Promise<void> {
    try {
      for await (const chunk of this.child.stdout) {
        if (this.closed) break;
        if (typeof chunk === "string") throw new Error("Native Codex output must remain a byte stream.");
        await this.consumeChunk(chunk as Uint8Array);
      }
      if (!this.closed) { this.decoder.end(); this.fail(new Error("Native transport ended; unconfirmed operations remain unknown.")); }
    } catch (error) { this.fail(error instanceof Error ? error : new Error("Native protocol read failed.")); }
    finally {
      if (this.frameTimer) clearTimeout(this.frameTimer); this.frameTimer = null;
      try { this.decoder.dispose(); } catch (error) { this.options.onFatalError?.(error instanceof Error ? error : new Error("Native media cleanup failed.")); }
      this.child.off("error", this.onError); this.child.off("close", this.onClose); this.child.stdin.off("error", this.onError);
    }
  }
  private deliver(message: NativeObject): void {
    if (typeof message.method === "string") { this.onMessage(message); return; }
    if (typeof message.id !== "number") return;
    const waiter = this.pending.get(message.id);
    const response: CodexLateResponse = message.error === undefined ? { result: message.result } : { error: new NativeRpcError(typeof record(message.error).code === "number" ? record(message.error).code as number : -1, string(record(message.error).message) || "Native operation rejected.") };
    if (!waiter) {
      const observer = this.late.get(message.id); if (!observer) return;
      this.late.delete(message.id); this.observerCount -= 1; observer(response); return;
    }
    clearTimeout(waiter.timer); this.pending.delete(message.id);
    if (waiter.observer) this.observerCount -= 1;
    if ("error" in response) waiter.reject(response.error); else waiter.resolve(response.result);
  }
  /** Unobserved timeout evidence is never evicted while this connection lives. */
  request(method: string, params: unknown, onLateResponse?: LateObserver): Promise<unknown> {
    if (this.closed || this.nativeClosed) return Promise.reject(new Error("Native process is closed."));
    if (onLateResponse && this.observerCount >= 1000) return Promise.reject(new NativeRpcError(-32602, "Native response observer capacity exceeded before dispatch."));
    if (onLateResponse) this.observerCount += 1;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); if (onLateResponse) this.late.set(id, onLateResponse); reject(new NativeRpcTimeoutError(method)); }, this.options.timeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer, ...(onLateResponse ? { observer: onLateResponse } : {}) });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); if (onLateResponse) this.observerCount -= 1; reject(error); }
    });
  }
  notify(method: string, params?: unknown): void { this.write({ method, ...(params === undefined ? {} : { params }) }); }
  respond(id: unknown, result: unknown): void { this.write({ id, result }); }
  reject(id: unknown, message: string): void { this.write({ id, error: { code: -32601, message } }); }
  private write(value: unknown): void { if (this.closed || this.nativeClosed) throw new Error("Native process is closed."); this.child.stdin.write(JSON.stringify(value) + "\n"); }
  private fail(error: Error, report = true): void {
    if (this.closed) return; this.closed = true;
    if (this.frameTimer) clearTimeout(this.frameTimer); this.frameTimer = null;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); } this.pending.clear();
    this.late.clear(); this.observerCount = 0;
    this.child.stdout.destroy();
    if (report) this.options.onFatalError?.(error);
  }
  dispose(): void { this.fail(new Error("Native transport closed."), false); }
}
