import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const keys = { inputTokens: "input_tokens", outputTokens: "output_tokens", totalTokens: "total_tokens", cachedInputTokens: "cached_input_tokens", cacheWriteInputTokens: "cache_write_input_tokens", reasoningOutputTokens: "reasoning_output_tokens" };

/** Reads only the original thread's returned physical rollout, without retaining bodies. */
export class CodexUsageRollout {
  private offset = 0;
  private readPosition = 0;
  private pending = Buffer.alloc(0);
  private verified = false;
  private fingerprint: string | null = null;
  private flight: Promise<void> | null = null;
  constructor(private readonly options: { file: string; cwd: string; nativeSessionId: string; observe(event: unknown): void; gap(reason: string): void }) {}

  scan(): Promise<void> {
    if (this.flight) return this.flight;
    this.flight = this.read().catch(() => { this.options.gap("native_recovery_gap"); }).finally(() => { this.flight = null; });
    return this.flight;
  }

  async drain(): Promise<void> {
    await this.flight;
    const deadline = Date.now() + 5000;
    do {
      const before = this.offset;
      await this.scan();
      if (this.offset === before) return;
    } while (Date.now() < deadline);
    this.options.gap("native_recovery_gap");
  }

  private async read(): Promise<void> {
    const { file, nativeSessionId } = this.options;
    if (!path.isAbsolute(file)) throw new Error("collector_failed");
    const named = await lstat(file);
    if (!named.isFile() || named.isSymbolicLink() || await realpath(file) !== file) throw new Error("collector_failed");
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat(), fingerprint = `${stat.dev}:${stat.ino}`;
      if (stat.dev !== named.dev || stat.ino !== named.ino || this.fingerprint !== null && this.fingerprint !== fingerprint || stat.size < this.readPosition) throw new Error("collector_failed");
      this.fingerprint = fingerprint;
      const end = stat.size, buffer = Buffer.alloc(64 * 1024), deadline = Date.now() + 5000;
      let processed = 0;
      while (this.readPosition < end) {
        if (Date.now() >= deadline || processed >= 16 * 1024 * 1024 && this.pending.length === 0) return;
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - this.readPosition), this.readPosition);
        if (!bytesRead) throw new Error("collector_failed");
        this.readPosition += bytesRead; processed += bytesRead;
        this.pending = Buffer.concat([this.pending, buffer.subarray(0, bytesRead)]);
        let newline: number;
        while ((newline = this.pending.indexOf(10)) >= 0) {
          if (newline > 32 * 1024 * 1024) throw new Error("collector_failed");
          const entry = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.pending.subarray(0, newline)))), p = object(entry.payload);
          if (!this.verified) {
            if (entry.type !== "session_meta" || p.id !== nativeSessionId || p.cli_version !== "0.169.0" || typeof p.cwd !== "string" || await realpath(p.cwd) !== await realpath(this.options.cwd)
              || p.forked_from_id != null || object(p.source).subagent != null) throw new Error("collector_failed");
            this.verified = true;
          } else if (entry.type === "session_meta") throw new Error("collector_failed");
          if (entry.type === "token_usage_record") {
            if (p.thread_id !== nativeSessionId || p.session_id !== nativeSessionId || typeof p.turn_id !== "string" || p.root_turn_id !== p.turn_id) throw new Error("collector_failed");
            const usage = object(p.usage);
            this.options.observe({ method: "rawResponse/completed", params: { threadId: nativeSessionId, turnId: p.turn_id, responseId: p.response_id, usage: Object.fromEntries(Object.entries(keys).map(([key, nativeKey]) => [key, usage[nativeKey] ?? null])) } });
          }
          this.offset += newline + 1; this.pending = this.pending.subarray(newline + 1);
        }
        if (this.pending.length > 32 * 1024 * 1024) throw new Error("collector_failed");
      }
      // A partial last line belongs to the live native writer and is retried intact.
    } finally { await handle.close(); }
  }
}
