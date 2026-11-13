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
import { createWorkerModelDiscovery, createWorkerReadOnlyConfiguration } from "../../../../src/commands/worker/read-only/models.js";
import { ToolSelectionManager } from "../../../../src/commands/worker/tool-selection.js";
import { createOperation } from "../../../../src/api/operation.js";
import type { WorkerConfigurationSnapshot, WorkerConfigurationToolTargets } from "../../../../src/commands/worker/configuration-model.js";
import { frozenToolLaunch } from "../../../helpers/tool-launch.js";
const disposals: (() => void)[] = [];
afterEach(() => { disposals.splice(0).forEach(close => close()); sockets.length = 0; vi.useRealTimers(); });
const setup = (execute = vi.fn(async () => ({ path: "/", parentPath: null, entries: [], nextCursor: null }))) => {
  const ownerUserId = randomUUID(), workerId = randomUUID();
  let signature = "one";
  const onError = vi.fn();
  const channel = createWorkerReadOnlyChannel({ serverOrigin: "http://127.0.0.1:1234", serverToken: "test-token", ownerUserId, workerId,
    configurationSignature: () => signature, execute, onError });
  disposals.push(channel.close);
  const socket = sockets[0]; socket.emit("open");
  const hello = socket.sent[0];
  const fence = { protocol: WORKER_READONLY_PROTOCOL, ownerUserId, workerId, connectionId: randomUUID(), capabilityGeneration: hello.capabilityGeneration };
  const emit = (value: unknown) => socket.emit("message", Buffer.from(JSON.stringify(value)), false);
  emit({ type: "ready", ...fence });
  return { channel, socket, fence, emit, execute, onError, change: () => { signature = "two"; } };
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

test("model requests dispatch independently of directory result shape", async () => {
  const result = { schemaVersion: 1, provider: "codex", models: [], nextCursor: null };
  const execute = vi.fn(async () => result as any);
  const { emit, fence, socket } = setup(execute);
  expect(socket.sent[0].operations).toContain("model.list");
  emit({ type: "request", ...fence, requestId: randomUUID(), operation: "model.list", input: { provider: "codex" }, timeoutMs: 30000 });
  await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
  expect(socket.sent[1].result).toEqual(result);
  expect(execute).toHaveBeenCalledWith("model.list", { provider: "codex" }, expect.any(AbortSignal));
});

test("model input failures do not dispatch and cleanup errors remain distinguishable", async () => {
  const execute = vi.fn(async () => { throw Object.assign(new Error("private process proof"), { code: "cleanup_unknown" }); });
  const { emit, fence, socket } = setup(execute);
  emit({ type: "request", ...fence, requestId: randomUUID(), operation: "model.list", input: { provider: "codex", model: null }, timeoutMs: 30000 });
  expect(socket.sent.at(-1).error.code).toBe("invalid_input");
  expect(execute).not.toHaveBeenCalled();
  emit({ type: "request", ...fence, requestId: randomUUID(), operation: "model.list", input: { provider: "codex" }, timeoutMs: 30000 });
  await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
  expect(socket.sent[2].error.code).toBe("cleanup_unknown");
  expect(JSON.stringify(socket.sent)).not.toContain("private process proof");
});

test("reports unconfirmed cleanup even after the caller cancels", async () => {
  let reject!: (error: unknown) => void;
  const execute = vi.fn(() => new Promise<any>((_resolve, failure) => { reject = failure; }));
  const { emit, fence, socket, onError } = setup(execute);
  const requestId = randomUUID();
  emit({ type: "request", ...fence, requestId, operation: "model.list", input: { provider: "codex" }, timeoutMs: 30000 });
  emit({ type: "cancel", ...fence, requestId });
  reject(Object.assign(new Error("private proof"), { code: "cleanup_unknown" }));
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("cleanup_unknown")));
  expect(socket.sent).toHaveLength(1);
  expect(JSON.stringify(onError.mock.calls)).not.toContain("private proof");
});

