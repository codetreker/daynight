import { expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ProviderImageProjector } from "../../../src/commands/controller/providers/image-projector.js";
import { ImageCaptureNotDispatchedError, ImageCapturePrerequisiteError, ImageCaptureRequestError } from "../../../src/commands/controller/media/capture-error.js";
import type { ProviderEntry, ProviderOptions } from "../../../src/commands/controller/providers/types.js";
import type { DirectCaptureSubmission, ImageCaptureReceipt, ImageCaptureRequest, ImageOccurrence, ImagePart, ImageUnavailablePart } from "../../../src/session/image-values.js";
import { parseTimelineEntry } from "../../../src/session/protocol.js";
import type { NativeInputPublicationView, NativeImageProjectionState } from "../../../src/commands/controller/media/native-publication-types.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { loadSqliteSequence } from "../../../src/platform/sqlite-sql.js";
import { migrateDirectCaptureState } from "../../../src/commands/controller/media/capture-migration.js";

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
    prepareImageCapture: vi.fn(async (value: ImageCaptureRequest) => { calls.push("prepare"); request = value; }),
    registerImageCapture: vi.fn(),
    submitImageCapture: vi.fn(async (value: DirectCaptureSubmission) => { calls.push("submit"); request = value.request; return value.outcome.kind === "failed" ? { ...receipt("failed"), resourceId: null, error: value.outcome.error } : receipt("committed"); }),
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

const migrateLegacyProjection = (states: Map<string, unknown>, old: unknown): NativeImageProjectionState => {
  const db = createMemoryDatabase(), key = [...states.keys()][0]!;
  try {
    for (const step of loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url)).filter(step => step.version <= 11)) db.exec(step.sql);
    db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run(`native_provider:${key}`, JSON.stringify(old));
    db.transaction(() => migrateDirectCaptureState(db, "SELECT 1", () => {}))();
    const state = JSON.parse((db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(`native_provider:${key}`) as { value: string }).value) as NativeImageProjectionState;
    states.set(key, state); return state;
  } finally { db.close(); }
};

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
    expect(f.options.prepareImageCapture).not.toHaveBeenCalled();
    f.acknowledge(); projector.acknowledged(); await projector.settled();
    expect(f.calls.indexOf("prepare")).toBeGreaterThan(f.calls.indexOf("occurrence"));
    expect(f.calls.indexOf("stage")).toBeGreaterThan(f.calls.indexOf("prepare"));
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
    expect(f.options.prepareImageCapture).toHaveBeenCalledOnce();
    expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image", resourceId: f.resourceId }, { text: "after" }] });
    expect(release).toHaveBeenCalledOnce();
  } finally { await projector.close(); }
});

test("a pending native slot waits for its final bytes and retains its published identity", async () => {
  const f = fixture(); f.acknowledge(); const projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [{ ...f.slot, payload: { kind: "pending" } }]); await projector.settled();
    const first = (f.entries[0] as any).content[1].imageId;
    expect(f.options.prepareImageCapture).not.toHaveBeenCalled();
    projector.publish({ ...f.entry, revision: "2" }, [f.slot]); await projector.settled();
    expect(f.options.prepareImageCapture).toHaveBeenCalledOnce();
    expect((f.entries.at(-1) as any).content[1]).toMatchObject({ type: "image", imageId: first });
  } finally { await projector.close(); }
});

test("source resolution and native transcript reads start only after ACK and complete history", async () => {
  const f = fixture(), read = vi.fn(async () => { f.calls.push("source"); return f.slot.payload; });
  const projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [{ ...f.slot, payload: { kind: "deferred", read } }]); await projector.settled();
    expect(read).not.toHaveBeenCalled();
    f.acknowledge(); projector.acknowledged(); await projector.settled();
    expect(read).toHaveBeenCalledOnce();
    expect(f.calls.indexOf("source")).toBeGreaterThan(f.calls.indexOf("prepare"));
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
    expect(f.options.submitImageCapture).toHaveBeenCalledOnce();
    expect(f.options.submitImageCapture).toHaveBeenCalledWith(expect.objectContaining({ outcome: { kind: "failed", error: expect.objectContaining({ code: "source_validation_failed" }) } }));
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
    expect(f.options.prepareImageCapture).toHaveBeenCalledOnce(); expect(f.options.stageImageCapture).toHaveBeenCalledOnce(); expect(f.options.submitImageCapture).toHaveBeenCalledOnce(); expect(f.options.queryImageCapture).not.toHaveBeenCalled();
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
    expect(f.options.prepareImageCapture).toHaveBeenCalledOnce(); expect(f.options.submitImageCapture).toHaveBeenCalledOnce(); expect(f.options.queryImageCapture).not.toHaveBeenCalled();
  } finally { await projector.close(); }
});

