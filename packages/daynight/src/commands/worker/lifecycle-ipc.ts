import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { lifecycleId } from "../../api/worker-lifecycle.js";
import { jsonObjectSources } from "../../api/json-source.js";
import type { LifecycleIdentity } from "./lifecycle-store.js";

export type LifecycleIpcAction = { kind: "query" | "disable" | "reconcile" | "resume"; operationId: string | null };
export const LIFECYCLE_IPC_BYTES = 16 * 1024;
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const exact = (input: unknown, keys: string[]): Record<string, unknown> => {
  if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join() !== [...keys].sort().join()) throw new Error("Invalid lifecycle IPC fields.");
  return input as Record<string, unknown>;
};
const sameIdentity = (input: unknown, identity: LifecycleIdentity): boolean => {
  const value = exact(input, ["serverOrigin", "userId", "workerId"]);
  return value.serverOrigin === identity.serverOrigin && value.userId === identity.userId && value.workerId === identity.workerId;
};
const actionValue = (input: unknown): LifecycleIpcAction => {
  const value = exact(input, ["kind", "operationId"]);
  if (!["query", "disable", "reconcile", "resume"].includes(String(value.kind)) || (value.kind === "query" ? value.operationId !== null : typeof value.operationId !== "string")) throw new Error("Invalid lifecycle IPC action.");
  return { kind: value.kind as LifecycleIpcAction["kind"], operationId: value.operationId === null ? null : lifecycleId(value.operationId) };
};
const privatePath = async (location: string, kind: "file" | "directory" | "socket") => {
  const info = await lstat(location);
  if (info.isSymbolicLink() || !(kind === "directory" ? info.isDirectory() : kind === "file" ? info.isFile() : info.isSocket()) || process.platform !== "win32" && (info.uid !== process.getuid!() || (info.mode & 0o077) !== 0)) throw new Error("Lifecycle IPC requires private original paths.");
  return info;
};
const locations = async (workerDirectory: string) => {
  if (!path.isAbsolute(workerDirectory) || path.normalize(workerDirectory) !== workerDirectory || await realpath(workerDirectory) !== workerDirectory) throw new Error("Lifecycle IPC requires the original physical Worker directory.");
  await privatePath(workerDirectory, "directory");
  const key = createHash("sha256").update(workerDirectory).digest("hex").slice(0, 24);
  let endpoint = process.platform === "win32" ? `\\\\.\\pipe\\daynight-lifecycle-${key}` : path.join(workerDirectory, "lifecycle.sock");
  // Match the Controller's authenticated short-root convention for long Unix paths.
  if (process.platform !== "win32" && Buffer.byteLength(endpoint) > (process.platform === "darwin" ? 103 : 107)) endpoint = `/tmp/daynight-lifecycle-${process.getuid!()}-${key}/s`;
  return { secretFile: path.join(workerDirectory, "lifecycle-ipc.json"), endpoint };
};
const descriptor = async (file: string, endpoint: string, identity: LifecycleIdentity): Promise<{ secret: string; raw: string }> => {
  const before = await privatePath(file, "file");
  if (before.size > LIFECYCLE_IPC_BYTES) throw new Error("Lifecycle IPC descriptor exceeds its limit.");
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (info.dev !== before.dev || info.ino !== before.ino) throw new Error("Lifecycle IPC descriptor changed during read.");
    const raw = await handle.readFile("utf8"); jsonObjectSources(raw);
    const value = exact(JSON.parse(raw), ["protocolVersion", "identity", "endpoint", "secret"]);
    if (value.protocolVersion !== 1 || value.endpoint !== endpoint || !sameIdentity(value.identity, identity) || typeof value.secret !== "string" || !/^[0-9a-f]{64}$/.test(value.secret)) throw new Error("Lifecycle IPC identity does not match the original Worker.");
    return { secret: value.secret, raw };
  } finally { await handle.close(); }
};
const encode = (value: unknown): string => {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame) > LIFECYCLE_IPC_BYTES) throw new Error("Lifecycle IPC frame exceeds 16 KiB.");
  return frame;
};
export class LifecycleIpcUnknownError extends Error {
  constructor(message: string, readonly dispatched = true, options?: ErrorOptions) { super(message, options); }
}

