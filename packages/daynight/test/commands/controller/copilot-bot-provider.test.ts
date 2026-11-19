import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { NativeProvider, ProviderOptions, ProviderState } from "../../../src/commands/controller/providers/types.js";
import { textNativeInput } from "../../../src/commands/controller/providers/native-input.js";

const recovery = vi.hoisted(() => ({ prepare: vi.fn(), validateVersion: vi.fn(), markDirty: vi.fn(), protect: vi.fn(), close: vi.fn(), construct: vi.fn(), sourceDirectory: "" }));
const runtime = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("../../../src/commands/controller/providers/copilot-bot-recovery.js", () => ({ CopilotBotRecovery: class {
  constructor(options: unknown) { recovery.construct(options); }
  prepare = recovery.prepare; validateVersion = recovery.validateVersion; markDirty = recovery.markDirty;
  protect = recovery.protect; close = recovery.close;
  get sourceDirectory() { return recovery.sourceDirectory; }
} }));
vi.mock("../../../src/commands/controller/providers/copilot-runtime.js", async original => ({
  ...await original<typeof import("../../../src/commands/controller/providers/copilot-runtime.js")>(), startCopilotRuntime: runtime.start,
}));
import { openCopilotProvider } from "../../../src/commands/controller/providers/copilot.js";

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const providers: NativeProvider[] = [];
const releaseBarriers: (() => void)[] = [];
beforeEach(() => { vi.resetAllMocks(); recovery.sourceDirectory = realpathSync(process.cwd()); });
afterEach(async () => { vi.useRealTimers(); for (const release of releaseBarriers.splice(0)) release(); for (const provider of providers.splice(0)) await provider.close(); });

function fixture() {
  const cwd = realpathSync(process.cwd()), messageId: string = randomUUID(), states: ProviderState[] = [], fatal: Error[] = [];
  let config!: { sessionId: string; onEvent: (event: unknown) => void };
  const native = { sessionId: "", send: vi.fn(async () => messageId), disconnect: vi.fn(async () => {}), rpc: {
    eventLog: { read: vi.fn(async () => ({ events: [], cursor: "end", hasMore: false, cursorStatus: "ok" })) },
    metadata: {
      snapshot: vi.fn(async () => ({ sessionId: native.sessionId, workingDirectory: cwd, workspacePath: cwd, alreadyInUse: false, isRemote: false })),
      isProcessing: vi.fn(async () => ({ processing: false })), activity: vi.fn(async () => ({ hasActiveWork: false, abortable: false })),
    },
    tasks: { list: vi.fn(async () => ({ tasks: [] as unknown[] })) },
    queue: { pendingItems: vi.fn(async () => ({ items: [] as unknown[], steeringMessages: [] as unknown[], inFlightSteeringCount: 0 })) },
    plan: { readSqlTodos: vi.fn(async () => ({ rows: [] })) },
    permissions: { configure: vi.fn(async () => ({ success: true })) },
    model: { getCurrent: vi.fn(async () => ({ modelId: "test-model" })), list: vi.fn(async () => ({ list: [{ id: "test-model", name: "Test" }] })), switchTo: vi.fn(async () => ({ deferred: false })) },
    skills: { ensureLoaded: vi.fn(async () => ({})), list: vi.fn(async () => ({ skills: [{ name: "test-command", enabled: true, userInvocable: true }] })) },
    commands: { invoke: vi.fn(async () => ({ kind: "completed", message: "done", runtimeSettingsChanged: false })) },
  } };
  const capture = async (value: typeof config) => { config = value; native.sessionId = value.sessionId; return native; };
  const client = {
    createSession: vi.fn(capture), resumeSession: vi.fn(async (id: string, value: typeof config) => capture({ ...value, sessionId: id })),
    getSessionMetadata: vi.fn(async (id: string) => ({ sessionId: id, isRemote: false, context: { workingDirectory: cwd } })),
    getStatus: vi.fn(async () => ({ version: "1.0.105", protocolVersion: 3 })), ping: vi.fn(async () => ({})),
    rpc: { sessions: { checkInUse: vi.fn(async () => ({ inUse: [] })), save: vi.fn(async () => ({})) }, skills: { getDiscoveryPaths: vi.fn(async () => ({ paths: [] })) } },
  };
  const close = vi.fn(async () => {});
  runtime.start.mockReturnValue({ ready: Promise.resolve(client), close, nativeExecutableSha256: null });
  const options: ProviderOptions = { cwd, args: [], model: null, resumeNativeSessionId: null, executable: "/controlled/copilot",
    env: { COPILOT_HOME: cwd }, copilotBotRecovery: { directory: cwd, identity: { serverOrigin: "https://fixture.invalid", ownerUserId: randomUUID(), botId: randomUUID(), sessionId: randomUUID() } },
    onTimeline: () => {}, onSpawn: () => {}, onState: value => states.push(value), onFatalError: error => fatal.push(error),
  };
  const open = async (extra: Partial<ProviderOptions> = {}) => { const provider = await openCopilotProvider({ ...options, ...extra }); providers.push(provider); return provider; };
  const emit = (type: string, data: unknown = {}, ephemeral = false) => config.onEvent({ id: randomUUID(), timestamp: new Date().toISOString(), parentId: null, type, data, ...(ephemeral ? { ephemeral: true } : {}) });
  return { open, options, native, client, close, states, fatal, emit, messageId };
}

