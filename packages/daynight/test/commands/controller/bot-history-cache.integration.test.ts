import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import { openBotHistoryCache, type BotHistoryCacheBudget } from "../../../src/commands/controller/content/bot-history-cache.js";
import { openTimelineStore } from "../../../src/commands/controller/content/timeline-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { SourceTimelineEntry } from "../../../src/session/controller-protocol.js";
import { botHistoryWindowEntryDigest } from "../../../src/session/bot-history-window.js";
import type { ImageCaptureReceipt, ImageCaptureRequest } from "../../../src/session/image-values.js";
import type { SessionResource } from "../../../src/session/protocol.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

const fixture = (botHistoryBudget: BotHistoryCacheBudget) => {
  const tmp = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-tests");
  mkdirSync(tmp, { recursive: true });
  const root = mkdtempSync(path.join(tmp, "bot-history-cache-"));
  cleanup.push(() => rmSync(root, { recursive: true }));
  const file = path.join(root, "journal.sqlite");
  const executionId = randomUUID();
  const ticket: ControllerLaunchTicket = {
    schemaVersion: 1, launchId: randomUUID(), executionId, controllerId: randomUUID(), controllerInstanceId: randomUUID(),
    sessionId: randomUUID(), testExecutionId: executionId, ownerUserId: randomUUID(), botId: randomUUID(), executionGeneration: "1",
    serverOrigin: "http://127.0.0.1:8080", provider: "codex", cwd: root, nativeHome: path.join(root, "native"),
    configuration: { agent: "codex", model: null, args: [], recoveryLimit: 2, agentControlMode: "web" },
    initialInput: "none", initialPrompt: "", initialOperationId: randomUUID(), resumeNativeSessionId: null,
    credentialFile: path.join(root, "grant.json"), ipcEndpoint: path.join(root, "local.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString(),
  };
  const open = (database?: Database.Database) => {
    if (database) cleanup.push(() => { if (database.open) database.close(); });
    const journal = openControllerLifecycleStore(file, ticket, { ...(database ? { database } : {}), contentOwnedLocally: true, botHistoryBudget, onMigration: () => {} });
    cleanup.push(() => journal.close());
    return journal;
  };
  const measure = () => {
    const db = new Database(file, { readonly: true });
    try {
      return db.prepare(`SELECT COUNT(*) AS entries,COALESCE(SUM(t.byte_length+i.preview_bytes),0) AS bytes,
        COALESCE(SUM(length(CAST(t.value AS BLOB))+length(CAST(i.preview AS BLOB))),0) AS actual
        FROM timeline_entries t JOIN bot_history_identity i ON t.id=i.id WHERE i.preview IS NOT NULL`).get();
    } finally { db.close(); }
  };
  return { file, ticket, open, measure };
};
const message = (kind: "user_message" | "assistant_message", text: string, entryId: string = randomUUID()): SourceTimelineEntry =>
  ({ entryId, kind, revision: "1", content: [{ type: "text", text }] });
const tool = (entryId: string = randomUUID()): SourceTimelineEntry => ({
  entryId, revision: "1", kind: "tool_call", callId: "test-command", name: "exec_command",
  input: JSON.stringify({ cmd: "test command", workdir: "test directory" }), output: [{ type: "text", text: "command output" }],
  status: "completed", truncated: false,
});

test("revises a UTF-8 bounded no-tool turn in place and accounts for both stored copies", () => {
  const f = fixture({ entries: 5, bytes: 16 * 1024 * 1024 }), journal = f.open();
  const user = message("user_message", "a".repeat(32_764) + "🧩" + "rest");
  journal.projectTimeline(user);
  const first = journal.readBotHistoryWindow()!;
  expect(first.entries[0]!.entry).toMatchObject({
    preview: "a".repeat(32_764) + "…", previewBytes: "32767", originalBytes: "32772", truncated: true,
  });
  const nativeSessionId = randomUUID(), operationId = randomUUID();
  journal.patchSnapshot({ nativeSessionId });
  journal.prepareOperation({ operationId, kind: "worker_input", payload: { text: "original input", origin: "daynight" } });
  journal.markDispatching(operationId);
  expect(journal.associateInputMessage(operationId, nativeSessionId, user.entryId)).toBe(user.entryId);
  expect(journal.readBotHistoryWindow()!.entries[0]!.entry).toEqual({ ...first.entries[0]!.entry, revision: "2" });
  const assistant = message("assistant_message", "😃".repeat(20_000));
  journal.projectTimeline(assistant);
  const old = journal.readBotHistoryWindow()!;
  for (const text of ["x".repeat(70_000), "short 🧩", "😃".repeat(22_000)]) {
    journal.projectTimeline(message("assistant_message", text, assistant.entryId));
  }
  const revised = journal.readBotHistoryWindow()!;
  expect(revised.entries).toHaveLength(2);
  expect(revised.entries[1]!.entry).toMatchObject({ entryId: assistant.entryId, entrySeq: "2", revision: "4", originalBytes: "88000", truncated: true });
  expect(revised.entries[1]!.entry.preview.isWellFormed()).toBe(true);
  expect(BigInt(revised.windowRevision)).toBeGreaterThan(BigInt(old.windowRevision));
  expect(f.measure()).toEqual({ entries: 2, bytes: expect.any(Number), actual: expect.any(Number) });
  const totals = f.measure() as { bytes: number; actual: number };
  expect(totals.bytes).toBe(totals.actual);
  expect(totals.bytes).toBeLessThan(140_000);
});

test("evicts complete older turns, summarizes active tools and rejects retired revisions after reopen", () => {
  const f = fixture({ entries: 4, bytes: 24_000 }), journal = f.open();
  const first = message("user_message", "first turn"), answer = message("assistant_message", "first answer");
  const second = message("user_message", "second turn");
  const toolImageId = randomUUID(), withImage = tool();
  if (withImage.kind !== "tool_call") throw new Error("Missing tool fixture.");
  for (const entry of [first, answer, second, { ...withImage, imageProjectionError: null, output: [{ type: "image", imageId: toolImageId, resourceId: randomUUID(), label: "Tool output" }] }, tool()] as const) journal.projectTimeline(entry);
  journal.registerImageOccurrence({ entryId: withImage.entryId, imageId: toolImageId, container: "tool_output", callId: withImage.callId, sourceKey: "test-tool-image", partId: null, sourceRevision: null, sourceTextSha256: null }, null);
  expect(journal.readBotHistoryWindow()).toMatchObject({ retainedFromSeq: "3", throughSeq: "5", earlierHistoryUnavailable: true });
  expect(journal.getTimelineEntry(first.entryId)).toBeUndefined();
  const initial = journal.readBotHistoryWindow()!;
  for (let i = 0; i < 9; i++) journal.projectTimeline(tool());
  const window = journal.readBotHistoryWindow()!;
  expect(window.entries).toHaveLength(4);
  expect(window.entries[1]!.entry.omittedEntryCount).toBe(9);
  expect(window.entries[1]!.entry).toMatchObject({ kind: "tool_call", truncated: true, omissionReason: "earlier_tool_details" });
  expect(BigInt(window.entries[1]!.entry.revision)).toBeGreaterThan(BigInt(initial.entries[1]!.entry.revision));
  expect(window.entries[1]!.imageOccurrences).toEqual([]);
  expect(window.entries[2]!.entry.tool).toMatchObject({ command: "test command", cwd: "test directory", status: "completed" });
  expect(window.entries[0]!.entry.entryId).toBe(second.entryId);
  expect(BigInt(window.windowRevision)).toBeGreaterThan(BigInt(initial.windowRevision));
  const retired = initial.entries[2]!.entry.entryId;
  journal.close();
  const reopened = f.open();
  expect(reopened.hasTimelineEntry(retired)).toBe(true);
  expect(reopened.projectTimeline(tool(retired))).toBeNull();
  expect(reopened.readBotHistoryWindow()).toEqual(window);
  const totals = f.measure() as { bytes: number; actual: number };
  expect(totals.bytes).toBe(totals.actual);
  expect(totals.bytes).toBeLessThanOrEqual(24_000);
  expect(() => reopened.prepareImageHistorySync()).toThrow("window checkpoint");
});

test("rolls back boundary, revisions and source append together and preserves recovery after clearing display", () => {
  const f = fixture({ entries: 2, bytes: 16_000 }), db = new Database(f.file), journal = f.open(db);
  const entry = message("user_message", "before"), nativeSessionId = randomUUID(), operationId = randomUUID(), approvalId = randomUUID();
  journal.patchSnapshot({ nativeSessionId, currentTurnId: "native-turn" });
  journal.prepareOperation({ operationId, kind: "worker_input", payload: { text: "durable input", origin: "daynight" } });
  journal.markDispatching(operationId);
  journal.projectTimeline(entry);
  journal.projectTimeline({ kind: "interaction", entryId: approvalId, revision: "1", interaction: { interactionId: approvalId, revision: "1", kind: "approval", state: "pending", title: "Command", detail: "Read output", actions: ["allow_once", "reject"] } });
  const before = journal.readBotHistoryWindow(), through = journal.getLastSourceSequence();
  db.exec("CREATE TEMP TRIGGER fail_bot_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'controlled source failure'); END");
  try {
    expect(() => journal.projectTimeline(message("user_message", "after"))).toThrow("controlled source failure");
  } finally { db.exec("DROP TRIGGER temp.fail_bot_outbox"); }
  expect(journal.getLastSourceSequence()).toBe(through);
  expect(journal.readBotHistoryWindow()).toEqual(before);
  journal.close();
  const offline = new Database(f.file);
  try {
    const timeline = openTimelineStore(offline, { assertWrite: () => { if (!offline.inTransaction) throw new Error("Missing test transaction."); } });
    const cache = openBotHistoryCache(offline, timeline);
    offline.transaction(() => cache.clear()).immediate();
  } finally { offline.close(); }
  const reopened = f.open();
  expect(reopened.readBotHistoryWindow()).toMatchObject({ retainedFromSeq: null, throughSeq: "1", earlierHistoryUnavailable: true, entries: [] });
  expect(reopened.pendingInteractions()).toHaveLength(1);
  expect(reopened.getSnapshot()).toMatchObject({ nativeSessionId, currentTurnId: "native-turn" });
  expect(reopened.getOperation(operationId)).toMatchObject({ state: "dispatching", operationId });
  expect(reopened.projectTimeline(message("user_message", "late revision", entry.entryId))).toBeNull();
  reopened.projectTimeline(message("assistant_message", "continues"));
  expect(reopened.readBotHistoryWindow()).toMatchObject({ retainedFromSeq: "3", throughSeq: "3", earlierHistoryUnavailable: true });
  const expire = { kind: "interaction", entryId: approvalId, revision: "1", interaction: { interactionId: approvalId, revision: "1", kind: "approval", state: "expired", title: "Command", detail: "Read output", actions: ["allow_once", "reject"] } } as const;
  expect(reopened.projectTimeline(expire)?.payload).toMatchObject({ payload: { revision: "2" } });
  expect(reopened.projectTimeline({ ...expire, interaction: { ...expire.interaction, state: "resolved" } })?.payload).toMatchObject({ payload: { revision: "3" } });
  expect(reopened.pendingInteractions()).toHaveLength(0);
});

test("evicts complete turns when exact occurrence metadata exhausts the checkpoint", () => {
  const f = fixture({ entries: 20, bytes: 48_000, checkpointBytes: 2800 }), journal = f.open();
  const publish = () => {
    const entryId = randomUUID(), resourceId = randomUUID(), imageId = randomUUID();
    journal.projectTimeline({ entryId, kind: "user_message", revision: "1", imageProjectionError: null, content: [{ type: "image", resourceId, imageId, label: "Image" }] });
    journal.registerImageOccurrence({ entryId, imageId, container: "content", callId: null, sourceKey: "image-position-".repeat(50), partId: null, sourceRevision: null, sourceTextSha256: null }, null);
    return entryId;
  };
  const old = publish(), retained = [publish(), publish(), publish()];
  const current = journal.readBotHistoryWindow()!;
  expect(journal.getTimelineEntry(old)).toBeUndefined();
  expect(current).toMatchObject({ retainedFromSeq: "3", throughSeq: "4", earlierHistoryUnavailable: true });
  expect(current.entries.map(row => row.entry.entryId)).toEqual(retained.slice(1));
  expect(current.entries.every(row => row.imageOccurrences.length === 1)).toBe(true);
});

test("publishes decoded tool metadata with valid Unicode for the checkpoint digest", async () => {
  const journal = fixture({ entries: 4, bytes: 16_000 }).open();
  const entry = tool();
  if (entry.kind !== "tool_call") throw new Error("Missing tool fixture.");
  journal.projectTimeline({ ...entry, input: JSON.stringify({ command: "command\0flag", cwd: "directory\uD800", exitCode: 0 }) });
  const projected = journal.readBotHistoryWindow()!.entries[0]!.entry;
  expect(projected.tool).toMatchObject({ command: "command\uFFFDflag", cwd: "directory\uFFFD", exitCode: 0 });
  await expect(botHistoryWindowEntryDigest(projected)).resolves.toMatch(/^[a-f0-9]{64}$/);
});

test.each([
  ["eviction", "before"], ["eviction", "after"], ["revision", "before"], ["revision", "after"],
] as const)("releases an unpublished capture's resource on %s with receipt %s removal", (removal, order) => {
  const f = fixture({ entries: 1, bytes: 16_000 }), db = new Database(f.file), journal = f.open(db);
  const entryId = randomUUID(), imageId = randomUUID(), partId = randomUUID();
  const text = "![original](original.png)", textSha256 = createHash("sha256").update(text).digest("hex");
  const occurrence = { imageId, entryId, container: "content" as const, callId: null, partId, sourceRevision: "1", sourceTextSha256: textSha256, sourceKey: "markdown-position" };
  journal.projectTimeline({ entryId, kind: "user_message", revision: "1", imageProjectionError: null, content: [{
    type: "markdown", text, partId, textSha256, revision: "1", complete: true, truncated: false, retainedImages: [],
    bindings: [{ imageId, start: 0, end: text.length, part: { type: "image_unavailable", imageId, label: "Pending image", error: { code: "capture_pending", message: "Saving the original." } } }],
  }] });
  journal.registerImageOccurrence(occurrence, null);
  journal.acknowledgeEvents(journal.getLastSourceSequence());
  const request: ImageCaptureRequest = { captureId: randomUUID(), attemptId: randomUUID(), occurrence, nativeSource: null, locator: { kind: "local", path: "original.png", contextId: randomUUID() } };
  journal.registerImageCaptureRequest(request);
  expect(journal.imageCaptureProof(request.captureId, request.attemptId).sourceSeq).toBe(journal.getLastSourceSequence());
  const bytes = Buffer.from("saved original"), resourceId = randomUUID(), sha256 = createHash("sha256").update(bytes).digest("hex");
  const resource: SessionResource = { resourceId, revision: "1", status: "available", name: "original.png", mediaType: "image/png", byteLength: String(bytes.length), sha256, width: 1, height: 1, frameCount: 1, error: null };
  const receipt: ImageCaptureReceipt = { captureId: request.captureId, attemptId: request.attemptId, revision: "1", occurrence, state: "committed", resourceId, resource, error: null };
  const observe = () => {
    expect(journal.observeImageCaptureReceipt(receipt)).toEqual(receipt);
    // Saving the adopted descriptor and bytes follows the durable receipt.
    journal.saveResource(resource, bytes);
  };
  const queued = () => db.prepare("SELECT resource_id FROM bot_resource_retirement WHERE resource_id=?").get(resourceId);
  if (order === "before") {
    observe();
    expect(queued()).toBeUndefined();
  }
  journal.projectTimeline(message("user_message", "without the image", removal === "revision" ? entryId : randomUUID()));
  if (order === "after") observe();
  expect(queued()).toEqual({ resource_id: resourceId });
  expect(journal.readResource(resourceId, "0", 40).resource).toEqual(resource);
  journal.retireBotHistoryResources();
  expect(() => journal.readResource(resourceId, "0", 40)).toThrow("unavailable");
  expect(queued()).toBeUndefined();
  expect(journal.getImageCaptureRequest(request.captureId)).toEqual(request);
  expect(journal.readBotHistoryWindow()!.entries[0]!.entry.resourceIds).toEqual([]);
});

test("converting a legacy Bot releases resources from excluded reasoning", () => {
  const f = fixture({ entries: 1, bytes: 16_000 }), journal = f.open();
  const bytes = Buffer.from("saved original"), resourceId = randomUUID(), sha256 = createHash("sha256").update(bytes).digest("hex");
  journal.saveResource({ resourceId, revision: "1", status: "available", name: "original.png", mediaType: "image/png", byteLength: String(bytes.length), sha256, width: 1, height: 1, frameCount: 1, error: null }, bytes);
  journal.close();
  const entryId = randomUUID(), imageId = randomUUID(), text = "![original](original.png)";
  const legacy = new Database(f.file);
  try {
    const timeline = openTimelineStore(legacy, { assertWrite: () => { if (!legacy.inTransaction) throw new Error("Missing fixture transaction."); } });
    legacy.transaction(() => {
      timeline.save({ entryId, entrySeq: "1", revision: "1", kind: "reasoning", text, imageProjectionError: null, markdown: {
        partId: randomUUID(), textSha256: createHash("sha256").update(text).digest("hex"), revision: "1", complete: true, truncated: false, retainedImages: [],
        bindings: [{ imageId, start: 0, end: text.length, part: { type: "image", imageId, resourceId, label: "Previously displayed" } }],
      } });
      legacy.exec("DROP INDEX bot_history_image_positions; DROP INDEX bot_history_capture_entry; DROP TABLE bot_history_identity; DROP TABLE bot_history_state; DROP TABLE bot_resource_retirement; PRAGMA user_version=20");
    }).immediate();
  } finally { legacy.close(); }
  const converted = f.open();
  expect(converted.getTimelineEntry(entryId)).toBeUndefined();
  expect(converted.readResource(resourceId, "0", 40).resource.resourceId).toBe(resourceId);
  converted.retireBotHistoryResources();
  expect(() => converted.readResource(resourceId, "0", 40)).toThrow("unavailable");
});
