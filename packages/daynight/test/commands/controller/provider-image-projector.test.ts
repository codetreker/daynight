import { expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ProviderImageProjector } from "../../../src/commands/controller/providers/image-projector.js";
import { ImageCaptureNotDispatchedError, ImageCapturePrerequisiteError, ImageCaptureRequestError } from "../../../src/commands/controller/media/capture-error.js";
import type { ProviderEntry, ProviderOptions } from "../../../src/commands/controller/providers/types.js";
import type { ImageCaptureReceipt, ImageCaptureRequest, ImageOccurrence, ImagePart, ImageUnavailablePart } from "../../../src/session/image-values.js";
import { parseTimelineEntry } from "../../../src/session/protocol.js";
import type { NativeInputPublicationView, NativeImageProjectionState } from "../../../src/commands/controller/media/native-publication-types.js";

const fixture = () => {
  let acknowledged = false;
  const states = new Map<string, unknown>(), calls: string[] = [], entries: ProviderEntry[] = [];
  const resourceId = randomUUID();
  let request: ImageCaptureRequest;
  const receipt = (state: ImageCaptureReceipt["state"]): ImageCaptureReceipt => ({ captureId: request.captureId, attemptId: request.attemptId, revision: state === "committed" ? "2" : "1", occurrence: request.occurrence, state, resourceId, resource: null, error: null });
  const options = {
    onTimeline: (entry: ProviderEntry) => { calls.push("position"); entries.push(structuredClone(entry)); },
    onImageOccurrence: () => { calls.push("occurrence"); return acknowledged; }, imageOccurrenceAcknowledged: () => acknowledged,
    imageRuntime: { readState: (key: string) => states.get(key) ?? null, writeState: (key: string, value: unknown) => { states.set(key, structuredClone(value)); } },
    registerImageCapture: vi.fn(async (value: ImageCaptureRequest) => { calls.push("register"); request = value; return receipt("reserved"); }),
    queryImageCapture: vi.fn(async () => receipt("committed")),
    stageImageCapture: vi.fn(async () => { calls.push("stage"); return { mediaType: "image/png", byteLength: "3", sha256: "a".repeat(64), width: 1, height: 1, frameCount: 1 }; }),
    commitImageCapture: vi.fn(async () => { calls.push("commit"); return receipt("committed"); }),
    failImageCapture: vi.fn(async () => receipt("failed")),
  } as unknown as ProviderOptions;
  const entry: ProviderEntry = { entryId: randomUUID(), revision: "1", kind: "assistant_message", content: [{ type: "text", text: "before" }, { type: "text", text: "slot" }, { type: "text", text: "after" }] };
  const release = vi.fn();
  const slot = { index: 1, label: "Native image", native: { provider: "codex" as const, nativeSessionId: "native", nativeMessageId: "message", nativePartId: "content/1" }, payload: { kind: "file" as const, path: "/private/controlled-spool", byteLength: "3", sha256: "a".repeat(64), release } };
  return { options, states, calls, entries, entry, slot, release, resourceId, acknowledge: () => { acknowledged = true; } };
};

// Retained capture state is inspected because callback output cannot prove that
// an otherwise unreachable historical body was released.
const retainedMapValues = (projector: ProviderImageProjector): unknown[] => Object.values(projector).flatMap(value => value instanceof Map ? [...value.values()] : []);

test("text history is not retained and fallback bodies live only with active captures", async () => {
  const f = fixture(), projector = new ProviderImageProjector(f.options);
  try {
    for (let index = 0; index < 20; index++) projector.publish({ ...f.entry, entryId: randomUUID() }, [], { format: "markdown", complete: true, truncated: false });
    await projector.settled();
    expect(retainedMapValues(projector)).toEqual([]);
    projector.publish(f.entry, [f.slot], { format: "markdown", complete: true, truncated: false });
    await projector.settled();
    expect(retainedMapValues(projector)).toHaveLength(1);
    expect(retainedMapValues(projector)[0]).toMatchObject({ projection: { entry: { entryId: f.entry.entryId }, metadata: { complete: true } } });
    f.acknowledge(); projector.acknowledged(); await projector.settled();
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image", resourceId: f.resourceId }, { text: "after" }] });
    expect(retainedMapValues(projector)).toEqual([]);
    projector.publish(f.entry, [f.slot]); await projector.settled();
    expect(retainedMapValues(projector)).toEqual([]);
    expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
  } finally { await projector.close(); }
});

test("journal-owned capture retains no body and patches the current text after a later revision", async () => {
  const f = fixture();
  let current: ProviderEntry = f.entry;
  const publish = f.options.onTimeline;
  f.options.onTimeline = (entry, metadata) => { current = structuredClone(entry); publish(entry, metadata); };
  const patch = vi.fn((occurrence: ImageOccurrence, part: ImagePart | ImageUnavailablePart) => {
    if (current.kind !== "assistant_message") throw new Error("Expected current assistant body");
    current = { ...current, content: current.content.map(value => (value.type === "image" || value.type === "image_unavailable") && value.imageId === occurrence.imageId ? part : value) };
    return { ...current, entrySeq: "1" };
  });
  f.options.imageRuntime!.patchNativeImagePart = patch;
  const projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [f.slot], { format: "markdown", complete: true, truncated: false }); await projector.settled();
    expect(retainedMapValues(projector)).toHaveLength(1);
    expect(retainedMapValues(projector)[0]).toMatchObject({ projection: null });
    if (current.kind !== "assistant_message") throw new Error("Expected current assistant body");
    current = { ...current, revision: "3", content: [{ type: "text", text: "new current text" }, ...current.content.slice(1)] };
    f.acknowledge(); projector.acknowledged(); await projector.settled();
    expect(current).toMatchObject({ revision: "3", content: [{ text: "new current text" }, { type: "image", resourceId: f.resourceId }, { text: "after" }] });
    expect(patch).toHaveBeenCalledOnce();
    expect(f.entries).toHaveLength(1);
    expect(retainedMapValues(projector)).toEqual([]);
  } finally { await projector.close(); }
});

