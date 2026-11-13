import { nativeEntryId } from "../../../src/commands/controller/providers/projection.js";
import { textNativeInput } from "../../../src/commands/controller/providers/native-input.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import type { ChildProcess } from "node:child_process";
import { startupFailure } from "../../../src/commands/controller/startup.js";
import { NativeRpcTimeoutError } from "../../../src/commands/controller/providers/native-rpc.js";
import type { NativeReadPolicy, ProviderEntry, ProviderOptions, ProviderState } from "../../../src/commands/controller/providers/types.js";
import type { LocalImageCheckpoint } from "../../../src/commands/controller/markdown/local-source-proof.js";
import { bindCopilotRead, checkCopilotRead, type CopilotAuthorityNative } from "../../../src/commands/controller/providers/copilot-read-authority-check.js";
const sdk = vi.hoisted(() => ({ provenGeometry: false, authority: null as any, construct: vi.fn(), imageSend: vi.fn(), connection: vi.fn((url, options) => ({ kind: "uri", url, ...options })) }));
vi.mock("../../../src/commands/controller/providers/copilot-image-profile.js", async original => {
  const actual = await original<typeof import("../../../src/commands/controller/providers/copilot-image-profile.js")>();
  return { ...actual, copilotImageProfile(sdkVersion: string, cliVersion: string) {
    const profile = actual.copilotImageProfile(sdkVersion, cliVersion);
    return profile && sdk.provenGeometry ? { geometry: { version: 1, known: true, maxWidth: 1024, maxHeight: 1024, maxPixels: 1_048_576, maxFrames: 1 } } : profile;
  } };
});
vi.mock("../../../src/commands/controller/providers/copilot-read-authority-artifacts.js", () => ({ prepareCopilotAuthorityArtifacts: async () => sdk.authority ? { entry: "/controlled/copilot/index.js", cleanup: async () => {} } : undefined }));
vi.mock("../../../src/commands/controller/providers/copilot-read-authority.js", async original => {
  const actual = await original<typeof import("../../../src/commands/controller/providers/copilot-read-authority.js")>();
  return { ...actual, CopilotReadAuthority: vi.fn(function (...args: ConstructorParameters<typeof actual.CopilotReadAuthority>) { return sdk.authority ?? new actual.CopilotReadAuthority(...args); }) };
});
const processMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("../../../src/commands/controller/providers/copilot-bridge.js", async original => ({ ...await original<typeof import("../../../src/commands/controller/providers/copilot-bridge.js")>(), startCopilotBridge(options: { port: number; token: string }) {
  const client = sdk.construct({ connection: sdk.connection(`127.0.0.1:${options.port}`, { connectionToken: options.token }) });
  return { ready: client.start().then(() => client), close: async () => {}, metrics: () => ({ peakRss: 0, peakHeap: 0 }) };
}, sendCopilotBridgeImages: (native: unknown, input: unknown) => sdk.imageSend(native, input) }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: processMock.spawn }));
import { openCopilotProvider } from "../../../src/commands/controller/providers/copilot.js";
import { CopilotReadCorrelation, copilotReadMarker } from "../../../src/commands/controller/providers/copilot-read-authority-correlation.js";
import { CopilotImages } from "../../../src/commands/controller/providers/copilot-images.js";

const event = (type: string, data: unknown = {}, agentId?: string) => ({ id: randomUUID(), timestamp: new Date().toISOString(), parentId: null, type, data, ...(agentId ? { agentId } : {}) });
let fixture: ReturnType<typeof setup>;
function setup() {
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null, signalCode: null as string | null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
  const kill = () => { child.signalCode = "SIGTERM"; child.emit("exit", null, "SIGTERM"); child.emit("close", null, "SIGTERM"); return true; };
  child.kill.mockImplementation(kill);
  processMock.spawn.mockImplementation(() => { queueMicrotask(() => { child.emit("spawn"); child.stdout.write("Listening on port 54321\n"); }); return child; });
  let captured: { sessionId: string; onEvent: (e: unknown) => void; [key: string]: unknown };
  const native = { sessionId: "", send: vi.fn(async () => "native-message-id"), getEvents: vi.fn(async () => [] as unknown[]), disconnect: vi.fn(async () => {}), rpc: {
    eventLog: { read: vi.fn(async ({ cursor }: { cursor?: string; max: number; includeEphemeral: boolean }) => { const events = await native.getEvents(), index = Number(cursor ?? 0); return { events: events.slice(index, index + 1), cursor: String(index + 1), hasMore: index + 1 < events.length, cursorStatus: "ok" }; }) },
    metadata: { snapshot: vi.fn(async () => ({ sessionId: native.sessionId, workingDirectory: process.cwd(), alreadyInUse: false, isRemote: false })), isProcessing: vi.fn(async () => ({ processing: false })) },
    plan: { readSqlTodos: vi.fn(async () => ({ rows: [] as { id?: string; title?: string; description?: string; status?: string }[] })) }, interruptMainTurn: vi.fn(async () => ({ interrupted: true })), permissions: { configure: vi.fn(async () => ({ success: true })), handlePendingPermissionRequest: vi.fn(async () => ({ success: true })) },
  } };
  const capture = async (config: typeof captured) => { captured = config; native.sessionId = config.sessionId; return native; };
  const client = { start: vi.fn(async () => {}), stop: vi.fn(async () => []), forceStop: vi.fn(async () => {}), ping: vi.fn(async () => ({})), createSession: vi.fn(capture), resumeSession: vi.fn(async (id, config) => capture({ ...config, sessionId: id })), getSessionMetadata: vi.fn(async (id: string) => ({ sessionId: id, isRemote: false, context: { workingDirectory: process.cwd() } })), rpc: { skills: { getDiscoveryPaths: vi.fn(async () => ({ paths: [{ path: "/native/project/skills" }] })) }, runtime: { shutdown: vi.fn(async () => { if (child.exitCode === null && child.signalCode === null) { child.exitCode = 0; child.emit("exit", 0, null); child.emit("close", 0, null); } return {}; }) }, sessions: { checkInUse: vi.fn(async () => ({ inUse: [] as string[] })) } } };
  sdk.construct.mockReturnValue(client);
  const entries: ProviderEntry[] = [], states: ProviderState[] = [], observed: string[] = [], spawned: unknown[] = [];
  const options: ProviderOptions = { cwd: process.cwd(), model: null, args: [], resumeNativeSessionId: null, executable: "/controlled/copilot", env: { ...process.env, COPILOT_HOME: "/private/copilot-profile" }, onTimeline: e => entries.push(structuredClone(e)), onState: s => states.push(structuredClone(s)), onInputObserved: id => observed.push(typeof id === "string" ? id : id.operationId), onSpawn: p => { expect(p.pid).toBe(12345); spawned.push(p); } };
  return { child, client, native, entries, states, options, observed, spawned, emit: (e: unknown) => captured.onEvent(e), config: () => captured };
}
beforeEach(() => { vi.clearAllMocks(); sdk.provenGeometry = false; sdk.authority = null; sdk.imageSend.mockResolvedValue("native-image-message"); fixture = setup(); });
afterEach(() => vi.useRealTimers());

