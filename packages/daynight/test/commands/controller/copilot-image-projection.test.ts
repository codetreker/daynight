import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { DirectCaptureSubmission, ImageCaptureReceipt, ImageCaptureRequest, ImageOccurrence, ImagePart, ImageUnavailablePart, InputObservation, NativeImageSource } from "../../../src/session/image-values.js";
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
import { observeNativeInput } from "../../../src/commands/controller/recovery.js";
import type { SessionCommand, SessionResource } from "../../../src/session/protocol.js";
import type { NativeImageProjectionState, NativeInputPublicationIdentity, NativeInputPublicationRequest } from "../../../src/commands/controller/media/native-publication-types.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const fixture = async (imageCount = 1) => {
  const sessionId = randomUUID(), operationId = randomUUID(), messageId = randomUUID(), entries: ProviderEntry[] = [];
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/copilot-publication-provider"); await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "case-")), file = path.join(cwd, "journal.sqlite"), bytes = Buffer.from([1, 2, 3]);
  const image = { type: "image" as const, imageId: randomUUID(), resourceId: randomUUID(), mediaType: "image/png", byteLength: "3", sha256: createHash("sha256").update(bytes).digest("hex"), localPath: "/private/input" };
  const originals = Array.from({ length: imageCount }, (_, index) => index ? { ...image, imageId: randomUUID() } : image);
  const input: NativeInput = { content: [{ type: "text", text: "question" }, ...originals] };
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "copilot", cwd, nativeHome: path.join(cwd, ".copilot"), configuration: { agent: "copilot", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(cwd, "grant.json"), ipcEndpoint: path.join(cwd, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  let journal = openControllerLifecycleStore(file, ticket, { contentOwnedLocally: true }); journal.patchSnapshot({ nativeSessionId: sessionId });
  const resource: SessionResource = { resourceId: image.resourceId, revision: "1", status: "available", name: "original.png", mediaType: "image/png", byteLength: image.byteLength, sha256: image.sha256, width: 1, height: 1, frameCount: 1, error: null }; journal.saveResource(resource, bytes);
  const payload = { content: [{ type: "text" as const, text: "question" }, ...originals.map(image => ({ type: "image" as const, imageId: image.imageId, resourceId: image.resourceId, uploadId: randomUUID(), sha256: image.sha256, byteLength: image.byteLength }))], expectedTurnId: null, target: { serverOrigin: ticket.serverOrigin, actorUserId: ticket.userId, fence: { sessionId: ticket.sessionId, claimId: ticket.claimId!, executionGeneration: "1" }, expectedNativeSessionId: sessionId }, expectedImageCapabilityRevision: "1", draftId: randomUUID(), draftRevision: "1" };
  const command: SessionCommand = { protocol: "daynight.session.v1", contentRevision: 2, requestId: randomUUID(), operationId, sessionId: ticket.sessionId, claimId: ticket.claimId!, executionGeneration: "1", kind: "send_message", payload };
  journal.prepareOperation({ operationId, kind: "send_message", payload, intent: command }); journal.markDispatching(operationId);
  const requests = new Map<string, ImageCaptureRequest>();
  const receipt = (id: string, state: ImageCaptureReceipt["state"]): ImageCaptureReceipt => {
    const request = requests.get(id)!;
    return { captureId: id, attemptId: request.attemptId, revision: "1", occurrence: request.occurrence, state, resourceId: request.locator.kind === "resource" ? request.locator.resourceId : image.resourceId, resource: null, error: state === "failed" ? { code: "fixture_missing", message: "Fixture source is missing." } : null };
  };
  const options = {
    onTimeline: (entry: ProviderEntry) => { journal.projectTimeline(entry); entries.push(structuredClone(entry)); }, onImageOccurrence: (occurrence: ImageOccurrence, source: NativeImageSource | null) => journal.registerImageOccurrence(occurrence, source).acknowledged, imageOccurrenceAcknowledged: (imageId: string) => journal.imageOccurrenceAcknowledged(imageId),
    imageRuntime: { getIntent: (id: string) => { const intent = journal.getInputIntent(id), operation = journal.getOperation(id); return intent && operation ? { sha256: intent.sha256, command: JSON.parse(intent.canonical), state: operation.state } : null; }, readState: (key: string) => journal.readNativeImageState(key), writeState: (key: string, value: unknown) => journal.writeNativeImageState(key, value), publishNativeInputAssociation: (request: NativeInputPublicationRequest) => journal.publishNativeInputAssociation(request), queryNativeInputAssociation: (identity: NativeInputPublicationIdentity) => journal.queryNativeInputAssociation(identity), patchNativeImagePart: (occurrence: ImageOccurrence, part: ImagePart | ImageUnavailablePart) => journal.patchNativeImagePart(occurrence, part) },
    onInputObserved: vi.fn((observation: string | InputObservation) => observeNativeInput(journal, observation)),
    prepareImageCapture: vi.fn(async (request: ImageCaptureRequest) => { journal.registerImageCaptureRequest(request); requests.set(request.captureId, request); }),
    queryImageCapture: vi.fn(async (id: string) => receipt(id, "committed")),
    stageImageCapture: vi.fn(async () => ({ mediaType: "image/png", byteLength: "3", sha256: "a".repeat(64), width: 1, height: 1, frameCount: 1 })),
    submitImageCapture: vi.fn(async (input: DirectCaptureSubmission) => input.outcome.kind === "failed" ? { ...receipt(input.request.captureId, "failed"), resourceId: null, error: input.outcome.error } : receipt(input.request.captureId, "committed")),
  } as unknown as ProviderOptions;
  const inputs = new CopilotImageInputs(options, sessionId), images = new CopilotImages(options, sessionId, inputs), projection = new CopilotProjection(sessionId, options.onTimeline, images);
  cleanups.push(async () => { await images.close(); journal.close(); await rm(cwd, { recursive: true, force: true }); });
  const marker = () => { const marker = { kind: "copilot_bridge_image", path: "/private/bridge", byteLength: "3", sha256: "a".repeat(64), mediaType: "image/png" }; bridge.brands.add(marker); return marker; };
  const event = (attachment?: unknown) => ({ id: messageId, type: "user.message", data: { content: "question", attachments: attachment === undefined ? Array.from({ length: imageCount }, () => ({ type: "blob", mimeType: "image/png", data: marker() })) : [attachment] } });
  return { images, inputs, projection, options, input, image, entries, sessionId, operationId, messageId, event, marker, get journal() { return journal; }, timeline: () => journal.readTimeline({ historyEpoch: "epoch", direction: "tail", cursor: null, limit: 10 }).items, reopen: () => { journal.close(); journal = openControllerLifecycleStore(file, ticket, { contentOwnedLocally: true }); }, acknowledge: () => { journal.acknowledgeEvents(journal.getLastSourceSequence()); images.acknowledge(); } };
};
test("receipt-first input reuses original image identity and does not stage a duplicate native blob", async () => {
  const f = await fixture(), publish = vi.spyOn(f.options.imageRuntime!, "publishNativeInputAssociation");
  try {
    f.inputs.prepare(f.input, f.operationId, null); f.inputs.accept(f.operationId, f.messageId); f.projection.accept(f.event());
    expect(publish.mock.results[0]?.value.state, JSON.stringify({ result: publish.mock.results[0]?.value, request: publish.mock.calls[0]?.[0] })).toBe("committed");
    await f.images.settled(); expect(f.options.prepareImageCapture).not.toHaveBeenCalled();
    f.acknowledge(); await f.images.settled();
    expect(f.timeline()[0]).toMatchObject({ content: [{ type: "text", text: "question" }, { type: "image", imageId: f.image.imageId, resourceId: f.image.resourceId }] });
    expect(f.options.stageImageCapture).not.toHaveBeenCalled();
  } finally { await f.images.close(); }
});
test.each(["text", "mime", "attachments"] as const)("an accepted input with mismatched %s still publishes its native message without associating originals", async mismatch => {
  const f = await fixture(), publish = vi.spyOn(f.options.imageRuntime!, "publishNativeInputAssociation");
  f.inputs.prepare(f.input, f.operationId, null); f.inputs.accept(f.operationId, f.messageId);
  const event = f.event();
  if (mismatch === "text") event.data.content = "different native text";
  if (mismatch === "mime") (event.data.attachments[0] as { mimeType: string }).mimeType = "image/jpeg";
  if (mismatch === "attachments") event.data.attachments = [];
  f.projection.accept(event); await f.images.settled();
  expect(f.timeline()).toHaveLength(1);
  expect(f.timeline()[0]).toMatchObject({ kind: "user_message", content: [{ text: event.data.content }, ...(mismatch === "attachments" ? [] : [{ type: "image_unavailable" }])] });
  expect(f.timeline()[0]).not.toMatchObject({ content: expect.arrayContaining([expect.objectContaining({ imageId: f.image.imageId })]) });
  expect(publish).not.toHaveBeenCalled(); expect(f.inputs.profileAllowed).toBe(false);
  f.acknowledge(); await f.images.settled();
  expect(f.timeline()[0]).not.toMatchObject({ content: expect.arrayContaining([expect.objectContaining({ imageId: f.image.imageId })]) });
});

test("an uncertain association for mismatched native text falls back only after the shared owner confirms absence", async () => {
  const f = await fixture(), publish = vi.spyOn(f.options.imageRuntime!, "publishNativeInputAssociation");
  const query = vi.spyOn(f.options.imageRuntime!, "queryNativeInputAssociation").mockReturnValue({ state: "unknown", error: { code: "publication_unknown", message: "Controlled query failure" } });
  f.inputs.prepare(f.input, f.operationId, null); const match = f.inputs.accept(f.operationId, f.messageId);
  const event = f.event(); event.data.content = "different native text";
  f.projection.accept(event); await f.images.settled(); expect(f.timeline()).toEqual([]);
  query.mockRestore(); f.images.accepted(match); await f.images.settled();
  expect(f.timeline()[0]).toMatchObject({ content: [{ text: "different native text" }, { type: "image_unavailable" }] });
  f.acknowledge(); await f.images.settled();
  expect(f.timeline()[0]).toMatchObject({ content: [{ text: "different native text" }, { type: "image" }] });
  expect(publish).not.toHaveBeenCalled(); expect(f.inputs.profileAllowed).toBe(false);
  expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
});

test.each(["before", "after"] as const)("publication intent write failure %s commit retains its native lease for cleanup retry", async boundary => {
  const f = await fixture(), write = f.options.imageRuntime!.writeState, publish = vi.spyOn(f.options.imageRuntime!, "publishNativeInputAssociation");
  const failure = new Error("Controlled publication intent write failure"), releaseFailure = new Error("Controlled native lease removal failure");
  f.inputs.prepare(f.input, f.operationId, null); f.inputs.accept(f.operationId, f.messageId);
  f.options.imageRuntime!.writeState = (key, value) => {
    if (value && typeof value === "object" && "publicationIntent" in value) {
      if (boundary === "after") write(key, value);
      throw failure;
    }
    write(key, value);
  };
  bridge.retained.mockClear();
  try {
    expect(() => f.projection.accept(f.event())).toThrow(failure);
    expect(publish).not.toHaveBeenCalled(); expect(f.timeline()).toEqual([]);
    bridge.retained.mockImplementationOnce(() => { throw releaseFailure; });
    await expect(f.images.close()).rejects.toBe(releaseFailure);
    expect(bridge.retained).toHaveBeenCalledOnce();
    await f.images.close(); expect(bridge.retained).toHaveBeenCalledTimes(2);
    await f.images.close(); expect(bridge.retained).toHaveBeenCalledTimes(2);
  } finally { bridge.retained.mockReset(); await f.images.close(); }
});

test.each(["read", "write", "index"] as const)("mismatched native fallback retains its lease when %s preparation fails", async boundary => {
  const f = await fixture(), runtime = f.options.imageRuntime!, read = runtime.readState, write = runtime.writeState;
  const failure = new Error("Controlled native fallback preparation failure"), releaseFailure = new Error("Controlled fallback lease removal failure");
  f.inputs.prepare(f.input, f.operationId, null); f.inputs.accept(f.operationId, f.messageId);
  let publishedReads = 0;
  runtime.readState = key => {
    if (boundary === "read" && key.startsWith("copilot:published:") && ++publishedReads === 2) throw failure;
    return read(key);
  };
  runtime.writeState = (key, value) => {
    if (boundary === "write" && key.startsWith("copilot:published:") || boundary === "index" && key.startsWith("copilot:pending:")) throw failure;
    write(key, value);
  };
  const event = f.event(); event.data.content = "different native text"; bridge.retained.mockClear();
  try {
    expect(() => f.projection.accept(event)).toThrow(failure); expect(f.timeline()).toEqual([]);
    bridge.retained.mockImplementationOnce(() => { throw releaseFailure; });
    await expect(f.images.close()).rejects.toBe(releaseFailure);
    expect(bridge.retained).toHaveBeenCalledOnce();
    await f.images.close(); expect(bridge.retained).toHaveBeenCalledTimes(2);
  } finally { bridge.retained.mockReset(); await f.images.close(); }
});

test.each(["read", "write", "index"] as const)("unassociated native %s preparation failure releases every lease and retries failed removal on close", async boundary => {
  const f = await fixture(), runtime = f.options.imageRuntime!, read = runtime.readState, write = runtime.writeState;
  const failure = new Error("Controlled native preparation failure"), releaseFailure = new Error("Controlled native removal failure");
  runtime.readState = key => { if (boundary === "read" && key.startsWith("copilot:published:")) throw failure; return read(key); };
  runtime.writeState = (key, value) => {
    if (boundary === "write" && key.startsWith("copilot:published:") || boundary === "index" && key.startsWith("copilot:pending:")) throw failure;
    write(key, value);
  };
  const event = f.event(); event.data.attachments.push({ type: "blob", mimeType: "image/png", data: f.marker() });
  bridge.retained.mockClear(); bridge.retained.mockImplementationOnce(() => { throw releaseFailure; });
  try {
    expect(() => f.projection.accept(event)).toThrow("Native image preparation and release failed.");
    expect(f.timeline()).toEqual([]); expect(bridge.retained).toHaveBeenCalledTimes(2);
    await f.images.close(); expect(bridge.retained).toHaveBeenCalledTimes(3);
    await f.images.close(); expect(bridge.retained).toHaveBeenCalledTimes(3);
  } finally { bridge.retained.mockReset(); await f.images.close(); }
});

test.each(["read", "write"] as const)("receipt-first source %s failure on the second image retains the first lease until removal succeeds", async boundary => {
  const f = await fixture(2), runtime = f.options.imageRuntime!, read = runtime.readState, write = runtime.writeState;
  f.inputs.prepare(f.input, f.operationId, null); f.inputs.accept(f.operationId, f.messageId);
  const failure = new Error("Controlled second source identity failure"), releaseFailure = new Error("Controlled first image removal failure");
  let sources = 0;
  runtime.readState = key => {
    if (boundary === "read" && key.startsWith("copilot:source:") && ++sources === 2) throw failure;
    return read(key);
  };
  runtime.writeState = (key, value) => {
    if (boundary === "write" && key.startsWith("copilot:source:") && ++sources === 2) throw failure;
    write(key, value);
  };
  bridge.retained.mockClear(); bridge.retained.mockImplementationOnce(() => { throw releaseFailure; });
  try {
    expect(() => f.projection.accept(f.event())).toThrow("Native image preparation and release failed.");
    expect(f.timeline()).toEqual([]); expect(bridge.retained).toHaveBeenCalledOnce();
    await f.images.close(); expect(bridge.retained).toHaveBeenCalledTimes(2);
    await f.images.close(); expect(bridge.retained).toHaveBeenCalledTimes(2);
  } finally { bridge.retained.mockReset(); await f.images.close(); }
});

test("an old native capture preserves original slots committed before the publication result was adopted", async () => {
  const f = await fixture(), publishOriginal = f.options.imageRuntime!.publishNativeInputAssociation!, submitOriginal = vi.mocked(f.options.submitImageCapture!).getMockImplementation()!;
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  vi.mocked(f.options.submitImageCapture!).mockImplementation(async (...args) => { entered.resolve(); await finish.promise; return submitOriginal(...args); });
  const publish = vi.spyOn(f.options.imageRuntime!, "publishNativeInputAssociation").mockImplementation(request => {
    const result = publishOriginal(request); expect(result.state, JSON.stringify(result)).toBe("committed");
    throw new Error("Controlled publication response loss after commit");
  });
  try {
    f.inputs.prepare(f.input, f.operationId, null); f.projection.accept(f.event()); f.acknowledge(); await entered.promise;
    const native = (f.timeline()[0] as Extract<ProviderEntry, { kind: "user_message" | "assistant_message" }>).content[1]!;
    f.images.accepted(f.inputs.accept(f.operationId, f.messageId));
    expect(f.timeline()[0]).toMatchObject({ content: [{ text: "question" }, native, { type: "image", imageId: f.image.imageId }] });
    finish.resolve(); await f.images.settled();
    expect(f.timeline()[0]).toMatchObject({ content: [{ text: "question" }, { type: "image", imageId: "imageId" in native ? native.imageId : "" }, { type: "image", imageId: f.image.imageId, resourceId: f.image.resourceId }] });
    const committed = f.inputs.publication(f.messageId); expect(committed?.state).toBe("committed");
    if (committed?.state !== "committed") throw new Error("Shared publication did not commit.");
    const nativeState = f.journal.readNativeImageState(committed.view.slots[0]!.key) as NativeImageProjectionState;
    expect(nativeState).toMatchObject({ phase: "settled", part: { type: "image", resourceId: f.image.resourceId } });
    expect(publish).toHaveBeenCalledOnce(); expect(f.options.prepareImageCapture).toHaveBeenCalledOnce(); expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
  } finally { finish.resolve(); await f.images.close(); }
});

test("public-first native bytes retain their slot and late acceptance appends original images once", async () => {
  const f = await fixture(), publish = vi.spyOn(f.options.imageRuntime!, "publishNativeInputAssociation");
  try {
    f.inputs.prepare(f.input, f.operationId, null); f.projection.accept(f.event()); f.acknowledge(); await f.images.settled();
    const native = (f.timeline().at(-1) as any).content[1]; expect(native.imageId).not.toBe(f.image.imageId);
    const match = f.inputs.accept(f.operationId, f.messageId); f.images.accepted(match); await f.images.settled();
    expect(publish.mock.results[0]?.value.state, JSON.stringify({ result: publish.mock.results[0]?.value, request: publish.mock.calls[0]?.[0] })).toBe("committed");
    const entry = f.timeline()[0] as any; expect(entry.content).toHaveLength(3); expect(entry.content[1]).toMatchObject(native); expect(entry.content[2]).toMatchObject({ type: "image", imageId: f.image.imageId, resourceId: f.image.resourceId });
    f.images.accepted(match); await f.images.settled(); expect((f.timeline()[0] as any).content).toHaveLength(3); expect(publish).toHaveBeenCalledOnce();
    expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
  } finally { await f.images.close(); }
});
test("a referenced asset waits for bytes, preserves the original owner and never creates an assistant row", async () => {
  const f = await fixture(), assetId = `sha256:${"a".repeat(64)}`;
  try {
    f.projection.accept(f.event({ type: "blob", mimeType: "image/png", assetId, byteLength: 3 })); f.acknowledge(); await f.images.settled();
    const first = (f.timeline().at(-1) as any).content[1].imageId;
    expect(f.options.prepareImageCapture).not.toHaveBeenCalled();
    f.projection.accept({ type: "session.binary_asset", id: "asset-event", data: { assetId, mimeType: "image/png", byteLength: 3, data: f.marker() } }); await f.images.settled();
    expect((f.timeline().at(-1) as any).content[1]).toMatchObject({ type: "image", imageId: first });
    expect(f.entries.every(entry => entry.kind === "user_message")).toBe(true);
  } finally { await f.images.close(); }
});
test("tool contents preserve text/image order, failure and subagent ownership without guessing structured media", async () => {
  const f = await fixture();
  try {
    f.projection.accept({ type: "tool.execution_start", id: "start", agentId: "child", data: { toolCallId: "tool", toolName: "inspect" } });
    f.projection.accept({ type: "tool.execution_complete", id: "complete", agentId: "child", data: { toolCallId: "tool", success: false, error: { message: "failed" }, result: { contents: [{ type: "text", text: "before" }, { type: "image", mimeType: "image/png", data: f.marker() }, { type: "text", text: "after" }], structuredContent: { type: "image", data: "ordinary structured output" } } } });
    f.acknowledge(); await f.images.settled();
    expect(f.timeline().at(-1)).toMatchObject({ kind: "tool_call", status: "failed", name: "[Subagent child] inspect", output: [{ text: "failed" }, { text: "before" }, { type: "image" }, { text: "after" }, { type: "text" }] });
    expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
  } finally { await f.images.close(); }
});

test("an explicit same-asset tool mirror releases its independent transfer without staging a second image", async () => {
  const f = await fixture(), primary = f.marker(), mirror = f.marker();
  try {
    f.projection.accept({ type: "tool.execution_complete", id: "complete", data: { toolCallId: "tool", success: true, result: {
      contents: [{ type: "image", assetId: "same-asset", mimeType: "image/png", data: primary }],
      binaryResultsForLlm: [{ type: "image", assetId: "same-asset", mimeType: "image/png", data: mirror }],
    } } });
    f.acknowledge(); await f.images.settled();
    expect(bridge.releases.mock.calls.filter(([value]) => value === mirror)).toHaveLength(1);
    expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
    expect((f.timeline().at(-1) as any).output).toHaveLength(1);
  } finally { await f.images.close(); }
});

test("failed mirror removal releases earlier unsubmitted tool-image readers and preserves the removal error", async () => {
  const f = await fixture(), primary = f.marker(), mirror = f.marker(), failure = new Error("Fixture mirror removal failed");
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
  const f = await fixture(), failure = new Error("Fixture retained lease removal failed");
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
  const f = await fixture(); f.projection.accept(f.event()); await f.images.settled();
  const first = (f.timeline().at(-1) as any).content[1].imageId;
  expect(f.images.requiresReplay()).toBe(true); await f.images.close();
  const reopened = new CopilotImages(f.options, f.sessionId, f.inputs), projection = new CopilotProjection(f.sessionId, f.options.onTimeline, reopened);
  try {
    expect(reopened.requiresReplay()).toBe(true); projection.accept(f.event()); f.acknowledge(); reopened.acknowledge(); await reopened.settled();
    expect((f.timeline().at(-1) as any).content[1]).toMatchObject({ type: "image", imageId: first });
    expect(reopened.requiresReplay()).toBe(false); expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
  } finally { await reopened.close(); }
});

test("native repeated text blocks retain their positions around an image", async () => {
  const f = await fixture();
  try {
    f.projection.accept({ type: "tool.execution_complete", id: "complete", data: { toolCallId: "tool", success: true, result: { contents: [{ type: "text", text: "repeat" }, { type: "image", mimeType: "image/png", data: f.marker() }, { type: "text", text: "repeat" }] } } });
    f.acknowledge(); await f.images.settled();
    expect(f.timeline().at(-1)).toMatchObject({ output: [{ type: "text", text: "repeat" }, { type: "image" }, { type: "text", text: "repeat" }] });
  } finally { await f.images.close(); }
});

test("a content-addressed asset digest conflict cannot become readable media", async () => {
  const f = await fixture(), assetId = `sha256:${"b".repeat(64)}`;
  try {
    f.projection.accept(f.event({ type: "blob", mimeType: "image/png", assetId, byteLength: 3 })); f.acknowledge(); await f.images.settled();
    f.projection.accept({ type: "session.binary_asset", id: "asset-event", data: { assetId, mimeType: "image/png", byteLength: 3, data: f.marker() } }); await f.images.settled();
    expect(f.options.stageImageCapture).not.toHaveBeenCalled(); expect(f.options.submitImageCapture).toHaveBeenCalledWith(expect.objectContaining({ outcome: { kind: "failed", error: expect.objectContaining({ code: "asset_identity_conflict" }) } }));
  } finally { await f.images.close(); }
});

test("an asset identity conflict remains unavailable after a repeated original event and reopen", async () => {
  const f = await fixture(), assetId = "opaque-native-asset";
  const asset = (marker: unknown) => ({ type: "session.binary_asset", id: randomUUID(), data: { assetId, mimeType: "image/png", byteLength: 3, data: marker } });
  const other = { ...f.marker(), sha256: "b".repeat(64) }; bridge.brands.add(other);
  try {
    f.projection.accept(asset(f.marker())); f.projection.accept(asset(other)); f.projection.accept(asset(f.marker()));
    f.projection.accept(f.event({ type: "blob", mimeType: "image/png", assetId, byteLength: 3 })); f.acknowledge(); await f.images.settled();
    expect(f.options.stageImageCapture).not.toHaveBeenCalled();
    expect(f.timeline().at(-1)).toMatchObject({ content: [{ type: "text" }, { type: "image_unavailable" }] });
  } finally { await f.images.close(); }
  const reopened = new CopilotImages(f.options, f.sessionId, f.inputs), projection = new CopilotProjection(f.sessionId, f.options.onTimeline, reopened);
  try {
    projection.accept(asset(f.marker()));
    projection.accept({ ...f.event({ type: "blob", mimeType: "image/png", assetId, byteLength: 3 }), id: randomUUID() }); reopened.acknowledge(); await reopened.settled();
    expect(f.options.stageImageCapture).not.toHaveBeenCalled();
    expect(f.options.submitImageCapture).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: { kind: "failed", error: expect.objectContaining({ code: "asset_identity_conflict" }) } }));
  } finally { await reopened.close(); }
});