test("binds the original recovery identity and resumes without creating another native session", async () => {
  const f = fixture(), id = randomUUID(), provider = await f.open({ resumeNativeSessionId: id });
  expect(recovery.construct).toHaveBeenCalledWith(expect.objectContaining({ ...f.options.copilotBotRecovery, cwd: f.options.cwd, nativeHome: f.options.env!.COPILOT_HOME }));
  expect(recovery.prepare).toHaveBeenCalledWith(id, true);
  expect(recovery.prepare.mock.invocationCallOrder[0]).toBeLessThan(runtime.start.mock.invocationCallOrder[0]!);
  expect(recovery.markDirty.mock.invocationCallOrder[0]).toBeLessThan(runtime.start.mock.invocationCallOrder[0]!);
  expect(recovery.validateVersion).toHaveBeenCalledWith({ sdkVersion: "1.0.11", cliVersion: "1.0.105" });
  expect(f.client.resumeSession).toHaveBeenCalledWith(id, expect.objectContaining({ workingDirectory: f.options.cwd }));
  expect(f.client.createSession).not.toHaveBeenCalled(); expect(provider.nativeSessionId).toBe(id);
});

test.each(["prepare", "validateVersion"] as const)("refuses %s failure without opening or sending native input", async phase => {
  const f = fixture(); recovery[phase].mockImplementation(() => { throw new Error("recovery failure"); });
  await expect(f.open()).rejects.toThrow("recovery failure");
  expect(f.client.createSession).not.toHaveBeenCalled(); expect(f.native.send).not.toHaveBeenCalled(); expect(recovery.close).toHaveBeenCalled();
  if (phase === "prepare") expect(runtime.start).not.toHaveBeenCalled(); else expect(f.close).toHaveBeenCalled();
});

test("refuses a native storage binding that differs from its protected source", async () => {
  const f = fixture(); f.native.rpc.metadata.snapshot.mockImplementation(async () => ({ sessionId: f.native.sessionId, workingDirectory: f.options.cwd, workspacePath: "", alreadyInUse: false, isRemote: false }));
  await expect(f.open()).rejects.toThrow("storage differs"); expect(f.native.send).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalled();
});

test("flushes before protection and admits no input, setting, or cancellation until protection commits", async () => {
  const f = fixture(), barrier = deferred<void>(); recovery.protect.mockReturnValue(barrier.promise);
  releaseBarriers.push(() => barrier.resolve());
  const provider = await f.open(), receipt = await provider.send(textNativeInput("one"), randomUUID(), null);
  expect(recovery.markDirty.mock.invocationCallOrder.at(-1)).toBeLessThan(f.native.send.mock.invocationCallOrder[0]!);
  f.emit("session.idle"); await vi.waitFor(() => expect(recovery.protect).toHaveBeenCalledOnce());
  expect(f.client.rpc.sessions.save).toHaveBeenCalledWith({ sessionId: provider.nativeSessionId });
  expect(f.client.rpc.sessions.save.mock.invocationCallOrder[0]).toBeLessThan(recovery.protect.mock.invocationCallOrder[0]!);
  expect(recovery.protect).toHaveBeenCalledWith(provider.nativeSessionId, receipt.turnId, f.messageId, expect.any(Function));
  expect(f.states.at(-1)!.activity).not.toBe("idle");
  await expect(provider.send(textNativeInput("two"), randomUUID(), null)).rejects.toThrow();
  await expect(provider.setSetting!("model", "test-model", randomUUID(), f.states.at(-1)!.controls!.revision)).rejects.toThrow();
  await expect(provider.cancel(receipt.turnId!)).rejects.toThrow();
  expect(f.native.send).toHaveBeenCalledOnce();
  barrier.resolve(); await provider.waitForTurn(receipt.turnId!, Date.now() + 1000);
  expect(f.states.at(-1)!.activity).toBe("idle");
  await provider.send(textNativeInput("two"), randomUUID(), null); expect(f.native.send).toHaveBeenCalledTimes(2);
});

