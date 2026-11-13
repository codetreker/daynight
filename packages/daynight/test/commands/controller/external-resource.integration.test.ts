import Database from "better-sqlite3";
import { openControllerTestDatabase, closeControllerTestDatabase } from "../../helpers/controller-sqlite.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { openSessionContent } from "../../../src/commands/controller/content/session-content.js";
import { openResourceFiles } from "../../../src/commands/controller/content/resource-files.js";
import { controllerMetadataBudget } from "../../../src/commands/controller/media/metadata-budget.js";

const roots: string[] = [], databases: Database.Database[] = [];
const database = (file: string) => { const db = openControllerTestDatabase({ file, allowCreate: true, onMigration: () => {} }); databases.push(db); return db; };
afterEach(async () => { for (const db of databases.splice(0)) closeControllerTestDatabase(db); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sessionContent = (file: string, sessionId: string, db: Database.Database) => openSessionContent(file, sessionId, db, {
  read: action => db.inTransaction ? action() : db.transaction(action).deferred(),
  assertWrite: additional => { if (!db.inTransaction) throw new Error("Publication requires the original write transaction."); controllerMetadataBudget(file, db).assert(additional); },
});
const descriptor = (bytes: Uint8Array) => ({ resourceId: randomUUID(), status: "available" as const, name: "original.png", mediaType: "image/png", byteLength: String(bytes.byteLength), sha256: createHash("sha256").update(bytes).digest("hex"), error: null });

test("stores a resource above the old 8 MiB limit outside JSON and restores the same immutable bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dn-blob-")); roots.push(root);
  const journal = path.join(root, "journal.sqlite"), session = randomUUID();
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 37), resource = descriptor(bytes);
  const content = openResourceFiles(journal, session);
  expect(typeof content.writeResource).toBe("function");
  content.writeResource(resource, bytes);
  const lease = content.acquireResource(resource.resourceId);
  expect(lease.read("8388608", 512)).toEqual(bytes.subarray(8388608)); lease.close();
  const restored = openResourceFiles(journal, session).acquireResource(resource.resourceId);
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
  const content = openResourceFiles(journal, session);
  expect(typeof content.importResourceFile).toBe("function");
  content.importResourceFile(resource, source);
  const lease = content.acquireResource(resource.resourceId); const file = lease.path;
  expect(() => content.releaseResource(resource.resourceId)).toThrow("lease"); lease.close();
  await rm(file);
  expect(() => openResourceFiles(journal, session)).toThrow("incomplete");
});

test("current timeline references protect a resource until the entry no longer refers to it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dn-resource-reference-")); roots.push(root);
  const journal = path.join(root, "journal.sqlite"), session = randomUUID(), bytes = Buffer.from("original");
  const resource = descriptor(bytes), db = database(journal), content = sessionContent(journal, session, db);
  content.resourceFiles.writeResource(resource, bytes);
  const entry = { entryId: randomUUID(), entrySeq: "1", revision: "1", kind: "user_message" as const, imageProjectionError: null, content: [{ type: "image" as const, imageId: randomUUID(), resourceId: resource.resourceId, label: "original" }] };
  db.transaction(() => content.timeline.save(entry)).immediate();
  expect(() => content.resourceFiles.releaseResource(resource.resourceId)).toThrow("Resource is referenced by session history");
  const lease = content.resourceFiles.acquireResource(resource.resourceId);
  try { expect(lease.read("0", bytes.length)).toEqual(bytes); } finally { lease.close(); }
  db.transaction(() => content.timeline.save({ ...entry, revision: "2", content: [{ type: "text" as const, text: "image removed" }] })).immediate();
  content.resourceFiles.releaseResource(resource.resourceId);
  expect(sessionContent(journal, session, db).resourceFiles.resources.has(resource.resourceId)).toBe(false);
});

test("counts orphan originals before importing a new blob and leaves no new publication on refusal", async () => {
  const { open } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "dn-orphan-budget-")); roots.push(root);
  const journal = path.join(root, "journal.sqlite"), content = openResourceFiles(journal, randomUUID());
  const orphan = await open(path.join(content.root, "blobs", `${"a".repeat(64)}.bin`), "wx", 0o600);
  try { await orphan.truncate(1024 * 1024 * 1024); } finally { await orphan.close(); }
  expect(() => content.writeResource(descriptor(Buffer.from("original")), Buffer.from("original"))).toThrow("budget");
  expect(content.resources.size).toBe(0);
  expect(await readdir(path.join(content.root, "blobs"))).toEqual([`${"a".repeat(64)}.bin`]);
});


test("the composition refuses to delete a resource referenced by committed SQL history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dn-history-resource-")); roots.push(root);
  const journal = path.join(root, "journal.sqlite"), session = randomUUID(), bytes = Buffer.from("original");
  const resource = descriptor(bytes), db = database(journal), content = sessionContent(journal, session, db);
  content.resourceFiles.writeResource(resource, bytes);
  const entry = { entryId: randomUUID(), entrySeq: "1", revision: "1", kind: "assistant_message" as const, content: [{ type: "resource" as const, resourceId: resource.resourceId, label: "original" }] };
  db.transaction(() => content.timeline.save(entry)).immediate();
  expect(() => content.resourceFiles.releaseResource(resource.resourceId)).toThrow("referenced by session history");
  const lease = content.resourceFiles.acquireResource(resource.resourceId);
  try { expect(lease.read("0", 100)).toEqual(bytes); } finally { lease.close(); }
  expect(sessionContent(journal, session, db).timeline.get(entry.entryId)).toEqual(entry);
});
