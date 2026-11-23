import { sqliteDisplayFilename } from "../../platform/sqlite-filename.js";
import type Database from "better-sqlite3";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { controllerPayloadHash } from "./launch-ticket.js";
import { createHash, randomUUID } from "node:crypto";
import { parseStoredTimelineEntry, parseStoredSessionResource, type TimelineEntry } from "../../session/protocol.js";
import { syncDirectory, writeDurableJson } from "../../platform/durable-json.js";
import { assertControllerStoragePermit, type ControllerStoragePermit } from "./storage-lock.js";

const entryName = (id: string) => `${createHash("sha256").update(id).digest("hex")}.json`;
type EntryPointer = { id: string; content_hash: string; revision: string; entry_seq: string; content_file: string; content_sha256: string; content_bytes: number };
const readPrivateTimelineBytes = (file: string, expectedBytes?: number): Buffer => {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || process.platform !== "win32" && (before.mode & 0o077) !== 0) throw new Error("Pending archive entry is not a private regular file.");
  const byteLength = expectedBytes === undefined ? before.size : expectedBytes;
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || before.size !== byteLength) throw new Error("Pending archive entry is corrupt.");
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
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.test(pointer.content_file) || !/^[a-f0-9]{64}$/.test(pointer.content_sha256) || !Number.isSafeInteger(pointer.content_bytes) || pointer.content_bytes < 1) throw new Error("Pending archive entry pointer is corrupt.");
  const file = join(entryDirectory, pointer.content_file);
  if (!existsSync(file)) throw new Error("Pending archive source is incomplete: committed entry is missing.");
  const bytes = readPrivateTimelineBytes(file, pointer.content_bytes);
  if (createHash("sha256").update(bytes).digest("hex") !== pointer.content_sha256) throw new Error("Pending archive entry is corrupt.");
  const entry = parseStoredTimelineEntry(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
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
  const directory = assertPendingTimelineIdentity(sqliteDisplayFilename(db.name), sessionId);
  // better-sqlite3 disallows writes while an iterator is active. Keyset reads
  // release each statement before the caller inserts the corresponding SQL body.
  const first = db.prepare("SELECT * FROM content_index ORDER BY id LIMIT 1"), next = db.prepare("SELECT * FROM content_index WHERE id>? ORDER BY id LIMIT 1");
  let pointer = first.get() as EntryPointer | undefined;
  while (pointer !== undefined) {
    const entry = readPendingEntry(directory, pointer);
    visit(entry);
    pointer = next.get(pointer.id) as EntryPointer | undefined;
  }
};

/** Retain committed pointer metadata so the complete DDL may retire its SQL index. */
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
      const directory = assertPendingTimelineIdentity(sqliteDisplayFilename(db.name), sessionId);
      for (const pointer of pointers) {
        const result: unknown = visit(readPendingEntry(directory, pointer));
        if (typeof result === "object" && result !== null && "then" in result && typeof result.then === "function") throw new Error("Timeline import callbacks must be synchronous.");
      }
    },
  };
};

