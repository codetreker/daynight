import Database from "better-sqlite3";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join, dirname } from "node:path";
import { controllerPayloadHash } from "./launch-ticket.js";
import { createHash, randomUUID } from "node:crypto";
import { parseTimelineEntry, parseSessionResource, type TimelineEntry, type SessionResource } from "../../session/protocol.js";
import { sessionArchiveReferences } from "../../session/archive.js";

/** Pending upload source, not a second permanent native session history. */
export type PendingResource = { resource: SessionResource; data: string | null };
export type ControlledResourceLease = { readonly path: string; readonly resource: SessionResource; read(offset: string, limit: number): Buffer; close(): void };
const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;
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
  const timelineDirectory = join(root, "timeline"), resourceDirectory = join(root, "resources"), blobDirectory = join(root, "blobs");
  mkdirSync(timelineDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(resourceDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(blobDirectory, { recursive: true, mode: 0o700 });
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
  const leases = new Map<string, number>();
  const pinsPath = join(root, "resource-pins.json");
  const pins: Record<string, string[]> = existsSync(pinsPath) ? JSON.parse(readFileSync(pinsPath, "utf8")) as Record<string, string[]> : {};
  if (!pins || Array.isArray(pins) || typeof pins !== "object" || Object.values(pins).some(values => !Array.isArray(values) || values.some(value => typeof value !== "string" || !value))) throw new Error("Invalid persistent resource references.");
  const name = (id: string) => `${createHash("sha256").update(id).digest("hex")}.json`;
  for (const file of readdirSync(timelineDirectory).filter(file => file.endsWith(".json"))) {
    const entry = parseTimelineEntry(JSON.parse(readFileSync(join(timelineDirectory, file), "utf8")));
    if (name(entry.entryId) !== file || entries.has(entry.entryId)) throw new Error("Invalid pending timeline identity.");
    entries.set(entry.entryId, entry);
  }
  let lastEntrySequence = [...entries.values()].reduce((maximum, entry) => BigInt(entry.entrySeq) > maximum ? BigInt(entry.entrySeq) : maximum, 0n);
  const sequences = new Set([...entries.values()].map(entry => entry.entrySeq));
  if (sequences.size !== entries.size) throw new Error("Duplicate pending timeline sequence.");
  const blobPath = (id: string) => join(blobDirectory, name(id).replace(/\.json$/, ".bin"));
  const openBlob = (resource: SessionResource): number => {
    const file = blobPath(resource.resourceId);
    if (!existsSync(file)) throw new Error("Pending archive source is incomplete: saved resource blob is missing.");
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || String(stat.size) !== resource.byteLength) { closeSync(fd); throw new Error("Corrupt pending resource content."); }
    return fd;
  };
  const verifyBlob = (resource: SessionResource): void => {
    const fd = openBlob(resource);
    try {
      const hash = createHash("sha256"), block = Buffer.alloc(524288); let count = 0;
      for (;;) { const size = readSync(fd, block, 0, block.length, count); if (!size) break; count += size; hash.update(block.subarray(0, size)); }
      if (count > MAX_RESOURCE_BYTES || String(count) !== resource.byteLength || hash.digest("hex") !== resource.sha256) throw new Error("Corrupt pending resource content.");
    } finally { closeSync(fd); }
  };
  const publishBytes = (resource: SessionResource, copy: (fd: number) => { length: number; digest: string }): void => {
    if (resource.status !== "available" || resource.byteLength === null || resource.sha256 === null || BigInt(resource.byteLength) > BigInt(MAX_RESOURCE_BYTES)) throw new Error("Invalid pending resource bytes.");
    const file = blobPath(resource.resourceId), temporary = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    let published = false;
    try {
      const result = copy(fd);
      if (result.length > MAX_RESOURCE_BYTES || String(result.length) !== resource.byteLength || result.digest !== resource.sha256) throw new Error("Corrupt pending resource content.");
      fsyncSync(fd); closeSync(fd);
      if (existsSync(file)) { verifyBlob(resource); unlinkSync(temporary); }
      else renameSync(temporary, file);
      syncDirectory(blobDirectory); published = true;
    } finally { if (!published) { try { closeSync(fd); } catch {} if (existsSync(temporary)) unlinkSync(temporary); } }
  };
  for (const file of readdirSync(resourceDirectory).filter(file => file.endsWith(".json"))) {
    const original = readFileSync(join(resourceDirectory, file));
    const value = JSON.parse(original.toString("utf8")) as PendingResource;
    const resource = parseSessionResource(value.resource);
    if (name(resource.resourceId) !== file || (value.data !== null && typeof value.data !== "string")) throw new Error("Invalid pending resource identity.");
    if (value.data !== null) {
      const content = Buffer.from(value.data, "base64");
      if (content.toString("base64") !== value.data) throw new Error("Corrupt pending resource content.");
      publishBytes(resource, fd => { writeFileSync(fd, content); return { length: content.length, digest: createHash("sha256").update(content).digest("hex") }; });
      // Keep the exact old source until the new reader has verified the closure.
      const legacy = join(root, "legacy-resources"); mkdirSync(legacy, { recursive: true, mode: 0o700 });
      const old = join(legacy, file); if (!existsSync(old)) { const fd = openSync(old, "wx", 0o600); try { writeFileSync(fd, original); fsyncSync(fd); } finally { closeSync(fd); } syncDirectory(legacy); }
      verifyBlob(resource); writeDurableJson(join(resourceDirectory, file), { resource, data: null });
    }
    if (resource.status === "available") verifyBlob(resource);
    resources.set(resource.resourceId, { resource, data: null });
  }
  // SQL content_index is the durable timeline inventory. Rewriting a growing
  // entry list on each insert would make an otherwise linear archive quadratic.
  // Resources have their own small inventory because their bytes do not live in SQL.
  const updateIndex = () => writeDurableJson(indexPath, { entries: [], resources: [...resources.keys()].map(name).sort() });
  const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  let entryBytes = [...entries.values()].reduce((sum, entry) => sum + encodedBytes(entry), 0);
  let descriptorBytes = [...resources.values()].reduce((sum, value) => sum + encodedBytes(value.resource), 0);
  const timelineBytes = (count = entries.size, bytes = entryBytes) => encodedBytes({ entries: [] }) + bytes + Math.max(0, count - 1);
  const checkResourceBudget = (resource?: SessionResource): void => {
    const known = new Set([...resources.keys()].map(id => name(id).replace(/\.json$/, ".bin")));
    let bytes = 0, orphans = 0;
    for (const file of readdirSync(blobDirectory).filter(file => file.endsWith(".bin"))) {
      const metadata = lstatSync(join(blobDirectory, file));
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Invalid pending resource blob.");
      bytes += metadata.size; if (!known.has(file)) orphans++;
    }
    let count = resources.size + orphans;
    if (resource && !resources.has(resource.resourceId)) {
      if (!existsSync(blobPath(resource.resourceId))) count++;
      if (resource.status === "available" && !existsSync(blobPath(resource.resourceId))) bytes += Number(resource.byteLength);
    } else if (resource?.status === "available" && !existsSync(blobPath(resource.resourceId))) bytes += Number(resource.byteLength);
    if (count > 1000 || bytes > 1073741824) throw new Error("Pending session resource budget exceeded.");
    const metadata = descriptorBytes - (resource && resources.has(resource.resourceId) ? encodedBytes(resources.get(resource.resourceId)!.resource) : 0) + (resource ? encodedBytes(resource) : 0);
    if (metadata > 4 * 1024 * 1024) throw new Error("Pending resource metadata budget exceeded.");
  };
  if (entries.size > 100000 || timelineBytes() > 64 * 1024 * 1024) throw new Error("Pending session timeline budget exceeded.");
  checkResourceBudget();
  // An interrupted insert may leave a committed file ahead of the index; adopt it.
  updateIndex();
  const saveEntry = (value: TimelineEntry) => {
    const entry = parseTimelineEntry(JSON.parse(JSON.stringify(value)));
    const old = entries.get(entry.entryId);
    if (old && (old.entrySeq !== entry.entrySeq || BigInt(old.revision) > BigInt(entry.revision))) throw new Error("Pending timeline revision regressed.");
    if (old && JSON.stringify(old) === JSON.stringify(entry)) return;
    const count = entries.size + (old ? 0 : 1), bytes = entryBytes - (old ? encodedBytes(old) : 0) + encodedBytes(entry);
    if (count > 100000 || timelineBytes(count, bytes) > 64 * 1024 * 1024) throw new Error("Pending session timeline budget exceeded.");
    writeDurableJson(join(timelineDirectory, name(entry.entryId)), entry);
    entries.set(entry.entryId, entry);
    entryBytes = bytes;
    if (BigInt(entry.entrySeq) > lastEntrySequence) lastEntrySequence = BigInt(entry.entrySeq);
  };
  const saveResource = (value: PendingResource, bytes?: Uint8Array) => {
    parseSessionResource(value.resource);
    const input = bytes ?? (value.data === null ? undefined : Buffer.from(value.data, "base64"));
    if (value.data !== null && Buffer.from(value.data, "base64").toString("base64") !== value.data) throw new Error("Corrupt pending resource content.");
    const previous = resources.get(value.resource.resourceId);
    if (previous?.resource.status === "available" && JSON.stringify(previous.resource) !== JSON.stringify(value.resource)) throw new Error("An available local resource cannot change identity.");
    checkResourceBudget(value.resource);
    if (input !== undefined) publishBytes(value.resource, fd => { writeFileSync(fd, input); return { length: input.byteLength, digest: createHash("sha256").update(input).digest("hex") }; });
    if (value.resource.status === "available") verifyBlob(value.resource);
    const normalized = { resource: value.resource, data: null };
    if (previous && JSON.stringify(previous) === JSON.stringify(normalized)) return;
    const existed = previous !== undefined;
    writeDurableJson(join(resourceDirectory, name(value.resource.resourceId)), normalized);
    resources.set(value.resource.resourceId, JSON.parse(JSON.stringify(normalized)) as PendingResource);
    descriptorBytes += encodedBytes(value.resource) - (previous ? encodedBytes(previous.resource) : 0);
    if (!existed) updateIndex();
  };
  const writeResource = (resource: SessionResource, bytes: Uint8Array) => saveResource({ resource, data: null }, bytes);
  const importResourceFile = (resource: SessionResource, source: string): void => {
    const previous = resources.get(resource.resourceId);
    if (previous?.resource.status === "available" && JSON.stringify(previous.resource) !== JSON.stringify(resource)) throw new Error("An available local resource cannot change identity.");
    checkResourceBudget(parseSessionResource(resource));
    const before = lstatSync(source), input = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(input);
      if (!before.isFile() || before.isSymbolicLink() || before.dev !== stat.dev || before.ino !== stat.ino || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Resource import requires a private regular file.");
      publishBytes(resource, output => { const block = Buffer.alloc(524288), hash = createHash("sha256"); let length = 0;
        for (;;) { const size = readSync(input, block, 0, block.length, length); if (!size) break; if (length + size > MAX_RESOURCE_BYTES) throw new Error("Resource exceeds its byte budget."); let offset = 0; while (offset < size) offset += writeSync(output, block, offset, size - offset); hash.update(block.subarray(0, size)); length += size; }
        return { length, digest: hash.digest("hex") };
      });
    } finally { closeSync(input); }
    saveResource({ resource, data: null });
  };
  const acquireResource = (id: string): ControlledResourceLease => {
    const resource = resources.get(id)?.resource;
    if (!resource || resource.status !== "available") throw new Error("Local session resource is unavailable.");
    const fd = openBlob(resource); let closed = false; leases.set(id, (leases.get(id) ?? 0) + 1);
    return { path: blobPath(id), resource, read(offset, limit) {
      if (closed) throw new Error("Resource lease is closed.");
      if (!/^(0|[1-9][0-9]{0,18})$/.test(offset) || BigInt(offset) > BigInt(resource.byteLength!) || !Number.isSafeInteger(limit) || limit < 1 || limit > 524288) throw new Error("Invalid local resource chunk limit.");
      const size = Math.min(limit, Number(BigInt(resource.byteLength!) - BigInt(offset))), block = Buffer.alloc(size);
      if (size && readSync(fd, block, 0, size, Number(offset)) !== size) throw new Error("Corrupt pending resource content."); return block;
    }, close() { if (!closed) { closeSync(fd); closed = true; leases.set(id, leases.get(id)! - 1); } } };
  };
  const pinResource = (id: string, reference: string): void => { if (!resources.has(id) || !reference) throw new Error("Invalid resource reference."); pins[id] = [...new Set([...(pins[id] ?? []), reference])]; writeDurableJson(pinsPath, pins); };
  const unpinResource = (id: string, reference: string): void => { pins[id] = (pins[id] ?? []).filter(value => value !== reference); writeDurableJson(pinsPath, pins); };
  const releaseResource = (id: string): void => {
    if ((leases.get(id) ?? 0) > 0 || (pins[id]?.length ?? 0) > 0) throw new Error("Resource has an active lease or reference.");
    if (sessionArchiveReferences([...entries.values()], false).resources.has(id)) throw new Error("Resource is referenced by session history.");
    if (existsSync(blobPath(id))) unlinkSync(blobPath(id));
    if (existsSync(join(resourceDirectory, name(id)))) unlinkSync(join(resourceDirectory, name(id)));
    syncDirectory(blobDirectory); syncDirectory(resourceDirectory); descriptorBytes -= resources.has(id) ? encodedBytes(resources.get(id)!.resource) : 0; resources.delete(id); delete pins[id]; writeDurableJson(pinsPath, pins); updateIndex();
  };
  return { root, entries, resources, saveEntry, saveResource, writeResource, importResourceFile, acquireResource, pinResource, unpinResource, releaseResource, metadataBytes: () => timelineBytes() + descriptorBytes, nextEntrySequence: () => String(lastEntrySequence + 1n) };
};
export type PendingContent = ReturnType<typeof openPendingContent>;

