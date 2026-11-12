import Database from "better-sqlite3";
import { openSqliteDatabase } from "../../../src/platform/sqlite-access.js";
import { controllerJournalFormat } from "../../../src/commands/controller/journal-format.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { openPendingContent } from "../../../src/commands/controller/pending-content.js";

const roots: string[] = [], databases: Database.Database[] = [];
const database = (file: string) => { const db = openSqliteDatabase({ file, format: controllerJournalFormat, allowCreate: true, onMigration: () => {} }); databases.push(db); return db; };
afterEach(async () => { for (const db of databases.splice(0)) if (db.open) db.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const descriptor = (bytes: Uint8Array) => ({ resourceId: randomUUID(), status: "available" as const, name: "original.png", mediaType: "image/png", byteLength: String(bytes.byteLength), sha256: createHash("sha256").update(bytes).digest("hex"), error: null });

test("stores a resource above the old 8 MiB limit outside JSON and restores the same immutable bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dn-blob-")); roots.push(root);
  const journal = path.join(root, "journal.sqlite"), session = randomUUID();
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 37), resource = descriptor(bytes);
  const db = database(journal), content = openPendingContent(journal, session, db);
  expect(typeof content.writeResource).toBe("function");
  content.writeResource(resource, bytes);
  const lease = content.acquireResource(resource.resourceId);
  expect(lease.read("8388608", 512)).toEqual(bytes.subarray(8388608)); lease.close();
  const restored = openPendingContent(journal, session, db).acquireResource(resource.resourceId);
  expect((await readFile(restored.path)).equals(bytes)).toBe(true); restored.close();
  for (const file of await readdir(`${journal}.pending-content/resources`)) {
    if (file.endsWith(".json")) expect((await readFile(path.join(`${journal}.pending-content/resources`, file))).byteLength).toBeLessThan(4096);
  }
  expect(() => content.writeResource({ ...resource, sha256: "0".repeat(64) }, bytes)).toThrow();
});

test("imports a private resource file without replacing a saved original and detects a missing blob on reopening", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dn-blob-")); roots.push(root);
  const journal = path.join(root, "journal.sqlite"), session = randomUUID(), bytes = Buffer.from("original");
  const resource = descriptor(bytes), source = path.join(root, "source.bin"); await writeFile(source, bytes, { mode: 0o600 });
  const db = database(journal), content = openPendingContent(journal, session, db);
  expect(typeof content.importResourceFile).toBe("function");
  content.importResourceFile(resource, source);
  const lease = content.acquireResource(resource.resourceId); const file = lease.path;
  expect(() => content.releaseResource(resource.resourceId)).toThrow("lease"); lease.close();
  await rm(file);
  expect(() => openPendingContent(journal, session, db)).toThrow("incomplete");
});

test("current timeline references protect a resource until the entry no longer refers to it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dn-resource-reference-")); roots.push(root);
  const journal = path.join(root, "journal.sqlite"), session = randomUUID(), bytes = Buffer.from("original");
  const resource = descriptor(bytes), db = database(journal), content = openPendingContent(journal, session, db);
  content.writeResource(resource, bytes);
  const entry = { entryId: randomUUID(), entrySeq: "1", revision: "1", kind: "user_message" as const, imageProjectionError: null, content: [{ type: "image" as const, imageId: randomUUID(), resourceId: resource.resourceId, label: "original" }] };
  db.transaction(() => content.saveEntry(entry)).immediate();
  expect(() => content.releaseResource(resource.resourceId)).toThrow("Resource is referenced by session history");
  const lease = content.acquireResource(resource.resourceId);
  try { expect(lease.read("0", bytes.length)).toEqual(bytes); } finally { lease.close(); }
  db.transaction(() => content.saveEntry({ ...entry, revision: "2", content: [{ type: "text" as const, text: "image removed" }] })).immediate();
  content.releaseResource(resource.resourceId);
  expect(openPendingContent(journal, session, db).resources.has(resource.resourceId)).toBe(false);
});

test("admits the exact complete timeline budget and preserves it when a revision exceeds the limit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dn-budget-")); roots.push(root);
  const journal = path.join(root, "journal.sqlite"), session = randomUUID();
  const db = database(journal), content = openPendingContent(journal, session, db);
  const empty = { entryId: randomUUID(), entrySeq: "1", revision: "1", kind: "assistant_message" as const, content: Array.from({ length: 64 }, (_, index) => ({ type: "text" as const, text: index === 63 ? "" : "x".repeat(1024 * 1024) })) };
  const remaining = 64 * 1024 * 1024 - Buffer.byteLength(JSON.stringify({ entries: [empty] }));
  const entry = { ...empty, content: empty.content.map((part, index) => index === 63 ? { ...part, text: "x".repeat(remaining) } : part) };
  db.transaction(() => content.saveEntry(entry)).immediate();
  expect(content.metadataBytes()).toBe(64 * 1024 * 1024);
  expect(() => db.transaction(() => content.saveEntry({ ...entry, revision: "2", content: entry.content.map((part, index) => index === 63 ? { ...part, text: `${part.text}x` } : part) })).immediate()).toThrow("budget");
  expect(content.entries.get(entry.entryId)?.revision).toBe("1");
  expect(openPendingContent(journal, session, db).metadataBytes()).toBe(64 * 1024 * 1024);
}, 30_000);

test("counts orphan originals before importing a new blob and leaves no new publication on refusal", async () => {
  const { open } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "dn-orphan-budget-")); roots.push(root);
  const journal = path.join(root, "journal.sqlite"), content = openPendingContent(journal, randomUUID(), database(journal));
  const orphan = await open(path.join(content.root, "blobs", `${"a".repeat(64)}.bin`), "wx", 0o600);
  try { await orphan.truncate(1024 * 1024 * 1024); } finally { await orphan.close(); }
  expect(() => content.writeResource(descriptor(Buffer.from("original")), Buffer.from("original"))).toThrow("budget");
  expect(content.resources.size).toBe(0);
  expect(await readdir(path.join(content.root, "blobs"))).toEqual([`${"a".repeat(64)}.bin`]);
});
