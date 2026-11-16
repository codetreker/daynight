import { expect, test, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { parseTimelineEntry } from "../../../../src/session/protocol.js";
import type { ProviderEntry } from "../../../../src/commands/controller/providers/types.js";
import { createMarkdownImageProjector, type MarkdownProjectionMetadata } from "../../../../src/commands/controller/markdown/projection.js";
import { MarkdownAnalysisError, parseMarkdownImages } from "../../../../src/commands/controller/markdown/parser.js";
const id = randomUUID(), hash = (text: string) => createHash("sha256").update(text).digest("hex");
const entry = (text: string, entryId = id): ProviderEntry => ({ entryId, kind: "assistant_message", revision: "1", content: [{ type: "text", text }] });
const meta = (complete = true, contextKey = "trusted-context"): MarkdownProjectionMetadata => ({ parts: [{ inputIndex: 0, sourceKey: `${id}:body`, complete, truncated: false, format: "markdown", contextKey }] });
const valid = (value: ProviderEntry) => parseTimelineEntry({ ...value, entrySeq: "1" });

test("streaming text is published synchronously with a durable opaque part identity and never parsed", () => {
  const parse = vi.fn(async () => [{ start: 0, end: 9, destination: "x.png", label: "a", linkHref: null }]), projector = createMarkdownImageProjector({ parse });
  const first = projector.prepare(entry("![a](x.png)"), meta(false), null);
  expect(first.entry).toMatchObject({ content: [{ type: "markdown", text: "![a](x.png)", complete: false, bindings: [] }] });
  expect(parse).not.toHaveBeenCalled(); valid(first.entry);
  const reopened = JSON.parse(JSON.stringify(first.state));
  const changed = projector.prepare(entry("prefix ![a](x.png)"), meta(false), reopened);
  const a = first.entry.kind === "assistant_message" ? first.entry.content[0] : null, b = changed.entry.kind === "assistant_message" ? changed.entry.content[0] : null;
  expect(a).toHaveProperty("partId"); expect(b).toHaveProperty("partId", a && "partId" in a ? a.partId : null);
  expect(b).toHaveProperty("revision", "2"); expect(b).toHaveProperty("textSha256", hash("prefix ![a](x.png)"));
});

test("complete real AST nodes produce distinct immutable occurrences and unchanged bodies reuse the original image IDs", async () => {
  const projector = createMarkdownImageProjector(), source = "![a](one.png) ![a](one.png)", prepared = projector.prepare(entry(source), meta(), null);
  const done = await projector.complete(prepared.state);
  expect(done.occurrences).toHaveLength(2); expect(done.occurrences[0]!.occurrence.imageId).not.toBe(done.occurrences[1]!.occurrence.imageId);
  expect(done.occurrences[0]).toMatchObject({ destination: "one.png", contextKey: "trusted-context", occurrence: { entryId: id, container: "content", sourceRevision: "1", sourceTextSha256: hash(source) } }); valid(done.entry);
  const again = projector.prepare(entry(source), meta(), JSON.parse(JSON.stringify(done.state)));
  expect(again.entry).toEqual(done.entry);
  const repeated = await projector.complete(again.state); expect(repeated.occurrences).toEqual([]); expect(repeated.entry).toEqual(done.entry);
});

test("revision, locator and trusted context changes retain the old images and late capture completion stays in the original container", async () => {
  const projector = createMarkdownImageProjector(), original = await projector.complete(projector.prepare(entry("![a](one.png)"), meta(), null).state);
  const originalImage = original.occurrences[0]!, prepared = projector.prepare(entry("![b](two.png)"), meta(), original.state);
  expect(prepared.entry).toMatchObject({ content: [{ complete: false, bindings: [], retainedImages: [{ imageId: originalImage.occurrence.imageId, sourceRevision: "1" }] }] });
  const changed = await projector.complete(prepared.state); expect(changed.occurrences).toHaveLength(1);
  expect(changed.occurrences[0]!.occurrence.imageId).not.toBe(originalImage.occurrence.imageId);
  const late = projector.updateImagePart(changed.state, originalImage.occurrence.imageId, { type: "image", imageId: originalImage.occurrence.imageId, resourceId: randomUUID(), label: "original" });
  expect(late.entry).toMatchObject({ content: [{ bindings: [{ imageId: changed.occurrences[0]!.occurrence.imageId }], retainedImages: [{ imageId: originalImage.occurrence.imageId, part: { type: "image", label: "original" } }] }] }); valid(late.entry);
  const context = await projector.complete(projector.prepare(entry("![b](two.png)"), meta(true, "other-trusted-context"), late.state).state);
  expect(context.occurrences[0]!.occurrence.imageId).not.toBe(changed.occurrences[0]!.occurrence.imageId);
  expect(context.entry).toMatchObject({ content: [{ retainedImages: expect.arrayContaining([expect.objectContaining({ imageId: originalImage.occurrence.imageId }), expect.objectContaining({ imageId: changed.occurrences[0]!.occurrence.imageId })]) }] });
});

test("removed body parts keep their durable part IDs and capture ownership without copying text", async () => {
  const projector = createMarkdownImageProjector(), original = await projector.complete(projector.prepare(entry("![a](one.png)"), meta(), null).state);
  const cleared = projector.prepare({ entryId: id, revision: "2", kind: "assistant_message", content: [] }, { parts: [] }, original.state);
  expect(cleared.entry).toMatchObject({ content: [{ type: "markdown", text: "", complete: true, bindings: [], partId: original.occurrences[0]!.occurrence.partId, retainedImages: [{ imageId: original.occurrences[0]!.occurrence.imageId }] }] });
  valid(cleared.entry);
});

test("parser failure preserves current readable text, all prior images and an explicit strict failure container", async () => {
  let fail = false;
  const parse = async (text: string) => { if (fail) throw new Error("private parser diagnostic"); return (await import("../../../../src/commands/controller/markdown/parser.js")).parseMarkdownImages(text); };
  const projector = createMarkdownImageProjector({ parse }), original = await projector.complete(projector.prepare(entry("![a](one.png)"), meta(), null).state);
  fail = true;
  const failed = await projector.complete(projector.prepare(entry("new readable ![b](two.png)"), meta(), original.state).state);
  expect(failed.failed).toBe(true); expect(failed.occurrences).toEqual([]);
  expect(failed.entry).toMatchObject({ imageProjectionError: { code: "source_unavailable" }, content: [{ type: "text", text: "new readable ![b](two.png)" }, { type: "markdown", text: "", complete: true, truncated: false, textSha256: hash(""), bindings: [], retainedImages: [{ imageId: original.occurrences[0]!.occurrence.imageId }] }] }); valid(failed.entry);
  fail = false;
  const restored = await projector.complete(projector.prepare(entry("new readable ![b](two.png)"), meta(), failed.state).state);
  expect(restored.entry).toMatchObject({ imageProjectionError: null, content: [{ type: "markdown", revision: "4", text: "new readable ![b](two.png)" }] }); valid(restored.entry);
});

test("reasoning and explicitly Markdown tool output retain their original ownership while plain tools never parse", async () => {
  const projector = createMarkdownImageProjector(), reasoning: ProviderEntry = { entryId: id, revision: "1", kind: "reasoning", text: "![a](one.png)" };
  const reasoned = await projector.complete(projector.prepare(reasoning, meta(), null).state);
  expect(reasoned.occurrences[0]!.occurrence).toMatchObject({ container: "reasoning", callId: null });
  expect(reasoned.entry).toMatchObject({ markdown: { bindings: [{ imageId: reasoned.occurrences[0]!.occurrence.imageId }] } }); valid(reasoned.entry);
  const tool: ProviderEntry = { entryId: id, revision: "1", kind: "tool_call", callId: "native-call", name: "tool", input: "not parsed ![x](secret)", output: [{ type: "text", text: "![a](one.png)" }], status: "completed", truncated: false };
  const tooled = await projector.complete(projector.prepare(tool, meta(), null).state);
  expect(tooled.occurrences[0]!.occurrence).toMatchObject({ container: "tool_output", callId: "native-call" }); valid(tooled.entry);
  const parse = vi.fn(async () => []), plain = createMarkdownImageProjector({ parse });
  const result = await plain.complete(plain.prepare(tool, { parts: [{ ...meta().parts[0]!, format: "plain" }] }, null).state);
  expect(parse).not.toHaveBeenCalled(); expect(result.occurrences).toEqual([]);
});

test("a reasoning parse failure uses bindings null and never duplicates or loses the full readable body", async () => {
  const projector = createMarkdownImageProjector({ parse: async () => { throw new Error("failed"); } });
  const result = await projector.complete(projector.prepare({ entryId: id, revision: "1", kind: "reasoning", text: "![a](one.png)" }, meta(), null).state);
  expect(result.entry).toMatchObject({ text: "![a](one.png)", markdown: { bindings: null, textSha256: hash("![a](one.png)") }, imageProjectionError: { code: "source_unavailable" } }); valid(result.entry);
});

test("mixed native-image failures retain fixed slots and a protocol-valid adjacent failure envelope", async () => {
  const projector = createMarkdownImageProjector({ parse: async () => { throw new Error("Controlled parse failure"); } });
  const image = { type: "image" as const, imageId: randomUUID(), resourceId: randomUUID(), label: "Native" };
  const input: ProviderEntry = { ...entry("unused"), kind: "assistant_message", imageProjectionError: null, content: [{ type: "text", text: "![a](one.png)" }, image] };
  const failed = await projector.complete(projector.prepare(input, meta(), null).state); valid(failed.entry);
  expect(failed.entry).toMatchObject({ content: [{ type: "text", text: "![a](one.png)" }, image, { type: "text", text: "" }, { type: "markdown", text: "", bindings: [] }] });
});

test("native block identities survive reordering while array positions never become the image identities", async () => {
  const projector = createMarkdownImageProjector(), firstInput: ProviderEntry = { entryId: id, revision: "1", kind: "assistant_message", content: [{ type: "text", text: "![a](a.png)" }, { type: "text", text: "![b](b.png)" }] };
  const descriptors: MarkdownProjectionMetadata = { parts: [{ ...meta().parts[0]!, sourceKey: "native-a" }, { ...meta().parts[0]!, inputIndex: 1, sourceKey: "native-b" }] };
  const first = await projector.complete(projector.prepare(firstInput, descriptors, null).state);
  const swapped: ProviderEntry = { ...firstInput, content: [...firstInput.content].reverse() };
  const again = await projector.complete(projector.prepare(swapped, { parts: [{ ...descriptors.parts[1]!, inputIndex: 0 }, { ...descriptors.parts[0]!, inputIndex: 1 }] }, JSON.parse(JSON.stringify(first.state))).state);
  expect(again.occurrences).toEqual([]);
  expect(again.entry).toMatchObject({ content: [{ partId: first.occurrences[1]!.occurrence.partId, bindings: [{ imageId: first.occurrences[1]!.occurrence.imageId }] }, { partId: first.occurrences[0]!.occurrence.partId, bindings: [{ imageId: first.occurrences[0]!.occurrence.imageId }] }] }); valid(again.entry);
});

test("completion and resource updates advance the CAS token without changing a body's revision", async () => {
  const projector = createMarkdownImageProjector(), prepared = projector.prepare(entry("![a](one.png)"), meta(), null), done = await projector.complete(prepared.state);
  expect(done.token).toBe(prepared.state.token); expect(done.state.token).not.toBe(done.token);
  const imageId = done.occurrences[0]!.occurrence.imageId, updated = projector.updateImagePart(done.state, imageId, { type: "image", imageId, resourceId: randomUUID(), label: "saved" });
  expect(updated.token).toBe(done.state.token); expect(updated.state.token).not.toBe(updated.token);
  expect(updated.entry).toMatchObject({ content: [{ revision: "1", bindings: [{ part: { type: "image" } }] }] });
});

test("truncated text and incomplete syntax never authorize source reading or parsing", async () => {
  const parse = vi.fn(async () => []), projector = createMarkdownImageProjector({ parse });
  const result = await projector.complete(projector.prepare(entry("![a](one.png)"), { parts: [{ ...meta().parts[0]!, truncated: true }] }, null).state);
  expect(parse).not.toHaveBeenCalled(); expect(result.occurrences).toEqual([]); valid(result.entry);
});

test("the original one-MiB text capacity remains readable and oversized input is an explicit capacity failure", () => {
  const projector = createMarkdownImageProjector(), text = "x".repeat(1_048_576), prepared = projector.prepare(entry(text), meta(), null);
  expect(prepared.failed).toBe(false); valid(prepared.entry);
  expect(() => projector.prepare(entry(text + "x"), meta(), prepared.state)).toThrow("capacity");
});

test.each(["original text without images", "![new](new.png)"])("failed original bodies can be reparsed after serialization: %s", async text => {
  let fail = false;
  const projector = createMarkdownImageProjector({ parse: async body => { if (fail) throw new MarkdownAnalysisError("startup_timeout"); return parseMarkdownImages(body); } });
  const first = await projector.complete(projector.prepare(entry("![old](old.png)"), meta(), null).state);
  const old = first.occurrences[0]!, available = projector.updateImagePart(first.state, old.occurrence.imageId, { type: "image", imageId: old.occurrence.imageId, resourceId: randomUUID(), label: "original" });
  fail = true;
  const failed = await projector.complete(projector.prepare(entry(text), meta(), available.state).state), original = JSON.stringify(failed.state);
  expect(failed.state.parts[0]!.failureReason).toBe("startup_timeout");
  const prepared = projector.retryFailed(JSON.parse(original));
  expect(JSON.stringify(failed.state)).toBe(original);
  expect(prepared.token).toBe(failed.state.token); expect(prepared.state.token).not.toBe(prepared.token);
  expect(prepared.state.parts[0]).toMatchObject({ partId: failed.state.parts[0]!.partId, sourceKey: failed.state.parts[0]!.sourceKey, status: "pending", retained: failed.state.parts[0]!.retained });
  expect(projector.retryFailed(prepared.state).state).toEqual(prepared.state);
  fail = false;
  const repaired = await projector.complete(JSON.parse(JSON.stringify(prepared.state)));
  expect(repaired.failed).toBe(false); expect(repaired.pending).toBe(false); valid(repaired.entry);
  expect(repaired.entry).toMatchObject({ imageProjectionError: null, content: [{ type: "markdown", text, retainedImages: [{ imageId: old.occurrence.imageId, part: { type: "image" } }] }] });
  expect(repaired.occurrences).toHaveLength(text.includes("![") ? 1 : 0);
  expect(projector.retryFailed(repaired.state).state).toEqual(repaired.state);
  expect((await projector.complete(repaired.state)).entry).toEqual(repaired.entry);
});

test("retry failure preserves the readable body and retained resources without exposing parser diagnostics", async () => {
  const projector = createMarkdownImageProjector({ parse: async () => { throw new Error("private source path"); } });
  const failed = await projector.complete(projector.prepare(entry("![a](private.png)"), meta(), null).state);
  const repeated = await projector.complete(projector.retryFailed(failed.state).state);
  expect(repeated.failed).toBe(true); expect(repeated.state.input).toEqual(failed.state.input);
  expect(repeated.state.parts[0]!.failureReason).toBe("parse_failed");
  expect(JSON.stringify(repeated.state)).not.toContain("private source path");
  expect(repeated.entry).toMatchObject({ content: [{ type: "text", text: "![a](private.png)" }, { type: "markdown", text: "", retainedImages: [] }], imageProjectionError: { code: "source_unavailable" } }); valid(repeated.entry);
});

test("repair retains native slots committed after an adopted failure carrier", async () => {
  let fail = true;
  const projector = createMarkdownImageProjector({ parse: async text => { if (fail) throw new Error("controlled"); return parseMarkdownImages(text); } });
  const native = { type: "image" as const, imageId: randomUUID(), resourceId: randomUUID(), label: "native" };
  const appended = { ...native, imageId: randomUUID(), resourceId: randomUUID(), label: "appended" };
  const input: ProviderEntry = { ...entry("unused"), kind: "assistant_message", imageProjectionError: null, content: [{ type: "text", text: "![a](one.png)" }, native] };
  const failed = await projector.complete(projector.prepare(input, meta(), null).state);
  if (failed.entry.kind !== "assistant_message") throw new Error("Invalid fixture");
  const committed = { ...failed.entry, content: [...failed.entry.content, appended] }, adopted = projector.adoptCommitted(failed.state, committed);
  fail = false;
  const pending = projector.retryFailed(adopted); valid(pending.entry);
  const repaired = await projector.complete(pending.state); valid(repaired.entry);
  expect(repaired.entry).toMatchObject({ imageProjectionError: null, content: [
    { type: "markdown", text: "![a](one.png)", partId: failed.state.parts[0]!.partId, bindings: [{ imageId: repaired.occurrences[0]!.occurrence.imageId }] },
    native, { type: "text", text: "" }, { type: "text", text: "" }, appended,
  ] });
  expect(projector.retryFailed(repaired.state).entry).toEqual(repaired.entry);
});

test.each([
  ["hash", "projection_input_changed"], ["incomplete", "projection_input_incomplete"], ["truncated", "projection_input_incomplete"],
  ["ambiguous", "projection_identity_ambiguous"], ["identity", "projection_input_changed"], ["index", "projection_input_missing"],
  ["pending", "projection_input_changed"], ["removed-index", "projection_input_missing"], ["duplicate", "projection_identity_ambiguous"],
])("repair refuses %s changes without mutating the original projection", async (corruption, code) => {
  const projector = createMarkdownImageProjector({ parse: async () => { throw new Error("controlled"); } });
  const failed = await projector.complete(projector.prepare(entry("body"), meta(), null).state);
  const changed = JSON.parse(JSON.stringify(failed.state));
  if (corruption === "hash") changed.input.content[0].text = "changed";
  if (corruption === "incomplete") changed.parts[0].complete = false;
  if (corruption === "truncated") changed.parts[0].truncated = true;
  if (corruption === "ambiguous") changed.parts[0].sourceKey = `${id}:projection-unavailable`;
  if (corruption === "identity") changed.entryId = randomUUID();
  if (corruption === "index") changed.parts[0].inputIndex = 2;
  if (corruption === "pending") changed.pending = true;
  if (corruption === "removed-index") changed.parts[0].inputIndex = null;
  if (corruption === "duplicate") changed.parts.push(structuredClone(changed.parts[0]));
  const original = JSON.stringify(changed);
  expect(() => projector.retryFailed(changed)).toThrowError(expect.objectContaining({ code }));
  expect(JSON.stringify(changed)).toBe(original);
});
