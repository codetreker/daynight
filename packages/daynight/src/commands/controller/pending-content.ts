import Database from "better-sqlite3";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { controllerPayloadHash } from "./launch-ticket.js";
import { createHash, randomUUID } from "node:crypto";
import { parseTimelineEntry, parseSessionResource, type TimelineEntry } from "../../session/protocol.js";
import { sessionArchiveReferences } from "../../session/archive.js";
import { controllerMetadataBudget } from "./media/metadata-budget.js";
import { syncDirectory, writeDurableJson } from "../../platform/durable-json.js";
import { openResourceFiles } from "./content/resource-files.js";

const entryName = (id: string) => `${createHash("sha256").update(id).digest("hex")}.json`;
type EntryPointer = { id: string; content_hash: string; revision: string; entry_seq: string; content_file: string; content_sha256: string; content_bytes: number };
const openPendingContentFiles = (journal: string, sessionId: string, db: Database.Database) => {
  const root = `${journal}.pending-content`;
  const timelineDirectory = join(root, "timeline"), entryDirectory = join(root, "entries");
  mkdirSync(timelineDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(entryDirectory, { recursive: true, mode: 0o700 });
  const entryStat = lstatSync(entryDirectory);
  if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) throw new Error("Invalid pending entry directory.");
  const resourceFiles = openResourceFiles(journal, sessionId);
  const read = <T>(action: () => T): T => db.inTransaction ? action() : db.transaction(action).deferred();
  const loadEntry = (pointer: EntryPointer): TimelineEntry => {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.test(pointer.content_file) || !/^[a-f0-9]{64}$/.test(pointer.content_sha256) || !Number.isSafeInteger(pointer.content_bytes) || pointer.content_bytes < 1 || pointer.content_bytes > 64 * 1024 * 1024) throw new Error("Pending archive entry pointer is corrupt.");
    const file = join(entryDirectory, pointer.content_file);
    if (!existsSync(file)) throw new Error("Pending archive source is incomplete: committed entry is missing.");
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("Pending archive entry is corrupt.");
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || stat.size !== pointer.content_bytes) throw new Error("Pending archive entry is corrupt.");
      bytes = Buffer.alloc(pointer.content_bytes);
      let offset = 0;
      while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) throw new Error("Pending archive entry is corrupt."); offset += count; }
      if (readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0) throw new Error("Pending archive entry is corrupt.");
    }
    finally { closeSync(fd); }
    if (createHash("sha256").update(bytes).digest("hex") !== pointer.content_sha256) throw new Error("Pending archive entry is corrupt.");
    const entry = parseTimelineEntry(JSON.parse(bytes.toString("utf8")));
    if (entry.entryId !== pointer.id || entry.entrySeq !== pointer.entry_seq || entry.revision !== pointer.revision || controllerPayloadHash(entry) !== pointer.content_hash) throw new Error("Pending archive entry differs from its committed pointer.");
    return entry;
  };
  const getEntry = (id: string): TimelineEntry | undefined => read(() => { const row = db.prepare("SELECT * FROM content_index WHERE id=?").get(id) as EntryPointer | undefined; return row && loadEntry(row); });
  const entries = (): Map<string, TimelineEntry> => read(() => new Map((db.prepare("SELECT * FROM content_index").all() as EntryPointer[]).map(row => [row.id, loadEntry(row)])));
  const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const timelineBytes = (count: number, bytes: number) => encodedBytes({ entries: [] }) + bytes + Math.max(0, count - 1);
  const timelineSize = () => read(() => db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(content_bytes),0) AS bytes FROM content_index").get() as { count: number; bytes: number });
  const saveEntry = (value: TimelineEntry) => {
    if (!db.inTransaction) throw new Error("Pending entry publication requires the journal transaction.");
    const entry = parseTimelineEntry(JSON.parse(JSON.stringify(value)));
    const old = getEntry(entry.entryId);
    if (old && (old.entrySeq !== entry.entrySeq || BigInt(old.revision) > BigInt(entry.revision))) throw new Error("Pending timeline revision regressed.");
    if (old && JSON.stringify(old) === JSON.stringify(entry)) return;
    if (old?.revision === entry.revision) throw new Error("Pending timeline revision cannot change its content.");
    const size = timelineSize(), count = size.count + (old ? 0 : 1), bytes = size.bytes - (old ? encodedBytes(old) : 0) + encodedBytes(entry);
    if (count > 100000 || timelineBytes(count, bytes) > 64 * 1024 * 1024) throw new Error("Pending session timeline budget exceeded.");
    const pointer = writeEntryCandidate(journal, db, entry);
    db.prepare("INSERT INTO content_index(id,content_hash,revision,entry_seq,content_file,content_sha256,content_bytes) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content_hash=excluded.content_hash,revision=excluded.revision,entry_seq=excluded.entry_seq,content_file=excluded.content_file,content_sha256=excluded.content_sha256,content_bytes=excluded.content_bytes").run(entry.entryId, controllerPayloadHash(entry), entry.revision, entry.entrySeq, pointer.file, pointer.sha256, pointer.bytes);
  };
  const releaseResource = (id: string): void => read(() => {
    if (db.prepare("SELECT 1 FROM native_input_publication_images WHERE resource_id=? LIMIT 1").get(id) || sessionArchiveReferences([...entries().values()], false).resources.has(id)) throw new Error("Resource is referenced by session history.");
    resourceFiles.releaseResource(id);
  });
  return { ...resourceFiles, resourceFiles: { ...resourceFiles, releaseResource }, releaseResource, get entries() { return entries(); }, getEntry, hasEntry: (id: string) => getEntry(id) !== undefined, saveEntry,
    hasRetainedEntries: () => [timelineDirectory, entryDirectory].some(directory => readdirSync(directory).some(file => file.endsWith(".json"))),
    metadataBytes: () => { const size = timelineSize(); return timelineBytes(size.count, size.bytes) + resourceFiles.descriptorBytes(); },
    nextEntrySequence: () => read(() => String(BigInt((db.prepare("SELECT CAST(COALESCE(MAX(CAST(entry_seq AS INTEGER)),0) AS TEXT) AS sequence FROM content_index").get() as { sequence: string }).sequence) + 1n)),
  };
};