// A candidate path is immutable: a retry can reuse identical output without
// replacing an unrelated file left by another publication.
const publishMigrationFile = (file: string, bytes: Buffer): boolean => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  let failure: unknown, same = false;
  try { writeFileSync(fd, bytes); fsyncSync(fd); } catch (error) { failure = error; }
  try { closeSync(fd); }
  catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "Migration file write and close failed.", { cause: failure }); }
  if (failure === undefined) {
    try {
      try { linkSync(temporary, file); same = true; }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        same = readMigrationSource(file)?.equals(bytes) ?? false;
      }
      if (same) syncDirectory(dirname(file));
    } catch (error) { failure = error; }
  }
  try { unlinkSync(temporary); }
  catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "Migration publication and cleanup failed.", { cause: failure }); }
  if (failure !== undefined) throw failure;
  return same;
};
const parseObject = (text: string): Record<string, unknown> | undefined => {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
};
const ordered = (value: unknown, keys: string[], nested: Record<string, (item: unknown) => unknown> = {}): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>, result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) if (Object.hasOwn(source, key)) result[key] = nested[key] ? nested[key]!(source[key]) : source[key];
  for (const [key, item] of Object.entries(source)) if (!keys.includes(key)) result[key] = item;
  return result;
};
const mapArray = (value: unknown, map: (item: unknown) => unknown): unknown => Array.isArray(value) ? value.map(map) : value;
const imageError = (value: unknown): unknown => ordered(value, ["code", "message"]);
const imagePart = (value: unknown): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const type = (value as Record<string, unknown>).type;
  if (type === "text") return ordered(value, ["type", "text"]);
  if (type === "resource") return ordered(value, ["type", "resourceId", "label"]);
  if (type === "image") return ordered(value, ["type", "imageId", "resourceId", "label"]);
  if (type === "image_unavailable") return ordered(value, ["type", "imageId", "label", "error"], { error: imageError });
  if (type === "markdown") return ordered(value, ["type", "text", "partId", "revision", "textSha256", "complete", "truncated", "bindings", "retainedImages"], markdownChildren);
  return value;
};
const binding = (value: unknown): unknown => ordered(value, ["imageId", "start", "end", "part", "sourceRevision", "sourceTextSha256", "linkHref"], { part: imagePart });
const markdownChildren = { bindings: (value: unknown) => mapArray(value, binding), retainedImages: (value: unknown) => mapArray(value, binding) };
const markdown = (value: unknown): unknown => ordered(value, ["partId", "revision", "textSha256", "complete", "truncated", "bindings", "retainedImages"], markdownChildren);
const option = (value: unknown): unknown => ordered(value, ["id", "label"]);
const interaction = (value: unknown): unknown => ordered(value, ["interactionId", "revision", "state", "title", "kind", "detail", "actions", "canDismiss", "questions", "fields"], {
  questions: value => mapArray(value, item => ordered(item, ["questionId", "label", "options", "multiple", "allowCustom", "required", "sensitive"], { options: options => mapArray(options, option) })),
  fields: value => mapArray(value, item => ordered(item, ["fieldId", "label", "required", "type", "sensitive", "min", "max", "options"], { options: options => mapArray(options, option) })),
});
const entryBody = (value: Record<string, unknown>, seq: string): Record<string, unknown> => {
  const extras: Record<string, string[]> = {
    user_message: ["content", "origin"], assistant_message: ["content"], reasoning: ["text", "markdown"],
    tool_call: ["callId", "name", "input", "output", "status", "truncated"], interaction: ["interaction"],
    error: ["code", "message"], compaction: ["summary"], todo: ["items"],
  };
  const keys = ["entryId", "entrySeq", "revision", "imageProjectionError", "kind", ...(typeof value.kind === "string" && Object.hasOwn(extras, value.kind) ? extras[value.kind]! : [])];
  return ordered({ ...value, entrySeq: seq }, keys, {
    imageProjectionError: imageError, content: item => mapArray(item, imagePart), output: item => mapArray(item, imagePart), markdown,
    interaction, items: item => mapArray(item, todo => ordered(todo, ["id", "text", "status"])),
  }) as Record<string, unknown>;
};

