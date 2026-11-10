import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type { ImageCaptureReceipt, ImageCaptureRequest } from "../../../src/session/image-values.js";
import type { NativeInput, ProviderEntry, ProviderOptions } from "../../../src/commands/controller/providers/types.js";
const bridge = vi.hoisted(() => ({ brands: new WeakSet<object>(), releases: vi.fn(), retained: vi.fn() }));
vi.mock("../../../src/commands/controller/providers/copilot-bridge.js", () => ({
  isCopilotBridgeImage: (value: unknown) => value !== null && typeof value === "object" && bridge.brands.has(value),
  releaseCopilotBridgeImage: bridge.releases, retainCopilotBridgeImage: () => bridge.retained,
}));
import { CopilotImages } from "../../../src/commands/controller/providers/copilot-images.js";
import { CopilotImageInputs } from "../../../src/commands/controller/providers/copilot-image-input.js";
import { CopilotProjection } from "../../../src/commands/controller/providers/copilot-projection.js";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";

const fixture = () => {
  const sessionId = randomUUID(), operationId = randomUUID(), messageId = randomUUID(), entries: ProviderEntry[] = [], states = new Map<string, unknown>();
  const image = { type: "image" as const, imageId: randomUUID(), resourceId: randomUUID(), mediaType: "image/png", byteLength: "3", sha256: "a".repeat(64), localPath: "/private/input" };
  const input: NativeInput = { content: [{ type: "text", text: "question" }, image] };
  const intent: any = { sha256: "b".repeat(64), command: { kind: "send_message", operationId, payload: { expectedTurnId: null, target: { expectedNativeSessionId: sessionId }, content: input.content } } };
  const requests = new Map<string, ImageCaptureRequest>(); let acknowledged = false;
  const receipt = (id: string, state: ImageCaptureReceipt["state"]): ImageCaptureReceipt => {
    const request = requests.get(id)!;
    return { captureId: id, attemptId: request.attemptId, revision: "1", occurrence: request.occurrence, state, resourceId: request.locator.kind === "resource" ? request.locator.resourceId : image.resourceId, resource: null, error: state === "failed" ? { code: "fixture_missing", message: "Fixture source is missing." } : null };
  };
  const options = {
    onTimeline: (entry: ProviderEntry) => entries.push(structuredClone(entry)), onImageOccurrence: () => true, imageOccurrenceAcknowledged: () => acknowledged,
    imageRuntime: { getIntent: (id: string) => id === operationId ? intent : null, readState: (key: string) => states.get(key) ?? null, writeState: (key: string, value: unknown) => states.set(key, structuredClone(value)) },
    onInputObserved: vi.fn(() => true),
    registerImageCapture: vi.fn(async (request: ImageCaptureRequest) => { requests.set(request.captureId, request); return receipt(request.captureId, request.locator.kind === "resource" ? "committed" : "reserved"); }),
    queryImageCapture: vi.fn(async (id: string) => receipt(id, "committed")),
    stageImageCapture: vi.fn(async () => ({ mediaType: "image/png", byteLength: "3", sha256: "a".repeat(64), width: 1, height: 1, frameCount: 1 })),
    commitImageCapture: vi.fn(async (id: string) => receipt(id, "committed")), failImageCapture: vi.fn(async (id: string) => receipt(id, "failed")),
  } as unknown as ProviderOptions;
  const inputs = new CopilotImageInputs(options, sessionId), images = new CopilotImages(options, sessionId, inputs), projection = new CopilotProjection(sessionId, options.onTimeline, images);
  const marker = () => { const marker = { kind: "copilot_bridge_image", path: "/private/bridge", byteLength: "3", sha256: "a".repeat(64), mediaType: "image/png" }; bridge.brands.add(marker); return marker; };
  const event = (attachment: unknown = { type: "blob", mimeType: "image/png", data: marker() }) => ({ id: messageId, type: "user.message", data: { content: "question", attachments: [attachment] } });
  return { images, inputs, projection, options, input, image, entries, states, sessionId, operationId, messageId, event, marker, acknowledge: () => { acknowledged = true; images.acknowledge(); } };
};
test("receipt-first input reuses original image identity and does not stage a duplicate native blob", async () => {
  const f = fixture();
  try {
    f.inputs.prepare(f.input, f.operationId, null); f.inputs.accept(f.operationId, f.messageId); f.projection.accept(f.event());
    await f.images.settled(); expect(f.options.registerImageCapture).not.toHaveBeenCalled();
    f.acknowledge(); await f.images.settled();
    expect(f.entries.at(-1)).toMatchObject({ content: [{ type: "text", text: "question" }, { type: "image", imageId: f.image.imageId, resourceId: f.image.resourceId }] });
    expect(f.options.stageImageCapture).not.toHaveBeenCalled();
  } finally { await f.images.close(); }
});
test("public-first native bytes retain their slot and late acceptance appends original images once", async () => {
  const f = fixture();
  try {
    f.inputs.prepare(f.input, f.operationId, null); f.projection.accept(f.event()); f.acknowledge(); await f.images.settled();
    const native = (f.entries.at(-1) as any).content[1]; expect(native.imageId).not.toBe(f.image.imageId);
    const match = f.inputs.accept(f.operationId, f.messageId); f.images.accepted(match); await f.images.settled();
    const entry = f.entries.at(-1) as any; expect(entry.content).toHaveLength(3); expect(entry.content[1]).toMatchObject(native); expect(entry.content[2]).toMatchObject({ type: "image", imageId: f.image.imageId, resourceId: f.image.resourceId });
    f.images.accepted(match); await f.images.settled(); expect((f.entries.at(-1) as any).content).toHaveLength(3);
    expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
  } finally { await f.images.close(); }
});
test("a referenced asset waits for bytes, preserves the original owner and never creates an assistant row", async () => {
  const f = fixture(), assetId = `sha256:${"a".repeat(64)}`;
  try {
    f.projection.accept(f.event({ type: "blob", mimeType: "image/png", assetId, byteLength: 3 })); f.acknowledge(); await f.images.settled();
    const first = (f.entries.at(-1) as any).content[1].imageId;
    expect(f.options.registerImageCapture).not.toHaveBeenCalled();
    f.projection.accept({ type: "session.binary_asset", id: "asset-event", data: { assetId, mimeType: "image/png", byteLength: 3, data: f.marker() } }); await f.images.settled();
    expect((f.entries.at(-1) as any).content[1]).toMatchObject({ type: "image", imageId: first });
    expect(f.entries.every(entry => entry.kind === "user_message")).toBe(true);
  } finally { await f.images.close(); }
});
test("tool contents preserve text/image order, failure and subagent ownership without guessing structured media", async () => {
  const f = fixture();
  try {
    f.projection.accept({ type: "tool.execution_start", id: "start", agentId: "child", data: { toolCallId: "tool", toolName: "inspect" } });
    f.projection.accept({ type: "tool.execution_complete", id: "complete", agentId: "child", data: { toolCallId: "tool", success: false, error: { message: "failed" }, result: { contents: [{ type: "text", text: "before" }, { type: "image", mimeType: "image/png", data: f.marker() }, { type: "text", text: "after" }], structuredContent: { type: "image", data: "ordinary structured output" } } } });
    f.acknowledge(); await f.images.settled();
    expect(f.entries.at(-1)).toMatchObject({ kind: "tool_call", status: "failed", name: "[Subagent child] inspect", output: [{ text: "failed" }, { text: "before" }, { type: "image" }, { text: "after" }, { type: "text" }] });
    expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
  } finally { await f.images.close(); }
});

