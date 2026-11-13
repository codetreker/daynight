import { afterEach, expect, test, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { nativeEntryId } from "../../../src/commands/controller/native-identity.js";
import { openTimelineStore } from "../../../src/commands/controller/content/timeline-store.js";
import { openSessionContent } from "../../../src/commands/controller/content/session-content.js";
import { observeNativeInput } from "../../../src/commands/controller/recovery.js";
import type { NativeImageProjectionState, NativeInputPublicationRequest } from "../../../src/commands/controller/media/native-publication-types.js";
import { nativeInputPublicationFailure } from "../../../src/commands/controller/media/native-publication.js";
import { canonicalImageJson } from "../../../src/session/image-values.js";
import { createMarkdownTimelinePipeline } from "../../../src/commands/controller/markdown/pipeline.js";
import { createMarkdownImageProjector, type MarkdownProjectionState } from "../../../src/commands/controller/markdown/projection.js";
import type { ImageOccurrence } from "../../../src/session/image-values.js";
import type { SessionCommand, SessionResource } from "../../../src/session/protocol.js";

const timelineRows = (db: Database.Database): unknown[] => db.prepare("SELECT id,CAST(entry_seq AS TEXT) AS entry_seq,CAST(revision AS TEXT) AS revision,kind,value,content_hash,byte_length FROM timeline_entries ORDER BY timeline_entries.entry_seq").all();
const timelineTotals = (db: Database.Database): unknown[] => db.prepare("SELECT id,entry_count,byte_length FROM timeline_totals ORDER BY id").all();
const candidateFiles = async (file: string): Promise<string[]> => {
  const directory = `${file}.pending-content/entries`;
  return existsSync(directory) ? readdir(directory) : [];
};

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });
const fixture = async (resourceMetadata: Partial<SessionResource> = {}, imageCount = 1, text = "question", origin?: "user" | "daynight") => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/native-publication-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")); roots.push(root);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "copilot", cwd: root, nativeHome: path.join(root, ".copilot"), configuration: { agent: "copilot", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(root, "grant.json"), ipcEndpoint: path.join(root, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const file = path.join(root, "journal.sqlite"), db = new Database(file), journal = openControllerLifecycleStore(file, ticket, { database: db, contentOwnedLocally: true });
  const nativeSessionId = "native", nativeMessageId = "message", operationId = randomUUID(), imageId = randomUUID(), resourceId = randomUUID();
  journal.patchSnapshot({ nativeSessionId });
  // These bytes exercise persistence and identity, not image decoding.
  const bytes = Buffer.from("original bytes"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const resource: SessionResource = { resourceId, revision: "1", status: "available", name: "original.png", mediaType: "image/png", byteLength: String(bytes.length), sha256, width: 1, height: 1, frameCount: 1, error: null, ...resourceMetadata };
  journal.saveResource(resource, bytes);
  const images = Array.from({ length: imageCount }, (_, index) => ({ type: "image" as const, imageId: index === 0 ? imageId : randomUUID(), uploadId: randomUUID(), resourceId, byteLength: String(bytes.length), sha256 }));
  const payload = { ...(origin ? { origin } : {}), content: [{ type: "text" as const, text }, ...images], expectedTurnId: null, target: { serverOrigin: ticket.serverOrigin, actorUserId: ticket.userId, fence: { sessionId: ticket.sessionId, claimId: ticket.claimId!, executionGeneration: "1" }, expectedNativeSessionId: nativeSessionId }, expectedImageCapabilityRevision: "1", draftId: randomUUID(), draftRevision: "1" };
  const command: SessionCommand = { protocol: "daynight.session.v1", contentRevision: 2, requestId: randomUUID(), operationId, sessionId: ticket.sessionId, claimId: ticket.claimId!, executionGeneration: "1", kind: "send_message", payload };
  journal.prepareOperation({ operationId, kind: "send_message", payload, intent: command }); journal.markDispatching(operationId);
  const entryId = nativeEntryId(nativeSessionId, `:user:${nativeMessageId}`);
  const nativeStates = images.map((_, ordinal) => {
    const index = ordinal + 1, nativeSource = { provider: "copilot" as const, nativeSessionId, nativeMessageId, nativePartId: `attachment-${ordinal}` };
    const sourceKey = canonicalImageJson([1, nativeSource, entryId, "content", null, index]), nativeImageId = nativeEntryId(nativeSessionId, `image:${sourceKey}`), key = `image-slot:${nativeEntryId(nativeSessionId, sourceKey)}`;
    const pending = { type: "image_unavailable" as const, imageId: nativeImageId, label: "Native image", error: { code: "capture_pending", message: "The original image is being saved." } };
    const state: NativeImageProjectionState = { request: { captureId: nativeEntryId(nativeImageId, "capture"), attemptId: nativeEntryId(nativeImageId, "attempt"), occurrence: { imageId: nativeImageId, entryId, container: "content", partId: null, sourceRevision: null, sourceTextSha256: null, callId: null, sourceKey }, nativeSource, locator: { kind: "native", ...nativeSource } }, index, waitingForSource: false, phase: "new", unknownAction: null, part: pending, validated: null };
    return { index, nativeSource, nativeImageId, key, pending, state };
  });
  const { nativeImageId, key, state } = nativeStates[0]!;
  const identity = { provider: "copilot" as const, nativeSessionId, nativeMessageId, operationId, intentSha256: journal.getInputIntent(operationId)!.sha256, entryId };
  const { entryId: _entryId, ...observation } = identity;
  expect(observeNativeInput(journal, observation)).toBe(true);
  const request: NativeInputPublicationRequest = { identity, seed: { entry: { entryId, kind: "user_message", content: [{ type: "text", text }, ...nativeStates.map(item => item.pending)] }, nativeSlots: nativeStates.map(({ index, nativeSource }) => ({ index, nativeSource, label: "Native image" })) }, originals: images.map((input, ordinal) => ({ imageId: input.imageId, resourceId, nativeSlotIndex: ordinal + 1, appendNativeSource: { ...nativeStates[ordinal]!.nativeSource, nativePartId: `original:${operationId}:${input.imageId}` } })) };
  const publishNative = () => { for (const item of nativeStates) journal.writeNativeImageState(item.key, item.state); journal.projectTimeline({ ...request.seed.entry, imageProjectionError: null, revision: "1" }); for (const item of nativeStates) journal.registerImageOccurrence(item.state.request.occurrence, item.nativeSource); };
  const timeline = () => journal.readTimeline({ historyEpoch: "epoch", direction: "tail", cursor: null, limit: 10 }).items[0]!;
  return { root, file, ticket, db, journal, request, resource, state, key, nativeImageId, imageId, resourceId, payload, publishNative, timeline };
};

