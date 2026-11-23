import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { sqliteFilename } from "../../../platform/sqlite-filename.js";

export type CopilotBotRecoveryOptions = {
  directory: string; cwd: string; nativeHome: string;
  identity: { serverOrigin: string; ownerUserId: string; botId: string; sessionId: string };
};
type Version = { sdkVersion: string; cliVersion: string };
type FileRecord = { path: string; bytes: number; sha256: string };
type State = { format: 1; identity: CopilotBotRecoveryOptions["identity"]; cwd: string; nativeHome: string; nativeSessionId: string;
  version: Version | null; dirty: boolean; protectedThroughTurn: string | null; nativeUserMessageId: string | null;
  snapshot: string | null; files: FileRecord[] };
type Code = "recovery_version_unsupported" | "recovery_material_missing" | "recovery_material_invalid" | "recovery_material_incomplete" | "recovery_cleanup_failed" | "outcome_unknown";
export class CopilotBotRecoveryError extends Error {
  get recoveryCommitted(): boolean { return this.code === "recovery_cleanup_failed"; }
  constructor(readonly code: Code, message: string, options?: ErrorOptions) { super(`${code}: ${message}`, options); this.name = "CopilotBotRecoveryError"; }
}
const invalid = (message: string) => new CopilotBotRecoveryError("recovery_material_invalid", message);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const missing = (error: unknown) => object(error).code === "ENOENT";
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const verifyVersion = (version: Version) => {
  if (version.sdkVersion !== "1.0.11" || version.cliVersion !== "1.0.105") throw new CopilotBotRecoveryError("recovery_version_unsupported", "Copilot recovery requires SDK 1.0.11 and CLI 1.0.105.");
};
async function noSymlinks(filename: string): Promise<void> {
  let current = path.parse(filename).root;
  for (const part of filename.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw invalid("Copilot recovery rejects symbolic links in owned paths."); }
    catch (error) { if (!missing(error)) throw error; }
  }
}
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const file = await open(directory, "r"); try { await file.sync(); } finally { await file.close(); }
}
async function hashFile(filename: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of createReadStream(filename)) { bytes += chunk.length; hash.update(chunk); }
  return { bytes, sha256: hash.digest("hex") };
}

const nativeLock = (name: string) => name === ".workspace-fork.lock" || /^inuse\.[0-9]+\.(?:hold|lock)$/.test(name);
const sqlite = (name: string) => /\.(?:db|sqlite|sqlite3)$/.test(name);
const sqliteSidecar = (name: string) => /\.(?:db|sqlite|sqlite3)-(?:wal|shm|journal)$/.test(name);
async function verifySidecar(filename: string): Promise<void> {
  await noSymlinks(filename);
  if (!(await lstat(filename)).isFile()) throw invalid("Copilot SQLite sidecar is not a regular file.");
  const main = filename.replace(/-(?:wal|shm|journal)$/, ""); await noSymlinks(main);
  if (!(await lstat(main)).isFile()) throw invalid("Copilot SQLite sidecar has no regular database.");
  const file = await open(main, "r");
  try {
    const bytes = Buffer.alloc(16); const result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead !== 16 || bytes.toString("binary") !== "SQLite format 3\0") throw invalid("Copilot SQLite sidecar has no valid database.");
  } finally { await file.close(); }
}