test("a source discovered after a pending slot freezes its final locator before source IO", async () => {
  const f = fixture(); f.acknowledge(); const projector = new ProviderImageProjector(f.options);
  f.options.resolveImageCaptureSource = vi.fn(async () => f.slot.payload);
  try {
    projector.publish(f.entry, [{ ...f.slot, payload: { kind: "pending" } }]); await projector.settled();
    const locator = { kind: "external" as const, url: "https://example.test/actual.png" };
    projector.publish(f.entry, [{ ...f.slot, payload: { kind: "source", locator } }]); await projector.settled();
    expect(f.options.prepareImageCapture).toHaveBeenCalledWith(expect.objectContaining({ locator }));
  } finally { await projector.close(); }
});

test("a reopened pending slot captures the discovered source without changing its occurrence", async () => {
  const f = fixture(); f.acknowledge(); let projector = new ProviderImageProjector(f.options);
  projector.publish(f.entry, [{ ...f.slot, payload: { kind: "pending" } }]); await projector.settled(); await projector.close();
  const imageId = (f.entries.at(-1) as any).content[1].imageId;
  f.options.resolveImageCaptureSource = vi.fn(async () => f.slot.payload);
  projector = new ProviderImageProjector(f.options);
  try {
    const locator = { kind: "local" as const, path: "/original/final.png", contextId: "same-native-context" };
    projector.publish(f.entry, [{ ...f.slot, payload: { kind: "source", locator } }]); await projector.settled();
    expect(f.options.prepareImageCapture).toHaveBeenCalledWith(expect.objectContaining({ locator, occurrence: expect.objectContaining({ imageId }) }));
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
    expect(read).toHaveBeenCalledOnce(); expect(f.options.prepareImageCapture).toHaveBeenCalledWith((saved as NativeImageProjectionState).request);
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
    expect(f.options.prepareImageCapture).not.toHaveBeenCalled(); expect(f.options.stageImageCapture).not.toHaveBeenCalled();
  } finally { await projector.close(); }
});

test("an adopted unknown capture queries its saved receipt even when native bytes have not replayed", async () => {
  const f = fixture(); f.acknowledge(); let projector = new ProviderImageProjector(f.options);
  vi.mocked(f.options.submitImageCapture!).mockRejectedValue(new Error("Controlled lost submit response"));
  projector.publish({ ...f.entry, kind: "user_message" }, [f.slot]); await projector.settled(); await projector.close();
  const [key, state] = [...f.states.entries()][0]!, saved = structuredClone(state) as NativeImageProjectionState;
  vi.mocked(f.options.queryImageCapture!).mockResolvedValue({ captureId: saved.request.captureId, attemptId: saved.request.attemptId, revision: "2", occurrence: saved.request.occurrence, state: "committed", resourceId: f.resourceId, resource: null, error: null });
  const view: NativeInputPublicationView = { entry: { ...f.entries.at(-1), kind: "user_message", entrySeq: "1", revision: "5" } as NativeInputPublicationView["entry"], slots: [{ key, label: "Native image", state: saved }] };
  projector = new ProviderImageProjector(f.options);
  try {
    projector.adoptCommitted(view); await projector.settled();
    expect(f.options.queryImageCapture).toHaveBeenCalledWith(saved.request.captureId);
    expect(f.options.prepareImageCapture).toHaveBeenCalledOnce(); expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image", resourceId: f.resourceId }, { text: "after" }] });
  } finally { await projector.close(); }
});

test("sealed native bytes are submitted directly without legacy capture controls", async () => {
  const f = fixture(); f.acknowledge(); const projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [f.slot]); await projector.settled();
    expect(f.calls.filter(call => ["prepare", "stage", "submit"].includes(call))).toEqual(["prepare", "stage", "submit"]);
    expect(f.options.registerImageCapture).not.toHaveBeenCalled(); expect(f.options.commitImageCapture).not.toHaveBeenCalled(); expect(f.options.failImageCapture).not.toHaveBeenCalled();
    expect(f.options.submitImageCapture).toHaveBeenCalledWith(expect.objectContaining({ outcome: { kind: "validated", validated: expect.objectContaining({ sha256: "a".repeat(64) }) } }));
  } finally { await projector.close(); }
});

