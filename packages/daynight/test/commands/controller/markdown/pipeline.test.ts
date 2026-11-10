import { expect, test } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { openControllerLifecycleStore } from "../../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../../src/commands/controller/launch-ticket.js";
import { randomUUID } from "node:crypto";
import { createMarkdownTimelinePipeline } from "../../../../src/commands/controller/markdown/pipeline.js";
import { createMarkdownImageProjector } from "../../../../src/commands/controller/markdown/projection.js";
import type { ProviderEntry } from "../../../../src/commands/controller/providers/types.js";
import type { ImageCaptureReceipt, ImageCaptureRequest, ImageOccurrence } from "../../../../src/session/image-values.js";
const id = randomUUID(), entry = (text: string): ProviderEntry => ({ entryId: id, revision: "1", kind: "assistant_message", content: [{ type: "text", text }] });
function fixture() {
  const values = new Map<string, unknown>(), events: string[] = [], published: ProviderEntry[] = [], sources = new Map<string, ImageOccurrence>(), errors: unknown[] = [];
  const store = { get: <T>(kind: string, key: string) => values.get(`${kind}:${key}`) as T ?? null, put(kind: string, key: string, value: unknown) { values.set(`${kind}:${key}`, structuredClone(value)); events.push(`store:${kind}`); }, listIds(kind: string, page: { after?: string; limit: number }) { const prefix = kind + ":"; return [...values.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)).sort().filter(key => page.after === undefined || key > page.after).slice(0, page.limit); } };
  const journal = { markdownStore: store, projectTimeline(value: ProviderEntry) { published.push(structuredClone(value)); events.push("timeline"); return null; }, markProjectionGap() { events.push("gap"); } };
  const captures = { contextKey: () => "trusted-context", contextFor: (occurrence: ImageOccurrence) => ({ contextId: "trusted", partId: occurrence.partId }), enqueue(occurrence: ImageOccurrence) { sources.set(occurrence.imageId, occurrence); events.push("source"); }, get: (imageId: string) => sources.get(imageId) ?? null };
  return { values, events, published, sources, errors, journal, captures };
}
const complete = { complete: true, format: "markdown" as const, truncated: false };

test("timeline accepts body synchronously before parsing and only enqueues sources after the durable complete projection", async () => {
  const f = fixture(), pipeline = createMarkdownTimelinePipeline({ journal: f.journal, captures: f.captures, onError: error => { f.errors.push(error); } });
  pipeline.accept(entry("![a](one.png)"), complete);
  expect(f.events).toEqual(["store:projection", "timeline"]); expect(f.sources.size).toBe(0);
  await pipeline.drain(); expect(f.sources.size).toBe(1); expect(pipeline.hasPending()).toBe(false);
  expect(f.events.slice(-3)).toEqual(["store:projection", "timeline", "source"]); expect(f.errors).toEqual([]);
});

