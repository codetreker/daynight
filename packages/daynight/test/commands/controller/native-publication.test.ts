import { afterEach, expect, test, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { nativeEntryId } from "../../../src/commands/controller/native-identity.js";
import { openPendingContent } from "../../../src/commands/controller/pending-content.js";
import { observeNativeInput } from "../../../src/commands/controller/recovery.js";
import type { NativeImageProjectionState, NativeInputPublicationRequest } from "../../../src/commands/controller/media/native-publication-types.js";
import { canonicalImageJson } from "../../../src/session/image-values.js";
import type { SessionCommand, SessionResource } from "../../../src/session/protocol.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });
const fixture = async (resourceMetadata: Partial<SessionResource> = {}, imageCount = 1) => {
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
  const payload = { content: [{ type: "text" as const, text: "question" }, ...images], expectedTurnId: null, target: { serverOrigin: ticket.serverOrigin, actorUserId: ticket.userId, fence: { sessionId: ticket.sessionId, claimId: ticket.claimId!, executionGeneration: "1" }, expectedNativeSessionId: nativeSessionId }, expectedImageCapabilityRevision: "1", draftId: randomUUID(), draftRevision: "1" };
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
  const request: NativeInputPublicationRequest = { identity, seed: { entry: { entryId, kind: "user_message", content: [{ type: "text", text: "question" }, ...nativeStates.map(item => item.pending)] }, nativeSlots: nativeStates.map(({ index, nativeSource }) => ({ index, nativeSource, label: "Native image" })) }, originals: images.map((input, ordinal) => ({ imageId: input.imageId, resourceId, nativeSlotIndex: ordinal + 1, appendNativeSource: { ...nativeStates[ordinal]!.nativeSource, nativePartId: `original:${operationId}:${input.imageId}` } })) };
  const publishNative = () => { for (const item of nativeStates) journal.writeNativeImageState(item.key, item.state); journal.projectTimeline({ ...request.seed.entry, imageProjectionError: null, revision: "1" }); for (const item of nativeStates) journal.registerImageOccurrence(item.state.request.occurrence, item.nativeSource); };
  const timeline = () => journal.readTimeline({ historyEpoch: "epoch", direction: "tail", cursor: null, limit: 10 }).items[0]!;
  return { root, file, ticket, db, journal, request, resource, state, key, nativeImageId, imageId, resourceId, payload, publishNative, timeline };
};

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
      const content = openPendingContent(f.file, f.ticket.sessionId, db);
      expect(() => content.releaseResource(f.resourceId)).toThrow("Resource is referenced by session history");
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

test("a SQL failure after entry staging rolls back aliases, the visible pointer, occurrences and outbox together", async () => {
  const f = await fixture();
  try {
    f.publishNative(); const before = f.timeline(), events = f.journal.pendingEvents();
    const directory = `${f.file}.pending-content/entries`, candidates = await readdir(directory);
    const prepare = f.db.prepare.bind(f.db), injected = vi.spyOn(f.db, "prepare").mockImplementation(sql => {
      if (sql.startsWith("INSERT INTO native_input_publications ")) throw new Error("Controlled publication failure after entry staging");
      return prepare(sql);
    });
    const result = f.journal.publishNativeInputAssociation(f.request); injected.mockRestore();
    expect(result).toMatchObject({ state: "not_committed", error: { message: "Controlled publication failure after entry staging" } });
    expect((await readdir(directory)).length).toBe(candidates.length + 1);
    expect(f.timeline()).toEqual(before); expect(f.journal.pendingEvents()).toEqual(events);
    expect(f.db.prepare("SELECT 1 FROM image_occurrences WHERE image_id=?").get(f.imageId)).toBeUndefined();
    expect(f.journal.queryNativeInputAssociation(f.request.identity)).toEqual({ state: "absent" });
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
    expect(f.db.prepare("SELECT 1 FROM content_index WHERE id=?").get(f.request.identity.entryId)).toBeUndefined();
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
    f.publishNative(); const before = f.timeline();
    const exec = f.db.exec.bind(f.db), injected = vi.spyOn(f.db, "exec").mockImplementation(sql => {
      if (sql === "COMMIT" || sql === "ROLLBACK") throw new Error(`Controlled ${sql} failure before execution`);
      return exec(sql);
    });
    let result;
    try { result = f.journal.publishNativeInputAssociation(f.request); } finally { injected.mockRestore(); }
    expect(result.state).toBe("unknown");
    expect(observer.prepare("SELECT 1 FROM native_input_publications").get()).toBeUndefined();
    expect(observer.prepare("SELECT revision FROM content_index WHERE id=?").get(f.request.identity.entryId)).toEqual({ revision: before.revision });
    expect(f.journal.queryNativeInputAssociation(f.request.identity).state).toBe("unknown");
    expect(() => f.timeline()).toThrow();
    expect(() => f.journal.readNativeImageState(f.key)).toThrow();
    expect(() => f.journal.writeNativeImageState("after-failure", {})).toThrow();
    expect(() => f.journal.assertInputCapacity()).toThrow();
    expect(() => f.journal.media()).toThrow();
    f.journal.close();
    expect(observer.prepare("SELECT 1 FROM native_input_publications").get()).toBeUndefined();
    expect(observer.prepare("SELECT owner_pid FROM execution WHERE id=1").get()).toEqual({ owner_pid: process.pid });
    const pointer = observer.prepare("SELECT content_file FROM content_index WHERE id=?").get(f.request.identity.entryId) as { content_file: string };
    expect(JSON.parse(await readFile(path.join(`${f.file}.pending-content/entries`, pointer.content_file), "utf8"))).toEqual(before);
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
