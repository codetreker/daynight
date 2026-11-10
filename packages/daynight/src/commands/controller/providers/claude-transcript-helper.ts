import { fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureProcessProof, type ProcessProof } from "../process-proof.js";
import { openClaudeTranscript, ClaudeTranscriptError, type ClaudeTranscriptIndexReservation, type ClaudeTranscriptOptions, type ClaudeTranscriptPage, type ClaudeTranscriptReader, type ClaudeTranscriptSnapshot } from "./claude-transcript.js";

const MAX_FRAME = 1_048_576;
type Wire = Record<string, unknown>;
const record = (value: unknown): Wire => value && typeof value === "object" && !Array.isArray(value) ? value as Wire : {};
const safeError = (error: unknown) => error instanceof ClaudeTranscriptError ? { code: error.code, message: error.message } : { code: "invalid_transcript" as const, message: "Claude transcript helper could not complete its read." };
const checked = (message: Wire) => { if (Buffer.byteLength(JSON.stringify(message)) > MAX_FRAME) throw new ClaudeTranscriptError("limit_exceeded", "Claude transcript helper metadata frame exceeds its limit."); return message; };
const bounded = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new ClaudeTranscriptError("closed", message)), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
export type ClaudeTranscriptHelperOptions = Omit<ClaudeTranscriptOptions, "reserveIndex"> & {
  /** Hold the Controller's shared metadata allowance until release or confirmed helper exit. */
  readonly acquireIndexReservation: (additionalBytes: number, owner?: ProcessProof) => ClaudeTranscriptIndexReservation | Promise<ClaudeTranscriptIndexReservation>;
  readonly onSpawn: (child: ChildProcess) => void;
};