test.each(["flush", "protect"] as const)("%s failure disconnects without acknowledging the turn or replaying input", async phase => {
  const f = fixture();
  if (phase === "flush") f.client.rpc.sessions.save.mockRejectedValue(new Error("flush failed")); else recovery.protect.mockRejectedValue(new Error("protect failed"));
  const provider = await f.open(), receipt = await provider.send(textNativeInput("one"), randomUUID(), null);
  f.emit("session.idle"); await vi.waitFor(() => expect(f.fatal).toHaveLength(1));
  await expect(provider.waitForTurn(receipt.turnId!, Date.now() + 1000)).rejects.toThrow(`${phase} failed`);
  await expect(provider.send(textNativeInput("two"), randomUUID(), receipt.turnId!)).rejects.toThrow();
  expect(f.native.send).toHaveBeenCalledOnce(); expect(f.states.at(-1)!.activity).toBe("unknown");
  if (phase === "flush") expect(recovery.protect).not.toHaveBeenCalled();
});

test.each(["processing", "activity", "tasks", "queue", "steering"])("does not snapshot a native session with outstanding %s", async condition => {
  const f = fixture(), provider = await f.open(); await provider.send(textNativeInput("one"), randomUUID(), null);
  if (condition === "processing") f.native.rpc.metadata.isProcessing.mockResolvedValue({ processing: true });
  if (condition === "activity") f.native.rpc.metadata.activity.mockResolvedValue({ hasActiveWork: true, abortable: true });
  if (condition === "tasks") f.native.rpc.tasks.list.mockResolvedValue({ tasks: [{ id: "running" }] });
  if (condition === "queue") f.native.rpc.queue.pendingItems.mockResolvedValue({ items: [{ id: "queued" }], steeringMessages: [], inFlightSteeringCount: 0 });
  if (condition === "steering") f.native.rpc.queue.pendingItems.mockResolvedValue({ items: [], steeringMessages: [{ id: "steer" }], inFlightSteeringCount: 0 });
  f.emit("session.idle"); await vi.waitFor(() => expect(f.fatal).toHaveLength(1));
  expect(f.client.rpc.sessions.save).not.toHaveBeenCalled(); expect(recovery.protect).not.toHaveBeenCalled();
});

test("rechecks native work after flush before copying recovery material", async () => {
  const f = fixture(), provider = await f.open(); await provider.send(textNativeInput("one"), randomUUID(), null);
  f.client.rpc.sessions.save.mockImplementation(async () => { f.native.rpc.metadata.activity.mockResolvedValue({ hasActiveWork: true, abortable: true }); return {}; });
  f.emit("session.idle"); await vi.waitFor(() => expect(f.fatal).toHaveLength(1));
  expect(f.client.rpc.sessions.save).toHaveBeenCalledOnce(); expect(recovery.protect).not.toHaveBeenCalled();
});

test("assistant idle with pending background work waits for complete session idle before protecting", async () => {
  const f = fixture(), provider = await f.open(), receipt = await provider.send(textNativeInput("one"), randomUUID(), null);
  f.native.rpc.metadata.activity.mockResolvedValue({ hasActiveWork: true, abortable: true });
  f.native.rpc.tasks.list.mockResolvedValue({ tasks: [{ id: "attached-shell" }] });
  let completed = false;
  const completion = provider.waitForTurn(receipt.turnId!, Date.now() + 1000).then(() => { completed = true; });
  void completion.catch(() => {});
  f.emit("assistant.idle"); await Promise.resolve();
  expect(f.client.rpc.sessions.save).not.toHaveBeenCalled(); expect(recovery.protect).not.toHaveBeenCalled();
  expect(f.fatal).toHaveLength(0); expect(completed).toBe(false); expect(f.states.at(-1)!.activity).not.toBe("idle");
  f.native.rpc.metadata.activity.mockResolvedValue({ hasActiveWork: false, abortable: false });
  f.native.rpc.tasks.list.mockResolvedValue({ tasks: [] });
  f.emit("session.idle"); await completion;
  expect(f.client.rpc.sessions.save).toHaveBeenCalledOnce(); expect(recovery.protect).toHaveBeenCalledOnce();
  expect(completed).toBe(true); expect(f.states.at(-1)!.activity).toBe("idle"); expect(f.fatal).toHaveLength(0);
});

