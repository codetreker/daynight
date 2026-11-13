import { test, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { createNativeInputPublication, nativeInputPublicationFailure } from "../../../src/commands/controller/media/native-publication.js";
import { readControllerOutboxByteLength } from "../../../src/commands/controller/outbox-store.js";
const fixture = vi.hoisted(() => ({ open: vi.fn(), capture: vi.fn(), journal: vi.fn(), close: vi.fn(), serverClose: vi.fn(), serverCreate: vi.fn(), relayClose: vi.fn(), relayCreate: vi.fn(), captureCreate: vi.fn(), synchronousRelay: false, ticketOverrides: {} as Record<string, unknown>, options: null as unknown, closed: false, provider: "codex" as "codex" | "claude" | "copilot", socketHandler: null as null | ((socket: unknown) => void), relayCallbacks: null as null | { onConnection(connected: boolean): void; onCommand(command: unknown): Promise<void>; onError(error: unknown): void } }));
const storage = vi.hoisted(() => ({ acquire: vi.fn(), prepare: vi.fn(), release: vi.fn(), open: vi.fn(), order: [] as string[] }));
vi.mock("../../../src/commands/controller/storage-lock.js", async importOriginal => ({ ...await importOriginal<typeof import("../../../src/commands/controller/storage-lock.js")>(), acquireControllerStoragePermit: (file: string) => storage.acquire(file), isControllerStorageLockHeld: (error: unknown) => error instanceof Error && error.message === "fixture-lock-busy" }));
vi.mock("../../../src/commands/controller/storage-preparation.js", () => ({ prepareControllerStorage: (...args: unknown[]) => storage.prepare(...args) }));
vi.mock("node:fs/promises", () => ({ mkdir: async () => {}, realpath: async (value: string) => value, chmod: async () => {}, unlink: async () => {} }));
vi.mock("node:net", () => ({ createServer: (handler: (socket: unknown) => void) => { fixture.serverCreate(); fixture.socketHandler = handler; const server = new EventEmitter() as EventEmitter & { listen: (path: string, callback: () => void) => void; close: () => void }; server.listen = (_path, callback) => queueMicrotask(callback); server.close = fixture.serverClose; return server; } }));
vi.mock("../../../src/commands/controller/launch-ticket.js", () => ({ readLaunchTicket: async () => ({ provider: fixture.provider, cwd: process.cwd(), executionId: "execution", executionGeneration: "2", sessionId: "session", claimId: "claim", launchId: "launch", nativeHome: "/private/native", ipcEndpoint: "/private/ipc", configuration: { model: null, args: [] }, resumeNativeSessionId: null, ...fixture.ticketOverrides }), controllerExecutionDirectory: () => "/private/controller" }));
vi.mock("../../../src/commands/controller/lifecycle-store.js", () => ({ openControllerLifecycleStore: (...args: unknown[]) => { storage.open(...args); return fixture.journal(); } }));
const externalRuntime = vi.hoisted(() => ({ create: vi.fn(), coordinatorCreate: vi.fn(), coordinatorStop: vi.fn(async () => {}), pipelineCreate: vi.fn(), pipelineTick: vi.fn(async () => {}), pipelineStop: vi.fn(async () => {}), close: vi.fn(async () => {}), acquire: vi.fn(async () => ({ marker: "external-generation" })), coordinatorOptions: null as null | { acquireExternalPolicy(): Promise<unknown> } }));
vi.mock("../../../src/commands/controller/markdown/external-policy.js", () => ({ createExternalImagePolicyProducer: (options: unknown) => { externalRuntime.create(options); return { acquire: externalRuntime.acquire, close: externalRuntime.close }; } }));
vi.mock("../../../src/commands/controller/markdown/coordinator.js", () => ({ createMarkdownCaptureCoordinator: (options: { acquireExternalPolicy(): Promise<unknown> }) => { externalRuntime.coordinatorCreate(); externalRuntime.coordinatorOptions = options; return { tick: async () => {}, stop: externalRuntime.coordinatorStop, invalidate: () => {} }; } }));
vi.mock("../../../src/commands/controller/markdown/pipeline.js", () => ({ createMarkdownTimelinePipeline: ({ journal }: { journal: { projectTimeline(entry: unknown): void } }) => { externalRuntime.pipelineCreate(); return { accept: (entry: unknown) => journal.projectTimeline(entry), tick: externalRuntime.pipelineTick, stop: externalRuntime.pipelineStop }; } }));
vi.mock("../../../src/commands/controller/media/capture.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../../src/commands/controller/media/capture.js")>();
  return { ...original, createControllerCaptureBridge: (...args: Parameters<typeof original.createControllerCaptureBridge>) => { fixture.captureCreate(); return original.createControllerCaptureBridge(...args); } };
});
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ captureControllerProcessProof: () => fixture.capture(), captureProcessProof: async () => ({ pid: 1 }) }));
vi.mock("../../../src/commands/controller/relay.js", () => ({ createControllerRelay: (_ticket: unknown, _journal: unknown, callbacks: { onConnection(connected: boolean): void; onCommand(command: unknown): Promise<void>; onError(error: unknown): void }) => { fixture.relayCreate(); fixture.relayCallbacks = callbacks; if (fixture.synchronousRelay) callbacks.onConnection(false); return { stop: vi.fn(), flush: async () => {}, close: fixture.relayClose, connected: () => true, authorize: async () => {}, receipt: vi.fn() }; } }));
vi.mock("../../../src/commands/controller/providers/codex.js", () => ({ openCodexProvider: (options: unknown) => { fixture.options = options; return fixture.open(); } }));
vi.mock("../../../src/commands/controller/providers/copilot.js", () => ({ openCopilotProvider: (options: unknown) => { fixture.options = options; return fixture.open(); } }));
vi.mock("../../../src/commands/controller/providers/claude.js", () => ({ openClaudeProvider: (options: unknown) => { fixture.options = options; return fixture.open(); } }));
vi.mock("../../../src/commands/controller/local-client.js", () => ({ validateControllerLocalRequest: (value: unknown) => value }));
const aliasFixture = vi.hoisted(() => ({ environment: undefined as NodeJS.ProcessEnv | undefined, read: vi.fn(async () => ({})) }));
vi.mock("../../../src/config/agent-cli-aliases.js", () => ({ readAgentCliAliases: aliasFixture.read }));
vi.mock("../../../src/cli/agent-cli-aliases.js", () => ({ prepareAgentCliAliases: async (options: { environment: NodeJS.ProcessEnv }) => ({ environment: aliasFixture.environment ?? options.environment, bindings: aliasFixture.environment ? [{ name: "daynight", target: "daynight-dev", executable: "/private/build/daynight-dev" }] : [], directory: null }) }));
const toolSelectionFixture = vi.hoisted(() => ({ read: null as null | (() => Promise<unknown>) }));
vi.mock("../../../src/commands/controller/launch-tool-selection.js", () => ({ readLaunchToolSelection: async (_home: string, ticket: { configuration: { toolLaunch?: unknown } }) => toolSelectionFixture.read ? toolSelectionFixture.read() : ticket.configuration.toolLaunch }));
import { runController } from "../../../src/commands/controller/runtime.js";
afterEach(() => { toolSelectionFixture.read = null; });
afterEach(() => { externalRuntime.coordinatorOptions = null; externalRuntime.close.mockReset(); externalRuntime.close.mockResolvedValue(); vi.clearAllMocks(); fixture.options = null; fixture.ticketOverrides = {}; fixture.closed = false; fixture.provider = "codex"; aliasFixture.environment = undefined; aliasFixture.read.mockReset(); aliasFixture.read.mockResolvedValue({}); vi.unstubAllEnvs(); });
const setup = () => {
  fixture.synchronousRelay = false;
  fixture.serverCreate.mockReset(); fixture.relayCreate.mockReset(); fixture.captureCreate.mockReset();
  fixture.serverClose.mockReset(); fixture.serverClose.mockImplementation(() => { storage.order.push("server"); });
  fixture.relayClose.mockReset(); fixture.relayClose.mockImplementation(() => { storage.order.push("relay"); });
  externalRuntime.create.mockReset(); externalRuntime.coordinatorCreate.mockReset(); externalRuntime.pipelineCreate.mockReset();
  externalRuntime.coordinatorStop.mockReset(); externalRuntime.coordinatorStop.mockImplementation(async () => { storage.order.push("captures"); });
  externalRuntime.pipelineTick.mockReset(); externalRuntime.pipelineTick.mockResolvedValue();
  externalRuntime.pipelineStop.mockReset(); externalRuntime.pipelineStop.mockImplementation(async () => { storage.order.push("pipeline"); });
  storage.order.length = 0;
  storage.release.mockReset(); storage.release.mockImplementation(() => { storage.order.push("permit"); });
  storage.acquire.mockReset(); storage.acquire.mockImplementation((journalFile: string) => ({ journalFile, owner: "fixture", release: storage.release }));
  storage.prepare.mockReset(); storage.prepare.mockReturnValue({ kind: "prepared", snapshot: null, legacyTimelineCleanupPending: false });
  storage.open.mockReset(); storage.open.mockImplementation(() => { storage.order.push("journal-open"); });
  const snapshot = { lifecycle: "starting", nativeSessionId: null, initialInputState: "not_submitted", activity: "initializing", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false } };
  const patch = vi.fn((fields?: Record<string, unknown>) => { if (fields) Object.assign(snapshot, fields); if (fixture.closed) throw new Error("Journal was closed while native startup still owned it"); });
  fixture.journal.mockReturnValue({ reconcileNativeIndexReservation: async () => {}, listOperations: () => [], disableOutboxWrites: vi.fn(), patchSnapshot: patch, getSnapshot: () => snapshot, appendEvent: vi.fn(), close: () => { fixture.closed = true; storage.order.push("journal"); } });
  fixture.capture.mockResolvedValue({ pid: 1 });
  fixture.close.mockImplementation(async () => { expect(fixture.closed).toBe(false); });
  return patch;
};