/** Owns one read-only helper and joins its readers before releasing outstanding metadata reservations. */
export const openClaudeTranscriptHelper = async (options: ClaudeTranscriptHelperOptions): Promise<ClaudeTranscriptReader> => {
  options.signal?.throwIfAborted();
  await mkdir(options.indexDirectory, { recursive: true, mode: 0o700 });
  const ownedDirectory = await mkdtemp(path.join(options.indexDirectory, "claude-reader-"));
  let child: ChildProcess;
  try { child = fork(fileURLToPath(import.meta.url), ["--daynight-claude-transcript-helper"], { execArgv: ["--max-old-space-size=128"], stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json", windowsHide: true }); }
  catch (error) { await rm(ownedDirectory, { recursive: true, force: true }); throw error; }
  let sequence = 0, closed = false, closing: Promise<void> | null = null, active: string | null = null;
  let scheduledRequests = 0, requestTail: Promise<void> = Promise.resolve();
  let snapshot: ClaudeTranscriptSnapshot;
  let processProof: ProcessProof;
  const reservations = new Map<string, ClaudeTranscriptIndexReservation>();
  const reservationWork = new Set<Promise<void>>();
  const pendingReservations = new Set<string>();
  const consumerWork = new Set<Promise<void>>();
  type Request = { resolve(value: unknown): void; reject(error: Error): void; consume?: (bytes: Uint8Array) => void | Promise<void>; chunk: number; inFlight: Promise<void> | null; failure?: Error; timer: NodeJS.Timeout };
  const requests = new Map<string, Request>();
  let exited = false;
  const exit = new Promise<void>(resolve => {
    child.once("exit", () => { exited = true; resolve(); });
    child.once("error", () => { if (!child.pid) { exited = true; resolve(); } });
  });
  const send = (message: Wire) => { if (!child.connected) throw new ClaudeTranscriptError("closed", "Claude transcript helper connection is closed."); child.send(checked(message)); };
  const settle = (id: string, waiter: Request, result: () => void) => {
    requests.delete(id); clearTimeout(waiter.timer);
    const finish = () => { if (active === id) active = null; result(); };
    if (waiter.inFlight) void waiter.inFlight.then(finish, finish); else finish();
  };
  const rejectRequests = (error: Error) => { for (const [id, waiter] of requests) settle(id, waiter, () => waiter.reject(waiter.failure ?? error)); };
  child.once("error", () => rejectRequests(new ClaudeTranscriptError("closed", "Claude transcript helper could not start.")));
  child.once("exit", () => rejectRequests(new ClaudeTranscriptError("closed", "Claude transcript helper exited before its read completed.")));
  const cancel = (id: string) => { if (child.connected) send({ kind: "cancel", id }); };
  child.on("message", raw => {
    const message = record(raw);
    try { checked(message); } catch { child.kill("SIGTERM"); return; }
    if (message.kind === "reserve" && typeof message.id === "string" && typeof message.reservationId === "string" && Number.isSafeInteger(message.bytes) && Number(message.bytes) > 0) {
      const id = message.reservationId;
      const request = requests.get(message.id);
      if (!request || reservations.size > 0 || pendingReservations.size > 0) { child.kill("SIGTERM"); return; }
      request.timer.refresh(); pendingReservations.add(id);
      const work = (async () => {
        try {
          const permission = await options.acquireIndexReservation(Number(message.bytes), processProof);
          if (!permission || typeof permission.release !== "function") throw new Error("Missing metadata reservation lease.");
          reservations.set(id, permission);
          if (exited) { await permission.release(); reservations.delete(id); return; }
          send({ kind: "reserve-result", reservationId: id, ok: true });
        } catch { if (child.connected) send({ kind: "reserve-result", reservationId: id, ok: false }); }
        finally { pendingReservations.delete(id); request.timer.refresh(); }
      })();
      reservationWork.add(work); void work.finally(() => reservationWork.delete(work)).catch(() => {}); return;
    }
    if (message.kind === "release" && typeof message.reservationId === "string") {
      const id = message.reservationId, permission = reservations.get(id);
      if (!permission) { child.kill("SIGTERM"); return; }
      if (active) requests.get(active)?.timer.refresh();
      const work = (async () => { try { await permission.release(); reservations.delete(id); send({ kind: "release-result", reservationId: id, ok: true }); } catch { if (child.connected) send({ kind: "release-result", reservationId: id, ok: false }); } })();
      reservationWork.add(work); void work.finally(() => reservationWork.delete(work)).catch(() => {}); return;
    }
    if (typeof message.id !== "string") { child.kill("SIGTERM"); return; }
    const waiter = requests.get(message.id); if (!waiter) return;
    waiter.timer.refresh();
    if (message.kind === "chunk") {
      if (!waiter.consume || waiter.inFlight || message.index !== waiter.chunk++ || typeof message.data !== "string" || message.data.length > 87_384) { waiter.failure = new ClaudeTranscriptError("invalid_transcript", "Claude transcript helper media ordering is invalid."); cancel(message.id); return; }
      const bytes = Buffer.from(message.data, "base64");
      if (bytes.length > 65_536 || bytes.toString("base64") !== message.data) { waiter.failure = new ClaudeTranscriptError("invalid_transcript", "Claude transcript helper media encoding is invalid."); cancel(message.id); return; }
      const id = message.id, index = message.index;
      const work = Promise.resolve().then(() => waiter.consume!(bytes)).then(() => { if (child.connected && requests.has(id)) send({ kind: "chunk-result", id, index, ok: true }); }, error => { waiter.failure = error instanceof Error ? error : new Error("Transcript media consumer failed."); if (child.connected && requests.has(id)) send({ kind: "chunk-result", id, index, ok: false }); });
      waiter.inFlight = work; consumerWork.add(work);
      void work.finally(() => { waiter.inFlight = null; consumerWork.delete(work); }).catch(() => {});
      return;
    }
    if (message.kind !== "result") { child.kill("SIGTERM"); return; }
    settle(message.id, waiter, () => {
      if (waiter.failure) waiter.reject(waiter.failure);
      else if (message.ok === true) waiter.resolve(message.value);
      else { const error = record(message.error); waiter.reject(new ClaudeTranscriptError(typeof error.code === "string" ? error.code as ClaudeTranscriptError["code"] : "invalid_transcript", typeof error.message === "string" ? error.message : "Claude transcript helper read failed.")); }
    });
  });
  const performRequest = <T>(method: string, value: unknown, consume?: (bytes: Uint8Array) => void | Promise<void>, signal?: AbortSignal): Promise<T> => {
    if (closed || active !== null) return Promise.reject(new ClaudeTranscriptError("closed", "Claude transcript helper is closed or its read ownership changed."));
    signal?.throwIfAborted(); options.signal?.throwIfAborted();
    const id = String(++sequence); active = id;
    const aborted = () => cancel(id);
    signal?.addEventListener("abort", aborted, { once: true });
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { const waiter = requests.get(id); if (waiter) waiter.failure = new ClaudeTranscriptError("closed", "Claude transcript helper stopped making progress."); cancel(id); child.kill("SIGTERM"); }, 30_000);
      requests.set(id, { resolve: value => resolve(value as T), reject, ...(consume ? { consume } : {}), chunk: 0, inFlight: null, timer });
      try { send({ kind: "request", id, method, value }); } catch (error) { clearTimeout(timer); requests.delete(id); active = null; reject(error); }
    });
    return promise.finally(() => signal?.removeEventListener("abort", aborted));
  };
  const request = <T>(method: string, value: unknown, consume?: (bytes: Uint8Array) => void | Promise<void>, signal?: AbortSignal): Promise<T> => {
    if (closed) return Promise.reject(new ClaudeTranscriptError("closed", "Claude transcript helper is closed."));
    if (scheduledRequests >= 128) return Promise.reject(new ClaudeTranscriptError("limit_exceeded", "Claude transcript helper request queue exceeds its bound."));
    scheduledRequests++;
    // Paging and deferred media share one read owner. A page ACK may release
    // media work while its caller already requests the next metadata page.
    const operation = requestTail.then(() => performRequest<T>(method, value, consume, signal));
    requestTail = operation.then(() => {}, () => {}).finally(() => { scheduledRequests--; });
    return operation;
  };
  const stop = (): Promise<void> => closing ??= (async () => {
    closed = true;
    if (active) cancel(active);
    // The child owns no native execution. Killing an unresponsive reader cannot submit input.
    if (child.connected) { try { send({ kind: "stop" }); } catch { /* Exit observation below owns cleanup. */ } }
    try { await bounded(exit, 4000, "Claude transcript helper did not exit after cancellation."); }
    catch {
      child.kill("SIGTERM");
      try { await bounded(exit, 2000, "Claude transcript helper did not terminate."); }
      catch { child.kill("SIGKILL"); await bounded(exit, 2000, "Claude transcript helper termination remains unconfirmed."); }
    }
    await Promise.all([...reservationWork]);
    await Promise.all([...consumerWork]);
    await requestTail;
    for (const [id, permission] of reservations) { await permission.release(); reservations.delete(id); }
    await rm(ownedDirectory, { recursive: true, force: true });
    options.signal?.removeEventListener("abort", shutdown);
  })();
  const shutdown = () => { void stop().catch(() => {}); };
  options.signal?.addEventListener("abort", shutdown, { once: true });
  if (options.signal?.aborted) shutdown();
  try {
    await new Promise<void>((resolve, reject) => { child.once("spawn", () => { try { options.onSpawn(child); resolve(); } catch (error) { reject(error); } }); child.once("error", reject); });
    if (!child.pid) throw new ClaudeTranscriptError("closed", "Claude transcript helper process identity is unavailable.");
    processProof = await captureProcessProof(child.pid);
    const { acquireIndexReservation: _reserve, onSpawn: _spawn, signal: _signal, ...input } = options; void _reserve; void _spawn; void _signal;
    snapshot = await request<ClaudeTranscriptSnapshot>("open", { ...input, indexDirectory: ownedDirectory });
  } catch (error) { await stop(); throw error; }
  return {
    get snapshot() { return { ...snapshot }; },
    nextPage: options => request<ClaudeTranscriptPage>("page", options ?? {}),
    acknowledge: cursor => request<void>("ack", { cursor }),
    readMedia: (mediaId, consume, signal) => request<void>("media", { mediaId }, consume, signal),
    refresh: async () => snapshot = await request<ClaudeTranscriptSnapshot>("refresh", {}),
    close: stop,
  };
};