test.each([false, true])("Markdown preserves atomic native publication positions and recovers a later committed patch (parse failure=%s)", async failParse => {
  const f = await fixture({}, 1, "![a](one.png)", "daynight"), errors: Error[] = [], sources = new Map<string, ImageOccurrence>();
  const captures = { contextKey: () => "trusted", contextFor: () => ({}), get: (id: string) => sources.get(id), enqueue: (occurrence: ImageOccurrence) => { sources.set(occurrence.imageId, occurrence); } };
  const projector = failParse ? createMarkdownImageProjector({ parse: async () => { throw new Error("Controlled parse failure"); } }) : createMarkdownImageProjector();
  let journal = f.journal;
  try {
    f.publishNative();
    const pipeline = createMarkdownTimelinePipeline({ journal, captures, projector, onError: error => { errors.push(error); } });
    pipeline.accept({ ...f.request.seed.entry, revision: "1", imageProjectionError: null }, { complete: true, format: "markdown", truncated: false }); await pipeline.drain();
    const published = journal.publishNativeInputAssociation(f.request);
    expect(published.state).toBe("committed"); if (published.state !== "committed") return;
    const { entrySeq: _entrySeq, ...entry } = published.view.entry;
    pipeline.adoptCommitted(entry); await pipeline.stop();
    expect(journal.queryNativeInputAssociation(f.request.identity)).toMatchObject({ state: "committed", receipt: published.receipt });
    expect(f.db.prepare("SELECT count(*) AS count FROM image_occurrences").get()).toEqual({ count: 2 });
    const saved = { type: "image" as const, imageId: f.nativeImageId, resourceId: f.resourceId, label: "Native image" };
    journal.patchNativeImagePart(f.state.request.occurrence, saved);
    const originalMarkdownIds = [...sources.keys()]; journal.close(); sources.clear();
    journal = openControllerLifecycleStore(f.file, f.ticket, { contentOwnedLocally: true });
    const recovered = createMarkdownTimelinePipeline({ journal, captures, onError: error => { errors.push(error); } }); await recovered.drain();
    expect([...sources.keys()]).toEqual(originalMarkdownIds);
    for (const occurrence of sources.values()) recovered.failure(occurrence, { code: "source_forbidden", message: "Denied" });
    await recovered.stop();
    const current = journal.queryNativeInputAssociation(f.request.identity);
    expect(current.state).toBe("committed"); if (current.state !== "committed") return;
    expect(current.receipt).toEqual(published.receipt); expect(current.view.entry.content[1]).toEqual(saved);
    expect(current.view.entry).toMatchObject({ origin: "daynight" });
    expect(current.view.entry.content[published.receipt.originalSlots[0]!.index]).toMatchObject({ imageId: f.imageId, resourceId: f.resourceId });
    const sequence = journal.getLastSourceSequence(); expect(journal.publishNativeInputAssociation(f.request)).toEqual(current); expect(journal.getLastSourceSequence()).toBe(sequence);
    expect(errors).toEqual([]);
  } finally { journal.close(); }
});