test.each(["SIGTERM", "SIGINT"] as const)("%s during native initialization closes the eventual provider before releasing its journal", async signal => {
  setup(); let ready!: (value: unknown) => void;
  fixture.open.mockImplementation(() => new Promise(resolve => { ready = resolve; }));
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledOnce());
  process.emit(signal, signal);
  await Promise.resolve(); expect(fixture.closed).toBe(false); expect(fixture.close).not.toHaveBeenCalled();
  ready({ nativeSessionId: "native", close: fixture.close });
  await running; expect(fixture.close).toHaveBeenCalledOnce(); expect(fixture.closed).toBe(true);
});

test("stop during process-proof initialization never starts a native writer afterwards", async () => {
  setup(); let captured!: (value: unknown) => void;
  fixture.capture.mockImplementation(() => new Promise(resolve => { captured = resolve; }));
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  await vi.waitFor(() => expect(fixture.capture).toHaveBeenCalledOnce());
  process.emit("SIGTERM", "SIGTERM"); captured({ pid: 1 });
  await running; expect(fixture.open).not.toHaveBeenCalled(); expect(storage.open).not.toHaveBeenCalled(); expect(storage.release).toHaveBeenCalledOnce();
});

test("stop while reading the frozen tool selection prevents a later provider start", async () => {
  setup(); let selected!: (value: unknown) => void;
  const read = vi.fn(() => new Promise(resolve => { selected = resolve; })); toolSelectionFixture.read = read;
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  process.emit("SIGTERM", "SIGTERM"); selected(undefined);
  await running; expect(fixture.open).not.toHaveBeenCalled(); expect(fixture.closed).toBe(true);
});


test("dispatches Copilot with its frozen profile and closes that provider", async () => {
  setup(); fixture.provider = "copilot";
  vi.stubEnv("COPILOT_HOME", "/changed/after/launch");
  vi.stubEnv("DN_CONFIG_DIR", "/private/worker-state");
  const toolLaunch = Object.freeze({ schemaVersion: 1, tool: "copilot", context: "web", source: "explicit", entryPath: "/frozen/copilot", canonicalEntryPath: "/frozen/copilot", executablePath: "/frozen/node", interpreterPath: "/frozen/node", command: { file: "/frozen/node", prefixArgs: ["/frozen/copilot"] }, artifacts: [], selectionKey: "frozen-selection" });
  fixture.ticketOverrides = { configuration: { model: null, args: [], toolLaunch } };
  fixture.open.mockResolvedValue({ nativeSessionId: "native", close: fixture.close });
  const running = runController({ homeDirectory: "/private", provider: "copilot", launchId: "launch" });
  let failure: unknown; void running.catch(error => { failure = error; });
  try {
    await vi.waitFor(() => { if (failure) throw failure; expect(fixture.open).toHaveBeenCalledOnce(); });
    expect((fixture.options as { env: NodeJS.ProcessEnv }).env.COPILOT_HOME).toBe("/private/native");
    expect((fixture.options as { toolLaunch: unknown }).toolLaunch).toBe(toolLaunch);
    expect((fixture.options as { toolRuntimeRoot: string }).toolRuntimeRoot).toBe(path.resolve("/private/worker-state", "worker", "tool-runtimes"));
    expect(process.env.COPILOT_HOME).toBe("/changed/after/launch");
  } finally { if (!failure) process.emit("SIGTERM", "SIGTERM"); await running.catch(() => {}); }
  expect(fixture.close).toHaveBeenCalledOnce();
});