test("an explicit same-asset tool mirror releases its independent transfer without staging a second image", async () => {
  const f = fixture(), primary = f.marker(), mirror = f.marker();
  try {
    f.projection.accept({ type: "tool.execution_complete", id: "complete", data: { toolCallId: "tool", success: true, result: {
      contents: [{ type: "image", assetId: "same-asset", mimeType: "image/png", data: primary }],
      binaryResultsForLlm: [{ type: "image", assetId: "same-asset", mimeType: "image/png", data: mirror }],
    } } });
    f.acknowledge(); await f.images.settled();
    expect(bridge.releases.mock.calls.filter(([value]) => value === mirror)).toHaveLength(1);
    expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
    expect((f.entries.at(-1) as any).output).toHaveLength(1);
  } finally { await f.images.close(); }
});

test("failed mirror removal releases earlier unsubmitted tool-image readers and preserves the removal error", async () => {
  const f = fixture(), primary = f.marker(), mirror = f.marker(), failure = new Error("Fixture mirror removal failed");
  bridge.retained.mockClear(); bridge.releases.mockImplementation(value => { if (value === mirror) throw failure; });
  try {
    expect(() => f.projection.accept({ type: "tool.execution_complete", id: "complete", data: { toolCallId: "tool", success: true, result: {
      contents: [{ type: "image", assetId: "same-asset", mimeType: "image/png", data: primary }],
      binaryResultsForLlm: [{ type: "image", assetId: "same-asset", mimeType: "image/png", data: mirror }],
    } } })).toThrow(failure);
    expect(bridge.retained).toHaveBeenCalledOnce(); expect(f.options.stageImageCapture).not.toHaveBeenCalled();
  } finally { bridge.releases.mockReset(); await f.images.close(); }
});