/** File commit precedes SQL deletion. A crash leaves either both copies or files only. */
export const migratePendingContent = (db: Database.Database, content: PendingContent, schemaSql: string): void => {
  if (!db.inTransaction) throw new Error("Pending content migration requires the journal migration transaction.");
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
    const existing = content.entries.get(entry.entryId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error("Legacy projection conflicts with pending archive source.");
    writeDurableJson(join(sourceDirectory,`${row.seq}.timeline.json`),row);
    content.saveEntry(entry);
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
  for (const entry of content.entries.values()) db.prepare("INSERT INTO content_index VALUES(?,?,?,?)").run(entry.entryId, controllerPayloadHash(entry), entry.revision, entry.entrySeq);
};

/** Called after the enclosing SQLite migration reports a committed outcome. */
export const finalizePendingMigration = (db: Database.Database, content: PendingContent): void => {
  const path=join(content.root,"migration.json");if (!existsSync(path)) return;
  if (db.inTransaction) throw new Error("Migration readback requires a committed journal.");
  const marker=JSON.parse(readFileSync(path,"utf8")) as {migrationId:string;sourceHash:string;phase:string};
  if (marker.phase === "verified") return;
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name IN ('projection','resources')").get()) return;
  if (marker.phase !== "files_durable" && marker.phase !== "committed") throw new Error("Pending migration files were not confirmed durable.");
  writeDurableJson(path,{...marker,phase:"committed"});
  const reopened=openPendingContent(db.name,(JSON.parse(readFileSync(join(content.root,"manifest.json"),"utf8")) as {sessionId:string}).sessionId);
  reconcilePendingContent(db,reopened);
  writeDurableJson(path,{...marker,phase:"verified"});
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
