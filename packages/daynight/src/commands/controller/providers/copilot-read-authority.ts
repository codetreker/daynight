import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { parseLocalImageCheckpoint, type LocalImageCheckpoint } from "../markdown/local-source-proof.js";
import { copilotReadRefused, copilotSourcePath } from "./copilot-read-authority-check.js";
import type { NativeReadPolicy } from "./types.js";
import { CopilotReadCorrelation, copilotReadMarker } from "./copilot-read-authority-correlation.js";

export const copilotAuthorityProtocol = "daynight.copilot.read.v1";
export type CopilotReadRequest = { protocol: string; execution: string; sequence: number; sessionId: string; cwd: string; checkpoint: LocalImageCheckpoint | null; digest: string };
export function copilotRequestDigest(request: Omit<CopilotReadRequest, "digest">): string { return createHash("sha256").update(JSON.stringify(request)).digest("hex"); }
export function parseCopilotReadRequest(value: unknown): CopilotReadRequest {
  if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 270_336) throw copilotReadRefused();
  const row = value as CopilotReadRequest;
  if (Object.keys(row).sort().join() !== "checkpoint,cwd,digest,execution,protocol,sequence,sessionId" || row.protocol !== copilotAuthorityProtocol
    || !/^[a-f0-9-]{36}$/.test(row.execution) || !Number.isSafeInteger(row.sequence) || row.sequence < 0 || typeof row.sessionId !== "string" || !row.sessionId || row.sessionId.length > 256
    || typeof row.cwd !== "string" || row.cwd.length > 8192 || !/^[a-f0-9]{64}$/.test(row.digest)) throw copilotReadRefused();
  const request = { protocol: row.protocol, execution: row.execution, sequence: row.sequence, sessionId: row.sessionId, cwd: row.cwd, checkpoint: row.checkpoint === null ? null : parseLocalImageCheckpoint(row.checkpoint) };
  if (copilotRequestDigest(request) !== row.digest || (row.sequence === 0) !== (row.checkpoint === null)) throw copilotReadRefused();
  return { ...request, digest: row.digest };
}

type Options = { child: ChildProcess; execution?: string; cwd: string; publish(policy: NativeReadPolicy | null): void; timeoutMs?: number };
/** One owned IPC channel, one Session and single-use checkpoint responses. */
export class CopilotReadAuthority {
  readonly execution: string;
  private invalid = false;
  private installed = false;
  private sequence = 0;
  private correlation: CopilotReadCorrelation | undefined;
  private key: string | undefined;
  private queue: Promise<void> = Promise.resolve();
  private pending: { sequence: number; digest: string; resolve(key: string | null): void; reject(error: Error): void; timer: NodeJS.Timeout } | undefined;
  constructor(private readonly options: Options) {
    this.execution = options.execution ?? randomUUID(); options.publish(null);
    options.child.on("message", this.receive);
    options.child.once("exit", () => this.invalidate());
    options.child.once("disconnect", () => this.invalidate());
    options.child.once("error", () => this.invalidate());
  }
  private readonly receive = (value: unknown) => {
    if (this.invalid) return;
    const row = value as Record<string, unknown> | null, pending = this.pending;
    if (!row || typeof row !== "object" || Array.isArray(row) || Buffer.byteLength(JSON.stringify(row)) > 1024
      || Object.keys(row).sort().join() !== "allowed,digest,execution,key,protocol,sequence" || row.protocol !== copilotAuthorityProtocol || row.execution !== this.execution
      || !pending || row.sequence !== pending.sequence || row.digest !== pending.digest || typeof row.allowed !== "boolean"
      || (row.sequence === 0 && row.allowed ? typeof row.key !== "string" || !/^[a-f0-9]{64}$/.test(row.key) : row.key !== null)) { this.invalidate(); return; }
    this.pending = undefined; clearTimeout(pending.timer);
    if (row.allowed) pending.resolve(row.key as string | null); else pending.reject(copilotReadRefused());
  };
  invalidate(): void {
    if (this.invalid) return;
    this.invalid = true; this.options.publish(null);
    const pending = this.pending; this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(copilotReadRefused()); }
  }
  verify(): void { if (this.invalid || !this.options.child.connected) throw copilotReadRefused(); }
  observe(event: unknown): void { if (this.installed && (event as { type?: unknown })?.type === "session.permissions_changed") this.invalidate(); }
  rejectPermission(request: unknown, context: unknown) { return this.correlation?.reject(request, context); }
  prepareHistory(events: readonly unknown[]): void { this.correlation?.prepareHistory(events); }
  suppressPermissionEvent(event: unknown, history = false): boolean { return this.correlation?.suppress(event, history) ?? false; }
  private async request(sessionId: string, checkpoint: LocalImageCheckpoint | null): Promise<string | null> {
    this.verify();
    const payload = { protocol: copilotAuthorityProtocol, execution: this.execution, sequence: this.sequence++, sessionId, cwd: this.options.cwd, checkpoint };
    const request = { ...payload, digest: copilotRequestDigest(payload) };
    const path = checkpoint ? copilotSourcePath(checkpoint, this.options.cwd) : null;
    const intention = path && this.key ? copilotReadMarker(this.key, sessionId, this.execution, request.sequence, request.digest, path) : null;
    if (intention) this.correlation!.issue(intention, path!);
    const result = await new Promise<string | null>((resolve, reject) => {
      // A native checker cannot be cancelled. Admit no more checks after this
      // deadline and discard its eventual result without stopping text turns.
      const timer = setTimeout(() => this.invalidate(), this.options.timeoutMs ?? 15_000);
      this.pending = { sequence: request.sequence, digest: request.digest, resolve, reject, timer };
      try { this.options.child.send(request, error => { if (error) this.invalidate(); }); } catch { this.invalidate(); }
    }).finally(() => { if (!this.invalid && intention) this.correlation!.settled(intention); });
    this.verify(); return result;
  }
  async install(sessionId: string): Promise<void> {
    if (this.installed || this.invalid) throw copilotReadRefused(); this.installed = true;
    try { this.key = (await this.request(sessionId, null))!; this.correlation = new CopilotReadCorrelation(this.key, sessionId); } catch { this.invalidate(); return; }
    this.verify();
    const policy: NativeReadPolicy = Object.freeze({ nativeSessionId: sessionId, cwd: this.options.cwd, revision: `copilot:1.0.105:${this.execution}`, verify: () => this.verify(),
      authorizeCheckpoint: (input: LocalImageCheckpoint) => {
        const checkpoint = parseLocalImageCheckpoint(input); copilotSourcePath(checkpoint, this.options.cwd);
        const result = this.queue.then(async () => { await this.request(sessionId, checkpoint); });
        this.queue = result.catch(() => {}); return result;
      },
    });
    this.options.publish(policy);
  }
}
