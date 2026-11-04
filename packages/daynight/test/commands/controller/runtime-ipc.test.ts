import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createConnection, Socket } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import type { ProviderOptions } from "../../../src/commands/controller/providers/types.js";
const f = vi.hoisted(() => ({ send: vi.fn(), close: vi.fn(), waitForTurn: vi.fn() }));
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ captureControllerProcessProof: async () => ({ pid: 1, parentPid: 0, processGroupId: 1, startedAt: "test", commandHash: "test" }) }));
vi.mock("../../../src/commands/controller/relay.js", () => ({ createControllerRelay: (_ticket: unknown, _journal: unknown, callbacks: { onConnection(connected: boolean): void }) => {
  queueMicrotask(() => callbacks.onConnection(true));
  return { flush: async () => {}, close: () => {}, connected: () => true };
} }));
vi.mock("../../../src/commands/controller/providers/claude.js", () => ({ openClaudeProvider: async (options: ProviderOptions) => {
  options.onState({ nativeSessionId: "native-test", activity: "idle", currentTurnId: null, capabilities: { send: true, steer: false, cancel: true, respond: true } });
  return { nativeSessionId: "native-test", send: f.send, close: f.close, cancel: async () => {}, waitForTurn: f.waitForTurn };
} }));
import { runController } from "../../../src/commands/controller/runtime.js";
import { requestController } from "../../../src/commands/controller/local-client.js";
import { writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const setup = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "ipc-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", testExecutionId: randomUUID(), ownerUserId: randomUUID(), provider: "claude", cwd: process.cwd(), nativeHome: path.join(home, "native"), configuration: { agent: "claude", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialInput: "prompt", initialOperationId: randomUUID(), initialPrompt: "accepted once", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: process.platform === "win32" ? String.raw`\\.\pipe\daynight-ipc-test-${randomUUID()}` : path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  await writeLaunchTicket(home, ticket);
  const running = runController({ homeDirectory: home, provider: "claude", launchId: ticket.launchId });
  void running.catch(() => {});
  await vi.waitFor(async () => expect((await requestController(ticket, { kind: "observe" })).snapshot.lifecycle).toBe("ready"));
  return { ticket, running, stop: async () => { await requestController(ticket, { kind: "stop", deadline: Date.now() + 2000 }); await running; } };
};

test("authenticated input clears its admission deadline while incomplete frames still expire", async () => {
  const nativeInput = Promise.withResolvers<{ disposition: "started"; turnId: string }>();
  f.send.mockReturnValue(nativeInput.promise);
  const v = await setup();
  const admitted: Socket[] = [];
  const nativeSetTimeout = Socket.prototype.setTimeout;
  const timeoutPolicy = vi.spyOn(Socket.prototype, "setTimeout").mockImplementation(function (this: Socket, milliseconds, callback) {
    if (milliseconds === 30_000) admitted.push(this);
    return nativeSetTimeout.call(this, milliseconds, callback);
  });
  const incomplete = createConnection(v.ticket.ipcEndpoint);
  incomplete.on("error", () => {});
  let waiting: ReturnType<typeof requestController> | undefined;
  let responseSettled = false;
  try {
    await once(incomplete, "connect");
    await vi.waitFor(() => expect(admitted).toHaveLength(1));
    const incompletePeer = admitted[0]!;
    const fragment = once(incompletePeer, "data");
    incomplete.write("{");
    expect((await fragment)[0]).toBe("{");
    expect(incompletePeer.timeout).toBe(30_000);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    waiting = requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId }, { timeoutMs: 65_000 });
    void waiting.then(() => { responseSettled = true; }, () => { responseSettled = true; });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(admitted).toHaveLength(2);
    const authenticatedPeer = admitted[1]!;
    expect(authenticatedPeer.timeout).toBe(0);
    expect(responseSettled).toBe(false);

    let admissionExpired = false;
    let admissionClosed = false;
    incompletePeer.once("timeout", () => { admissionExpired = true; });
    incomplete.once("close", () => { admissionClosed = true; });
    // Socket inactivity timers use Node internals, so exercise their native
    // timeout event after shortening only the already-observed incomplete frame.
    nativeSetTimeout.call(incompletePeer, 1);
    await vi.waitFor(() => expect(admissionClosed).toBe(true), { timeout: 5_000 });
    expect(admissionExpired).toBe(true);
    expect(incomplete.destroyed).toBe(true);

    await vi.advanceTimersByTimeAsync(31_000);
    vi.useRealTimers();
    expect(authenticatedPeer.destroyed).toBe(false);
    expect(responseSettled).toBe(false);
    expect(f.send).toHaveBeenCalledOnce(); expect(f.close).not.toHaveBeenCalled();
    nativeInput.resolve({ disposition: "started", turnId: "same-turn" });
    const result = await waiting;
    expect(result.operation?.state).toBe("confirmed");
    expect(result.snapshot.initialInputState).toBe("confirmed");
    expect(f.send).toHaveBeenCalledOnce(); expect(f.close).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers(); timeoutPolicy.mockRestore();
    nativeInput.resolve({ disposition: "started", turnId: "same-turn" });
    incomplete.destroy();
    await waiting?.catch(() => {});
    for (const socket of admitted) socket.destroy();
    await v.stop();
  }
}, 40_000);

