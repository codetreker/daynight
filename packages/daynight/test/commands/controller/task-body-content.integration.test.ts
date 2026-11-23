import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openSessionContent, retireStoppedOnlineContent } from "../../../src/commands/controller/content/session-content.js";
import { openResourceFiles } from "../../../src/commands/controller/content/resource-files.js";
import type { TimelineEntry } from "../../../src/session/protocol.js";
import type { ImageOccurrence } from "../../../src/session/image-values.js";

const roots: string[] = [], stores: ReturnType<typeof openControllerLifecycleStore>[] = [], databases: Database.Database[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = (options: { maxOnlineBytes?: number; maxOutboxBytes?: number; historyPolicy?: "legacy" | "task_body" } = {}) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-tests"); mkdirSync(base, { recursive: true });
  const home = mkdtempSync(path.join(base, "task-body-")); roots.push(home);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: "https://daynight.example", projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "codex", cwd: home, nativeHome: path.join(home, ".codex"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "worker-managed task", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const file = path.join(home, "journal.sqlite");
  const open = (policy: "legacy" | "task_body" = options.historyPolicy ?? "task_body") => {
    const store = openControllerLifecycleStore(file, ticket, { ...options, historyPolicy: policy, contentOwnedLocally: true }); stores.push(store); return store;
  };
  const read = <T>(action: (db: Database.Database) => T): T => {
    const db = new Database(file, { readonly: true });
    try { return db.transaction(() => action(db)).deferred(); } finally { db.close(); }
  };
  return { file, home, ticket, open, read, store: open() };
};
const message = (text: string, entryId: string = randomUUID()): TimelineEntry => ({ entryId, entrySeq: "1", revision: "1", kind: "assistant_message", content: [{ type: "text", text }] });
const tool = (text = "tool-only marker", entryId: string = randomUUID()): TimelineEntry => ({ entryId, entrySeq: "1", revision: "1", kind: "tool_call", callId: "call-1", name: "shell", input: "command", output: [{ type: "text", text }], status: "running", truncated: false });
const approval = (): TimelineEntry => ({ entryId: randomUUID(), entrySeq: "1", revision: "1", kind: "interaction", interaction: { interactionId: randomUUID(), revision: "1", kind: "approval", state: "pending", title: "Run command?", detail: "Details", actions: ["allow_once", "reject"] } });

it("keeps body history separate while revisions, approval and full tools survive ACK and journal reopen", () => {
  const f = fixture(), call = tool(), pending = approval();
  const body = message("Run `pnpm test`\nstdout: tool-only marker\n中文 😀");
  f.store.projectTimeline(call); f.store.projectTimeline(pending); f.store.projectTimeline(body);
  f.store.projectTimeline({ ...call, output: [{ type: "text", text: "updated tool-only marker" }] } as TimelineEntry);
  expect(f.store.getTimelineEntry(call.entryId)).toMatchObject({ entrySeq: "1", revision: "2" });
  expect(f.store.getTimelineEntry(body.entryId)).toMatchObject({ entrySeq: "3", revision: "1", content: body.kind === "assistant_message" ? body.content : [] });
  f.store.acknowledgeEvents(f.store.getLastSourceSequence());
  f.read(db => {
    expect(db.prepare("SELECT kind FROM timeline_entries").all()).toEqual([{ kind: "assistant_message" }]);
    expect(db.prepare("SELECT entry_count FROM timeline_totals").get()).toEqual({ entry_count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM online_entries").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT byte_length FROM outbox_totals").get()).toEqual({ byte_length: 0 });
  });
  f.store.close(); const reopened = f.open("legacy");
  expect(reopened.getHistoryContentPolicy()).toBe("task_body");
  expect(reopened.pendingInteractions()).toHaveLength(1);
  expect(reopened.getTimelineEntry(call.entryId)).toMatchObject({ revision: "2", output: [{ type: "text", text: "updated tool-only marker" }] });
  const entries = reopened.readTimeline({ historyEpoch: "epoch", direction: "tail", cursor: null, limit: 10 }).items;
  expect(entries.map(entry => entry.entrySeq)).toEqual(["1", "2", "3"]);
  reopened.projectTimeline(message("after reconnect"));
  expect(reopened.getLastSourceSequence()).toBe("5");
  reopened.acknowledgeEvents("5");
  expect(reopened.getHistorySource()).toMatchObject({ sourceThrough: "5", acknowledgedThrough: "5", projectionGap: false });
});

it("rolls back online capacity failures without consuming body capacity or source identity", () => {
  const f = fixture({ maxOnlineBytes: 700 }), call = tool("x".repeat(100));
  f.store.projectTimeline(call);
  const original = f.store.getTimelineEntry(call.entryId), through = f.store.getLastSourceSequence();
  expect(() => f.store.projectTimeline(tool("x".repeat(800), call.entryId))).toThrow("Online session detail budget exceeded");
  expect(f.store.getTimelineEntry(call.entryId)).toEqual(original);
  expect(f.store.getLastSourceSequence()).toBe(through);
  expect(f.store.projectTimeline(message("正文仍能保存"))?.sequence).toBe("2");
  f.read(db => expect(db.prepare("SELECT entry_count FROM timeline_totals").get()).toEqual({ entry_count: 1 }));
});

it("rebuilds details and pending interactions after the bounded outbox discards only transport replay", () => {
  const f = fixture({ maxOutboxBytes: 512 }), call = tool("x".repeat(400)), pending = approval();
  f.store.projectTimeline(call); f.store.projectTimeline(pending); f.store.projectTimeline(message("body"));
  expect(BigInt(f.store.getSourceFloor())).toBeGreaterThan(0n);
  expect(f.store.readTimeline({ historyEpoch: "epoch", direction: "tail", cursor: null, limit: 10 }).items.map(entry => entry.kind)).toEqual(["tool_call", "interaction", "assistant_message"]);
  expect(f.store.pendingInteractions()).toEqual([f.store.getTimelineEntry(pending.entryId)]);
  f.store.acknowledgeEvents(f.store.getLastSourceSequence());
  expect(f.store.pendingEvents()).toEqual([]);
  expect(f.store.getTimelineEntry(call.entryId)).toMatchObject({ kind: "tool_call" });
});

it("preserves legacy policy when a new runtime opens an existing journal", () => {
  const f = fixture({ historyPolicy: "legacy" }), call = tool(); f.store.projectTimeline(call); f.store.close();
  const reopened = f.open("task_body");
  expect(reopened.getHistoryContentPolicy()).toBe("legacy");
  expect(reopened.getTimelineEntry(call.entryId)).toMatchObject({ kind: "tool_call" });
  f.read(db => expect(db.prepare("SELECT kind FROM timeline_entries").all()).toEqual([{ kind: "tool_call" }]));
});

it("persists the welcome decision and rejects a different mode or policy after reopening", () => {
  const f = fixture();
  expect(f.store.getOnlineMode()).toBeNull();
  expect(() => f.store.bindOnlineMode("relay", "legacy")).toThrow("history policy differs");
  expect(f.store.getOnlineMode()).toBeNull();
  f.store.bindOnlineMode("relay", "task_body");
  f.store.close();
  const reopened = f.open();
  expect(reopened.getOnlineMode()).toBe("relay");
  reopened.bindOnlineMode("relay", "task_body");
  expect(() => reopened.bindOnlineMode("legacy", "task_body")).toThrow("online mode differs");
  expect(() => reopened.bindOnlineMode("relay", null)).toThrow("bound history content policy");
  expect(reopened.getOnlineMode()).toBe("relay");
});

it("does not infer Task body policy from the shared Test and Bot execution identity", () => {
  const f = fixture(); f.store.close();
  const { claimId: _claim, projectId: _project, taskId: _task, workerId: _worker, worktreeId: _worktree, userId, ...common } = f.ticket;
  const ticket: ControllerLaunchTicket = { ...common, testExecutionId: randomUUID(), ownerUserId: userId!, initialInput: "none", initialPrompt: "" };
  expect(() => openControllerLifecycleStore(path.join(f.home, "test.sqlite"), ticket, { historyPolicy: "task_body", contentOwnedLocally: true })).toThrow("Task body history requires a locally owned Task Session");
});

it("does not let a tool revision change ownership and reappear as message history", () => {
  const f = fixture(), call = tool(); f.store.projectTimeline(call);
  expect(() => f.store.projectTimeline(message("changed kind", call.entryId))).toThrow("cannot change its original kind");
  expect(f.store.getLastSourceSequence()).toBe("1");
  expect(f.store.getTimelineEntry(call.entryId)).toMatchObject({ kind: "tool_call", revision: "1" });
  expect(() => f.store.saveTimelineHistory(call, "legacy")).toThrow("cannot adopt a different content policy");
});

it("keeps original online image positions for capture retries without importing tool bodies into history", () => {
  const f = fixture(), imageId = randomUUID(), resourceId = randomUUID(), call = tool();
  const occurrence: ImageOccurrence = { imageId, entryId: call.entryId, container: "tool_output", callId: "call-1", partId: null, sourceRevision: null, sourceTextSha256: null, sourceKey: "image-source" };
  f.store.projectTimeline({ ...call, imageProjectionError: null, output: [{ type: "image", imageId, resourceId, label: "image" }] } as TimelineEntry);
  f.store.registerImageOccurrence(occurrence, null);
  expect(f.store.getOnlineImageOccurrences()).toEqual([occurrence]);
  f.store.projectTimeline(call);
  expect(f.store.getOnlineImageOccurrences()).toEqual([occurrence]);
  f.read(db => expect(db.prepare("SELECT COUNT(*) AS count FROM timeline_entries").get()).toEqual({ count: 0 }));
});

it("retires tool content and exclusive files only after the stopped receipt and all resource leases", () => {
  const f = fixture(), call = tool(), body = message("retained body"), bytes = Buffer.from("tool image bytes");
  const resourceId = randomUUID(), sharedId = randomUUID();
  const resource = (id: string) => ({ resourceId: id, status: "available" as const, name: "file.bin", mediaType: "application/octet-stream", byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex"), error: null });
  f.store.saveResource(resource(resourceId), bytes); f.store.saveResource(resource(sharedId), bytes);
  f.store.projectTimeline({ ...call, output: [{ type: "resource", resourceId, label: "tool image" }, { type: "resource", resourceId: sharedId, label: "shared" }] } as TimelineEntry);
  f.store.projectTimeline({ ...body, content: [{ type: "resource", resourceId: sharedId, label: "shared" }] } as TimelineEntry);
  f.store.markdownStore.put("projection", call.entryId, { entryId: call.entryId, input: call });
  const excluded = tool("projection that did not publish");
  f.store.markdownStore.put("projection", excluded.entryId, { entryId: excluded.entryId, input: excluded });
  f.store.markdownStore.put("context", "execution-root", { dev: "1", ino: "2" });
  f.store.acknowledgeEvents(f.store.getLastSourceSequence());
  f.store.patchSnapshot({ lifecycle: "stopped", nativeStopped: true }); f.store.close();
  const db = new Database(f.file); databases.push(db);
  const content = openSessionContent(f.file, f.ticket.sessionId, db, { read: action => db.transaction(action).deferred(), assertWrite: () => { throw new Error("read only"); } });
  expect(() => content.resourceFiles.releaseResource(resourceId)).toThrow("referenced by session history");
  expect(() => retireStoppedOnlineContent(f.file, f.ticket.sessionId, db)).toThrow();
  writeFileSync(`${f.file}.archive-receipt-1.json`, JSON.stringify({ state: "ready", schemaVersion: 3, sha256: "a".repeat(64), byteLength: "100", errorCode: null, completeness: "complete" }));
  const lease = content.resourceFiles.acquireResource(resourceId);
  try {
    expect(() => retireStoppedOnlineContent(f.file, f.ticket.sessionId, db)).toThrow("active lease or reference");
    expect(db.prepare("SELECT COUNT(*) AS count FROM online_entries").get()).toEqual({ count: 1 });
    expect(lease.read("0", 100)).toEqual(bytes);
  } finally { lease.close(); }
  retireStoppedOnlineContent(f.file, f.ticket.sessionId, db);
  expect(db.prepare("SELECT COUNT(*) AS count FROM online_entries").get()).toEqual({ count: 0 });
  expect(db.prepare("SELECT entry_id FROM timeline_source_revisions ORDER BY entry_id").all()).toEqual([{ entry_id: body.entryId }]);
  expect(db.prepare("SELECT COUNT(*) AS count FROM image_runtime_state WHERE key LIKE 'markdown:projection:%'").get()).toEqual({ count: 0 });
  expect(db.prepare("SELECT value FROM image_runtime_state WHERE key='markdown:context:execution-root'").get()).toBeDefined();
  const files = openResourceFiles(f.file, f.ticket.sessionId);
  expect(files.resources.has(resourceId)).toBe(false); expect(files.resources.has(sharedId)).toBe(true);
  expect(db.prepare("SELECT kind FROM timeline_entries").all()).toEqual([{ kind: "assistant_message" }]);
  retireStoppedOnlineContent(f.file, f.ticket.sessionId, db);
});
