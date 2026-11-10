import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { createMarkdownTimelinePipeline } from "../../../src/commands/controller/markdown/pipeline.js";
import type { MarkdownProjectionState } from "../../../src/commands/controller/markdown/projection.js";
import { CodexImageInputs, encodeCodexInput } from "../../../src/commands/controller/providers/codex-image-input.js";
import { CodexImageProjection } from "../../../src/commands/controller/providers/codex-image-projection.js";
import { ProviderImageProjector } from "../../../src/commands/controller/providers/image-projector.js";
import type { MarkdownTimelineMetadata, NativeImagePart, NativeInput, ProviderEntry, ProviderOptions } from "../../../src/commands/controller/providers/types.js";
import type { ImageCaptureRequest, ImageOccurrence, InputObservation, NativeImageSource } from "../../../src/session/image-values.js";

const text = { type: "text" as const, text: "![plot](plot.png)" };
const nativeImage = (): NativeImagePart => ({ type: "image", imageId: randomUUID(), resourceId: randomUUID(), mediaType: "image/png", byteLength: "3", sha256: "a".repeat(64), localPath: "/private/native-image" });

function fixture(input: NativeInput = { content: [text, nativeImage()] }) {
  const operationId = randomUUID(), intentSha256 = "b".repeat(64), states = new Map<string, unknown>();
  const published: ProviderEntry[] = [], metadata: (MarkdownTimelineMetadata | undefined)[] = [], errors: unknown[] = [], observations: (string | InputObservation)[] = [];
  const native: { occurrence: ImageOccurrence; source: NativeImageSource | null }[] = [], sources = new Map<string, { occurrence: ImageOccurrence; destination: string }>();
  const store = {
    get: <T>(kind: string, key: string) => states.get(`${kind}:${key}`) as T ?? null,
    put(kind: string, key: string, value: unknown) { states.set(`${kind}:${key}`, structuredClone(value)); },
    listIds(kind: string, page: { after?: string; limit: number }) { const prefix = kind + ":"; return [...states.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)).sort().filter(key => page.after === undefined || key > page.after).slice(0, page.limit); },
  };
  const journal = {
    markdownStore: store,
    getTimelineEntry: (entryId: string) => published.findLast(entry => entry.entryId === entryId),
    publishMarkdownProjection(state: MarkdownProjectionState, entry: ProviderEntry) { store.put("projection", state.entryId, state); this.projectTimeline(entry); },
    projectTimeline(entry: ProviderEntry) { published.push(structuredClone(entry)); },
  };
  const captures = {
    contextKey: () => "trusted-context",
    contextFor: (occurrence: ImageOccurrence) => ({ partId: occurrence.partId }),
    enqueue(occurrence: ImageOccurrence, destination: string) { sources.set(occurrence.imageId, { occurrence, destination }); },
    get: (imageId: string) => sources.get(imageId) ?? null,
  };
  const pipeline = createMarkdownTimelinePipeline({ journal, captures, onError: error => { errors.push(error); } });
  const intent = { sha256: intentSha256, state: "unknown", command: { kind: "send_message", operationId, payload: { expectedTurnId: null, target: { expectedNativeSessionId: null }, content: input.content.map(part => part.type === "text" ? part : { ...part, uploadId: randomUUID() }) } } };
  const options = {
    cwd: "/authorized/worktree",
    imageRuntime: {
      readState: (key: string) => states.get(key) ?? null,
      writeState: (key: string, value: unknown) => states.set(key, structuredClone(value)),
      getIntent: (id: string) => id === operationId ? intent : null,
    },
    onTimeline(entry: ProviderEntry, value?: MarkdownTimelineMetadata) { metadata.push(value); pipeline.accept(entry, value); },
    onInputObserved(observation: string | InputObservation) { observations.push(observation); return true; },
    onImageOccurrence(occurrence: ImageOccurrence, source: NativeImageSource | null) { native.push({ occurrence, source }); return true; },
    imageOccurrenceAcknowledged: () => false,
  } as unknown as ProviderOptions;
  const inputs = new CodexImageInputs(options, "thread"), publisher = new ProviderImageProjector(options);
  inputs.prepare(input, operationId, null);
  const projection = new CodexImageProjection("thread", options, inputs, publisher);
  const latest = () => { const entry = published.at(-1)!; if (entry.kind !== "user_message") throw new Error("Expected a user message"); return entry; };
  const commit = (occurrence: ImageOccurrence) => {
    const request: ImageCaptureRequest = { captureId: randomUUID(), attemptId: randomUUID(), occurrence, locator: { kind: "local", path: "plot.png", contextId: randomUUID() }, nativeSource: null }, resourceId = randomUUID();
    pipeline.receipt(request, { captureId: request.captureId, attemptId: request.attemptId, revision: "2", occurrence, state: "committed", resourceId, resource: { resourceId, status: "available", name: "saved.png", mediaType: "image/png", byteLength: "1", sha256: "c".repeat(64), error: null }, error: null });
    return resourceId;
  };
  return { input, operationId, intentSha256, options, inputs, publisher, projection, pipeline, sources, native, observations, metadata, errors, latest, commit,
    async close() { try { await publisher.close(); } finally { await pipeline.stop(); } },
  };
}

