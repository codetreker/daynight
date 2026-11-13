import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { loadSqliteSequence } from "../../../src/platform/sqlite-sql.js";
import { openSessionContent } from "../../../src/commands/controller/content/session-content.js";
import { openTimelineStore } from "../../../src/commands/controller/content/timeline-store.js";
import { createLocalSessionContent } from "../../../src/commands/controller/local-content.js";
import { canonicalHistoryJSON, encodeHistoryPageCursor } from "../../../src/session/history.js";
import type { TimelineEntry } from "../../../src/session/protocol.js";

const roots: string[] = [], connections: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-tests"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "sql-content-reads-")); roots.push(root);
  const file = path.join(root, "journal.sqlite"), db = new Database(file); connections.push(db);
  db.pragma("journal_mode = WAL");
  for (const step of loadSqliteSequence(new URL("../../../src/commands/controller/sqlite/journal/", import.meta.url))) db.exec(step.sql);
  let writing = false;
  const transactions = {
    read: <T>(action: () => T): T => db.transaction(action).deferred(),
    write: <T>(action: () => T): T => db.transaction(() => { writing = true; try { return action(); } finally { writing = false; } }).immediate(),
  };
  const sessionId = randomUUID(), epoch = randomUUID();
  const content = openSessionContent(file, sessionId, db, { read: transactions.read, assertWrite: () => { if (!writing) throw new Error("Not the original write transaction."); } });
  return { db, file, sessionId, epoch, content, local: createLocalSessionContent(content, sessionId, transactions), write: transactions.write };
};
const reasoning = (entrySeq: string, text = "current SQL body", revision = "1", entryId: string = randomUUID()): TimelineEntry => ({ entryId, entrySeq, revision, kind: "reasoning", text });
const interaction = (entrySeq: string, state: "pending" | "resolved" = "pending", title = "Approval"): TimelineEntry => ({ entryId: randomUUID(), entrySeq, revision: "1", kind: "interaction", interaction: { interactionId: randomUUID(), revision: "1", kind: "approval", state, title, detail: "Details", actions: ["allow_once", "reject"] } });
const cursor = (sessionId: string, epoch: string, sequence: string) => Buffer.from(JSON.stringify([sessionId, epoch, sequence])).toString("base64url");

it("uses exclusive numeric int64 cursors for SQL timeline and inspection pages", () => {
  const f = fixture(), sequences = ["2", "16", "9007199254740993", "9007199254740995", "9223372036854775807"];
  const entries = sequences.map(sequence => reasoning(sequence));
  f.write(() => { for (const entry of entries) f.content.timeline.save(entry); });
  const tail = f.local.readTimeline({ historyEpoch: f.epoch, direction: "tail", cursor: null, limit: 2 });
  expect(tail.items).toEqual(entries.slice(3)); expect(tail.hasMoreBefore).toBe(true); expect(tail.hasMoreAfter).toBe(false);
  const before = f.local.readTimeline({ historyEpoch: f.epoch, direction: "before", cursor: tail.beforeCursor, limit: 2 });
  expect(before.items).toEqual(entries.slice(1, 3));
  const after = f.local.readTimeline({ historyEpoch: f.epoch, direction: "after", cursor: before.afterCursor, limit: 2 });
  expect(after.items).toEqual(entries.slice(3));
  const inspectCursor = encodeHistoryPageCursor({ source: "live", sessionId: f.sessionId, historyEpoch: f.epoch, sourceVersion: f.epoch, entrySeq: sequences[3]! });
  expect(f.local.readInspection({ historyEpoch: f.epoch, cursor: inspectCursor, limit: 2, responseOverhead: 4096 }).items.map(item => item.entrySeq)).toEqual(sequences.slice(1, 3));
  for (const invalid of [cursor(randomUUID(), f.epoch, "16"), cursor(f.sessionId, randomUUID(), "16"), cursor(f.sessionId, f.epoch, "9223372036854775808")]) expect(() => f.local.readTimeline({ historyEpoch: f.epoch, direction: "before", cursor: invalid, limit: 2 })).toThrow();
});

it("bases backward cursors on entries that actually fit the response", () => {
  const f = fixture(), entries = [1, 2, 3].map(sequence => interaction(String(sequence), "pending", "x".repeat(600000)));
  f.write(() => { for (const entry of entries) f.content.timeline.save(entry); });
  const tail = f.local.readTimeline({ historyEpoch: f.epoch, direction: "tail", cursor: null, limit: 3 });
  expect(tail.items.map(entry => entry.entryId)).toEqual(entries.slice(1).map(entry => entry.entryId));
  expect(tail.beforeCursor).toBe(cursor(f.sessionId, f.epoch, "2")); expect(tail.hasMoreBefore).toBe(true);
  expect(f.local.readTimeline({ historyEpoch: f.epoch, direction: "before", cursor: tail.beforeCursor, limit: 3 }).items.map(entry => entry.entryId)).toEqual([entries[0]!.entryId]);
});

