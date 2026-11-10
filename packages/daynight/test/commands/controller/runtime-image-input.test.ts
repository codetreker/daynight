import { beforeEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import stateVector from "../../session/fixtures/runtime-image-state.json" with { type: "json" };
import { parseControllerState } from "../../../src/session/controller-protocol.js";
const f = vi.hoisted(() => ({ callbacks: null as any, options: null as any, acquire: vi.fn(), send: vi.fn(), receipt: vi.fn(), order: [] as string[], state: "accepted", revision: "1", turn: null as string | null, actualState: false }));
vi.mock("node:fs/promises", () => ({ mkdir: async () => {}, realpath: async (v: string) => v, chmod: async () => {}, unlink: async () => {} }));
vi.mock("node:net", () => ({ createServer: () => { const s: any = new EventEmitter(); s.listen = (_: unknown, cb: () => void) => queueMicrotask(cb); s.close = () => {}; return s; } }));
vi.mock("../../../src/commands/controller/launch-ticket.js", () => ({ readLaunchTicket: async () => ({ provider: "codex", cwd: process.cwd(), executionId: "execution", executionGeneration: "2", sessionId: "session", claimId: "claim", launchId: "launch", nativeHome: "/private/native", ipcEndpoint: "/private/ipc", configuration: { model: null, args: [] }, resumeNativeSessionId: null }), controllerExecutionDirectory: () => "/private/controller" }));
vi.mock("../../../src/commands/controller/process-proof.js", () => ({ captureControllerProcessProof: async () => ({ pid: 1 }), captureProcessProof: async () => ({ pid: 1 }) }));
vi.mock("../../../src/commands/controller/providers/codex.js", () => ({ openCodexProvider: async (options: unknown) => { f.options = options; return { send: f.send, close: async () => {} }; } }));
vi.mock("../../../src/commands/controller/relay.js", () => ({ createControllerRelay: (_: unknown, __: unknown, callbacks: any) => { f.callbacks = callbacks; return { flush: async () => {}, close: () => {}, connected: () => true, authorize: async () => { f.order.push("authorize"); }, receipt: f.receipt }; } }));
vi.mock("../../../src/commands/controller/lifecycle-store.js", () => ({ openControllerLifecycleStore: () => ({ reconcileNativeIndexReservation: async () => {}, listOperations: () => [], patchSnapshot: () => {}, getSnapshot: () => ({ nativeSessionId: "native", initialInputState: "confirmed", activity: "idle", currentTurnId: f.turn, capabilities: { send: true, steer: true, cancel: true, respond: true } }), providerImageCapabilities: (value: object) => f.actualState ? { ...value, revision: "1" } : ({ revision: f.revision, send: "supported", steer: "supported" }), appendEvent: () => {}, prepareOperation: () => ({ operationId: "op", kind: "send_message", state: "accepted" }), media: () => ({ acquireInput: f.acquire }), assertInputCapacity: () => {}, markDispatching: () => { f.order.push("dispatch"); f.state = "dispatching"; }, getOperation: () => ({ state: f.state }), recordOperation: (_: unknown, state: string) => { f.state = state; return { state }; }, close: () => {} }) }));
vi.mock("../../../src/config/agent-cli-aliases.js", () => ({ readAgentCliAliases: async () => ({}) }));
import { runController } from "../../../src/commands/controller/runtime.js";
beforeEach(() => { f.callbacks = null; f.options = null; f.state = "accepted"; f.revision = "1"; f.turn = null; f.actualState = false; f.order.length = 0; f.acquire.mockReset(); f.send.mockReset(); f.receipt.mockClear(); f.send.mockImplementation(async () => { f.order.push("native"); return { disposition: "started", turnId: "turn" }; }); });
const command = () => ({ sessionId: "session", claimId: "claim", executionGeneration: "2", operationId: "op", kind: "send_message", payload: { content: [{ type: "image", imageId: "image" }], expectedTurnId: null, target: { expectedNativeSessionId: "native" }, expectedImageCapabilityRevision: "1" } });
const start = async () => { const running = runController({ homeDirectory: "/private", provider: "codex", launchId: "launch" }); await vi.waitFor(() => expect(f.options).not.toBeNull()); f.callbacks.onConnection(true); return { running, stop: () => process.emit("SIGTERM") }; };
test("all native files are acquired before dispatch and capability is rechecked after asynchronous preparation", async () => {
  let finish!: (value: unknown) => void; const close = vi.fn(() => f.order.push("close")), retain = vi.fn(() => f.order.push("retain"));
  f.acquire.mockImplementation(() => { f.order.push("acquire"); return new Promise(resolve => { finish = resolve; }); });
  const c = await start();
  try {
    const pending = f.callbacks.onCommand(command()); await vi.waitFor(() => expect(f.acquire).toHaveBeenCalledOnce());
    expect(f.order).toEqual(["acquire"]); expect(f.send).not.toHaveBeenCalled();
    const input = { content: [{ type: "image", localPath: "/private/lease" }] }; finish({ input, close, retain, verify() {} }); await pending;
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