test("unknown send outcome rejects subsequent input and ignores a late idle event", async () => {
  const f = fixture(), provider = await f.open(); f.native.send.mockRejectedValue(new Error("connection lost"));
  await expect(provider.send(textNativeInput("one"), randomUUID(), null)).rejects.toThrow("connection lost");
  f.emit("session.idle"); await expect(provider.send(textNativeInput("two"), randomUUID(), null)).rejects.toThrow();
  expect(f.fatal).toHaveLength(1); expect(recovery.protect).not.toHaveBeenCalled(); expect(f.native.send).toHaveBeenCalledOnce();
});

test("a timed-out send cannot become protected when its acceptance arrives late", async () => {
  const f = fixture(), provider = await f.open(), accepted = deferred<string>();
  releaseBarriers.push(() => accepted.resolve(f.messageId)); f.native.send.mockReturnValue(accepted.promise);
  vi.useFakeTimers();
  const sending = provider.send(textNativeInput("one"), randomUUID(), null).catch(error => error as Error);
  await vi.advanceTimersByTimeAsync(60_001);
  expect(await sending).toBeInstanceOf(Error); expect(f.fatal).toHaveLength(1);
  accepted.resolve(f.messageId); await vi.advanceTimersByTimeAsync(0); f.emit("session.idle");
  await expect(provider.send(textNativeInput("two"), randomUUID(), null)).rejects.toThrow();
  expect(recovery.protect).not.toHaveBeenCalled(); expect(f.native.send).toHaveBeenCalledOnce();
});

test.each(["close", "timeout"] as const)("%s interrupts recovery waiting for a pending send receipt and releases the runtime", async outcome => {
  const f = fixture(), provider = await f.open(), accepted = deferred<string>();
  releaseBarriers.push(() => accepted.resolve(f.messageId)); f.native.send.mockReturnValue(accepted.promise);
  vi.useFakeTimers();
  const sending = provider.send(textNativeInput("one"), randomUUID(), null).catch(error => error as Error);
  await vi.advanceTimersByTimeAsync(0); expect(f.native.send).toHaveBeenCalledOnce();
  f.emit("session.idle"); await vi.advanceTimersByTimeAsync(0);
  expect(recovery.protect).not.toHaveBeenCalled(); expect(f.client.rpc.sessions.save).not.toHaveBeenCalled();
  if (outcome === "timeout") {
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await sending).toBeInstanceOf(Error); expect(f.fatal).toHaveLength(1);
  }
  const closing = provider.close(); await vi.advanceTimersByTimeAsync(0);
  // Cleanup must reach the runtime while the original native receipt is still unresolved.
  expect(f.close).toHaveBeenCalledOnce(); expect(recovery.close).toHaveBeenCalledOnce();
  await closing; expect(await sending).toBeInstanceOf(Error);
  await expect(provider.send(textNativeInput("two"), randomUUID(), null)).rejects.toThrow();
  accepted.resolve(f.messageId); await vi.advanceTimersByTimeAsync(0);
  expect(recovery.protect).not.toHaveBeenCalled(); expect(f.client.rpc.sessions.save).not.toHaveBeenCalled(); expect(f.native.send).toHaveBeenCalledOnce();
});

test("native turn errors retain the dirty result and never publish a protected idle state", async () => {
  const f = fixture(), provider = await f.open(), receipt = await provider.send(textNativeInput("one"), randomUUID(), null);
  f.emit("session.error", { message: "native failed" });
  await expect(provider.waitForTurn(receipt.turnId!, Date.now() + 1000)).rejects.toThrow("native failed");
  expect(f.fatal).toHaveLength(1); expect(recovery.protect).not.toHaveBeenCalled(); expect(f.states.at(-1)!.activity).toBe("unknown");
});

test("close joins an in-progress snapshot before closing its storage and runtime", async () => {
  const f = fixture(), barrier = deferred<void>(); recovery.protect.mockReturnValue(barrier.promise);
  releaseBarriers.push(() => barrier.resolve());
  const provider = await f.open(); await provider.send(textNativeInput("one"), randomUUID(), null); f.emit("session.idle");
  await vi.waitFor(() => expect(recovery.protect).toHaveBeenCalledOnce());
  const closing = provider.close(); await Promise.resolve();
  expect(recovery.close).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
  barrier.resolve(); await closing; expect(recovery.close).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
});