/** The Controller serializes dispatch, flushes native writers and proves stopping before recovery. */
export class CopilotBotRecovery {
  private db: Database.Database | undefined;
  private state: State | undefined;
  private failure: CopilotBotRecoveryError | undefined;
  private runtimeVersion: Version | undefined;
  private work: Promise<unknown> = Promise.resolve();
  private closing = false;
  private retiredSnapshots = new Set<string>();
  get protectedThroughTurn(): string | null { return this.state?.protectedThroughTurn ?? null; }
  get sourceDirectory(): string {
    if (!this.state) throw invalid("Copilot recovery identity has not been prepared.");
    return path.join(this.options.nativeHome, "session-state", this.state.nativeSessionId);
  }
  constructor(private readonly options: CopilotBotRecoveryOptions) {
    if (![options.directory, options.cwd, options.nativeHome].every(value => path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value))
      || ![options.identity.ownerUserId, options.identity.botId, options.identity.sessionId].every(uuid)) throw invalid("Copilot recovery identity or location is invalid.");
    const origin = new URL(options.identity.serverOrigin);
    if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== options.identity.serverOrigin) throw invalid("Copilot recovery service origin is invalid.");
  }
  private healthy(): void {
    if (this.failure) throw this.failure;
    if (!this.db || !this.state || this.closing) throw invalid("Copilot recovery storage is not open.");
  }
  private retain(error: unknown): never {
    this.failure ??= error instanceof CopilotBotRecoveryError ? error : new CopilotBotRecoveryError("outcome_unknown", "Copilot persistence failed; native operations cannot continue.", { cause: error });
    throw this.failure;
  }
  private save(next: State): void {
    this.db!.prepare("INSERT INTO state(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(JSON.stringify(next));
    this.state = next;
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.work.then(async () => { this.healthy(); return action(); });
    this.work = result.catch(() => {}); return result;
  }
  async prepare(nativeSessionId: string, resume: boolean): Promise<void> {
    if (this.db || !uuid(nativeSessionId)) throw invalid("Copilot native Session identity or storage state is invalid.");
    const source = path.join(this.options.nativeHome, "session-state", nativeSessionId);
    const contains = (parent: string, child: string) => { const relative = path.relative(parent, child); return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
    if (contains(source, this.options.directory) || contains(this.options.directory, source)) throw invalid("Copilot native and recovery directories must not overlap.");
    const filename = path.join(this.options.directory, "recovery.sqlite");
    await noSymlinks(filename);
    let exists = true;
    try { if (!(await lstat(filename)).isFile()) throw invalid("Copilot recovery database is not a regular file."); }
    catch (error) { if (!missing(error)) throw error; exists = false; }
    if (!exists && resume) throw new CopilotBotRecoveryError("recovery_material_missing", "The original Copilot Session has no protected material.");
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.options.directory);
    if (await realpath(this.options.directory) !== this.options.directory || process.platform !== "win32" && (directory.mode & 0o077) !== 0) throw invalid("Copilot recovery requires its physical private directory.");
    this.db = new Database(sqliteFilename(filename));
    try {
      await chmod(filename, 0o600); this.db.pragma("journal_mode = DELETE"); this.db.pragma("synchronous = EXTRA"); this.db.pragma("busy_timeout = 0");
      if (!exists) this.db.exec("CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)");
      const saved = this.db.prepare("SELECT data FROM state WHERE id=1").get() as { data: string } | undefined;
      if (!saved) {
        if (exists || resume) throw new CopilotBotRecoveryError("recovery_material_missing", "Copilot recovery manifest is missing.");
        this.save({ format: 1, identity: this.options.identity, cwd: await realpath(this.options.cwd), nativeHome: this.options.nativeHome, nativeSessionId,
          version: null, dirty: false, protectedThroughTurn: null, nativeUserMessageId: null, snapshot: null, files: [] });
        return;
      }
      const value = JSON.parse(saved.data) as State;
      if (value.format !== 1) throw new CopilotBotRecoveryError("recovery_version_unsupported", "Copilot recovery format is unsupported.");
      if (canonical(value.identity) !== canonical(this.options.identity) || value.cwd !== await realpath(this.options.cwd)
        || value.nativeHome !== this.options.nativeHome || value.nativeSessionId !== nativeSessionId || typeof value.dirty !== "boolean" || !Array.isArray(value.files)) throw invalid("Copilot recovery belongs to another identity or location.");
      this.state = value;
      if (value.dirty) throw new CopilotBotRecoveryError("outcome_unknown", "The original Copilot operation has no protected result; do not replay it.");
      if (!resume) {
        if (value.snapshot === null && value.protectedThroughTurn === null && value.version === null) return;
        throw invalid("Existing Copilot recovery cannot create another Session.");
      }
      if (!value.version || !uuid(value.snapshot) || !uuid(value.protectedThroughTurn) || !uuid(value.nativeUserMessageId)) throw new CopilotBotRecoveryError("recovery_material_missing", "The original Copilot Session has no complete protected turn.");
      verifyVersion(value.version);
      const snapshot = path.join(this.options.directory, "snapshots", value.snapshot);
      if (canonical(await this.inventory(snapshot)) !== canonical(value.files)) throw invalid("Copilot protected material digest differs.");
      await this.validateEvents(snapshot, nativeSessionId, value.nativeUserMessageId);
      try { await lstat(this.sourceDirectory); await this.verifyExisting(snapshot); }
      catch (error) { if (!missing(error)) throw error; await this.restore(snapshot); }
    } catch (error) {
      await this.close();
      if (missing(error)) throw new CopilotBotRecoveryError("recovery_material_missing", "Copilot protected recovery material is missing.", { cause: error });
      throw error;
    }
  }
  validateVersion(version: Version): void {
    this.healthy(); verifyVersion(version);
    if (this.state!.version && canonical(this.state!.version) !== canonical(version)) throw new CopilotBotRecoveryError("recovery_version_unsupported", "Copilot runtime differs from the protected version.");
    this.runtimeVersion = { ...version };
  }
  markDirty(): void {
    this.healthy(); if (this.state!.dirty) return;
    try { this.save({ ...this.state!, dirty: true }); } catch (error) { this.retain(error); }
  }
  private async mutate<T>(action: () => Promise<T>): Promise<T> { try { return await action(); } catch (error) { this.retain(error); } }
  private async inventory(directory: string, optional = false, raw = false): Promise<FileRecord[]> {
    await noSymlinks(directory); const files: FileRecord[] = [];
    const walk = async (current: string): Promise<void> => {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw invalid("Copilot recovery material contains an unsupported file.");
      // SQLite may create an empty WAL when opening a checkpointed database for
      // backup. It carries no committed pages and is not a native data change.
      if (raw && info.isFile() && info.size === 0 && sqliteSidecar(path.basename(current))) return;
      if (info.isFile()) { files.push({ path: path.relative(directory, current).split(path.sep).join("/"), ...await hashFile(current) }); return; }
      for (const name of (await readdir(current)).sort()) {
        if (current === directory && nativeLock(name)) continue;
        if (sqliteSidecar(name)) { await verifySidecar(path.join(current, name)); if (!raw || name.endsWith("-shm")) continue; }
        await walk(path.join(current, name));
      }
    };
    try { await walk(directory); } catch (error) { if (!optional || !missing(error)) throw error; }
    return files;
  }
  private async copyTree(source: string, destination: string, backup = false, root = source): Promise<void> {
    await mkdir(destination, { mode: 0o700, recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (source === root && nativeLock(entry.name)) continue;
      if (sqliteSidecar(entry.name)) { await verifySidecar(path.join(source, entry.name)); continue; }
      const from = path.join(source, entry.name), to = path.join(destination, entry.name);
      if (entry.isDirectory()) await this.copyTree(from, to, backup, root);
      else if (entry.isFile()) {
        if (backup && sqlite(entry.name)) {
          const database = new Database(sqliteFilename(from), { readonly: true, fileMustExist: true });
          try { await database.backup(sqliteFilename(to)); } finally { database.close(); }
        } else await copyFile(from, to, constants.COPYFILE_EXCL);
        await chmod(to, 0o600); const file = await open(to, "r+"); try { await file.sync(); } finally { await file.close(); }
      }
      else throw invalid("Copilot recovery cannot copy nonregular files.");
    }
    await syncDirectory(destination);
  }
  private async restore(source: string): Promise<void> {
    await noSymlinks(this.sourceDirectory);
    await mkdir(path.dirname(this.sourceDirectory), { recursive: true, mode: 0o700 });
    // Exclusive directory creation and file publication never replace a competing
    // writer. An interrupted restore remains incomplete and blocks native startup.
    await mkdir(this.sourceDirectory, { mode: 0o700 });
    await this.copyTree(source, this.sourceDirectory);
    if (canonical(await this.inventory(this.sourceDirectory)) !== canonical(this.state!.files)) throw invalid("Copilot restored material differs from its protected snapshot.");
    await syncDirectory(path.dirname(this.sourceDirectory));
  }
  private async verifyExisting(snapshot: string): Promise<void> {
    const before = await this.inventory(this.sourceDirectory, false, true);
    const observed = path.join(this.options.directory, `verify-${randomUUID()}`);
    try {
      await this.copyTree(this.sourceDirectory, observed, true);
      if (canonical(before) !== canonical(await this.inventory(this.sourceDirectory, false, true))) throw invalid("Copilot native material changed during recovery verification.");
      const files = await this.inventory(observed), expected = this.state!.files;
      if (canonical(files.filter(file => file.path !== "events.jsonl")) !== canonical(expected.filter(file => file.path !== "events.jsonl"))) throw invalid("Existing Copilot material differs from its protected snapshot; it is preserved.");
      const [protectedBytes, nativeBytes] = await Promise.all([readFile(path.join(snapshot, "events.jsonl")), readFile(path.join(observed, "events.jsonl"))]);
      if (!nativeBytes.subarray(0, protectedBytes.length).equals(protectedBytes)) throw invalid("Existing Copilot history differs from its protected prefix; it is preserved.");
      const suffix = new TextDecoder("utf-8", { fatal: true }).decode(nativeBytes.subarray(protectedBytes.length));
      if (suffix && (!suffix.endsWith("\n") || suffix.trimEnd().split("\n").some(line => object(JSON.parse(line)).type !== "session.shutdown"))) throw invalid("Existing Copilot history contains newer unprotected activity; it is preserved.");
      await this.validateEvents(observed, this.state!.nativeSessionId, this.state!.nativeUserMessageId!);
    } finally { await this.inventory(observed, true); await rm(observed, { recursive: true, force: true }); }
  }
  private async validateEvents(directory: string, nativeId: string, messageId: string): Promise<void> {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path.join(directory, "events.jsonl"))); }
    catch (error) { if (missing(error)) throw new CopilotBotRecoveryError("recovery_material_missing", "Copilot native event log is missing."); throw error; }
    if (!text.endsWith("\n")) throw invalid("Copilot event log ends with an incomplete record.");
    const events = text.trimEnd().split("\n").map(line => object(JSON.parse(line))), first = events[0], ids = new Set<string>();
    if (first?.type !== "session.start" || object(first.data).sessionId !== nativeId || object(object(first.data).context).cwd !== this.state!.cwd
      || object(first.data).copilotVersion !== "1.0.105") throw invalid("Copilot event log has a different Session, workspace or version.");
    let input = false, ended = false, response = false; const tools = new Set<string>();
    for (const event of events) {
      if (!uuid(event.id) || ids.has(event.id)) throw invalid("Copilot event identity is invalid or repeated."); ids.add(event.id);
      const data = object(event.data);
      if (event.type === "user.message") {
        if (event.id === messageId || data.messageId === messageId) { input = true; ended = false; response = false; }
        else if (input) throw invalid("Copilot event log contains a later unprotected input.");
      }
      if (/compaction|subagent|autopilot|background/.test(String(event.type))) throw new CopilotBotRecoveryError("recovery_material_incomplete", "Copilot history requires an unsupported recovery profile.");
      if (!input) continue;
      if (event.type === "session.error" || event.type === "abort") throw new CopilotBotRecoveryError("recovery_material_incomplete", "Copilot turn did not complete successfully.");
      if (event.type === "tool.execution_start") { if (typeof data.toolCallId !== "string") throw invalid("Copilot tool call identity is missing."); tools.add(data.toolCallId); }
      if (event.type === "tool.execution_complete") { if (typeof data.toolCallId !== "string" || !tools.delete(data.toolCallId)) throw invalid("Copilot tool result has no matching call."); }
      if (event.type === "assistant.message") response = true;
      if (event.type === "assistant.turn_end") ended = true;
    }
    if (!input || !ended || !response || tools.size) throw new CopilotBotRecoveryError("recovery_material_incomplete", "Copilot event log does not contain a complete successful turn and all tool results.");
  }
  protect(nativeSessionId: string, turnId: string, nativeUserMessageId: string, assertCurrent?: () => void): Promise<void> {
    return this.enqueue(() => this.mutate(async () => {
      if (nativeSessionId !== this.state!.nativeSessionId || !uuid(turnId) || !uuid(nativeUserMessageId)) throw invalid("Copilot protected turn identity is invalid.");
      if (!this.runtimeVersion) throw new CopilotBotRecoveryError("recovery_version_unsupported", "Copilot runtime must be verified before protection.");
      await this.validateEvents(this.sourceDirectory, nativeSessionId, nativeUserMessageId);
      const before = await this.inventory(this.sourceDirectory, false, true), generation = randomUUID(), previous = this.state!.snapshot;
      const destination = path.join(this.options.directory, "snapshots", generation);
      await this.copyTree(this.sourceDirectory, destination, true);
      if (canonical(await this.inventory(this.sourceDirectory, false, true)) !== canonical(before)) throw invalid("Copilot native material changed during snapshot publication.");
      await this.validateEvents(destination, nativeSessionId, nativeUserMessageId);
      const files = await this.inventory(destination);
      await syncDirectory(path.dirname(destination));
      assertCurrent?.();
      this.save({ ...this.state!, version: this.runtimeVersion, dirty: false, protectedThroughTurn: turnId, nativeUserMessageId, snapshot: generation, files });
      if (previous) this.retiredSnapshots.add(previous);
      try {
        for (const retired of this.retiredSnapshots) {
          const directory = path.join(this.options.directory, "snapshots", retired);
          await this.inventory(directory, true); await rm(directory, { recursive: true, force: true }); this.retiredSnapshots.delete(retired);
        }
      } catch (cause) { throw new CopilotBotRecoveryError("recovery_cleanup_failed", "The Copilot recovery point committed, but retired snapshot cleanup failed.", { cause }); }
    }));
  }
  async close(): Promise<void> {
    await this.work; this.closing = true;
    this.db?.close(); this.db = undefined;
  }
}