test("original resource echoes submit associations without reading or staging bytes", async () => {
  const f = fixture(); f.acknowledge(); const projector = new ProviderImageProjector(f.options), imageId = randomUUID();
  try {
    projector.publish(f.entry, [{ ...f.slot, original: { imageId, resourceId: f.resourceId }, payload: { kind: "resource", resourceId: f.resourceId } }]); await projector.settled();
    expect(f.options.stageImageCapture).not.toHaveBeenCalled();
    expect(f.options.submitImageCapture).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ locator: { kind: "resource", resourceId: f.resourceId } }), outcome: { kind: "resource" } }));
  } finally { await projector.close(); }
});

test.each(["copying", "committed", "failed"] as const)("lost native submit reconciles the original %s result after reopen without new source IO", async state => {
  const f = fixture(); f.acknowledge();
  vi.mocked(f.options.submitImageCapture!).mockRejectedValueOnce(new Error("lost submit receipt"));
  let projector = new ProviderImageProjector(f.options);
  projector.publish(f.entry, [f.slot]); await projector.settled(); await projector.close();
  const saved = [...f.states.values()][0] as NativeImageProjectionState;
  vi.mocked(f.options.queryImageCapture!).mockResolvedValue({ captureId: saved.request.captureId, attemptId: saved.attemptId, revision: "2", occurrence: saved.request.occurrence, state, resourceId: state === "failed" ? null : f.resourceId, resource: null, error: state === "failed" ? { code: "storage_unavailable", message: "Storage failed." } : null });
  projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [{ ...f.slot, payload: { kind: "pending" } }]); await projector.settled();
    expect(f.options.queryImageCapture).toHaveBeenCalledWith(saved.request.captureId);
    expect(f.options.submitImageCapture).toHaveBeenCalledOnce(); expect(f.options.stageImageCapture).toHaveBeenCalledOnce(); expect(f.options.prepareImageCapture).toHaveBeenCalledOnce();
    expect([...f.states.values()][0]).toMatchObject({ phase: state === "copying" ? "query" : "settled", request: saved.request });
  } finally { await projector.close(); }
});

test("an explicitly absent capture replays the frozen submission after reconnect without staging again", async () => {
  const f = fixture(); f.acknowledge();
  const submit = vi.mocked(f.options.submitImageCapture!); submit.mockRejectedValueOnce(new Error("first frame lost"));
  let projector = new ProviderImageProjector(f.options);
  projector.publish(f.entry, [f.slot]); await projector.settled(); await projector.close();
  const original = structuredClone(submit.mock.calls[0]![0]);
  vi.mocked(f.options.queryImageCapture!).mockRejectedValueOnce(new ImageCaptureRequestError({ code: "capture_not_found", message: "Capture is absent under the current authorized Session." }));
  projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [{ ...f.slot, payload: { kind: "unavailable", error: { code: "source_missing", message: "Source disappeared." } } }]); await projector.settled();
    expect(submit).toHaveBeenCalledTimes(2); expect(submit.mock.calls[1]![0]).toEqual(original);
    expect(f.options.stageImageCapture).toHaveBeenCalledOnce(); expect(f.options.prepareImageCapture).toHaveBeenCalledOnce();
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image", resourceId: f.resourceId }, { text: "after" }] });
  } finally { await projector.close(); }
});

test.each(["session_not_found", "forbidden", "unknown"])("query refusal %s cannot authorize frozen submit replay", async code => {
  const f = fixture(); f.acknowledge();
  vi.mocked(f.options.submitImageCapture!).mockRejectedValueOnce(new Error("lost receipt"));
  const projector = new ProviderImageProjector(f.options);
  vi.mocked(f.options.queryImageCapture!).mockRejectedValue(new ImageCaptureRequestError({ code, message: "Current execution could not be reconciled." }));
  try {
    projector.publish(f.entry, [f.slot]); await projector.settled(); projector.acknowledged(); await projector.settled();
    expect(f.options.submitImageCapture).toHaveBeenCalledOnce(); expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
    expect([...f.states.values()][0]).toMatchObject({ phase: "query" });
  } finally { await projector.close(); }
});