test("initial input waits for both the provider handle and relay without turning startup into a failure", async () => {
  const patch = setup(); let opened!: (value: unknown) => void;
  fixture.open.mockImplementation(() => new Promise(resolve => { opened = resolve; }));
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledOnce());
  const nativeOptions = fixture.options as { onState(state: unknown): void };
  nativeOptions.onState({ nativeSessionId: null, activity: "initializing", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false } });
  const socket = Object.assign(new EventEmitter(), { setTimeout: () => {}, setEncoding: () => {}, destroy: () => {}, end: vi.fn() });
  try {
    expect(patch).toHaveBeenLastCalledWith(expect.objectContaining({ lifecycle: "starting" }));
    fixture.socketHandler!(socket);
    socket.emit("data", JSON.stringify({ requestId: "request", action: { kind: "submit_initial" } }) + "\n");
    await vi.waitFor(() => expect(socket.end).toHaveBeenCalled());
    expect(JSON.parse(socket.end.mock.calls[0]![0])).toMatchObject({ ok: true, snapshot: { lifecycle: "starting", initialInputState: "not_submitted" } });
    nativeOptions.onState({ nativeSessionId: "native", activity: "idle", currentTurnId: null, capabilities: { send: true, steer: true, cancel: true, respond: true } });
    opened({ nativeSessionId: "native", close: fixture.close }); await new Promise(resolve => setImmediate(resolve));
    expect(fixture.journal().getSnapshot().lifecycle).toBe("starting");
    fixture.relayCallbacks!.onConnection(true);
    expect(fixture.journal().getSnapshot().lifecycle).toBe("ready");
  } finally { opened({ nativeSessionId: "native", close: fixture.close }); process.emit("SIGTERM", "SIGTERM"); await running; }
});

test.each(["codex", "claude", "copilot"] as const)("%s fatal native loss releases provider, relay and IPC while retaining the unknown input journal", async provider => {
  const patch = setup(); fixture.provider = provider;
  fixture.journal().patchSnapshot({ nativeSessionId: "same-native-session", initialInputState: "unknown" });
  fixture.open.mockResolvedValue({ nativeSessionId: "same-native-session", close: fixture.close });
  const errorLog = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const running = runController({ homeDirectory: "/private", provider, launchId: "launch" });
  try {
    await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledOnce()); await new Promise(resolve => setImmediate(resolve));
    const nativeOptions = fixture.options as { onFatalError?: (error: Error) => void };
    nativeOptions.onFatalError?.(new Error("owned native runtime disappeared"));
    await vi.waitFor(() => expect(fixture.serverClose).toHaveBeenCalledOnce(), { timeout: 100 });
    await running;
    expect(fixture.close).toHaveBeenCalledOnce(); expect(fixture.relayClose).toHaveBeenCalledOnce(); expect(fixture.closed).toBe(true);
    expect(fixture.journal().getSnapshot()).toMatchObject({ nativeSessionId: "same-native-session", initialInputState: "unknown", error: "owned native runtime disappeared" });
    expect(patch).toHaveBeenCalledWith({ lifecycle: "paused", error: "owned native runtime disappeared" });
    expect(errorLog.mock.calls.some(([line]) => String(line).includes("owned native runtime disappeared"))).toBe(true);
  } finally { process.emit("SIGTERM", "SIGTERM"); await running.catch(() => {}); errorLog.mockRestore(); }
});

test("Copilot fatal error during initialization waits for the eventual provider handle without a shutdown deadlock", async () => {
  setup(); fixture.provider = "copilot"; let opened!: (value: unknown) => void;
  fixture.open.mockImplementation(() => new Promise(resolve => { opened = resolve; }));
  const errorLog = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const running = runController({ homeDirectory: "/private", provider: "copilot", launchId: "launch" });
  const settled = running.then(() => undefined, error => error);
  try {
    await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledOnce());
    (fixture.options as { onFatalError?: (error: Error) => void }).onFatalError?.(new Error("native startup connection lost"));
    await Promise.resolve(); expect(fixture.close).not.toHaveBeenCalled(); expect(fixture.closed).toBe(false);
    opened({ nativeSessionId: "same-native-session", close: fixture.close });
    await vi.waitFor(() => expect(fixture.serverClose).toHaveBeenCalledOnce(), { timeout: 100 });
    expect(await settled).toMatchObject({ message: "native startup connection lost" });
    expect(fixture.close).toHaveBeenCalledOnce(); expect(fixture.closed).toBe(true);
  } finally { opened({ nativeSessionId: "same-native-session", close: fixture.close }); process.emit("SIGTERM", "SIGTERM"); await settled; errorLog.mockRestore(); }
});

test("no-input Test hides native send capability until the real provider handle is acquired", async () => {
  setup(); fixture.journal().patchSnapshot({ initialInputState: "not_required" });
  let opened!: (value: unknown) => void;
  fixture.open.mockImplementation(() => new Promise(resolve => { opened = resolve; }));
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  try {
    await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledOnce());
    fixture.relayCallbacks!.onConnection(true);
    const controls = { revision: "5", settings: [{id:"model",mutable:true}], commands:[],settingsError:null,commandsError:null };
    (fixture.options as { onState(state: unknown): void }).onState({ controls, nativeSessionId: null, activity: "idle", currentTurnId: null, capabilities: { send: true, steer: false, cancel: true, respond: true } });
    expect(fixture.journal().appendEvent).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ initialInputState: "not_required", capabilities: { send: false, steer: false, cancel: false, respond: false } }) }));
    expect(fixture.journal().appendEvent.mock.lastCall[0].payload).not.toHaveProperty("controls");
    expect(fixture.journal().appendEvent.mock.lastCall[0].payload.activity).toBe("initializing");
    opened({ nativeSessionId: "native", close: fixture.close }); await new Promise(resolve => setImmediate(resolve));
    expect(fixture.journal().appendEvent).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ controls, activity:"idle", capabilities: expect.objectContaining({ send: true }) }) }));
  } finally { opened({ nativeSessionId: "native", close: fixture.close }); process.emit("SIGTERM", "SIGTERM"); await running; }
});