async function sourceAuthorityFixture() {
  const { CopilotReadAuthority, copilotAuthorityProtocol } = await vi.importActual<typeof import("../../../src/commands/controller/providers/copilot-read-authority.js")>("../../../src/commands/controller/providers/copilot-read-authority.js");
  const policies: (NativeReadPolicy | null)[] = [], readPaths: string[] = [], cwd = process.cwd(), child = fixture.child;
  let readBarrier: { entered(): void; waiting: Promise<void> } | undefined;
  const state = { modelId: "first", reasoningEffort: "low", readAllowed: true };
  const model = {
    getCurrent: vi.fn(async () => ({ modelId: state.modelId, reasoningEffort: state.reasoningEffort })),
    list: vi.fn(async () => ({ list: ["first", "second"].map(id => ({ id, supportedReasoningEfforts: ["low", "high"] })) })),
    switchTo: vi.fn(async ({ modelId }: { modelId: string }) => { state.modelId = modelId; return { deferred: false }; }),
    setReasoningEffort: vi.fn(async ({ reasoningEffort }: { reasoningEffort: string }) => { state.reasoningEffort = reasoningEffort; return {}; }),
  };
  const skills = { ensureLoaded: vi.fn(async () => {}), list: vi.fn(async () => ({ skills: [] })) };
  Object.assign(fixture.native.rpc, { model, skills });
  const setApproveAll = vi.fn(async () => ({ success: true })); Object.assign(fixture.native.rpc.permissions, { setApproveAll });
  const nativeRead: CopilotAuthorityNative = {
    sessionAuthMetadataJson: () => JSON.stringify({ type: "user", host: "https://github.com", login: "fixture" }),
    hookSessionSnapshot: async sessionId => JSON.stringify({ sessionId, cwd, hooks: [], hookCount: 0, warnings: [], repositoryLoaded: true, repositoryDiagnostics: [] }),
    hookProcessorCallbackRegistrations: () => [],
    sessionInvokeJson: async (sessionId, method, params) => {
      if (method === "session.metadata.snapshot") return JSON.stringify({ ok: true, result: { sessionId, workingDirectory: cwd, isRemote: false } });
      if (method === "session.permissions.getMode") return JSON.stringify({ ok: true, result: { mode: "manual" } });
      if (method !== "session.contentExclusion.checkPaths") throw new Error(`Unexpected Read method: ${method}`);
      if (readBarrier) { readBarrier.entered(); await readBarrier.waiting; }
      const { paths } = JSON.parse(params!); return JSON.stringify({ ok: true, result: { available: true, checks: paths.map((path: string) => ({ path, excluded: false })) } });
    },
    sessionRoutePermissionJson: async (_sessionId, params) => {
      const request = JSON.parse(params).permissionRequest;
      if (request.kind !== "read") throw new Error("Unexpected permission kind");
      readPaths.push(request.path); return JSON.stringify({ route: "result", result: { kind: state.readAllowed ? "approved" : "denied-by-rules" } });
    },
  };
  Object.assign(child, { connected: true, send(request: import("../../../src/commands/controller/providers/copilot-read-authority.js").CopilotReadRequest, callback: (error: Error | null) => void) {
    callback(null);
    void (async () => {
      let allowed = false;
      try {
        if (request.checkpoint) await checkCopilotRead(nativeRead, request.sessionId, request.cwd, request.checkpoint);
        else await bindCopilotRead(nativeRead, request.sessionId, request.cwd);
        allowed = true;
      } catch { /* The controlled transport returns the native checkpoint decision. */ }
      child.emit("message", { protocol: copilotAuthorityProtocol, execution: request.execution, sequence: request.sequence, digest: request.digest, allowed, key: request.sequence === 0 && allowed ? "1".repeat(64) : null });
    })();
    return true;
  } });
  const publish = (policy: NativeReadPolicy | null) => policies.push(policy);
  sdk.authority = new CopilotReadAuthority({ child: child as unknown as ChildProcess, cwd, publish });
  const checkpoint: LocalImageCheckpoint = { stage: "initial", proof: { requested: { locator: "image.png", path: "image.png" }, root: { cwd, identity: { kind: "posix", dev: "1", ino: "1" }, traversal: [] }, traversal: [], opened: null } };
  const drain = vi.fn(async () => {}), { executable: _executable, ...options } = fixture.options;
  const provider = await openCopilotProvider({ ...options, onNativeReadPolicy: publish, drainNativeReadPolicy: drain });
  const policy = policies.at(-1)!;
  if (!policy) { await provider.close(); throw new Error("The provider did not publish its Read policy."); }
  const blockCheckpoint = () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
    readBarrier = { entered, waiting }; return { started, release };
  };
  skills.ensureLoaded.mockClear(); skills.list.mockClear(); setApproveAll.mockClear();
  return { provider, policy, checkpoint, policies, readPaths, state, model, skills, setApproveAll, drain, blockCheckpoint, revision: () => fixture.states.at(-1)!.controls!.revision };
}

// The qualified Copilot Read ABI consumes POSIX checkpoints.
const sourceAuthorityTest = test.skipIf(process.platform === "win32");
sourceAuthorityTest.each([["model", "second"], ["effort", "high"]])("Copilot %s settings preserve fresh local-source checkpoint decisions", async (id, value) => {
  const f = await sourceAuthorityFixture();
  try {
    await expect(f.policy.authorizeCheckpoint(f.checkpoint)).resolves.toBeUndefined();
    await expect(f.provider.setSetting!(id, value, randomUUID(), f.revision())).resolves.toEqual({ disposition: "handled" });
    expect(fixture.states.at(-1)!.controls!.settings.find(setting => setting.id === id)?.value).toBe(value);
    await expect(f.policy.authorizeCheckpoint(f.checkpoint)).resolves.toBeUndefined();
    expect(f.policies.at(-1)).toBe(f.policy);
    f.state.readAllowed = false;
    await expect(f.policy.authorizeCheckpoint(f.checkpoint)).rejects.toMatchObject({ code: "source_forbidden" });
    expect(f.readPaths).toEqual(Array(3).fill(path.join(process.cwd(), "image.png")));
  } finally { await f.provider.close(); }
});

sourceAuthorityTest.each([["model", "second"], ["effort", "high"]])("Copilot %s setting readback never reloads native skills", async (id, value) => {
  const f = await sourceAuthorityFixture();
  try {
    await f.provider.setSetting!(id, value, randomUUID(), f.revision());
    expect(f.skills.ensureLoaded).not.toHaveBeenCalled(); expect(f.skills.list).not.toHaveBeenCalled();
  } finally { await f.provider.close(); }
});

sourceAuthorityTest("Copilot deferred model switches require readback before setting confirmation", async () => {
  const f = await sourceAuthorityFixture();
  try {
    await f.policy.authorizeCheckpoint(f.checkpoint);
    f.model.switchTo.mockResolvedValue({ deferred: true }); vi.useFakeTimers();
    let confirmed = false;
    const setting = f.provider.setSetting!("model", "second", randomUUID(), f.revision()).then(result => { confirmed = true; return result; });
    await vi.advanceTimersByTimeAsync(0); expect(confirmed).toBe(false);
    f.state.modelId = "second"; await vi.advanceTimersByTimeAsync(1001);
    expect(await setting).toEqual({ disposition: "handled" });
    await expect(f.policy.authorizeCheckpoint(f.checkpoint)).resolves.toBeUndefined();
    expect(f.policies.at(-1)).toBe(f.policy); expect(f.drain).not.toHaveBeenCalled();
    expect(f.skills.ensureLoaded).not.toHaveBeenCalled(); expect(f.skills.list).not.toHaveBeenCalled();
  } finally { await f.provider.close(); }
});

