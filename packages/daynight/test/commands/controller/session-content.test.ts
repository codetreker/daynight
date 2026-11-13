import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { loadSqliteSql } from "../../../src/platform/sqlite-sql.js";
import { openSessionContent } from "../../../src/commands/controller/content/session-content.js";
import type { TimelineEntry } from "../../../src/session/protocol.js";

const roots: string[] = [], connections: Database.Database[] = [];
afterEach(() => { for (const db of connections.splice(0)) if (db.open) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/controller-tests"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "session-sql-content-")); roots.push(root);
  const file = path.join(root, "journal.sqlite"), db = new Database(file); connections.push(db);
  db.exec("CREATE TABLE execution(id INTEGER PRIMARY KEY); CREATE TABLE content_index(id TEXT PRIMARY KEY); CREATE TABLE native_input_publication_images(resource_id TEXT);" + loadSqliteSql(new URL("../../../src/commands/controller/sqlite/journal/010-timeline-content.sql", import.meta.url)));
  let writing = false;
  const read = <T>(action: () => T): T => db.inTransaction ? action() : db.transaction(action).deferred();
  const write = <T>(action: () => T): T => db.transaction(() => { writing = true; try { return action(); } finally { writing = false; } }).immediate();
  const content = openSessionContent(file, randomUUID(), db, { read, assertWrite: () => { if (!writing) throw new Error("Not the original write transaction."); } });
  const resourceId = randomUUID();
  content.resourceFiles.saveResource({ resource: { resourceId, status: "unavailable", name: "file.txt", mediaType: null, byteLength: null, sha256: null, error: null }, data: null });
  return { db, content, resourceId, write };
};

it("guards resource release with current SQL bodies and permits release after their replacement", () => {
  const f = fixture(), entryId = randomUUID();
  const entry: TimelineEntry = { entryId, entrySeq: "1", revision: "1", kind: "assistant_message", content: [{ type: "resource", resourceId: f.resourceId, label: "file" }] };
  f.write(() => f.content.timeline.save(entry));
  expect(() => f.content.resourceFiles.assertResourceReleasable(f.resourceId)).toThrow("referenced by session history");
  expect(() => f.content.resourceFiles.releaseResource(f.resourceId)).toThrow("referenced by session history");
  expect(f.content.resourceFiles.resources.has(f.resourceId)).toBe(true);
  f.write(() => f.content.timeline.save({ ...entry, revision: "2", content: [{ type: "text", text: "replacement" }] }));
  f.content.resourceFiles.releaseResource(f.resourceId);
  expect(f.content.resourceFiles.resources.has(f.resourceId)).toBe(false);
  expect(f.content.metadataBytes()).toBe(f.content.timeline.totals().timelineBytes);
});

it("retains resources associated with native input independently of current timeline bodies", () => {
  const f = fixture();
  f.db.prepare("INSERT INTO native_input_publication_images(resource_id) VALUES(?)").run(f.resourceId);
  expect(() => f.content.resourceFiles.releaseResource(f.resourceId)).toThrow("referenced by session history");
  expect(f.content.resourceFiles.resources.has(f.resourceId)).toBe(true);
  f.db.exec("DELETE FROM native_input_publication_images");
  f.content.resourceFiles.releaseResource(f.resourceId);
  expect(f.content.resourceFiles.resources.has(f.resourceId)).toBe(false);
});

it("retains persistent resource pins before checking SQL references", () => {
  const f = fixture();
  f.content.resourceFiles.pinResource(f.resourceId, "archive");
  expect(() => f.content.resourceFiles.releaseResource(f.resourceId)).toThrow("active lease or reference");
  f.content.resourceFiles.unpinResource(f.resourceId, "archive");
  f.content.resourceFiles.releaseResource(f.resourceId);
  expect(f.content.resourceFiles.resources.has(f.resourceId)).toBe(false);
});
