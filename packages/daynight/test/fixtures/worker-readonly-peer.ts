import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import type { Socket } from "node:net";
import { createInterface, type Interface } from "node:readline";
import WebSocket, { WebSocketServer } from "ws";
import type { WorkerDirectoryInput, WorkerDirectoryResult } from "../../src/commands/worker/read-only/directory.js";
import { terminateInstalledProcess } from "./installed-cli.js";

export type WorkerReadonlyTarget = { ownerUserId: string; workerId: string; serverToken: string; defaultCwd: string };
export type WorkerReadonlyFrame = { protocol: "daynight.worker-readonly.v1"; ownerUserId: string; workerId: string; connectionId: string; capabilityGeneration: string };
type Result = WorkerReadonlyFrame & { type: "result"; requestId: string; result?: WorkerDirectoryResult; error?: { code: string; message: string } };
type Pending = { workerId: string; resolve(value: { message: Result; raw: Buffer }): void; reject(error: Error): void; timer: NodeJS.Timeout };
export class WorkerReadonlyCleanupError extends AggregateError {
  constructor(errors: unknown[], readonly childrenDrained: boolean) { super(errors, "Worker peer execution or cleanup failed."); }
}

type Peer = { drained: boolean; target: WorkerReadonlyTarget; child: ChildProcessWithoutNullStreams; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; lines: Interface; socket?: WebSocket; fence?: WorkerReadonlyFrame; ready: boolean; stderr: string; lifetime: NodeJS.Timeout };
const protocol = "daynight.worker-readonly.v1" as const;
const fixture = path.resolve(import.meta.dirname, "worker-readonly-native.mjs");
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const startWorkerReadonlyPeers = async (targets: readonly WorkerReadonlyTarget[]): Promise<{
  request(workerId: string, requestId: string, input: WorkerDirectoryInput): Promise<{ message: Result; raw: Buffer }>;
  close(): Promise<void>;
}> => {
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  const peers = new Map<string, Peer>();
  const pending = new Map<string, Pending>();
  const sockets = new Set<WebSocket>();
  const connections = new Set<Socket>();
  server.on("connection", socket => { connections.add(socket); socket.once("close", () => connections.delete(socket)); });
  let failure: Error | undefined, closing = false, closePromise: Promise<void> | undefined;
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const allReady = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Startup can fail before the readiness promise is awaited.
  void allReady.catch(() => {});
  const fail = (cause: unknown): void => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    failure ??= error;
    readyReject(failure);
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(failure); }
    pending.clear();
  };
  server.on("error", fail);
  wss.on("error", fail);
  server.on("upgrade", (req, socket, head) => {
    try {
      const target = targets.find(item => req.url === `/api/v1/me/workers/${item.workerId}/readonly/channel`);
      const peer = target && peers.get(target.workerId);
      if (req.method !== "GET" || !target || !peer || req.headers.authorization !== `Bearer ${target.serverToken}` || peer.socket || closing) throw new Error("Unexpected Worker channel upgrade.");
      wss.handleUpgrade(req, socket, head, ws => {
        peer.socket = ws; sockets.add(ws);
        ws.on("error", fail);
        ws.on("close", () => { sockets.delete(ws); if (!closing) fail(new Error(`Worker ${target.workerId} channel closed unexpectedly.`)); });
        ws.on("message", (data, binary) => {
          try {
            if (binary) throw new Error("Worker channel sent a binary message.");
            const raw = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
            const message: unknown = JSON.parse(raw.toString("utf8"));
            if (!record(message)) throw new Error("Worker channel sent a non-object message.");
            if (!peer.fence) {
              const operations = message.operations;
              if (message.type !== "hello" || message.protocol !== protocol || !uuid(message.capabilityGeneration) || !Array.isArray(operations) || operations.length !== 2 || new Set(operations).size !== 2 || !operations.includes("directory.list") || !operations.includes("model.list")) throw new Error("Invalid Worker hello.");
              peer.fence = { protocol, ownerUserId: target.ownerUserId, workerId: target.workerId, connectionId: randomUUID(), capabilityGeneration: message.capabilityGeneration };
              ws.send(JSON.stringify({ type: "ready", ...peer.fence }));
              return;
            }
            const fence = peer.fence;
            if (message.type !== "result" || !uuid(message.requestId) || Object.entries(fence).some(([key, value]) => message[key] !== value)) throw new Error("Invalid Worker result fence or type.");
            const waiter = pending.get(message.requestId);
            if (!waiter || waiter.workerId !== target.workerId) throw new Error("Unexpected Worker result request ID or connection.");
            pending.delete(message.requestId); clearTimeout(waiter.timer);
            waiter.resolve({ message: message as Result, raw });
          } catch (error) { fail(error); }
        });
      });
    } catch (error) { socket.destroy(); fail(error); }
  });
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const errors: unknown[] = [];
      if (pending.size) { errors.push(new Error("Worker requests remained pending during cleanup.")); fail(errors[0]); }
      await Promise.all([...peers.values()].map(async peer => {
        clearTimeout(peer.lifetime);
        if (peer.child.exitCode === null && peer.child.signalCode === null) {
          peer.child.stdin.on("error", fail);
          peer.child.stdin.end("close\n");
        }
        let timer: NodeJS.Timeout | undefined;
        try {
          const result = await Promise.race([peer.closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Worker did not close within three seconds.")), 3000); })]);
          if (result.code !== 0 || result.signal !== null) errors.push(new Error(`Worker exited with code ${String(result.code)} and signal ${String(result.signal)}.`));
        } catch (error) {
          errors.push(error);
          try { await terminateInstalledProcess(peer.child, peer.closed); } catch (cleanupError) { errors.push(cleanupError); }
        } finally { if (timer) clearTimeout(timer); peer.lines.close(); }
        if (peer.stderr) errors.push(new Error(`Worker stderr: ${peer.stderr}`));
      }));
      const bounded = async (operation: Promise<void>, label: string): Promise<void> => {
        let timer: NodeJS.Timeout | undefined;
        try { await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not close within three seconds.`)), 3000); })]); }
        finally { if (timer) clearTimeout(timer); }
      };
      try {
        await bounded(Promise.all([...sockets].map(socket => new Promise<void>(resolve => {
          if (socket.readyState === WebSocket.CLOSED) resolve(); else socket.once("close", () => resolve());
        }))).then(() => {}), "Worker WebSocket");
      } catch (error) { errors.push(error); for (const socket of sockets) socket.terminate(); }
      const wsClosed = new Promise<void>((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
      try { await bounded(wsClosed, "WebSocket server"); }
      catch (error) {
        errors.push(error); for (const socket of sockets) socket.terminate();
        try { await bounded(wsClosed, "Forced WebSocket server"); } catch (drainError) { errors.push(drainError); }
      }
      if (server.listening) {
        const serverClosed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        try { await bounded(serverClosed, "HTTP server"); }
        catch (error) {
          errors.push(error); for (const connection of connections) connection.destroy();
          try { await bounded(serverClosed, "Forced HTTP server"); } catch (drainError) { errors.push(drainError); }
        }
      }
      if (failure) errors.unshift(failure);
      if (errors.length) throw new WorkerReadonlyCleanupError(errors, [...peers.values()].every(peer => peer.drained));
    })();
    return closePromise;
  };
  try {
    if (!targets.length || new Set(targets.map(target => target.workerId)).size !== targets.length) throw new Error("Worker roster must have distinct targets.");
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Worker peer listener has no TCP address.");
    for (const target of targets) {
      const child = spawn(process.execPath, [fixture], { cwd: target.defaultCwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
      const lines = createInterface({ input: child.stdout });
      const peer: Peer = { drained: false, target, child, closed, lines, ready: false, stderr: "", lifetime: setTimeout(() => { fail(new Error(`Worker ${target.workerId} exceeded its 45 second lifetime.`)); void close().catch(() => {}); }, 45_000) };
      peers.set(target.workerId, peer);
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.stderr.on("data", chunk => { peer.stderr += String(chunk); });
      lines.on("line", line => {
        if (line !== "WORKER_READONLY_READY" || peer.ready || !peer.fence) { fail(new Error("Unexpected Worker stdout or premature readiness.")); return; }
        peer.ready = true;
        if (peers.size === targets.length && [...peers.values()].every(item => item.ready)) readyResolve();
      });
      void closed.then(result => { peer.drained = true; if (!closing) fail(new Error(`Worker exited before cleanup: ${String(result.code)} / ${String(result.signal)}.`)); });
      child.stdin.write(`${JSON.stringify({ ...target, serverOrigin: `http://127.0.0.1:${address.port}` })}\n`);
    }
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([allReady, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Worker readiness exceeded ten seconds.")), 10_000); })]); }
    finally { if (timer) clearTimeout(timer); }
    if (failure) throw failure;
    return {
      request: async (workerId, requestId, input) => {
        if (failure) throw failure;
        const peer = peers.get(workerId);
        if (closing || !peer?.ready || !peer.socket || !peer.fence || !uuid(requestId) || pending.has(requestId)) throw new Error("Invalid Worker request target or ID.");
        const socket = peer.socket, fence = peer.fence;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => fail(new Error(`Worker request ${requestId} timed out.`)), 10_000);
          pending.set(requestId, { workerId, resolve: value => { if (Object.entries(fence).some(([key, expected]) => value.message[key as keyof WorkerReadonlyFrame] !== expected) || socket !== peer.socket) { reject(new Error("Worker result arrived on a different connection.")); return; } resolve(value); }, reject, timer });
          socket.send(JSON.stringify({ type: "request", ...fence, requestId, operation: "directory.list", input, timeoutMs: 10_000 }), error => { if (error) fail(error); });
        });
      },
      close,
    };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Worker peer startup and cleanup failed."); }
    throw error;
  }
};