test("fallback captures for one entry share updates without reverting another image slot", async () => {
  const f = fixture(), projector = new ProviderImageProjector(f.options), release = vi.fn();
  try {
    projector.publish(f.entry, [f.slot, { ...f.slot, index: 2, native: { ...f.slot.native, nativePartId: "content/2" }, payload: { ...f.slot.payload, release } }]);
    await projector.settled();
    const retained = retainedMapValues(projector) as Array<{ projection: unknown }>;
    expect(retained).toHaveLength(2); expect(retained[0]!.projection).toBe(retained[1]!.projection);
    f.acknowledge(); projector.acknowledged(); await projector.settled();
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image", resourceId: f.resourceId }, { type: "image", resourceId: f.resourceId }] });
    expect(f.release).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
    expect(retainedMapValues(projector)).toEqual([]);
  } finally { await projector.close(); }
});

test("unchanged text publishes its Markdown completion transition", async () => {
  const f = fixture(), onTimeline = vi.fn(), projector = new ProviderImageProjector({ ...f.options, onTimeline });
  try {
    projector.publish(f.entry, [], { format: "markdown", complete: false, truncated: false });
    projector.publish(f.entry, [], { format: "markdown", complete: true, truncated: false });
    expect(onTimeline.mock.calls.map(call => call[1])).toEqual([{ format: "markdown", complete: false, truncated: false }, { format: "markdown", complete: true, truncated: false }]);
  } finally { await projector.close(); }
});

test.each([true, false])("late native capture preserves the current body's metadata (known=%s)", async known => {
  const f = fixture(), onTimeline = vi.fn(), projector = new ProviderImageProjector({ ...f.options, onTimeline });
  try {
    projector.publish(f.entry, [f.slot], { format: "markdown", complete: true, truncated: false });
    const changed = { ...f.entry, revision: "2" };
    const metadata = known ? { format: "markdown" as const, complete: false, truncated: false } : undefined;
    projector.publish(changed, [{ ...f.slot, payload: { kind: "pending" } }], metadata);
    f.acknowledge(); projector.acknowledged(); await projector.settled();
    expect(onTimeline.mock.calls.at(-1)?.[0]).toMatchObject({ revision: "2", content: [{ text: "before" }, { type: "image", resourceId: f.resourceId }, { text: "after" }] });
    expect(onTimeline.mock.calls.at(-1)?.[1]).toEqual(metadata);
  } finally { await projector.close(); }
});

test.each(["user_message", "assistant_message", "tool_call"] as const)("%s image positions and committed originals survive the timeline protocol", async kind => {
  const f = fixture(), projector = new ProviderImageProjector(f.options);
  const parts = [{ type: "text" as const, text: "before" }, { type: "text" as const, text: "slot" }, { type: "text" as const, text: "after" }];
  const entry: ProviderEntry = kind === "tool_call"
    ? { entryId: f.entry.entryId, revision: "1", kind, callId: "tool-call", name: "image tool", input: "{}", output: parts, status: "completed", truncated: false }
    : { entryId: f.entry.entryId, revision: "1", kind, content: parts };
  try {
    projector.publish(entry, [f.slot]); await projector.settled();
    expect(parseTimelineEntry({ ...f.entries.at(-1), entrySeq: "1" })).toMatchObject({ imageProjectionError: null });
    f.acknowledge(); projector.acknowledged(); await projector.settled();
    const restored = parseTimelineEntry({ ...f.entries.at(-1), entrySeq: "1" });
    expect(restored).toMatchObject({ imageProjectionError: null, [kind === "tool_call" ? "output" : "content"]: [{ text: "before" }, { type: "image", resourceId: f.resourceId }, { text: "after" }] });
  } finally { await projector.close(); }
});

test("the original image position is published and acknowledged before capture and keeps its order", async () => {
  const f = fixture(), projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [f.slot]); await projector.settled();
    expect(f.calls).toEqual(["position", "occurrence"]);
    expect(f.options.registerImageCapture).not.toHaveBeenCalled();
    f.acknowledge(); projector.acknowledged(); await projector.settled();
    expect(f.calls.indexOf("register")).toBeGreaterThan(f.calls.indexOf("occurrence"));
    expect(f.calls.indexOf("stage")).toBeGreaterThan(f.calls.indexOf("register"));
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image", resourceId: f.resourceId }, { text: "after" }] });
    expect(f.release).toHaveBeenCalledOnce();
  } finally { await projector.close(); }
});