test("draining responds only to interactions created by the actual cleanup input", async () => {
  setup(); const journal = fixture.journal();
  journal.patchSnapshot({ initialInputState: "confirmed", activity: "idle" });
  Object.assign(journal, { projectTimeline: vi.fn(), assertInputCapacity: vi.fn(), prepareOperation: (input: any) => ({ ...input, state: "accepted" }), markDispatching: vi.fn(), getOperation: () => null, recordOperation: (operationId: string, state: string) => ({ operationId, state }) });
  const interaction = (id: string) => ({ entryId: id, revision: "1", kind: "interaction", interaction: { interactionId: id, revision: "1", state: "pending", kind: "approval", title: "Approval", detail: "", actions: ["allow_once"] } });
  const respond = vi.fn(async () => ({ disposition: "handled" }));
  fixture.open.mockResolvedValue({ nativeSessionId: "native", close: fixture.close, respond, send: async () => {
    const native = fixture.options as { onTimeline(entry: unknown): void };
    native.onTimeline(interaction("old")); native.onTimeline(interaction("cleanup"));
    return { disposition: "started", turnId: "cleanup-turn" };
  }, waitForTurn: async () => {} });
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  try {
    await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledOnce()); await new Promise(resolve => setImmediate(resolve));
    fixture.relayCallbacks!.onConnection(true);
    (fixture.options as { onTimeline(entry: unknown): void }).onTimeline(interaction("old"));
    const socket = Object.assign(new EventEmitter(), { setTimeout: () => {}, setEncoding: () => {}, destroy: () => {}, end: vi.fn() });
    fixture.socketHandler!(socket);
    socket.emit("data", JSON.stringify({ requestId: "cleanup-request", action: { kind: "cleanup", operationId: "cleanup-operation", prompt: "clean up", deadline: Date.now() + 1000 } }) + "\n");
    await vi.waitFor(() => expect(socket.end).toHaveBeenCalled());
    expect(journal.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ cleanupInteractionIds: ["cleanup"] }) }));
    const command = (interactionId: string) => ({ sessionId: "session", claimId: "claim", executionGeneration: "2", operationId: `respond-${interactionId}`, kind: "interaction_response", payload: { interactionId, interactionRevision: "1", submissionId: "submission", response: { kind: "approval", action: "allow_once" } } });
    await fixture.relayCallbacks!.onCommand(command("old")); expect(respond).not.toHaveBeenCalled();
    await fixture.relayCallbacks!.onCommand(command("cleanup")); expect(respond).toHaveBeenCalledOnce();
  } finally { process.emit("SIGTERM", "SIGTERM"); await running; }
});

test("an accounting failure while cleanup awaits cancellation prevents its later native input", async () => {
  setup(); const journal = fixture.journal();
  journal.patchSnapshot({ initialInputState: "confirmed", activity: "working", currentTurnId: "turn" });
  const { SqliteAccessError } = await import("../../../src/platform/sqlite-error.js");
  const failure = new SqliteAccessError("invalid-format", { database: "controller-journal", phase: "outbox-read" }, { outcome: "rolled-back", cause: new Error("original accounting failure") });
  const cancelled = Promise.withResolvers<void>(), cancel = vi.fn(() => cancelled.promise), send = vi.fn(), record = vi.fn();
  Object.assign(journal, { assertInputCapacity: vi.fn(), prepareOperation: vi.fn(() => ({ operationId: "cleanup-operation", kind: "cleanup", state: "accepted" })), markDispatching: vi.fn(), getOperation: vi.fn(() => ({ state: "dispatching" })), recordOperation: record, markProjectionGap: vi.fn() });
  fixture.close.mockImplementation(async () => { await cancelled.promise; });
  fixture.open.mockResolvedValue({ nativeSessionId: "native", close: fixture.close, cancel, send });
  const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  const result = running.then(() => null, error => error);
  try {
    await vi.waitFor(() => expect(journal.getSnapshot().startup).toMatchObject({ state: "ready" }));
    const socket = Object.assign(new EventEmitter(), { setTimeout: () => {}, setEncoding: () => {}, destroy: () => {}, end: vi.fn() });
    fixture.socketHandler!(socket);
    socket.emit("data", JSON.stringify({ requestId: "cleanup-request", action: { kind: "cleanup", operationId: "cleanup-operation", prompt: "clean up", deadline: Date.now() + 5000 } }) + "\n");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    journal.appendEvent.mockImplementationOnce(() => { throw failure; });
    const native = fixture.options as { onState(state: unknown): void; assertNativeDispatch(): void };
    expect(() => native.assertNativeDispatch()).not.toThrow();
    native.onState({ nativeSessionId: "native", activity: "idle", currentTurnId: null, capabilities: { send: true, steer: true, cancel: true, respond: true } });
    expect(journal.disableOutboxWrites).toHaveBeenCalledOnce();
    expect(() => native.assertNativeDispatch()).toThrow(failure);
    cancelled.resolve();
    expect(await result).toBe(failure);
    expect(send).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  } finally { cancelled.resolve(); process.emit("SIGTERM", "SIGTERM"); await result; log.mockRestore(); }
});

test("shutdown while cleanup awaits cancellation prevents its later native input", async () => {
  setup(); const journal = fixture.journal();
  journal.patchSnapshot({ initialInputState: "confirmed", activity: "working", currentTurnId: "turn" });
  const cancelled = Promise.withResolvers<void>(), cancel = vi.fn(() => cancelled.promise), send = vi.fn();
  const record = vi.fn((_id: string, state: string) => ({ state }));
  Object.assign(journal, { assertInputCapacity: vi.fn(), prepareOperation: vi.fn(() => ({ operationId: "cleanup-operation", kind: "cleanup", state: "accepted" })), markDispatching: vi.fn(), getOperation: vi.fn(() => ({ state: "dispatching" })), recordOperation: record });
  fixture.close.mockImplementation(async () => { await cancelled.promise; });
  fixture.open.mockResolvedValue({ nativeSessionId: "native", close: fixture.close, cancel, send });
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  try {
    await vi.waitFor(() => expect(journal.getSnapshot().startup).toMatchObject({ state: "ready" }));
    const socket = Object.assign(new EventEmitter(), { setTimeout: () => {}, setEncoding: () => {}, destroy: () => {}, end: vi.fn() });
    fixture.socketHandler!(socket);
    socket.emit("data", JSON.stringify({ requestId: "cleanup-request", action: { kind: "cleanup", operationId: "cleanup-operation", prompt: "clean up", deadline: Date.now() + 5000 } }) + "\n");
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    process.emit("SIGTERM", "SIGTERM");
    expect(() => (fixture.options as { assertNativeDispatch(): void }).assertNativeDispatch()).toThrow("Controller stopped before native dispatch.");
    cancelled.resolve();
    await vi.waitFor(() => expect(socket.end).toHaveBeenCalled());
    await running;
    expect(send).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith("cleanup-operation", "unknown", null, "Controller stopped before native dispatch.");
  } finally { cancelled.resolve(); process.emit("SIGTERM", "SIGTERM"); await running.catch(() => {}); }
});


test.each(["codex", "claude", "copilot"] as const)("passes prepared aliases to %s without changing the parent environment", async provider => {
  setup(); fixture.provider = provider;
  const original = process.env.PATH;
  aliasFixture.environment = { ...process.env, PATH: "/private/aliases:/usr/bin", DN_CONFIG_DIR: "/private/dev" };
  fixture.open.mockResolvedValue({ nativeSessionId: "native", close: fixture.close });
  const running = runController({ homeDirectory: "/private", provider, launchId: "launch" });
  try {
    await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledOnce());
    expect((fixture.options as { env: NodeJS.ProcessEnv }).env).toMatchObject({ PATH: "/private/aliases:/usr/bin", DN_CONFIG_DIR: "/private/dev" });
    expect((fixture.options as { agentCliEnvironment: NodeJS.ProcessEnv }).agentCliEnvironment).toEqual({ PATH: "/private/aliases:/usr/bin", DN_CONFIG_DIR: "/private/dev" });
    expect(process.env.PATH).toBe(original);
  } finally { process.emit("SIGTERM", "SIGTERM"); await running; }
});