const writeEntryCandidate = (journal: string, db: Database.Database, entry: TimelineEntry): { file: string; sha256: string; bytes: number } => {
  const bytes = Buffer.from(JSON.stringify(entry)), directory = join(`${journal}.pending-content`, "entries");
  controllerMetadataBudget(journal, db).assert(bytes.length + 16_384, true);
  const file = `${randomUUID()}.json`, fd = openSync(join(directory, file), "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(directory);
  // Old snapshots and unknown commits may still reference candidates. Their
  // actual bytes remain charged until a reader-safe maintenance owner removes them.
  return { file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
};

export const openPendingContent = (journal: string, sessionId: string, db: Database.Database) => {
  const content = openPendingContentFiles(journal, sessionId, db);
  const validate = () => {
    const size = db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(content_bytes),0) AS bytes FROM content_index").get() as { count: number; bytes: number };
    if (size.count > 100000 || !Number.isSafeInteger(size.bytes) || size.bytes < 0 || Buffer.byteLength('{"entries":[]}') + size.bytes + Math.max(0, size.count - 1) > 64 * 1024 * 1024) throw new Error("Pending session timeline budget exceeded.");
    void content.entries;
  };
  if (db.inTransaction) validate(); else db.transaction(validate).deferred();
  return content;
};
export type PendingContent = ReturnType<typeof openPendingContent>;

/** File commit precedes SQL deletion. A crash leaves either both copies or files only. */
export const migratePendingContent = (db: Database.Database, sessionId: string, schemaSql: string): void => {
  if (!db.inTransaction) throw new Error("Pending content migration requires the journal migration transaction.");
  const content = openPendingContentFiles(db.name, sessionId, db), entries: TimelineEntry[] = [];
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
    const bytes = Buffer.byteLength(JSON.stringify(entry)); timelineBytes += bytes + (entries.length ? 1 : 0);
    if (entries.length >= 100000 || timelineBytes > 64 * 1024 * 1024) throw new Error("Pending session timeline budget exceeded.");
    const filename = join(content.root, "timeline", entryName(entry.entryId));
    const existing = existsSync(filename) ? parseTimelineEntry(JSON.parse(readFileSync(filename, "utf8"))) : undefined;
    if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error("Legacy projection conflicts with pending archive source.");
    controllerMetadataBudget(db.name, db).assert(bytes + Buffer.byteLength(JSON.stringify(row)) + 16_384, true);
    writeDurableJson(join(sourceDirectory,`${row.seq}.timeline.json`),row);
    writeDurableJson(filename, entry); entries.push(entry);
  }
  for (const row of db.prepare("SELECT descriptor,content FROM resources").iterate() as Iterable<{ descriptor: string; content: Buffer | null }>) {
    const resource = parseSessionResource(JSON.parse(row.descriptor));
    const value = { resource, data: row.content?.toString("base64") ?? null };
    const existing = content.resources.get(resource.resourceId);
    if (existing && controllerPayloadHash(existing.resource) !== controllerPayloadHash(resource)) throw new Error("Legacy resource conflicts with pending archive source.");
    writeDurableJson(join(sourceDirectory,`${resource.resourceId}.resource.json`),{descriptor:row.descriptor,content:row.content?.toString("base64")??null});
    content.saveResource(value);
  }
  writeDurableJson(markerPath,{...marker,phase:"files_durable"});
  db.exec(schemaSql);
  for (const entry of entries) db.prepare("INSERT INTO content_index VALUES(?,?,?,?)").run(entry.entryId, controllerPayloadHash(entry), entry.revision, entry.entrySeq);
};

