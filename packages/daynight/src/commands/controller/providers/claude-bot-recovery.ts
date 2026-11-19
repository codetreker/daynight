import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { SessionKey, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { sqliteFilename } from "../../../platform/sqlite-filename.js";

export type ClaudeBotRecoveryOptions = {
  directory: string; cwd: string; nativeHome: string;
  identity: { serverOrigin: string; ownerUserId: string; botId: string; sessionId: string };
};
type Version = { sdkVersion: string; cliVersion: string };
type State = { format: 1; identity: ClaudeBotRecoveryOptions["identity"]; cwd: string; nativeHome: string;
  nativeSessionId: string | null; projectKey: string | null; version: Version | null;
  dirty: boolean; protectedThroughTurn: string | null; digest: string | null };
type Row = { ordinal: number; uuid: string | null; data: string };
export class ClaudeBotRecoveryError extends Error {
  constructor(readonly code: "recovery_version_unsupported" | "recovery_material_missing" | "recovery_material_invalid" | "recovery_material_incomplete" | "outcome_unknown", message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options); this.name = "ClaudeBotRecoveryError";
  }
}
const invalid = (message: string) => new ClaudeBotRecoveryError("recovery_material_invalid", message);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const missing = (error: unknown) => object(error).code === "ENOENT";
const metadataTypes = new Set(["summary", "custom-title", "ai-title", "atis-latch", "tag", "agent-name", "agent-color", "mode", "last-prompt"]);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const verifyVersion = (version: Version) => {
  if (version.sdkVersion !== "0.3.247" || version.cliVersion !== "2.1.247") throw new ClaudeBotRecoveryError("recovery_version_unsupported", "Claude recovery requires SDK 0.3.247 and CLI 2.1.247.");
};
const inlineAttachment = (value: unknown): boolean => {
  const item = object(value), strings = (field: unknown) => Array.isArray(field) && field.every(entry => typeof entry === "string");
  const fields = (names: string[]) => Object.keys(item).every(name => names.includes(name));
  if (item.type === "agent_listing_delta") return fields(["type", "addedTypes", "addedLines", "removedTypes", "isInitial", "showConcurrencyNote"])
    && strings(item.addedTypes) && strings(item.addedLines) && strings(item.removedTypes) && typeof item.isInitial === "boolean" && typeof item.showConcurrencyNote === "boolean";
  if (item.type === "skill_listing") return fields(["type", "content", "skillCount", "isInitial", "names"])
    && typeof item.content === "string" && Number.isSafeInteger(item.skillCount) && Number(item.skillCount) >= 0 && typeof item.isInitial === "boolean" && strings(item.names);
  return item.type === "auto_mode" && fields(["type", "autoModeConsentFlow", "bashFirst", "steerOnly", "bypass"])
    && [item.autoModeConsentFlow, item.bashFirst, item.steerOnly, item.bypass].every(flag => typeof flag === "boolean");
};
async function noSymlinks(filename: string): Promise<void> {
  let component = path.parse(filename).root;
  for (const part of filename.slice(component.length).split(path.sep).filter(Boolean)) {
    component = path.join(component, part);
    try { if ((await lstat(component)).isSymbolicLink()) throw invalid("Claude recovery rejects symbolic links in owned paths."); }
    catch (error) { if (!missing(error)) throw error; }
  }
}

