import { test, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import path from "node:path";
const fixture = vi.hoisted(() => ({ open: vi.fn(), capture: vi.fn(), journal: vi.fn(), close: vi.fn(), serverClose: vi.fn(), relayClose: vi.fn(), ticketOverrides: {} as Record<string, unknown>, options: null as unknown, closed: false, provider: "codex" as "codex" | "claude" | "copilot", socketHandler: null as null | ((socket: unknown) => void), relayCallbacks: null as null | { onConnection(connected: boolean): void; onCommand(command: unknown): Promise<void> } }));
vi.mock("node:fs/promises", () => ({ mkdir: async () => {}, realpath: async (value: string) => value, chmod: async () => {}, unlink: async () => {} }));
vi.mock("node:net", () => ({ createServer: (handler: (socket: unknown) => void) => { fixture.socketHandler = handler; const server = new EventEmitter() as EventEmitter & { listen: (path: string, callback: () => void) => void; close: () => void }; server.listen = (_path, callback) => queueMicrotask(callback); server.close = fixture.serverClose; return server; } }));
vi.mock("../../../src/commands/controller/launch-ticket.js", () => ({ readLaunchTicket: async () => ({ provider: fixture.provider, cwd: process.cwd(), executionId: "execution", executionGeneration: "2", sessionId: "session", claimId: "claim", launchId: "launch", nativeHome: "/private/native", ipcEndpoint: "/private/ipc", configuration: { model: null, args: [] }, resumeNativeSessionId: null, ...fixture.ticketOverrides }), controllerExecutionDirectory: () => "/private/controller" }));
vi.mock("../../../src/commands/controller/lifecycle-store.js", () => ({ openControllerLifecycleStore: () => fixture.journal() }));
const externalRuntime = vi.hoisted(() => ({ create: vi.fn(), close: vi.fn(async () => {}), acquire: vi.fn(async () => ({ marker: "external-generation" })), coordinatorOptions: null as null | { acquireExternalPolicy(): Promise<unknown> } }));
vi.mock("../../../src/commands/controller/markdown/external-policy.js", () => ({ createExternalImagePolicyProducer: (options: unknown) => { externalRuntime.create(options); return { acquire: externalRuntime.acquire, close: externalRuntime.close }; } }));
vi.mock("../../../src/commands/controller/markdown/coordinator.js", () => ({ createMarkdownCaptureCoordinator: (options: { acquireExternalPolicy(): Promise<unknown> }) => { externalRuntime.coordinatorOptions = options; return { tick: async () => {}, stop: async () => {}, invalidate: () => {} }; } }));
vi.mock("../../../src/commands/controller/markdown/pipeline.js", () => ({ createMarkdownTimelinePipeline: ({ journal }: { journal: { projectTimeline(entry: unknown): void } }) => ({ accept: (entry: unknown) => journal.projectTimeline(entry), tick: async () => {}, stop: async () => {} }) }));
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ captureControllerProcessProof: () => fixture.capture(), captureProcessProof: async () => ({ pid: 1 }) }));
vi.mock("../../../src/commands/controller/relay.js", () => ({ createControllerRelay: (_ticket: unknown, _journal: unknown, callbacks: { onConnection(connected: boolean): void; onCommand(command: unknown): Promise<void> }) => { fixture.relayCallbacks = callbacks; return { flush: async () => {}, close: fixture.relayClose, connected: () => true, authorize: async () => {}, receipt: vi.fn() }; } }));
vi.mock("../../../src/commands/controller/providers/codex.js", () => ({ openCodexProvider: (options: unknown) => { fixture.options = options; return fixture.open(); } }));
vi.mock("../../../src/commands/controller/providers/copilot.js", () => ({ openCopilotProvider: (options: unknown) => { fixture.options = options; return fixture.open(); } }));
vi.mock("../../../src/commands/controller/providers/claude.js", () => ({ openClaudeProvider: (options: unknown) => { fixture.options = options; return fixture.open(); } }));
vi.mock("../../../src/commands/controller/local-client.js", () => ({ validateControllerLocalRequest: (value: unknown) => value }));
const aliasFixture = vi.hoisted(() => ({ environment: undefined as NodeJS.ProcessEnv | undefined, read: vi.fn(async () => ({})) }));
vi.mock("../../../src/config/agent-cli-aliases.js", () => ({ readAgentCliAliases: aliasFixture.read }));
vi.mock("../../../src/cli/agent-cli-aliases.js", () => ({ prepareAgentCliAliases: async (options: { environment: NodeJS.ProcessEnv }) => ({ environment: aliasFixture.environment ?? options.environment, bindings: aliasFixture.environment ? [{ name: "daynight", target: "daynight-dev", executable: "/private/build/daynight-dev" }] : [], directory: null }) }));
import { runController } from "../../../src/commands/controller/runtime.js";
afterEach(() => { externalRuntime.coordinatorOptions = null; externalRuntime.close.mockReset(); externalRuntime.close.mockResolvedValue(); vi.clearAllMocks(); fixture.options = null; fixture.ticketOverrides = {}; fixture.closed = false; fixture.provider = "codex"; aliasFixture.environment = undefined; aliasFixture.read.mockReset(); aliasFixture.read.mockResolvedValue({}); vi.unstubAllEnvs(); });
const setup = () => {
  const snapshot = { lifecycle: "starting", nativeSessionId: null, initialInputState: "not_submitted", activity: "initializing", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false } };
  const patch = vi.fn((fields?: Record<string, unknown>) => { if (fields) Object.assign(snapshot, fields); if (fixture.closed) throw new Error("Journal was closed while native startup still owned it"); });
  fixture.journal.mockReturnValue({ listOperations: () => [], patchSnapshot: patch, getSnapshot: () => snapshot, appendEvent: vi.fn(), close: () => { fixture.closed = true; } });
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
  await running; expect(fixture.open).not.toHaveBeenCalled(); expect(fixture.closed).toBe(true);
});


test("dispatches Copilot with its frozen profile and closes that provider", async () => {
  setup(); fixture.provider = "copilot";
  vi.stubEnv("COPILOT_HOME", "/changed/after/launch");
  fixture.open.mockResolvedValue({ nativeSessionId: "native", close: fixture.close });
  const running = runController({ homeDirectory: "/private", provider: "copilot", launchId: "launch" });
  let failure: unknown; void running.catch(error => { failure = error; });
  try {
    await vi.waitFor(() => { if (failure) throw failure; expect(fixture.open).toHaveBeenCalledOnce(); });
    expect((fixture.options as { env: NodeJS.ProcessEnv }).env.COPILOT_HOME).toBe("/private/native");
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
  try { await vi.waitFor(() => expect(fixture.open).toHaveBeenCalledOnce()); process.emit("SIGTERM", "SIGTERM"); await running; }
  finally { log.mockRestore(); }
  expect(fixture.close).toHaveBeenCalledOnce(); expect(fixture.relayClose).toHaveBeenCalledOnce(); expect(fixture.closed).toBe(true);
});