test("reopened projection reuses the saved original without staging or reading the source again", async () => {
  const f = fixture(); f.acknowledge();
  let projector = new ProviderImageProjector(f.options);
  projector.publish(f.entry, [f.slot]); await projector.settled(); await projector.close();
  const release = vi.fn(); projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [{ ...f.slot, payload: { ...f.slot.payload, path: "/a/replaced/source", release } }]); await projector.settled();
    expect(f.options.registerImageCapture).toHaveBeenCalledOnce();
    expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image", resourceId: f.resourceId }, { text: "after" }] });
    expect(release).toHaveBeenCalledOnce();
  } finally { await projector.close(); }
});

test("a lost register response is queried by its original capture identity and never registered twice", async () => {
  const f = fixture(); f.acknowledge();
  vi.mocked(f.options.registerImageCapture!).mockImplementationOnce(async () => { throw new Error("lost receipt"); });
  vi.mocked(f.options.queryImageCapture!).mockImplementation(async captureId => {
    const saved = [...f.states.values()].find((value: any) => value.request?.captureId === captureId) as any;
    return { captureId, attemptId: saved.request.attemptId, revision: "2", occurrence: saved.request.occurrence, state: "committed", resourceId: f.resourceId, resource: null, error: null };
  });
  let projector = new ProviderImageProjector(f.options);
  projector.publish(f.entry, [f.slot]); await projector.settled(); await projector.close();
  projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [{ ...f.slot, payload: { kind: "unavailable", error: { code: "source_missing", message: "The source is unavailable." } } }]); await projector.settled();
    expect(f.options.registerImageCapture).toHaveBeenCalledOnce();
    expect(f.options.queryImageCapture).toHaveBeenCalledOnce();
    expect(f.options.stageImageCapture).not.toHaveBeenCalled();
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image", resourceId: f.resourceId }, { text: "after" }] });
  } finally { await projector.close(); }
});

test.each(["capture", "history"] as const)("a definite %s refusal settles without querying or inventing a receipt", async kind => {
  const f = fixture(); f.acknowledge();
  const failure = { code: "quota_exceeded", message: "Capture capacity is exhausted." };
  vi.mocked(f.options.registerImageCapture!).mockRejectedValue(kind === "capture" ? new ImageCaptureRequestError(failure) : new ImageCapturePrerequisiteError(failure));
  const projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [f.slot]); await projector.settled();
    projector.acknowledged(); await projector.settled();
    expect(f.options.registerImageCapture).toHaveBeenCalledOnce();
    expect(f.options.queryImageCapture).not.toHaveBeenCalled(); expect(f.options.stageImageCapture).not.toHaveBeenCalled();
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image_unavailable", error: { code: "quota_exceeded" } }, { text: "after" }] });
    expect(f.release).toHaveBeenCalledOnce();
    expect([...f.states.values()]).toContainEqual(expect.objectContaining({ phase: "settled", unknownAction: null }));
  } finally { await projector.close(); }
});

test.each(["rate", "local"] as const)("register retries %s refusal with its frozen identity without querying it", async kind => {
  const f = fixture(); f.acknowledge();
  const now = vi.spyOn(Date, "now").mockReturnValue(10000);
  const register = vi.mocked(f.options.registerImageCapture!);
  register.mockRejectedValueOnce(kind === "rate" ? new ImageCaptureRequestError({ code: "rate_limited", message: "Try later." }) : new ImageCaptureNotDispatchedError("Capture slots are full."));
  const projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [f.slot]); await projector.settled();
    projector.acknowledged(); await projector.settled();
    expect(register).toHaveBeenCalledOnce(); expect(f.options.queryImageCapture).not.toHaveBeenCalled();
    expect(f.options.stageImageCapture).not.toHaveBeenCalled();
    now.mockReturnValue(11000); projector.acknowledged(); await projector.settled();
    expect(register).toHaveBeenCalledTimes(2); expect(register.mock.calls[0]![0]).toEqual(register.mock.calls[1]![0]);
    expect(f.options.queryImageCapture).not.toHaveBeenCalled();
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image", resourceId: f.resourceId }, { text: "after" }] });
  } finally { now.mockRestore(); await projector.close(); }
});

test.each((["commit", "failure"] as const).flatMap(action => (["rate", "local"] as const).map(kind => ({ action, kind }))))("$action retries $kind refusal after restart with the original request", async ({ action, kind }) => {
  const f = fixture(); f.acknowledge();
  const now = vi.spyOn(Date, "now").mockReturnValue(10000);
  const control = action === "commit" ? vi.mocked(f.options.commitImageCapture!) : vi.mocked(f.options.failImageCapture!);
  control.mockRejectedValueOnce(kind === "rate" ? new ImageCaptureRequestError({ code: "rate_limited", message: "Try later." }) : new ImageCaptureNotDispatchedError("Capture slots are full."));
  if (action === "failure") vi.mocked(f.options.failImageCapture!).mockImplementationOnce(async (captureId, attemptId, error) => {
    const saved = [...f.states.values()].find((value: any) => value.request?.captureId === captureId) as any;
    return { captureId, attemptId, revision: "2", occurrence: saved.request.occurrence, state: "failed", resourceId: null, resource: null, error };
  });
  let projector = new ProviderImageProjector(f.options);
  const slot = action === "failure" ? { ...f.slot, payload: { kind: "unavailable" as const, error: { code: "source_missing", message: "Original is missing." } } } : f.slot;
  try {
    projector.publish(f.entry, [slot]); await projector.settled();
    projector.acknowledged(); await projector.settled();
    expect(control).toHaveBeenCalledOnce(); expect(f.options.queryImageCapture).not.toHaveBeenCalled();
    await projector.close(); projector = new ProviderImageProjector(f.options);
    projector.publish(f.entry, [{ ...f.slot, payload: { kind: "pending" } }]); await projector.settled();
    expect(control).toHaveBeenCalledOnce();
    now.mockReturnValue(11000); projector.acknowledged(); await projector.settled();
    expect(control).toHaveBeenCalledTimes(2); expect(control.mock.calls[0]).toEqual(control.mock.calls[1]);
    expect(f.options.queryImageCapture).not.toHaveBeenCalled();
    expect(f.options.stageImageCapture).toHaveBeenCalledTimes(action === "commit" ? 1 : 0);
  } finally { now.mockRestore(); await projector.close(); }
});