test("Copilot image cleanup attempts all cached leases and retains a failed lease for retry", async () => {
  const f = fixture(), failure = new Error("Fixture retained lease removal failed");
  for (const assetId of ["first", "second"]) f.projection.accept({ type: "session.binary_asset", id: assetId, data: { assetId, mimeType: "image/png", byteLength: 3, data: f.marker() } });
  bridge.retained.mockClear(); bridge.retained.mockImplementationOnce(() => { throw failure; });
  try {
    await expect(f.images.close()).rejects.toBe(failure);
    expect(bridge.retained).toHaveBeenCalledTimes(2);
    await f.images.close(); expect(bridge.retained).toHaveBeenCalledTimes(3);
    await f.images.close(); expect(bridge.retained).toHaveBeenCalledTimes(3);
  } finally { bridge.retained.mockReset(); await f.images.close(); }
});

test("an unresolved capture forces a bounded history rescan after reopen and keeps its native occurrence", async () => {
  const f = fixture(); f.projection.accept(f.event()); await f.images.settled();
  const first = (f.entries.at(-1) as any).content[1].imageId;
  expect(f.images.requiresReplay()).toBe(true); await f.images.close();
  const reopened = new CopilotImages(f.options, f.sessionId, f.inputs), projection = new CopilotProjection(f.sessionId, f.options.onTimeline, reopened);
  try {
    expect(reopened.requiresReplay()).toBe(true); projection.accept(f.event()); f.acknowledge(); reopened.acknowledge(); await reopened.settled();
    expect((f.entries.at(-1) as any).content[1]).toMatchObject({ type: "image", imageId: first });
    expect(reopened.requiresReplay()).toBe(false); expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
  } finally { await reopened.close(); }
});

test("native repeated text blocks retain their positions around an image", async () => {
  const f = fixture();
  try {
    f.projection.accept({ type: "tool.execution_complete", id: "complete", data: { toolCallId: "tool", success: true, result: { contents: [{ type: "text", text: "repeat" }, { type: "image", mimeType: "image/png", data: f.marker() }, { type: "text", text: "repeat" }] } } });
    f.acknowledge(); await f.images.settled();
    expect(f.entries.at(-1)).toMatchObject({ output: [{ type: "text", text: "repeat" }, { type: "image" }, { type: "text", text: "repeat" }] });
  } finally { await f.images.close(); }
});