test("stop during alias preparation never starts a native writer afterwards", async () => {
  setup(); let resolved!: (value: object) => void;
  aliasFixture.read.mockImplementationOnce(() => new Promise(resolve => { resolved = resolve; }));
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  await vi.waitFor(() => expect(aliasFixture.read).toHaveBeenCalledOnce());
  process.emit("SIGTERM", "SIGTERM"); resolved({});
  await running;
  expect(fixture.open).not.toHaveBeenCalled(); expect(fixture.closed).toBe(true);
});


test.each(["codex", "claude", "copilot"] as const)("passes frozen role options to %s on fresh and resumed starts without sending a user turn", async provider => {
  for (const resumeNativeSessionId of [null, "original-native"]) {
    fixture.closed = false; setup(); fixture.provider = provider;
    fixture.ticketOverrides = { claimId: undefined, testExecutionId: "test", initialInput: "none", initialPrompt: "", instructions: "角色\nKeep native defaults. 😀", resumeNativeSessionId };
    fixture.journal().patchSnapshot({ initialInputState: "not_required" });
    const send = vi.fn();
    fixture.open.mockClear(); fixture.open.mockResolvedValue({ nativeSessionId: "original-native", close: fixture.close, send });
    const running = runController({ homeDirectory: "/private", provider, launchId: "launch" });
    try {
      await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledOnce());
      await new Promise(resolve => setImmediate(resolve));
      fixture.relayCallbacks!.onConnection(true);
      expect(fixture.options).toMatchObject({ instructions: fixture.ticketOverrides.instructions, resumeNativeSessionId, cwd: process.cwd(), model: null, args: [], unattended: false });
      expect(send).not.toHaveBeenCalled();
    } finally { process.emit("SIGTERM", "SIGTERM"); await running; }
  }
});

test.each(["task", "test"])("omits role options for a legacy %s startup", async scope => {
  setup();
  if (scope === "test") fixture.ticketOverrides = { claimId: undefined, testExecutionId: "test", initialInput: "none", initialPrompt: "" };
  fixture.open.mockResolvedValue({ nativeSessionId: "native", close: fixture.close });
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  try {
    await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledOnce());
    expect(fixture.options).not.toHaveProperty("instructions");
    expect(fixture.options).toMatchObject({ unattended: scope === "task", model: null, args: [], resumeNativeSessionId: null });
  } finally { process.emit("SIGTERM", "SIGTERM"); await running; }
});


test("startup rejection is retained separately from shutdown lifecycle", async () => {
  setup();
  const { NativeRpcError } = await import("../../../src/commands/controller/providers/native-rpc.js");
  const error = new NativeRpcError(-32602, "Rejected /private/secret input");
  fixture.open.mockRejectedValue(error);
  const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await expect(runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" })).rejects.toBe(error);
    expect(fixture.journal().getSnapshot()).toMatchObject({ startup: { state: "failed", reasonCode: "native_rejected" }, error: error.message });
  } finally { log.mockRestore(); }
});

test("startup is not ready until the provider opening promise has completed", async () => {
  setup(); let opened!: (value: unknown) => void;
  fixture.open.mockImplementation(() => new Promise(resolve => { opened = resolve; }));
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  try {
    await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledOnce());
    const native = fixture.options as { onState(state: unknown): void };
    native.onState({ nativeSessionId: "native", activity: "idle", currentTurnId: null, capabilities: { send: true, steer: true, cancel: true, respond: true } });
    expect(fixture.journal().getSnapshot().startup).toEqual({ state: "starting", reasonCode: "initializing" });
    opened({ nativeSessionId: "native", close: fixture.close });
    await vi.waitFor(() => expect(fixture.journal().getSnapshot().startup).toEqual({ state: "ready", reasonCode: "ready" }));
  } finally { opened({ nativeSessionId: "native", close: fixture.close }); process.emit("SIGTERM", "SIGTERM"); await running; }
});


test("a subsequent shutdown error cannot replace the original initialization timeout", async () => {
  setup(); const { NativeRpcTimeoutError } = await import("../../../src/commands/controller/providers/native-rpc.js");
  const timeout = new NativeRpcTimeoutError("initialize");
  fixture.open.mockImplementation(async () => {
    const native = fixture.options as { onFatalError(error: Error): void };
    native.onFatalError(timeout);
    throw new Error("Cleanup transport lost /private/profile");
  });
  const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await expect(runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" })).rejects.toThrow("Cleanup transport lost");
    expect(fixture.journal().getSnapshot().startup).toEqual({ state: "unknown", reasonCode: "native_timeout" });
  } finally { log.mockRestore(); }
});


test("runtime supplies a lazily acquired external policy from the trusted configuration path and closes its producer", async () => {
  const stateDirectory = path.resolve("/private/deployment-config");
  setup(); vi.stubEnv("DN_CONFIG_DIR", stateDirectory);
  fixture.open.mockResolvedValue({ nativeSessionId: "native", close: fixture.close });
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  try {
    await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledOnce());
    expect(externalRuntime.create).toHaveBeenCalledWith({ paths: { stateDirectory, configFile: path.join(stateDirectory, "config.yml") } });
    expect(externalRuntime.acquire).not.toHaveBeenCalled();
    await expect(externalRuntime.coordinatorOptions!.acquireExternalPolicy()).resolves.toEqual({ marker: "external-generation" });
    expect(externalRuntime.acquire).toHaveBeenCalledOnce();
  } finally { process.emit("SIGTERM", "SIGTERM"); await running; }
  expect(externalRuntime.close).toHaveBeenCalledOnce();
});

test("an external producer close failure cannot skip provider and journal cleanup", async () => {
  setup(); fixture.open.mockResolvedValue({ nativeSessionId: "native", close: fixture.close });
  externalRuntime.close.mockRejectedValueOnce(new Error("External policy close failed"));
  const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  try { await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledOnce()); process.emit("SIGTERM", "SIGTERM"); await expect(running).rejects.toThrow("External policy close failed"); }
  finally { log.mockRestore(); }
  expect(fixture.close).toHaveBeenCalledOnce(); expect(fixture.relayClose).toHaveBeenCalledOnce(); expect(fixture.closed).toBe(true);
});