sourceAuthorityTest.each(["revision", "value"])("Copilot invalid setting %s revokes source authority before returning", async failure => {
  const f = await sourceAuthorityFixture();
  try {
    await f.policy.authorizeCheckpoint(f.checkpoint);
    await expect(f.provider.setSetting!("model", failure === "value" ? "unlisted" : "second", randomUUID(), failure === "revision" ? "0" : f.revision())).rejects.toThrow();
    expect(f.model.switchTo).not.toHaveBeenCalled(); expect(f.policies.at(-1)).toBeNull(); expect(f.drain).toHaveBeenCalledOnce();
    await expect(f.policy.authorizeCheckpoint(f.checkpoint)).rejects.toMatchObject({ code: "source_forbidden" });
  } finally { await f.provider.close(); }
});

sourceAuthorityTest.each([["tool_approval", "allow"], ["unknown", "value"]])("Copilot %s updates revoke pending checkpoints and drain before dispatch", async (id, value) => {
  const f = await sourceAuthorityFixture();
  let releaseDrain!: () => void;
  const drained = new Promise<void>(resolve => { releaseDrain = resolve; }), blocked = f.blockCheckpoint();
  try {
    const checking = f.policy.authorizeCheckpoint(f.checkpoint).catch(error => error);
    await blocked.started;
    f.drain.mockImplementation(() => drained);
    const setting = f.provider.setSetting!(id, value, randomUUID(), f.revision()).catch(error => error);
    expect(await checking).toMatchObject({ code: "source_forbidden" });
    expect(f.policies.at(-1)).toBeNull();
    expect(f.drain).toHaveBeenCalledOnce(); expect(f.setApproveAll).not.toHaveBeenCalled();
    const reply = once(fixture.child, "message"); blocked.release(); await reply;
    releaseDrain();
    if (id === "tool_approval") expect(await setting).toEqual({ disposition: "handled" });
    else expect(await setting).toBeInstanceOf(Error);
    expect(f.model.switchTo).not.toHaveBeenCalled();
    await expect(f.policy.authorizeCheckpoint(f.checkpoint)).rejects.toMatchObject({ code: "source_forbidden" });
  } finally { blocked.release(); releaseDrain(); await f.provider.close(); }
});

sourceAuthorityTest.each([
  ["model", "second", "reject"], ["effort", "high", "reject"],
  ["model", "second", "readback"], ["effort", "high", "readback"],
])("Copilot %s update %s (%s) keeps source capture fail-closed", async (id, value, failure) => {
  const f = await sourceAuthorityFixture();
  try {
    await expect(f.policy.authorizeCheckpoint(f.checkpoint)).resolves.toBeUndefined();
    if (id === "model") f.model.switchTo.mockImplementation(async () => { if (failure === "reject") throw new Error("Native update rejected"); return { deferred: false }; });
    else f.model.setReasoningEffort.mockImplementation(async () => { if (failure === "reject") throw new Error("Native update rejected"); return {}; });
    await expect(f.provider.setSetting!(id, value, randomUUID(), f.revision())).rejects.toThrow();
    expect(f.policies.at(-1)).toBeNull(); expect(f.drain).toHaveBeenCalledOnce();
    await expect(f.policy.authorizeCheckpoint(f.checkpoint)).rejects.toMatchObject({ code: "source_forbidden" });
    expect(f.readPaths).toHaveLength(1);
    await expect(f.provider.send(textNativeInput("Text remains available"), randomUUID(), null)).resolves.toMatchObject({ disposition: "started" });
  } finally { await f.provider.close(); }
});

sourceAuthorityTest("Copilot delayed effort completion cannot revive authority after the update deadline", async () => {
  const f = await sourceAuthorityFixture(); let complete!: () => void;
  try {
    f.model.setReasoningEffort.mockImplementation(({ reasoningEffort }) => new Promise(resolve => { complete = () => { f.state.reasoningEffort = reasoningEffort; resolve({}); }; }));
    vi.useFakeTimers();
    const setting = f.provider.setSetting!("effort", "high", randomUUID(), f.revision()), failed = expect(setting).rejects.toThrow("not confirmed");
    await vi.advanceTimersByTimeAsync(30_001); await failed;
    expect(f.policies.at(-1)).toBeNull(); expect(f.drain).toHaveBeenCalledOnce();
    complete(); await f.provider.refreshControls!();
    expect(fixture.states.at(-1)!.controls!.settings.find(setting => setting.id === "effort")?.value).toBe("high");
    await expect(f.policy.authorizeCheckpoint(f.checkpoint)).rejects.toMatchObject({ code: "source_forbidden" });
  } finally { complete?.(); await f.provider.close(); }
});

sourceAuthorityTest("Copilot deferred model timeout cannot revive authority on a later readback", async () => {
  const f = await sourceAuthorityFixture();
  try {
    f.model.switchTo.mockResolvedValue({ deferred: true }); vi.useFakeTimers();
    const setting = f.provider.setSetting!("model", "second", randomUUID(), f.revision()), failed = expect(setting).rejects.toThrow("not confirmed");
    await vi.advanceTimersByTimeAsync(30_001); await failed;
    expect(f.policies.at(-1)).toBeNull(); expect(f.drain).toHaveBeenCalledOnce();
    f.state.modelId = "second"; await f.provider.refreshControls!();
    expect(fixture.states.at(-1)!.controls!.settings.find(setting => setting.id === "model")?.value).toBe("second");
    await expect(f.policy.authorizeCheckpoint(f.checkpoint)).rejects.toMatchObject({ code: "source_forbidden" });
  } finally { await f.provider.close(); }
});

sourceAuthorityTest("a native permission change during an effort update still revokes source authority", async () => {
  const f = await sourceAuthorityFixture();
  try {
    f.model.setReasoningEffort.mockImplementation(async ({ reasoningEffort }) => { f.state.reasoningEffort = reasoningEffort; fixture.emit(event("session.permissions_changed", { mode: "assisted" })); return {}; });
    await f.provider.setSetting!("effort", "high", randomUUID(), f.revision());
    expect(f.policies.at(-1)).toBeNull(); expect(f.drain).toHaveBeenCalledOnce();
    await expect(f.policy.authorizeCheckpoint(f.checkpoint)).rejects.toMatchObject({ code: "source_forbidden" });
  } finally { await f.provider.close(); }
});

sourceAuthorityTest("an unknown Copilot command still revokes source authority and drains", async () => {
  const f = await sourceAuthorityFixture();
  try {
    await f.policy.authorizeCheckpoint(f.checkpoint);
    await expect(f.provider.executeCommand!("unknown", "", randomUUID(), f.revision(), null)).rejects.toThrow();
    expect(f.policies.at(-1)).toBeNull(); expect(f.drain).toHaveBeenCalledOnce();
    await expect(f.policy.authorizeCheckpoint(f.checkpoint)).rejects.toMatchObject({ code: "source_forbidden" });
  } finally { await f.provider.close(); }
});

test("Copilot still stops its owned runtime when image draining fails", async () => {
  const error = new Error("Image cleanup failed"), policies: unknown[] = [];
  const provider = await openCopilotProvider({ ...fixture.options, onNativeReadPolicy: policy => policies.push(policy), drainNativeReadPolicy: async () => { throw error; } });
  await expect(provider.close()).rejects.toBe(error);
  expect(fixture.native.disconnect).toHaveBeenCalledOnce();
  expect(fixture.child.exitCode).toBe(0); expect(fixture.child.kill).not.toHaveBeenCalled();
  expect(policies).toEqual([null]);
  expect(fixture.states.at(-1)?.activity).toBe("stopped");
});