test.each(["commit", "failure"] as const)("a lost native %s retry is queried after restart, never replayed", async action => {
  const f = fixture(); f.acknowledge();
  const now = vi.spyOn(Date, "now").mockReturnValue(10000);
  const control = action === "commit" ? vi.mocked(f.options.commitImageCapture!) : vi.mocked(f.options.failImageCapture!);
  control.mockRejectedValueOnce(new ImageCaptureRequestError({ code: "rate_limited", message: "Try later." })).mockImplementationOnce(async () => {
    expect([...f.states.values()]).toContainEqual(expect.objectContaining({ phase: "query", unknownAction: action }));
    throw new Error("Response lost");
  });
  vi.mocked(f.options.queryImageCapture!).mockImplementation(async captureId => {
    const saved = [...f.states.values()].find((value: any) => value.request?.captureId === captureId) as any;
    return { captureId, attemptId: saved.request.attemptId, revision: "1", occurrence: saved.request.occurrence, state: "reserved", resourceId: f.resourceId, resource: null, error: null };
  });
  const slot = action === "failure" ? { ...f.slot, payload: { kind: "unavailable" as const, error: { code: "source_missing", message: "Original is missing." } } } : f.slot;
  let projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [slot]); await projector.settled();
    now.mockReturnValue(11000); projector.acknowledged(); await projector.settled();
    expect(control).toHaveBeenCalledTimes(2);
    await projector.close(); projector = new ProviderImageProjector(f.options);
    projector.publish(f.entry, [{ ...f.slot, payload: { kind: "pending" } }]); await projector.settled();
    expect(f.options.queryImageCapture).toHaveBeenCalledOnce(); expect(control).toHaveBeenCalledTimes(2);
  } finally { now.mockRestore(); await projector.close(); }
});

test("a failed original receipt ends observation after an unknown register result", async () => {
  const f = fixture(); f.acknowledge();
  vi.mocked(f.options.registerImageCapture!).mockRejectedValue(new Error("lost receipt"));
  vi.mocked(f.options.queryImageCapture!).mockImplementation(async captureId => {
    const saved = [...f.states.values()].find((value: any) => value.request?.captureId === captureId) as any;
    return { captureId, attemptId: saved.request.attemptId, revision: "1", occurrence: saved.request.occurrence, state: "failed", resourceId: null, resource: null, error: { code: "quota_exceeded", message: "Capture capacity is exhausted." } };
  });
  const projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [f.slot]); await projector.settled();
    projector.acknowledged(); await projector.settled();
    projector.acknowledged(); await projector.settled();
    expect(f.options.queryImageCapture).toHaveBeenCalledOnce(); expect(f.options.stageImageCapture).not.toHaveBeenCalled();
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image_unavailable", error: { code: "quota_exceeded" } }, { text: "after" }] });
  } finally { await projector.close(); }
});

test("a missing query after an unknown register does not settle the original capture", async () => {
  const f = fixture(); f.acknowledge();
  vi.mocked(f.options.registerImageCapture!).mockRejectedValue(new Error("lost response"));
  vi.mocked(f.options.queryImageCapture!).mockRejectedValueOnce(new ImageCaptureRequestError({ code: "capture_not_found", message: "Capture was not found." })).mockImplementation(async captureId => {
    const saved = [...f.states.values()].find((value: any) => value.request?.captureId === captureId) as any;
    return { captureId, attemptId: saved.request.attemptId, revision: "2", occurrence: saved.request.occurrence, state: "committed", resourceId: f.resourceId, resource: null, error: null };
  });
  const projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [f.slot]); await projector.settled();
    projector.acknowledged(); await projector.settled();
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image_unavailable", error: { code: "capture_unknown" } }, { text: "after" }] });
    expect(f.release).not.toHaveBeenCalled();
    projector.acknowledged(); await projector.settled();
    expect(f.options.queryImageCapture).toHaveBeenCalledTimes(2);
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image", resourceId: f.resourceId }, { text: "after" }] });
  } finally { await projector.close(); }
});