test("a content-addressed asset digest conflict cannot become readable media", async () => {
  const f = fixture(), assetId = `sha256:${"b".repeat(64)}`;
  try {
    f.projection.accept(f.event({ type: "blob", mimeType: "image/png", assetId, byteLength: 3 })); f.acknowledge(); await f.images.settled();
    f.projection.accept({ type: "session.binary_asset", id: "asset-event", data: { assetId, mimeType: "image/png", byteLength: 3, data: f.marker() } }); await f.images.settled();
    expect(f.options.stageImageCapture).not.toHaveBeenCalled(); expect(f.options.failImageCapture).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ code: "asset_identity_conflict" }));
  } finally { await f.images.close(); }
});

test("an asset identity conflict remains unavailable after a repeated original event and reopen", async () => {
  const f = fixture(), assetId = "opaque-native-asset";
  const asset = (marker: unknown) => ({ type: "session.binary_asset", id: randomUUID(), data: { assetId, mimeType: "image/png", byteLength: 3, data: marker } });
  const other = { ...f.marker(), sha256: "b".repeat(64) }; bridge.brands.add(other);
  try {
    f.projection.accept(asset(f.marker())); f.projection.accept(asset(other)); f.projection.accept(asset(f.marker()));
    f.projection.accept(f.event({ type: "blob", mimeType: "image/png", assetId, byteLength: 3 })); f.acknowledge(); await f.images.settled();
    expect(f.options.stageImageCapture).not.toHaveBeenCalled();
    expect(f.entries.at(-1)).toMatchObject({ content: [{ type: "text" }, { type: "image_unavailable" }] });
  } finally { await f.images.close(); }
  const reopened = new CopilotImages(f.options, f.sessionId, f.inputs), projection = new CopilotProjection(f.sessionId, f.options.onTimeline, reopened);
  try {
    projection.accept(asset(f.marker()));
    projection.accept({ ...f.event({ type: "blob", mimeType: "image/png", assetId, byteLength: 3 }), id: randomUUID() }); reopened.acknowledge(); await reopened.settled();
    expect(f.options.stageImageCapture).not.toHaveBeenCalled();
    expect(f.options.failImageCapture).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ code: "asset_identity_conflict" }));
  } finally { await reopened.close(); }
});

test.each(["plan", "timeline", "occurrence"] as const)("late original publication recovers from %s failure without changing or duplicating native slots", async boundary => {
  const f = fixture(); f.inputs.prepare(f.input, f.operationId, null); f.projection.accept(f.event()); f.acknowledge(); await f.images.settled();
  const native = structuredClone((f.entries.at(-1) as any).content[1]), before = f.entries.length;
  const match = f.inputs.accept(f.operationId, f.messageId);
  const writer = f.options.imageRuntime!.writeState;
  const failing = boundary === "plan" ? vi.spyOn(f.options.imageRuntime!, "writeState").mockImplementation((key, value) => {
    if (key.startsWith("copilot:input:") && (value as any).publication) throw new Error("Fixture publication plan failure");
    writer(key, value);
  }) : boundary === "timeline" ? vi.spyOn(f.options, "onTimeline").mockImplementation(() => { throw new Error("Fixture timeline failure"); })
    : vi.spyOn(f.options, "onImageOccurrence").mockImplementation(() => { throw new Error("Fixture occurrence failure"); });
  expect(() => f.images.accepted(match)).toThrow("Fixture");
  if (boundary !== "occurrence") expect(f.entries).toHaveLength(before);
  const publication = f.inputs.publication(f.messageId);
  if (boundary === "plan") expect(publication).toBeNull();
  else expect(publication?.slots.map(slot => slot.imageId)).toEqual([native.imageId, f.image.imageId]);
  failing.mockRestore(); await f.images.close();
  const inputs = new CopilotImageInputs(f.options, f.sessionId), reopened = new CopilotImages(f.options, f.sessionId, inputs);
  try {
    for (const restored of inputs.restoreAccepted()) reopened.accepted(restored);
    reopened.acknowledge(); await reopened.settled();
    const restored = f.entries.at(-1) as any;
    expect(restored.content).toHaveLength(3); expect(restored.content[1]).toEqual(native);
    expect(restored.content[2]).toMatchObject({ type: "image", imageId: f.image.imageId, resourceId: f.image.resourceId });
    const committed = structuredClone(inputs.publication(f.messageId));
    reopened.accepted(inputs.accept(f.operationId, f.messageId)); await reopened.settled();
    expect((f.entries.at(-1) as any).content).toHaveLength(3); expect(inputs.publication(f.messageId)).toEqual(committed);
    expect(inputs.pendingAccepted()).toEqual([]); expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
    if (publication) expect(committed).toEqual(publication);
  } finally { await reopened.close(); }
});

