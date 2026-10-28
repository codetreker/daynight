import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import type { ProviderEntry, ProviderOptions, ProviderState } from "../../../src/commands/controller/providers/types.js";
const sdk = vi.hoisted(() => ({ construct: vi.fn(), connection: vi.fn((url, options) => ({ kind: "uri", url, ...options })) }));
const processMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("@github/copilot-sdk", () => ({ CopilotClient: class { constructor(options: unknown) { return sdk.construct(options); } }, RuntimeConnection: { forUri: sdk.connection } }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: processMock.spawn }));
import { openCopilotProvider } from "../../../src/commands/controller/providers/copilot.js";

const event = (type: string, data: unknown = {}, agentId?: string) => ({ id: randomUUID(), timestamp: new Date().toISOString(), parentId: null, type, data, ...(agentId ? { agentId } : {}) });
let fixture: ReturnType<typeof setup>;
function setup() {
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null, signalCode: null as string | null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
  const kill = () => { child.signalCode = "SIGTERM"; child.emit("exit", null, "SIGTERM"); child.emit("close", null, "SIGTERM"); return true; };
  child.kill.mockImplementation(kill);
  processMock.spawn.mockImplementation(() => { queueMicrotask(() => { child.emit("spawn"); child.stdout.write("Listening on port 54321\n"); }); return child; });
  let captured: { sessionId: string; onEvent: (e: unknown) => void; [key: string]: unknown };
  const native = { sessionId: "", send: vi.fn(async () => "native-message-id"), getEvents: vi.fn(async () => [] as unknown[]), disconnect: vi.fn(async () => {}), rpc: {
    metadata: { snapshot: vi.fn(async () => ({ sessionId: native.sessionId, workingDirectory: process.cwd(), alreadyInUse: false, isRemote: false })), isProcessing: vi.fn(async () => ({ processing: false })) },
    plan: { readSqlTodos: vi.fn(async () => ({ rows: [] as { id?: string; title?: string; description?: string; status?: string }[] })) }, interruptMainTurn: vi.fn(async () => ({ interrupted: true })), permissions: { configure: vi.fn(async () => ({ success: true })), handlePendingPermissionRequest: vi.fn(async () => ({ success: true })) },
  } };
  const capture = async (config: typeof captured) => { captured = config; native.sessionId = config.sessionId; return native; };
  const client = { start: vi.fn(async () => {}), stop: vi.fn(async () => []), forceStop: vi.fn(async () => {}), ping: vi.fn(async () => ({})), createSession: vi.fn(capture), resumeSession: vi.fn(async (id, config) => capture({ ...config, sessionId: id })), getSessionMetadata: vi.fn(async (id: string) => ({ sessionId: id, isRemote: false, context: { workingDirectory: process.cwd() } })), rpc: { skills: { getDiscoveryPaths: vi.fn(async () => ({ paths: [{ path: "/native/project/skills" }] })) }, runtime: { shutdown: vi.fn(async () => ({})) }, sessions: { checkInUse: vi.fn(async () => ({ inUse: [] as string[] })) } } };
  sdk.construct.mockReturnValue(client);
  const entries: ProviderEntry[] = [], states: ProviderState[] = [], observed: string[] = [], spawned: unknown[] = [];
  const options: ProviderOptions = { cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, executable: "/controlled/copilot", env: { ...process.env, COPILOT_HOME: "/private/copilot-profile" }, onTimeline: e => entries.push(structuredClone(e)), onState: s => states.push(structuredClone(s)), onInputObserved: id => observed.push(id), onSpawn: p => { expect(p.pid).toBe(12345); spawned.push(p); } };
  return { child, client, native, entries, states, options, observed, spawned, emit: (e: unknown) => captured.onEvent(e), config: () => captured };
}
beforeEach(() => { vi.clearAllMocks(); fixture = setup(); });
afterEach(() => vi.useRealTimers());