test("losing native ownership while copying prevents the recovery commit guard from passing", async () => {
  const f = fixture(), barrier = deferred<void>(), commits = vi.fn(); releaseBarriers.push(() => barrier.resolve());
  recovery.protect.mockImplementation(async (_native, _turn, _message, assertCurrent: () => void) => {
    await barrier.promise; assertCurrent(); commits();
  });
  const provider = await f.open(), receipt = await provider.send(textNativeInput("one"), randomUUID(), null);
  f.emit("session.idle"); await vi.waitFor(() => expect(recovery.protect).toHaveBeenCalledOnce());
  f.emit("session.shutdown"); barrier.resolve();
  await expect(provider.waitForTurn(receipt.turnId!, Date.now() + 1000)).rejects.toThrow("operation results are unknown");
  await provider.close(); expect(commits).not.toHaveBeenCalled();
});

test.each(["assistant.turn_start", "tool.execution_start"])("%s during snapshot creation invalidates its publication", async type => {
  const f = fixture(), barrier = deferred<void>(), commits = vi.fn(); releaseBarriers.push(() => barrier.resolve());
  recovery.protect.mockImplementation(async (_native, _turn, _message, assertCurrent: () => void) => {
    await barrier.promise; assertCurrent(); commits();
  });
  const provider = await f.open(), receipt = await provider.send(textNativeInput("one"), randomUUID(), null);
  f.emit("session.idle"); await vi.waitFor(() => expect(recovery.protect).toHaveBeenCalledOnce());
  recovery.markDirty.mockClear();
  f.emit(type, type === "tool.execution_start" ? { toolCallId: randomUUID(), toolName: "powershell", arguments: {} } : {});
  expect(recovery.markDirty).toHaveBeenCalledOnce(); expect(f.states.at(-1)!.activity).not.toBe("idle");
  barrier.resolve();
  await expect(provider.waitForTurn(receipt.turnId!, Date.now() + 1000)).rejects.toThrow("native work changed");
  expect(commits).not.toHaveBeenCalled(); expect(f.states.at(-1)!.activity).toBe("unknown");
  await expect(provider.send(textNativeInput("two"), randomUUID(), null)).rejects.toThrow();
  expect(f.native.send).toHaveBeenCalledOnce();
});

test("empty ephemeral background-task notifications do not invalidate completed work during protection", async () => {
  const f = fixture(), barrier = deferred<void>(), committed = vi.fn(); releaseBarriers.push(() => barrier.resolve());
  recovery.protect.mockImplementation(async (_native, _turn, _message, assertCurrent: () => void) => {
    await barrier.promise; assertCurrent(); committed();
  });
  const provider = await f.open(), receipt = await provider.send(textNativeInput("one"), randomUUID(), null);
  f.emit("session.idle"); await vi.waitFor(() => expect(recovery.protect).toHaveBeenCalledOnce());
  recovery.markDirty.mockClear();
  f.emit("session.background_tasks_changed", {}, true);
  expect(recovery.markDirty).not.toHaveBeenCalled(); expect(f.fatal).toHaveLength(0);
  barrier.resolve(); await provider.waitForTurn(receipt.turnId!, Date.now() + 1000);
  expect(committed).toHaveBeenCalledOnce(); expect(f.states.at(-1)!.activity).toBe("idle");
  await provider.send(textNativeInput("two"), randomUUID(), null); expect(f.native.send).toHaveBeenCalledTimes(2);
});

test("unrequested tool work after protected idle marks recovery dirty before reporting the failure", async () => {
  const f = fixture(), fatal = vi.fn(() => { expect(recovery.markDirty).toHaveBeenCalledOnce(); });
  const provider = await f.open({ onFatalError: fatal }), receipt = await provider.send(textNativeInput("one"), randomUUID(), null);
  f.emit("session.idle"); await provider.waitForTurn(receipt.turnId!, Date.now() + 1000);
  recovery.markDirty.mockClear(); recovery.protect.mockClear();
  f.emit("tool.execution_start", { toolCallId: randomUUID(), toolName: "powershell", arguments: {} });
  expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("unrequested native work") }));
  expect(recovery.protect).not.toHaveBeenCalled(); expect(f.states.at(-1)!.activity).toBe("unknown");
  await expect(provider.send(textNativeInput("two"), randomUUID(), null)).rejects.toThrow();
});