test.each(["commit", "failure"] as const)("a rejected %s observes the original copying and committed states", async action => {
  const f = fixture(); f.acknowledge();
  const refusal = new ImageCaptureRequestError({ code: "resource_conflict", message: "Capture changed." });
  if (action === "commit") vi.mocked(f.options.commitImageCapture!).mockRejectedValue(refusal);
  else vi.mocked(f.options.failImageCapture!).mockRejectedValue(refusal);
  let queries = 0;
  vi.mocked(f.options.queryImageCapture!).mockImplementation(async captureId => {
    const saved = [...f.states.values()].find((value: any) => value.request?.captureId === captureId) as any;
    return { captureId, attemptId: saved.request.attemptId, revision: "2", occurrence: saved.request.occurrence, state: ++queries === 1 ? "copying" : "committed", resourceId: f.resourceId, resource: null, error: null };
  });
  const projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [{ ...f.slot, ...(action === "failure" ? { payload: { kind: "unavailable" as const, error: { code: "source_unavailable", message: "Missing." } } } : {}) }]); await projector.settled();
    projector.acknowledged(); await projector.settled();
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image_unavailable", error: { code: "capture_unknown" } }, { text: "after" }] });
    projector.acknowledged(); await projector.settled();
    expect(f.options.queryImageCapture).toHaveBeenCalledTimes(2);
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image", resourceId: f.resourceId }, { text: "after" }] });
    expect(action === "commit" ? f.options.commitImageCapture : f.options.failImageCapture).toHaveBeenCalledOnce();
  } finally { await projector.close(); }
});

test("an unresolved commit is never replayed when a query still reports reserved", async () => {
  const f = fixture(); f.acknowledge();
  vi.mocked(f.options.commitImageCapture!).mockRejectedValue(new Error("commit response lost"));
  vi.mocked(f.options.queryImageCapture!).mockImplementation(async captureId => {
    const saved = [...f.states.values()].find((value: any) => value.request?.captureId === captureId) as any;
    return { captureId, attemptId: saved.request.attemptId, revision: "1", occurrence: saved.request.occurrence, state: "reserved", resourceId: f.resourceId, resource: null, error: null };
  });
  const projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [f.slot]); await projector.settled();
    projector.acknowledged(); await projector.settled();
    expect(f.options.commitImageCapture).toHaveBeenCalledOnce();
    expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
    expect(f.options.queryImageCapture).toHaveBeenCalledOnce();
  } finally { await projector.close(); }
});

test("a pending native slot waits for its final bytes and retains its published identity", async () => {
  const f = fixture(); f.acknowledge(); const projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [{ ...f.slot, payload: { kind: "pending" } }]); await projector.settled();
    const first = (f.entries[0] as any).content[1].imageId;
    expect(f.options.registerImageCapture).not.toHaveBeenCalled();
    projector.publish({ ...f.entry, revision: "2" }, [f.slot]); await projector.settled();
    expect(f.options.registerImageCapture).toHaveBeenCalledOnce();
    expect((f.entries.at(-1) as any).content[1]).toMatchObject({ type: "image", imageId: first });
  } finally { await projector.close(); }
});

test("source resolution and native transcript reads start only after ACK and registration", async () => {
  const f = fixture(), read = vi.fn(async () => { f.calls.push("source"); return f.slot.payload; });
  const projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [{ ...f.slot, payload: { kind: "deferred", read } }]); await projector.settled();
    expect(read).not.toHaveBeenCalled();
    f.acknowledge(); projector.acknowledged(); await projector.settled();
    expect(read).toHaveBeenCalledOnce();
    expect(f.calls.indexOf("source")).toBeGreaterThan(f.calls.indexOf("register"));
    expect(f.release).toHaveBeenCalledOnce();
  } finally { await projector.close(); }
});

test("an injected safe source resolver preserves the original locator and is skipped on reopen", async () => {
  const f = fixture(); f.acknowledge();
  const resolve = vi.fn(async (_request: ImageCaptureRequest) => f.slot.payload);
  f.options.resolveImageCaptureSource = resolve;
  const slot = { ...f.slot, payload: { kind: "source" as const, locator: { kind: "local" as const, path: "image.png", contextId: "native-cwd" } } };
  let projector = new ProviderImageProjector(f.options);
  projector.publish(f.entry, [slot]); await projector.settled(); await projector.close();
  expect(resolve).toHaveBeenCalledOnce();
  expect(resolve.mock.calls[0]?.[0]).toMatchObject({ locator: slot.payload.locator });
  projector = new ProviderImageProjector(f.options);
  try { projector.publish(f.entry, [slot]); await projector.settled(); expect(resolve).toHaveBeenCalledOnce(); }
  finally { await projector.close(); }
});

test("closing projection aborts and joins an active deferred source before releasing its bytes", async () => {
  const f = fixture(); f.acknowledge(); let aborted = false, finish!: () => void;
  const started = new Promise<void>(resolve => { finish = resolve; });
  const projector = new ProviderImageProjector(f.options);
  projector.publish(f.entry, [{ ...f.slot, payload: { kind: "deferred", read: async signal => {
    finish(); await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true })); return f.slot.payload;
  } } }]);
  await started; await projector.close();
  expect(aborted).toBe(true); expect(f.release).toHaveBeenCalledOnce();
  expect(f.options.stageImageCapture).not.toHaveBeenCalled();
});

