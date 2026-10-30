import Database from "better-sqlite3";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { controllerPayloadHash } from "./launch-ticket.js";
import { createHash, randomUUID } from "node:crypto";
import { parseTimelineEntry, parseSessionResource, type TimelineEntry, type SessionResource } from "../../session/protocol.js";

/** Pending upload source, not a second permanent native session history. */
export type PendingResource = { resource: SessionResource; data: string | null };
const syncDirectory = (directory: string): void => {
  // Windows does not expose directory handles through fs.open; file flush remains mandatory.
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
};
export const writeDurableJson = (file: string, value: unknown): void => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  syncDirectory(dirname(file));
};
export const openPendingContent = (journal: string, sessionId: string) => {
  const root = `${journal}.pending-content`;
  const timelineDirectory = join(root, "timeline"), resourceDirectory = join(root, "resources");
  mkdirSync(timelineDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(resourceDirectory, { recursive: true, mode: 0o700 });
  syncDirectory(dirname(root));
  const manifest = join(root, "manifest.json");
  if (existsSync(manifest)) {
    const value = JSON.parse(readFileSync(manifest, "utf8")) as { schemaVersion: number; sessionId: string };
    if (value.schemaVersion !== 1 || value.sessionId !== sessionId) throw new Error("Pending content belongs to another session.");
  } else writeDurableJson(manifest, { schemaVersion: 1, sessionId });
  const indexPath = join(root, "index.json");
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) as { entries: string[]; resources: string[] } : { entries: [], resources: [] };
  if (!Array.isArray(index.entries) || !Array.isArray(index.resources)) throw new Error("Invalid pending content index.");
  for (const [directory, names] of [[timelineDirectory, index.entries], [resourceDirectory, index.resources]] as const) {
    for (const name of names) if (!/^[a-f0-9]{64}\.json$/.test(name) || !existsSync(join(directory, name))) throw new Error("Pending archive source is incomplete.");
  }
  const entries = new Map<string, TimelineEntry>();
  const resources = new Map<string, PendingResource>();
  const name = (id: string) => `${createHash("sha256").update(id).digest("hex")}.json`;
  for (const file of readdirSync(timelineDirectory).filter(file => file.endsWith(".json"))) {
    const entry = parseTimelineEntry(JSON.parse(readFileSync(join(timelineDirectory, file), "utf8")));
    if (name(entry.entryId) !== file || entries.has(entry.entryId)) throw new Error("Invalid pending timeline identity.");
    entries.set(entry.entryId, entry);
  }
  let lastEntrySequence = [...entries.values()].reduce((maximum, entry) => BigInt(entry.entrySeq) > maximum ? BigInt(entry.entrySeq) : maximum, 0n);
  const sequences = new Set([...entries.values()].map(entry => entry.entrySeq));
  if (sequences.size !== entries.size) throw new Error("Duplicate pending timeline sequence.");
  for (const file of readdirSync(resourceDirectory).filter(file => file.endsWith(".json"))) {
    const value = JSON.parse(readFileSync(join(resourceDirectory, file), "utf8")) as PendingResource;
    const resource = parseSessionResource(value.resource);
    if (name(resource.resourceId) !== file || (value.data !== null && typeof value.data !== "string")) throw new Error("Invalid pending resource identity.");
    if (value.data !== null) {
      const content = Buffer.from(value.data, "base64");
      if (content.toString("base64") !== value.data || String(content.length) !== resource.byteLength || createHash("sha256").update(content).digest("hex") !== resource.sha256) throw new Error("Corrupt pending resource content.");
    }
    resources.set(resource.resourceId, { resource, data: value.data });
  }
  // SQL content_index is the durable timeline inventory. Rewriting a growing
  // entry list on each insert would make an otherwise linear archive quadratic.
  // Resources have their own small inventory because their bytes do not live in SQL.
  const updateIndex = () => writeDurableJson(indexPath, { entries: [], resources: [...resources.keys()].map(name).sort() });
  // An interrupted insert may leave a committed file ahead of the index; adopt it.
  updateIndex();
  const saveEntry = (value: TimelineEntry) => {
    const entry = parseTimelineEntry(JSON.parse(JSON.stringify(value)));
    const old = entries.get(entry.entryId);
    if (old && (old.entrySeq !== entry.entrySeq || BigInt(old.revision) > BigInt(entry.revision))) throw new Error("Pending timeline revision regressed.");
    if (old && JSON.stringify(old) === JSON.stringify(entry)) return;
    writeDurableJson(join(timelineDirectory, name(entry.entryId)), entry);
    entries.set(entry.entryId, entry);
    if (BigInt(entry.entrySeq) > lastEntrySequence) lastEntrySequence = BigInt(entry.entrySeq);
  };
  const saveResource = (value: PendingResource) => {
    parseSessionResource(value.resource);
    if (value.data !== null) {
      const bytes = Buffer.from(value.data, "base64");
      if (bytes.length > 8_388_608 || bytes.toString("base64") !== value.data || String(bytes.length) !== value.resource.byteLength || createHash("sha256").update(bytes).digest("hex") !== value.resource.sha256) throw new Error("Corrupt pending resource content.");
    }
    const previous = resources.get(value.resource.resourceId);
    if (previous && JSON.stringify(previous) === JSON.stringify(value)) return;
    const existed = previous !== undefined;
    writeDurableJson(join(resourceDirectory, name(value.resource.resourceId)), value);
    resources.set(value.resource.resourceId, JSON.parse(JSON.stringify(value)) as PendingResource);
    if (!existed) updateIndex();
  };
  return { entries, resources, saveEntry, saveResource, nextEntrySequence: () => String(lastEntrySequence + 1n) };
};
export type PendingContent = ReturnType<typeof openPendingContent>;