test.each(["analysis", "receipt"])("a failed Markdown %s publication rolls its state and timeline back together before recovery", async phase => {
  const f = await fixture({}, 1, "![a](one.png)"), errors: Error[] = [], sources = new Map<string, ImageOccurrence>();
  const captures = { contextKey: () => "trusted", contextFor: () => ({}), get: (id: string) => sources.get(id), enqueue: (occurrence: ImageOccurrence) => { sources.set(occurrence.imageId, occurrence); } };
  let journal = f.journal;
  try {
    f.publishNative(); const pipeline = createMarkdownTimelinePipeline({ journal, captures, onError: error => { errors.push(error); } });
    pipeline.accept({ ...f.request.seed.entry, revision: "1", imageProjectionError: null }, { complete: true, format: "markdown", truncated: false });
    if (phase === "receipt") await pipeline.drain();
    const before = journal.getTimelineEntry(f.request.identity.entryId), state = journal.markdownStore.get<MarkdownProjectionState>("projection", f.request.identity.entryId), events = journal.pendingEvents(), rows = timelineRows(f.db), totals = timelineTotals(f.db);
    const prepare = f.db.prepare.bind(f.db), fault = vi.spyOn(f.db, "prepare").mockImplementation(sql => {
      if (sql.startsWith("INSERT INTO outbox(")) throw new Error("Controlled Markdown outbox failure after SQL body update");
      return prepare(sql);
    });
    try {
      if (phase === "analysis") await expect(pipeline.drain()).rejects.toThrow("persistence");
      else {
        const occurrence = [...sources.values()][0]!, captureId = randomUUID(), attemptId = randomUUID();
        pipeline.receipt({ captureId, attemptId, occurrence, locator: { kind: "local", path: "one.png", contextId: randomUUID() }, nativeSource: null }, { captureId, attemptId, occurrence, revision: "1", state: "committed", resourceId: f.resourceId, resource: f.resource, error: null });
      }
    } finally { fault.mockRestore(); }
    expect(errors).toHaveLength(1);
    expect(journal.markdownStore.get("projection", f.request.identity.entryId)).toEqual(state);
    expect(journal.getTimelineEntry(f.request.identity.entryId)).toEqual(before); expect(journal.pendingEvents()).toEqual(events);
    expect(timelineRows(f.db)).toEqual(rows); expect(timelineTotals(f.db)).toEqual(totals);
    journal.close(); sources.clear(); journal = openControllerLifecycleStore(f.file, f.ticket, { contentOwnedLocally: true });
    const recovered = createMarkdownTimelinePipeline({ journal, captures, onError: error => { errors.push(error); } }); await recovered.drain(); await recovered.stop();
    expect(sources.size).toBe(1); expect(errors).toHaveLength(1);
    expect(journal.markdownStore.get<MarkdownProjectionState>("projection", f.request.identity.entryId)?.parts[0]?.status).toBe("complete");
  } finally { journal.close(); }
});

test("a lost Markdown publication acknowledgement defers source work until the committed pair is read back", async () => {
  const f = await fixture({}, 1, "![a](one.png)"), errors: Error[] = [], sources = new Map<string, ImageOccurrence>();
  const captures = { contextKey: () => "trusted", contextFor: () => ({}), get: (id: string) => sources.get(id), enqueue: (occurrence: ImageOccurrence) => { sources.set(occurrence.imageId, occurrence); } };
  let journal = f.journal, loseAcknowledgement = true;
  try {
    f.publishNative(); const owner = journal;
    const pipeline = createMarkdownTimelinePipeline({ journal: { ...owner, publishMarkdownProjection(state, entry) {
      const event = owner.publishMarkdownProjection(state, entry);
      if (loseAcknowledgement && state.parts.some(part => part.status === "complete")) { loseAcknowledgement = false; throw new Error("Controlled acknowledgement loss after the journal commit"); }
      return event;
    } }, captures, onError: error => { errors.push(error); } });
    pipeline.accept({ ...f.request.seed.entry, revision: "1", imageProjectionError: null }, { complete: true, format: "markdown", truncated: false });
    await expect(pipeline.drain()).rejects.toThrow("persistence"); expect(sources.size).toBe(0);
    const committed = journal.markdownStore.get<MarkdownProjectionState>("projection", f.request.identity.entryId)!;
    const original = committed.parts[0]!.current[0]!.occurrence;
    expect(committed.parts[0]!.status).toBe("complete");
    const observer = new Database(f.file, { readonly: true });
    try {
      const visible = openTimelineStore(observer, { assertWrite: () => { throw new Error("Observer timeline is read-only."); } }).get(f.request.identity.entryId);
      expect(visible).toMatchObject({ content: [{ bindings: [{ imageId: original.imageId }] }, { imageId: f.nativeImageId }] });
      const row = observer.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(`markdown:projection:${f.request.identity.entryId}`) as { value: string };
      expect(JSON.parse(row.value)).toEqual(committed);
    } finally { observer.close(); }
    const saved = { type: "image" as const, imageId: f.nativeImageId, resourceId: f.resourceId, label: "Native image" };
    journal.patchNativeImagePart(f.state.request.occurrence, saved);
    journal.close(); journal = openControllerLifecycleStore(f.file, f.ticket, { contentOwnedLocally: true });
    const recovered = createMarkdownTimelinePipeline({ journal, captures, onError: error => { errors.push(error); } }); await recovered.drain(); await recovered.stop();
    expect([...sources.keys()]).toEqual([original.imageId]); expect(journal.getTimelineEntry(f.request.identity.entryId)).toMatchObject({ content: [{ bindings: [{ imageId: original.imageId }] }, saved] }); expect(errors).toHaveLength(1);
  } finally { journal.close(); }
});