/** The Controller owns serialization and proves the original native writer stopped before prepare. */
export class ClaudeBotRecovery {
  private db: Database.Database | undefined;
  private state: State | undefined;
  private failure: ClaudeBotRecoveryError | undefined;
  private runtimeVersion: Version | undefined;
  get protectedThroughTurn(): string | null { return this.state?.protectedThroughTurn ?? null; }
  get transcriptPath(): string | null {
    return this.state?.projectKey && this.state.nativeSessionId ? path.join(this.options.nativeHome, "projects", this.state.projectKey, `${this.state.nativeSessionId}.jsonl`) : null;
  }
  constructor(private readonly options: ClaudeBotRecoveryOptions) {
    if (![options.directory, options.cwd, options.nativeHome].every(value => path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value))
      || ![options.identity.ownerUserId, options.identity.botId, options.identity.sessionId].every(uuid)) throw invalid("Claude recovery identity or absolute location is invalid.");
    const origin = new URL(options.identity.serverOrigin);
    if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== options.identity.serverOrigin) throw invalid("Claude recovery service origin is invalid.");
  }
  private healthy(): void {
    if (this.failure) throw this.failure;
    if (!this.db || !this.state) throw invalid("Claude recovery storage is not open.");
  }
  private retainFailure(error: unknown): never {
    this.failure ??= error instanceof ClaudeBotRecoveryError ? error : new ClaudeBotRecoveryError("outcome_unknown", "Claude recovery persistence is unconfirmed; native operations cannot continue.", { cause: error });
    throw this.failure;
  }
  private save(state: State): void {
    this.db!.prepare("INSERT INTO state(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(JSON.stringify(state));
  }
  private digest(): string {
    const hash = createHash("sha256");
    for (const row of this.db!.prepare("SELECT data FROM entries ORDER BY ordinal").iterate() as Iterable<{ data: string }>) hash.update(row.data).update("\n");
    return hash.digest("hex");
  }
  async prepare(nativeSessionId: string | null): Promise<void> {
    if (this.db) throw invalid("Claude recovery storage is already open.");
    if (nativeSessionId !== null && !uuid(nativeSessionId)) throw invalid("Claude native Session identity is invalid.");
    const filename = path.join(this.options.directory, "recovery.sqlite");
    await noSymlinks(filename);
    let exists = true;
    try { if (!(await lstat(filename)).isFile()) throw invalid("Claude recovery database is not a regular file."); }
    catch (error) { if (!missing(error)) throw error; exists = false; }
    if (!exists && nativeSessionId !== null) throw new ClaudeBotRecoveryError("recovery_material_missing", "The original Claude Session has no protected mirror.");
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.options.directory);
    if (await realpath(this.options.directory) !== this.options.directory || process.platform !== "win32" && (directory.mode & 0o077) !== 0) throw invalid("Claude recovery requires its physical private directory.");
    this.db = new Database(sqliteFilename(filename));
    try {
      await chmod(filename, 0o600);
      // DELETE commits need the journal directory sync so power loss cannot undo
      // a dirty barrier after native dispatch: https://www.sqlite.org/pragma.html#pragma_synchronous
      this.db.pragma("journal_mode = DELETE"); this.db.pragma("synchronous = EXTRA"); this.db.pragma("busy_timeout = 0");
      if (!exists) this.db.exec("CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL); CREATE TABLE entries(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,uuid TEXT UNIQUE,data TEXT NOT NULL);");
      const saved = this.db.prepare("SELECT data FROM state WHERE id=1").get() as { data: string } | undefined;
      if (!saved) {
        if (exists || nativeSessionId !== null) throw new ClaudeBotRecoveryError("recovery_material_missing", "The Claude recovery manifest is missing.");
        this.state = { format: 1, identity: this.options.identity, cwd: await realpath(this.options.cwd), nativeHome: this.options.nativeHome,
          nativeSessionId: null, projectKey: null, version: null, dirty: false, protectedThroughTurn: null, digest: null };
        this.save(this.state); return;
      }
      const value = JSON.parse(saved.data) as State;
      if (value.format !== 1) throw new ClaudeBotRecoveryError("recovery_version_unsupported", "The Claude recovery format is unsupported.");
      if (canonical(value.identity) !== canonical(this.options.identity) || value.cwd !== await realpath(this.options.cwd) || value.nativeHome !== this.options.nativeHome
        || typeof value.dirty !== "boolean") throw invalid("Claude recovery belongs to another identity or location.");
      this.state = value;
      if (value.dirty) throw new ClaudeBotRecoveryError("outcome_unknown", "The original Claude operation has no protected result; do not replay it.");
      if (nativeSessionId === null) {
        if (value.nativeSessionId === null && value.protectedThroughTurn === null && value.digest === null
          && (this.db.prepare("SELECT COUNT(*) AS count FROM entries").get() as { count: number }).count === 0) return;
        throw invalid("An existing Claude recovery manifest cannot start another Session.");
      }
      if (!value.version || !value.digest || !value.protectedThroughTurn || !value.projectKey) throw new ClaudeBotRecoveryError("recovery_material_missing", "The original Claude Session has no complete protected turn.");
      verifyVersion(value.version);
      if (value.nativeSessionId !== nativeSessionId || !uuid(value.protectedThroughTurn) || !this.validKey({ projectKey: value.projectKey, sessionId: nativeSessionId }) || this.digest() !== value.digest) throw invalid("Claude recovery identity or mirror digest differs.");
      await this.restore();
    } catch (error) { this.close(); throw error; }
  }
  validateVersion(version: Version): void {
    this.healthy(); verifyVersion(version);
    if (this.state!.version && canonical(this.state!.version) !== canonical(version)) throw new ClaudeBotRecoveryError("recovery_version_unsupported", "The original Claude runtime version differs.");
    this.runtimeVersion = { ...version };
  }
  markDirty(): void {
    this.healthy();
    if (this.state!.dirty) return;
    const next = { ...this.state!, dirty: true };
    try { this.save(next); this.state = next; } catch (error) { this.retainFailure(error); }
  }
  private validKey(key: SessionKey): boolean {
    return uuid(key.sessionId) && typeof key.projectKey === "string" && key.projectKey.length > 0 && key.projectKey.length <= 256
      && /^[a-zA-Z0-9_-]+$/.test(key.projectKey) && key.subpath === undefined;
  }
  private validateEntry(entry: SessionStoreEntry, nativeSessionId: string): void {
    if (!entry || typeof entry.type !== "string" || !(metadataTypes.has(entry.type) || ["user", "assistant", "system", "progress", "queue-operation", "attachment"].includes(entry.type))) throw invalid("Claude recovery contains an unsupported native record type.");
    if (entry.sessionId !== undefined && entry.sessionId !== nativeSessionId || entry.cwd !== undefined && entry.cwd !== this.state!.cwd
      || entry.isSidechain === true || entry.agentId != null || entry.teamName != null || object(entry.data).type === "agent_progress") throw invalid("Claude recovery contains another Session, workspace or subagent.");
    if (["user", "assistant"].includes(entry.type) && (!uuid(entry.uuid) || entry.sessionId !== nativeSessionId || entry.cwd !== this.state!.cwd
      || object(entry.message).role !== entry.type)) throw invalid("Claude recovery message lacks its original identity or role.");
    // These configuration-discovery records contain their complete values inline.
    // File, media and unknown attachment kinds require separate recovery material.
    if (entry.type === "attachment" && (!inlineAttachment(entry.attachment) || !uuid(entry.uuid) || entry.sessionId !== nativeSessionId || entry.cwd !== this.state!.cwd)) throw invalid("Claude recovery contains an unsupported attachment or attachment identity.");
    if (entry.type === "system" && entry.subtype === "compact_boundary") throw invalid("Claude compact recovery has not been verified.");
    if (entry.type === "queue-operation" && !["enqueue", "dequeue"].includes(String(entry.operation))) throw invalid("Claude recovery contains an unsupported native queue operation.");
    const inspect = (content: unknown): void => {
      if (!Array.isArray(content)) return;
      for (const value of content) {
        const part = object(value);
        if (["image", "document"].includes(String(part.type))) throw invalid("Claude recovery contains unsupported external media.");
        if (part.type === "tool_use" && /^(?:Agent|Task|TaskOutput|TaskStop|EnterWorktree|ExitWorktree|NotebookEdit)$/i.test(String(part.name))) throw invalid("Claude recovery depends on unsupported native resources.");
        if (part.type === "tool_result") inspect(part.content);
      }
    };
    inspect(object(entry.message).content);
    if (Buffer.byteLength(JSON.stringify(entry)) > 32 * 1024 * 1024) throw invalid("Claude recovery record exceeds 32 MiB.");
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.healthy();
    try {
      if (!this.validKey(key) || this.state!.nativeSessionId !== null && this.state!.nativeSessionId !== key.sessionId
        || this.state!.projectKey !== null && this.state!.projectKey !== key.projectKey) throw invalid("Claude mirror key differs from its original root Session.");
      if (!Array.isArray(entries) || !entries.length) throw invalid("Claude mirror batch is empty or invalid.");
      for (const entry of entries) this.validateEntry(entry, key.sessionId);
      const next = { ...this.state!, nativeSessionId: key.sessionId, projectKey: key.projectKey };
      this.db!.transaction(() => {
        let changedBusiness = false;
        for (const entry of entries) {
          const data = canonical(entry), id = typeof entry.uuid === "string" && entry.uuid ? entry.uuid : null;
          const old = id === null ? undefined : this.db!.prepare("SELECT data FROM entries WHERE uuid=?").get(id) as { data: string } | undefined;
          if (old?.data === data) continue;
          if (!metadataTypes.has(entry.type)) changedBusiness = true;
          this.db!.prepare("INSERT INTO entries(uuid,data) VALUES(?,?) ON CONFLICT(uuid) DO UPDATE SET data=excluded.data").run(id, data);
        }
        if (changedBusiness) next.dirty = true;
        if (!next.dirty && next.digest !== null) next.digest = this.digest();
        this.save(next);
      })();
      this.state = next;
    } catch (error) { this.retainFailure(error); }
  }
  async protect(nativeSessionId: string, turnId: string): Promise<void> {
    this.healthy();
    try {
      if (!this.runtimeVersion) throw new ClaudeBotRecoveryError("recovery_version_unsupported", "Claude runtime must be verified before protecting a turn.");
      if (nativeSessionId !== this.state!.nativeSessionId || !uuid(turnId)) throw invalid("Claude protected turn identity is invalid.");
      const user = this.db!.prepare("SELECT ordinal,data FROM entries WHERE uuid=?").get(turnId) as Row | undefined;
      if (!user || object(JSON.parse(user.data)).type !== "user") throw new ClaudeBotRecoveryError("recovery_material_incomplete", "Claude mirror does not contain the completed input.");
      let assistant: Record<string, unknown> | undefined;
      for (const row of this.db!.prepare("SELECT data FROM entries WHERE ordinal>? ORDER BY ordinal").iterate(user.ordinal) as Iterable<{ data: string }>) {
        const entry = JSON.parse(row.data) as SessionStoreEntry;
        if (entry.type === "assistant") assistant = object(entry.message);
        const content = object(entry.message).content;
        if (entry.type === "user" && !entry.isMeta && !(Array.isArray(content) && content.some(part => object(part).type === "tool_result"))) throw invalid("Claude mirror includes another unprotected user turn.");
      }
      if (assistant?.stop_reason !== "end_turn") throw new ClaudeBotRecoveryError("recovery_material_incomplete", "Claude mirror does not contain its terminal assistant response.");
      let queued = 0;
      const tools = new Set<string>();
      for (const row of this.db!.prepare("SELECT data FROM entries ORDER BY ordinal").iterate() as Iterable<{ data: string }>) {
        const entry = JSON.parse(row.data) as SessionStoreEntry;
        if (entry.type === "queue-operation") {
          queued += entry.operation === "enqueue" ? 1 : -1;
          if (queued < 0) throw invalid("Claude mirror has an incomplete native queue history.");
        }
        const content = object(entry.message).content;
        if (Array.isArray(content)) for (const item of content) {
          const part = object(item);
          if (part.type === "tool_use" && typeof part.id === "string") tools.add(part.id);
          if (part.type === "tool_result" && typeof part.tool_use_id === "string") tools.delete(part.tool_use_id);
        }
      }
      if (queued || tools.size) throw new ClaudeBotRecoveryError("recovery_material_incomplete", "Claude mirror retains queued input or an unresolved tool call.");
      const next = { ...this.state!, version: this.runtimeVersion, dirty: false, protectedThroughTurn: turnId, digest: this.digest() };
      this.save(next); this.state = next;
    } catch (error) { this.retainFailure(error); }
  }
  private async restore(): Promise<void> {
    const filename = this.transcriptPath!;
    await noSymlinks(filename);
    try { await this.verifyNative(filename); return; } catch (error) { if (!missing(error)) throw error; }
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await noSymlinks(filename);
    const temporary = path.join(path.dirname(filename), `.daynight-${randomUUID()}.tmp`), file = await open(temporary, "wx", 0o600);
    try {
      try {
        for (const row of this.db!.prepare("SELECT data FROM entries ORDER BY ordinal").iterate() as Iterable<{ data: string }>) await file.writeFile(`${row.data}\n`);
        await file.sync();
      } finally { await file.close(); }
      // Hard-link publication is atomic and never replaces a concurrently created transcript.
      await noSymlinks(filename); await link(temporary, filename);
      if (process.platform !== "win32") { const directory = await open(path.dirname(filename), "r"); try { await directory.sync(); } finally { await directory.close(); } }
    } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
  }
  private async verifyNative(filename: string): Promise<void> {
    const before = await lstat(filename, { bigint: true });
    if (!before.isFile()) throw invalid("The original Claude transcript is not a regular file.");
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await file.stat({ bigint: true });
      if (opened.ino !== before.ino || opened.dev !== before.dev) throw invalid("The original Claude transcript changed during recovery.");
      this.db!.exec("CREATE TEMP TABLE native_entries(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,uuid TEXT UNIQUE,data TEXT NOT NULL)");
      const decoder = new TextDecoder("utf-8", { fatal: true }); let pending = "";
      const accept = (line: string) => {
        if (!line.trim()) return;
        const value = JSON.parse(line) as SessionStoreEntry;
        this.validateEntry(value, this.state!.nativeSessionId!);
        this.db!.prepare("INSERT INTO native_entries(uuid,data) VALUES(?,?) ON CONFLICT(uuid) DO UPDATE SET data=excluded.data")
          .run(typeof value.uuid === "string" && value.uuid ? value.uuid : null, canonical(value));
      };
      for await (const chunk of createReadStream(filename, { fd: file.fd, autoClose: false })) {
        pending += decoder.decode(chunk as Buffer, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) { accept(pending.slice(0, end)); pending = pending.slice(end + 1); }
        if (Buffer.byteLength(pending) > 32 * 1024 * 1024) throw invalid("The original Claude transcript record exceeds 32 MiB.");
      }
      pending += decoder.decode();
      if (pending.length) throw invalid("The original Claude transcript ends with an incomplete record.");
      const hash = createHash("sha256");
      for (const row of this.db!.prepare("SELECT data FROM native_entries ORDER BY ordinal").iterate() as Iterable<{ data: string }>) hash.update(row.data).update("\n");
      const after = await file.stat({ bigint: true }); await noSymlinks(filename);
      const named = await lstat(filename, { bigint: true });
      if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || named.ino !== opened.ino || named.dev !== opened.dev || hash.digest("hex") !== this.state!.digest) throw invalid("The original Claude transcript differs from its protected mirror; it is preserved.");
    } finally { this.db!.exec("DROP TABLE IF EXISTS temp.native_entries"); await file.close(); }
  }
  close(): void { this.db?.close(); this.db = undefined; }
}