it("keeps page rows and cursor existence checks in one short WAL snapshot", () => {
  const f = fixture(), first = reasoning("1"); f.write(() => f.content.timeline.save(first));
  const writer = new Database(f.file); connections.push(writer);
  const other = openTimelineStore(writer, { assertWrite: () => {} });
  const hasBefore = f.content.timeline.hasBefore;
  const hook = vi.spyOn(f.content.timeline, "hasBefore").mockImplementation(pivot => {
    writer.transaction(() => other.save(reasoning("2"))).immediate(); hook.mockRestore();
    return hasBefore(pivot);
  });
  const page = f.local.readTimeline({ historyEpoch: f.epoch, direction: "tail", cursor: null, limit: 1 });
  expect(page.items).toEqual([first]); expect(page.hasMoreAfter).toBe(false); expect(f.db.inTransaction).toBe(false);
  expect(f.local.readTimeline({ historyEpoch: f.epoch, direction: "after", cursor: page.afterCursor, limit: 1 }).items[0]!.entrySeq).toBe("2");
});

it("keeps global coverage and selected rows in the same SQL snapshot", () => {
  const f = fixture(), first = reasoning("1"); f.write(() => f.content.timeline.save(first));
  const writer = new Database(f.file); connections.push(writer);
  const other = openTimelineStore(writer, { assertWrite: () => {} });
  const page = f.content.timeline.page;
  const hook = vi.spyOn(f.content.timeline, "page").mockImplementation(query => {
    writer.transaction(() => {
      other.save({ entryId: first.entryId, entrySeq: "1", revision: "2", kind: "tool_call", callId: "tool", name: "shell", input: "x", output: [], status: "completed", truncated: true });
      other.save(reasoning("2", "newest"));
    }).immediate(); hook.mockRestore();
    return page(query);
  });
  const observed = f.local.readInspection({ historyEpoch: f.epoch, cursor: null, limit: 1, responseOverhead: 4096 });
  expect(observed.items[0]!.body).toEqual(first); expect(observed.coverage).toEqual({ state: "complete", reason: null }); expect(f.db.inTransaction).toBe(false);
  const current = f.local.readInspection({ historyEpoch: f.epoch, cursor: null, limit: 1, responseOverhead: 4096 });
  expect(current.items[0]!.entrySeq).toBe("2"); expect(current.coverage).toEqual({ state: "partial", reason: "entry_truncated" });
});

it("reads current canonical UTF-8 chunks and rejects a cursor after its SQL revision changes", () => {
  const f = fixture(), original = reasoning("9007199254740993", "😀\u2028".repeat(50000), "9007199254740995");
  f.write(() => f.content.timeline.save(original));
  const item = f.local.readInspection({ historyEpoch: f.epoch, cursor: null, limit: 1, responseOverhead: 4096 }).items[0]!;
  expect(item.body).toBeNull();
  let next = item.contentRef!.cursor, complete = "";
  for (;;) {
    const chunk = f.local.readEntryChunk({ historyEpoch: f.epoch, cursor: next, limit: 32768 });
    expect(chunk.fragment.isWellFormed()).toBe(true); expect(Buffer.byteLength(chunk.fragment)).toBeLessThanOrEqual(32768);
    complete += chunk.fragment;
    if (chunk.eof) break;
    next = chunk.nextCursor!;
  }
  expect(complete).toBe(canonicalHistoryJSON(original));
  expect(createHash("sha256").update(complete).digest("hex")).toBe(item.contentRef!.sha256);
  expect(String(Buffer.byteLength(complete))).toBe(item.contentRef!.byteLength);
  f.write(() => f.content.timeline.save(reasoning(original.entrySeq, "replacement", "9007199254740996", original.entryId)));
  expect(() => f.local.readEntryChunk({ historyEpoch: f.epoch, cursor: item.contentRef!.cursor, limit: 32768 })).toThrow(expect.objectContaining({ code: "content_changed" }));
});

it("streams only current pending interactions in numeric order and enforces the synchronization limit", () => {
  const f = fixture(), entries = [interaction("16"), interaction("2", "resolved"), interaction("9007199254740993")];
  f.write(() => { for (const entry of entries) f.content.timeline.save(entry); });
  expect(f.local.pendingInteractions()).toEqual([entries[0], entries[2]]);
  f.write(() => { for (let index = 17; index < 117; index++) f.content.timeline.save(interaction(String(index))); });
  expect(() => f.local.pendingInteractions()).toThrow("Too many pending native interactions");
  expect(f.db.inTransaction).toBe(false);
});

it("propagates corrupt SQL body errors instead of returning empty history", () => {
  const f = fixture(), entry = reasoning("1"); f.write(() => f.content.timeline.save(entry));
  f.db.prepare("UPDATE timeline_entries SET content_hash=? WHERE id=?").run("0".repeat(64), entry.entryId);
  expect(() => f.local.readTimeline({ historyEpoch: f.epoch, direction: "tail", cursor: null, limit: 1 })).toThrow("stored identity or content");
  expect(() => f.local.readInspection({ historyEpoch: f.epoch, cursor: null, limit: 1, responseOverhead: 4096 })).toThrow("stored identity or content");
  expect(f.db.inTransaction).toBe(false);
});