test("image publication cannot replace an operation's original message owner", async () => {
  const f = await fixture({}, 1, "question", "daynight");
  try {
    const { operationId, nativeSessionId, entryId } = f.request.identity;
    f.journal.associateInputMessage(operationId, nativeSessionId, randomUUID());
    expect(f.journal.publishNativeInputAssociation(f.request)).toMatchObject({ state: "not_committed", error: { code: "publication_conflict" } });
    expect(f.journal.getTimelineEntry(entryId)).toBeUndefined();
    expect(f.journal.queryNativeInputAssociation(f.request.identity).state).toBe("absent");
  } finally { f.journal.close(); }
});

test("a late input association commits its original reference, occurrence and real revision without replacing the native slot", async () => {
  const f = await fixture();
  try {
    f.publishNative(); const before = f.timeline(), result = f.journal.publishNativeInputAssociation(f.request);
    expect(result.state).toBe("committed"); if (result.state !== "committed") return;
    expect(result.receipt.publicationRevision).toBe("2"); expect(result.view.entry.content).toHaveLength(3);
    expect(result.view.entry.content[1]).toEqual((before as any).content[1]);
    expect(result.view.entry.content[2]).toMatchObject({ type: "image", imageId: f.imageId, resourceId: f.resourceId });
    expect(f.timeline()).toEqual(result.view.entry);
    expect(f.db.prepare("SELECT source_sequence,acknowledged FROM image_occurrences WHERE image_id=?").get(f.imageId)).toEqual({ source_sequence: result.receipt.sourceSequence, acknowledged: 0 });
    expect(f.journal.pendingEvents().find(event => event.sequence === result.receipt.sourceSequence)?.payload).toMatchObject({ kind: "timeline_upsert", payload: result.view.entry });
    const sequence = f.journal.getLastSourceSequence();
    expect(f.journal.publishNativeInputAssociation(f.request)).toEqual(result); expect(f.journal.getLastSourceSequence()).toBe(sequence);
  } finally { f.journal.close(); }
});

test("the original input group cannot be associated with native positions in a different order", async () => {
  const f = await fixture({}, 2);
  try {
    const changed = { ...f.request, originals: f.request.originals.map((original, index) => ({ ...original, nativeSlotIndex: 2 - index })) };
    expect(f.journal.publishNativeInputAssociation(changed)).toMatchObject({ state: "not_committed", error: { code: "publication_conflict" } });
    expect(f.journal.queryNativeInputAssociation(f.request.identity)).toEqual({ state: "absent" });
    const result = f.journal.publishNativeInputAssociation(f.request);
    expect(result.state).toBe("committed"); if (result.state !== "committed") return;
    expect(result.view.entry.content.slice(1).map(part => "imageId" in part ? part.imageId : null)).toEqual(f.request.originals.map(part => part.imageId));
  } finally { f.journal.close(); }
});

test("reopened publication references retain the original even after every visible image becomes unavailable", async () => {
  const f = await fixture();
  try {
    const result = f.journal.publishNativeInputAssociation(f.request);
    expect(result.state).toBe("committed"); if (result.state !== "committed") return;
    const slot = result.view.slots[0]!, part = { type: "image_unavailable" as const, imageId: f.imageId, label: slot.label, error: { code: "source_unavailable", message: "Controlled later source failure" } };
    f.journal.writeNativeImageState(slot.key, { ...slot.state, phase: "settled", part });
    f.journal.projectTimeline({ ...result.view.entry, content: [result.view.entry.content[0]!, part] });
    f.journal.close();
    const db = new Database(f.file), reopened = openControllerLifecycleStore(f.file, f.ticket, { database: db, contentOwnedLocally: true });
    try {
      const query = reopened.queryNativeInputAssociation(f.request.identity);
      expect(query).toMatchObject({ state: "committed", receipt: result.receipt, view: { entry: { revision: "2", content: [result.view.entry.content[0], part] } } });
      const content = openSessionContent(f.file, f.ticket.sessionId, db, {
        read: action => db.transaction(action).deferred(),
        assertWrite: () => { throw new Error("Reference verification is read-only."); },
      });
      expect(() => content.resourceFiles.releaseResource(f.resourceId)).toThrow("Resource is referenced by session history");
      expect(reopened.readResource(f.resourceId, "0", 100).resource).toEqual(f.resource);
    } finally { reopened.close(); }
  } finally { f.journal.close(); }
});