/** The caller holds the original Worker instance lock for the server's lifetime. */
export const startLifecycleIpcServer = async (options: { workerDirectory: string; identity: LifecycleIdentity; handle: (request: LifecycleIpcAction) => unknown | Promise<unknown> }) => {
  const { secretFile, endpoint } = await locations(options.workerDirectory);
  if (process.platform !== "win32") { await mkdir(path.dirname(endpoint), { recursive: true, mode: 0o700 }); await privatePath(path.dirname(endpoint), "directory"); }
  let previous = false;
  try { await descriptor(secretFile, endpoint, options.identity); previous = true; }
  catch (error) { if (!missing(error)) throw error; }
  if (process.platform !== "win32") {
    try { await privatePath(endpoint, "socket"); if (!previous) throw new Error("An unowned lifecycle socket was retained."); await unlink(endpoint); }
    catch (error) { if (!missing(error)) throw error; }
  }
  const secret = randomBytes(32).toString("hex"), raw = JSON.stringify({ protocolVersion: 1, identity: options.identity, endpoint, secret });
  const temporary = `${secretFile}.${randomUUID()}.tmp`, handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, secretFile);
  const sockets = new Set<Socket>(), work = new Set<Promise<void>>();
  const server = createServer(socket => {
    if (sockets.size >= 16) { socket.destroy(); return; }
    sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {});
    socket.setTimeout(10_000, () => socket.destroy());
    const chunks: Buffer[] = []; let bytes = 0, handled = false;
    socket.on("data", (chunk: Buffer) => {
      if (handled) { socket.destroy(); return; }
      bytes += chunk.length; if (bytes > LIFECYCLE_IPC_BYTES) { socket.destroy(); return; } chunks.push(chunk);
      const buffer = Buffer.concat(chunks), newline = buffer.indexOf(10); if (newline < 0) return;
      handled = true;
      const task = (async () => {
        let requestId: string | undefined;
        try {
          if (newline !== buffer.length - 1) throw new Error("Lifecycle IPC accepts one frame.");
          const source = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline)); jsonObjectSources(source);
          const request = exact(JSON.parse(source), ["protocolVersion", "requestId", "identity", "secret", "action"]);
          if (request.protocolVersion !== 1 || !sameIdentity(request.identity, options.identity) || typeof request.secret !== "string" || !/^[a-f0-9]{64}$/.test(request.secret) || !timingSafeEqual(Buffer.from(request.secret), Buffer.from(secret))) throw new Error("Lifecycle IPC authentication failed.");
          requestId = lifecycleId(request.requestId);
          const action = actionValue(request.action);
          socket.setTimeout(90_000, () => socket.destroy());
          await options.handle(action);
          socket.end(encode({ protocolVersion: 1, requestId, identity: options.identity, ok: true }));
        } catch {
          if (requestId === undefined) socket.destroy();
          else socket.end(encode({ protocolVersion: 1, requestId, identity: options.identity, ok: false }));
        }
      })();
      work.add(task); void task.finally(() => work.delete(task));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, () => { server.off("error", reject); resolve(); }); });
    if (process.platform !== "win32") await chmod(endpoint, 0o600);
  } catch (error) { server.close(); throw error; }
  let closed = false;
  return { close: async (): Promise<void> => {
    if (closed) return; closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.allSettled(work), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Lifecycle IPC handlers are still pending; the descriptor was retained.")), 90_000); })]); }
    finally { clearTimeout(timer); }
    if (await readFile(secretFile, "utf8") !== raw) throw new Error("Lifecycle IPC descriptor ownership changed; it was retained.");
    await unlink(secretFile);
    if (process.platform !== "win32" && path.dirname(endpoint) !== options.workerDirectory) await rmdir(path.dirname(endpoint));
  } };
};

/** A lost IPC response never authorizes replaying resume; read the original local operation. */
export const requestLifecycleIpc = async (options: { workerDirectory: string; identity: LifecycleIdentity } & LifecycleIpcAction & { signal?: AbortSignal; timeoutMs?: number }): Promise<void> => {
  const { secretFile, endpoint } = await locations(options.workerDirectory), { secret } = await descriptor(secretFile, endpoint, options.identity);
  if (process.platform !== "win32") { await privatePath(path.dirname(endpoint), "directory"); await privatePath(endpoint, "socket"); }
  options.signal?.throwIfAborted();
  const action = actionValue({ kind: options.kind, operationId: options.operationId }), requestId = randomUUID();
  const frame = encode({ protocolVersion: 1, requestId, identity: options.identity, secret, action });
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90_000) throw new Error("Lifecycle IPC timeout must be between 1 and 90000 milliseconds.");
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection(endpoint); let bytes = 0, settled = false, dispatched = false; const chunks: Buffer[] = [];
    const finish = (error?: unknown): void => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort); socket.destroy(); if (error !== undefined) reject(error); else resolve(); };
    const abort = (): void => finish(new LifecycleIpcUnknownError("Lifecycle IPC was cancelled; inspect the original operation.", dispatched, { cause: options.signal?.reason }));
    const timer = setTimeout(() => finish(new LifecycleIpcUnknownError("Lifecycle IPC response is pending; inspect the original operation.")), timeoutMs);
    socket.once("connect", () => { dispatched = true; socket.write(frame); });
    socket.once("error", cause => finish(new LifecycleIpcUnknownError("Lifecycle IPC transport is unavailable; inspect the original operation.", dispatched, { cause })));
    socket.once("end", () => finish(new LifecycleIpcUnknownError("Lifecycle IPC closed before confirmation; inspect the original operation.")));
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length; if (bytes > LIFECYCLE_IPC_BYTES) { finish(new LifecycleIpcUnknownError("Lifecycle IPC response exceeds its limit.")); return; } chunks.push(chunk);
      const buffer = Buffer.concat(chunks), newline = buffer.indexOf(10); if (newline < 0) return;
      try {
        if (newline !== buffer.length - 1) throw new Error("Unexpected lifecycle IPC response frames.");
        const source = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline)); jsonObjectSources(source);
        const response = exact(JSON.parse(source), ["protocolVersion", "requestId", "identity", "ok"]);
        if (response.protocolVersion !== 1 || response.requestId !== requestId || !sameIdentity(response.identity, options.identity) || response.ok !== true) throw new Error("Lifecycle IPC response did not confirm the original request.");
        finish();
      } catch (cause) { finish(new LifecycleIpcUnknownError("Lifecycle IPC result is unconfirmed; inspect the original operation.", true, { cause })); }
    });
    options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) abort();
  });
};