test("commits the captured Controller proof through the journal constructor before connecting a relay or starting a provider", async () => {
  setup(); fixture.synchronousRelay = true;
  const proof = { pid: 321, startedAt: "original-controller" };
  fixture.capture.mockResolvedValue(proof);
  fixture.relayCreate.mockImplementation(() => {
    expect(storage.open).toHaveBeenCalledWith(path.join("/private/controller", "journal.sqlite"), expect.objectContaining({ launchId: "launch" }), expect.objectContaining({ controllerProcess: proof, storagePermit: expect.objectContaining({ owner: "fixture" }) }));
  });
  fixture.open.mockResolvedValue({ nativeSessionId: "native", close: fixture.close });
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  try { await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledOnce()); }
  finally { process.emit("SIGTERM", "SIGTERM"); await running; }
  expect(storage.prepare).toHaveBeenCalledWith(expect.objectContaining({ mode: "writer", journalFile: path.join("/private/controller", "journal.sqlite"), ticket: expect.objectContaining({ launchId: "launch" }) }), expect.objectContaining({ owner: "fixture" }));
  expect(storage.order.at(-1)).toBe("permit");
  expect(storage.order.indexOf("journal")).toBeGreaterThan(storage.order.indexOf("relay"));
});

test.each(["proof", "journal", "capture", "external", "coordinator", "pipeline", "relay", "server", "provider"] as const)("%s construction failure closes every earlier owner before releasing storage", async stage => {
  setup();
  const error = new Error(`${stage} constructor failed`);
  const constructor = { proof: fixture.capture, journal: storage.open, capture: fixture.captureCreate, external: externalRuntime.create, coordinator: externalRuntime.coordinatorCreate, pipeline: externalRuntime.pipelineCreate, relay: fixture.relayCreate, server: fixture.serverCreate, provider: fixture.open }[stage];
  constructor.mockImplementationOnce(() => { throw error; });
  const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try { await expect(runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" })).rejects.toBe(error); }
  finally { log.mockRestore(); }
  expect(storage.release).toHaveBeenCalledOnce();
  expect(storage.order.at(-1)).toBe("permit");
  expect(fixture.closed).toBe(!["proof", "journal"].includes(stage));
  expect(externalRuntime.close).toHaveBeenCalledTimes(["coordinator", "pipeline", "relay", "server", "provider"].includes(stage) ? 1 : 0);
  expect(externalRuntime.coordinatorStop).toHaveBeenCalledTimes(["pipeline", "relay", "server", "provider"].includes(stage) ? 1 : 0);
  expect(externalRuntime.pipelineStop).toHaveBeenCalledTimes(["relay", "server", "provider"].includes(stage) ? 1 : 0);
  expect(fixture.relayClose).toHaveBeenCalledTimes(["server", "provider"].includes(stage) ? 1 : 0);
  expect(fixture.serverClose).toHaveBeenCalledTimes(stage === "provider" ? 1 : 0);
});

test("constructor and cleanup failures preserve both causes and still release the closed journal", async () => {
  setup();
  const primary = new Error("pipeline constructor failed"), cleanup = new Error("external policy close failed");
  externalRuntime.pipelineCreate.mockImplementationOnce(() => { throw primary; });
  externalRuntime.close.mockRejectedValueOnce(cleanup);
  const failure = await runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" }).then(() => null, error => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors).toEqual([primary, cleanup]);
  expect(failure.cause).toBe(primary);
  expect(fixture.closed).toBe(true);
  expect(storage.order.at(-1)).toBe("permit");
});

test("journal shutdown uncertainty retains the storage permit while later cleanup still runs", async () => {
  setup(); const close = new Error("journal close failed");
  fixture.journal().close = () => { throw close; };
  fixture.serverCreate.mockImplementationOnce(() => { throw new Error("server constructor failed"); });
  const failure = await runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" }).then(() => null, error => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors).toContain(close);
  expect(storage.release).not.toHaveBeenCalled();
  expect(fixture.relayClose).toHaveBeenCalledOnce();
});

test("a launch that waits beyond its first observation window keeps the same ticket and acquires storage once it becomes available", async () => {
  setup(); vi.useFakeTimers();
  let busy = true;
  storage.acquire.mockImplementation((journalFile: string) => {
    if (busy) throw new Error("fixture-lock-busy");
    return { journalFile, owner: "fixture", release: storage.release };
  });
  fixture.open.mockResolvedValue({ nativeSessionId: "native", close: fixture.close });
  const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  const settled = running.then(() => null, error => error);
  try {
    await vi.advanceTimersByTimeAsync(31_000);
    expect(storage.prepare).not.toHaveBeenCalled();
    expect(storage.open).not.toHaveBeenCalled();
    expect(fixture.capture).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
    busy = false; await vi.advanceTimersByTimeAsync(100);
    expect(storage.open).toHaveBeenCalledOnce();
    expect(fixture.capture).toHaveBeenCalledOnce();
    expect(fixture.open).toHaveBeenCalledOnce();
    expect(storage.open.mock.calls[0]![1]).toMatchObject({ launchId: "launch", executionGeneration: "2" });
  } finally {
    process.emit("SIGTERM", "SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    expect(await settled).toBeNull();
    vi.useRealTimers(); log.mockRestore();
  }
  expect(storage.release).toHaveBeenCalledOnce();
});


test("explicit physical-capacity waiting releases each short permit and retries the original writer preparation", async () => {
  setup(); vi.useFakeTimers();
  storage.prepare.mockReturnValueOnce({ kind: "waiting", reason: "physical_capacity", cause: new Error("reserved storage is busy") });
  fixture.open.mockResolvedValue({ nativeSessionId: "native", close: fixture.close });
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  const settled = running.then(() => null, error => error);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.release).toHaveBeenCalledOnce();
    expect(fixture.capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(storage.acquire).toHaveBeenCalledTimes(2);
    expect(storage.prepare).toHaveBeenCalledTimes(2);
    expect(storage.prepare.mock.calls[0]![0]).toEqual(storage.prepare.mock.calls[1]![0]);
    expect(storage.open).toHaveBeenCalledOnce();
  } finally { process.emit("SIGTERM", "SIGTERM"); await vi.advanceTimersByTimeAsync(0); expect(await settled).toBeNull(); vi.useRealTimers(); }
  expect(storage.release).toHaveBeenCalledTimes(2);
});

test("an unclassified storage acquisition failure exposes the original error without retrying", async () => {
  setup(); const error = new Error("lock owner liveness is unknown");
  storage.acquire.mockImplementationOnce(() => { throw error; });
  await expect(runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" })).rejects.toBe(error);
  expect(storage.acquire).toHaveBeenCalledOnce();
  expect(storage.prepare).not.toHaveBeenCalled();
  expect(storage.release).not.toHaveBeenCalled();
  expect(fixture.capture).not.toHaveBeenCalled();
});

test("storage preparation with an unclosed SQLite connection retains ownership evidence", async () => {
  setup();
  const { SqliteAccessError } = await import("../../../src/platform/sqlite-error.js");
  const error = new SqliteAccessError("cleanup-failed", { database: "controller-journal", phase: "close" }, { outcome: "unknown", connectionClosed: false });
  storage.prepare.mockImplementationOnce(() => { throw error; });
  await expect(runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" })).rejects.toBe(error);
  expect(storage.acquire).toHaveBeenCalledOnce();
  expect(storage.release).not.toHaveBeenCalled();
  expect(fixture.capture).not.toHaveBeenCalled();
});

test("a stop interrupts storage lock waiting without creating a journal generation", async () => {
  setup(); vi.useFakeTimers();
  storage.acquire.mockImplementation(() => { throw new Error("fixture-lock-busy"); });
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.acquire).toHaveBeenCalledOnce();
    process.emit("SIGTERM", "SIGTERM"); await running;
    expect(storage.open).not.toHaveBeenCalled();
    expect(fixture.capture).not.toHaveBeenCalled();
    expect(storage.release).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});


test.each(["preparation", "journal"] as const)("nested %s connection-close uncertainty retains the runtime storage permit", async stage => {
  setup();
  const { SqliteAccessError } = await import("../../../src/platform/sqlite-error.js");
  const unclosed = new SqliteAccessError("cleanup-failed", { database: "controller-journal", phase: "close" }, { outcome: "unknown", connectionClosed: false });
  const failure = new AggregateError([new Error("original initialization failed"), new Error("connection shutdown failed", { cause: unclosed })], "Constructor and cleanup failed");
  (stage === "preparation" ? storage.prepare : storage.open).mockImplementationOnce(() => { throw failure; });
  await expect(runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" })).rejects.toBe(failure);
  expect(storage.acquire).toHaveBeenCalledOnce();
  expect(storage.release).not.toHaveBeenCalled();
  expect(fixture.open).not.toHaveBeenCalled();
});

test("a committed journal initialization and subsequent permit release failure preserve the committed primary outcome", async () => {
  setup();
  const { SqliteAccessError } = await import("../../../src/platform/sqlite-error.js");
  const finalization = new Error("pending content finalization failed");
  const primary = new SqliteAccessError("cleanup-failed", { database: "controller-journal", phase: "initialize" }, { outcome: "committed", connectionClosed: true, cause: finalization });
  const release = new Error("storage lock release failed");
  storage.open.mockImplementationOnce(() => { throw primary; });
  storage.release.mockImplementationOnce(() => { throw release; });
  const failure = await runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" }).then(() => null, error => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors).toEqual([primary, release]);
  expect(failure.cause).toBe(primary);
  expect(failure.cause).toMatchObject({ outcome: "committed", connectionClosed: true, context: { phase: "initialize" } });
  expect(failure.cause.cause).toBe(finalization);
  expect(storage.release).toHaveBeenCalledOnce();
  expect(fixture.open).not.toHaveBeenCalled();
});

test("logs a structured outbox admission failure without changing the original failure", async () => {
  setup();
  const { SqliteAccessError } = await import("../../../src/platform/sqlite-error.js");
  const cause = new Error("private event payload");
  const failure = new SqliteAccessError("invalid-format", { database: "controller-journal", phase: "outbox-read" }, { cause, outcome: "unknown", connectionClosed: true });
  storage.open.mockImplementationOnce(() => { throw failure; });
  const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await expect(runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" })).rejects.toBe(failure);
    const line = String(log.mock.calls[0]![0]);
    const record = JSON.parse(line.slice(line.indexOf("{")));
    expect(record).toMatchObject({ kind: "controller-sqlite-error", component: "outbox", phase: "outbox-read", executionId: "execution", sessionId: "session", claimId: "claim", generation: "2", error: { outcome: "unknown" } });
    expect(line).not.toContain("private event payload");
    expect(failure.cause).toBe(cause);
  } finally { log.mockRestore(); }
});


test("an outbox failure reported by the relay stops the controller with the original error", async () => {
  const patch = setup();
  const { SqliteAccessError } = await import("../../../src/platform/sqlite-error.js");
  const failure = new SqliteAccessError("invalid-format", { database: "controller-journal", phase: "outbox-ack" }, { outcome: "rolled-back" });
  fixture.open.mockResolvedValue({ nativeSessionId: "native", close: fixture.close });
  const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  const result = running.then(() => null, error => error);
  try {
    await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledOnce());
    fixture.relayCallbacks!.onError(failure);
    expect(await result).toBe(failure);
    expect(patch).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "paused" }));
    expect(fixture.journal().disableOutboxWrites).toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(log.mock.calls.some(([line]) => String(line).includes('"phase":"outbox-ack"'))).toBe(true);
  } finally { process.emit("SIGTERM", "SIGTERM"); await result; log.mockRestore(); }
});