test.each([0, 1])("accepted Codex input captures its unique Markdown text at index %i without moving native images", async textIndex => {
  const image = nativeImage(), imageIndex = 1 - textIndex, input = { content: textIndex === 0 ? [text, image] : [image, text] }, f = fixture(input);
  try {
    const match = f.inputs.accepted(f.operationId, "turn")!;
    expect(f.projection.acceptedInput(match, input)).toBe(true);
    await f.pipeline.drain();
    expect([...f.sources.values()]).toHaveLength(1);
    const source = [...f.sources.values()][0]!;
    expect(source.destination).toBe("plot.png");
    expect(f.latest().content[textIndex]).toMatchObject({ type: "markdown", partId: source.occurrence.partId, complete: true, bindings: [{ part: { imageId: source.occurrence.imageId } }] });
    expect(f.latest().content[imageIndex]).toMatchObject({ type: "image_unavailable", imageId: image.imageId });
    expect(f.native).toEqual([{ occurrence: expect.objectContaining({ imageId: image.imageId, entryId: match.entryId, partId: null }), source: { provider: "codex", nativeSessionId: "thread", nativeMessageId: f.operationId, nativePartId: `content/${imageIndex}` } }]);
    expect(f.observations).toEqual([{ operationId: f.operationId, nativeSessionId: "thread", intentSha256: f.intentSha256, nativeMessageId: f.operationId, provider: "codex" }]);
    const resourceId = f.commit(source.occurrence), nativePart = f.latest().content[imageIndex];
    expect(f.projection.acceptedInput(match, input)).toBe(true); await f.pipeline.drain();
    expect(f.latest().content[textIndex]).toMatchObject({ type: "markdown", partId: source.occurrence.partId, bindings: [{ part: { type: "image", imageId: source.occurrence.imageId, resourceId } }] });
    expect(f.latest().content[imageIndex]).toEqual(nativePart); expect(f.sources.size).toBe(1); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test.each(["localImage", "image"])("Codex %s history waits for completion and keeps Markdown and native identities on replay", async type => {
  const f = fixture(), image = type === "localImage" ? { type, path: "/authorized/worktree/native.png" } : { type, url: "https://images.example/native.png" };
  const item = { id: "history", type: "userMessage", content: [image, text] };
  try {
    expect(f.projection.item(item, false, "turn")).toBe(true); await f.pipeline.drain();
    expect(f.sources.size).toBe(0);
    const streaming = f.latest().content[1], nativePart = f.latest().content[0];
    expect(streaming).toMatchObject({ type: "markdown", complete: false });
    expect(f.projection.item(item, true, "turn")).toBe(true); await f.pipeline.drain();
    expect([...f.sources.values()]).toHaveLength(1);
    const source = [...f.sources.values()][0]!, resourceId = f.commit(source.occurrence);
    expect(source.destination).toBe("plot.png");
    expect(streaming).toHaveProperty("partId", source.occurrence.partId);
    expect(f.projection.item(item, true, "turn")).toBe(true); await f.pipeline.drain();
    expect(f.latest().content[1]).toMatchObject({ type: "markdown", partId: source.occurrence.partId, complete: true, bindings: [{ part: { type: "image", imageId: source.occurrence.imageId, resourceId } }] });
    expect(f.latest().content[0]).toEqual(nativePart);
    expect(f.native).toHaveLength(1); expect(f.native[0]!.source).toMatchObject({ nativeMessageId: "history", nativePartId: "content/0" });
    expect(f.sources.size).toBe(1); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("resumed Codex history aliases retain the original input, Markdown receipt and native position", async () => {
  const image = nativeImage(), f = fixture({ content: [text, image] });
  try {
    const match = f.inputs.accepted(f.operationId, "turn")!;
    f.projection.acceptedInput(match, f.input); await f.pipeline.drain();
    expect([...f.sources.values()]).toHaveLength(1);
    const source = [...f.sources.values()][0]!, resourceId = f.commit(source.occurrence);
    const resumed = new CodexImageProjection("thread", f.options, new CodexImageInputs(f.options, "thread"), f.publisher);
    expect(resumed.item({ id: "resumed-item", type: "userMessage", clientId: f.operationId, content: encodeCodexInput(f.input) }, true, "turn")).toBe(true); await f.pipeline.drain();
    expect(f.latest()).toMatchObject({ entryId: match.entryId, content: [{ type: "markdown", partId: source.occurrence.partId, bindings: [{ part: { type: "image", imageId: source.occurrence.imageId, resourceId } }] }, { type: "image_unavailable", imageId: image.imageId }] });
    expect(f.native).toHaveLength(1); expect(f.sources.size).toBe(1);
    expect(f.observations).toEqual([match.observation, match.observation]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test.each([
  { name: "multiple text blocks", format: "plain", truncated: false, content: [text, { type: "text", text: "second" }] },
  { name: "an unknown content block", format: "plain", truncated: false, content: [text, { type: "unknown", text: "extra" }] },
  { name: "a malformed text block", format: "plain", truncated: false, content: [text, { type: "text", text: null }] },
  { name: "no text block", format: "plain", truncated: false, content: [] },
  { name: "a truncated text block", format: "markdown", truncated: true, content: [{ type: "text", text: text.text + "x".repeat(200_000) }] },
])("Codex history with $name never starts Markdown source capture", async ({ content, format, truncated }) => {
  const f = fixture();
  try {
    expect(f.projection.item({ id: "history", type: "userMessage", content: [...content, { type: "localImage", path: "/private/native-image" }] }, true, "turn")).toBe(true); await f.pipeline.drain();
    expect(f.metadata.at(-1)).toEqual({ complete: true, format, truncated });
    expect(f.sources.size).toBe(0); expect(f.native).toHaveLength(1); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test.each([
  { name: "multiple text blocks", format: "plain", truncated: false, content: [text, { type: "text" as const, text: "second" }] },
  { name: "a truncated text block", format: "markdown", truncated: true, content: [{ type: "text" as const, text: text.text + "x".repeat(200_000) }] },
])("accepted Codex input with $name never starts Markdown source capture", async ({ content, format, truncated }) => {
  const f = fixture({ content: [...content, nativeImage()] });
  try {
    expect(f.projection.acceptedInput(f.inputs.accepted(f.operationId, "turn")!, f.input)).toBe(true); await f.pipeline.drain();
    expect(f.metadata.at(-1)).toEqual({ complete: true, format, truncated });
    expect(f.sources.size).toBe(0); expect(f.native).toHaveLength(1); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