test("new Copilot selection cannot pass startup after the native catalog is unavailable", async () => {
  const result = await openCopilotProvider({ ...fixture.options, model: "requested", validateNativeSelection: true }).then(provider => ({ provider, error: null }), error => ({ provider: null, error }));
  try { expect(result.error).toBeInstanceOf(Error); expect(fixture.native.send).not.toHaveBeenCalled(); }
  finally { await result.provider?.close(); }
  expect(fixture.child.signalCode).toBe("SIGTERM");
});

const { ResponseError } = createRequire(createRequire(import.meta.url).resolve("@github/copilot-sdk"))("vscode-jsonrpc/node") as { ResponseError: new (code: number, message: string) => Error };
test.each([-32099, -32098, -32097, -32096])("Copilot SDK local transport error %s remains unknown", async code => {
  fixture.client.createSession.mockRejectedValue(new ResponseError(code, "Local transport failed"));
  const error = await openCopilotProvider(fixture.options).catch(error => error);
  expect(startupFailure(error)).toEqual({ state: "unknown", reasonCode: "native_transport_unknown" });
});

test.each(["reject", "timeout"])("Copilot cleanup failure preserves the original startup %s without asserting stopped", async mode => {
  fixture.client.createSession.mockRejectedValue(mode === "reject" ? new ResponseError(-32602, "Native initialization rejected") : new NativeRpcTimeoutError("session.create"));
  fixture.child.kill.mockImplementation(() => { throw new Error("Fixture stop failed"); });
  const diagnostics: string[] = [];
  const error = await openCopilotProvider({ ...fixture.options, onDiagnostic: message => diagnostics.push(message) }).catch(error => error);
  expect(startupFailure(error)).toEqual(mode === "reject" ? { state: "failed", reasonCode: "native_rejected" } : { state: "unknown", reasonCode: "native_timeout" });
  expect(diagnostics.some(message => /stop|cleanup/i.test(message))).toBe(true);
  expect(fixture.states.some(state => state.activity === "stopped")).toBe(false);
  expect(fixture.child.signalCode).toBeNull();
});

test("Copilot late session creation after startup timeout cannot issue disconnect RPCs", async () => {
  vi.useFakeTimers();
  let settle!: (native: typeof fixture.native) => void;
  fixture.client.createSession.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
  const pending = openCopilotProvider(fixture.options).catch(error => error);
  await vi.waitFor(() => expect(fixture.client.createSession).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(30_001);
  expect(startupFailure(await pending)).toEqual({ state: "unknown", reasonCode: "native_timeout" });
  settle(fixture.native); await Promise.resolve(); await Promise.resolve();
  expect(fixture.native.disconnect).not.toHaveBeenCalled();
  expect(fixture.client.forceStop).toHaveBeenCalledOnce();
});

test.each([false, true])("Copilot appends the exact role without an initial user turn (resume=%s)", async resume => {
  const instructions = "  Daynight 助手\nKeep native defaults. 😀 e\u0301\n", id = resume ? randomUUID() : null;
  const setApproveAll = vi.fn(async () => ({ success: true }));
  Object.assign(fixture.native.rpc.permissions, { setApproveAll });
  const provider = await openCopilotProvider({ ...fixture.options, instructions, resumeNativeSessionId: id });
  try {
    expect(fixture.config().systemMessage).toEqual({ mode: "append", content: instructions });
    expect(fixture.config()).not.toHaveProperty("model");
    expect(fixture.config()).not.toHaveProperty("reasoningEffort");
    expect(provider.nativeSessionId).toBe(id ?? fixture.config().sessionId);
    expect(fixture.native.send).not.toHaveBeenCalled();
    expect(fixture.states.at(-1)).toMatchObject({ activity: "idle", currentTurnId: null });
    expect(fixture.entries.some(entry => entry.kind === "user_message")).toBe(false);
    expect(fixture.native.rpc.permissions.configure).not.toHaveBeenCalled();
    expect((fixture.config().onPermissionRequest as () => unknown)()).toEqual({ kind: "no-result" });
    if (resume) {
      expect(fixture.client.createSession).not.toHaveBeenCalled();
      expect(setApproveAll).not.toHaveBeenCalled();
    } else expect(setApproveAll).toHaveBeenCalledWith({ enabled: false });
    expect(processMock.spawn.mock.calls[0]![1]).not.toContain("--allow-all");
  } finally { await provider.close(); }
});

test.each([false, true])("Copilot leaves legacy sessions without a system message (resume=%s)", async resume => {
  const provider = await openCopilotProvider({ ...fixture.options, resumeNativeSessionId: resume ? randomUUID() : null });
  try {
    expect(fixture.config()).not.toHaveProperty("systemMessage");
    expect(fixture.native.send).not.toHaveBeenCalled();
  } finally { await provider.close(); }
});

test.each([false, true])("Copilot roles preserve explicit creation settings and native resume settings (resume=%s)", async resume => {
  const provider = await openCopilotProvider({ ...fixture.options, instructions: "Role", model: "selected-model", args: ["--effort", "high"], resumeNativeSessionId: resume ? randomUUID() : null });
  try {
    expect(fixture.config().systemMessage).toEqual({ mode: "append", content: "Role" });
    if (resume) {
      expect(fixture.config()).not.toHaveProperty("model");
      expect(fixture.config()).not.toHaveProperty("reasoningEffort");
    } else expect(fixture.config()).toMatchObject({ model: "selected-model", reasoningEffort: "high" });
  } finally { await provider.close(); }
});

test.each([false, true])("Copilot role startup failures preserve the error and stop the owned runtime (resume=%s)", async resume => {
  const error = new Error("Native role configuration rejected");
  const opening = resume ? fixture.client.resumeSession : fixture.client.createSession;
  opening.mockRejectedValue(error);
  await expect(openCopilotProvider({ ...fixture.options, instructions: "Role", resumeNativeSessionId: resume ? randomUUID() : null })).rejects.toBe(error);
  expect(fixture.native.send).not.toHaveBeenCalled();
  expect(fixture.client.rpc.runtime.shutdown).not.toHaveBeenCalled();
  expect(fixture.client.stop).not.toHaveBeenCalled();
  expect(fixture.client.forceStop).toHaveBeenCalledOnce();
  expect(fixture.child.kill).toHaveBeenCalledWith("SIGTERM");
  expect(fixture.child.signalCode).toBe("SIGTERM");
  expect(fixture.states.at(-1)?.activity).toBe("stopped");
  if (resume) expect(fixture.client.createSession).not.toHaveBeenCalled();
});

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
  await provider.close(); expect(fixture.child.exitCode).toBe(0); expect(fixture.child.kill).not.toHaveBeenCalled(); expect(fixture.states.at(-1)?.activity).toBe("stopped");
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
  expect(fixture.native.disconnect).not.toHaveBeenCalled(); expect(fixture.child.kill).toHaveBeenCalled();
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
  const receipt = await provider.send(textNativeInput("same text"), operation, null);
  expect(receipt.disposition).toBe("started"); expect(receipt.turnId).toBeTruthy();
  expect(fixture.native.send).toHaveBeenCalledWith({ prompt: "same text", mode: "immediate" });
  expect(fixture.observed).not.toContain(operation);
  await provider.close();
});

test("Copilot cannot submit input when the working-state callback fences its queued send", async () => {
  const failure = new Error("accounting failure"); let fenced = false;
  const provider = await openCopilotProvider({ ...fixture.options,
    onState: state => { fixture.options.onState(state); if (state.activity === "working") fenced = true; },
    assertNativeDispatch: () => { if (fenced) throw failure; },
  });
  try {
    await expect(provider.send(textNativeInput("must not dispatch"), randomUUID(), null)).rejects.toBe(failure);
    expect(fixture.native.send).not.toHaveBeenCalled();
  } finally { await provider.close(); }
});