test("late input evidence cannot replace an already published native image identity", async () => {
  const f = fixture(); f.acknowledge(); let projector = new ProviderImageProjector(f.options);
  projector.publish(f.entry, [f.slot]); await projector.settled(); await projector.close();
  projector = new ProviderImageProjector(f.options);
  try {
    expect(() => projector.publish(f.entry, [{ ...f.slot, original: { imageId: randomUUID(), resourceId: randomUUID() } }])).toThrow(/identity/);
  } finally { await projector.close(); }
});

test("rejected positions release every incoming file that the projector did not adopt", async () => {
  const f = fixture(), projector = new ProviderImageProjector(f.options), laterRelease = vi.fn();
  try {
    expect(() => projector.publish(f.entry, [{ ...f.slot, index: -1 }, { ...f.slot, payload: { ...f.slot.payload, release: laterRelease } }])).toThrow(/position/);
    expect(f.release).toHaveBeenCalledOnce(); expect(laterRelease).toHaveBeenCalledOnce();
  } finally { await projector.close(); }
  expect(f.release).toHaveBeenCalledOnce(); expect(laterRelease).toHaveBeenCalledOnce();
});

test("shutdown retains a failed lease for retry while releasing the other owned files", async () => {
  const f = fixture(), projector = new ProviderImageProjector(f.options), otherRelease = vi.fn();
  f.release.mockImplementationOnce(() => { throw new Error("controlled unlink failure"); });
  projector.publish(f.entry, [f.slot, { ...f.slot, index: 2, native: { ...f.slot.native, nativePartId: "content/2" }, payload: { ...f.slot.payload, release: otherRelease } }]);
  await projector.settled();
  await expect(projector.close()).rejects.toThrow(/release/);
  expect(f.release).toHaveBeenCalledOnce(); expect(otherRelease).toHaveBeenCalledOnce();
  await projector.close();
  expect(f.release).toHaveBeenCalledTimes(2); expect(otherRelease).toHaveBeenCalledOnce();
});

test("failed cleanup of a rejected file remains retryable and does not skip other files", async () => {
  const f = fixture(), projector = new ProviderImageProjector(f.options), otherRelease = vi.fn();
  f.release.mockImplementationOnce(() => { throw new Error("controlled unlink failure"); });
  expect(() => projector.publish(f.entry, [{ ...f.slot, index: -1 }, { ...f.slot, payload: { ...f.slot.payload, release: otherRelease } }])).toThrow();
  expect(otherRelease).toHaveBeenCalledOnce();
  await projector.close();
  expect(f.release).toHaveBeenCalledTimes(2); expect(otherRelease).toHaveBeenCalledOnce();
});

test("a committed resource stays visible when removing redundant native bytes needs a retry", async () => {
  const f = fixture(), projector = new ProviderImageProjector(f.options); f.acknowledge();
  f.release.mockImplementationOnce(() => { throw new Error("controlled unlink failure"); });
  vi.mocked(f.options.registerImageCapture!).mockImplementation(async request => ({ captureId: request.captureId, attemptId: request.attemptId, revision: "1", occurrence: request.occurrence, state: "committed", resourceId: f.resourceId, resource: null, error: null }));
  try {
    projector.publish(f.entry, [f.slot]); await projector.settled();
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image", resourceId: f.resourceId }, { text: "after" }] });
    expect(f.options.queryImageCapture).not.toHaveBeenCalled();
  } finally { await projector.close(); }
  expect(f.release).toHaveBeenCalledTimes(2);
});

test("a local release error cannot suppress the definite staging failure receipt", async () => {
  const f = fixture(), projector = new ProviderImageProjector(f.options); f.acknowledge();
  vi.mocked(f.options.stageImageCapture!).mockRejectedValue(new Error("invalid native image"));
  f.release.mockImplementationOnce(() => { throw new Error("controlled unlink failure"); });
  try {
    projector.publish(f.entry, [f.slot]); await projector.settled();
    expect(f.options.failImageCapture).toHaveBeenCalledOnce();
    expect(f.options.failImageCapture).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ code: "source_validation_failed" }));
    expect(f.options.queryImageCapture).not.toHaveBeenCalled();
    expect(f.options.commitImageCapture).not.toHaveBeenCalled();
  } finally { await projector.close(); }
  expect(f.release).toHaveBeenCalledTimes(2);
});

test.each(["owner", "legacy"] as const)("a committed capture survives repeated %s metadata patch failures without repeating source or capture RPCs", async mode => {
  const f = fixture(), projector = new ProviderImageProjector(f.options); f.acknowledge();
  const timeline = f.options.onTimeline;
  let failures = 2;
  const patch = vi.fn((entry: ProviderEntry) => {
    if (failures-- > 0) throw new Error("Controlled timeline patch failure");
    timeline(entry);
    return { ...entry, entrySeq: "1" };
  });
  if (mode === "owner") f.options.imageRuntime!.patchNativeImagePart = (occurrence, part) => {
    const entry = f.entries.at(-1)! as Extract<ProviderEntry, { kind: "user_message" | "assistant_message" }>;
    return patch({ ...entry, content: entry.content.map(value => (value.type === "image" || value.type === "image_unavailable") && value.imageId === occurrence.imageId ? part : value) });
  };
  else f.options.onTimeline = entry => {
    if (entry.kind === "assistant_message" && entry.content[1]?.type === "image") patch(entry);
    else timeline(entry);
  };
  try {
    projector.publish(f.entry, [f.slot]); await projector.settled();
    const saved = () => [...f.states.values()][0] as NativeImageProjectionState;
    expect(saved()).toMatchObject({ phase: "settled", part: { type: "image", resourceId: f.resourceId } });
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image_unavailable" }, { text: "after" }] });
    projector.acknowledged(); await projector.settled();
    expect(saved()).toMatchObject({ phase: "settled", part: { type: "image", resourceId: f.resourceId } });
    projector.acknowledged(); await projector.settled();
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image", resourceId: f.resourceId }, { text: "after" }] });
    expect(patch).toHaveBeenCalledTimes(3);
    expect(f.options.registerImageCapture).toHaveBeenCalledOnce(); expect(f.options.stageImageCapture).toHaveBeenCalledOnce(); expect(f.options.commitImageCapture).toHaveBeenCalledOnce(); expect(f.options.queryImageCapture).not.toHaveBeenCalled();
  } finally { await projector.close(); }
});