/** File commit precedes SQL deletion. A crash leaves either both copies or files only. */
export const migratePendingContent = (db: Database.Database, content: PendingContent): void => {
  const version = Number(db.pragma("user_version", { simple: true }));
  if (version >= 6) return;
  db.pragma("secure_delete = ON");
  db.transaction(() => {
    for (const row of db.prepare("SELECT CAST(rowid AS TEXT) AS seq,value FROM projection ORDER BY rowid").iterate() as Iterable<{ seq: string; value: string }>) {
      const entry = parseTimelineEntry({ ...JSON.parse(row.value) as object, entrySeq: row.seq });
      const existing = content.entries.get(entry.entryId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error("Legacy projection conflicts with pending archive source.");
      content.saveEntry(entry);
    }
    for (const row of db.prepare("SELECT descriptor,content FROM resources").iterate() as Iterable<{ descriptor: string; content: Buffer | null }>) {
      const resource = parseSessionResource(JSON.parse(row.descriptor));
      const value = { resource, data: row.content?.toString("base64") ?? null };
      const existing = content.resources.get(resource.resourceId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(value)) throw new Error("Legacy resource conflicts with pending archive source.");
      content.saveResource(value);
    }
    db.exec("ALTER TABLE execution ADD COLUMN archive_incomplete INTEGER NOT NULL DEFAULT 0; UPDATE execution SET archive_incomplete=1 WHERE projection_gap IS NOT NULL; CREATE TABLE content_index (id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, revision TEXT NOT NULL, entry_seq TEXT NOT NULL);");
    for (const entry of content.entries.values()) db.prepare("INSERT INTO content_index VALUES(?,?,?,?)").run(entry.entryId, controllerPayloadHash(entry), entry.revision, entry.entrySeq);
    db.exec("DROP TABLE projection; DROP TABLE resources; PRAGMA user_version=6;");
  }).immediate();
  db.pragma("wal_checkpoint(TRUNCATE)");
};

/** Files may be ahead of a rolled-back SQL delivery transaction, never behind it. */
export const reconcilePendingContent = (db: Database.Database, content: PendingContent): void => {
  db.transaction(() => {
    const rows = db.prepare("SELECT id,content_hash,revision,entry_seq FROM content_index").all() as { id: string; content_hash: string; revision: string; entry_seq: string }[];
    const indexed = new Map(rows.map(row => [row.id, row]));
    for (const row of rows) {
      const entry = content.entries.get(row.id);
      if (!entry || entry.entrySeq !== row.entry_seq || BigInt(entry.revision) < BigInt(row.revision) || entry.revision === row.revision && controllerPayloadHash(entry) !== row.content_hash) throw new Error("Pending archive source is incomplete or corrupt.");
    }
    for (const entry of content.entries.values()) {
      const row = indexed.get(entry.entryId);
      if (row?.content_hash === controllerPayloadHash(entry)) continue;
      db.prepare("INSERT INTO content_index VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET content_hash=excluded.content_hash,revision=excluded.revision,entry_seq=excluded.entry_seq").run(entry.entryId, controllerPayloadHash(entry), entry.revision, entry.entrySeq);
      db.prepare("UPDATE execution SET projection_gap=COALESCE(projection_gap,?) WHERE id=1").run("Recovered pending timeline requires full relay resynchronization.");
    }
  }).immediate();
};