test("Copilot model-step completion and child idle cannot complete the foreground turn", async () => {
  const provider = await openCopilotProvider(fixture.options);
  const receipt = await provider.send(textNativeInput("work"), randomUUID(), null); let ended = false;
  const waiting = provider.waitForTurn(receipt.turnId!, Date.now() + 2000).then(() => { ended = true; });
  fixture.emit(event("assistant.turn_start", { turnId: "0", interactionId: "a" }));
  fixture.emit(event("assistant.turn_end", { turnId: "0" }));
  fixture.emit(event("assistant.idle", {}, "child"));
  await Promise.resolve(); expect(ended).toBe(false); expect(fixture.states.at(-1)?.currentTurnId).toBe(receipt.turnId);
  fixture.emit(event("assistant.idle")); await waiting; expect(fixture.states.at(-1)?.currentTurnId).toBeNull();
  const next = await provider.send(textNativeInput("next"), randomUUID(), null); expect(next.turnId).not.toBe(receipt.turnId);
  await provider.close();
});

test("Copilot steer belongs to the active turn and stale sends are rejected before native dispatch", async () => {
  const provider = await openCopilotProvider(fixture.options), receipt = await provider.send(textNativeInput("work"), randomUUID(), null);
  await expect(provider.send(textNativeInput("stale"), randomUUID(), randomUUID())).rejects.toThrow(/turn/i);
  expect(fixture.native.send).toHaveBeenCalledTimes(1);
  await expect(provider.send(textNativeInput("direction"), randomUUID(), receipt.turnId!)).resolves.toMatchObject({ turnId: receipt.turnId });
  await provider.close();
});

test("Copilot cancellation waits for foreground stop and preserves child ownership", async () => {
  const provider = await openCopilotProvider(fixture.options), receipt = await provider.send(textNativeInput("work"), randomUUID(), null); let confirmed = false;
  const cancel = provider.cancel(receipt.turnId!).then(() => { confirmed = true; });
  await Promise.resolve(); expect(confirmed).toBe(false);
  fixture.emit(event("abort", {}, "child")); await Promise.resolve(); expect(confirmed).toBe(false);
  fixture.emit(event("abort")); await cancel;
  expect(fixture.native.rpc.interruptMainTurn).toHaveBeenCalledWith({}); await provider.close();
});

