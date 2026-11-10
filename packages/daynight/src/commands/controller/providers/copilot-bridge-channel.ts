import { createHash, randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

export const COPILOT_IPC_FRAME_BYTES = 1_048_576;
export const COPILOT_IPC_METADATA_BYTES = 16_777_216;
const PART_BYTES = 524_288;
const QUEUE_BYTES = 33_554_432;
type Assembly = { length: number; sha256: string; received: number; chunks: Buffer[]; timer: NodeJS.Timeout };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Private stdio frames remain bounded even when a complete control catalog needs several frames. */
export class CopilotBridgeChannel {
  private buffered = Buffer.alloc(0);
  private closed = false;
  private outgoing: Promise<void> = Promise.resolve();
  private outgoingBytes = 0;
  private incomingBytes = 0;
  private readonly assemblies = new Map<string, Assembly>();
  constructor(private readonly input: Readable, private readonly output: Writable,
    private readonly receive: (value: unknown) => void, private readonly failed: (error: Error) => void) {
    input.on("data", this.data); input.on("error", this.error); input.on("end", this.ended); output.on("error", this.error);
  }
  private error = (error: Error) => this.fail(error);
  private ended = () => { if (!this.closed) this.fail(new Error("Copilot bridge transport ended; operation results are unknown.")); };
  private fail(error: Error): void { if (this.closed) return; this.close(); this.failed(error); }
  private data = (chunk: Buffer): void => {
    if (this.closed) return;
    try {
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 10) continue;
        if (this.buffered.length + i - start > COPILOT_IPC_FRAME_BYTES) throw new Error("Copilot bridge IPC frame exceeds its limit.");
        const line = this.buffered.length ? Buffer.concat([this.buffered, chunk.subarray(start, i)]) : chunk.subarray(start, i);
        this.buffered = Buffer.alloc(0); start = i + 1;
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(line);
        this.frame(object(JSON.parse(decoded)));
        if (this.closed) return;
      }
      if (start < chunk.length) {
        const tail = chunk.subarray(start);
        if (this.buffered.length + tail.length > COPILOT_IPC_FRAME_BYTES) throw new Error("Copilot bridge IPC frame exceeds its limit.");
        this.buffered = Buffer.concat([this.buffered, tail]);
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  };
  private frame(frame: Record<string, unknown>): void {
    const { id } = frame;
    if (typeof id !== "string" || id.length < 1 || id.length > 128) throw new Error("Copilot bridge frame has invalid identity.");
    if (frame.kind === "begin") {
      if (this.assemblies.has(id) || this.assemblies.size >= 2 || typeof frame.length !== "number" || !Number.isSafeInteger(frame.length) || frame.length < 1 || frame.length > COPILOT_IPC_METADATA_BYTES || typeof frame.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(frame.sha256) || this.incomingBytes + frame.length > QUEUE_BYTES) throw new Error("Copilot bridge metadata admission failed.");
      const timer = setTimeout(() => this.fail(new Error("Copilot bridge metadata assembly made no progress.")), 30_000); timer.unref();
      this.incomingBytes += frame.length;
      this.assemblies.set(id, { length: frame.length, sha256: frame.sha256, received: 0, chunks: [], timer });
      return;
    }
    const assembly = this.assemblies.get(id);
    if (!assembly) throw new Error("Copilot bridge frame has no admitted metadata identity.");
    if (frame.kind === "part") {
      if (frame.offset !== assembly.received || typeof frame.data !== "string" || frame.data.length > 699_052 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) throw new Error("Copilot bridge metadata part is invalid.");
      const bytes = Buffer.from(frame.data, "base64");
      if (!bytes.length || bytes.length > PART_BYTES || bytes.toString("base64") !== frame.data || assembly.received + bytes.length > assembly.length) throw new Error("Copilot bridge metadata part exceeds its admission.");
      assembly.chunks.push(bytes); assembly.received += bytes.length; assembly.timer.refresh();
      return;
    }
    if (frame.kind !== "end" || assembly.received !== assembly.length) throw new Error("Copilot bridge metadata is incomplete.");
    clearTimeout(assembly.timer); this.assemblies.delete(id); this.incomingBytes -= assembly.length;
    const bytes = Buffer.concat(assembly.chunks, assembly.length);
    if (createHash("sha256").update(bytes).digest("hex") !== assembly.sha256) throw new Error("Copilot bridge metadata digest differs.");
    this.receive(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  }
  async send(value: unknown): Promise<void> {
    if (this.closed) throw new Error("Copilot bridge transport is closed.");
    const bytes = Buffer.from(JSON.stringify(value));
    if (!bytes.length || bytes.length > COPILOT_IPC_METADATA_BYTES || this.outgoingBytes + bytes.length > QUEUE_BYTES) throw new Error("Copilot bridge metadata exceeds its queue budget.");
    this.outgoingBytes += bytes.length;
    const work = this.outgoing.then(async () => {
      const id = randomUUID();
      await this.write({ kind: "begin", id, length: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      for (let offset = 0; offset < bytes.length; offset += PART_BYTES) await this.write({ kind: "part", id, offset, data: bytes.subarray(offset, offset + PART_BYTES).toString("base64") });
      await this.write({ kind: "end", id });
    });
    this.outgoing = work.catch(() => {});
    try { await work; } finally { this.outgoingBytes -= bytes.length; }
  }
  private write(frame: unknown): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Copilot bridge transport is closed."));
    const bytes = Buffer.from(JSON.stringify(frame) + "\n");
    if (bytes.length > COPILOT_IPC_FRAME_BYTES) return Promise.reject(new Error("Copilot bridge IPC frame exceeds its limit."));
    return new Promise((resolve, reject) => this.output.write(bytes, error => error ? reject(error) : resolve()));
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    this.input.off("data", this.data); this.input.off("error", this.error); this.input.off("end", this.ended); this.output.off("error", this.error);
    for (const assembly of this.assemblies.values()) clearTimeout(assembly.timer);
    this.assemblies.clear(); this.buffered = Buffer.alloc(0); this.incomingBytes = 0;
  }
}