test("receipt-first publication uses the original image directly and only its exact ACK permits capture", async () => {
  const f = await fixture();
  try {
    const result = f.journal.publishNativeInputAssociation(f.request); expect(result.state, JSON.stringify(result)).toBe("committed"); if (result.state !== "committed") return;
    expect(result.receipt.publicationRevision).toBe("1"); expect(result.view.entry.content).toHaveLength(2);
    expect(result.view.entry.content[1]).toMatchObject({ type: "image", imageId: f.imageId, resourceId: f.resourceId });
    const capture = result.view.slots[0]!.state.request;
    expect(() => f.journal.registerImageCaptureRequest(capture)).toThrow(/acknowledged/);
    f.journal.acknowledgeEvents(result.receipt.sourceSequence); expect(f.journal.registerImageCaptureRequest(capture)).toEqual(capture);
  } finally { f.journal.close(); }
});

test("publication queries preserve the original commit revision while returning capture progress from a newer current view", async () => {
  const f = await fixture();
  try {
    f.publishNative(); const result = f.journal.publishNativeInputAssociation(f.request); expect(result.state).toBe("committed"); if (result.state !== "committed") return;
    const part = { type: "image" as const, imageId: f.nativeImageId, resourceId: f.resourceId, label: "Native image" };
    f.journal.writeNativeImageState(f.key, { ...f.state, phase: "settled", part });
    f.journal.projectTimeline({ ...result.view.entry, content: [result.view.entry.content[0]!, part, result.view.entry.content[2]!] });
    const query = f.journal.queryNativeInputAssociation(f.request.identity); expect(query.state).toBe("committed"); if (query.state !== "committed") return;
    expect(query.receipt).toEqual(result.receipt); expect(query.view.entry.revision).toBe("3");
    expect(query.view.slots.find(slot => slot.state.request.occurrence.imageId === f.nativeImageId)?.state).toMatchObject({ phase: "settled", part });
    expect(f.journal.publishNativeInputAssociation(f.request)).toEqual(query);
  } finally { f.journal.close(); }
});

test("a SQL failure after updating a body rolls back aliases, current rows, totals, occurrences and outbox together", async () => {
  const f = await fixture();
  try {
    f.publishNative(); const before = f.timeline(), events = f.journal.pendingEvents(), rows = timelineRows(f.db), totals = timelineTotals(f.db);
    const aliases = f.db.prepare("SELECT key,value FROM image_runtime_state ORDER BY key").all();
    expect(await candidateFiles(f.file)).toEqual([]);
    const prepare = f.db.prepare.bind(f.db), injected = vi.spyOn(f.db, "prepare").mockImplementation(sql => {
      if (sql.startsWith("INSERT INTO native_input_publications ")) throw new Error("Controlled publication failure after SQL body update");
      return prepare(sql);
    });
    const result = f.journal.publishNativeInputAssociation(f.request); injected.mockRestore();
    expect(result).toMatchObject({ state: "not_committed", error: { message: "Controlled publication failure after SQL body update" } });
    expect(await candidateFiles(f.file)).toEqual([]);
    expect(timelineRows(f.db)).toEqual(rows); expect(timelineTotals(f.db)).toEqual(totals);
    expect(f.db.prepare("SELECT key,value FROM image_runtime_state ORDER BY key").all()).toEqual(aliases);
    expect(f.timeline()).toEqual(before); expect(f.journal.pendingEvents()).toEqual(events);
    expect(f.db.prepare("SELECT 1 FROM image_occurrences WHERE image_id=?").get(f.imageId)).toBeUndefined();
    expect(f.journal.queryNativeInputAssociation(f.request.identity)).toEqual({ state: "absent" });
  } finally { f.journal.close(); }
});

test("an outbox invariant failure retains its rolled-back error outside the unchanged publication receipt", async () => {
  const f = await fixture();
  try {
    f.publishNative();
    const before = f.timeline(), events = f.journal.pendingEvents(), rows = timelineRows(f.db), totals = timelineTotals(f.db);
    f.db.exec("DELETE FROM outbox_totals");
    const result = f.journal.publishNativeInputAssociation(f.request);
    expect(result).toMatchObject({ state: "not_committed", error: { code: "publication_unavailable" } });
    expect(Object.keys(result).sort()).toEqual(["error", "state"]);
    expect(nativeInputPublicationFailure(result)).toMatchObject({ kind: "invalid-format", context: { phase: "outbox-read" }, outcome: "rolled-back", cause: { kind: "invalid-format", outcome: "unknown" } });
    expect(timelineRows(f.db)).toEqual(rows); expect(timelineTotals(f.db)).toEqual(totals);
    expect(f.timeline()).toEqual(before); expect(f.journal.pendingEvents()).toEqual(events);
    expect(f.db.prepare("SELECT 1 FROM native_input_publications").get()).toBeUndefined();
    expect(f.journal.queryNativeInputAssociation(f.request.identity)).toEqual({ state: "absent" });
  } finally { f.journal.close(); }
});