test("an outbox relay failure during provider startup preserves the original error", async () => {
  setup(); let opened!: (value: unknown) => void;
  fixture.open.mockImplementation(() => new Promise(resolve => { opened = resolve; }));
  const { SqliteAccessError } = await import("../../../src/platform/sqlite-error.js");
  const failure = new SqliteAccessError("invalid-format", { database: "controller-journal", phase: "outbox-ack" }, { outcome: "rolled-back" });
  const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  const result = running.then(() => null, error => error);
  try {
    await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledOnce());
    fixture.relayCallbacks!.onError(failure);
    opened({ nativeSessionId: "native", close: fixture.close });
    expect(await result).toBe(failure);
    expect(fixture.close).toHaveBeenCalledOnce();
  } finally { opened({ nativeSessionId: "native", close: fixture.close }); process.emit("SIGTERM", "SIGTERM"); await result; log.mockRestore(); }
});

test.each(["native during startup", "native while running", "connection", "startup publication", "background failure"] as const)("%s fences outbox writes and retains the original accounting error", async source => {
  setup(); let opened!: (value: unknown) => void;
  const delayed = source === "native during startup";
  fixture.open.mockImplementation(() => delayed ? new Promise(resolve => { opened = resolve; }) : Promise.resolve({ nativeSessionId: "native", close: fixture.close }));
  const { SqliteAccessError } = await import("../../../src/platform/sqlite-error.js");
  const cause = new Error("original accounting cause");
  const failure = new SqliteAccessError("invalid-format", { database: "controller-journal", phase: "outbox-read" }, { outcome: "rolled-back", cause });
  const journal = fixture.journal(), append = journal.appendEvent as import("vitest").Mock<(payload: unknown) => void>;
  let disabled = false, admitted = 0;
  journal.disableOutboxWrites.mockImplementation(() => { disabled = true; });
  append.mockImplementation(() => { if (disabled) throw new Error("outbox writes disabled"); admitted++; });
  externalRuntime.pipelineStop.mockImplementation(async () => {
    expect(() => append({ kind: "late projection" })).toThrow("outbox writes disabled");
  });
  if (source === "startup publication") append.mockImplementationOnce(() => { throw failure; });
  if (source === "background failure") externalRuntime.pipelineTick.mockRejectedValueOnce(failure);
  const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  const result = running.then(() => null, error => error);
  try {
    await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledOnce());
    if (source === "native during startup" || source === "native while running") {
      if (!delayed) await vi.waitFor(() => expect(journal.getSnapshot().startup).toMatchObject({ state: "ready" }));
      append.mockImplementationOnce(() => { throw failure; });
      const state = { nativeSessionId: null, activity: "idle", currentTurnId: null, capabilities: { send: true, steer: true, cancel: true, respond: true } };
      const native = fixture.options as { onState(state: unknown): void };
      const before = admitted;
      native.onState(state);
      expect(disabled).toBe(true);
      native.onState(state);
      expect(admitted).toBe(before);
    } else if (source === "connection") {
      await vi.waitFor(() => expect(journal.getSnapshot().startup).toMatchObject({ state: "ready" }));
      append.mockImplementationOnce(() => { throw failure; });
      fixture.relayCallbacks!.onConnection(true);
      expect(disabled).toBe(true);
    }
    if (delayed) opened({ nativeSessionId: "native", close: fixture.close });
    expect(await result).toBe(failure);
    expect(failure.cause).toBe(cause);
    expect(journal.disableOutboxWrites).toHaveBeenCalled();
    expect(externalRuntime.pipelineStop).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledOnce();
  } finally { if (delayed) opened({ nativeSessionId: "native", close: fixture.close }); process.emit("SIGTERM", "SIGTERM"); await result; log.mockRestore(); }
});

