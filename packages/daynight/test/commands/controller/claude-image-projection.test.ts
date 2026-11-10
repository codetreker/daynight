import { expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ClaudeProjection } from "../../../src/commands/controller/providers/claude-image-projection.js";
import type { NativeInput, ProviderEntry, ProviderOptions } from "../../../src/commands/controller/providers/types.js";
import type { ImageCaptureRequest } from "../../../src/session/image-values.js";

const fixture = () => {
  const saved = new Map<string, unknown>(), entries: ProviderEntry[] = [], occurrences: unknown[] = [];
  const options = { onTimeline: (entry: ProviderEntry) => entries.push(structuredClone(entry)), imageOccurrenceAcknowledged: () => false, onImageOccurrence: (occurrence: unknown) => { occurrences.push(occurrence); return true; }, imageRuntime: { readState: (key: string) => saved.get(key), writeState: (key: string, value: unknown) => saved.set(key, structuredClone(value)) } } as unknown as ProviderOptions;
  return { options, entries, saved, occurrences, sessionId: randomUUID() };
};
const image = { type: "image", source: { type: "url", url: "https://example.test/original.png" } };

test("stream, final blocks and cold history preserve the same image, text and reasoning identities", async () => {
  const f = fixture(), projection = new ClaudeProjection(f.options, f.sessionId, () => null);
  projection.stream({ type: "stream_event", event: { type: "message_start", message: { id: "message" } } });
  for (const [index, kind] of ["thinking", "text", "image"].entries()) {
    projection.stream({ type: "stream_event", event: { type: "content_block_start", index, content_block: kind === "image" ? image : { type: kind } } });
    if (kind !== "image") projection.stream({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: `${kind}_delta`, [kind]: kind } } });
    projection.message({ type: "assistant", uuid: `${kind}-uuid`, message: { id: "message", content: [kind === "image" ? image : { type: kind, [kind]: kind }] } });
  }
  const first = new Map(f.entries.map(entry => [entry.entryId, entry])); expect(first.size).toBe(3);
  expect([...first.values()].filter(entry => entry.kind === "reasoning")).toHaveLength(1);
  await projection.close();
  const reopened = new ClaudeProjection(f.options, f.sessionId, () => null);
  for (const [offset, kind] of ["thinking", "text", "image"].entries()) {
    const value = { type: "assistant", uuid: `${kind}-uuid`, message: { id: "message", content: [kind === "image" ? image : { type: kind, [kind]: kind }] } };
    reopened.message(value, { row: { value, media: [], assistantBlockOffset: offset }, reader: {} as never });
  }
  expect(new Set(f.entries.map(entry => entry.entryId))).toEqual(new Set(first.keys()));
  expect(new Set(f.occurrences.map((entry: any) => entry.imageId)).size).toBe(1); await reopened.close();
});

test("nested tool results preserve text/image order without serializing native image bytes", async () => {
  const f = fixture(), projection = new ClaudeProjection(f.options, f.sessionId, () => null);
  projection.message({ type: "user", uuid: "tool-result", message: { content: [{ type: "tool_result", tool_use_id: "call", content: [{ type: "text", text: "before" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "PRIVATE_BASE64" } }, { type: "text", text: "after" }] }] } });
  const output = f.entries.find(entry => entry.kind === "tool_call");
  expect(output).toMatchObject({ kind: "tool_call", output: [{ type: "text", text: "before" }, { type: "image_unavailable" }, { type: "text", text: "after" }] });
  expect(JSON.stringify(f.entries)).not.toContain("PRIVATE_BASE64"); await projection.close();
});

test("submitted and native user image positions reuse the original ordered identity", async () => {
  const f = fixture(), id = randomUUID(), original: NativeInput = { content: [{ type: "text", text: "look" }, ...[1, 2].map(() => ({ type: "image" as const, imageId: randomUUID(), resourceId: randomUUID(), byteLength: "1", sha256: "a".repeat(64), mediaType: "image/png", localPath: "/private/image" }))] };
  const projection = new ClaudeProjection(f.options, f.sessionId, value => value === id ? original : null);
  projection.dispatch(original, id); projection.message({ type: "user", uuid: id, message: { content: [{ type: "text", text: "look" }, image, image] } });
  const entries = f.entries.filter(entry => entry.kind === "user_message"); expect(new Set(entries.map(entry => entry.entryId)).size).toBe(1);
  expect(entries.at(-1)).toMatchObject({ content: [{ type: "text", text: "look" }, { type: "image_unavailable", imageId: (original.content[1] as any).imageId }, { type: "image_unavailable", imageId: (original.content[2] as any).imageId }] }); await projection.close();
});