test("an older parser completion cannot overwrite a newer body or enqueue its sources", async () => {
  const f = fixture(); let release!: () => void, begun!: () => void;
  const began = new Promise<void>(resolve => { begun = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const projector = createMarkdownImageProjector({ parse: async text => { if (first) { first = false; begun(); await gate; } const destination = text.includes("old.png") ? "old.png" : "new.png"; return [{ start: 0, end: text.length, destination, label: "a", linkHref: null }]; } });
  const pipeline = createMarkdownTimelinePipeline({ journal: f.journal, captures: f.captures, onError: error => { f.errors.push(error); }, projector });
  pipeline.accept(entry("![a](old.png)"), complete); const ticking = pipeline.tick(); await began;
  pipeline.accept(entry("![a](new.png)"), complete); release(); await ticking;
  expect(f.sources.size).toBe(0); await pipeline.drain();
  expect(f.sources.size).toBe(1); expect(f.published.at(-1)).toMatchObject({ content: [{ text: "![a](new.png)" }] });
});

test("a recovered complete projection replays the original IDs even when source intent creation was interrupted", async () => {
  const f = fixture(), first = createMarkdownTimelinePipeline({ journal: f.journal, captures: f.captures, onError: error => { f.errors.push(error); } });
  first.accept(entry("![a](one.png)"), complete); await first.drain(); const original = [...f.sources.keys()]; await first.stop(); f.sources.clear();
  const reopened = createMarkdownTimelinePipeline({ journal: f.journal, captures: f.captures, onError: error => { f.errors.push(error); } });
  await reopened.drain(); expect([...f.sources.keys()]).toEqual(original); expect(f.errors).toEqual([]);
});

test("multi-block Markdown without trusted native identities preserves all text and publishes explicit projection failure", async () => {
  const f = fixture(), pipeline = createMarkdownTimelinePipeline({ journal: f.journal, captures: f.captures, onError: error => { f.errors.push(error); } });
  const input: ProviderEntry = { ...entry("unused"), kind: "assistant_message", content: [{ type: "text", text: "![a](one.png)" }, { type: "text", text: "![b](two.png)" }] };
  pipeline.accept(input, complete); await pipeline.drain();
  expect(f.published.at(-1)).toMatchObject({ imageProjectionError: { code: "source_unavailable" }, content: [{ type: "text", text: "![a](one.png)" }, { type: "markdown", text: "", bindings: [] }, { type: "text", text: "![b](two.png)" }] });
  expect(f.sources.size).toBe(0); expect(f.events).not.toContain("gap");
});

test("stop joins the current parser and does not enqueue source work after the stop boundary", async () => {
  const f = fixture(); let release!: () => void, begun!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { begun = resolve; });
  const projector = createMarkdownImageProjector({ parse: async text => { begun(); await gate; return [{ start: 0, end: text.length, destination: "one.png", label: "a", linkHref: null }]; } });
  const pipeline = createMarkdownTimelinePipeline({ journal: f.journal, captures: f.captures, onError: error => { f.errors.push(error); }, projector });
  pipeline.accept(entry("![a](one.png)"), complete); const tick = pipeline.tick(); await began; let joined = false;
  const stop = pipeline.stop().then(() => { joined = true; }); await Promise.resolve(); expect(joined).toBe(false);
  release(); await Promise.all([tick, stop]); expect(joined).toBe(true); expect(f.sources.size).toBe(0);
  expect(pipeline.accept(entry("later"), complete)).toBe(false);
});

test("parser failure remains an explicit entry error and never creates an irreversible journal gap", async () => {
  const f = fixture(), projector = createMarkdownImageProjector({ parse: async () => { throw new Error("parser failed"); } });
  const pipeline = createMarkdownTimelinePipeline({ journal: f.journal, captures: f.captures, onError: error => { f.errors.push(error); }, projector });
  pipeline.accept(entry("![a](one.png)"), complete); await pipeline.drain();
  expect(f.published.at(-1)).toMatchObject({ imageProjectionError: { code: "source_unavailable" } });
  expect(f.events).not.toContain("gap"); expect(f.sources.size).toBe(0);
});

test("a persistent storage failure stops drain with a visible gap rather than an unbounded retry loop", async () => {
  const f = fixture(), original = f.journal.markdownStore.put.bind(f.journal.markdownStore); let writes = 0;
  f.journal.markdownStore.put = (kind, key, value) => { if (++writes === 2) throw new Error("capacity"); original(kind, key, value); };
  const pipeline = createMarkdownTimelinePipeline({ journal: f.journal, captures: f.captures, onError: error => { f.errors.push(error); } });
  pipeline.accept(entry("![a](one.png)"), complete);
  await expect(pipeline.drain()).rejects.toThrow("persistence"); expect(f.events).toContain("gap"); expect(f.errors).toHaveLength(1);
});

test("stop parses trusted pending bodies without starting capture and marks incomplete streams as explicit failures", async () => {
  const completeFixture = fixture(), completed = createMarkdownTimelinePipeline({ journal: completeFixture.journal, captures: completeFixture.captures, onError: error => { completeFixture.errors.push(error); } });
  completed.accept(entry("![a](one.png)"), complete); await completed.stop();
  expect(completeFixture.published.at(-1)).toMatchObject({ imageProjectionError: null, content: [{ complete: true, bindings: [{ part: { type: "image_unavailable" } }] }] });
  expect(completeFixture.sources.size).toBe(0);
  const streamFixture = fixture(), streaming = createMarkdownTimelinePipeline({ journal: streamFixture.journal, captures: streamFixture.captures, onError: error => { streamFixture.errors.push(error); } });
  streaming.accept(entry("![a](one.png)"), { ...complete, complete: false }); await streaming.stop();
  expect(streamFixture.published.at(-1)).toMatchObject({ imageProjectionError: { code: "source_unavailable" }, content: [{ type: "text", text: "![a](one.png)" }, { type: "markdown", text: "", bindings: [] }] });
  expect(streamFixture.sources.size).toBe(0); expect(streamFixture.events).not.toContain("gap");
});

test("receipts preserve unavailable placeholders until committed and a late commit updates the original retained image", async () => {
  const f = fixture(), pipeline = createMarkdownTimelinePipeline({ journal: f.journal, captures: f.captures, onError: error => { f.errors.push(error); } });
  pipeline.accept(entry("![original](one.png)"), complete); await pipeline.drain();
  const occurrence = [...f.sources.values()][0]!, request: ImageCaptureRequest = { captureId: randomUUID(), attemptId: randomUUID(), occurrence, locator: { kind: "local", path: "one.png", contextId: randomUUID() }, nativeSource: null }, resourceId = randomUUID();
  const reserved: ImageCaptureReceipt = { captureId: request.captureId, attemptId: request.attemptId, revision: "1", occurrence, state: "reserved", resourceId, resource: null, error: null };
  pipeline.receipt(request, reserved);
  expect(f.published.at(-1)).toMatchObject({ content: [{ bindings: [{ part: { type: "image_unavailable", label: "original" } }] }] });
  pipeline.accept(entry("changed body"), complete); await pipeline.drain();
  const committed: ImageCaptureReceipt = { ...reserved, revision: "2", state: "committed", resource: { resourceId, status: "available", name: "saved.png", mediaType: "image/png", byteLength: "1", sha256: "a".repeat(64), error: null } };
  pipeline.receipt(request, committed);
  expect(f.published.at(-1)).toMatchObject({ content: [{ text: "changed body", bindings: [], retainedImages: [{ imageId: occurrence.imageId, part: { type: "image", resourceId, label: "original" } }] }] });
  expect(f.errors).toEqual([]);
});

test("source failures preserve the original label and never masquerade as an available resource", async () => {
  const f = fixture(), pipeline = createMarkdownTimelinePipeline({ journal: f.journal, captures: f.captures, onError: error => { f.errors.push(error); } });
  pipeline.accept(entry("![original](one.png)"), complete); await pipeline.drain();
  const occurrence = [...f.sources.values()][0]!;
  pipeline.failure(occurrence, { code: "source_forbidden", message: "Source is outside the authorized roots." });
  expect(f.published.at(-1)).toMatchObject({ content: [{ bindings: [{ part: { type: "image_unavailable", label: "original", error: { code: "source_forbidden" } } }] }] });
});

test("real journal close and reopen retain the original projection and occurrence IDs before source intent replay", async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../../.tmp/pipeline-journal-tests"); await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "case-")), file = path.join(cwd, "journal.sqlite"), f = fixture();
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", testExecutionId: randomUUID(), ownerUserId: randomUUID(), initialInput: "none", provider: "codex", cwd, nativeHome: path.join(cwd, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "", resumeNativeSessionId: null, credentialFile: path.join(cwd, "grant.json"), ipcEndpoint: path.join(cwd, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  let journal = openControllerLifecycleStore(file, ticket);
  try {
    const first = createMarkdownTimelinePipeline({ journal, captures: f.captures, onError: error => { f.errors.push(error); } });
    first.accept(entry("![a](one.png)"), complete); await first.drain(); const original = [...f.sources.keys()]; await first.stop(); journal.close();
    f.sources.clear(); journal = openControllerLifecycleStore(file, ticket);
    const second = createMarkdownTimelinePipeline({ journal, captures: f.captures, onError: error => { f.errors.push(error); } });
    await second.drain(); expect([...f.sources.keys()]).toEqual(original); expect(journal.hasTimelineEntry(id)).toBe(true); expect(f.errors).toEqual([]); await second.stop();
  } finally { journal.close(); await rm(cwd, { force: true, recursive: true }); }
});