test("Copilot child loss rejects in-flight send and disables all controls without replay", async () => {
  const provider = await openCopilotProvider(fixture.options);
  fixture.native.send.mockImplementation(() => new Promise(() => {}));
  const send = provider.send(textNativeInput("uncertain"), randomUUID(), null), rejection = expect(send).rejects.toThrow(/unknown|connection|stopped/);
  await Promise.resolve();
  fixture.child.exitCode = 1; fixture.child.emit("exit", 1, null); fixture.child.emit("close", 1, null);
  await rejection; expect(fixture.states.at(-1)).toMatchObject({ activity: "unknown", capabilities: { send: false, steer: false, cancel: false, respond: false } });
  await expect(provider.send(textNativeInput("again"), randomUUID(), null)).rejects.toThrow(); expect(fixture.native.send).toHaveBeenCalledTimes(1);
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

test("Copilot joins its owned runtime after media cleanup fails and retries the retained cleanup", async () => {
  const provider = await openCopilotProvider(fixture.options), failure = new Error("Fixture media removal failed");
  const closeImages = vi.spyOn(CopilotImages.prototype, "close").mockRejectedValueOnce(failure).mockResolvedValue(undefined);
  try {
    await expect(provider.close()).rejects.toBe(failure);
    expect(fixture.client.rpc.runtime.shutdown).toHaveBeenCalledOnce(); expect(fixture.child.kill).not.toHaveBeenCalled();
    expect(fixture.child.exitCode).toBe(0); expect(fixture.states.at(-1)?.activity).toBe("stopped");
    await expect(provider.close()).resolves.toBeUndefined(); expect(closeImages).toHaveBeenCalledTimes(2);
    expect(fixture.child.kill).not.toHaveBeenCalled();
  } finally { closeImages.mockRestore(); await provider.close().catch(() => {}); }
});

test("Copilot preserves media and runtime shutdown errors without reporting an unjoined runtime as stopped", async () => {
  const provider = await openCopilotProvider(fixture.options), mediaFailure = new Error("Fixture media removal failed"), runtimeFailure = new Error("Fixture process termination failed");
  const closeImages = vi.spyOn(CopilotImages.prototype, "close").mockRejectedValue(mediaFailure);
  vi.useFakeTimers(); fixture.client.rpc.runtime.shutdown.mockImplementation(async () => ({}));
  fixture.child.kill.mockImplementation(() => { throw runtimeFailure; });
  fixture.emit(event("permission.requested", { requestId: "cleanup-permission", permissionRequest: { kind: "shell", fullCommandText: "echo fixture" } }));
  try {
    const closing = provider.close().catch(error => error); await vi.advanceTimersByTimeAsync(1500); const error = await closing;
    expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual(expect.arrayContaining([mediaFailure, runtimeFailure]));
    expect(fixture.client.rpc.runtime.shutdown).toHaveBeenCalledOnce(); expect(fixture.child.kill).toHaveBeenCalled();
    expect(fixture.states.some(state => state.activity === "stopped")).toBe(false);
    expect(fixture.states.at(-1)).toMatchObject({ activity: "unknown", capabilities: { send: false, steer: false, cancel: false, respond: false } });
  } finally { fixture.child.exitCode = 0; fixture.child.emit("exit", 0, null); closeImages.mockRestore(); await provider.close().catch(() => {}); }
});

test("Copilot late ACK confirms only the timed-out invocation in its still-owned runtime", async () => {
  const onInputMessage = vi.fn();
  const provider = await openCopilotProvider({ ...fixture.options, onInputMessage }); vi.useFakeTimers();
  let acknowledge!: (id: string) => void; fixture.native.send.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
  const operation = randomUUID(), rejected = expect(provider.send(textNativeInput("one dispatch"), operation, null)).rejects.toThrow(/unknown/);
  await vi.advanceTimersByTimeAsync(60_001); await rejected; expect(fixture.observed).toEqual([]);
  acknowledge("real-native-message-id"); await vi.advanceTimersByTimeAsync(0);
  expect(fixture.observed).toEqual([operation]); expect(fixture.native.send).toHaveBeenCalledOnce();
  expect(onInputMessage).toHaveBeenCalledWith(operation, provider.nativeSessionId, nativeEntryId(provider.nativeSessionId, ":user:real-native-message-id"));
  await provider.close();
});

test("Copilot ACK arriving after runtime loss cannot confirm input", async () => {
  const provider = await openCopilotProvider(fixture.options); let acknowledge!: (id: string) => void;
  fixture.native.send.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
  const rejected = expect(provider.send(textNativeInput("uncertain"), randomUUID(), null)).rejects.toThrow(/unknown/);
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

test("Copilot leaves a new session without a todo entry until native todos exist", async () => {
  const provider = await openCopilotProvider(fixture.options);
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(fixture.entries).toEqual([]);
    fixture.emit(event("session.todos_changed"));
    await new Promise(resolve => setImmediate(resolve));
    expect(fixture.entries).toEqual([]);
    expect(fixture.states.at(-1)).toMatchObject({ activity: "idle", nativeSessionId: provider.nativeSessionId });
    expect(fixture.native.send).not.toHaveBeenCalled();
  } finally { await provider.close(); }
});

test("Copilot retains the same todo entry when a populated list is cleared and refilled", async () => {
  fixture.native.rpc.plan.readSqlTodos.mockResolvedValue({ rows: [{ id: "a", title: "First", status: "pending" }] });
  const provider = await openCopilotProvider(fixture.options);
  try {
    await new Promise(resolve => setImmediate(resolve));
    fixture.native.rpc.plan.readSqlTodos.mockResolvedValue({ rows: [] });
    fixture.emit(event("session.todos_changed"));
    await new Promise(resolve => setImmediate(resolve));
    fixture.native.rpc.plan.readSqlTodos.mockResolvedValue({ rows: [{ id: "a", description: "Finished", status: "done" }] });
    fixture.emit(event("session.todos_changed"));
    await new Promise(resolve => setImmediate(resolve));
    const todos = fixture.entries.filter(entry => entry.kind === "todo");
    expect(todos.map(entry => entry.items)).toEqual([[{ id: "a", text: "First", status: "pending" }], [], [{ id: "a", text: "Finished", status: "completed" }]]);
    expect(new Set(todos.map(entry => entry.entryId)).size).toBe(1);
  } finally { await provider.close(); }
});

test("Copilot resume publishes an empty current list to clear its previously projected todo identity", async () => {
  fixture.native.rpc.plan.readSqlTodos.mockResolvedValue({ rows: [{ id: "a", title: "Before resume", status: "in_progress" }] });
  const first = await openCopilotProvider(fixture.options);
  await new Promise(resolve => setImmediate(resolve));
  const previous = fixture.entries.find(entry => entry.kind === "todo")!;
  await first.close();
  fixture = setup();
  const resumed = await openCopilotProvider({ ...fixture.options, resumeNativeSessionId: first.nativeSessionId });
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(fixture.entries.filter(entry => entry.kind === "todo")).toEqual([{ ...previous, items: [] }]);
    expect(fixture.client.createSession).not.toHaveBeenCalled();
  } finally { await resumed.close(); }
});

test("Copilot failed todo reads neither invent an empty entry nor discard a later clear", async () => {
  const diagnostic = vi.fn();
  fixture.native.rpc.plan.readSqlTodos.mockRejectedValueOnce(new Error("Unavailable"));
  const provider = await openCopilotProvider({ ...fixture.options, onDiagnostic: diagnostic });
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(diagnostic).toHaveBeenCalledWith("Copilot todo state is unavailable.");
    expect(fixture.entries).toEqual([]);
    fixture.emit(event("session.todos_changed"));
    await new Promise(resolve => setImmediate(resolve));
    expect(fixture.entries).toEqual([]);
    fixture.native.rpc.plan.readSqlTodos.mockResolvedValueOnce({ rows: [{ id: "a", title: "Retained", status: "pending" }] });
    fixture.emit(event("session.todos_changed"));
    await new Promise(resolve => setImmediate(resolve));
    fixture.native.rpc.plan.readSqlTodos.mockRejectedValueOnce(new Error("Unavailable again"));
    fixture.emit(event("session.todos_changed"));
    await new Promise(resolve => setImmediate(resolve));
    expect(fixture.entries.filter(entry => entry.kind === "todo")).toHaveLength(1);
    fixture.emit(event("session.todos_changed"));
    await new Promise(resolve => setImmediate(resolve));
    expect(fixture.entries.filter(entry => entry.kind === "todo").map(entry => entry.items)).toEqual([[{ id: "a", text: "Retained", status: "pending" }], []]);
    expect(diagnostic).toHaveBeenCalledTimes(2);
  } finally { await provider.close(); }
});

test("Copilot serializes concurrent todo refreshes so a clear follows its populated read", async () => {
  type Rows = Awaited<ReturnType<typeof fixture.native.rpc.plan.readSqlTodos>>;
  const settle: ((value: Rows) => void)[] = [];
  fixture.native.rpc.plan.readSqlTodos.mockImplementation(() => new Promise(resolve => settle.push(resolve)));
  const provider = await openCopilotProvider(fixture.options);
  try {
    fixture.emit(event("session.todos_changed"));
    await new Promise(resolve => setImmediate(resolve));
    expect(settle).toHaveLength(1);
    settle[0]!({ rows: [{ id: "a", title: "Queued", status: "pending" }] });
    await new Promise(resolve => setImmediate(resolve));
    expect(settle).toHaveLength(2);
    expect(fixture.entries.filter(entry => entry.kind === "todo").map(entry => entry.items)).toEqual([[{ id: "a", text: "Queued", status: "pending" }]]);
    settle[1]!({ rows: [] });
    await new Promise(resolve => setImmediate(resolve));
    const todos = fixture.entries.filter(entry => entry.kind === "todo");
    expect(todos.map(entry => entry.items)).toEqual([[{ id: "a", text: "Queued", status: "pending" }], []]);
    expect(todos[0]!.entryId).toBe(todos[1]!.entryId);
  } finally { await provider.close(); }
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
  const rejected = expect(provider.send(textNativeInput("must not reach native"), randomUUID(), null)).rejects.toThrow();
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

test.each([false, true])("Copilot does not initialize native permissions after a fence during session creation (unattended=%s)", async unattended => {
  const failure = new Error("accounting failure"); let fenced = false;
  const setApproveAll = vi.fn(async () => ({ success: true })); Object.assign(fixture.native.rpc.permissions, { setApproveAll });
  const create = fixture.client.createSession.getMockImplementation()!;
  fixture.client.createSession.mockImplementation(async config => { const session = await create(config); fenced = true; return session; });
  await expect(openCopilotProvider({ ...fixture.options, unattended, assertNativeDispatch: () => { if (fenced) throw failure; } })).rejects.toBe(failure);
  expect(fixture.client.createSession).toHaveBeenCalledOnce();
  expect(fixture.native.rpc.permissions.configure).not.toHaveBeenCalled(); expect(setApproveAll).not.toHaveBeenCalled();
  expect(fixture.native.send).not.toHaveBeenCalled();
});

const imageFixture = async (pure = false, provenGeometry = true) => {
  sdk.provenGeometry = provenGeometry;
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/copilot-provider-images"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")), localPath = path.join(root, "image.png");
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  await writeFile(localPath, bytes, { mode: 0o400 });
  const operationId = randomUUID(), image = { type: "image" as const, imageId: randomUUID(), resourceId: randomUUID(), mediaType: "image/png", localPath, byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex") };
  const input = { content: [...pure ? [] : [{ type: "text" as const, text: "Inspect the image" }], image] }, states = new Map<string, unknown>();
  const intent: any = { sha256: "b".repeat(64), command: { kind: "send_message", operationId, payload: { expectedTurnId: null, target: { expectedNativeSessionId: null }, content: input.content } } };
  const model = { getCurrent: vi.fn(async () => ({ modelId: "vision-model" })), list: vi.fn(async () => ({ list: [{ id: "vision-model", name: "Vision", capabilities: { supports: { vision: true }, limits: { vision: { supported_media_types: ["image/png"], max_prompt_image_size: 10_485_760, max_prompt_images: 8 } } } }] })) };
  Object.assign(fixture.native.rpc, { model }); Object.assign(fixture.client, { getStatus: vi.fn(async () => ({ version: "1.0.105", protocolVersion: 3 })) });
  const observed = vi.fn(() => true);
  const options = { ...fixture.options, onInputObserved: observed, imageRuntime: { getIntent: (id: string) => id === operationId ? intent : null, readState: (key: string) => states.get(key) ?? null, writeState: (key: string, value: unknown) => states.set(key, structuredClone(value)) } } as unknown as ProviderOptions;
  return { root, input, image, intent, operationId, options, observed, states, model };
};

test.each([true, false])("under a controlled proven geometry profile the common Copilot send preserves ordered leases and durable acceptance (pure=%s)", async pure => {
  const f = await imageFixture(pure); let provider;
  try {
    provider = await openCopilotProvider(f.options);
    expect(fixture.states.at(-1)?.images).toMatchObject({ send: "supported", steer: "unknown" });
    const receipt = await provider.send(f.input, f.operationId, null); expect(receipt.disposition).toBe("started");
    expect(sdk.imageSend).toHaveBeenCalledOnce(); expect(sdk.imageSend.mock.calls[0]?.[1]).toEqual({ prompt: pure ? "" : "Inspect the image", mode: "immediate", attachments: [{ path: f.image.localPath, byteLength: f.image.byteLength, sha256: f.image.sha256, mimeType: "image/png" }] });
    expect(fixture.native.send).not.toHaveBeenCalled(); expect(f.observed).toHaveBeenCalledWith(expect.objectContaining({ provider: "copilot", operationId: f.operationId, nativeMessageId: "native-image-message", intentSha256: f.intent.sha256 }));
    await expect(provider.send(f.input, randomUUID(), receipt.turnId!)).rejects.toThrow("capability"); expect(sdk.imageSend).toHaveBeenCalledOnce();
  } finally { await provider?.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("second image validation failure and changed model evidence both prevent the entire Copilot send", async () => {
  const f = await imageFixture(); let provider;
  try {
    provider = await openCopilotProvider(f.options);
    const changed = { ...f.image, imageId: randomUUID(), sha256: "f".repeat(64) };
    await expect(provider.send({ content: [...f.input.content, changed] }, f.operationId, null)).rejects.toThrow("integrity");
    expect(sdk.imageSend).not.toHaveBeenCalled(); expect(fixture.native.send).not.toHaveBeenCalled();
    f.model.getCurrent.mockResolvedValue({ modelId: "unknown-model" });
    await expect(provider.send(f.input, f.operationId, null)).rejects.toThrow("capability"); expect(sdk.imageSend).not.toHaveBeenCalled();
    expect(fixture.states.at(-1)?.currentTurnId).toBeNull();
  } finally { await provider?.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Copilot does not send an image after the fence rises during native model revalidation", async () => {
  const f = await imageFixture(), failure = new Error("accounting failure"); let fenced = false, release!: (value: { modelId: string }) => void;
  let provider: Awaited<ReturnType<typeof openCopilotProvider>> | undefined;
  try {
    provider = await openCopilotProvider({ ...f.options, assertNativeDispatch: () => { if (fenced) throw failure; } });
    f.model.getCurrent.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = provider.send(f.input, f.operationId, null);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    fenced = true; release({ modelId: "vision-model" });
    await expect(pending).rejects.toBe(failure);
    expect(sdk.imageSend).not.toHaveBeenCalled(); expect(fixture.native.send).not.toHaveBeenCalled();
  } finally { await provider?.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Copilot image acceptance remains unknown if its durable callback does not confirm", async () => {
  const f = await imageFixture(); f.observed.mockReturnValue(false); let provider;
  try {
    provider = await openCopilotProvider(f.options);
    await expect(provider.send(f.input, f.operationId, null)).rejects.toThrow("durably");
    expect(sdk.imageSend).toHaveBeenCalledOnce(); expect(fixture.states.at(-1)?.images?.send).toBe("unknown");
  } finally { await provider?.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a timed-out Copilot image send keeps its original Promise and appends late original provenance without replay", async () => {
  const f = await imageFixture(); let provider;
  const { openControllerLifecycleStore } = await import("../../../src/commands/controller/lifecycle-store.js");
  const { observeNativeInput } = await import("../../../src/commands/controller/recovery.js");
  const ticket: import("../../../src/commands/controller/launch-ticket.js").ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "copilot", cwd: f.root, nativeHome: path.join(f.root, ".copilot"), configuration: { agent: "copilot", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(f.root, "grant.json"), ipcEndpoint: path.join(f.root, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const journal = openControllerLifecycleStore(path.join(f.root, "journal.sqlite"), ticket, { contentOwnedLocally: true });
  const { readFile } = await import("node:fs/promises");
  journal.saveResource({ resourceId: f.image.resourceId, revision: "1", status: "available", name: "original.png", mediaType: "image/png", byteLength: f.image.byteLength, sha256: f.image.sha256, width: 1, height: 1, frameCount: 1, error: null }, await readFile(f.image.localPath));
  const payload = { content: [{ type: "text" as const, text: "Inspect the image" }, { type: "image" as const, imageId: f.image.imageId, resourceId: f.image.resourceId, uploadId: randomUUID(), sha256: f.image.sha256, byteLength: f.image.byteLength }], expectedTurnId: null, target: { serverOrigin: ticket.serverOrigin, actorUserId: ticket.userId, fence: { sessionId: ticket.sessionId, claimId: ticket.claimId!, executionGeneration: "1" }, expectedNativeSessionId: null }, expectedImageCapabilityRevision: "1", draftId: randomUUID(), draftRevision: "1" };
  const command: import("../../../src/session/protocol.js").SessionCommand = { protocol: "daynight.session.v1", contentRevision: 2, requestId: randomUUID(), operationId: f.operationId, sessionId: ticket.sessionId, claimId: ticket.claimId!, executionGeneration: "1", kind: "send_message", payload };
  journal.prepareOperation({ operationId: f.operationId, kind: "send_message", payload, intent: command }); journal.markDispatching(f.operationId);
  Object.assign(f.options.imageRuntime!, { getIntent: (operationId: string) => { const intent = journal.getInputIntent(operationId), operation = journal.getOperation(operationId); return intent && operation ? { command: JSON.parse(intent.canonical), sha256: intent.sha256, state: operation.state } : null; }, readState: journal.readNativeImageState, writeState: journal.writeNativeImageState, publishNativeInputAssociation: journal.publishNativeInputAssociation, queryNativeInputAssociation: journal.queryNativeInputAssociation });
  const timeline = f.options.onTimeline; f.options.onTimeline = entry => { journal.projectTimeline(entry); timeline(entry); };
  f.options.onInputObserved = observation => { f.observed(); return observeNativeInput(journal, observation); };
  f.options.onImageOccurrence = (occurrence, source) => journal.registerImageOccurrence(occurrence, source).acknowledged;
  f.options.imageOccurrenceAcknowledged = imageId => journal.imageOccurrenceAcknowledged(imageId);
  try {
    provider = await openCopilotProvider(f.options); journal.patchSnapshot({ nativeSessionId: provider.nativeSessionId }); let acknowledge!: (id: string) => void;
    sdk.imageSend.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
    vi.useFakeTimers();
    const sending = provider.send(f.input, f.operationId, null), rejected = expect(sending).rejects.toThrow("unknown");
    await vi.waitFor(() => expect(sdk.imageSend).toHaveBeenCalledOnce());
    fixture.emit({ ...event("user.message", { content: "Inspect the image", attachments: [{ type: "blob", mimeType: "image/png", omittedReason: "size_limit" }] }), id: "late-native" });
    const before = (fixture.entries.find(entry => entry.kind === "user_message") as any).content[1].imageId;
    await vi.advanceTimersByTimeAsync(60_001); await rejected; expect(f.observed).not.toHaveBeenCalled();
    acknowledge("late-native"); await vi.advanceTimersByTimeAsync(0);
    expect(f.observed).toHaveBeenCalledOnce(); expect(sdk.imageSend).toHaveBeenCalledOnce();
    const after = journal.readTimeline({ historyEpoch: "epoch", direction: "tail", cursor: null, limit: 10 }).items.find(entry => entry.kind === "user_message") as any;
    expect(after.content).toHaveLength(3); expect(after.content[1].imageId).toBe(before); expect(after.content[2].imageId).toBe(f.image.imageId);
  } finally { await provider?.close(); vi.useRealTimers(); journal.close(); await rm(f.root, { recursive: true, force: true }); }
});


test("the installed Copilot profile refuses image input without a proven geometry envelope while text stays available", async () => {
  const f = await imageFixture(true, false); let provider;
  try {
    provider = await openCopilotProvider(f.options);
    expect(fixture.states.at(-1)?.images).toMatchObject({ send: "unknown", reasonCode: "capability_unknown", geometry: { known: false } });
    await expect(provider.send(f.input, f.operationId, null)).rejects.toThrow("capability");
    expect(sdk.imageSend).not.toHaveBeenCalled(); expect(fixture.native.send).not.toHaveBeenCalled();
    await provider.send(textNativeInput("Still text"), randomUUID(), null);
    expect(fixture.native.send).toHaveBeenCalledOnce();
  } finally { await provider?.close(); await rm(f.root, { recursive: true, force: true }); }
});


test.each(["complete", "incomplete", "wrong-request", "expired", "during-replay", "unavailable", "repeated-expiry"])("Copilot bounded permission prepass preserves %s cross-page history", async mode => {
  const sessionId = randomUUID(), key = "a".repeat(64), sourcePath = "/controlled/image.png";
  const marker = copilotReadMarker(key, sessionId, randomUUID(), 1, "b".repeat(64), sourcePath);
  const request = { kind: "read" as const, path: sourcePath, intention: marker };
  const requested = event("permission.requested", { requestId: "internal", permissionRequest: request, promptRequest: { intention: marker } });
  const signing = new CopilotReadCorrelation(key, sessionId); signing.issue(marker, sourcePath);
  const rejection = signing.reject(request, { sessionId })!;
  expect(signing.suppress(requested)).toBe(true);
  const refusal = await rejection;
  const completed = event("permission.completed", { requestId: mode === "wrong-request" ? "different" : "internal", result: { kind: "denied-interactively-by-user", feedback: refusal.feedback } });
  const ordinary = event("permission.requested", { requestId: "ordinary", permissionRequest: { kind: "shell", fullCommandText: "echo ordinary" }, promptRequest: { intention: "Ordinary native permission" } });
  const ordinaryDone = event("permission.completed", { requestId: "ordinary", result: { kind: "denied-interactively-by-user" } });
  const history = [requested, ordinary, event("user.message", { content: "keep ordinary history" }), ...(mode === "incomplete" ? [] : [completed]), ordinaryDone];
  const correlation = new CopilotReadCorrelation(key, sessionId);
  const prepareHistory = vi.fn((events: readonly unknown[]) => correlation.prepareHistory(events));
  sdk.authority = { install: async () => {}, invalidate: vi.fn(), observe: vi.fn(), rejectPermission: (value: unknown, context: unknown) => correlation.reject(value, context), prepareHistory, suppressPermissionEvent: (value: unknown, historical: boolean) => correlation.suppress(value, historical) };
  let expired = false, injected = false;
  fixture.native.rpc.eventLog.read.mockImplementation(async (input: any) => {
    const selected = input.types ? history.filter(item => input.types.includes(item.type) && (mode !== "during-replay" || item !== requested && item !== completed)) : history;
    if (mode === "during-replay" && !input.types && !injected) {
      injected = true; correlation.issue(marker, sourcePath);
      const rejecting = (fixture.config().onPermissionRequest as (request: unknown, context: unknown) => Promise<unknown>)(request, { sessionId });
      fixture.emit(requested); await rejecting; fixture.emit(completed);
    }
    if (input.types && (mode === "unavailable" || mode === "repeated-expiry")) return { events: [], cursor: "unknown", hasMore: false, cursorStatus: mode === "unavailable" ? "unknown" : "expired" };
    if (mode === "expired" && input.types && input.cursor && !expired) { expired = true; return { events: [], cursor: "expired", hasMore: false, cursorStatus: "expired" }; }
    const index = Number(input.cursor ?? 0);
    return { events: selected.slice(index, index + 1), cursor: String(index + 1), hasMore: index + 1 < selected.length, cursorStatus: "ok" };
  });
  const { executable: _executable, ...options } = fixture.options;
  const provider = await openCopilotProvider({ ...options, resumeNativeSessionId: sessionId, onNativeReadPolicy() {} });
  try {
    const interactions = fixture.entries.filter(entry => entry.kind === "interaction");
    const internal = interactions.filter(entry => entry.interaction.title === marker);
    const unavailable = mode === "unavailable" || mode === "repeated-expiry";
    expect(internal.map(entry => entry.interaction.state)).toEqual(mode === "complete" || mode === "expired" || mode === "during-replay" ? [] : unavailable ? ["expired", "resolved"] : ["expired"]);
    expect(interactions.filter(entry => entry.interaction.title === "Ordinary native permission").map(entry => entry.interaction.state)).toEqual(["expired", "resolved"]);
    expect(fixture.entries).toContainEqual(expect.objectContaining({ kind: "user_message", content: [{ type: "text", text: "keep ordinary history" }] }));
    if (unavailable) {
      expect(prepareHistory).not.toHaveBeenCalled(); expect(sdk.authority.invalidate).toHaveBeenCalledOnce();
      await expect(provider.send(textNativeInput("ordinary text remains available"), randomUUID(), null)).resolves.toMatchObject({ disposition: "started" });
    } else {
      expect(prepareHistory).toHaveBeenCalledOnce();
      expect(prepareHistory.mock.calls[0]![0]).toEqual(history.filter(item => item.type.startsWith("permission.") && (mode !== "during-replay" || item !== requested && item !== completed)));
    }
    expect(fixture.native.getEvents).not.toHaveBeenCalled();
    expect(fixture.native.rpc.eventLog.read.mock.calls.every(([input]) => input.max === 1 && input.includeEphemeral === false)).toBe(true);
    expect(fixture.states.at(-1)?.activity).toBe(unavailable ? "working" : "idle");
  } finally { await provider.close(); }
});


test("Copilot associates the receipt identity after an earlier message event without matching equal text", async () => {
  const associated: unknown[][] = [], onInputMessage = (...values: unknown[]) => { associated.push(values); };
  const provider = await openCopilotProvider({ ...fixture.options, onInputMessage });
  const operationId = randomUUID(), nativeMessage = event("user.message", { content: "same input" });
  try {
    fixture.native.send.mockImplementation(async () => {
      fixture.emit(nativeMessage);
      fixture.emit(event("user.message", { content: "same input" }));
      expect(associated).toEqual([]);
      return nativeMessage.id;
    });
    await provider.send(textNativeInput("same input"), operationId, null);
    expect(associated).toEqual([[operationId, provider.nativeSessionId, nativeEntryId(provider.nativeSessionId, `:user:${nativeMessage.id}`)]]);
    expect(fixture.entries.filter(entry => entry.kind === "user_message")).toHaveLength(2);
    expect(fixture.native.send).toHaveBeenCalledOnce();
  } finally { await provider.close(); }
});