test("Copilot owns a token-authenticated local runtime, preserves private profile and stops its child", async () => {
  const provider = await openCopilotProvider(fixture.options);
  expect(fixture.spawned).toEqual([fixture.child]);
  const [command, args, settings] = processMock.spawn.mock.calls[0]!;
  expect(command).toBe("/controlled/copilot"); expect(args).toContain("--headless"); expect(args).not.toContain("--remote");
  expect(settings).toMatchObject({ detached: false, cwd: process.cwd(), env: { COPILOT_HOME: "/private/copilot-profile" } });
  expect(settings.env.COPILOT_CONNECTION_TOKEN).toMatch(/^[a-f0-9]{64}$/);
  expect(sdk.connection).toHaveBeenCalledWith("127.0.0.1:54321", { connectionToken: settings.env.COPILOT_CONNECTION_TOKEN });
  expect(fixture.config()).toMatchObject({ streaming: true, skillDirectories: ["/native/project/skills"] });
  expect(fixture.client.rpc.skills.getDiscoveryPaths).toHaveBeenCalledWith({ projectPaths: [process.cwd()] });
  expect(fixture.config().model).toBeUndefined(); expect(fixture.config().reasoningEffort).toBeUndefined();
  await provider.close(); expect(fixture.child.kill).toHaveBeenCalled(); expect(fixture.states.at(-1)?.activity).toBe("stopped");
});

test("Copilot reports native skill discovery failures while keeping the session usable", async () => {
  fixture.client.rpc.skills.getDiscoveryPaths.mockRejectedValue(new Error("Discovery unavailable"));
  const provider = await openCopilotProvider(fixture.options);
  expect(fixture.states.at(-1)?.controls?.commandsError).toContain("Discovery unavailable");
  expect(fixture.states.at(-1)?.capabilities.send).toBe(true);
  await provider.close();
});

test.each(["missing", "wrong_id", "wrong_cwd", "in_use", "remote"])("Copilot exact resume refuses %s before attempting native resume or create", async failure => {
  const id = randomUUID();
  if (failure === "missing") fixture.client.getSessionMetadata.mockResolvedValue(undefined as never);
  if (failure === "wrong_id") fixture.client.getSessionMetadata.mockResolvedValue({ sessionId: randomUUID(), isRemote: false, context: { workingDirectory: process.cwd() } });
  if (failure === "wrong_cwd") fixture.client.getSessionMetadata.mockResolvedValue({ sessionId: id, isRemote: false, context: { workingDirectory: "/" } });
  if (failure === "remote") fixture.client.getSessionMetadata.mockResolvedValue({ sessionId: id, isRemote: true, context: { workingDirectory: process.cwd() } });
  if (failure === "in_use") fixture.client.rpc.sessions.checkInUse.mockResolvedValue({ inUse: [id] });
  await expect(openCopilotProvider({ ...fixture.options, resumeNativeSessionId: id })).rejects.toThrow();
  expect(fixture.client.resumeSession).not.toHaveBeenCalled(); expect(fixture.client.createSession).not.toHaveBeenCalled(); expect(fixture.child.kill).toHaveBeenCalled();
});

test("Copilot rechecks native identity and directory after opening", async () => {
  fixture.native.rpc.metadata.snapshot.mockResolvedValue({ sessionId: "wrong", workingDirectory: process.cwd(), alreadyInUse: false, isRemote: false });
  await expect(openCopilotProvider(fixture.options)).rejects.toThrow(/identity|directory/i);
  expect(fixture.native.disconnect).toHaveBeenCalled(); expect(fixture.child.kill).toHaveBeenCalled();
});

test("Copilot delivers early native events and final messages upsert their streamed identity", async () => {
  fixture.client.createSession.mockImplementation(async config => {
    fixture.native.sessionId = config.sessionId;
    config.onEvent(event("assistant.message_delta", { messageId: "m", deltaContent: "draft" }));
    return fixture.native;
  });
  fixture.native.getEvents.mockResolvedValue([event("assistant.message", { messageId: "m", content: "corrected final" })]);
  const provider = await openCopilotProvider(fixture.options);
  const text = fixture.entries.filter(e => e.kind === "assistant_message");
  expect(new Set(text.map(e => e.entryId)).size).toBe(1);
  expect(text.at(-1)).toMatchObject({ content: [{ type: "text", text: "corrected final" }] });
  await provider.close();
});