test("a known capture receipt is persisted again after its first settled-state write fails", async () => {
  const f = fixture(), projector = new ProviderImageProjector(f.options); f.acknowledge();
  const write = f.options.imageRuntime!.writeState;
  let failures = 1;
  f.options.imageRuntime!.writeState = (key, value) => {
    if ((value as NativeImageProjectionState).phase === "settled" && failures-- > 0) throw new Error("Controlled settled-state write failure");
    write(key, value);
  };
  try {
    projector.publish(f.entry, [f.slot]); await projector.settled();
    expect([...f.states.values()][0]).toMatchObject({ phase: "query" });
    projector.acknowledged(); await projector.settled();
    expect([...f.states.values()][0]).toMatchObject({ phase: "settled", part: { type: "image", resourceId: f.resourceId } });
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image", resourceId: f.resourceId }, { text: "after" }] });
    expect(f.options.registerImageCapture).toHaveBeenCalledOnce(); expect(f.options.commitImageCapture).toHaveBeenCalledOnce(); expect(f.options.queryImageCapture).not.toHaveBeenCalled();
  } finally { await projector.close(); }
});

test("a source discovered after a pending slot uses its final locator before registration", async () => {
  const f = fixture(); f.acknowledge(); const projector = new ProviderImageProjector(f.options);
  f.options.resolveImageCaptureSource = vi.fn(async () => f.slot.payload);
  try {
    projector.publish(f.entry, [{ ...f.slot, payload: { kind: "pending" } }]); await projector.settled();
    const locator = { kind: "external" as const, url: "https://example.test/actual.png" };
    projector.publish(f.entry, [{ ...f.slot, payload: { kind: "source", locator } }]); await projector.settled();
    expect(f.options.registerImageCapture).toHaveBeenCalledWith(expect.objectContaining({ locator }));
  } finally { await projector.close(); }
});

test("a reopened pending slot registers the discovered source without changing its occurrence", async () => {
  const f = fixture(); f.acknowledge(); let projector = new ProviderImageProjector(f.options);
  projector.publish(f.entry, [{ ...f.slot, payload: { kind: "pending" } }]); await projector.settled(); await projector.close();
  const imageId = (f.entries.at(-1) as any).content[1].imageId;
  f.options.resolveImageCaptureSource = vi.fn(async () => f.slot.payload);
  projector = new ProviderImageProjector(f.options);
  try {
    const locator = { kind: "local" as const, path: "/original/final.png", contextId: "same-native-context" };
    projector.publish(f.entry, [{ ...f.slot, payload: { kind: "source", locator } }]); await projector.settled();
    expect(f.options.registerImageCapture).toHaveBeenCalledWith(expect.objectContaining({ locator, occurrence: expect.objectContaining({ imageId }) }));
  } finally { await projector.close(); }
});

test("adopting a committed current view emits no timeline or occurrence and retains settled image resources", async () => {
  const f = fixture(); f.acknowledge(); let projector = new ProviderImageProjector(f.options);
  projector.publish({ ...f.entry, kind: "user_message" }, [f.slot]); await projector.settled(); await projector.close();
  const [key, saved] = [...f.states.entries()][0]!;
  const view: NativeInputPublicationView = { entry: { ...f.entries.at(-1), kind: "user_message", entrySeq: "1", revision: "8" } as NativeInputPublicationView["entry"], slots: [{ key, label: "Native image", state: structuredClone(saved) as NativeImageProjectionState }] };
  const previous = [...f.calls], release = vi.fn(); projector = new ProviderImageProjector(f.options);
  try {
    projector.adoptCommitted(view, [{ ...f.slot, payload: { ...f.slot.payload, release } }]); await projector.settled();
    expect(f.calls).toEqual(previous); expect(release).toHaveBeenCalledOnce();
    expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
    expect(view.entry).toMatchObject({ revision: "8", content: [{ text: "before" }, { type: "image", resourceId: f.resourceId }, { text: "after" }] });
  } finally { await projector.close(); }
});

