import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

export type CodexBotRecoveryIdentity = { serverOrigin: string; ownerUserId: string; botId: string; sessionId: string };
export type CodexBotRecoveryOptions = { directory: string; identity: CodexBotRecoveryIdentity; cwd: string };
type Point = { nativeSessionId: string; providerVersion: string; protectedThroughTurn: string | null; file: string; bytes: number; sha256: string };
type Manifest = { recoveryFormatVersion: 1; provider: "codex"; identity: CodexBotRecoveryIdentity; cwd: string; dirty: boolean; activeFile: string | null; point: Point | null };
export class CodexBotRecoveryError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: "recovery_version_unsupported" | "recovery_material_missing" | "recovery_material_invalid" | "recovery_material_incomplete" | "outcome_unknown", detail: string, options?: ErrorOptions) {
    super(`${code}: ${detail}`, options); this.name = "CodexBotRecoveryError"; this.retryable = code === "recovery_material_incomplete";
  }
}
const invalid = (detail: string) => new CodexBotRecoveryError("recovery_material_invalid", detail);
const incomplete = (detail: string) => new CodexBotRecoveryError("recovery_material_incomplete", detail);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const ownedFile = (name: unknown, prefix: string): name is string => typeof name === "string" && name.startsWith(`${prefix}-`) && name.endsWith(".jsonl") && uuid(name.slice(prefix.length + 1, -6));
const absent = (error: unknown) => object(error).code === "ENOENT";
const maxLineBytes = 32 * 1024 * 1024;
const rolloutTypes = new Set(["session_meta", "event_msg", "response_item", "turn_context", "compacted", "world_state", "token_usage_record"]);
const cellWait = (item: Record<string, unknown>): boolean => {
  // The verified legacy rollout spells the code-mode tool "wait". Other
  // namespaces and call formats do not inherit this argument-based exception.
  if (item.type !== "function_call" || item.name !== "wait" || typeof item.arguments !== "string") return false;
  let args: Record<string, unknown>;
  try { args = object(JSON.parse(item.arguments)); } catch { return false; }
  return typeof args.cell_id === "string" && args.cell_id.trim().length > 0
    && Object.keys(args).every(key => ["cell_id", "yield_time_ms", "max_tokens", "terminate"].includes(key))
    && ["yield_time_ms", "max_tokens"].every(key => !Object.hasOwn(args, key) || Number.isSafeInteger(args[key]) && (args[key] as number) >= 0)
    && (!Object.hasOwn(args, "terminate") || typeof args.terminate === "boolean");
};
/** This recovery profile owns one legacy rollout, not another thread or external media. */
const validateDependencies = (entry: Record<string, unknown>): void => {
  if (!rolloutTypes.has(String(entry.type))) throw invalid("Codex rollout uses an unsupported native record type.");
  const payload = object(entry.payload);
  if ([entry, payload].some(item => ["forked_from_id", "forked_from", "history_base"].some(key => item[key] !== undefined && item[key] !== null))
    || entry.type === "session_meta" && object(payload.source).subagent != null
    || entry.type === "event_msg" && typeof payload.type === "string" && /^(?:collab_|collab[A-Z])/.test(payload.type)) {
    throw invalid("Codex recovery has an unsupported dependency on another native thread.");
  }
  const media = (value: unknown) => {
    const item = object(value);
    if (["local_image", "localImage", "input_file"].includes(String(item.type))) throw invalid("Codex recovery has an unsupported dependency on external media.");
    if (Object.hasOwn(item, "image_url") && (typeof item.image_url !== "string" || !/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(item.image_url))) throw invalid("Codex recovery has an unsupported dependency on an external image URL.");
    if (["input_image", "image"].includes(String(item.type)) && ["path", "file_path", "url"].some(key => item[key] !== undefined)) throw invalid("Codex recovery has an unsupported dependency on an external image path.");
  };
  const response = (value: unknown) => {
    const item = object(value);
    if (["function_call", "custom_tool_call", "tool_call"].includes(String(item.type)) && typeof item.name === "string" && /(?:^|[.:])(?:spawn_agent|send_input|wait|close_agent|resume_agent)$/.test(item.name) && !cellWait(item)) {
      throw invalid("Codex recovery has an unsupported dependency on another native thread.");
    }
    if (item.type === "message" && Array.isArray(item.content)) for (const part of item.content) media(part);
    if (item.type === "function_call_output" && Array.isArray(item.output)) for (const part of item.output) media(part);
  };
  // Native tool declarations and arbitrary JSON returned by a tool are data.
  // Only actual response items, media parts and event identities own dependencies.
  if (entry.type === "response_item") response(payload);
  if (entry.type === "compacted" && Array.isArray(payload.replacement_history)) for (const item of payload.replacement_history) response(item);
  if (entry.type === "event_msg" && payload.type === "user_message") {
    if (Array.isArray(payload.local_images) && payload.local_images.length) throw invalid("Codex recovery has an unsupported dependency on external image paths.");
    if (Array.isArray(payload.images)) for (const image of payload.images) media({ type: "input_image", image_url: image });
  }
};