test("Copilot ACK confirms only its send; text history never fabricates operation confirmation", async () => {
  const id = randomUUID(), operation = randomUUID();
  fixture.native.getEvents.mockResolvedValue([event("user.message", { content: "same text", messageId: operation })]);
  const provider = await openCopilotProvider({ ...fixture.options, resumeNativeSessionId: id });
  const receipt = await provider.send("same text", operation, null);
  expect(receipt.disposition).toBe("started"); expect(receipt.turnId).toBeTruthy();
  expect(fixture.native.send).toHaveBeenCalledWith({ prompt: "same text", mode: "immediate" });
  expect(fixture.observed).not.toContain(operation);
  await provider.close();
});

test("Copilot model-step completion and child idle cannot complete the foreground turn", async () => {
  const provider = await openCopilotProvider(fixture.options);
  const receipt = await provider.send("work", randomUUID(), null); let ended = false;
  const waiting = provider.waitForTurn(receipt.turnId!, Date.now() + 2000).then(() => { ended = true; });
  fixture.emit(event("assistant.turn_start", { turnId: "0", interactionId: "a" }));
  fixture.emit(event("assistant.turn_end", { turnId: "0" }));
  fixture.emit(event("assistant.idle", {}, "child"));
  await Promise.resolve(); expect(ended).toBe(false); expect(fixture.states.at(-1)?.currentTurnId).toBe(receipt.turnId);
  fixture.emit(event("assistant.idle")); await waiting; expect(fixture.states.at(-1)?.currentTurnId).toBeNull();
  const next = await provider.send("next", randomUUID(), null); expect(next.turnId).not.toBe(receipt.turnId);
  await provider.close();
});

test("Copilot steer belongs to the active turn and stale sends are rejected before native dispatch", async () => {
  const provider = await openCopilotProvider(fixture.options), receipt = await provider.send("work", randomUUID(), null);
  await expect(provider.send("stale", randomUUID(), randomUUID())).rejects.toThrow(/turn/i);
  expect(fixture.native.send).toHaveBeenCalledTimes(1);
  await expect(provider.send("direction", randomUUID(), receipt.turnId!)).resolves.toMatchObject({ turnId: receipt.turnId });
  await provider.close();
});

test("Copilot cancellation waits for foreground stop and preserves child ownership", async () => {
  const provider = await openCopilotProvider(fixture.options), receipt = await provider.send("work", randomUUID(), null); let confirmed = false;
  const cancel = provider.cancel(receipt.turnId!).then(() => { confirmed = true; });
  await Promise.resolve(); expect(confirmed).toBe(false);
  fixture.emit(event("abort", {}, "child")); await Promise.resolve(); expect(confirmed).toBe(false);
  fixture.emit(event("abort")); await cancel;
  expect(fixture.native.rpc.interruptMainTurn).toHaveBeenCalledWith({}); await provider.close();
});

test("Copilot child loss rejects in-flight send and disables all controls without replay", async () => {
  const provider = await openCopilotProvider(fixture.options);
  fixture.native.send.mockImplementation(() => new Promise(() => {}));
  const send = provider.send("uncertain", randomUUID(), null), rejection = expect(send).rejects.toThrow(/unknown|connection|stopped/);
  await Promise.resolve();
  fixture.child.exitCode = 1; fixture.child.emit("exit", 1, null); fixture.child.emit("close", 1, null);
  await rejection; expect(fixture.states.at(-1)).toMatchObject({ activity: "unknown", capabilities: { send: false, steer: false, cancel: false, respond: false } });
  await expect(provider.send("again", randomUUID(), null)).rejects.toThrow(); expect(fixture.native.send).toHaveBeenCalledTimes(1);
  await provider.close();
});

test("Copilot rejects startup output overflow and cleans the owned child", async () => {
  processMock.spawn.mockImplementation(() => { queueMicrotask(() => { fixture.child.emit("spawn"); fixture.child.stdout.write("x".repeat(70_000)); }); return fixture.child; });
  await expect(openCopilotProvider(fixture.options)).rejects.toThrow(/limit|large/i);
  expect(fixture.child.kill).toHaveBeenCalled();
});