test.each(["before", "after"] as const)("publication result loss %s commit queries the original identity before any retry", async boundary => {
  const f = await fixture(), publishOriginal = f.options.imageRuntime!.publishNativeInputAssociation!, timeline = vi.spyOn(f.options, "onTimeline"), occurrence = vi.spyOn(f.options, "onImageOccurrence");
  const unknown = { state: "unknown" as const, error: { code: "publication_unknown" as const, message: "Controlled publication result loss" } };
  const publish = vi.spyOn(f.options.imageRuntime!, "publishNativeInputAssociation").mockImplementation(request => {
    if (boundary === "after") { const committed = publishOriginal(request); expect(committed.state, JSON.stringify(committed)).toBe("committed"); throw new Error("Controlled lost result after commit"); }
    return unknown;
  });
  bridge.retained.mockClear(); f.inputs.prepare(f.input, f.operationId, null); const match = f.inputs.accept(f.operationId, f.messageId);
  try {
    f.projection.accept(f.event()); await f.images.settled(); expect(publish).toHaveBeenCalledOnce();
    const request = structuredClone(publish.mock.calls[0]![0]);
    expect(bridge.retained).not.toHaveBeenCalled(); expect(timeline).not.toHaveBeenCalled(); expect(occurrence).not.toHaveBeenCalled();
    const query = vi.spyOn(f.options.imageRuntime!, "queryNativeInputAssociation").mockReturnValue(unknown);
    f.images.accepted(match); expect(query).toHaveBeenLastCalledWith(request.identity); expect(publish).toHaveBeenCalledOnce();
    query.mockRestore(); publish.mockImplementation(publishOriginal); f.images.accepted(match); await f.images.settled();
    expect(publish).toHaveBeenCalledTimes(boundary === "after" ? 1 : 2);
    if (boundary === "before") expect(publish.mock.calls[1]![0]).toEqual(request);
    expect(f.inputs.publication(f.messageId)).toMatchObject({ state: "committed" });
    expect(f.timeline()[0]).toMatchObject({ content: [{ text: "question" }, { type: "image", imageId: f.image.imageId, resourceId: f.image.resourceId }] });
    expect(timeline).not.toHaveBeenCalled(); expect(occurrence).not.toHaveBeenCalled(); expect(f.options.prepareImageCapture).not.toHaveBeenCalled();
    f.acknowledge(); await f.images.settled(); expect(f.options.prepareImageCapture).toHaveBeenCalledOnce(); expect(f.options.stageImageCapture).not.toHaveBeenCalled();
    expect(bridge.retained).toHaveBeenCalledOnce(); expect(f.inputs.pendingAccepted()).toEqual([]);
  } finally { await f.images.close(); }
});