test("a failed publication rollback retains the original accounting error with unknown outcome", async () => {
  const f = await fixture();
  try {
    f.publishNative(); f.db.exec("DELETE FROM outbox_totals");
    const exec = f.db.exec.bind(f.db), rollbackFailure = new Error("Controlled publication rollback failure");
    const injected = vi.spyOn(f.db, "exec").mockImplementation(sql => { if (sql === "ROLLBACK") throw rollbackFailure; return exec(sql); });
    let result;
    try { result = f.journal.publishNativeInputAssociation(f.request); } finally { injected.mockRestore(); }
    expect(result).toMatchObject({ state: "unknown", error: { code: "publication_unknown" } });
    const failure = nativeInputPublicationFailure(result);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toMatchObject({ kind: "invalid-format", context: { phase: "outbox-read" }, outcome: "unknown" });
    expect((failure as AggregateError).errors[1]).toBe(rollbackFailure);
    expect(() => f.journal.assertUsable()).toThrow("unresolved transaction");
  } finally { f.journal.close(); }
});

test("first association incorporates capture state that committed before its timeline patch", async () => {
  const f = await fixture();
  try {
    f.publishNative();
    const part = { type: "image" as const, imageId: f.nativeImageId, resourceId: f.resourceId, label: "Native image" };
    f.journal.writeNativeImageState(f.key, { ...f.state, phase: "settled", part });
    const result = f.journal.publishNativeInputAssociation(f.request);
    expect(result.state, JSON.stringify(result)).toBe("committed"); if (result.state !== "committed") return;
    expect(result.view.entry.content[1]).toEqual(part);
    expect(result.view.entry.content[2]).toMatchObject({ imageId: f.imageId });
  } finally { f.journal.close(); }
});

test.each([false, true])("previously materialized original slots are reused without a second revision or appended image (late=%s)", async late => {
  const f = await fixture();
  try {
    if (late) f.publishNative();
    const index = late ? 2 : 1, source = late ? f.request.originals[0]!.appendNativeSource : f.request.seed.nativeSlots[0]!.nativeSource;
    const sourceKey = canonicalImageJson([1, source, f.request.identity.entryId, "content", null, index]);
    const part = { type: "image" as const, imageId: f.imageId, resourceId: f.resourceId, label: "Original uploaded image" };
    const state: NativeImageProjectionState = { ...f.state, request: { captureId: nativeEntryId(f.imageId, "capture"), attemptId: nativeEntryId(f.imageId, "attempt"), occurrence: { ...f.state.request.occurrence, imageId: f.imageId, sourceKey }, nativeSource: source, locator: { kind: "resource", resourceId: f.resourceId } }, index, phase: "settled", part };
    f.journal.writeNativeImageState(`image-slot:${nativeEntryId(f.request.identity.nativeSessionId, sourceKey)}`, state);
    const content = [...f.request.seed.entry.content]; content[index] = part;
    f.journal.projectTimeline({ ...f.request.seed.entry, imageProjectionError: null, revision: "1", content });
    f.journal.registerImageOccurrence(state.request.occurrence, source);
    const before = f.timeline(), sequence = f.journal.getLastSourceSequence();
    const result = f.journal.publishNativeInputAssociation(f.request);
    expect(result.state, JSON.stringify(result)).toBe("committed"); if (result.state !== "committed") return;
    expect(result.view.entry).toEqual(before); expect(result.receipt.publicationRevision).toBe(before.revision);
    expect(BigInt(result.receipt.sourceSequence)).toBe(BigInt(sequence) + 1n);
    expect(result.receipt.originalSlots).toEqual([{ imageId: f.imageId, resourceId: f.resourceId, index }]);
    expect(f.journal.publishNativeInputAssociation(f.request)).toEqual(result);
    expect(f.journal.getLastSourceSequence()).toBe(result.receipt.sourceSequence);
  } finally { f.journal.close(); }
});

test("querying a committed association reports a later settled capture without writing its missing timeline patch", async () => {
  const f = await fixture();
  try {
    f.publishNative(); const result = f.journal.publishNativeInputAssociation(f.request);
    expect(result.state).toBe("committed"); if (result.state !== "committed") return;
    const part = { type: "image" as const, imageId: f.nativeImageId, resourceId: f.resourceId, label: "Native image" };
    f.journal.writeNativeImageState(f.key, { ...f.state, phase: "settled", part });
    const sequence = f.journal.getLastSourceSequence(), query = f.journal.queryNativeInputAssociation(f.request.identity);
    expect(query).toMatchObject({ state: "committed", receipt: result.receipt, view: { entry: result.view.entry } });
    if (query.state === "committed") expect(query.view.slots[0]!.state.part).toEqual(part);
    expect(f.timeline()).toEqual(result.view.entry); expect(f.journal.getLastSourceSequence()).toBe(sequence);
  } finally { f.journal.close(); }
});