/** The owner serializes calls under its Controller storage ownership and proves the old writer stopped before prepare. */
export class CodexBotRecovery {
  private manifest: Manifest | undefined;
  private publicationFailure: CodexBotRecoveryError | undefined;
  private readonly manifestPath: string;
  get protectedThroughTurn(): string | null { return this.manifest?.point?.protectedThroughTurn ?? null; }
  constructor(private readonly options: CodexBotRecoveryOptions) {
    if (![options.directory, options.cwd].every(value => path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/.test(value))
      || ![options.identity.ownerUserId, options.identity.botId, options.identity.sessionId].every(uuid)
      || typeof options.identity.serverOrigin !== "string") throw invalid("Bot recovery identity or location is invalid.");
    const origin = new URL(options.identity.serverOrigin);
    if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== options.identity.serverOrigin) throw invalid("Bot recovery service origin is invalid.");
    this.manifestPath = path.join(options.directory, "manifest.json");
  }

  private async directory(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.options.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(this.options.directory) !== this.options.directory
      || process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw invalid("Bot recovery requires its physical private directory.");
  }

  private async load(): Promise<Manifest | undefined> {
    await this.directory();
    let metadata;
    try { metadata = await lstat(this.manifestPath); } catch (error) { if (absent(error)) return undefined; throw error; }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) throw invalid("Bot recovery manifest is not a bounded regular file.");
    let raw: unknown;
    try { raw = JSON.parse(await readFile(this.manifestPath, "utf8")); } catch (cause) { throw new CodexBotRecoveryError("recovery_material_invalid", "Bot recovery manifest cannot be decoded.", { cause }); }
    const value = object(raw), identity = object(value.identity), point = object(value.point);
    if (value.recoveryFormatVersion !== 1) throw new CodexBotRecoveryError("recovery_version_unsupported", "The Bot recovery manifest format is unsupported.");
    if (value.provider !== "codex" || typeof value.dirty !== "boolean"
      || value.cwd !== await realpath(this.options.cwd) || !(value.activeFile === null || ownedFile(value.activeFile, "active"))
      || Object.entries(this.options.identity).some(([key, expected]) => identity[key] !== expected)
      || value.point !== null && (!uuid(point.nativeSessionId) || typeof point.providerVersion !== "string"
        || !(point.protectedThroughTurn === null || typeof point.protectedThroughTurn === "string" && point.protectedThroughTurn.length > 0)
        || !ownedFile(point.file, "snapshot") || !Number.isSafeInteger(point.bytes) || (point.bytes as number) < 1
        || typeof point.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(point.sha256))) throw invalid("Bot recovery manifest identity or format is inconsistent.");
    return raw as Manifest;
  }

  private async publish(value: Manifest): Promise<void> {
    this.assertPublicationConfirmed();
    try {
      await this.directory();
      const temporary = path.join(this.options.directory, `manifest-${randomUUID()}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try {
        try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); } finally { await file.close(); }
        await rename(temporary, this.manifestPath);
        await this.syncDirectory();
      } finally { await unlink(temporary).catch(error => { if (!absent(error)) throw error; }); }
      this.manifest = value;
    } catch (cause) {
      // Replacement can be visible without a confirmed durability barrier. An
      // old cached dirty value or a fresh read cannot authorize native dispatch.
      this.publicationFailure = new CodexBotRecoveryError("outcome_unknown", "Codex recovery manifest publication is unconfirmed; this execution cannot admit another native operation.", { cause });
      throw cause;
    }
  }

  private assertPublicationConfirmed(): void {
    if (this.publicationFailure) throw this.publicationFailure;
  }

  private async syncDirectory(): Promise<void> {
    if (process.platform === "win32") return;
    const directory = await open(this.options.directory, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async markDirty(): Promise<void> {
    this.assertPublicationConfirmed();
    this.manifest ??= await this.load();
    if (this.manifest?.dirty) return;
    await this.publish(this.manifest ? { ...this.manifest, dirty: true } : {
      recoveryFormatVersion: 1, provider: "codex", identity: this.options.identity,
      cwd: await realpath(this.options.cwd), dirty: true, activeFile: null, point: null,
    });
  }

  /** A snapshot is immutable. Native resume receives a separate active copy. */
  async prepare(nativeSessionId: string | null): Promise<string | undefined> {
    this.assertPublicationConfirmed();
    this.manifest = await this.load();
    if (this.manifest?.dirty) throw new CodexBotRecoveryError("outcome_unknown", "The original Codex operation has no verified recovery point; do not replay it.");
    if (nativeSessionId === null) {
      if (this.manifest !== undefined) throw invalid("An existing Codex recovery point cannot start another thread.");
      return undefined;
    }
    const point = this.manifest?.point;
    if (!point) throw new CodexBotRecoveryError("recovery_material_missing", "The original Codex thread has no protected rollout.");
    if (point.nativeSessionId !== nativeSessionId) throw invalid("The protected Codex thread differs from the original native Session.");
    const destination = path.join(this.options.directory, `active-${randomUUID()}.jsonl`);
    const copied = await this.copy(path.join(this.options.directory, point.file), destination, nativeSessionId, point.protectedThroughTurn);
    if (copied.bytes !== point.bytes || copied.sha256 !== point.sha256) {
      await unlink(destination); throw invalid("The protected Codex rollout digest differs from its manifest.");
    }
    const previousActive = this.manifest!.activeFile;
    // Local verification has no native side effects. Keep a repairable original
    // point clean until the verified active copy is ready for native admission.
    await this.publish({ ...this.manifest!, dirty: true, activeFile: path.basename(destination) });
    if (previousActive) await unlink(path.join(this.options.directory, previousActive)).catch(error => { if (!absent(error)) throw error; });
    return destination;
  }

  async protect(input: { path: string; nativeSessionId: string; providerVersion: string; protectedThroughTurn: string | null; settingsAfter?: number }): Promise<void> {
    this.assertPublicationConfirmed();
    if (!uuid(input.nativeSessionId)) throw invalid("The native Codex Session ID is invalid.");
    if (input.settingsAfter !== undefined && (!Number.isSafeInteger(input.settingsAfter) || input.settingsAfter < 0)) throw invalid("The Codex settings checkpoint offset is invalid.");
    this.manifest ??= await this.load();
    if (this.manifest?.point && this.manifest.point.nativeSessionId !== input.nativeSessionId) throw invalid("Codex cannot replace the original protected thread.");
    if (this.protectedThroughTurn !== null && input.protectedThroughTurn === null) throw invalid("Codex cannot discard its protected turn watermark.");
    const name = `snapshot-${randomUUID()}.jsonl`, destination = path.join(this.options.directory, name);
    const copied = await this.copy(input.path, destination, input.nativeSessionId, input.protectedThroughTurn, true, input.settingsAfter);
    const previous = this.manifest?.point?.file;
    // A failed publication may have replaced the manifest before a directory sync
    // failed. Retain the completed file rather than deleting an uncertain owner.
    await this.publish({ recoveryFormatVersion: 1, provider: "codex", identity: this.options.identity, cwd: await realpath(this.options.cwd), dirty: false, activeFile: this.manifest?.activeFile ?? null,
      point: { nativeSessionId: input.nativeSessionId, providerVersion: input.providerVersion, protectedThroughTurn: input.protectedThroughTurn, file: name, ...copied } });
    if (previous && previous !== name) await unlink(path.join(this.options.directory, previous)).catch(error => { if (!absent(error)) throw error; });
  }

  private async copy(source: string, destination: string, nativeSessionId: string, protectedThroughTurn: string | null, waitForSource = false, settingsAfter?: number): Promise<{ bytes: number; sha256: string }> {
    let input: FileHandle | undefined, output: FileHandle | undefined, created = false, succeeded = false;
    try {
      if (!path.isAbsolute(source)) throw invalid("Codex rollout path must be absolute.");
      const named = await lstat(source).catch(error => { if (waitForSource && absent(error)) throw incomplete("The Codex rollout has not been persisted yet."); throw error; });
      if (!named.isFile() || named.isSymbolicLink() || await realpath(source) !== source) throw invalid("Codex rollout must be a physical regular file.");
      input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await input.stat();
      if (!before.isFile() || named.dev !== before.dev || named.ino !== before.ino || !Number.isSafeInteger(before.size)) throw invalid("Codex rollout changed before capture.");
      output = await open(destination, "wx", 0o600); created = true;
      const sha = createHash("sha256"), cwd = await realpath(this.options.cwd);
      let offset = 0, pending = Buffer.alloc(0), metadataCount = 0, lastTurn: string | null = null, activeTurn = false, hasTurns = false;
      let parsedBytes = 0, settingsConfirmed = settingsAfter === undefined;
      while (offset < before.size) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, before.size - offset));
        const { bytesRead } = await input.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) throw invalid("Codex rollout ended before its captured length.");
        const bytes = buffer.subarray(0, bytesRead); offset += bytesRead; sha.update(bytes); await output.writeFile(bytes);
        pending = Buffer.concat([pending, bytes]);
        let end: number;
        while ((end = pending.indexOf(10)) !== -1) {
          if (end > maxLineBytes) throw invalid("Codex rollout record exceeds the supported recovery budget.");
          const line = pending.subarray(0, end); pending = pending.subarray(end + 1);
          const lineOffset = parsedBytes; parsedBytes += end + 1;
          if (!line.length) throw invalid("Codex rollout contains an empty record.");
          let entry: Record<string, unknown>;
          try { entry = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line))); } catch { throw invalid("Codex rollout contains invalid UTF-8 or JSON."); }
          if (typeof entry.type !== "string" || !Object.hasOwn(entry, "payload")) throw invalid("Codex rollout record has no native type or payload.");
          validateDependencies(entry);
          if (metadataCount === 0 && entry.type !== "session_meta") throw invalid("Codex rollout must begin with its original Session metadata.");
          const payload = object(entry.payload);
          if (settingsAfter !== undefined && lineOffset >= settingsAfter && entry.type === "event_msg" && payload.type === "thread_settings_applied" && payload.thread_id === nativeSessionId) settingsConfirmed = true;
          if (entry.type === "session_meta") {
            metadataCount++;
            if (metadataCount !== 1 || payload.id !== nativeSessionId || typeof payload.cwd !== "string" || await realpath(payload.cwd) !== cwd) throw invalid("Codex rollout Session identity or working directory differs.");
          }
          if (entry.type === "compacted") hasTurns = true;
          if (entry.type === "event_msg" && payload.type === "task_started") { activeTurn = true; hasTurns = true; }
          if (entry.type === "event_msg" && (payload.type === "task_complete" || payload.type === "turn_aborted")) {
            lastTurn = typeof payload.turn_id === "string" && payload.turn_id.length > 0 ? payload.turn_id : null;
            activeTurn = false; hasTurns = true;
          }
        }
        if (pending.length > maxLineBytes) throw invalid("Codex rollout record exceeds the supported recovery budget.");
      }
      if (pending.length || before.size === 0 || activeTurn || !settingsConfirmed || protectedThroughTurn !== null && lastTurn !== protectedThroughTurn) throw incomplete("Codex rollout is incomplete or does not cover the protected completed turn and settings.");
      if (metadataCount !== 1) throw invalid("Codex rollout has no original Session metadata.");
      if (protectedThroughTurn === null && hasTurns) throw invalid("Only an empty Codex thread can have no protected turn watermark.");
      const [after, current] = await Promise.all([input.stat(), lstat(source)]);
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino || after.size !== before.size
        || current.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || await realpath(source) !== source) throw incomplete("Codex rollout changed during capture.");
      await output.sync();
      await output.close(); output = undefined;
      await input.close(); input = undefined;
      succeeded = true;
      return { bytes: offset, sha256: sha.digest("hex") };
    } catch (cause) {
      if (absent(cause)) throw new CodexBotRecoveryError("recovery_material_missing", "A required Codex rollout or working directory is missing.", { cause });
      throw cause;
    } finally {
      try { await output?.close(); } finally {
        try { await input?.close(); } finally { if (created && !succeeded) await unlink(destination).catch(error => { if (!absent(error)) throw error; }); }
      }
    }
  }
}