const modelChannel = () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let release!: () => void, entered!: () => void, token = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let probeSignal: AbortSignal | undefined;
  const check = vi.fn(async (_launch, operation) => { probeSignal = operation.signal; entered(); await gate; return { version: "1.0.0" }; });
  const tools = new ToolSelectionManager({ cwd: process.cwd(), environment: {}, readActiveSelections: () => [],
    resolve: async input => ({ ...frozenToolLaunch(input.tool === "copilot" ? "copilot" : "codex"), source: "path" }),
    verify: async () => {}, probe: { check, cacheToken: () => token, close: async () => {} } });
  let effective: WorkerConfigurationSnapshot["effective"] = { native: { agent: "codex", model: null, args: [] }, projects: [], agentControlMode: "web",
    maxConcurrent: 1, pollIntervalMs: 60_000, recoveryLimit: 3, preferPlatformSpecificTasks: false };
  let toolTargets: WorkerConfigurationToolTargets = { source: "local", revision: null, choices: { codex: { kind: "auto" }, copilot: { kind: "auto" }, herdr: { kind: "auto" } } };
  const configuration = createWorkerReadOnlyConfiguration({ current: () => ({ effective, toolTargets }), local: {}, selection: tool => {
    const launch = tools.currentSelection(tool, "web");
    return launch === undefined ? undefined : { selectionKey: launch.selectionKey, revision: token };
  } });
  const inspect = vi.fn(async (_input, operation) => { operation.check(); return { model: "a", models: [{ id: "a", efforts: null }, { id: "b", efforts: null }] }; });
  const discovery = createWorkerModelDiscovery({ configuration: configuration.modelConfiguration, defaultCwd: process.cwd(), environment: {},
    prepare: async (provider, operation) => { if (provider === "codex" || provider === "copilot") await tools.prepare(provider, "web", operation); }, verifier: { discover: inspect } });
  const ownerUserId = randomUUID(), workerId = randomUUID(), onInvalidate = vi.fn(() => discovery.invalidate());
  const channel = createWorkerReadOnlyChannel({ serverOrigin: "http://127.0.0.1:1234", serverToken: "test-token", ownerUserId, workerId,
    configurationSignature: configuration.channelSignature, onInvalidate, onError: vi.fn(),
    execute: async (_operation, input, signal) => discovery.discover(input as import("../../../../src/commands/worker/read-only/models.js").WorkerModelInput, signal) as never });
  const socket = sockets.at(-1); socket.emit("open");
  const fence = { protocol: WORKER_READONLY_PROTOCOL, ownerUserId, workerId, connectionId: randomUUID(), capabilityGeneration: socket.sent[0].capabilityGeneration };
  const emit = (value: unknown) => socket.emit("message", Buffer.from(JSON.stringify(value)), false);
  emit({ type: "ready", ...fence });
  return { tools, started, release, check, inspect, socket, channel, fence, emit, onInvalidate,
    probeSignal: () => probeSignal, invalidateProof: () => { token++; },
    restoreProof: async () => { const op = createOperation(); try { await tools.prepare("copilot", "web", op); } finally { op.dispose(); } },
    changeNative: () => { effective = { ...effective, native: { ...effective.native!, model: "changed" } }; },
    changeTargets: () => { toolTargets = { ...toolTargets, choices: { ...toolTargets.choices, copilot: { kind: "path", path: "/new/copilot" } } }; },
    close: async () => { release(); channel.close(); discovery.close(); const op = createOperation(); try { await tools.close(op); } finally { op.dispose(); } },
  };
};

test("first Copilot model query keeps its connected fence through preparation and invalidates old pages when proof changes", async () => {
  const f = modelChannel(), requestId = randomUUID();
  try {
    expect(f.tools.currentSelection("copilot", "web")).toBeUndefined();
    f.emit({ type: "request", ...f.fence, requestId, operation: "model.list", input: { provider: "copilot", limit: 1 }, timeoutMs: 30000 });
    await f.started;
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.channel.connected()).toBe(true);
    expect(f.onInvalidate).not.toHaveBeenCalled();
    f.release();
    await vi.waitFor(() => expect(f.socket.sent).toHaveLength(2));
    const response = f.socket.sent[1];
    expect(response).toMatchObject({ type: "result", requestId, ...f.fence, result: { provider: "copilot", models: [{ id: "a" }] } });
    expect(response.result.nextCursor).toBeTruthy();
    expect(f.check).toHaveBeenCalledOnce(); expect(f.inspect).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(1);
    const key = f.tools.currentSelection("copilot", "web")!.selectionKey;
    f.invalidateProof();
    expect(f.tools.currentSelection("copilot", "web")).toBeUndefined();
    await f.restoreProof();
    expect(f.tools.currentSelection("copilot", "web")!.selectionKey).toBe(key);
    const next = randomUUID();
    f.emit({ type: "request", ...f.fence, requestId: next, operation: "model.list", input: { provider: "copilot", limit: 1, cursor: response.result.nextCursor }, timeoutMs: 30000 });
    await vi.waitFor(() => expect(f.socket.sent).toHaveLength(3));
    expect(f.socket.sent[2]).toMatchObject({ requestId: next, error: { code: "stale_configuration" } });
    expect(f.channel.connected()).toBe(true);
  } finally { await f.close(); }
});

test("an already prepared recipe changing during discovery rejects the result without dropping the channel", async () => {
  const f = modelChannel();
  try {
    f.emit({ type: "request", ...f.fence, requestId: randomUUID(), operation: "model.list", input: { provider: "copilot" }, timeoutMs: 30000 });
    await f.started; f.release();
    await vi.waitFor(() => expect(f.socket.sent).toHaveLength(2));
    expect(f.socket.sent[1].result.provider).toBe("copilot");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    f.inspect.mockImplementationOnce(async (_input, operation) => { entered(); await gate; operation.check(); return { model: "a", models: [{ id: "a", efforts: null }] }; });
    const requestId = randomUUID();
    f.emit({ type: "request", ...f.fence, requestId, operation: "model.list", input: { provider: "copilot" }, timeoutMs: 30000 });
    await started;
    const key = f.tools.currentSelection("copilot", "web")!.selectionKey;
    f.invalidateProof();
    await f.restoreProof();
    expect(f.tools.currentSelection("copilot", "web")!.selectionKey).toBe(key);
    release();
    await vi.waitFor(() => expect(f.socket.sent).toHaveLength(3));
    expect(f.socket.sent[2]).toMatchObject({ requestId, error: { code: "stale_configuration" } });
    expect(f.channel.connected()).toBe(true);
  } finally { await f.close(); }
});

test.each(["native", "tool target"])("genuine %s configuration changes cancel in-flight preparation", async change => {
  const f = modelChannel(), requestId = randomUUID();
  try {
    f.emit({ type: "request", ...f.fence, requestId, operation: "model.list", input: { provider: "copilot" }, timeoutMs: 30000 });
    await f.started;
    if (change === "native") f.changeNative(); else f.changeTargets();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.channel.connected()).toBe(false); expect(f.onInvalidate).toHaveBeenCalledOnce();
    expect(f.probeSignal()?.aborted).toBe(true);
    f.release();
    await vi.waitFor(() => expect(f.tools.currentSelection("copilot", "web")).toBeUndefined());
    expect(f.socket.sent).toHaveLength(1);
    expect(f.inspect).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