test.each(["commit", "failure"] as const)("publication query retains a durable %s retry", async action => {
  const f = await fixture();
  try {
    f.publishNative(); const result = f.journal.publishNativeInputAssociation(f.request);
    expect(result.state).toBe("committed"); if (result.state !== "committed") return;
    const state: NativeImageProjectionState = action === "commit"
      ? { ...f.state, phase: "commit", retryAt: 12345, validated: { mediaType: "image/png", byteLength: "3", sha256: "a".repeat(64), width: 1, height: 1, frameCount: 1 } }
      : { ...f.state, phase: "failure", retryAt: 12345, part: { type: "image_unavailable", imageId: f.nativeImageId, label: "Native image", error: { code: "source_missing", message: "Original is missing." } } };
    f.journal.writeNativeImageState(f.key, state);
    const query = f.journal.queryNativeInputAssociation(f.request.identity);
    expect(query.state).toBe("committed"); if (query.state === "committed") expect(query.view.slots[0]!.state).toEqual(state);
  } finally { f.journal.close(); }
});

test("a lost SQL commit confirmation is unknown until querying the unchanged identity observes the original committed receipt", async () => {
  const f = await fixture();
  try {
    const exec = f.db.exec.bind(f.db); let loseConfirmation = true;
    const spy = vi.spyOn(f.db, "exec").mockImplementation(sql => { const result = exec(sql); if (sql === "COMMIT" && loseConfirmation) { loseConfirmation = false; throw new Error("Controlled commit confirmation loss"); } return result; });
    let result;
    try { result = f.journal.publishNativeInputAssociation(f.request); } finally { spy.mockRestore(); }
    expect(result.state).toBe("unknown");
    const sequence = f.journal.getLastSourceSequence(), query = f.journal.queryNativeInputAssociation(f.request.identity);
    expect(query.state).toBe("committed"); if (query.state !== "committed") return;
    expect(query.view.entry.revision).toBe("1"); expect(query.receipt.sourceSequence).toBe(sequence);
    expect(f.journal.getLastSourceSequence()).toBe(sequence);
  } finally { f.journal.close(); }
});

test.each([{ phase: "invented" }, { waitingForSource: "yes" }, { unknownAction: "replay" }, { validated: {} }])("a malformed capture state cannot become a committed query view: %j", async patch => {
  const f = await fixture();
  try {
    const result = f.journal.publishNativeInputAssociation(f.request); expect(result.state).toBe("committed"); if (result.state !== "committed") return;
    const slot = result.view.slots[0]!, sequence = f.journal.getLastSourceSequence();
    f.journal.writeNativeImageState(slot.key, { ...slot.state, ...patch });
    expect(f.journal.queryNativeInputAssociation(f.request.identity).state).toBe("unknown");
    expect(f.journal.getLastSourceSequence()).toBe(sequence); expect(f.timeline()).toEqual(result.view.entry);
  } finally { f.journal.close(); }
});

test("an input image cannot alias an available non-image resource", async () => {
  const f = await fixture({ mediaType: "text/plain", width: null, height: null, frameCount: null });
  try {
    expect(f.journal.publishNativeInputAssociation(f.request).state).toBe("not_committed");
    expect(f.journal.queryNativeInputAssociation(f.request.identity)).toEqual({ state: "absent" });
  } finally { f.journal.close(); }
});

test("original resource geometry must match retained input preparation evidence", async () => {
  const f = await fixture();
  try {
    const input = f.payload.content.find(part => part.type === "image")!;
    const validated = { mediaType: f.resource.mediaType, byteLength: f.resource.byteLength, sha256: f.resource.sha256, width: 2, height: 1, frameCount: 1 };
    const receipt = { uploadId: input.uploadId, imageId: input.imageId, target: f.payload.target, state: "validated", acceptedOffset: input.byteLength, validated, error: null };
    f.db.prepare("INSERT INTO image_preparations VALUES(?,?)").run(input.uploadId, JSON.stringify({ receipt }));
    expect(f.journal.publishNativeInputAssociation(f.request).state).toBe("not_committed");
    expect(f.journal.queryNativeInputAssociation(f.request.identity)).toEqual({ state: "absent" });
  } finally { f.journal.close(); }
});

test("a publication without its exact durable acceptance observation does not create an alias", async () => {
  const f = await fixture();
  try {
    f.db.prepare("DELETE FROM input_observations WHERE operation_id=?").run(f.request.identity.operationId);
    expect(f.journal.publishNativeInputAssociation(f.request)).toMatchObject({ state: "not_committed", error: { code: "publication_conflict" } });
    expect(f.journal.queryNativeInputAssociation(f.request.identity)).toEqual({ state: "absent" });
    expect(f.db.prepare("SELECT 1 FROM timeline_entries WHERE id=?").get(f.request.identity.entryId)).toBeUndefined();
  } finally { f.journal.close(); }
});