test("Copilot owned runtime requests graceful shutdown before transport disposal", async () => {
  const provider = await openCopilotProvider(fixture.options); await provider.close();
  expect(fixture.client.rpc.runtime.shutdown).toHaveBeenCalledOnce();
  expect(fixture.client.rpc.runtime.shutdown.mock.invocationCallOrder[0]).toBeLessThan(fixture.client.stop.mock.invocationCallOrder[0]!);
});

test("Copilot late ACK confirms only the timed-out invocation in its still-owned runtime", async () => {
  const provider = await openCopilotProvider(fixture.options); vi.useFakeTimers();
  let acknowledge!: (id: string) => void; fixture.native.send.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
  const operation = randomUUID(), rejected = expect(provider.send("one dispatch", operation, null)).rejects.toThrow(/unknown/);
  await vi.advanceTimersByTimeAsync(60_001); await rejected; expect(fixture.observed).toEqual([]);
  acknowledge("real-native-message-id"); await vi.advanceTimersByTimeAsync(0);
  expect(fixture.observed).toEqual([operation]); expect(fixture.native.send).toHaveBeenCalledOnce();
  await provider.close();
});

test("Copilot ACK arriving after runtime loss cannot confirm input", async () => {
  const provider = await openCopilotProvider(fixture.options); let acknowledge!: (id: string) => void;
  fixture.native.send.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
  const rejected = expect(provider.send("uncertain", randomUUID(), null)).rejects.toThrow(/unknown/);
  await Promise.resolve();
  fixture.child.exitCode = 1; fixture.child.emit("exit", 1, null); fixture.child.emit("close", 1, null); await rejected;
  acknowledge("late-message"); await new Promise(resolve => setImmediate(resolve)); expect(fixture.observed).toEqual([]);
  await provider.close();
});

test("Copilot startup failure after a process proof callback still terminates its runtime", async () => {
  await expect(openCopilotProvider({ ...fixture.options, onSpawn: () => { throw new Error("proof unavailable"); } })).rejects.toThrow(/proof/);
  expect(fixture.child.kill).toHaveBeenCalledOnce(); expect(fixture.client.createSession).not.toHaveBeenCalled();
});

test("Copilot exact resume reads history without creating a replacement", async () => {
  const id = randomUUID(), provider = await openCopilotProvider({ ...fixture.options, resumeNativeSessionId: id });
  expect(provider.nativeSessionId).toBe(id); expect(fixture.client.resumeSession).toHaveBeenCalledWith(id, expect.objectContaining({ sessionId: id, workingDirectory: process.cwd() }));
  expect(fixture.client.createSession).not.toHaveBeenCalled(); await provider.close();
});

test("Copilot live todo updates preserve known state and expose unmappable rows", async () => {
  fixture.native.rpc.plan.readSqlTodos.mockResolvedValue({ rows: [{ id: "a", title: "ready", status: "pending" }, { title: "unknown state", status: "custom" }] });
  const provider = await openCopilotProvider(fixture.options); await new Promise(resolve => setImmediate(resolve));
  expect(fixture.entries.find(e => e.kind === "todo")).toMatchObject({ items: [{ id: "a", text: "ready", status: "pending" }] });
  expect(fixture.entries.some(e => e.kind === "error" && e.code === "unsupported_native_todo")).toBe(true);
  await provider.close();
});

test("Copilot waits for a complete startup line before accepting a split TCP port", async () => {
  processMock.spawn.mockImplementation(() => {
    queueMicrotask(() => { fixture.child.emit("spawn"); fixture.child.stdout.write("Listening on port 54"); setImmediate(() => fixture.child.stdout.write("321\n")); });
    return fixture.child;
  });
  const provider = await openCopilotProvider(fixture.options);
  expect(sdk.connection.mock.calls[0]?.[0]).toBe("127.0.0.1:54321");
  await provider.close();
});

test.each(["close", "loss"])("Copilot does not dispatch deferred input after same-tick %s", async failure => {
  const provider = await openCopilotProvider(fixture.options);
  const rejected = expect(provider.send("must not reach native", randomUUID(), null)).rejects.toThrow();
  let closing: Promise<void> | undefined;
  if (failure === "close") closing = provider.close();
  else { fixture.child.exitCode = 1; fixture.child.emit("exit", 1, null); fixture.child.emit("close", 1, null); }
  await rejected; await closing; expect(fixture.native.send).not.toHaveBeenCalled(); await provider.close();
});

