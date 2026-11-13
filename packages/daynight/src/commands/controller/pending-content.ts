import type Database from "better-sqlite3";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { controllerPayloadHash } from "./launch-ticket.js";
import { createHash, randomUUID } from "node:crypto";
import { parseTimelineEntry, parseSessionResource, type TimelineEntry } from "../../session/protocol.js";
import { SESSION_ARCHIVE_TIMELINE_MAX_BYTES } from "../../session/archive.js";
import { controllerMetadataBudget } from "./media/metadata-budget.js";
import { syncDirectory, writeDurableJson } from "../../platform/durable-json.js";
import { openResourceFiles } from "./content/resource-files.js";

const entryName = (id: string) => `${createHash("sha256").update(id).digest("hex")}.json`;
type EntryPointer = { id: string; content_hash: string; revision: string; entry_seq: string; content_file: string; content_sha256: string; content_bytes: number };
const readPrivateTimelineBytes = (file: string, expectedBytes?: number): Buffer => {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || process.platform !== "win32" && (before.mode & 0o077) !== 0) throw new Error("Pending archive entry is not a private regular file.");
  const byteLength = expectedBytes === undefined ? before.size : expectedBytes;
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > SESSION_ARCHIVE_TIMELINE_MAX_BYTES || before.size !== byteLength) throw new Error("Pending archive entry is corrupt.");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer | undefined, failure: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || stat.size !== byteLength || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Pending archive entry is corrupt.");
    bytes = Buffer.alloc(byteLength);
    let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) throw new Error("Pending archive entry is corrupt."); offset += count; }
    if (readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0) throw new Error("Pending archive entry is corrupt.");
    const after = fstatSync(fd), named = lstatSync(file);
    if (!named.isFile() || named.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || named.dev !== stat.dev || named.ino !== stat.ino || named.size !== stat.size || named.mtimeMs !== stat.mtimeMs || named.ctimeMs !== stat.ctimeMs) throw new Error("Pending archive entry changed while being read.");
  } catch (cause) { failure = cause; }
  try { closeSync(fd); }
  catch (close) { throw failure === undefined ? close : new AggregateError([failure, close], "Pending archive entry read and close failed.", { cause: failure }); }
  if (failure !== undefined) throw failure;
  return bytes!;
};
const readPendingEntry = (entryDirectory: string, pointer: EntryPointer): TimelineEntry => {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.test(pointer.content_file) || !/^[a-f0-9]{64}$/.test(pointer.content_sha256) || !Number.isSafeInteger(pointer.content_bytes) || pointer.content_bytes < 1 || pointer.content_bytes > SESSION_ARCHIVE_TIMELINE_MAX_BYTES) throw new Error("Pending archive entry pointer is corrupt.");
  const file = join(entryDirectory, pointer.content_file);
  if (!existsSync(file)) throw new Error("Pending archive source is incomplete: committed entry is missing.");
  const bytes = readPrivateTimelineBytes(file, pointer.content_bytes);
  if (createHash("sha256").update(bytes).digest("hex") !== pointer.content_sha256) throw new Error("Pending archive entry is corrupt.");
  const entry = parseTimelineEntry(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (entry.entryId !== pointer.id || entry.entrySeq !== pointer.entry_seq || entry.revision !== pointer.revision || controllerPayloadHash(entry) !== pointer.content_hash) throw new Error("Pending archive entry differs from its committed pointer.");
  return entry;
};

