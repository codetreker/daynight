import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
const sockets = vi.hoisted(() => [] as any[]);
vi.mock("ws", () => ({ default: class extends EventEmitter {
  static OPEN = 1; readyState = 1; sent: any[] = [];
  constructor() { super(); sockets.push(this); }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  terminate() { this.readyState = 3; this.emit("close"); }
} }));
import { createWorkerReadOnlyChannel, WORKER_READONLY_PROTOCOL } from "../../../../src/commands/worker/read-only/channel.js";
const disposals: (() => void)[] = [];
afterEach(() => { disposals.splice(0).forEach(close => close()); sockets.length = 0; vi.useRealTimers(); });
const setup = (execute = vi.fn(async () => ({ path: "/", parentPath: null, entries: [], nextCursor: null }))) => {
  const ownerUserId = randomUUID(), workerId = randomUUID();
  let signature = "one";
  const channel = createWorkerReadOnlyChannel({ serverOrigin: "http://127.0.0.1:1234", serverToken: "test-token", ownerUserId, workerId,
    configurationSignature: () => signature, execute, onError: vi.fn() });
  disposals.push(channel.close);
  const socket = sockets[0]; socket.emit("open");
  const hello = socket.sent[0];
  const fence = { protocol: WORKER_READONLY_PROTOCOL, ownerUserId, workerId, connectionId: randomUUID(), capabilityGeneration: hello.capabilityGeneration };
  const emit = (value: unknown) => socket.emit("message", Buffer.from(JSON.stringify(value)), false);
  emit({ type: "ready", ...fence });
  return { channel, socket, fence, emit, execute, change: () => { signature = "two"; } };
};
test("routes only the ready identity and preserves all result fences", async () => {
  const { socket, fence, emit, execute } = setup();
  const requestId = randomUUID();
  emit({ type: "request", ...fence, requestId, operation: "directory.list", input: {}, timeoutMs: 10000 });
  await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
  expect(execute).toHaveBeenCalledWith("directory.list", {}, expect.any(AbortSignal));
  expect(socket.sent[1]).toEqual({ type: "result", ...fence, requestId, result: { path: "/", parentPath: null, entries: [], nextCursor: null } });
});
test("wrong Worker and connection never dispatch to the filesystem", () => {
  const { emit, fence, execute, channel } = setup();
  emit({ type: "request", ...fence, workerId: randomUUID(), requestId: randomUUID(), operation: "directory.list", input: {}, timeoutMs: 10000 });
  expect(execute).not.toHaveBeenCalled(); expect(channel.connected()).toBe(false);
});
test("cancel aborts work and suppresses a late result", async () => {
  let finish!: (value: any) => void;
  const execute = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
  const { emit, fence, socket } = setup(execute);
  const requestId = randomUUID();
  emit({ type: "request", ...fence, requestId, operation: "directory.list", input: {}, timeoutMs: 10000 });
  emit({ type: "cancel", ...fence, requestId });
  expect((execute.mock.calls[0] as any)[2].aborted).toBe(true);
  finish({ path: "/", parentPath: null, entries: [], nextCursor: null });
  await new Promise(resolve => setImmediate(resolve));
  expect(socket.sent).toHaveLength(1);
});
test("configuration change invalidates even before periodic reconnect", () => {
  const { emit, fence, execute, change } = setup(); change();
  emit({ type: "request", ...fence, requestId: randomUUID(), operation: "directory.list", input: {}, timeoutMs: 10000 });
  expect(execute).not.toHaveBeenCalled();
});
test("timeout aborts and returns an explicit error; close cancels all outstanding work", async () => {
  vi.useFakeTimers();
  const execute = vi.fn(() => new Promise<any>(() => {}));
  const { emit, fence, socket, channel } = setup(execute);
  const requestId = randomUUID();
  emit({ type: "request", ...fence, requestId, operation: "directory.list", input: {}, timeoutMs: 10000 });
  await vi.advanceTimersByTimeAsync(10000);
  expect(socket.sent.at(-1)).toMatchObject({ requestId, error: { code: "timeout" } });
  expect((execute.mock.calls[0] as any)[2].aborted).toBe(true);
  const next = randomUUID(); emit({ type: "request", ...fence, requestId: next, operation: "directory.list", input: {}, timeoutMs: 10000 });
  channel.close(); expect((execute.mock.calls[1] as any)[2].aborted).toBe(true);
});
test("connection replacement suppresses old completion and advertises a new capability generation", async () => {
  vi.useFakeTimers();
  let finish!: (value: any) => void;
  const execute = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
  const { emit, fence, socket } = setup(execute);
  emit({ type: "request", ...fence, requestId: randomUUID(), operation: "directory.list", input: {}, timeoutMs: 10000 });
  socket.terminate(); await vi.advanceTimersByTimeAsync(5000);
  expect(sockets).toHaveLength(2); sockets[1].emit("open");
  expect(sockets[1].sent[0].capabilityGeneration).not.toBe(fence.capabilityGeneration);
  finish({ path: "/", parentPath: null, entries: [], nextCursor: null }); await vi.advanceTimersByTimeAsync(0);
  expect(socket.sent).toHaveLength(1); expect(sockets[1].sent).toHaveLength(1);
});
test("unsupported and invalid inputs fail without executing", () => {
  const { emit, fence, socket, execute } = setup();
  const request = { type: "request", ...fence, requestId: randomUUID(), operation: "shell", input: {}, timeoutMs: 10000 };
  emit(request); expect(socket.sent.at(-1).error.code).toBe("unsupported");
  emit({ ...request, requestId: randomUUID(), operation: "directory.list", input: { limit: 101 } });
  expect(socket.sent.at(-1).error.code).toBe("invalid_path"); expect(execute).not.toHaveBeenCalled();
});
test("cancelled but unsettled executors retain admission slots", () => {
  const execute = vi.fn(() => new Promise<any>(() => {}));
  const { emit, fence, socket } = setup(execute);
  for (let i = 0; i < 16; i++) {
    const requestId = randomUUID();
    emit({ type: "request", ...fence, requestId, operation: "directory.list", input: {}, timeoutMs: 10000 });
    emit({ type: "cancel", ...fence, requestId });
  }
  emit({ type: "request", ...fence, requestId: randomUUID(), operation: "directory.list", input: {}, timeoutMs: 10000 });
  expect(socket.sent.at(-1).error.code).toBe("busy"); expect(execute).toHaveBeenCalledTimes(16);
});
test("native errors are classified without leaking their messages", async () => {
  const execute = vi.fn(async () => { throw Object.assign(new Error("secret path"), { code: "permission_denied" }); });
  const { emit, fence, socket } = setup(execute);
  emit({ type: "request", ...fence, requestId: randomUUID(), operation: "directory.list", input: {}, timeoutMs: 10000 });
  await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
  expect(socket.sent[1].error.code).toBe("permission_denied"); expect(JSON.stringify(socket.sent)).not.toContain("secret path");
});