test("new tool work after recovery commit but before cleanup completes cannot acknowledge the turn", async () => {
  const f = fixture(), cleanup = deferred<void>(), committed = vi.fn(); let dirty = true;
  releaseBarriers.push(() => cleanup.resolve());
  recovery.markDirty.mockImplementation(() => { dirty = true; });
  recovery.protect.mockImplementation(async (_native, _turn, _message, assertCurrent: () => void) => {
    assertCurrent(); dirty = false; committed(); await cleanup.promise;
  });
  const provider = await f.open(), receipt = await provider.send(textNativeInput("one"), randomUUID(), null);
  f.emit("session.idle"); await vi.waitFor(() => expect(committed).toHaveBeenCalledOnce()); expect(dirty).toBe(false);
  recovery.markDirty.mockClear();
  f.emit("tool.execution_start", { toolCallId: randomUUID(), toolName: "powershell", arguments: {} });
  expect(recovery.markDirty).toHaveBeenCalledOnce(); expect(dirty).toBe(true);
  cleanup.resolve();
  await expect(provider.waitForTurn(receipt.turnId!, Date.now() + 1000)).rejects.toThrow();
  expect(f.states.at(-1)!.activity).toBe("unknown"); expect(dirty).toBe(true);
  await expect(provider.send(textNativeInput("two"), randomUUID(), null)).rejects.toThrow(); expect(f.native.send).toHaveBeenCalledOnce();
});

test.each(["setting", "command"] as const)("a stale %s revision is rejected before dispatch without closing the Bot", async kind => {
  const f = fixture(), provider = await f.open(); recovery.markDirty.mockClear();
  expect(f.states.at(-1)!.controls!.revision).not.toBe("0");
  const request = kind === "setting" ? provider.setSetting!("model", "test-model", randomUUID(), "0")
    : provider.executeCommand!("test-command", "", randomUUID(), "0", null);
  await expect(request).rejects.toThrow();
  expect(f.native.rpc.model.switchTo).not.toHaveBeenCalled(); expect(f.native.rpc.commands.invoke).not.toHaveBeenCalled();
  expect(recovery.markDirty).not.toHaveBeenCalled(); expect(f.fatal).toHaveLength(0); expect(f.states.at(-1)!.activity).toBe("idle");
  await provider.send(textNativeInput("continue"), randomUUID(), null); expect(f.native.send).toHaveBeenCalledOnce();
});

test.each(["setting", "command"] as const)("a dispatched %s failure disconnects and preserves the dirty barrier", async kind => {
  const f = fixture(), provider = await f.open(); recovery.markDirty.mockClear();
  f.native.rpc.model.switchTo.mockRejectedValue(new Error("native control failed"));
  f.native.rpc.commands.invoke.mockRejectedValue(new Error("native control failed"));
  const revision = f.states.at(-1)!.controls!.revision;
  const request = kind === "setting" ? provider.setSetting!("model", "test-model", randomUUID(), revision)
    : provider.executeCommand!("test-command", "", randomUUID(), revision, null);
  await expect(request).rejects.toThrow("native control failed");
  const nativeCall = kind === "setting" ? f.native.rpc.model.switchTo : f.native.rpc.commands.invoke;
  expect(nativeCall).toHaveBeenCalledOnce(); expect(recovery.markDirty).toHaveBeenCalledOnce();
  expect(recovery.markDirty.mock.invocationCallOrder[0]).toBeLessThan(nativeCall.mock.invocationCallOrder[0]!);
  expect(f.fatal).toHaveLength(1); expect(recovery.protect).not.toHaveBeenCalled();
  await expect(provider.send(textNativeInput("continue"), randomUUID(), null)).rejects.toThrow(); expect(f.native.send).not.toHaveBeenCalled();
});

test("ordinary Copilot sessions do not use the Bot recovery path", async () => {
  const f = fixture(), options = { ...f.options }; delete options.copilotBotRecovery;
  const provider = await openCopilotProvider(options); providers.push(provider);
  const receipt = await provider.send(textNativeInput("ordinary"), randomUUID(), null); f.emit("session.idle");
  await provider.waitForTurn(receipt.turnId!, Date.now() + 1000);
  expect(recovery.construct).not.toHaveBeenCalled(); expect(f.client.rpc.sessions.save).not.toHaveBeenCalled();
  expect(f.states.at(-1)!.capabilities.steer).toBe(true);
});