test.each(["rate", "local"] as const)("known unsent native %s refusal retries the same frozen business", async kind => {
  const f = fixture(); f.acknowledge(); const now = vi.spyOn(Date, "now").mockReturnValue(10000);
  const submit = vi.mocked(f.options.submitImageCapture!);
  submit.mockRejectedValueOnce(kind === "rate" ? new ImageCaptureRequestError({ code: "rate_limited", message: "Try later." }) : new ImageCaptureNotDispatchedError("Relay slots full."));
  const projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [f.slot]); await projector.settled(); projector.acknowledged(); await projector.settled(); expect(submit).toHaveBeenCalledOnce();
    now.mockReturnValue(11000); projector.acknowledged(); await projector.settled();
    expect(submit).toHaveBeenCalledTimes(2); expect(submit.mock.calls[0]![0]).toEqual(submit.mock.calls[1]![0]);
    expect(f.options.queryImageCapture).not.toHaveBeenCalled(); expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
  } finally { now.mockRestore(); await projector.close(); }
});

test("definite history failure settles before source IO and exposes its actual reason", async () => {
  const f = fixture(); f.acknowledge();
  vi.mocked(f.options.prepareImageCapture!).mockRejectedValueOnce(new ImageCapturePrerequisiteError({ code: "quota_exceeded", message: "Full history cannot be published." }));
  const projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [f.slot]); await projector.settled(); projector.acknowledged(); await projector.settled();
    expect(f.options.stageImageCapture).not.toHaveBeenCalled(); expect(f.options.submitImageCapture).not.toHaveBeenCalled(); expect(f.options.queryImageCapture).not.toHaveBeenCalled();
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image_unavailable", error: { code: "quota_exceeded" } }, { text: "after" }] });
  } finally { await projector.close(); }
});

test("an interrupted native source start submits failure after reopen without reading a changed source", async () => {
  const f = fixture(); let projector = new ProviderImageProjector(f.options);
  projector.publish(f.entry, [f.slot]); await projector.settled(); await projector.close();
  const [key, state] = [...f.states.entries()][0]!, saved = state as NativeImageProjectionState;
  saved.phase = "preparing"; f.states.set(key, saved); f.acknowledge();
  const read = vi.fn(async () => f.slot.payload); projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [{ ...f.slot, payload: { kind: "deferred", read } }]); await projector.settled();
    expect(read).not.toHaveBeenCalled(); expect(f.options.stageImageCapture).not.toHaveBeenCalled();
    expect(f.options.submitImageCapture).toHaveBeenCalledWith(expect.objectContaining({ outcome: { kind: "failed", error: expect.objectContaining({ code: "source_unavailable" }) } }));
  } finally { await projector.close(); }
});

test("a stale submit refusal observes the service's current retry without replacing the original request", async () => {
  const f = fixture(); f.acknowledge(); const currentAttempt = randomUUID();
  vi.mocked(f.options.submitImageCapture!).mockRejectedValueOnce(new ImageCaptureRequestError({ code: "capture_conflict", message: "Attempt advanced." }));
  const projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [f.slot]); await projector.settled();
    const original = ([...f.states.values()][0] as NativeImageProjectionState).request;
    vi.mocked(f.options.queryImageCapture!).mockResolvedValueOnce({ captureId: original.captureId, attemptId: currentAttempt, revision: "3", occurrence: original.occurrence, state: "copying", resourceId: f.resourceId, resource: null, error: null });
    projector.acknowledged(); await projector.settled();
    expect([...f.states.values()][0]).toMatchObject({ request: original, attemptId: currentAttempt, phase: "query", submission: null });
    expect(f.options.stageImageCapture).toHaveBeenCalledOnce(); expect(f.options.submitImageCapture).toHaveBeenCalledOnce();
  } finally { await projector.close(); }
});

test("migrated unknown registration resumes its first source read only after the same reserved attempt is observed", async () => {
  const f = fixture(); let projector = new ProviderImageProjector(f.options);
  projector.publish(f.entry, [f.slot]); await projector.settled(); await projector.close();
  const current = [...f.states.values()][0] as NativeImageProjectionState, { attemptId: _attemptId, submission: _submission, ...old } = current;
  const saved = migrateLegacyProjection(f.states, { ...old, phase: "query", unknownAction: "register", validated: null });
  const read = vi.fn(async () => f.slot.payload);
  vi.mocked(f.options.queryImageCapture!).mockRejectedValueOnce(new ImageCaptureRequestError({ code: "forbidden", message: "Current authority must be reconciled." })).mockResolvedValueOnce({ captureId: saved.request.captureId, attemptId: saved.attemptId, revision: "1", occurrence: saved.request.occurrence, state: "reserved", resourceId: f.resourceId, resource: null, error: null });
  f.acknowledge(); projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [{ ...f.slot, payload: { kind: "deferred", read } }]); await projector.settled();
    expect(read).not.toHaveBeenCalled(); expect([...f.states.values()][0]).toMatchObject({ phase: "query", resumeReserved: "source" });
    projector.acknowledged(); await projector.settled();
    expect(read).toHaveBeenCalledOnce(); expect(f.options.stageImageCapture).toHaveBeenCalledOnce(); expect(f.options.submitImageCapture).toHaveBeenCalledOnce();
    expect([...f.states.values()][0]).toMatchObject({ phase: "settled" }); expect([...f.states.values()][0]).not.toHaveProperty("resumeReserved");
  } finally { await projector.close(); }
});

