import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { ClaudeTranscriptJson, TranscriptBase64Decoder, type TranscriptLine } from "./claude-transcript-json.js";

export class ClaudeTranscriptError extends Error {
  override readonly name = "ClaudeTranscriptError";
  constructor(readonly code: "unauthorized" | "identity_changed" | "snapshot_changed" | "invalid_transcript" | "chain_gap" | "limit_exceeded" | "invalid_cursor" | "media_unavailable" | "closed", message: string) { super(message); }
}
export type ClaudeTranscriptMedia = { readonly mediaId: string; readonly path: readonly (string | number)[]; readonly mediaType: string; readonly byteLength: number; readonly state: "available" | "unavailable"; readonly error: string | null };
export type ClaudeTranscriptRecord = { readonly value: Record<string, unknown>; readonly media: readonly ClaudeTranscriptMedia[]; readonly assistantBlockOffset: number | null; readonly rootInputUuid?: string | null };
export type ClaudeTranscriptSnapshot = { readonly snapshotId: string; readonly historyEpoch: string; readonly nativeSessionId: string; readonly prefixBytes: number; readonly prefixSha256: string; readonly chainSha256: string; readonly records: number };
export type ClaudeTranscriptPage = { readonly snapshotId: string; readonly records: readonly ClaudeTranscriptRecord[]; readonly cursor: string; readonly done: boolean };
export type ClaudeTranscriptIndexReservation = { release(): void | Promise<void> };
export type ClaudeTranscriptOptions = {
  readonly nativeHome: string; readonly cwd: string; readonly nativeSessionId: string;
  /** A SessionStart hint is accepted only inside this home and for the exact root transcript. */
  readonly transcriptPath?: string;
  readonly indexDirectory: string;
  /** The Controller checks combined index, journal and sidecar metadata before each write. */
  readonly reserveIndex?: (additionalBytes: number) => void | ClaudeTranscriptIndexReservation | Promise<void | ClaudeTranscriptIndexReservation>;
  readonly resumeCursor?: string;
  readonly signal?: AbortSignal;
};
export interface ClaudeTranscriptReader {
  readonly snapshot: ClaudeTranscriptSnapshot;
  nextPage(options?: { maxRecords?: number }): Promise<ClaudeTranscriptPage>;
  /** Call only after the parent journal has durably accepted the complete page. */
  acknowledge(cursor: string): Promise<void>;
  readMedia(mediaId: string, consume: (bytes: Uint8Array) => void | Promise<void>, signal?: AbortSignal): Promise<void>;
  /** A verified append creates a new snapshot and restarts paging; native identities deduplicate reimport. */
  refresh(): Promise<ClaudeTranscriptSnapshot>;
  close(): Promise<void>;
}
type Row = { uuid: string; parent: string | null; type: string; message_id: string | null; timestamp: string; side: number; meta: number; team: number; ordinal: number; data: string; compact: string | null; tool_result: number; blocks: number };
type MediaRow = { id: string; uuid: string; start: number; end: number; bytes: number; error: string | null };
const MAX_INDEX = 134_217_728, MAX_RECORDS = 100_000, MAX_PAGE = 1_048_576 - 1024;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const key = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.isWellFormed() && !value.includes("\0") && Buffer.byteLength(value) <= 1024;
function fail(code: ClaudeTranscriptError["code"], message: string): never { throw new ClaudeTranscriptError(code, message); }
const inside = (root: string, target: string) => { const relative = path.relative(root, target); return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const locate = (value: unknown, at: readonly (string | number)[]) => { let current = value; for (const part of at) { if (typeof part === "number") current = Array.isArray(current) ? current[part] : undefined; else current = Object.hasOwn(object(current), part) ? object(current)[part] : undefined; } return current; };

async function noSymlinks(filename: string): Promise<void> {
  let component = path.parse(filename).root;
  for (const part of filename.slice(component.length).split(path.sep).filter(Boolean)) { component = path.join(component, part); if ((await lstat(component)).isSymbolicLink()) fail("unauthorized", "Claude transcript authorization rejects symbolic links."); }
}
async function authorize(options: ClaudeTranscriptOptions): Promise<{ handle: FileHandle; filename: string; cwd: string; identity: { dev: bigint; ino: bigint } }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.nativeSessionId) || !path.isAbsolute(options.nativeHome) || !path.isAbsolute(options.cwd)) fail("unauthorized", "Claude transcript requires an authorized native session and absolute roots.");
  const home = await realpath(options.nativeHome), cwd = await realpath(options.cwd);
  const projectKey = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (!options.transcriptPath && projectKey.length > 200) fail("unauthorized", "Claude transcript layout requires an authorized SessionStart path.");
  const filename = path.resolve(options.transcriptPath ?? path.join(home, "projects", projectKey, `${options.nativeSessionId}.jsonl`));
  const relative = path.relative(path.join(home, "projects"), filename).split(path.sep);
  if (!inside(path.join(home, "projects"), filename) || relative.length !== 2 || relative[1] !== `${options.nativeSessionId}.jsonl`) fail("unauthorized", "Claude transcript path is outside the authorized root session.");
  await noSymlinks(filename);
  const before = await lstat(filename, { bigint: true });
  if (!before.isFile()) fail("unauthorized", "Claude transcript is not an authorized regular file.");
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true }); await noSymlinks(filename);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || await realpath(filename) !== filename) fail("identity_changed", "Claude transcript file identity changed during authorization.");
    return { handle, filename, cwd, identity: { dev: opened.dev, ino: opened.ino } };
  } catch (error) { await handle.close(); throw error; }
}
async function prefixHash(handle: FileHandle, size: number, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256"), bytes = Buffer.allocUnsafe(65_536);
  for (let offset = 0; offset < size;) { signal?.throwIfAborted(); const { bytesRead } = await handle.read(bytes, 0, Math.min(bytes.length, size - offset), offset); if (!bytesRead) fail("snapshot_changed", "Claude transcript was truncated while reading its prefix."); hash.update(bytes.subarray(0, bytesRead)); offset += bytesRead; }
  return hash.digest("hex");
}
class TranscriptIndex {
  readonly db: Database.Database;
  private ordinal = 0;
  constructor(readonly filename: string, private readonly options: ClaudeTranscriptOptions, private readonly cwd: string) {
    this.db = new Database(filename);
    try {
    this.db.pragma("journal_mode = DELETE"); this.db.pragma("synchronous = FULL"); this.db.pragma("cache_size = -2048"); this.db.pragma("mmap_size = 0"); this.db.pragma("max_page_count = 32768");
    this.db.exec(`
      CREATE TABLE records(uuid TEXT PRIMARY KEY,parent TEXT,type TEXT NOT NULL,message_id TEXT,timestamp TEXT NOT NULL,side INTEGER NOT NULL,meta INTEGER NOT NULL,team INTEGER NOT NULL,ordinal INTEGER NOT NULL,data TEXT NOT NULL,compact TEXT,tool_result INTEGER NOT NULL,blocks INTEGER NOT NULL);
      CREATE INDEX parents ON records(parent);
      CREATE INDEX message_siblings ON records(message_id,timestamp,ordinal);
      CREATE INDEX physical_order ON records(ordinal);
      CREATE TABLE media(id TEXT PRIMARY KEY,uuid TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,bytes INTEGER NOT NULL,error TEXT);
      CREATE INDEX media_owner ON media(uuid);
      CREATE TABLE walk(uuid TEXT PRIMARY KEY);
      CREATE TABLE candidates(uuid TEXT PRIMARY KEY,ordinal INTEGER NOT NULL,main INTEGER NOT NULL);
      CREATE INDEX candidate_order ON candidates(main DESC,ordinal DESC);
      CREATE TABLE chain(position INTEGER PRIMARY KEY,uuid TEXT UNIQUE NOT NULL);
      CREATE TABLE selected(position INTEGER PRIMARY KEY,uuid TEXT UNIQUE NOT NULL,block_offset INTEGER,root_input TEXT);
    `);
    } catch (error) { this.db.close(); throw error; }
  }
  private async write<T>(additional: number, write: () => T): Promise<T> {
    this.options.signal?.throwIfAborted();
    const pages = this.db.pragma("page_count", { simple: true }) as number, size = this.db.pragma("page_size", { simple: true }) as number;
    if (pages * size + additional > MAX_INDEX) fail("limit_exceeded", "Claude transcript index metadata limit exceeded.");
    // DELETE-mode journaling may retain any preexisting page until commit.
    // Reserve its complete upper bound as well as bounded database growth.
    const permit = await this.options.reserveIndex?.(pages * (size + 8) + additional);
    try { this.options.signal?.throwIfAborted(); return write(); } finally { if (permit) await permit.release(); }
  }
  async add(line: TranscriptLine): Promise<void> {
    const raw = line.value;
    if (!["user", "assistant", "progress", "system", "attachment"].includes(String(raw.type)) || !key(raw.uuid)) return;
    if (++this.ordinal > MAX_RECORDS) fail("limit_exceeded", "Claude transcript record limit exceeded.");
    if (raw.sessionId !== this.options.nativeSessionId) fail("unauthorized", "Claude transcript native session identity differs.");
    if (typeof raw.cwd !== "string" || path.resolve(raw.cwd) !== this.cwd) fail("unauthorized", "Claude transcript working directory identity differs.");
    if (raw.parentUuid !== null && raw.parentUuid !== undefined && !key(raw.parentUuid)) fail("invalid_transcript", "Claude transcript parent identity is invalid.");
    const message = object(raw.message), content = message.content;
    const media: ClaudeTranscriptMedia[] = [], ranges: MediaRow[] = [];
    for (const range of line.media) {
      const source = object(locate(raw, range.path.slice(0, -1))), block = object(locate(raw, range.path.slice(0, -2)));
      if (block.type !== "image" || source.type !== "base64") fail("invalid_transcript", "Claude transcript media position has an unsupported schema.");
      delete source.data;
      const mediaId = sha(JSON.stringify([this.options.nativeSessionId, raw.uuid, range.path, range.start]));
      const error = range.error ?? (!["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"].includes(String(source.media_type)) ? "unsupported_media_type" : null);
      media.push({ mediaId, path: range.path, mediaType: typeof source.media_type === "string" ? source.media_type : "", byteLength: Number.isSafeInteger(range.byteLength) && range.byteLength >= 0 ? range.byteLength : 0, state: error ? "unavailable" : "available", error });
      ranges.push({ id: mediaId, uuid: raw.uuid, start: range.start, end: range.end, bytes: Number.isSafeInteger(range.byteLength) && range.byteLength >= 0 ? range.byteLength : 0, error });
    }
    const value: Record<string, unknown> = { type: raw.type, uuid: raw.uuid, parentUuid: raw.parentUuid ?? null, session_id: raw.sessionId, parent_tool_use_id: raw.parent_tool_use_id ?? null };
    if (raw.message !== undefined) value.message = { ...(key(message.id) ? { id: message.id } : {}), ...(typeof message.role === "string" ? { role: message.role } : {}), content };
    if (typeof raw.timestamp === "string") value.timestamp = raw.timestamp;
    if (key(raw.user_message_uuid)) value.user_message_uuid = raw.user_message_uuid;
    if (raw.type === "system" && raw.subtype === "compact_boundary") value.subtype = "compact_boundary";
    const data = JSON.stringify({ value, media });
    if (!data.isWellFormed() || Buffer.byteLength(data) > MAX_PAGE - 4096) fail("limit_exceeded", "Claude transcript record metadata exceeds the page limit.");
    const compact = raw.type === "system" && raw.subtype === "compact_boundary" ? JSON.stringify(object(raw.compactMetadata)) : null;
    const previous = this.db.prepare("SELECT length(CAST(data AS BLOB))+COALESCE(length(CAST(compact AS BLOB)),0) AS bytes FROM records WHERE uuid=?").get(raw.uuid) as { bytes: number } | undefined;
    // Include replaced payloads: DELETE journaling can be larger than the new record.
    await this.write((Buffer.byteLength(data) + Buffer.byteLength(compact ?? "") + (previous?.bytes ?? 0)) * 4 + 65_536, () => this.db.transaction(() => {
      this.db.prepare("DELETE FROM media WHERE uuid=?").run(raw.uuid);
      this.db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(uuid) DO UPDATE SET parent=excluded.parent,type=excluded.type,message_id=excluded.message_id,timestamp=excluded.timestamp,side=excluded.side,meta=excluded.meta,team=excluded.team,ordinal=excluded.ordinal,data=excluded.data,compact=excluded.compact,tool_result=excluded.tool_result,blocks=excluded.blocks").run(raw.uuid, raw.parentUuid ?? null, raw.type, raw.type === "assistant" && key(message.id) ? message.id : null, typeof raw.timestamp === "string" ? raw.timestamp : "", raw.isSidechain ? 1 : 0, raw.isMeta ? 1 : 0, raw.teamName ? 1 : 0, this.ordinal, data, compact, raw.type === "user" && Array.isArray(content) && content.some(part => object(part).type === "tool_result") ? 1 : 0, Array.isArray(content) ? content.length : 0);
      for (const range of ranges) this.db.prepare("INSERT INTO media VALUES(?,?,?,?,?,?)").run(range.id, range.uuid, range.start, range.end, range.bytes, range.error);
    })());
  }
  row(uuid: string): Row | undefined { return this.db.prepare("SELECT * FROM records WHERE uuid=?").get(uuid) as Row | undefined; }
  private *ordered(where: string, values: readonly unknown[] = []): Generator<Row> {
    const query = this.db.prepare(`SELECT * FROM records r WHERE ${where} AND ordinal>? ORDER BY ordinal LIMIT 1`);
    let ordinal = 0;
    for (;;) { const row = query.get(...values, ordinal) as Row | undefined; if (!row) return; ordinal = row.ordinal; yield row; }
  }
  private *timestampOrdered(where: string, values: readonly unknown[] = []): Generator<Row> {
    const query = this.db.prepare(`SELECT * FROM records r WHERE ${where} AND (timestamp>? OR timestamp=? AND ordinal>?) ORDER BY timestamp,ordinal LIMIT 1`);
    let timestamp = "", ordinal = 0;
    for (;;) { const row = query.get(...values, timestamp, timestamp, ordinal) as Row | undefined; if (!row) return; timestamp = row.timestamp; ordinal = row.ordinal; yield row; }
  }
  private *chain(): Generator<Row> {
    let position = MAX_RECORDS;
    for (;;) {
      const item = this.db.prepare("SELECT uuid,position FROM chain WHERE position<? ORDER BY position DESC LIMIT 1").get(position) as { uuid: string; position: number } | undefined;
      if (!item) return; position = item.position; yield this.row(item.uuid)!;
    }
  }
  private async reparent(row: Row, parent: string): Promise<void> {
    await this.write((Buffer.byteLength(row.data) + Buffer.byteLength(row.compact ?? "")) * 4 + 65_536, () => this.db.prepare("UPDATE records SET parent=? WHERE uuid=?").run(parent, row.uuid));
  }
  private async clearWalk(): Promise<void> {
    // Bound rollback-journal growth even when a prior ancestry walk used many pages.
    for (;;) {
      const rows = this.db.prepare("SELECT uuid FROM walk LIMIT 64").all() as { uuid: string }[];
      if (!rows.length) return;
      await this.write(64 * 1024 * 4 + 65_536, () => this.db.transaction(() => { for (const row of rows) this.db.prepare("DELETE FROM walk WHERE uuid=?").run(row.uuid); })());
    }
  }
  async select(): Promise<{ count: number; hash: string }> {
    for (const entry of this.ordered("compact IS NOT NULL")) {
      const compact = object(JSON.parse(entry.compact!)), messages = object(compact.preservedMessages), segment = object(compact.preservedSegment);
      if (compact.preservedMessages !== undefined) {
        if (!key(messages.anchorUuid) || !Array.isArray(messages.uuids) || messages.uuids.length > MAX_RECORDS || !messages.uuids.length || messages.uuids.some(id => !key(id) || !this.row(id))) fail("chain_gap", "Claude transcript preserved message chain is incomplete.");
        const uuids = messages.uuids as string[];
        let parent = messages.anchorUuid;
        for (const uuid of uuids) { await this.reparent(this.row(uuid)!, parent); parent = uuid; }
        for (const child of this.ordered("parent=? AND uuid<>?", [messages.anchorUuid, uuids[0]])) await this.reparent(child, parent);
      } else if (compact.preservedSegment !== undefined) {
        if (!key(segment.headUuid) || !key(segment.tailUuid) || !key(segment.anchorUuid) || !this.row(segment.headUuid) || !this.row(segment.tailUuid)) fail("chain_gap", "Claude transcript preserved segment chain is incomplete.");
        await this.reparent(this.row(segment.headUuid)!, segment.anchorUuid);
        for (const child of this.ordered("parent=? AND uuid<>?", [segment.anchorUuid, segment.headUuid])) await this.reparent(child, segment.tailUuid);
      }
    }
    for (const leaf of this.ordered("NOT EXISTS(SELECT 1 FROM records child WHERE child.parent=r.uuid)")) {
      await this.clearWalk(); let row = this.row(leaf.uuid);
      while (row) {
        if (this.db.prepare("SELECT 1 FROM walk WHERE uuid=?").get(row.uuid)) fail("chain_gap", "Claude transcript parent chain contains a cycle.");
        const current = row; await this.write(65_536, () => this.db.prepare("INSERT INTO walk VALUES(?)").run(current.uuid));
        if (row.type === "user" || row.type === "assistant") { await this.write(65_536, () => this.db.prepare("INSERT OR IGNORE INTO candidates VALUES(?,?,?)").run(current.uuid, current.ordinal, !current.side && !current.meta && !current.team ? 1 : 0)); break; }
        if (!row.parent) break; row = this.row(row.parent);
      }
    }
    const chosen = this.db.prepare("SELECT uuid FROM candidates ORDER BY main DESC,ordinal DESC LIMIT 1").get() as { uuid: string } | undefined;
    if (!chosen) { if (this.db.prepare("SELECT 1 FROM records LIMIT 1").get()) fail("chain_gap", "Claude transcript has no complete root message chain."); return { count: 0, hash: sha("") }; }
    let next: string | null = chosen.uuid, reverse = 0;
    while (next !== null) {
      const row = this.row(next); if (!row) fail("chain_gap", "Claude transcript parent chain has a missing record.");
      if (this.db.prepare("SELECT 1 FROM chain WHERE uuid=?").get(next)) fail("chain_gap", "Claude transcript parent chain contains a cycle.");
      await this.write(65_536, () => this.db.prepare("INSERT INTO chain VALUES(?,?)").run(reverse++, next)); next = row.parent;
    }
    let position = 0, rootInput: string | null = null;
    const add = async (row: Row) => {
      if (this.db.prepare("SELECT 1 FROM selected WHERE uuid=?").get(row.uuid)) return;
      if (!["user", "assistant", "system"].includes(row.type) || row.meta || row.side || row.team) return;
      if (++position > MAX_RECORDS) fail("limit_exceeded", "Claude transcript selected record limit exceeded.");
      const offset = row.message_id ? (this.db.prepare("SELECT COALESCE(SUM(r.blocks),0) AS count FROM selected s JOIN records r ON r.uuid=s.uuid WHERE r.message_id=?").get(row.message_id) as { count: number }).count : null;
      await this.write(65_536, () => this.db.prepare("INSERT INTO selected VALUES(?,?,?,?)").run(position, row.uuid, offset, rootInput));
    };
    for (const row of this.chain()) {
      if (row.type === "user" && !row.tool_result && !row.meta && !row.side && !row.team) rootInput = row.uuid;
      await add(row);
      if (!row.message_id) continue;
      const anchor = this.db.prepare("SELECT r.uuid FROM chain c JOIN records r ON r.uuid=c.uuid WHERE r.message_id=? ORDER BY c.position LIMIT 1").get(row.message_id) as { uuid: string };
      if (anchor.uuid !== row.uuid) continue;
      for (const sibling of this.timestampOrdered("message_id=? AND NOT EXISTS(SELECT 1 FROM chain c WHERE c.uuid=r.uuid)", [row.message_id])) await add(sibling);
      for (const tool of this.timestampOrdered("r.tool_result=1 AND r.parent IN(SELECT uuid FROM records WHERE message_id=?) AND NOT EXISTS(SELECT 1 FROM chain c WHERE c.uuid=r.uuid)", [row.message_id])) await add(tool);
    }
    const hash = createHash("sha256");
    for (const record of this.db.prepare("SELECT r.data,s.block_offset,s.root_input FROM selected s JOIN records r ON r.uuid=s.uuid ORDER BY s.position").iterate() as Iterable<{ data: string; block_offset: number | null; root_input: string | null }>) hash.update(JSON.stringify([record.data, record.block_offset, record.root_input]) + "\n");
    return { count: position, hash: hash.digest("hex") };
  }
  close() { this.db.close(); }
}