test("a lost IPC response does not prevent native acceptance from becoming observable", async () => {
  let accepted!: () => void;
  f.send.mockImplementation(() => new Promise(resolve => { accepted = () => resolve({ disposition: "started", turnId: "same-turn" }); }));
  const v = await setup();
  try {
    await expect(requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId }, { timeoutMs: 50 })).rejects.toThrow("outcome is unknown");
    accepted();
    await vi.waitFor(async () => expect((await requestController(v.ticket, { kind: "observe" })).snapshot.initialInputState).toBe("confirmed"));
    expect(f.send).toHaveBeenCalledOnce(); expect(f.close).not.toHaveBeenCalled();
  } finally { accepted?.(); await v.stop(); }
});


test("the authenticated response deadline releases its socket while native work continues", async () => {
  let accepted!: () => void;
  f.send.mockImplementation(() => new Promise(resolve => { accepted = () => resolve({ disposition: "started", turnId: "late-turn" }); }));
  const v = await setup();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const waiting = requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId }, { timeoutMs: 90_000 });
  const outcome = waiting.catch(error => error as Error);
  try {
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(65_000);
    vi.useRealTimers();
    expect(await outcome).toMatchObject({ message: "Controller IPC closed before its response; outcome is unknown." });
    expect(f.close).not.toHaveBeenCalled();
    accepted();
    await vi.waitFor(async () => expect((await requestController(v.ticket, { kind: "observe" })).snapshot.initialInputState).toBe("confirmed"));
    expect(f.send).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); accepted?.(); await v.stop(); }
});

test("duplicate authenticated waiters are bounded without blocking observe or explicit stop", async () => {
  let accepted!: () => void;
  f.send.mockImplementation(() => new Promise(resolve => { accepted = () => resolve({ disposition: "started", turnId: "same-turn" }); }));
  f.close.mockImplementation(async () => { accepted(); await new Promise(resolve => setImmediate(resolve)); });
  const v = await setup();
  const waiting = Array.from({ length: 32 }, () => requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId }));
  const outcomes = Promise.allSettled(waiting);
  try {
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    // A request on a later accepted socket is processed after the 32 waiters.
    await expect(requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId })).rejects.toThrow("capacity");
    expect((await requestController(v.ticket, { kind: "observe" })).snapshot.initialInputState).toBe("dispatching");
    expect(f.send).toHaveBeenCalledOnce(); expect(f.close).not.toHaveBeenCalled();
    await v.stop(); expect(f.close).toHaveBeenCalledOnce();
    await outcomes;
  } finally { accepted?.(); if (!f.close.mock.calls.length) await v.stop(); await outcomes; }
});

test("a lost initial response exposes a later definitive native rejection through the original journal", async () => {
  const { NativeRpcError } = await import("../../../src/commands/controller/providers/native-rpc.js");
  let rejectInput!: () => void;
  f.send.mockImplementation(() => new Promise((_resolve, reject) => { rejectInput = () => reject(new NativeRpcError(-32602, "Initial native input was rejected.")); }));
  const v = await setup();
  try {
    await expect(requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId }, { timeoutMs: 50 })).rejects.toThrow("outcome is unknown");
    rejectInput();
    await vi.waitFor(async () => expect((await requestController(v.ticket, { kind: "observe" })).snapshot).toMatchObject({ initialInputState: "failed", lifecycle: "ready" }));
    expect(f.send).toHaveBeenCalledOnce(); expect(f.close).not.toHaveBeenCalled();
  } finally { rejectInput?.(); await v.stop(); }
});


test("cleanup IPC keeps its response open beyond the former short wait while retaining the original agent deadline", async () => {
  const cleanupTurn = Promise.withResolvers<void>();
  f.send.mockResolvedValue({ disposition: "started", turnId: "cleanup-turn" });
  f.waitForTurn.mockReturnValue(cleanupTurn.promise);
  f.close.mockResolvedValue(undefined);
  const v = await setup();
  const deadline = Date.now() + 600_000;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const response = requestController(v.ticket, { kind: "cleanup", operationId: randomUUID(), prompt: "clean temporary resources", deadline }, { timeoutMs: 360_000 });
  let settled = false;
  void response.then(() => { settled = true; }, () => { settled = true; });
  try {
    await vi.waitFor(() => expect(f.waitForTurn).toHaveBeenCalledWith("cleanup-turn", deadline));
    await vi.advanceTimersByTimeAsync(240_000);
    expect(settled).toBe(false);
    vi.useRealTimers();
    cleanupTurn.resolve();
    expect((await response).operation?.state).toBe("confirmed");
    expect(f.send).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers(); cleanupTurn.resolve();
    await response.catch(() => {});
    await v.stop();
  }
});
