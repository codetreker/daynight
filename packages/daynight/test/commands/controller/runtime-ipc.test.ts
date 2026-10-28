import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createConnection } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import type { ProviderOptions } from "../../../src/commands/controller/providers/types.js";
const f = vi.hoisted(() => ({ send: vi.fn(), close: vi.fn() }));
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ captureControllerProcessProof: async () => ({ pid: 1, parentPid: 0, processGroupId: 1, startedAt: "test", commandHash: "test" }) }));
vi.mock("../../../src/commands/controller/relay.js", () => ({ createControllerRelay: (_ticket: unknown, _journal: unknown, callbacks: { onConnection(connected: boolean): void }) => {
  queueMicrotask(() => callbacks.onConnection(true));
  return { flush: async () => {}, close: () => {}, connected: () => true };
} }));
vi.mock("../../../src/commands/controller/providers/claude.js", () => ({ openClaudeProvider: async (options: ProviderOptions) => {
  options.onState({ nativeSessionId: "native-test", activity: "idle", currentTurnId: null, capabilities: { send: true, steer: false, cancel: true, respond: true } });
  return { nativeSessionId: "native-test", send: f.send, close: f.close };
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

test("an authenticated initial submission may finish after the 30-second admission window", async () => {
  f.send.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 31_000)); return { disposition: "started", turnId: "same-turn" }; });
  const v = await setup();
  const incomplete = createConnection(v.ticket.ipcEndpoint);
  const admissionClosed = new Promise<void>(resolve => incomplete.once("close", () => resolve()));
  incomplete.on("error", () => {}); incomplete.once("connect", () => incomplete.write("{"));
  try {
    const result = await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId }, { timeoutMs: 65_000 });
    await admissionClosed; expect(incomplete.destroyed).toBe(true);
    expect(result.operation?.state).toBe("confirmed");
    expect(result.snapshot.initialInputState).toBe("confirmed");
    expect(f.send).toHaveBeenCalledOnce(); expect(f.close).not.toHaveBeenCalled();
  } finally { incomplete.destroy(); await v.stop(); }
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