const assertPendingTimelineIdentity = (journal: string, sessionId: string): string => {
  const root = `${journal}.pending-content`, directory = join(root, "entries");
  for (const path of [root, directory]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Pending archive import requires a private directory.");
  }
  const manifest = join(root, "manifest.json"), stat = lstatSync(manifest);
  if (!stat.isFile() || stat.isSymbolicLink() || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Pending content manifest is not a private regular file.");
  const value = JSON.parse(readFileSync(manifest, "utf8")) as { schemaVersion: unknown; sessionId: unknown };
  if (value.schemaVersion !== 1 || value.sessionId !== sessionId) throw new Error("Pending content belongs to another session.");
  return directory;
};

/** Only committed SQL pointers authorize importing a candidate body. */
export const forEachCommittedPendingEntry = (db: Database.Database, sessionId: string, visit: (entry: TimelineEntry) => void): void => {
  if (!db.inTransaction) throw new Error("Pending entry import requires the journal migration transaction.");
  const directory = assertPendingTimelineIdentity(db.name, sessionId);
  let count = 0, bytes = Buffer.byteLength('{"entries":[]}');
  // better-sqlite3 disallows writes while an iterator is active. Keyset reads
  // release each statement before the caller inserts the corresponding SQL body.
  const first = db.prepare("SELECT * FROM content_index ORDER BY id LIMIT 1"), next = db.prepare("SELECT * FROM content_index WHERE id>? ORDER BY id LIMIT 1");
  let pointer = first.get() as EntryPointer | undefined;
  while (pointer !== undefined) {
    const entry = readPendingEntry(directory, pointer);
    bytes += Buffer.byteLength(JSON.stringify(entry)) + (count === 0 ? 0 : 1);
    if (++count > 100000 || bytes > SESSION_ARCHIVE_TIMELINE_MAX_BYTES) throw new Error("Pending session timeline budget exceeded.");
    visit(entry);
    pointer = next.get(pointer.id) as EntryPointer | undefined;
  }
};

/** Retain bounded pointer metadata so the complete DDL may retire its SQL index. */
export const captureCommittedPendingTimeline = (db: Database.Database, sessionId: string) => {
  const pointers: EntryPointer[] = [], pointerById = db.prepare("SELECT * FROM content_index WHERE id=?");
  let byteLength = 0;
  forEachCommittedPendingEntry(db, sessionId, entry => {
    pointers.push(pointerById.get(entry.entryId) as EntryPointer);
    byteLength += Buffer.byteLength(JSON.stringify(entry));
  });
  return {
    entryCount: pointers.length,
    byteLength,
    iterate: (visit: (entry: TimelineEntry) => void): void => {
      if (!db.inTransaction) throw new Error("Captured timeline import requires the original migration transaction.");
      const directory = assertPendingTimelineIdentity(db.name, sessionId);
      for (const pointer of pointers) {
        const result: unknown = visit(readPendingEntry(directory, pointer));
        if (typeof result === "object" && result !== null && "then" in result && typeof result.then === "function") throw new Error("Timeline import callbacks must be synchronous.");
      }
    },
  };
};

const initializeLegacyContentFiles = (journal: string, sessionId: string) => {
  const root = `${journal}.pending-content`;
  for (const directory of [root, join(root, "timeline"), join(root, "entries")]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Legacy pending archive export requires a private directory.");
  }
  return openResourceFiles(journal, sessionId);
};

const writeMigrationEntry = (journal: string, db: Database.Database, entry: TimelineEntry, assertReservedWrite?: (additionalBytes: number) => void): { file: string; sha256: string; bytes: number } => {
  const bytes = Buffer.from(JSON.stringify(entry)), directory = join(`${journal}.pending-content`, "entries");
  if (assertReservedWrite === undefined) controllerMetadataBudget(journal, db).assert(bytes.length + 16_384, true);
  else assertReservedWrite(bytes.length + 16_384);
  const file = `${randomUUID()}.json`, fd = openSync(join(directory, file), "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(directory);
  // Original sources and durable intermediate exports survive rollback or an
  // unknown commit until reader-safe v10 maintenance retires recognized files.
  return { file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
};

/** File commit precedes SQL deletion. A crash leaves either both copies or files only. */
export const migratePendingContent = (db: Database.Database, sessionId: string, schemaSql: string, assertReservedWrite?: (additionalBytes: number) => void): void => {
  if (!db.inTransaction) throw new Error("Pending content migration requires the journal migration transaction.");
  const content = initializeLegacyContentFiles(db.name, sessionId);
  const pointers: { id: string; contentHash: string; revision: string; entrySeq: string }[] = [];
  let timelineBytes = Buffer.byteLength('{"entries":[]}');
  const markerPath = join(content.root, "migration.json"), sourceDirectory = join(content.root, "legacy-sql");
  const inventory = createHash("sha256");
  for (const row of db.prepare("SELECT CAST(rowid AS TEXT) AS seq,value FROM projection ORDER BY rowid").iterate() as Iterable<{seq:string;value:string}>) inventory.update(JSON.stringify(row));
  for (const row of db.prepare("SELECT id,descriptor,content FROM resources ORDER BY id").iterate() as Iterable<{id:string;descriptor:string;content:Buffer|null}>) inventory.update(JSON.stringify({id:row.id,descriptor:row.descriptor,sha256:row.content === null ? null : createHash("sha256").update(row.content).digest("hex")}));
  const sourceHash=inventory.digest("hex");
  const previous = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath,"utf8")) as {migrationId:string;sourceHash:string;phase:string} : null;
  if (previous && previous.sourceHash !== sourceHash) throw new Error("Legacy migration source changed before verification.");
  const marker={migrationId:previous?.migrationId??randomUUID(),sourceHash,phase:"prepared"};
  mkdirSync(sourceDirectory,{recursive:true,mode:0o700});writeDurableJson(markerPath,marker);
  db.pragma("secure_delete = ON");
  for (const row of db.prepare("SELECT CAST(rowid AS TEXT) AS seq,value FROM projection ORDER BY rowid").iterate() as Iterable<{ seq: string; value: string }>) {
    const entry = parseTimelineEntry({ ...JSON.parse(row.value) as object, entrySeq: row.seq });
    const bytes = Buffer.byteLength(JSON.stringify(entry)); timelineBytes += bytes + (pointers.length ? 1 : 0);
    if (pointers.length >= 100000 || timelineBytes > SESSION_ARCHIVE_TIMELINE_MAX_BYTES) throw new Error("Pending session timeline budget exceeded.");
    const filename = join(content.root, "timeline", entryName(entry.entryId));
    const existing = existsSync(filename) ? parseTimelineEntry(JSON.parse(readFileSync(filename, "utf8"))) : undefined;
    if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error("Legacy projection conflicts with pending archive source.");
    const additional = bytes + Buffer.byteLength(JSON.stringify(row)) + 16_384;
    if (assertReservedWrite === undefined) controllerMetadataBudget(db.name, db).assert(additional, true);
    else assertReservedWrite(additional);
    writeDurableJson(join(sourceDirectory,`${row.seq}.timeline.json`),row);
    writeDurableJson(filename, entry); pointers.push({ id: entry.entryId, contentHash: controllerPayloadHash(entry), revision: entry.revision, entrySeq: entry.entrySeq });
  }
  for (const row of db.prepare("SELECT descriptor,content FROM resources").iterate() as Iterable<{ descriptor: string; content: Buffer | null }>) {
    const resource = parseSessionResource(JSON.parse(row.descriptor));
    const value = { resource, data: row.content?.toString("base64") ?? null };
    const existing = content.resources.get(resource.resourceId);
    if (existing && controllerPayloadHash(existing.resource) !== controllerPayloadHash(resource)) throw new Error("Legacy resource conflicts with pending archive source.");
    const backup = { descriptor: row.descriptor, content: row.content?.toString("base64") ?? null };
    const additional = Buffer.byteLength(JSON.stringify(backup)) + 16_384;
    if (assertReservedWrite === undefined) controllerMetadataBudget(db.name, db).assert(additional, true);
    else assertReservedWrite(additional);
    writeDurableJson(join(sourceDirectory, `${resource.resourceId}.resource.json`), backup);
    content.saveResource(value);
  }
  writeDurableJson(markerPath,{...marker,phase:"files_durable"});
  db.exec(schemaSql);
  for (const pointer of pointers) db.prepare("INSERT INTO content_index VALUES(?,?,?,?)").run(pointer.id, pointer.contentHash, pointer.revision, pointer.entrySeq);
};

type PendingTimelineSize = { entryCount: number; byteLength: number; timelineBytes: number };
const forEachLegacyPendingEntry = (db: Database.Database, sessionId: string, visit: (entry: TimelineEntry) => void): PendingTimelineSize => {
  const root = `${db.name}.pending-content`, directory = join(root, "timeline");
  const rootStat = lstatSync(root), directoryStat = lstatSync(directory), manifest = join(root, "manifest.json"), manifestStat = lstatSync(manifest);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("Legacy pending archive source is corrupt.");
  const identity = JSON.parse(readFileSync(manifest, "utf8")) as { schemaVersion: unknown; sessionId: unknown };
  if (identity.schemaVersion !== 1 || identity.sessionId !== sessionId) throw new Error("Pending content belongs to another session.");
  const indexed = new Set<string>();
  for (const row of db.prepare("SELECT id FROM content_index").iterate() as Iterable<{ id: string }>) {
    indexed.add(entryName(row.id));
    if (indexed.size > 100000) throw new Error("Pending session timeline budget exceeded.");
  }
  for (const file of readdirSync(directory).filter(file => file.endsWith(".json"))) if (!indexed.has(file)) throw new Error("Legacy pending timeline has an uncommitted entry; original evidence was retained.");
  const first = db.prepare("SELECT id,content_hash,revision,entry_seq FROM content_index ORDER BY id LIMIT 1"), next = db.prepare("SELECT id,content_hash,revision,entry_seq FROM content_index WHERE id>? ORDER BY id LIMIT 1");
  let row = first.get() as Omit<EntryPointer, "content_file" | "content_sha256" | "content_bytes"> | undefined;
  let entryCount = 0, byteLength = 0;
  const sequences = new Set<string>();
  while (row !== undefined) {
    const filename = join(directory, entryName(row.id));
    if (!existsSync(filename)) throw new Error("Pending archive source is incomplete.");
    const entry = parseTimelineEntry(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readPrivateTimelineBytes(filename))));
    byteLength += Buffer.byteLength(JSON.stringify(entry)); entryCount++;
    if (entryCount > 100000 || Buffer.byteLength('{"entries":[]}') + byteLength + Math.max(0, entryCount - 1) > SESSION_ARCHIVE_TIMELINE_MAX_BYTES) throw new Error("Pending session timeline budget exceeded.");
    if (entry.entryId !== row.id || entry.entrySeq !== row.entry_seq || entry.revision !== row.revision || controllerPayloadHash(entry) !== row.content_hash || sequences.has(entry.entrySeq)) throw new Error("Legacy pending timeline differs from its committed index; original evidence was retained.");
    sequences.add(entry.entrySeq); visit(entry);
    row = next.get(row.id) as typeof row;
  }
  return { entryCount, byteLength, timelineBytes: Buffer.byteLength('{"entries":[]}') + byteLength + Math.max(0, entryCount - 1) };
};