async function runHelper(): Promise<void> {
  let reader: ClaudeTranscriptReader | null = null, active: { id: string; abort: AbortController } | null = null, stopping = false;
  const lifetime = new AbortController();
  let sequence = 0, currentWork: Promise<unknown> = Promise.resolve();
  const waiters = new Map<string, { resolve(): void; reject(error: Error): void }>();
  const send = (message: Wire) => { if (!process.connected || !process.send) throw new Error("Transcript parent disconnected."); process.send(checked(message)); };
  const wait = (key: string, message: Wire) => new Promise<void>((resolve, reject) => { waiters.set(key, { resolve, reject }); try { send(message); } catch (error) { waiters.delete(key); reject(error); } });
  const cancel = () => { active?.abort.abort(new Error("Claude transcript read cancelled.")); for (const waiter of waiters.values()) waiter.reject(new Error("Claude transcript read cancelled.")); waiters.clear(); };
  let stopped: Promise<void> | null = null;
  const stop = () => stopped ??= (async () => { stopping = true; lifetime.abort(new Error("Claude transcript helper stopped.")); cancel(); const closing = reader?.close(); await currentWork.catch(() => {}); await closing; if (process.connected) process.disconnect(); })();
  process.on("disconnect", () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.once("SIGTERM", () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.on("message", raw => {
    const message = record(raw);
    try { checked(message); } catch { void stop(); return; }
    if (["reserve-result", "release-result", "chunk-result"].includes(String(message.kind))) {
      const key = message.kind === "chunk-result" ? `chunk:${String(message.id)}:${String(message.index)}` : `${message.kind === "reserve-result" ? "reserve" : "release"}:${String(message.reservationId)}`;
      const waiter = waiters.get(key); if (!waiter) return; waiters.delete(key);
      if (message.ok === true) waiter.resolve(); else waiter.reject(new ClaudeTranscriptError("limit_exceeded", "Claude transcript parent declined the indexed write or media chunk.")); return;
    }
    if (message.kind === "cancel" && active?.id === message.id) { cancel(); return; }
    if (message.kind === "stop") { void stop(); return; }
    if (stopping || active || message.kind !== "request" || typeof message.id !== "string" || typeof message.method !== "string") { void stop(); return; }
    const id = message.id, controller = new AbortController(); active = { id, abort: controller };
    currentWork = (async () => {
      try {
        const value = record(message.value); let result: unknown;
        if (message.method === "open" && !reader) {
          reader = await openClaudeTranscript({ ...value as unknown as ClaudeTranscriptOptions, signal: lifetime.signal, reserveIndex: async bytes => {
            const reservationId = String(++sequence);
            await wait(`reserve:${reservationId}`, { kind: "reserve", id: active!.id, reservationId, bytes });
            return { release: async () => { await wait(`release:${reservationId}`, { kind: "release", reservationId }); } };
          } }); result = reader.snapshot;
        } else if (!reader) throw new Error("Claude transcript is not open.");
        else if (message.method === "page") result = await reader.nextPage(value);
        else if (message.method === "ack" && typeof value.cursor === "string") result = await reader.acknowledge(value.cursor);
        else if (message.method === "media" && typeof value.mediaId === "string") {
          let index = 0;
          result = await reader.readMedia(value.mediaId, async bytes => { const current = index++; await wait(`chunk:${id}:${current}`, { kind: "chunk", id, index: current, data: Buffer.from(bytes).toString("base64") }); }, controller.signal);
        } else if (message.method === "refresh") result = await reader.refresh();
        else throw new Error("Unsupported transcript helper command.");
        if (!stopping) send({ kind: "result", id, ok: true, value: result ?? null });
      } catch (error) { if (!stopping && process.connected) send({ kind: "result", id, ok: false, error: safeError(error) }); }
      finally { active = null; }
    })();
  });
}

if (process.argv[2] === "--daynight-claude-transcript-helper") await runHelper();