test.each(["commit", "failure"] as const)("migrated unknown %s resumes its frozen outcome after the same reserved attempt is observed", async action => {
  const f = fixture(); let projector = new ProviderImageProjector(f.options);
  projector.publish(f.entry, [f.slot]); await projector.settled(); await projector.close();
  const current = [...f.states.values()][0] as NativeImageProjectionState, { attemptId: _attemptId, submission: _submission, ...old } = current;
  const validated = { mediaType: "image/png", byteLength: "3", sha256: "a".repeat(64), width: 1, height: 1, frameCount: 1 };
  const saved = migrateLegacyProjection(f.states, { ...old, phase: "query", unknownAction: action, validated: action === "commit" ? validated : null, part: action === "failure" ? { ...old.part, error: { code: "decode_failed", message: "Original decoder failed." } } : old.part });
  const read = vi.fn(async () => f.slot.payload);
  vi.mocked(f.options.queryImageCapture!).mockResolvedValueOnce({ captureId: saved.request.captureId, attemptId: saved.attemptId, revision: "1", occurrence: saved.request.occurrence, state: "reserved", resourceId: f.resourceId, resource: null, error: null });
  f.acknowledge(); projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [{ ...f.slot, payload: { kind: "deferred", read } }]); await projector.settled();
    expect(read).not.toHaveBeenCalled(); expect(f.options.stageImageCapture).not.toHaveBeenCalled(); expect(f.options.submitImageCapture).toHaveBeenCalledWith(saved.submission);
    expect([...f.states.values()][0]).toMatchObject({ phase: "settled" }); expect([...f.states.values()][0]).not.toHaveProperty("resumeReserved");
  } finally { await projector.close(); }
});
test.each(["upgrade_required", "capability_changed", "component_unsupported"])("a correlated native %s submit refusal settles once without replaying or inventing a receipt", async code => {
  const f = fixture(); f.acknowledge();
  vi.mocked(f.options.submitImageCapture!).mockRejectedValueOnce(new ImageCaptureRequestError({ code, message: "Direct capture cannot be accepted by the current component." }));
  const projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [f.slot]); await projector.settled(); projector.acknowledged(); await projector.settled();
    expect(f.options.submitImageCapture).toHaveBeenCalledOnce(); expect(f.options.queryImageCapture).not.toHaveBeenCalled(); expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
    expect([...f.states.values()][0]).toMatchObject({ phase: "settled", part: { type: "image_unavailable", error: { code } } });
    expect(f.entries.at(-1)).toMatchObject({ content: [{ text: "before" }, { type: "image_unavailable", error: { code } }, { text: "after" }] });
  } finally { await projector.close(); }
});
test.each(["capture_conflict", "resource_conflict", "session_conflict"])("a correlated %s followed by exact absence settles its original refusal after reopen", async code => {
  const f = fixture(); f.acknowledge();
  vi.mocked(f.options.submitImageCapture!).mockRejectedValueOnce(new ImageCaptureRequestError({ code, message: "The original capture cannot be accepted." }));
  let projector = new ProviderImageProjector(f.options);
  projector.publish(f.entry, [f.slot]); await projector.settled(); await projector.close();
  expect([...f.states.values()][0]).toMatchObject({ phase: "query", submissionRefusal: { code } });
  vi.mocked(f.options.queryImageCapture!).mockRejectedValueOnce(new ImageCaptureRequestError({ code: "capture_not_found", message: "Original capture is absent." }));
  projector = new ProviderImageProjector(f.options);
  try {
    projector.publish(f.entry, [{ ...f.slot, payload: { kind: "pending" } }]); await projector.settled(); projector.acknowledged(); await projector.settled();
    expect(f.options.submitImageCapture).toHaveBeenCalledOnce(); expect(f.options.stageImageCapture).toHaveBeenCalledOnce();
    expect([...f.states.values()][0]).toMatchObject({ phase: "settled", part: { type: "image_unavailable", error: { code } } });
    expect([...f.states.values()][0]).not.toHaveProperty("submissionRefusal");
  } finally { await projector.close(); }
});