test("adopted pending positions wait for their existing ACK before native source IO", async () => {
  const f = fixture(); let projector = new ProviderImageProjector(f.options);
  projector.publish({ ...f.entry, kind: "user_message" }, [{ ...f.slot, payload: { kind: "pending" } }]); await projector.settled(); await projector.close();
  const [key, saved] = [...f.states.entries()][0]!, read = vi.fn(async () => f.slot.payload);
  const view: NativeInputPublicationView = { entry: { ...f.entries.at(-1), kind: "user_message", entrySeq: "1", revision: "4" } as NativeInputPublicationView["entry"], slots: [{ key, label: "Native image", state: structuredClone(saved) as NativeImageProjectionState }] };
  const before = [...f.calls]; projector = new ProviderImageProjector(f.options);
  try {
    projector.adoptCommitted(view, [{ ...f.slot, payload: { kind: "deferred", read } }]); await projector.settled();
    expect(f.calls).toEqual(before); expect(read).not.toHaveBeenCalled();
    f.acknowledge(); projector.acknowledged(); await projector.settled();
    expect(read).toHaveBeenCalledOnce(); expect(f.options.registerImageCapture).toHaveBeenCalledWith((saved as NativeImageProjectionState).request);
  } finally { await projector.close(); }
});

test("adopting a different committed body cannot inherit an earlier Markdown permit", async () => {
  const f = fixture(), onTimeline = vi.fn(f.options.onTimeline), projector = new ProviderImageProjector({ ...f.options, onTimeline });
  try {
    projector.publish({ ...f.entry, kind: "user_message" }, [{ ...f.slot, payload: { kind: "pending" } }], { format: "markdown", complete: true, truncated: false });
    await projector.settled();
    const [key, state] = [...f.states.entries()][0]!;
    const previous = f.entries.at(-1)! as Extract<ProviderEntry, { kind: "user_message" | "assistant_message" }>;
    const view: NativeInputPublicationView = {
      entry: { ...previous, kind: "user_message", entrySeq: "1", revision: "2", content: [{ type: "text", text: "![changed](another.png)" }, ...previous.content.slice(1)] },
      slots: [{ key, label: "Native image", state: structuredClone(state) as NativeImageProjectionState }],
    };
    projector.adoptCommitted(view, [f.slot]);
    f.acknowledge(); projector.acknowledged(); await projector.settled();
    expect(onTimeline.mock.calls.at(-1)?.[0]).toMatchObject({ revision: "2", content: [{ text: "![changed](another.png)" }, { type: "image", resourceId: f.resourceId }, { text: "after" }] });
    expect(onTimeline.mock.calls.at(-1)?.[1]).toBeUndefined();
  } finally { await projector.close(); }
});

test("a settled capture repairs only its current committed slot after a crash before timeline projection", async () => {
  const f = fixture(); let projector = new ProviderImageProjector(f.options);
  projector.publish({ ...f.entry, kind: "user_message" }, [{ ...f.slot, payload: { kind: "pending" } }]); await projector.settled(); await projector.close();
  const [key, state] = [...f.states.entries()][0]!, saved = structuredClone(state) as NativeImageProjectionState;
  saved.phase = "settled"; saved.waitingForSource = false; saved.part = { type: "image", imageId: saved.request.occurrence.imageId, resourceId: f.resourceId, label: "Native image" };
  f.states.set(key, saved);
  const view: NativeInputPublicationView = { entry: { ...f.entries.at(-1), kind: "user_message", entrySeq: "1", revision: "7" } as NativeInputPublicationView["entry"], slots: [{ key, label: "Native image", state: saved }] };
  const before = [...f.calls]; f.acknowledge(); projector = new ProviderImageProjector(f.options);
  try {
    projector.adoptCommitted(view); expect(f.calls).toEqual(before); await projector.settled();
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, saved.part, { text: "after" }] });
    expect(f.calls.slice(before.length)).toEqual(["position"]);
    expect(f.options.registerImageCapture).not.toHaveBeenCalled(); expect(f.options.stageImageCapture).not.toHaveBeenCalled();
  } finally { await projector.close(); }
});

test("an adopted unknown capture queries its saved receipt even when native bytes have not replayed", async () => {
  const f = fixture(); f.acknowledge(); let projector = new ProviderImageProjector(f.options);
  vi.mocked(f.options.registerImageCapture!).mockRejectedValue(new Error("Controlled lost register response"));
  projector.publish({ ...f.entry, kind: "user_message" }, [f.slot]); await projector.settled(); await projector.close();
  const [key, state] = [...f.states.entries()][0]!, saved = structuredClone(state) as NativeImageProjectionState;
  vi.mocked(f.options.queryImageCapture!).mockResolvedValue({ captureId: saved.request.captureId, attemptId: saved.request.attemptId, revision: "2", occurrence: saved.request.occurrence, state: "committed", resourceId: f.resourceId, resource: null, error: null });
  const view: NativeInputPublicationView = { entry: { ...f.entries.at(-1), kind: "user_message", entrySeq: "1", revision: "5" } as NativeInputPublicationView["entry"], slots: [{ key, label: "Native image", state: saved }] };
  projector = new ProviderImageProjector(f.options);
  try {
    projector.adoptCommitted(view); await projector.settled();
    expect(f.options.queryImageCapture).toHaveBeenCalledWith(saved.request.captureId);
    expect(f.options.registerImageCapture).toHaveBeenCalledOnce(); expect(f.options.stageImageCapture).not.toHaveBeenCalled();
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image", resourceId: f.resourceId }, { text: "after" }] });
  } finally { await projector.close(); }
});