test.each(["IPC admission", "relay capacity", "native image patch"] as const)("%s preserves accounting failure without native dispatch or a false rejection", async source => {
  setup(); fixture.ticketOverrides = { initialOperationId: "initial-operation", initialPrompt: "original" };
  const { SqliteAccessError } = await import("../../../src/platform/sqlite-error.js");
  const failure = new SqliteAccessError("invalid-format", { database: "controller-journal", phase: "outbox-read" }, { outcome: "rolled-back", cause: new Error("original cause") });
  const journal = fixture.journal(), send = vi.fn(), record = vi.fn(), mark = vi.fn();
  const operation = { operationId: "operation", kind: "send_message", state: "accepted" };
  Object.assign(journal, {
    prepareOperation: vi.fn(() => operation), getOperation: vi.fn(() => operation), recordOperation: record, markDispatching: mark,
    assertInputCapacity: vi.fn(), patchNativeImagePart: vi.fn(),
  });
  fixture.open.mockResolvedValue({ nativeSessionId: "native", close: fixture.close, send });
  const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  const result = running.then(() => null, error => error);
  try {
    await vi.waitFor(() => expect(journal.getSnapshot().startup).toMatchObject({ state: "ready" }));
    fixture.relayCallbacks!.onConnection(true);
    if (source === "IPC admission") {
      journal.prepareOperation.mockImplementation(() => { throw failure; });
      const socket = Object.assign(new EventEmitter(), { setTimeout: () => {}, setEncoding: () => {}, destroy: () => {}, end: vi.fn() });
      fixture.socketHandler!(socket);
      socket.emit("data", JSON.stringify({ requestId: "request", action: { kind: "submit_initial" } }) + "\n");
      await vi.waitFor(() => expect(socket.end).toHaveBeenCalled());
      expect(JSON.parse(socket.end.mock.calls[0]![0])).toMatchObject({ ok: false });
    } else if (source === "relay capacity") {
      journal.assertInputCapacity.mockImplementation(() => { throw failure; });
      const command = { sessionId: "session", claimId: "claim", executionGeneration: "2", operationId: "operation", kind: "send_message", payload: { content: [{ type: "text", text: "hello" }], target: null } };
      await expect(fixture.relayCallbacks!.onCommand(command)).rejects.toBe(failure);
    } else {
      journal.patchNativeImagePart.mockImplementation(() => { throw failure; });
      const native = fixture.options as { imageRuntime: { patchNativeImagePart(occurrence: unknown, part: unknown): unknown } };
      expect(() => native.imageRuntime.patchNativeImagePart({}, {})).toThrow(failure);
    }
    expect(await result).toBe(failure);
    expect(journal.disableOutboxWrites).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled(); expect(mark).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
  } finally { process.emit("SIGTERM", "SIGTERM"); await result; log.mockRestore(); }
});

test.each(["rolled-back", "unknown"] as const)("native publication carries its real SQLite %s outcome to the runtime fence", async outcome => {
  setup(); fixture.open.mockResolvedValue({ nativeSessionId: "native", close: fixture.close });
  const db = new Database(":memory:");
  db.exec("CREATE TABLE outbox(sequence INTEGER PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE outbox_totals(id INTEGER PRIMARY KEY, byte_length INTEGER NOT NULL); PRAGMA user_version=11");
  const quarantine = vi.fn(), originalExec = db.exec.bind(db);
  if (outcome === "unknown") vi.spyOn(db, "exec").mockImplementation(sql => { if (sql === "ROLLBACK") throw new Error("controlled rollback failure"); return originalExec(sql); });
  const publication = createNativeInputPublication({
    db, ticket: { provider: "codex" }, content: {}, assertUsable() {}, quarantine,
    getOperation: () => { readControllerOutboxByteLength(db); return null; },
  } as never);
  const request = { identity: { provider: "codex", nativeSessionId: "native", nativeMessageId: "message", operationId: randomUUID(), intentSha256: "a".repeat(64), entryId: randomUUID() } };
  let original: ReturnType<typeof publication.publishNativeInputAssociation> | undefined;
  const journal = fixture.journal();
  journal.publishNativeInputAssociation = () => original = publication.publishNativeInputAssociation(request as never);
  const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" });
  const result = running.then(() => null, error => error);
  try {
    await vi.waitFor(() => expect(journal.getSnapshot().startup).toMatchObject({ state: "ready" }));
    const native = fixture.options as { imageRuntime: { publishNativeInputAssociation(request: unknown): unknown } };
    const receipt = native.imageRuntime.publishNativeInputAssociation(request);
    expect(receipt).toBe(original);
    expect(receipt).toMatchObject({ state: outcome === "unknown" ? "unknown" : "not_committed", error: { code: outcome === "unknown" ? "publication_unknown" : "publication_unavailable" } });
    const failure = nativeInputPublicationFailure(original!);
    expect(failure).toBeDefined();
    expect(await result).toBe(failure);
    expect(journal.disableOutboxWrites).toHaveBeenCalled();
    expect(quarantine).toHaveBeenCalledTimes(outcome === "unknown" ? 1 : 0);
    if (outcome === "rolled-back") expect(failure).toMatchObject({ outcome: "rolled-back", cause: { outcome: "unknown" } });
    else expect(failure).toBeInstanceOf(AggregateError);
  } finally { process.emit("SIGTERM", "SIGTERM"); await result; vi.restoreAllMocks(); if (db.open) db.close(); log.mockRestore(); }
});