/** Read-only native history. The caller owns its index directory, ACK journal and capture storage. */
export const openClaudeTranscript = async (options: ClaudeTranscriptOptions): Promise<ClaudeTranscriptReader> => {
  options.signal?.throwIfAborted();
  const authorized = await authorize(options), handle = authorized.handle;
  let index: TranscriptIndex | null = null, snapshot: ClaudeTranscriptSnapshot;
  let closed = false, acknowledged = 0, pending: ClaudeTranscriptPage | null = null, acknowledgedCursor: string | null = null;
  let verifiedCtime = -1n;
  const abort = new AbortController();
  let operation: Promise<unknown> = Promise.resolve();
  const serialized = <T>(run: () => Promise<T>): Promise<T> => {
    const next = operation.then(() => { if (closed) fail("closed", "Claude transcript reader is closed."); options.signal?.throwIfAborted(); abort.signal.throwIfAborted(); return run(); });
    operation = next.catch(() => {}); return next;
  };
  const identity = async () => {
    const [opened, named] = await Promise.all([handle.stat({ bigint: true }), lstat(authorized.filename, { bigint: true })]);
    if (!opened.isFile() || !named.isFile() || opened.dev !== authorized.identity.dev || opened.ino !== authorized.identity.ino || named.dev !== opened.dev || named.ino !== opened.ino) fail("identity_changed", "Claude transcript file identity changed.");
    if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) fail("limit_exceeded", "Claude transcript size cannot be represented safely.");
    return opened;
  };
  const verify = async () => {
    const observed = await identity();
    if (observed.size < BigInt(snapshot.prefixBytes)) fail("snapshot_changed", "Claude transcript snapshot was truncated.");
    if (observed.ctimeNs !== verifiedCtime) {
      if (await prefixHash(handle, snapshot.prefixBytes, abort.signal) !== snapshot.prefixSha256) fail("snapshot_changed", "Claude transcript snapshot prefix changed.");
      const after = await identity();
      if (observed.ctimeNs !== after.ctimeNs || observed.size !== after.size) fail("snapshot_changed", "Claude transcript changed while verifying its prefix.");
      verifiedCtime = after.ctimeNs;
    }
  };
  const removeIndex = async (old: TranscriptIndex) => { old.close(); for (const suffix of ["", "-journal", "-wal", "-shm"]) await rm(old.filename + suffix, { force: true }); };
  const build = async (): Promise<{ index: TranscriptIndex; snapshot: ClaudeTranscriptSnapshot }> => {
    const before = await identity(), size = Number(before.size);
    await mkdir(options.indexDirectory, { recursive: true, mode: 0o700 }); await noSymlinks(path.resolve(options.indexDirectory));
    const directory = await lstat(options.indexDirectory);
    if (!directory.isDirectory() || process.platform !== "win32" && (directory.mode & 0o077) !== 0) fail("unauthorized", "Claude transcript index directory must be private.");
    const filename = path.join(options.indexDirectory, `claude-transcript-${randomUUID()}.sqlite`);
    const permission = await options.reserveIndex?.(131_072);
    let created: TranscriptIndex | undefined;
    try { try { created = new TranscriptIndex(filename, options, authorized.cwd); } finally { if (permission) await permission.release(); } }
    catch (error) {
      if (created) await removeIndex(created);
      else for (const suffix of ["", "-journal", "-wal", "-shm"]) await rm(filename + suffix, { force: true });
      throw error;
    }
    try {
      await chmod(filename, 0o600);
      const buffer = Buffer.allocUnsafe(65_536), hash = createHash("sha256");
      let parser = new ClaudeTranscriptJson(), prefixBytes = 0, prefixSha256 = sha("");
      for (let offset = 0; offset < size;) {
        options.signal?.throwIfAborted(); abort.signal.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (!bytesRead) fail("snapshot_changed", "Claude transcript was truncated while indexing.");
        let start = 0;
        while (start < bytesRead) {
          const newline = buffer.indexOf(10, start), end = newline >= 0 && newline < bytesRead ? newline : bytesRead;
          parser.write(buffer.subarray(start, end), offset + start); hash.update(buffer.subarray(start, end));
          if (end < bytesRead) {
            hash.update(buffer.subarray(end, end + 1));
            const line = parser.finish(); if (line) await created.add(line);
            prefixBytes = offset + end + 1; prefixSha256 = hash.copy().digest("hex"); parser = new ClaudeTranscriptJson(); start = end + 1;
          } else start = end;
        }
        offset += bytesRead; await setImmediate();
      }
      // An incomplete tail is not a record, even if its current bytes already fail JSON validation.
      const selected = await created.select();
      const after = await identity();
      if (after.size < BigInt(prefixBytes) || await prefixHash(handle, prefixBytes, abort.signal) !== prefixSha256) fail("snapshot_changed", "Claude transcript snapshot prefix changed while indexing.");
      const final = await identity();
      if (final.ctimeNs !== after.ctimeNs || final.size !== after.size) fail("snapshot_changed", "Claude transcript changed while sealing its snapshot.");
      const snapshotId = sha(JSON.stringify([options.nativeSessionId, String(final.dev), String(final.ino), prefixBytes, prefixSha256, selected.hash]));
      verifiedCtime = final.ctimeNs;
      return { index: created, snapshot: { snapshotId, historyEpoch: snapshotId, nativeSessionId: options.nativeSessionId, prefixBytes, prefixSha256, chainSha256: selected.hash, records: selected.count } };
    } catch (error) { await removeIndex(created); throw error; }
  };
  const cursorAt = (position: number) => Buffer.from(JSON.stringify({ version: 1, snapshot: snapshot.snapshotId, chain: snapshot.chainSha256, position })).toString("base64url");
  const restore = (cursor: string) => {
    let value: Record<string, unknown>;
    try { if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error(); value = object(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))); }
    catch { return fail("invalid_cursor", "Claude transcript cursor is invalid."); }
    if (value.version !== 1 || value.snapshot !== snapshot.snapshotId || value.chain !== snapshot.chainSha256 || !Number.isSafeInteger(value.position) || Number(value.position) < 0 || Number(value.position) > snapshot.records || Object.keys(value).length !== 4) fail("invalid_cursor", "Claude transcript cursor belongs to another snapshot or chain.");
    acknowledged = Number(value.position); acknowledgedCursor = cursor;
  };
  try { ({ index, snapshot } = await build()); if (options.resumeCursor !== undefined) restore(options.resumeCursor); }
  catch (error) { if (index) await removeIndex(index); await handle.close(); throw error; }
  return {
    get snapshot() { return { ...snapshot }; },
    nextPage: requested => serialized(async () => {
      await verify(); if (pending) return structuredClone(pending);
      const max = requested?.maxRecords ?? 100;
      if (!Number.isSafeInteger(max) || max < 1 || max > 100) fail("limit_exceeded", "Claude transcript page size must be between 1 and 100.");
      const records: ClaudeTranscriptRecord[] = []; let position = acknowledged;
      for (const row of index!.db.prepare("SELECT s.position,s.block_offset,s.root_input,r.data FROM selected s JOIN records r ON r.uuid=s.uuid WHERE s.position>? ORDER BY s.position LIMIT ?").iterate(acknowledged, max) as Iterable<{ position: number; block_offset: number | null; root_input: string | null; data: string }>) {
        const record = { ...JSON.parse(row.data) as Omit<ClaudeTranscriptRecord, "assistantBlockOffset">, assistantBlockOffset: row.block_offset, rootInputUuid: row.root_input };
        const candidate = { snapshotId: snapshot.snapshotId, records: [...records, record], cursor: cursorAt(row.position), done: row.position === snapshot.records };
        if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_PAGE) { if (!records.length) fail("limit_exceeded", "Claude transcript record exceeds its page byte limit."); break; }
        records.push(record); position = row.position;
      }
      pending = { snapshotId: snapshot.snapshotId, records, cursor: cursorAt(position), done: position === snapshot.records };
      return structuredClone(pending);
    }),
    acknowledge: cursor => serialized(async () => {
      await verify();
      if (!pending && cursor === acknowledgedCursor) return;
      if (!pending || cursor !== pending.cursor) fail("invalid_cursor", "Claude transcript acknowledgement cursor does not match the outstanding page.");
      restore(cursor); pending = null;
    }),
    readMedia: (mediaId, consume, signal) => serialized(async () => {
      signal?.throwIfAborted(); await verify();
      const row = index!.db.prepare("SELECT m.*,s.position FROM media m JOIN selected s ON s.uuid=m.uuid WHERE m.id=?").get(mediaId) as (MediaRow & { position: number }) | undefined;
      if (!row) fail("media_unavailable", "Claude transcript media is not part of the selected chain.");
      if (row.position > acknowledged) fail("media_unavailable", "Claude transcript media requires its acknowledged page.");
      if (row.error) fail("media_unavailable", `Claude transcript media is unavailable: ${row.error}.`);
      const buffer = Buffer.allocUnsafe(65_536), produced: Uint8Array[] = [];
      const decoder = new TranscriptBase64Decoder(bytes => produced.push(bytes));
      for (let offset = row.start; offset < row.end;) {
        options.signal?.throwIfAborted(); abort.signal.throwIfAborted(); signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, row.end - offset), offset);
        if (!bytesRead) fail("snapshot_changed", "Claude transcript media was truncated.");
        decoder.write(buffer.subarray(0, bytesRead)); offset += bytesRead;
        for (const bytes of produced.splice(0)) { await consume(bytes); signal?.throwIfAborted(); abort.signal.throwIfAborted(); }
      }
      if (decoder.finish() !== row.bytes) fail("snapshot_changed", "Claude transcript media length differs from its indexed source.");
      for (const bytes of produced.splice(0)) { await consume(bytes); signal?.throwIfAborted(); abort.signal.throwIfAborted(); }
      await verify();
    }),
    refresh: () => serialized(async () => {
      await verify(); const fresh = await build(), old = index!;
      index = fresh.index; snapshot = fresh.snapshot; acknowledged = 0; pending = null; acknowledgedCursor = null;
      await removeIndex(old); return { ...snapshot };
    }),
    close: async () => {
      if (closed) return; closed = true; abort.abort(new Error("Claude transcript reader stopped.")); await operation;
      try { if (index) { const owned = index; index = null; await removeIndex(owned); } } finally { await handle.close(); }
    },
  };
};