test("a committed publication cannot be rewritten through a changed request or query identity", async () => {
  const f = await fixture();
  try {
    const result = f.journal.publishNativeInputAssociation(f.request); expect(result.state).toBe("committed"); if (result.state !== "committed") return;
    const sequence = f.journal.getLastSourceSequence();
    const changed = { ...f.request, seed: { ...f.request.seed, entry: { ...f.request.seed.entry, content: [{ type: "text" as const, text: "changed draft" }, f.request.seed.entry.content[1]!] } } };
    expect(f.journal.publishNativeInputAssociation(changed)).toMatchObject({ state: "not_committed", error: { code: "publication_conflict" } });
    expect(f.journal.queryNativeInputAssociation({ ...f.request.identity, nativeMessageId: "another-message" }).state).toBe("unknown");
    expect(f.journal.queryNativeInputAssociation(f.request.identity)).toEqual(result);
    expect(f.journal.getLastSourceSequence()).toBe(sequence);
  } finally { f.journal.close(); }
});

test("an unresolved commit and rollback failure never exposes the connection's uncommitted publication", async () => {
  const f = await fixture();
  const observer = new Database(f.file, { readonly: true });
  try {
    f.publishNative(); const before = f.timeline(), rows = timelineRows(observer), totals = timelineTotals(observer);
    const raw = observer.prepare("SELECT value FROM timeline_entries WHERE id=?").get(f.request.identity.entryId) as { value: string };
    const exec = f.db.exec.bind(f.db), injected = vi.spyOn(f.db, "exec").mockImplementation(sql => {
      if (sql === "COMMIT" || sql === "ROLLBACK") throw new Error(`Controlled ${sql} failure before execution`);
      return exec(sql);
    });
    let result;
    try { result = f.journal.publishNativeInputAssociation(f.request); } finally { injected.mockRestore(); }
    expect(result.state).toBe("unknown");
    expect(observer.prepare("SELECT 1 FROM native_input_publications").get()).toBeUndefined();
    expect(observer.prepare("SELECT CAST(revision AS TEXT) AS revision FROM timeline_entries WHERE id=?").get(f.request.identity.entryId)).toEqual({ revision: before.revision });
    expect(timelineRows(observer)).toEqual(rows); expect(timelineTotals(observer)).toEqual(totals);
    expect(f.journal.queryNativeInputAssociation(f.request.identity).state).toBe("unknown");
    expect(() => f.timeline()).toThrow();
    expect(() => f.journal.readNativeImageState(f.key)).toThrow();
    expect(() => f.journal.writeNativeImageState("after-failure", {})).toThrow();
    expect(() => f.journal.assertInputCapacity()).toThrow();
    expect(() => f.journal.media()).toThrow();
    f.journal.close();
    expect(observer.prepare("SELECT 1 FROM native_input_publications").get()).toBeUndefined();
    expect(observer.prepare("SELECT owner_pid FROM execution WHERE id=1").get()).toEqual({ owner_pid: process.pid });
    const current = observer.prepare("SELECT value FROM timeline_entries WHERE id=?").get(f.request.identity.entryId) as { value: string };
    expect(current.value).toBe(raw.value); expect(JSON.parse(current.value)).toEqual(before);
    expect(timelineRows(observer)).toEqual(rows); expect(timelineTotals(observer)).toEqual(totals);
    expect(await candidateFiles(f.file)).toEqual([]);
  } finally {
    observer.close();
    if (f.db.open && f.db.inTransaction) f.db.exec("ROLLBACK");
    f.journal.close();
  }
});

test("a capture patches its own slot in the latest committed entry while an older whole entry cannot remove originals", async () => {
  const f = await fixture();
  try {
    f.publishNative(); const before = f.timeline();
    if (before.kind !== "user_message") throw new Error("Expected the fixture's native message");
    const result = f.journal.publishNativeInputAssociation(f.request); expect(result.state).toBe("committed"); if (result.state !== "committed") return;
    const part = { type: "image" as const, imageId: f.nativeImageId, resourceId: f.resourceId, label: "Native image" };
    f.journal.writeNativeImageState(f.key, { ...f.state, phase: "settled", part });
    expect(() => f.journal.projectTimeline({ ...before, content: [before.content[0]!, part] })).toThrow("Timeline update cannot move or replace a committed original image association");
    expect(f.timeline()).toEqual(result.view.entry);
    const sequence = f.journal.getLastSourceSequence(), query = f.journal.queryNativeInputAssociation(f.request.identity);
    expect(query).toMatchObject({ state: "committed", receipt: result.receipt, view: { entry: result.view.entry } });
    expect(f.journal.getLastSourceSequence()).toBe(sequence);
    const updated = f.journal.patchNativeImagePart(f.state.request.occurrence, part);
    expect(updated).toMatchObject({ revision: "3", content: [before.content[0], part, result.view.entry.content[2]] });
    expect(f.journal.queryNativeInputAssociation(f.request.identity)).toMatchObject({ state: "committed", receipt: result.receipt, view: { entry: updated } });
  } finally { f.journal.close(); }
});