test("journal reopen adopts the latest capture view without replaying publication or shrinking original slots", async () => {
  const f = await fixture(); f.inputs.prepare(f.input, f.operationId, null); f.projection.accept(f.event());
  f.images.accepted(f.inputs.accept(f.operationId, f.messageId));
  const publication = f.inputs.publication(f.messageId); expect(publication?.state).toBe("committed");
  if (!publication || publication.state !== "committed") throw new Error("Shared publication did not commit.");
  f.acknowledge(); await f.images.settled(); const current = f.timeline()[0]!;
  expect(current).toMatchObject({ content: [{ text: "question" }, { type: "image" }, { type: "image", imageId: f.image.imageId, resourceId: f.image.resourceId }] });
  expect(BigInt(current.revision)).toBeGreaterThan(BigInt(publication.receipt.publicationRevision));
  await f.images.close(); f.reopen();
  const inputs = new CopilotImageInputs(f.options, f.sessionId), images = new CopilotImages(f.options, f.sessionId, inputs), projection = new CopilotProjection(f.sessionId, f.options.onTimeline, images);
  const publish = vi.spyOn(f.options.imageRuntime!, "publishNativeInputAssociation"), timeline = vi.spyOn(f.options, "onTimeline"), occurrence = vi.spyOn(f.options, "onImageOccurrence");
  try {
    for (const match of inputs.restoreAccepted()) images.accepted(match); await images.settled();
    expect(inputs.publication(f.messageId)).toMatchObject({ state: "committed", receipt: publication.receipt, view: { entry: current } });
    projection.accept(f.event()); await images.settled();
    expect(f.timeline()).toEqual([current]); expect(publish).not.toHaveBeenCalled(); expect(timeline).not.toHaveBeenCalled(); expect(occurrence).not.toHaveBeenCalled();
    expect(f.options.stageImageCapture).toHaveBeenCalledOnce(); expect(inputs.pendingAccepted()).toEqual([]);
  } finally { await images.close(); }
});