/** Validate the logical source without creating exports or adopting candidates. */
export const preflightPendingTimeline = (db: Database.Database, sessionId: string): PendingTimelineSize => {
  if (!db.inTransaction) throw new Error("Pending timeline preflight requires the journal migration transaction.");
  const committedPointers = (db.pragma("table_info(content_index)") as { name: string }[]).some(column => column.name === "content_file");
  if (!committedPointers) return forEachLegacyPendingEntry(db, sessionId, () => {});
  let entryCount = 0, byteLength = 0;
  forEachCommittedPendingEntry(db, sessionId, entry => { entryCount++; byteLength += Buffer.byteLength(JSON.stringify(entry)); });
  return { entryCount, byteLength, timelineBytes: Buffer.byteLength('{"entries":[]}') + byteLength + Math.max(0, entryCount - 1) };
};

/** Old mutable files are admitted only when they exactly match the SQL commit. */
export const migratePendingEntryPointers = (db: Database.Database, sessionId: string, schemaSql: string, assertReservedWrite?: (additionalBytes: number) => void): void => {
  if (!db.inTransaction) throw new Error("Pending entry migration requires the journal migration transaction.");
  if (!existsSync(join(`${db.name}.pending-content`, "manifest.json"))) throw new Error("Pending archive source is missing.");
  forEachLegacyPendingEntry(db, sessionId, () => {});
  initializeLegacyContentFiles(db.name, sessionId);
  db.exec(schemaSql);
  forEachLegacyPendingEntry(db, sessionId, entry => {
    const pointer = writeMigrationEntry(db.name, db, entry, assertReservedWrite);
    db.prepare("UPDATE content_index SET content_file=?,content_sha256=?,content_bytes=? WHERE id=?").run(pointer.file, pointer.sha256, pointer.bytes, entry.entryId);
  });
};
