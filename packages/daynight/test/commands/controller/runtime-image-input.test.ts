import { beforeEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import stateVector from "../../session/fixtures/runtime-image-state.json" with { type: "json" };
import { parseControllerState } from "../../../src/session/controller-protocol.js";
const f = vi.hoisted(() => ({ callbacks: null as any, options: null as any, authorize: vi.fn(), acquire: vi.fn(), send: vi.fn(), receipt: vi.fn(), order: [] as string[], state: "accepted", revision: "1", turn: null as string | null, actualState: false, storageFault: false, nativeClose: vi.fn(), journalClose: vi.fn(), mediaClose: vi.fn(), publication: vi.fn(), query: vi.fn(), patch: vi.fn(), intent: vi.fn(), adopt: vi.fn(), current: vi.fn() }));
vi.mock("../../../src/commands/controller/storage-lock.js", () => ({ acquireControllerStoragePermit: () => ({ journalFile: "/private/controller/journal.sqlite", owner: "fixture", release: () => {} }), controllerStorageConnectionIsOpen: () => false, isControllerStorageLockHeld: () => false }));
vi.mock("../../../src/commands/controller/storage-preparation.js", () => ({ prepareControllerStorage: () => ({ kind: "prepared", snapshot: null, legacyTimelineCleanupPending: false }) }));
vi.mock("node:fs/promises", () => ({ mkdir: async () => {}, realpath: async (v: string) => v, chmod: async () => {}, unlink: async () => {} }));
vi.mock("node:net", () => ({ createServer: () => { const s: any = new EventEmitter(); s.listen = (_: unknown, cb: () => void) => queueMicrotask(cb); s.close = () => {}; return s; } }));
vi.mock("../../../src/commands/controller/launch-ticket.js", () => ({ readLaunchTicket: async () => ({ provider: "codex", cwd: process.cwd(), executionId: "execution", executionGeneration: "2", sessionId: "session", claimId: "claim", launchId: "launch", nativeHome: "/private/native", ipcEndpoint: "/private/ipc", configuration: { model: null, args: [] }, resumeNativeSessionId: null }), controllerExecutionDirectory: () => "/private/controller" }));
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ captureControllerProcessProof: async () => ({ pid: 1 }), captureProcessProof: async () => ({ pid: 1 }) }));
vi.mock("../../../src/commands/controller/providers/codex.js", () => ({ openCodexProvider: async (options: unknown) => { f.options = options; return { send: f.send, close: f.nativeClose }; } }));
vi.mock("../../../src/commands/controller/relay.js", () => ({ createControllerRelay: (_: unknown, __: unknown, callbacks: any) => { f.callbacks = callbacks; return { flush: async () => {}, close: () => {}, connected: () => true, authorize: f.authorize, receipt: f.receipt }; } }));
vi.mock("../../../src/commands/controller/lifecycle-store.js", () => ({ openControllerLifecycleStore: () => ({ reconcileNativeIndexReservation: async () => {}, listOperations: () => [], patchSnapshot: () => { if (f.storageFault) throw new Error("Unresolved journal transaction"); }, getSnapshot: () => { if (f.storageFault) throw new Error("Unresolved journal transaction"); return ({ nativeSessionId: "native", initialInputState: "confirmed", activity: "idle", currentTurnId: f.turn, capabilities: { send: true, steer: true, cancel: true, respond: true } }); }, providerImageCapabilities: (value: object) => f.actualState ? { ...value, revision: "1" } : ({ ...imageCaps(), revision: f.revision }), appendEvent: () => {}, prepareOperation: () => ({ operationId: "op", kind: "send_message", state: "accepted" }), media: () => ({ acquireInput: f.acquire }), assertInputCapacity: () => {}, markDispatching: () => { f.order.push("dispatch"); f.state = "dispatching"; }, getOperation: () => ({ state: f.state }), recordOperation: (_: unknown, state: string) => { f.state = state; return { state }; }, markProjectionGap: () => { if (f.storageFault) throw new Error("Unresolved journal transaction"); }, close: f.journalClose, stopMedia: f.mediaClose, assertUsable: () => { if (f.storageFault) throw new Error("Unresolved journal transaction"); }, publishNativeInputAssociation: f.publication, queryNativeInputAssociation: f.query, patchNativeImagePart: f.patch, getInputIntent: f.intent, getTimelineEntry: f.current }) }));
vi.mock("../../../src/commands/controller/markdown/coordinator.js", () => ({ createMarkdownCaptureCoordinator: () => ({ tick: async () => {}, stop: async () => {}, invalidate: () => {} }) }));
vi.mock("../../../src/commands/controller/markdown/pipeline.js", () => ({ createMarkdownTimelinePipeline: () => ({ tick: async () => {}, stop: async () => {}, adoptCommitted: f.adopt }) }));
vi.mock("../../../src/config/agent-cli-aliases.js", () => ({ readAgentCliAliases: async () => ({}) }));
vi.mock("../../../src/commands/controller/media/input-intent.js", () => ({ restoreCanonicalInputIntent: (intent: any) => intent.command }));
vi.mock("../../../src/commands/controller/launch-tool-selection.js", () => ({ readLaunchToolSelection: async (_home: string, ticket: { configuration: { toolLaunch?: unknown } }) => ticket.configuration.toolLaunch }));
import { runController } from "../../../src/commands/controller/runtime.js";
const imageCaps = () => ({ revision: "7", providerRevision: "1", expectedNativeSessionId: "native", modelId: "model", controlsRevision: "1", send: "supported" as const, steer: "supported" as const, reasonCode: null, inputMediaTypes: ["image/png" as const], maxImageBytes: "1024", maxMessageImageBytes: "2048", maxImagesPerMessage: 2, geometry: { version: 1 as const, known: true, maxWidth: 32, maxHeight: 32, maxPixels: 1024, maxFrames: 1 } });
const nativeImage = () => ({ type: "image" as const, imageId: "image", resourceId: "resource", localPath: "/private/lease", mediaType: "image/png", byteLength: "100", sha256: "a".repeat(64), validated: { mediaType: "image/png", byteLength: "100", sha256: "a".repeat(64), width: 16, height: 16, frameCount: 1 } });
beforeEach(() => { f.authorize.mockReset(); f.authorize.mockImplementation(async () => { f.order.push("authorize"); return imageCaps(); }); f.publication.mockReset(); f.query.mockReset(); f.patch.mockReset(); f.intent.mockReset(); f.adopt.mockReset(); f.current.mockReset(); f.publication.mockImplementation(() => { f.storageFault = true; return { state: "unknown", error: { code: "publication_unknown", message: "Unresolved journal transaction" } }; }); f.callbacks = null; f.options = null; f.state = "accepted"; f.revision = "1"; f.turn = null; f.actualState = false; f.storageFault = false; f.nativeClose.mockReset(); f.nativeClose.mockResolvedValue(undefined); f.journalClose.mockReset(); f.mediaClose.mockReset(); f.mediaClose.mockResolvedValue(undefined); f.order.length = 0; f.acquire.mockReset(); f.send.mockReset(); f.receipt.mockClear(); f.send.mockImplementation(async () => { f.order.push("native"); return { disposition: "started", turnId: "turn" }; }); });
const command = () => ({ sessionId: "session", claimId: "claim", executionGeneration: "2", operationId: "op", kind: "send_message", payload: { content: [{ type: "image", imageId: "image" }], expectedTurnId: null, target: { expectedNativeSessionId: "native" }, expectedImageCapabilityRevision: "7" } });
const start = async () => { const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" }); await vi.waitFor(() => expect(f.options).not.toBeNull()); f.callbacks.onConnection(true); return { running, stop: () => process.emit("SIGTERM") }; };
test("all native files are acquired before dispatch and capability is rechecked after asynchronous preparation", async () => {
  let finish!: (value: unknown) => void; const close = vi.fn(() => f.order.push("close")), retain = vi.fn(() => f.order.push("retain"));
  f.acquire.mockImplementation(() => { f.order.push("acquire"); return new Promise(resolve => { finish = resolve; }); });
  const c = await start();
  try {
    const pending = f.callbacks.onCommand(command()); await vi.waitFor(() => expect(f.acquire).toHaveBeenCalledOnce());
    expect(f.order).toEqual(["acquire"]); expect(f.send).not.toHaveBeenCalled();
    const input = { content: [nativeImage()] }; finish({ input, close, retain, verify() {} }); await pending;
    expect(f.order).toEqual(["acquire", "authorize", "dispatch", "retain", "native", "close"]);
    expect(f.send).toHaveBeenCalledWith(input, "op", null);
  } finally { c.stop(); await c.running; }
});
test("a changed capability after acquisition rejects the whole operation before native dispatch", async () => {
  const close = vi.fn(), retain = vi.fn(); f.acquire.mockImplementation(async () => { f.revision = "2"; return { input: { content: [] }, close, retain, verify() {} }; });
  const c = await start();
  try { await f.callbacks.onCommand(command()); expect(f.state).toBe("rejected"); expect(f.send).not.toHaveBeenCalled(); expect(retain).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce(); }
  finally { c.stop(); await c.running; }
});

test.each(["missing", "effective-revision", "provider-revision", "model", "native", "controls", "geometry", "message-bytes"])("service image authorization rejects %s before the dispatch marker", async failure => {
  const first = nativeImage(), second = { ...nativeImage(), imageId: "second" };
  const close = vi.fn(), retain = vi.fn();
  f.acquire.mockResolvedValue({ input: { content: [first, second] }, close, retain, verify() {} });
  const authorization = imageCaps();
  if (failure === "effective-revision") authorization.revision = "8";
  if (failure === "provider-revision") authorization.providerRevision = "2";
  if (failure === "model") authorization.modelId = "other";
  if (failure === "native") authorization.expectedNativeSessionId = "other";
  if (failure === "controls") authorization.controlsRevision = "2";
  if (failure === "geometry") second.validated.width = 33;
  if (failure === "message-bytes") authorization.maxMessageImageBytes = "199";
  f.authorize.mockResolvedValue(failure === "missing" ? undefined : authorization);
  const c = await start();
  try {
    await f.callbacks.onCommand(command());
    expect(f.state).toBe("rejected"); expect(f.send).not.toHaveBeenCalled();
    expect(retain).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce(); expect(f.order).not.toContain("dispatch");
  } finally { c.stop(); await c.running; }
});

test("text dispatch does not require service image authorization", async () => {
  f.authorize.mockResolvedValue(undefined);
  const c = await start();
  try {
    const text = command(); text.payload.content = [{ type: "text", text: "hello" }] as any;
    await f.callbacks.onCommand(text);
    expect(f.send).toHaveBeenCalledOnce(); expect(f.acquire).not.toHaveBeenCalled();
  } finally { c.stop(); await c.running; }
});

test("the production runtime state matches the shared Go wire vector while native image profiles are closed", async () => {
  f.actualState = true; const c = await start();
  try { const state = f.callbacks.readState(); expect(state).toEqual(stateVector); expect(parseControllerState(JSON.parse(JSON.stringify(state)))).toEqual(stateVector); }
  finally { c.stop(); await c.running; }
});

test("provider image qualification is published through the existing durable capability revision owner", async () => {
  f.actualState = true; const c = await start();
  try {
    const images = { expectedNativeSessionId: "native", modelId: "exact-model", controlsRevision: null, send: "supported", steer: "unsupported", reasonCode: null,
      inputMediaTypes: ["image/png"], maxImageBytes: "10485760", maxMessageImageBytes: "20971520", maxImagesPerMessage: 8,
      geometry: { version: 1, known: true, maxWidth: 4096, maxHeight: 4096, maxPixels: 16777216, maxFrames: 1 } };
    f.options.onState({ nativeSessionId: "native", activity: "idle", currentTurnId: null, capabilities: { send: true, steer: false, cancel: false, respond: false }, images });
    expect(f.callbacks.readState().providerImages).toEqual({ ...images, revision: "1" });
    f.options.onState({ nativeSessionId: "native", activity: "idle", currentTurnId: null, capabilities: { send: true, steer: false, cancel: false, respond: false }, images: { ...images, expectedNativeSessionId: "another-native" } });
    expect(f.callbacks.readState().providerImages).toMatchObject({ send: "unsupported", reasonCode: "profile_disabled" });
  } finally { c.stop(); await c.running; }
});


test("an unresolved publication transaction still closes the native provider and each independent owner", async () => {
  const c = await start();
  // Cleanup errors cannot prevent later owners from releasing their own handles.
  f.mediaClose.mockRejectedValueOnce(new Error("Controlled media close failure"));
  const result = f.options.imageRuntime.publishNativeInputAssociation({});
  expect(result.state).toBe("unknown");
  await expect(c.running).rejects.toThrow("Controlled media close failure");
  expect(f.nativeClose).toHaveBeenCalledOnce();
  expect(f.mediaClose).toHaveBeenCalledOnce();
  expect(f.journalClose).toHaveBeenCalledOnce();
  expect(f.send).not.toHaveBeenCalled();
});


test.each(["publishNativeInputAssociation", "queryNativeInputAssociation"])("%s adopts only a committed current view with verified original text", async method => {
  const entry = { entryId: "entry", entrySeq: "4", revision: "2", kind: "user_message", imageProjectionError: null, content: [{ type: "text", text: "![a](one.png)" }, { type: "image", imageId: "image", resourceId: "resource", label: "original" }] };
  const committed = { state: "committed", receipt: { identity: { operationId: "op", intentSha256: "digest" } }, view: { entry, slots: [] } };
  f.publication.mockReturnValue(committed); f.query.mockReturnValue(committed); f.current.mockReturnValue({ ...entry, revision: "3" });
  f.intent.mockReturnValue({ sha256: "digest", command: { kind: "send_message", payload: { content: [{ type: "text", text: "![a](one.png)" }] } } });
  const c = await start();
  try {
    const result = f.options.imageRuntime[method]({});
    const { entrySeq: _entrySeq, ...providerEntry } = entry;
    expect(f.adopt).toHaveBeenCalledWith(providerEntry, { complete: true, format: "markdown", truncated: false });
    expect(result.receipt).toBe(committed.receipt); expect(result.view.entry.revision).toBe("3");
    f.adopt.mockClear();
    const projected = { ...committed, view: { ...committed.view, entry: { ...entry, content: [{ type: "markdown", text: "![a](one.png)", complete: false }, entry.content[1]] } } };
    f.publication.mockReturnValue(projected); f.query.mockReturnValue(projected); f.options.imageRuntime[method]({});
    expect(f.adopt).toHaveBeenLastCalledWith(expect.objectContaining({ content: projected.view.entry.content }), { complete: true, format: "markdown", truncated: false });
    f.publication.mockReturnValue(committed); f.query.mockReturnValue(committed);
    f.adopt.mockClear(); f.intent.mockReturnValue({ sha256: "digest", command: { kind: "send_message", payload: { content: [{ type: "text", text: "different original" }] } } });
    f.options.imageRuntime[method]({}); expect(f.adopt).toHaveBeenCalledWith(providerEntry, { complete: false, format: "markdown", truncated: true });
    f.adopt.mockClear(); f.publication.mockReturnValue({ state: "unknown" }); f.query.mockReturnValue({ state: "unknown" });
    expect(f.options.imageRuntime[method]({})).toEqual({ state: "unknown" }); expect(f.adopt).not.toHaveBeenCalled();
  } finally { c.stop(); await c.running; }
});

test("native image patches synchronize the pipeline from their committed result", async () => {
  const entry = { entryId: "entry", entrySeq: "4", revision: "3", kind: "user_message", content: [] }, occurrence = { imageId: "image" }, part = { type: "image_unavailable" };
  f.patch.mockReturnValue(entry); const c = await start();
  try {
    expect(f.options.imageRuntime.patchNativeImagePart(occurrence, part)).toBe(entry);
    expect(f.patch).toHaveBeenCalledWith(occurrence, part);
    const { entrySeq: _entrySeq, ...providerEntry } = entry; expect(f.adopt).toHaveBeenCalledWith(providerEntry);
  } finally { c.stop(); await c.running; }
});
