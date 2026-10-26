import { getEventListeners } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import { createHerdrRpcClient, HERDR_MAX_REQUEST_BYTES, HERDR_MAX_RESPONSE_BYTES, HerdrRpcError, herdrIpcAddress } from "../../../src/commands/worker/herdr/rpc.js";

type Request = { id: string; method: string; params: Record<string, unknown> };
const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp");
const cleanup: (() => Promise<void>)[] = [];
const operations: Operation[] = [];
const operation = (limits: Parameters<typeof createOperation>[0] = {}): Operation => {
  const result = createOperation(limits); operations.push(result); return result;
};
const tick = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const fixture = async (handle: (socket: Socket, request: Request) => void) => {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, "hi-"));
  const endpoint = path.join(directory, "s");
  const sockets = new Set<Socket>();
  const requests: Request[] = [];
  const peerErrors: Error[] = [];
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1; sockets.add(socket);
    // Deliberate client cancellation can reset a fixture's in-flight response write.
    socket.on("error", (error) => { peerErrors.push(error); });
    socket.once("close", () => { sockets.delete(socket); });
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) return;
      const request = JSON.parse(bytes.subarray(0, newline).toString("utf8")) as Request;
      requests.push(request); bytes = bytes.subarray(newline + 1);
      handle(socket, request);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(herdrIpcAddress(endpoint), () => { server.removeListener("error", reject); resolve(); });
  });
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error === undefined) resolve(); else reject(error); }); });
    await rm(directory, { recursive: true, force: true });
  });
  return { endpoint, client: createHerdrRpcClient(endpoint), requests, peerErrors, connectionCount: () => connections, sockets };
};
const response = (socket: Socket, id: string, result: Record<string, unknown>): void => {
  socket.write(`${JSON.stringify({ id, result })}\n`);
};
const disconnected = async (sockets: ReadonlySet<Socket>): Promise<void> => {
  const deadline = performance.now() + 2_000;
  while (sockets.size !== 0 && performance.now() < deadline) await tick();
  expect(sockets.size).toBe(0);
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const op of operations.splice(0)) op.dispose();
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe("Herdr local RPC", () => {
  it("maps logical paths directly to each platform's IPC address", () => {
    expect(herdrIpcAddress("/state/herdr.sock", "linux")).toBe("/state/herdr.sock");
    expect(herdrIpcAddress("/state/herdr.sock", "darwin")).toBe("/state/herdr.sock");
    expect(herdrIpcAddress("C:\\state\\herdr.sock", "win32")).toBe("\\\\.\\pipe\\C:\\state\\herdr.sock");
    for (const endpoint of ["", "relative.sock", "/state/invalid\0.sock"]) expect(() => herdrIpcAddress(endpoint, "linux")).toThrow("absolute logical path");
    expect(() => herdrIpcAddress("relative.sock", "win32")).toThrow("absolute logical path");
  });

  it("preserves opaque multiline Unicode input and reassembles split UTF-8 response bytes", async () => {
    const text = "worker-managed\n第一行\n  exact space\t😀\r\nfinal line";
    const f = await fixture((socket, request) => {
      const bytes = Buffer.from(`${JSON.stringify({ id: request.id, result: { type: "agent_prompted", text: request.params.text } })}\n`);
      const split = bytes.indexOf(Buffer.from("第")) + 1;
      socket.write(bytes.subarray(0, split));
      const timer = setTimeout(() => { socket.write(bytes.subarray(split)); }, 10);
      socket.once("close", () => { clearTimeout(timer); });
    });
    const op = operation();
    expect(await f.client.request("agent.prompt", { target: "pane", text }, op)).toEqual({ type: "agent_prompted", text });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({ method: "agent.prompt", params: { target: "pane", text } });
    expect(f.requests[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getEventListeners(op.signal, "abort")).toEqual([]);
    await disconnected(f.sockets);
  });

  it("opens independent connections and correlation IDs for explicit requests", async () => {
    const f = await fixture((socket, request) => { response(socket, request.id, { type: "pong" }); });
    const op = operation();
    expect(await f.client.request("ping", {}, op)).toEqual({ type: "pong" });
    expect(await f.client.request("ping", {}, op)).toEqual({ type: "pong" });
    expect(f.connectionCount()).toBe(2);
    expect(new Set(f.requests.map(({ id }) => id)).size).toBe(2);
    await disconnected(f.sockets);
  });

  it.each(["agent_blocked", "agent_prompt_failed", "timeout"])("preserves API error %s without interpreting it as safe to replay", async (code) => {
    const body = { code, message: "Original API diagnostic" };
    const f = await fixture((socket, request) => { socket.write(`${JSON.stringify({ id: request.id, error: body })}\n`); });
    const error: unknown = await f.client.request("agent.prompt", { target: "pane", text: "opaque" }, operation()).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(HerdrRpcError);
    expect(error).toMatchObject({ method: "agent.prompt", requestId: f.requests[0]!.id, submission: "unknown", code, apiMessage: body.message, cause: body });
    expect(f.connectionCount()).toBe(1);
    expect(f.requests).toHaveLength(1);
    await disconnected(f.sockets);
  });

  it.each([
    ["invalid JSON", () => "not JSON"],
    ["nonobject envelope", () => "null"],
    ["mismatched ID", () => JSON.stringify({ id: "other", result: { type: "pong" } })],
    ["missing ID", () => JSON.stringify({ result: { type: "pong" } })],
    ["both result and error", (id: string) => JSON.stringify({ id, result: { type: "pong" }, error: { code: "bad", message: "bad" } })],
    ["neither result nor error", (id: string) => JSON.stringify({ id })],
    ["malformed error code", (id: string) => JSON.stringify({ id, error: { code: 3, message: "bad" } })],
    ["malformed error message", (id: string) => JSON.stringify({ id, error: { code: "bad", message: null } })],
    ["missing result type", (id: string) => JSON.stringify({ id, result: {} })],
    ["nonobject result", (id: string) => JSON.stringify({ id, result: [] })],
  ] as const)("rejects %s without another request", async (_name, frame) => {
    const f = await fixture((socket, request) => { socket.write(`${frame(request.id)}\n`); });
    await expect(f.client.request("ping", {}, operation())).rejects.toMatchObject({ name: "HerdrRpcError", submission: "unknown", code: null });
    expect(f.connectionCount()).toBe(1);
    expect(f.requests).toHaveLength(1);
    await disconnected(f.sockets);
  });

  it("rejects invalid UTF-8 instead of replacing corrupted response characters", async () => {
    const f = await fixture((socket, request) => {
      const bytes = Buffer.from(`${JSON.stringify({ id: request.id, result: { type: "pong", text: "MARK" } })}\n`);
      bytes[bytes.indexOf(Buffer.from("MARK"))] = 0xff; socket.write(bytes);
    });
    const error: unknown = await f.client.request("ping", {}, operation()).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ name: "HerdrRpcError", submission: "unknown", cause: expect.any(TypeError) });
    await disconnected(f.sockets);
  });

  it("rejects EOF before the newline even when the partial response looks complete", async () => {
    const f = await fixture((socket, request) => { socket.end(JSON.stringify({ id: request.id, result: { type: "pong" } })); });
    await expect(f.client.request("ping", {}, operation())).rejects.toMatchObject({ name: "HerdrRpcError", submission: "unknown" });
    expect(f.connectionCount()).toBe(1);
    await disconnected(f.sockets);
  });

  it("retains a disconnected mutation as unknown and does not replay", async () => {
    const f = await fixture((socket) => { socket.destroy(); });
    await expect(f.client.request("workspace.create", { cwd: "/task" }, operation())).rejects.toMatchObject({ submission: "unknown", method: "workspace.create" });
    expect(f.requests).toHaveLength(1);
    expect(f.connectionCount()).toBe(1);
    await disconnected(f.sockets);
  });

  it("reports a connection failure as unsubmitted with the native cause", async () => {
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(path.join(scratch, "hi-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const client = createHerdrRpcClient(path.join(directory, "absent"));
    const error: unknown = await client.request("ping", {}, operation()).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(HerdrRpcError);
    expect(error).toMatchObject({ submission: "not-submitted", cause: expect.objectContaining({ code: expect.any(String) }) });
  });

  it("does not connect for a cancelled operation or non-JSON request", async () => {
    const f = await fixture(() => { throw new Error("Invalid requests must not reach Herdr."); });
    const controller = new AbortController(); controller.abort(new Error("Cancelled before RPC"));
    const cancelled = operation({ signal: controller.signal });
    await expect(f.client.request("ping", {}, cancelled)).rejects.toMatchObject({ submission: "not-submitted", cause: cancelled.signal.reason });
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const [method, params] of [["", {}], ["bad\nmethod", {}], ["ping", { omitted: undefined }], ["ping", { number: Number.NaN }], ["ping", { number: 1n }], ["ping", cyclic]] as [string, Record<string, unknown>][]) {
      await expect(f.client.request(method, params, operation())).rejects.toMatchObject({ submission: "not-submitted" });
    }
    await expect(f.client.request("ping", null as unknown as Record<string, unknown>, operation())).rejects.toMatchObject({ submission: "not-submitted" });
    await tick(); expect(f.connectionCount()).toBe(0);
  });

  it("accepts the exact upstream payload-byte boundary and rejects oversize UTF-8 before connecting", async () => {
    const f = await fixture((socket, request) => { response(socket, request.id, { type: "pong", bytes: Buffer.byteLength(JSON.stringify(request)) }); });
    const overhead = Buffer.byteLength(JSON.stringify({ id: "0".repeat(36), method: "ping", params: { text: "" } }));
    const result = await f.client.request("ping", { text: "x".repeat(HERDR_MAX_REQUEST_BYTES - overhead) }, operation());
    expect(result.bytes).toBe(HERDR_MAX_REQUEST_BYTES);
    await expect(f.client.request("ping", { text: "x".repeat(HERDR_MAX_REQUEST_BYTES - overhead + 1) }, operation())).rejects.toMatchObject({ submission: "not-submitted", cause: expect.any(RangeError) });
    await expect(f.client.request("ping", { text: "é".repeat(600_000) }, operation())).rejects.toMatchObject({ submission: "not-submitted", cause: expect.any(RangeError) });
    await tick(); expect(f.connectionCount()).toBe(1);
    await disconnected(f.sockets);
  });

  it("closes an oversized response at its fixed internal bound", async () => {
    const f = await fixture((socket) => { socket.end(Buffer.alloc(HERDR_MAX_RESPONSE_BYTES + 1, 0x20)); });
    await expect(f.client.request("session.snapshot", {}, operation())).rejects.toMatchObject({ submission: "unknown", cause: expect.any(RangeError) });
    expect(f.requests).toHaveLength(1);
    await disconnected(f.sockets);
  });

  it("applies the caller's smaller response bound and cumulative operation byte budget", async () => {
    const f = await fixture((socket, request) => { response(socket, request.id, { type: "pong", text: "x".repeat(64) }); });
    await expect(f.client.request("ping", {}, operation({ limits: { responseBytes: 32 } }))).rejects.toMatchObject({ submission: "unknown", cause: expect.any(RangeError) });
    const bytes = Buffer.byteLength(`${JSON.stringify({ id: "0".repeat(36), result: { type: "pong", text: "x".repeat(64) } })}\n`);
    const op = operation({ limits: { totalBytes: bytes * 2 - 1 } });
    await f.client.request("ping", {}, op);
    await expect(f.client.request("ping", {}, op)).rejects.toMatchObject({ submission: "unknown", cause: expect.objectContaining({ kind: "total_limit" }) });
    expect(op.signal.aborted).toBe(true);
    expect(f.connectionCount()).toBe(3);
    expect(getEventListeners(op.signal, "abort")).toEqual([]);
    await disconnected(f.sockets);
  });

  it("cancels a submitted request and closes its socket and abort listener", async () => {
    const received = deferred<void>();
    const f = await fixture(() => { received.resolve(); });
    const controller = new AbortController(); const op = operation({ signal: controller.signal });
    const pending = f.client.request("agent.prompt", { target: "pane", text: "do not replay" }, op).catch((error: unknown) => error);
    await received.promise; controller.abort(new Error("Stop this request"));
    expect(await pending).toMatchObject({ name: "HerdrRpcError", submission: "unknown", cause: op.signal.reason });
    expect(f.connectionCount()).toBe(1);
    expect(getEventListeners(op.signal, "abort")).toEqual([]);
    await disconnected(f.sockets);
  });

  it("does not renew its absolute request deadline when response fragments arrive", async () => {
    const received = deferred<void>();
    const f = await fixture((socket) => {
      received.resolve();
      const timer = setInterval(() => { socket.write(" "); }, 20);
      socket.once("close", () => { clearInterval(timer); });
    });
    const op = operation({ limits: { totalMs: 5_000, requestMs: 750 } });
    const pending = f.client.request("agent.prompt", { target: "pane", text: "one input" }, op).catch((error: unknown) => error);
    await received.promise;
    expect(await pending).toMatchObject({ name: "HerdrRpcError", submission: "unknown", message: expect.stringContaining("deadline exceeded") });
    expect(f.connectionCount()).toBe(1);
    expect(op.signal.aborted).toBe(false);
    expect(() => op.check()).not.toThrow();
    await disconnected(f.sockets);
  });

  it("uses the remaining operation deadline across the whole response", async () => {
    const f = await fixture(() => {});
    const op = operation({ limits: { totalMs: 750, requestMs: 5_000 } });
    const started = performance.now();
    await expect(f.client.request("session.snapshot", {}, op)).rejects.toMatchObject({ name: "HerdrRpcError", submission: "unknown" });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(f.connectionCount()).toBe(1);
    await disconnected(f.sockets);
  });

  it("rejects a response past the request deadline even before its timer callback runs", async () => {
    const now = performance.now();
    const f = await fixture((socket, request) => {
      vi.spyOn(performance, "now").mockReturnValue(now + 2_000);
      response(socket, request.id, { type: "pong" });
    });
    const op = operation({ limits: { totalMs: 10_000, requestMs: 1_000 } });
    const result = await f.client.request("ping", {}, op).catch((error: unknown) => error);
    vi.restoreAllMocks();
    expect(result).toMatchObject({ name: "HerdrRpcError", submission: "unknown", cause: expect.objectContaining({ message: "The Herdr RPC request deadline elapsed." }) });
    expect(op.signal.aborted).toBe(false);
    expect(f.connectionCount()).toBe(1);
    await disconnected(f.sockets);
  });
});