test("closing history projection cancels a source waiting for its page acknowledgement", async () => {
  const f = fixture(); let reserved!: () => void;
  const entered = new Promise<void>(resolve => { reserved = resolve; }), write = f.options.imageRuntime!.writeState;
  f.options.imageRuntime!.writeState = (key, value) => { write(key, value); if ((value as any).phase === "reserved") reserved(); };
  f.options.imageOccurrenceAcknowledged = () => true;
  f.options.registerImageCapture = async (request: ImageCaptureRequest) => ({ captureId: request.captureId, attemptId: request.attemptId, revision: "1", occurrence: request.occurrence, state: "reserved", resourceId: null, resource: null, error: null });
  f.options.queryImageCapture = vi.fn(); f.options.stageImageCapture = vi.fn(); f.options.commitImageCapture = vi.fn(); f.options.failImageCapture = vi.fn(); f.options.imageRuntime!.createSpool = vi.fn();
  const projection = new ClaudeProjection(f.options, f.sessionId, () => null), readMedia = vi.fn();
  const value = { type: "assistant", uuid: "history", message: { id: "history-message", content: [{ type: "image", source: { type: "base64", data: null } }] } };
  projection.message(value, { acknowledged: new Promise(() => {}), reader: { readMedia } as never, row: { value, assistantBlockOffset: 0, media: [{ mediaId: "source", path: ["message", "content", 0, "source", "data"], mediaType: "image/png", byteLength: 3, state: "available", error: null }] } });
  await entered; await projection.close();
  expect(readMedia).not.toHaveBeenCalled(); expect(f.options.imageRuntime!.createSpool).not.toHaveBeenCalled();
}, 2000);

test.each(["text", "thinking"])("cold history restores %s ordinals before a new sibling in the same native message", async kind => {
  const f = fixture(), message = (uuid: string, text: string) => ({ type: "assistant", uuid, message: { id: "same-message", content: [{ type: kind, [kind]: text }] } });
  const first = message("first", "first block");
  let projection = new ClaudeProjection(f.options, f.sessionId, () => null); projection.message(first); await projection.close();
  const originalId = f.entries.at(-1)!.entryId;
  projection = new ClaudeProjection(f.options, f.sessionId, () => null);
  projection.message(first, { row: { value: first, media: [], assistantBlockOffset: 0 }, reader: {} as never });
  const next = message("next", "next block"); projection.message(next, { row: { value: next, media: [], assistantBlockOffset: 1 }, reader: {} as never }); await projection.close();
  expect(f.entries[1]!.entryId).toBe(originalId); expect(f.entries[2]!.entryId).not.toBe(originalId);
  expect(new Set(f.entries.map(entry => entry.entryId)).size).toBe(2);
});

test.each(["text", "thinking"])("a cold %s stream alias reserves its ordinal before final-only siblings", async kind => {
  const f = fixture(); let projection = new ClaudeProjection(f.options, f.sessionId, () => null);
  projection.stream({ type: "stream_event", event: { type: "message_start", message: { id: "same-message" } } });
  projection.stream({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: kind } } });
  projection.stream({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: `${kind}_delta`, [kind]: "first block" } } });
  await projection.close(); const originalId = f.entries.at(-1)!.entryId;
  projection = new ClaudeProjection(f.options, f.sessionId, () => null);
  for (const [offset, text] of ["first block", "next block"].entries()) {
    const value = { type: "assistant", uuid: `final-${offset}`, message: { id: "same-message", content: [{ type: kind, [kind]: text }] } };
    projection.message(value, { row: { value, media: [], assistantBlockOffset: offset }, reader: {} as never });
  }
  await projection.close(); expect(f.entries[1]!.entryId).toBe(originalId); expect(f.entries[2]!.entryId).not.toBe(originalId); expect(new Set(f.entries.map(entry => entry.entryId)).size).toBe(2);
});