test("Copilot fatal native loss notifies its owner once after disabling controls", async () => {
  const onFatalError = vi.fn((_error: Error) => { expect(fixture.states.at(-1)).toMatchObject({ activity: "unknown", capabilities: { send: false, steer: false, cancel: false, respond: false } }); });
  const provider = await openCopilotProvider({ ...fixture.options, onFatalError });
  fixture.child.exitCode = 1; fixture.child.emit("exit", 1, null); fixture.child.emit("error", new Error("duplicate exit"));
  expect(onFatalError).toHaveBeenCalledOnce(); expect(onFatalError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  await provider.close(); expect(onFatalError).toHaveBeenCalledOnce();
});

test("Copilot unrecoverable transport failure requests owner shutdown without waiting for child exit", async () => {
  vi.useFakeTimers(); const onFatalError = vi.fn();
  const provider = await openCopilotProvider({ ...fixture.options, onFatalError });
  fixture.client.ping.mockRejectedValue(new Error("socket closed"));
  await vi.advanceTimersByTimeAsync(5000);
  expect(fixture.child.exitCode).toBeNull(); expect(fixture.child.signalCode).toBeNull();
  expect(onFatalError).toHaveBeenCalledOnce(); expect(onFatalError.mock.calls[0]?.[0]).toMatchObject({ message: "Native Copilot connection lost; operation results are unknown." });
  expect(fixture.states.at(-1)?.activity).toBe("unknown"); await provider.close();
});

test.each([false, true])("Copilot Worker permissions are native-confirmed and isolated from Test Sessions (worker=%s)", async unattended => {
  const setApproveAll = vi.fn(async () => ({ success: true }));
  Object.assign(fixture.native.rpc.permissions, { setApproveAll });
  const provider = await openCopilotProvider({ ...fixture.options, unattended });
  try {
    const args = processMock.spawn.mock.calls[0]![1] as string[];
    expect(args.includes("--allow-all")).toBe(unattended);
    expect(args.includes("--no-ask-user")).toBe(unattended);
    expect(args.includes("--no-sandbox")).toBe(unattended);
    if (unattended) {
      expect(fixture.native.rpc.permissions.configure).toHaveBeenCalledWith({ approveAllToolPermissionRequests: true, approveAllReadPermissionRequests: true, paths: { unrestricted: true }, urls: { unrestricted: true } });
      expect(setApproveAll).not.toHaveBeenCalled();
    } else {
      expect(setApproveAll).toHaveBeenCalledWith({ enabled: false });
      expect(fixture.native.rpc.permissions.configure).not.toHaveBeenCalled();
    }
    expect((fixture.config().onPermissionRequest as () => unknown)()).toEqual({ kind: "no-result" });
  } finally { await provider.close(); }
});

test("Copilot fails Worker initialization when native full access cannot be confirmed", async () => {
  fixture.native.rpc.permissions.configure.mockResolvedValue({ success: false });
  await expect(openCopilotProvider({ ...fixture.options, unattended: true })).rejects.toThrow("full access");
  expect(fixture.native.send).not.toHaveBeenCalled();
});

test("Copilot Worker resume does not overwrite persisted permissions", async () => {
  const setApproveAll = vi.fn(async () => ({ success: true }));
  Object.assign(fixture.native.rpc.permissions, { setApproveAll });
  const provider = await openCopilotProvider({ ...fixture.options, unattended: true, resumeNativeSessionId: randomUUID() });
  try {
    expect(setApproveAll).not.toHaveBeenCalled();
    expect(fixture.native.rpc.permissions.configure).not.toHaveBeenCalled();
    expect(processMock.spawn.mock.calls[0]![1]).not.toContain("--allow-all");
  } finally { await provider.close(); }
});

test("Copilot Worker does not submit input when native full access configuration is unavailable", async () => {
  fixture.native.rpc.permissions.configure.mockRejectedValue(new Error("Unhandled method session.permissions.configure"));
  await expect(openCopilotProvider({ ...fixture.options, unattended: true })).rejects.toThrow("Unhandled method");
  expect(fixture.native.send).not.toHaveBeenCalled();
});