test("the immutable Copilot publication survives a real journal reopen and repeated materialization keeps its entry revision", async () => {
  const f = fixture(), base = path.resolve(import.meta.dirname, "../../../../../.tmp/copilot-publication-journal"); await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "case-")), file = path.join(cwd, "journal.sqlite"), historyEpoch = randomUUID();
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", testExecutionId: randomUUID(), ownerUserId: randomUUID(), provider: "copilot", cwd, nativeHome: path.join(cwd, ".copilot"), configuration: { agent: "copilot", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialInput: "none", initialPrompt: "", resumeNativeSessionId: null, credentialFile: path.join(cwd, "grant.json"), ipcEndpoint: path.join(cwd, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  let journal = openControllerLifecycleStore(file, ticket), reopened: CopilotImages | undefined;
  f.options.imageRuntime!.readState = key => journal.readNativeImageState(key);
  f.options.imageRuntime!.writeState = (key, value) => journal.writeNativeImageState(key, value);
  const publish = (entry: ProviderEntry) => { journal.projectTimeline(entry); f.entries.push(structuredClone(entry)); };
  f.options.onTimeline = publish;
  const timeline = () => journal.readTimeline({ historyEpoch, direction: "tail", cursor: null, limit: 10 }).items;
  try {
    f.inputs.prepare(f.input, f.operationId, null); f.projection.accept(f.event()); f.acknowledge(); await f.images.settled();
    const native = structuredClone((timeline()[0] as any).content[1]);
    const match = f.inputs.accept(f.operationId, f.messageId);
    f.options.onTimeline = () => { throw new Error("Fixture failure after durable plan commit"); };
    expect(() => f.images.accepted(match)).toThrow("durable plan");
    const plan = structuredClone(f.inputs.publication(f.messageId));
    expect((timeline()[0] as any).content).toHaveLength(2);
    await f.images.close(); journal.close(); journal = openControllerLifecycleStore(file, ticket); f.options.onTimeline = publish;
    const inputs = new CopilotImageInputs(f.options, f.sessionId); reopened = new CopilotImages(f.options, f.sessionId, inputs);
    for (const receipt of inputs.restoreAccepted()) reopened.accepted(receipt);
    reopened.acknowledge(); await reopened.settled();
    expect(inputs.publication(f.messageId)).toEqual(plan); expect(timeline()).toHaveLength(1);
    const restored = timeline()[0] as any;
    expect(restored.content).toHaveLength(3); expect(restored.content[1]).toEqual(native);
    expect(restored.content[2]).toMatchObject({ type: "image", imageId: f.image.imageId, resourceId: f.image.resourceId });
    reopened.accepted(inputs.accept(f.operationId, f.messageId)); await reopened.settled();
    expect(timeline()[0]).toEqual(restored);
  } finally { await reopened?.close(); await f.images.close(); journal.close(); await rm(cwd, { recursive: true, force: true }); }
});