/** Old mutable files are admitted only when they exactly match the SQL commit. */
export const migratePendingEntryPointers = (db: Database.Database, sessionId: string, schemaSql: string): void => {
  if (!db.inTransaction) throw new Error("Pending entry migration requires the journal migration transaction.");
  if (!existsSync(join(`${db.name}.pending-content`, "manifest.json"))) throw new Error("Pending archive source is missing.");
  const content = openPendingContentFiles(db.name, sessionId, db), directory = join(content.root, "timeline");
  const rows = db.prepare("SELECT id,content_hash,revision,entry_seq FROM content_index").all() as Omit<EntryPointer, "content_file" | "content_sha256" | "content_bytes">[];
  if (rows.length > 100000) throw new Error("Pending session timeline budget exceeded.");
  const indexed = new Set(rows.map(row => entryName(row.id))), sequences = new Set<string>();
  for (const file of readdirSync(directory).filter(file => file.endsWith(".json"))) if (!indexed.has(file)) throw new Error("Legacy pending timeline has an uncommitted entry; original evidence was retained.");
  let timelineBytes = Buffer.byteLength('{"entries":[]}');
  const entries = rows.map((row, index) => {
    const filename = join(directory, entryName(row.id));
    if (!existsSync(filename)) throw new Error("Pending archive source is incomplete.");
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error("Legacy pending timeline source is corrupt.");
    const entry = parseTimelineEntry(JSON.parse(readFileSync(filename, "utf8")));
    timelineBytes += Buffer.byteLength(JSON.stringify(entry)) + (index ? 1 : 0);
    if (timelineBytes > 64 * 1024 * 1024) throw new Error("Pending session timeline budget exceeded.");
    if (entry.entryId !== row.id || entry.entrySeq !== row.entry_seq || entry.revision !== row.revision || controllerPayloadHash(entry) !== row.content_hash || sequences.has(entry.entrySeq)) throw new Error("Legacy pending timeline differs from its committed index; original evidence was retained.");
    sequences.add(entry.entrySeq); return entry;
  });
  db.exec(schemaSql);
  for (const entry of entries) {
    const pointer = writeEntryCandidate(db.name, db, entry);
    db.prepare("UPDATE content_index SET content_file=?,content_sha256=?,content_bytes=? WHERE id=?").run(pointer.file, pointer.sha256, pointer.bytes, entry.entryId);
  }
};

/** Called after the enclosing SQLite migration reports a committed outcome. */
export const finalizePendingMigration = (db: Database.Database, content: PendingContent): void => {
  const path=join(content.root,"migration.json");if (!existsSync(path)) return;
  if (db.inTransaction) throw new Error("Migration readback requires a committed journal.");
  const marker=JSON.parse(readFileSync(path,"utf8")) as {migrationId:string;sourceHash:string;phase:string};
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name IN ('projection','resources')").get()) return;
  if (!["files_durable", "committed", "verified"].includes(marker.phase)) throw new Error("Pending migration files were not confirmed durable.");
  if (marker.phase !== "verified") writeDurableJson(path,{...marker,phase:"committed"});
  const reopened=openPendingContent(db.name,(JSON.parse(readFileSync(join(content.root,"manifest.json"),"utf8")) as {sessionId:string}).sessionId,db);
  reconcilePendingContent(db,reopened);
  writeDurableJson(path,{...marker,phase:"verified"});
};

/** A candidate without a committed pointer is never promoted by recovery. */
export const reconcilePendingContent = (db: Database.Database, content: PendingContent): void => {
  db.transaction(() => {
    const entries = content.entries;
    if (new Set([...entries.values()].map(entry => entry.entrySeq)).size !== entries.size) throw new Error("Duplicate pending timeline sequence.");
  }).deferred();
};