/** Publish the files derived from SQL before retiring the old tables. */
export const migratePendingContent = (db: Database.Database, sessionId: string | undefined, schemaSql: string, permit: ControllerStoragePermit): void => {
  if (!db.inTransaction) throw new Error("Pending content migration requires the journal migration transaction.");
  assertControllerStoragePermit(permit, permit.journalFile);
  if (!db.memory && sqliteDisplayFilename(db.name) !== permit.journalFile) throw new Error("Pending content migration permit belongs to another database.");
  const pointers: { id: string; contentHash: string; revision: string; entrySeq: string }[] = [];
  if (sessionId !== undefined) {
    const root = `${sqliteDisplayFilename(db.name)}.pending-content`, timeline = join(root, "timeline"), resources = join(root, "resources"), blobs = join(root, "blobs");
    const makeDirectory = (directory: string): void => {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Legacy pending archive export requires a private directory.");
    };
    let rootReady = false, timelineReady = false;
    const prepareRoot = (): void => {
      if (rootReady) return;
      makeDirectory(root); syncDirectory(dirname(root)); syncDirectory(root);
      const manifest = join(root, "manifest.json");
      if (!existsSync(manifest)) writeDurableJson(manifest, { schemaVersion: 1, sessionId });
      rootReady = true;
    };
    for (const row of db.prepare("SELECT CAST(rowid AS TEXT) AS seq,id,CAST(revision AS TEXT) AS revision,value FROM projection ORDER BY rowid").iterate() as Iterable<{ seq: string; id: string; revision: string; value: string }>) {
      const value = typeof row.value === "string" ? parseObject(row.value) : undefined;
      if (!value || typeof row.id !== "string" || typeof row.revision !== "string") continue;
      prepareRoot();
      if (!timelineReady) { makeDirectory(timeline); timelineReady = true; }
      const body = entryBody(value, row.seq), bytes = Buffer.from(JSON.stringify(body));
      if (!publishMigrationFile(join(timeline, entryName(row.id)), bytes)) continue;
      pointers.push({ id: row.id, contentHash: controllerPayloadHash(body), revision: row.revision, entrySeq: row.seq });
    }
    let indexRead = false, oldIndex: Record<string, unknown> | undefined, names: Set<unknown> | undefined;
    const indexPath = join(root, "index.json");
    for (const row of db.prepare("SELECT id,descriptor,CAST(content AS BLOB) AS content FROM resources ORDER BY id").iterate() as Iterable<{ id: string; descriptor: string; content: Buffer | null }>) {
      const descriptor = typeof row.descriptor === "string" ? parseObject(row.descriptor) : undefined;
      if (!descriptor || typeof descriptor.resourceId !== "string") continue;
      if (!indexRead) {
        prepareRoot();
        const indexBytes = existsSync(indexPath) ? readMigrationSource(indexPath) : undefined;
        oldIndex = indexBytes === undefined ? (existsSync(indexPath) ? undefined : { entries: [], resources: [] }) : parseObject(indexBytes.toString("utf8"));
        if (oldIndex && Array.isArray(oldIndex.entries) && Array.isArray(oldIndex.resources)) {
          makeDirectory(resources); makeDirectory(blobs); names = new Set(oldIndex.resources);
        }
        indexRead = true;
      }
      if (!names) continue;
      const name = entryName(descriptor.resourceId), descriptorBytes = Buffer.from(JSON.stringify({ resource: descriptor, data: null }));
      const descriptorPath = join(resources, name), blobPath = join(blobs, name.replace(/\.json$/, ".bin"));
      if (existsSync(descriptorPath) && !(readMigrationSource(descriptorPath)?.equals(descriptorBytes) ?? false)) continue;
      if (row.content !== null && !publishMigrationFile(blobPath, row.content)) continue;
      if (!publishMigrationFile(descriptorPath, descriptorBytes)) continue;
      names.add(name);
    }
    if (!rootReady) {
      let rootExists = true;
      try { lstatSync(root); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") rootExists = false; else throw error; }
      if (!rootExists) prepareRoot();
    }
    if (names && oldIndex) {
      const next = { ...oldIndex, resources: [...names].sort() };
      if (!existsSync(indexPath) || JSON.stringify(next) !== JSON.stringify(oldIndex)) writeDurableJson(indexPath, next);
    }
  }
  db.pragma("secure_delete = ON");
  db.exec(schemaSql);
  const insert = db.prepare("INSERT INTO content_index VALUES(?,?,?,?)");
  for (const pointer of pointers) insert.run(pointer.id, pointer.contentHash, pointer.revision, pointer.entrySeq);
};

type PendingTimelineSize = { entryCount: number; byteLength: number; timelineBytes: number };
const forEachLegacyPendingEntry = (db: Database.Database, sessionId: string, visit: (entry: TimelineEntry) => void): PendingTimelineSize => {
  const root = `${sqliteDisplayFilename(db.name)}.pending-content`, directory = join(root, "timeline");
  const rootStat = lstatSync(root), directoryStat = lstatSync(directory), manifest = join(root, "manifest.json"), manifestStat = lstatSync(manifest);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("Legacy pending archive source is corrupt.");
  const identity = JSON.parse(readFileSync(manifest, "utf8")) as { schemaVersion: unknown; sessionId: unknown };
  if (identity.schemaVersion !== 1 || identity.sessionId !== sessionId) throw new Error("Pending content belongs to another session.");
  const indexed = new Set<string>();
  for (const row of db.prepare("SELECT id FROM content_index").iterate() as Iterable<{ id: string }>) {
    indexed.add(entryName(row.id));
  }
  for (const file of readdirSync(directory).filter(file => file.endsWith(".json"))) if (!indexed.has(file)) throw new Error("Legacy pending timeline has an uncommitted entry; original evidence was retained.");
  const first = db.prepare("SELECT id,content_hash,revision,entry_seq FROM content_index ORDER BY id LIMIT 1"), next = db.prepare("SELECT id,content_hash,revision,entry_seq FROM content_index WHERE id>? ORDER BY id LIMIT 1");
  let row = first.get() as Omit<EntryPointer, "content_file" | "content_sha256" | "content_bytes"> | undefined;
  let entryCount = 0, byteLength = 0;
  const sequences = new Set<string>();
  while (row !== undefined) {
    const filename = join(directory, entryName(row.id));
    if (!existsSync(filename)) throw new Error("Pending archive source is incomplete.");
    const entry = parseStoredTimelineEntry(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readPrivateTimelineBytes(filename))));
    byteLength += Buffer.byteLength(JSON.stringify(entry)); entryCount++;
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

/** Missing directories cannot provide sources; unsafe directories are not followed. */
export const migrationDirectoryExists = (directory: string): boolean => {
  let stat;
  try { stat = lstatSync(directory); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
  if (stat.isSymbolicLink()) throw new Error("Pending archive migration requires a private directory.");
  if (!stat.isDirectory()) return false;
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Pending archive migration requires a private directory.");
  return true;
};

/** Copy only SQL-indexed bytes and retain the original index metadata. */
export const migratePendingEntryPointers = (db: Database.Database, _sessionId: string | undefined, schemaSql: string, permit: ControllerStoragePermit): void => {
  if (!db.inTransaction) throw new Error("Pending entry migration requires the journal migration transaction.");
  assertControllerStoragePermit(permit, permit.journalFile);
  if (!db.memory && sqliteDisplayFilename(db.name) !== permit.journalFile) throw new Error("Pending entry migration permit belongs to another database.");
  const root = `${sqliteDisplayFilename(db.name)}.pending-content`, entries = join(root, "entries"), timeline = join(root, "timeline");
  const rows = db.prepare("SELECT id,entry_seq FROM content_index ORDER BY id").all() as { id: string; entry_seq: string }[];
  const written: { id: string; file: string; sha256: string; bytes: number }[] = [], sequences = new Set<string>();
  const sourceExists = rows.some(row => typeof row.id === "string" && typeof row.entry_seq === "string") && migrationDirectoryExists(root) && migrationDirectoryExists(timeline);
  if (rows.length && sourceExists) {
    if (!existsSync(entries)) mkdirSync(entries, { mode: 0o700 });
    const stat = lstatSync(entries);
    if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Legacy pending archive export requires a private directory.");
    syncDirectory(root);
  }
  for (const row of rows) {
    if (!sourceExists || typeof row.id !== "string" || typeof row.entry_seq !== "string" || sequences.has(row.entry_seq)) continue;
    const bytes = readMigrationSource(join(timeline, entryName(row.id)));
    if (bytes === undefined) continue;
    const file = `${randomUUID()}.json`;
    if (!publishMigrationFile(join(entries, file), bytes)) throw new Error("Pending entry publication collided with an existing file.");
    written.push({ id: row.id, file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
    sequences.add(row.entry_seq);
  }
  const keep = new Set(written.map(row => row.id)), remove = db.prepare("DELETE FROM content_index WHERE id=?");
  for (const row of rows) if (!keep.has(row.id)) remove.run(row.id);
  db.exec(schemaSql);
  const update = db.prepare("UPDATE content_index SET content_file=?,content_sha256=?,content_bytes=? WHERE id=?");
  for (const row of written) update.run(row.file, row.sha256, row.bytes, row.id);
};

/** Missing or non-regular sources cannot form an output; real IO failures propagate. */
export const readMigrationSource = (file: string): Buffer | undefined => {
  let stat;
  try { stat = lstatSync(file); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
  return readPrivateTimelineBytes(file);
};
