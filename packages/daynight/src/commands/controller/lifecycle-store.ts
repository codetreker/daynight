import { clearSourceWire, clearSourceWireThrough, sourceWireEvent } from "./source-wire.js";
import { isProcessBirth } from "./linux-process-proof.js";
import { sqliteFilename, sqliteDisplayFilename } from "../../platform/sqlite-filename.js";
import { imageQualificationFingerprint } from "./providers/image-qualification.js";
import { openUsageStore } from "./usage/store.js";
import { createNativeInputPublication } from "./media/native-publication.js";
import type { NativeImageProjectionState } from "./media/native-publication-types.js";
import { nativeEntryId } from "./native-identity.js";
import { createImageCaptureSource } from "./media/capture-source.js";
import { createMarkdownSourceStore } from "./markdown/store.js";
import type { MarkdownProjectionState } from "./markdown/projection.js";
import { createNativeImageState } from "./media/native-state.js";
import { createImageHistorySource } from "./media/history-source.js";
import { openControllerMediaStore, type ControllerMediaStore } from "./media/preparations.js";
import type { ImageDecoder } from "./media/image-decoder.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalSessionIntent, parseImageOccurrence, parseNativeImageSource, parseInputObservation, type ImageOccurrence, type ImagePart, type ImageUnavailablePart, type ImageCaptureRequest, type ImageCaptureReceipt, type NativeImageSource, type InputObservation, parseProviderImageCapabilities, canonicalImageJson, type ProviderImageCapabilities } from "../../session/image-values.js";
import { parseStoredTimelineEntry, type SessionCommand, type TimelineEntry } from "../../session/protocol.js";
import { parseStartupObservation, type StartupObservation } from "../../session/startup.js";
import { sessionDisplayEntry } from "./wire-display.js";
import type { SessionControls } from "../../session/controls.js";
import Database from "better-sqlite3";
import { openSessionContent, type SessionContent, type SessionHistoryContentPolicy } from "./content/session-content.js";
import type { TimelineContentPolicy } from "./content/timeline-store.js";
import { openBotHistoryCache, type BotHistoryCacheBudget } from "./content/bot-history-cache.js";
import { fitsBotMarkdown, isBotDisplayEntry } from "./content/bot-history-display.js";
import { queueBotResourceRetirement, retireBotResources } from "./content/bot-resource-retirement.js";
import { assertNoOrphanTimelineSource } from "./content/migration.js";
import { closeSqliteDatabase, openSqliteDatabase, readSqliteDatabase, runSqliteImmediate, sqliteDatabaseIsMissing, sqliteTransactionOutcome, type SqliteMigrationReporter, type SqliteDatabaseSource } from "../../platform/sqlite-access.js";
import { assertCurrentSqlite, inspectSqlite } from "../../platform/sqlite-format.js";
import { SqliteAccessError, type SqliteOutcome } from "../../platform/sqlite-error.js";
import { controllerJournalFormat, inspectReadCompatibleControllerJournal } from "./journal-format.js";
import { openControllerOutbox, withOutboxTransactionOutcome } from "./outbox-store.js";
import { acquireControllerStoragePermit, assertControllerStoragePermit, type ControllerStoragePermit } from "./storage-lock.js";
import { controllerJournalReadOptions, controllerJournalWriteOptions, controllerTimelineCleanupPending, upgradeControllerJournal } from "./storage-preparation.js";
import { createLocalSessionContent } from "./local-content.js";
import { chmodSync, existsSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { sessionBinding, type SessionBinding, type InitialInputState, type OperationState, type SessionCapabilities } from "../../session/protocol.js";
import { controllerPayloadHash, controllerTicketPath, isBotHistoryTicket, readLaunchTicket, MAX_TICKET_BYTES, parseLaunchTicket, type ControllerLaunchTicket } from "./launch-ticket.js";
import { parseSourceEvent, type SourceEvent, type SourceTimelineEntry } from "../../session/controller-protocol.js";
import { confirmControllerProcessesStopped, type ControllerProcessProof, type ProcessProof } from "./process-proof.js";
import { isLinuxControllerLaunch } from "./linux-controller-launch.js";
import type { ControllerJobLease } from "./windows-job.js";
export type ControllerSnapshot = SessionBinding & {
  executionId: string; sessionId: string; executionGeneration: string; controllerInstanceId: string;
  lifecycle: "starting" | "ready" | "working" | "stopping" | "stopped" | "paused" | "failed";
  nativeSessionId: string | null; initialInputState: InitialInputState;
  activity: "initializing" | "idle" | "working" | "waiting_input" | "stopped" | "unknown";
  currentTurnId: string | null; capabilities: SessionCapabilities; controls?: SessionControls; controlsRevisionFloor?: string; turnStartedAt?: string | null;
  controllerProcess: ControllerProcessProof | null; nativeProcesses: readonly ProcessProof[];
  nativeStopped: boolean; stoppedAt: string | null; error: string | null; startup?: StartupObservation;
  windowsJobStopProof?: { readonly version: 1; readonly ticketHash: string; readonly snapshotHash: string };
};
export type ControllerOperation = {
  executionGeneration?: string;
  operationId: string; kind: "initial" | "cleanup" | "worker_input" | "send_message" | "cancel" | "interaction_response" | "update_setting" | "execute_command" | "refresh_controls";
  payload: unknown; payloadHash: string; state: OperationState;
  result: unknown; error: string | null; createdAt: number; updatedAt: number;
};
export type ControllerOutboxEvent = { sequence: string; payload: unknown };
const json = <T>(value: unknown): T => {
  try { return JSON.parse(String(value)) as T; }
  catch (cause) { throw new SqliteAccessError("invalid-format", { database: controllerJournalFormat.name, phase: "decode" }, { cause }); }
};
const checkedSnapshot = (value: ControllerSnapshot): ControllerSnapshot => {
  if (value.startup !== undefined) parseStartupObservation(value.startup);
  return value;
};
const closeJournal = (db: Database.Database, file: string, operation: () => void, completedOutcome: SqliteOutcome = "committed"): void => {
  let failed = false, failure: unknown;
  try { operation(); } catch (cause) { failed = true; failure = cause; }
  const outcome = completedOutcome === "not-started" ? "not-started" : failed ? sqliteTransactionOutcome(failure) : completedOutcome;
  try { closeSqliteDatabase(db, { file, format: controllerJournalFormat }, outcome); }
  catch (close) {
    if (failed) throw new SqliteAccessError("cleanup-failed", { database: controllerJournalFormat.name, file, phase: "close" }, { cause: new AggregateError([failure, close], "Controller journal operation and shutdown failed."), outcome, connectionClosed: !db.open });
    throw close;
  }
  if (failed) throw failure;
};
const validSequence = (value: string): bigint => { if (!/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) throw new Error("Invalid controller outbox sequence."); return BigInt(value); };
/** The store owns a supplied connection; file also identifies its Session-bound resource files. */
type ControllerLifecycleOptions = { maxOutboxBytes?: number; maxOnlineBytes?: number; historyPolicy?: SessionHistoryContentPolicy; contentOwnedLocally?: boolean; botHistoryBudget?: BotHistoryCacheBudget; onMigration?: SqliteMigrationReporter; database?: Database.Database; imageDecoder?: ImageDecoder; storagePermit?: ControllerStoragePermit; controllerProcess?: ControllerProcessProof };
const hasLinuxLaunchKind = (value: unknown): boolean => value !== null && typeof value === "object" && "kind" in value && value.kind === "linux-controller-launch";
const validateLaunchIdentity = (value: unknown, ticket: ControllerLaunchTicket): void => {
  if (hasLinuxLaunchKind(value) && (!isLinuxControllerLaunch(value) || value.launchId !== ticket.launchId)) throw new Error("Linux Controller launch identity conflicts with its original ticket.");
};
const createControllerLifecycleStore = (file: string, ticket: ControllerLaunchTicket, options: ControllerLifecycleOptions, permit: ControllerStoragePermit) => {
  assertControllerStoragePermit(permit, file);
  const maxOutboxBytes = options.maxOutboxBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxOutboxBytes) || maxOutboxBytes < 256) throw new Error("Invalid controller outbox capacity.");
  parseLaunchTicket(ticket);
  validateLaunchIdentity(options.controllerProcess, ticket);
  if (options.historyPolicy !== undefined && options.historyPolicy !== "legacy" && options.historyPolicy !== "task_body") throw new Error("Invalid Controller history policy.");
  if (options.historyPolicy === "task_body" && (ticket.claimId === undefined || !options.contentOwnedLocally)) throw new Error("Task body history requires a locally owned Task Session.");
  const initial: ControllerSnapshot = { executionId: ticket.executionId, ...sessionBinding(ticket), sessionId: ticket.sessionId, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: "starting", nativeSessionId: ticket.resumeNativeSessionId, initialInputState: ticket.initialInput === "none" ? "not_required" : "not_submitted", activity: "initializing", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, controllerProcess: options.controllerProcess ?? null, nativeProcesses: [], nativeStopped: false, stoppedAt: null, error: null, startup: { state: "starting", reasonCode: "initializing" } };
  let sessionContent!: SessionContent;
  let botHistory: ReturnType<typeof openBotHistoryCache> | null = null;
  let db!: Database.Database;
  let quarantined = false, outboxWritesDisabled = false, writeDepth = 0;
  const assertUsable = (): void => { if (quarantined) throw new Error("Controller journal has an unresolved transaction; independent recovery is required."); };
  const assertOutboxWrites = (): void => { if (outboxWritesDisabled) throw new Error("Controller outbox writes are disabled after an accounting failure."); };
  const quarantine = (_cause: unknown): void => { quarantined = true; };
  const transaction = <T>(action: () => T, mode: "deferred" | "immediate"): T => {
    assertUsable();
    assertControllerStoragePermit(permit, file);
    const nested = db.inTransaction;
    let failed = false, primary: unknown;
    try {
      return db.transaction(() => {
        const previousDepth = writeDepth;
        if (mode === "immediate") writeDepth++;
        try { assertCurrentSqlite(db, controllerJournalFormat); return action(); }
        catch (cause) { failed = true; primary = cause; throw cause; }
        finally { writeDepth = previousDepth; }
      })[mode]();
    } catch (cause) {
      if (!nested && db.open && db.inTransaction) quarantine(cause);
      if (failed && cause !== primary) throw new AggregateError([primary, cause], "Controller journal operation and rollback failed.");
      if (!nested && mode === "immediate" && failed && cause === primary && db.open && !db.inTransaction) throw withOutboxTransactionOutcome(cause, "rolled-back");
      throw cause;
    }
  };
  const atomic = <T>(action: () => T): T => transaction(action, "immediate");
  const read = <T>(action: () => T): T => transaction(action, "deferred");
  const assertTimelineWrite = (): void => {
    assertUsable();
    assertControllerStoragePermit(permit, file);
    if (writeDepth === 0 || !db.inTransaction) throw new Error("SQL timeline publication requires the original Controller write transaction.");
  };
  db = openSqliteDatabase({ ...controllerJournalWriteOptions(file, permit, options.onMigration), file: options.database ?? file, allowCreate: true });
  let initializationOutcome: SqliteOutcome = "not-started";
  try {
    runSqliteImmediate(db, () => {
      assertCurrentSqlite(db, controllerJournalFormat);
      if (controllerTimelineCleanupPending(db)) throw new Error("Controller timeline maintenance must finish before writer initialization.");
      if (!db.memory) chmodSync(file, 0o600);
      const existing = db.prepare("SELECT ticket_hash, owner_pid, snapshot FROM execution WHERE id=1").get() as { ticket_hash: string; owner_pid: number | null; snapshot: string } | undefined;
      if (existing === undefined) {
        assertNoOrphanTimelineSource(file);
        db.prepare("INSERT INTO execution(id,ticket_hash,owner_pid,snapshot) VALUES(1,?,?,?)").run(controllerPayloadHash(ticket), process.pid, JSON.stringify(initial));
        db.prepare("UPDATE execution SET history_content_policy=? WHERE id=1").run(options.historyPolicy ?? "legacy");
      } else {
        if (existing.owner_pid !== null) {
          try { process.kill(existing.owner_pid, 0); throw new Error("The original controller journal writer is still running."); }
          catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
        }
        const previous = json<ControllerSnapshot>(existing.snapshot);
        if (previous.executionId !== ticket.executionId || previous.claimId !== ticket.claimId || previous.testExecutionId !== ticket.testExecutionId || previous.sessionId !== ticket.sessionId) throw new Error("Controller journal belongs to another execution.");
        if (existing.ticket_hash === controllerPayloadHash(ticket) && previous.controllerProcess !== null) throw new Error("A native controller generation cannot be relaunched without a new stopped-generation ticket.");
        if (existing.ticket_hash !== controllerPayloadHash(ticket)) {
          if (BigInt(ticket.executionGeneration) !== BigInt(previous.executionGeneration) + 1n || !previous.nativeStopped || previous.lifecycle !== "stopped" || previous.nativeSessionId === null || previous.nativeSessionId !== ticket.resumeNativeSessionId) throw new Error("Controller recovery requires a stopped original generation and exact native identity.");
          if (process.platform === "win32") validateWindowsStoredStopProof(previous, existing.ticket_hash);
          if (hasLinuxLaunchKind(previous.controllerProcess)) {
            if (!/^[a-f0-9]{64}$/.test(existing.ticket_hash) || !isLinuxControllerLaunch(previous.controllerProcess) || existing.owner_pid !== null || !Array.isArray(previous.nativeProcesses) || !previous.nativeProcesses.every(isValidNativeProcessProof)
              || typeof previous.stoppedAt !== "string" || !Number.isFinite(Date.parse(previous.stoppedAt))) throw new Error("Linux Controller stopped generation identity or writer is invalid.");
            const receipt = db.prepare("SELECT snapshot FROM stopped_generations WHERE ticket_hash=?").get(existing.ticket_hash) as { snapshot: string } | undefined;
            if (receipt === undefined || controllerPayloadHash(json<ControllerSnapshot>(receipt.snapshot)) !== controllerPayloadHash(previous)) throw new Error("Linux Controller stopped generation receipt is unavailable or conflicts with its original evidence.");
          } else if (previous.controllerProcess !== null) retainStoppedGeneration(db, existing.ticket_hash, previous);
          db.prepare("UPDATE execution SET ticket_hash=?,snapshot=? WHERE id=1").run(controllerPayloadHash(ticket), JSON.stringify({ ...initial, initialInputState: previous.initialInputState, controlsRevisionFloor: (() => {
            let floor = BigInt(previous.controls?.revision ?? previous.controlsRevisionFloor ?? "0");
            // Old source events are replayed before new provider state. Keep their
            // highest revision across execution reset without dropping the outbox.
            for (const row of db.prepare("SELECT json_extract(value, '$.payload.controls.revision') AS revision FROM outbox WHERE json_extract(value, '$.kind')='state'").iterate() as Iterable<{ revision: string | null }>) {
              if (row.revision !== null && /^[1-9][0-9]{0,18}$/.test(row.revision) && BigInt(row.revision) > floor) floor = BigInt(row.revision);
            }
            return String(floor);
          })() }));
        }
        db.prepare("UPDATE execution SET owner_pid=? WHERE id=1").run(process.pid);
      }
      // Earlier events may have been sent by a version without wire records.
      db.prepare("INSERT OR IGNORE INTO image_runtime_state SELECT 'source_wire_tracking',CAST(last_sequence AS TEXT) FROM execution WHERE id=1").run();
      if (existing !== undefined && !existsSync(`${file}.pending-content/manifest.json`)) throw new Error("Pending archive source is missing.");
      sessionContent = openSessionContent(file, ticket.sessionId, db, { read, assertWrite: assertTimelineWrite }, options.maxOnlineBytes === undefined ? {} : { maxOnlineBytes: options.maxOnlineBytes });
      if (existing === undefined && (sessionContent.timeline.totals().entryCount !== 0 || sessionContent.resourceFiles.resources.size !== 0)) throw new Error("Pending archive source has no original controller execution.");
      if (isBotHistoryTicket(ticket)) {
        botHistory = openBotHistoryCache(db, sessionContent.timeline, options.botHistoryBudget);
        writeDepth++;
        try { botHistory.initialize(); } finally { writeDepth--; }
      } else if (db.prepare("SELECT 1 FROM bot_history_state").get() !== undefined) throw new Error("A bounded Bot journal requires its original Bot identity.");
    });
    initializationOutcome = "committed";
  const outbox = openControllerOutbox(db, { assertWrite: () => { assertOutboxWrites(); assertTimelineWrite(); } });
  const markdownStore = createMarkdownSourceStore(db, { read, write: atomic }, sessionContent.contentPolicy === "task_body" ? { maxBytes: 512 * 1024 * 1024 } : {});
  const usage = openUsageStore(db, { read, write: atomic });
  const getSnapshot = (): ControllerSnapshot => read(() => checkedSnapshot(json((db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string }).snapshot)));
  const getOperation = (operationId: string): ControllerOperation | null => read(() => { const row = db.prepare("SELECT value FROM operations WHERE id=?").get(operationId) as { value: string } | undefined; return row === undefined ? null : json(row.value); });
  const writeOperation = (operation: ControllerOperation): ControllerOperation => { db.prepare("INSERT INTO operations(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,acknowledged=0").run(operation.operationId, JSON.stringify(operation)); return operation; };
  const patchSnapshot = (patch: Partial<Omit<ControllerSnapshot, "executionId" | "claimId" | "testExecutionId" | "sessionId" | "executionGeneration" | "controllerInstanceId" | "windowsJobStopProof">>): ControllerSnapshot => atomic(() => {
    const current = getSnapshot();
    if (Object.hasOwn(patch, "windowsJobStopProof") || current.windowsJobStopProof !== undefined) throw new Error("A completed Windows Job stop proof cannot be patched by the Controller.");
    if (Object.keys(patch).some((key) => ["executionId", "claimId", "testExecutionId", "sessionId", "executionGeneration", "controllerInstanceId"].includes(key))) throw new Error("Controller identity cannot change within a generation.");
    if (current.nativeSessionId !== null && patch.nativeSessionId !== undefined && patch.nativeSessionId !== current.nativeSessionId) throw new Error("The original native session cannot be replaced.");
    validateLaunchIdentity(patch.controllerProcess, ticket);
    if (isLinuxControllerLaunch(current.controllerProcess) && Object.hasOwn(patch, "controllerProcess") && controllerPayloadHash(patch.controllerProcess) !== controllerPayloadHash(current.controllerProcess)) throw new Error("Linux Controller launch identity cannot change within a generation.");
    const value = checkedSnapshot({ ...current, ...patch }); db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(value)); return value;
  });
  const outboxBytes = (): number => read(() => outbox.byteLength());
  const assertInputCapacity = (): void => { assertUsable(); if (!options.contentOwnedLocally && outboxBytes() >= maxOutboxBytes * 0.8) throw new Error("Controller outbox capacity reached; native input is paused until durable events are acknowledged."); };
  const localContent = createLocalSessionContent(sessionContent, ticket.sessionId, { read, write: atomic });
  const appendEvent = (payload: unknown): ControllerOutboxEvent => atomic(() => {
    assertOutboxWrites();
    if (options.contentOwnedLocally && payload && typeof payload === "object" && "kind" in payload && payload.kind === "resource" && "payload" in payload) {
      const event = parseSourceEvent({ sourceSeq: "1", ...payload });
      if (event.kind === "resource") localContent.saveResource(event.payload);
    }
    const encoded = JSON.stringify(payload);
    assertOutboxWrites();
    if (encoded === undefined) throw new Error("Controller event must be serializable.");
    if (outboxBytes() + Buffer.byteLength(encoded) > maxOutboxBytes) {
      if (!options.contentOwnedLocally) throw new Error("Controller outbox capacity exceeded; event was not discarded.");
      // Content is already committed in the local projection. Only transport
      // replay is discarded; the next connection must hydrate from local data.
      outbox.clear();
      clearSourceWire(db);
      db.prepare("UPDATE execution SET source_floor=last_sequence WHERE id=1").run();
    }
    const row = db.prepare("UPDATE execution SET last_sequence=last_sequence+1 WHERE id=1 RETURNING CAST(last_sequence AS TEXT) AS sequence").get() as { sequence: string };
    if (options.contentOwnedLocally && Buffer.byteLength(encoded) > maxOutboxBytes) db.prepare("UPDATE execution SET source_floor=last_sequence WHERE id=1").run();
    else outbox.append(BigInt(row.sequence), encoded);
    return { sequence: row.sequence, payload };
  });
  let closed = false;
  let mediaInstance: ControllerMediaStore | undefined;
  const media = () => { assertUsable(); return mediaInstance ??= openControllerMediaStore(file, ticket, db, sessionContent.resourceFiles, { read, write: atomic }, getSnapshot, options.imageDecoder); };
  const preserveTimelineAssociations = <T extends SourceTimelineEntry>(input: T): T => {
    let entry = input;
    const source = db.prepare("SELECT origin FROM input_message_origins WHERE entry_id=?").get(entry.entryId) as { origin: "user" | "daynight" } | undefined;
    if (source) {
      if (entry.kind !== "user_message" || entry.origin !== undefined && entry.origin !== source.origin) throw new Error("Timeline update changed its original input origin.");
      entry = { ...entry, origin: source.origin };
    }
    const originals = db.prepare("SELECT i.image_id,i.resource_id,i.part_index FROM native_input_publication_images i JOIN native_input_publications p ON p.operation_id=i.operation_id WHERE json_extract(p.value,'$.receipt.identity.entryId')=?").all(entry.entryId) as { image_id: string; resource_id: string; part_index: number }[];
    for (const original of originals) {
      const part = entry.kind === "user_message" ? entry.content[original.part_index] : undefined;
      if (!part || part.type !== "image" && part.type !== "image_unavailable" || part.imageId !== original.image_id || part.type === "image" && part.resourceId !== original.resource_id) throw new Error("Timeline update cannot move or replace a committed original image association.");
    }
    return entry;
  };
  // Identity and online publication belong to the caller. Excluded history must
  // not allocate source sequences or acknowledge operations on its behalf.
  const saveTimelineHistory = (entry: TimelineEntry, policy: TimelineContentPolicy) => atomic(() => {
    if (botHistory !== null) throw new Error("Bounded Bot history requires its original cache publication.");
    if (sessionContent.contentPolicy === "task_body" && policy !== "task_body") throw new Error("Task history cannot adopt a different content policy.");
    return sessionContent.timeline.save(preserveTimelineAssociations(entry), policy);
  });
  const botDisplayRetired = (entry: SourceTimelineEntry): boolean => {
    if (!botHistory || !isBotDisplayEntry(entry)) return false;
    const identity = botHistory.identity(entry.entryId);
    return identity !== undefined && (identity.preview === null || identity.summarized === 1);
  };
  const markdownKey = (id: string): string => `markdown:projection:${id}`;
  const projectTimeline = (input: SourceTimelineEntry, preserveBotPreview = false): ControllerOutboxEvent | null => atomic(() => {
    if (botDisplayRetired(input)) return null;
    if (botHistory && !fitsBotMarkdown(input)) db.prepare("DELETE FROM image_runtime_state WHERE key=?").run(markdownKey(input.entryId));
    const entry = preserveTimelineAssociations(input);
    const { revision: ignored, entrySeq: ignoredSequence, ...content } = entry;
    void ignored; void ignoredSequence;
    const contentHash = controllerPayloadHash(content);
    const previous = sessionContent.onlineTimeline.get(entry.entryId);
    const previousContent = previous ? (({ revision, entrySeq, ...value }) => { void revision; void entrySeq; return value; })(previous) : null;
    const known = botHistory?.identity(entry.entryId);
    if (botHistory ? known?.source_hash === contentHash : previousContent !== null && controllerPayloadHash(previousContent) === contentHash) return null;
    const previousSource = botHistory && known ? db.prepare("SELECT CAST(revision AS TEXT) AS revision FROM timeline_source_revisions WHERE entry_id=?").get(entry.entryId) as { revision: string } | undefined : undefined;
    const revisions = [previous?.revision, previousSource?.revision, known?.preview ? (JSON.parse(known.preview) as { revision: string }).revision : undefined];
    const revision = String(revisions.reduce<bigint>((maximum, value) => value !== undefined && BigInt(value) > maximum ? BigInt(value) : maximum, 0n) + 1n);
    const entrySeq = previous?.entrySeq ?? known?.entry_seq ?? botHistory?.nextSequence() ?? sessionContent.onlineTimeline.nextSequence();
    const payload = { ...content, revision, ...(options.contentOwnedLocally ? { entrySeq } : {}) } as SourceTimelineEntry;
    const durableEntry = { ...payload, entrySeq } as import("../../session/protocol.js").TimelineEntry;
    const retained = botHistory?.save(durableEntry, contentHash, preserveBotPreview) ?? parseStoredTimelineEntry(durableEntry);
    const { entrySeq: _storedSequence, ...storedPayload } = retained;
    const outgoing = botHistory ? { ...storedPayload, entrySeq } : payload;
    const display = options.contentOwnedLocally || botHistory !== null ? sessionDisplayEntry(outgoing) : outgoing;
    parseSourceEvent({ sourceSeq: "1", kind: "timeline_upsert", payload: display });
    // Online details and source replay commit together; ACK never removes the
    // original content needed by a reconnect or an outstanding approval.
    if (botHistory === null) sessionContent.onlineTimeline.save(durableEntry);
    const event = appendEvent({ kind: "timeline_upsert", payload: display });
    db.prepare("INSERT INTO timeline_source_revisions VALUES(?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET revision=excluded.revision,source_sequence=excluded.source_sequence,position_visible=excluded.position_visible").run(entry.entryId, revision, event.sequence, display.kind === payload.kind ? 1 : 0);
    return event;
  });
  const associateInputMessage = (operationId: string, nativeSessionId: string, entryId: string): string => atomic(() => {
    const operation = getOperation(operationId);
    if (!operation || operation.kind !== "send_message" && operation.kind !== "worker_input" || !operation.payload || typeof operation.payload !== "object" || !("origin" in operation.payload)) return entryId;
    const origin = operation.payload.origin;
    if (origin !== "user" && origin !== "daynight") throw new Error("Invalid persisted input origin.");
    if (nativeSessionId !== getSnapshot().nativeSessionId || !/^[a-f0-9-]{36}$/.test(entryId)) throw new Error("Native message identity differs from its original input.");
    if (!["dispatching", "unknown", "provider_accepted", "confirmed"].includes(operation.state)) throw new Error("Native message has no dispatched original input.");
    // Native history can rebuild raw item IDs while retaining the original
    // operation identity. Provenance and projection must reuse one durable row.
    const original = db.prepare("SELECT entry_id,origin FROM input_message_origins WHERE operation_id=?").get(operationId) as { entry_id: string; origin: string } | undefined;
    if (original) {
      if (original.origin !== origin) throw new Error("Native message origin conflicts with its original input.");
      entryId = original.entry_id;
    }
    const existing = db.prepare("SELECT operation_id,origin FROM input_message_origins WHERE entry_id=?").get(entryId) as { operation_id: string; origin: string } | undefined;
    if (existing && (existing.operation_id !== operationId || existing.origin !== origin)) throw new Error("Native message origin conflicts with its original input.");
    const current = sessionContent.onlineTimeline.get(entryId);
    if (current && current.kind !== "user_message") throw new Error("Native input cannot replace another timeline kind.");
    if (!existing) {
      db.prepare("INSERT INTO input_message_origins VALUES(?,?,?)").run(entryId, operationId, origin);
    }
    if (current) projectTimeline(current, true);
    return entryId;
  });
  const publishTimelineSnapshot = (entry: TimelineEntry): ControllerOutboxEvent => atomic(() => {
    const current = sessionContent.onlineTimeline.get(entry.entryId);
    if (!current || controllerPayloadHash(current) !== controllerPayloadHash(entry)) throw new Error("Timeline publication requires its current committed content.");
    const { entrySeq, ...content } = entry;
    const payload = options.contentOwnedLocally ? { ...content, entrySeq } : content;
    const display = options.contentOwnedLocally ? sessionDisplayEntry(payload) : payload;
    parseSourceEvent({ sourceSeq: "1", kind: "timeline_upsert", payload: display });
    const event = appendEvent({ kind: "timeline_upsert", payload: display });
    db.prepare("INSERT INTO timeline_source_revisions VALUES(?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET revision=excluded.revision,source_sequence=excluded.source_sequence,position_visible=excluded.position_visible").run(entry.entryId, entry.revision, event.sequence, display.kind === payload.kind ? 1 : 0);
    return event;
  });
  const botRetiredImagePosition = (entryId: string): { entrySeq: string; revision: string; sourceSequence: string } | null => {
    const known = botHistory?.identity(entryId);
    if (!known || known.preview !== null && known.summarized === 0) return null;
    const source = db.prepare("SELECT CAST(revision AS TEXT) AS revision,CAST(source_sequence AS TEXT) AS sourceSequence FROM timeline_source_revisions WHERE entry_id=?").get(entryId) as { revision: string; sourceSequence: string } | undefined;
    return source ? { entrySeq: known.entry_seq, ...source } : null;
  };
  const retiredNativeSlot = (occurrence: ImageOccurrence, nativeSource: NativeImageSource | null): NativeImageProjectionState | null => {
    if (!nativeSource || occurrence.partId !== null || !botRetiredImagePosition(occurrence.entryId)) return null;
    const key = `native_provider:image-slot:${nativeEntryId(nativeSource.nativeSessionId, occurrence.sourceKey)}`;
    const row = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(key) as { value: string } | undefined;
    if (!row) return null;
    const state = JSON.parse(row.value) as NativeImageProjectionState;
    if (!Number.isSafeInteger(state.index) || state.index < 0 || state.index >= 1000 || state.part.imageId !== occurrence.imageId
      || canonicalImageJson(state.request.occurrence) !== canonicalImageJson(occurrence) || canonicalImageJson(state.request.nativeSource) !== canonicalImageJson(nativeSource)
      || canonicalImageJson([1, nativeSource, occurrence.entryId, occurrence.container, occurrence.callId, state.index]) !== occurrence.sourceKey) throw new Error("Native image evidence differs from its original position.");
    return state;
  };
  const registerImageOccurrence = (input: ImageOccurrence, native: NativeImageSource | null): { occurrence: ImageOccurrence; sourceSequence: string; acknowledged: boolean } => atomic(() => {
    const occurrence = parseImageOccurrence(input), nativeSource = native === null ? null : parseNativeImageSource(native);
    if (nativeSource && (nativeSource.provider !== ticket.provider || nativeSource.nativeSessionId !== getSnapshot().nativeSessionId)) throw new Error("Image occurrence belongs to another native session.");
    const entry = sessionContent.onlineTimeline.get(occurrence.entryId);
    const retired = botRetiredImagePosition(occurrence.entryId);
    const nativeSlot = retired === null ? null : retiredNativeSlot(occurrence, nativeSource);
    const livePosition = entry && (!retired || occurrence.partId !== null) && (occurrence.container === "tool_output" ? entry.kind === "tool_call" && entry.callId === occurrence.callId : occurrence.container === "reasoning" ? entry.kind === "reasoning" : entry.kind === "user_message" || entry.kind === "assistant_message");
    const value = JSON.stringify(occurrence), source = nativeSource === null ? null : JSON.stringify(nativeSource);
    const previous = db.prepare("SELECT occurrence,native_source,source_sequence,acknowledged FROM image_occurrences WHERE image_id=?").get(occurrence.imageId) as { occurrence: string; native_source: string | null; source_sequence: string; acknowledged: number } | undefined;
    if (previous) {
      if (previous.occurrence !== value || previous.native_source !== source) throw new Error("Image occurrence cannot move from its original source.");
      if (!livePosition && !retired) throw new Error("Image occurrence has no durable original position.");
      return { occurrence, sourceSequence: previous.source_sequence, acknowledged: previous.acknowledged === 1 };
    }
    if (!livePosition && !nativeSlot) {
      if (retired && nativeSource === null) return { occurrence, sourceSequence: retired.sourceSequence, acknowledged: false };
      throw new Error("Image occurrence has no durable original position.");
    }
    const sequence = retired?.sourceSequence ?? (db.prepare("SELECT CAST(last_sequence AS TEXT) AS sequence FROM execution WHERE id=1").get() as { sequence: string }).sequence;
    const ack = (db.prepare("SELECT CAST(last_acknowledged AS TEXT) AS sequence FROM execution WHERE id=1").get() as { sequence: string }).sequence;
    const acknowledged = BigInt(ack) >= BigInt(sequence);
    const parts = entry?.kind === "user_message" || entry?.kind === "assistant_message" ? entry.content : entry?.kind === "tool_call" ? entry.output : [];
    const partIndex = nativeSlot?.index ?? (occurrence.partId === null ? parts.findIndex(part => (part.type === "image" || part.type === "image_unavailable") && part.imageId === occurrence.imageId) : -1);
    db.prepare("INSERT INTO image_occurrences(image_id,occurrence,native_source,source_sequence,acknowledged,part_index) VALUES(?,?,?,?,?,?)").run(occurrence.imageId, value, source, sequence, acknowledged ? 1 : 0, partIndex < 0 ? null : partIndex);
    botHistory?.reviseOccurrence(occurrence);
    return { occurrence, sourceSequence: sequence, acknowledged };
  });
  const getOnlineImageOccurrences = (): ImageOccurrence[] => read(() => {
    if (sessionContent.contentPolicy !== "task_body") return [];
    const result: ImageOccurrence[] = [];
    for (const row of db.prepare("SELECT occurrence FROM image_occurrences ORDER BY image_id").iterate() as Iterable<{ occurrence: string }>) {
      const occurrence = parseImageOccurrence(JSON.parse(row.occurrence));
      if (occurrence.container === "content") continue;
      // Capture attempts can still refer to a previously published position
      // after its tool entry changes. Its original identity lasts until archival.
      result.push(occurrence);
      if (result.length > 4096) throw new Error("Online image occurrence budget exceeded.");
    }
    return result;
  });
  const patchNativeImagePart = (input: ImageOccurrence, part: ImagePart | ImageUnavailablePart): TimelineEntry | null => atomic(() => {
    const occurrence = parseImageOccurrence(input);
    const row = db.prepare("SELECT occurrence,native_source FROM image_occurrences WHERE image_id=?").get(occurrence.imageId) as { occurrence: string; native_source: string | null } | undefined;
    if (!row || canonicalImageJson(JSON.parse(row.occurrence)) !== canonicalImageJson(occurrence) || part.imageId !== occurrence.imageId) throw new Error("Native image patch has no original committed occurrence.");
    const retired = retiredNativeSlot(occurrence, row.native_source === null ? null : parseNativeImageSource(JSON.parse(row.native_source)));
    if (retired) {
      if (canonicalImageJson(part) !== canonicalImageJson(retired.part)) throw new Error("Native image patch differs from its saved capture result.");
      if (part.type === "image") {
        const original = db.prepare("SELECT resource_id FROM native_input_publication_images WHERE image_id=?").get(occurrence.imageId) as { resource_id: string } | undefined;
        if (original && original.resource_id !== part.resourceId) throw new Error("Native image patch changed its original resource.");
        queueBotResourceRetirement(db, [part.resourceId]);
      }
      return null;
    }
    const entry = sessionContent.onlineTimeline.get(occurrence.entryId);
    const parts = entry?.kind === "user_message" || entry?.kind === "assistant_message" ? entry.content : entry?.kind === "tool_call" ? entry.output : null;
    if (!entry || !parts || occurrence.container !== (entry.kind === "tool_call" ? "tool_output" : "content") || occurrence.callId !== (entry.kind === "tool_call" ? entry.callId : null) || parts.filter(value => (value.type === "image" || value.type === "image_unavailable") && value.imageId === occurrence.imageId).length !== 1) throw new Error("Native image patch lost its original message position.");
    const updated = parts.map(value => (value.type === "image" || value.type === "image_unavailable") && value.imageId === occurrence.imageId ? part : value);
    projectTimeline(entry.kind === "tool_call" ? { ...entry, output: updated } : { ...entry, content: updated } as SourceTimelineEntry, true);
    return sessionContent.onlineTimeline.get(entry.entryId) ?? null;
  });
  return {
    usage,
    markdownStore,
    publishMarkdownProjection: (state: MarkdownProjectionState, entry: SourceTimelineEntry): ControllerOutboxEvent | null => atomic(() => {
      if (state.entryId !== entry.entryId || state.input.entryId !== entry.entryId || state.input.kind !== entry.kind) throw new Error("Markdown publication changed its entry identity.");
      if (botDisplayRetired(entry)) return null;
      markdownStore.put("projection", state.entryId, state);
      return projectTimeline(entry);
    }),
    shouldProjectBotMarkdown: (entry: SourceTimelineEntry): boolean => read(() => botHistory === null || (!botDisplayRetired(entry) && fitsBotMarkdown(entry))),
    botPreviewTruncated: (entryId: string): boolean => read(() => {
      const preview = botHistory?.identity(entryId)?.preview;
      return preview ? (JSON.parse(preview) as { truncated: boolean }).truncated : false;
    }),
    ...createNativeInputPublication({ db, ticket, content: sessionContent, read, assertUsable, quarantine, getSnapshot, getOperation, projectTimeline, associateInputMessage, publishTimelineSnapshot, registerImageOccurrence, retiredPosition: botRetiredImagePosition }),
    ...createNativeImageState(db, { read, write: atomic }),
    ...createImageHistorySource(file, db, sessionContent, { read, write: atomic }, { contentPolicy: () => sessionContent.contentPolicy, onlineImageOccurrences: getOnlineImageOccurrences, bounded: botHistory !== null }),
    ...createImageCaptureSource(db, { read, write: atomic }, getSnapshot, () => sessionContent.onlineTimeline, receipt => { botHistory?.observeCaptureReceipt(receipt); }),
    media,
    stopMedia: async (): Promise<void> => { await mediaInstance?.close(); },
    getSnapshot, patchSnapshot, getOperation, assertInputCapacity, assertUsable,
    patchNativeImagePart,
    applyNativeImageReceipt: (request: ImageCaptureRequest, receipt: ImageCaptureReceipt): void => atomic(() => {
      const source = request.nativeSource, occurrence = request.occurrence;
      if (!source || occurrence.partId !== null || receipt.captureId !== request.captureId || canonicalImageJson(receipt.occurrence) !== canonicalImageJson(occurrence)) throw new Error("Native image receipt differs from its original occurrence.");
      const captureRow = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(`capture:${request.captureId}`) as { value: string } | undefined;
      if (!captureRow) throw new Error("Native image receipt has no original capture.");
      const capture = JSON.parse(captureRow.value) as { request: ImageCaptureRequest; attemptId: string; receipt: ImageCaptureReceipt | null };
      if (capture.attemptId !== receipt.attemptId || canonicalImageJson(capture.receipt) !== canonicalImageJson(receipt)) return;
      const key = `native_provider:image-slot:${nativeEntryId(source.nativeSessionId, occurrence.sourceKey)}`;
      const stateRow = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(key) as { value: string } | undefined;
      if (!stateRow) throw new Error("Native image receipt has no original projection state.");
      const state = JSON.parse(stateRow.value) as NativeImageProjectionState;
      if (canonicalImageJson(state.request) !== canonicalImageJson(capture.request) || canonicalImageJson({ ...request, attemptId: state.request.attemptId }) !== canonicalImageJson(state.request)) throw new Error("Native image receipt changed its original request.");
      if (!Number.isSafeInteger(state.index) || state.index < 0) throw new Error("Native image projection position is corrupt.");
      const current = sessionContent.onlineTimeline.get(occurrence.entryId);
      const parts = current?.kind === "user_message" || current?.kind === "assistant_message" ? current.content : current?.kind === "tool_call" ? current.output : null;
      const existing = parts?.[state.index];
      if (!retiredNativeSlot(occurrence, source) && (!existing || (existing.type !== "image" && existing.type !== "image_unavailable") || existing.imageId !== occurrence.imageId)) throw new Error("Native image receipt lost its original slot.");
      if (receipt.state !== "committed" && receipt.state !== "failed") throw new Error("Native image receipt is not settled.");
      const label = state.part.label;
      const part: ImagePart | ImageUnavailablePart = receipt.state === "committed" && receipt.resourceId ? { type: "image", imageId: occurrence.imageId, resourceId: receipt.resourceId, label } : receipt.state === "failed" && receipt.error ? { type: "image_unavailable", imageId: occurrence.imageId, label, error: receipt.error } : (() => { throw new Error("Native image receipt has no terminal result."); })();
      const updated: NativeImageProjectionState = { ...state, attemptId: receipt.attemptId, phase: "settled", part, submission: null };
      delete updated.resumeReserved; delete updated.submissionRefusal;
      db.prepare("UPDATE image_runtime_state SET value=? WHERE key=?").run(JSON.stringify(updated), key);
      patchNativeImagePart(occurrence, part);
    }),
    providerImageCapabilities: (value: Omit<ProviderImageCapabilities, "revision">): ProviderImageCapabilities => atomic(() => {
      const row = db.prepare("SELECT value FROM image_runtime_state WHERE key='provider_images'").get() as { value: string } | undefined;
      const previous = row ? parseProviderImageCapabilities(JSON.parse(row.value)) : null;
      const candidate = parseProviderImageCapabilities({ ...value, revision: previous?.revision ?? "1" });
      const fingerprint = imageQualificationFingerprint(value);
      const priorFingerprint = db.prepare("SELECT value FROM image_runtime_state WHERE key='provider_images_qualification'").get() as { value: string } | undefined;
      if (previous && (priorFingerprint?.value ?? null) === fingerprint && canonicalImageJson(candidate) === canonicalImageJson(previous)) return previous;
      const next = { ...candidate, revision: previous ? String(BigInt(previous.revision) + 1n) : "1" };
      parseProviderImageCapabilities(next);
      db.prepare("INSERT INTO image_runtime_state VALUES('provider_images',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next));
      if (fingerprint === null) db.prepare("DELETE FROM image_runtime_state WHERE key='provider_images_qualification'").run();
      else db.prepare("INSERT INTO image_runtime_state VALUES('provider_images_qualification',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(fingerprint);
      return next;
    }),
    recordRelayHistory: (historyEpoch: string): void => atomic(() => {
      if (typeof historyEpoch !== "string" || !historyEpoch.isWellFormed() || !/[^\p{White_Space}]/u.test(historyEpoch) || historyEpoch.includes("\0") || Buffer.byteLength(historyEpoch) > 256) throw new Error("Invalid relay history epoch.");
      db.prepare("INSERT INTO image_runtime_state VALUES('history_epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(historyEpoch));
    }),
    getHistorySource: (): { historyEpoch: string | null; sourceThrough: string; acknowledgedThrough: string; projectionGap: boolean; archiveIncomplete: boolean } => read(() => {
      const row = db.prepare("SELECT CAST(last_sequence AS TEXT) AS sourceThrough,CAST(last_acknowledged AS TEXT) AS acknowledgedThrough,projection_gap,archive_incomplete FROM execution WHERE id=1").get() as { sourceThrough: string; acknowledgedThrough: string; projection_gap: string | null; archive_incomplete: number };
      const epoch = db.prepare("SELECT value FROM image_runtime_state WHERE key='history_epoch'").get() as { value: string } | undefined;
      return { historyEpoch: epoch ? JSON.parse(epoch.value) as string : null, sourceThrough: row.sourceThrough, acknowledgedThrough: row.acknowledgedThrough, projectionGap: row.projection_gap !== null, archiveIncomplete: row.archive_incomplete === 1 };
    }),
    recordHistoryCheckpoint: (checkpoint: { historyEpoch: string; sourceThrough: string }): void => atomic(() => {
      validSequence(checkpoint.sourceThrough);
      const epoch = db.prepare("SELECT value FROM image_runtime_state WHERE key='history_epoch'").get() as { value: string } | undefined;
      const row = db.prepare("SELECT CAST(last_sequence AS TEXT) AS sourceThrough,CAST(last_acknowledged AS TEXT) AS acknowledgedThrough,projection_gap,archive_incomplete FROM execution WHERE id=1").get() as { sourceThrough: string; acknowledgedThrough: string; projection_gap: string | null; archive_incomplete: number };
      if (!epoch || JSON.parse(epoch.value) !== checkpoint.historyEpoch || row.sourceThrough !== checkpoint.sourceThrough || row.acknowledgedThrough !== checkpoint.sourceThrough || row.projection_gap !== null || row.archive_incomplete !== 0) throw new Error("History checkpoint does not cover the complete acknowledged source.");
      db.prepare("INSERT INTO image_runtime_state VALUES('history_checkpoint',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(checkpoint));
    }),
    getHistoryCheckpoint: (): { historyEpoch: string; sourceThrough: string } | null => read(() => {
      const row = db.prepare("SELECT value FROM image_runtime_state WHERE key='history_checkpoint'").get() as { value: string } | undefined;
      return row ? JSON.parse(row.value) as { historyEpoch: string; sourceThrough: string } : null;
    }),
    ...localContent,
    getSourceFloor: (): string => read(() => (db.prepare("SELECT CAST(source_floor AS TEXT) AS sequence FROM execution WHERE id=1").get() as { sequence: string }).sequence),
    getLastSourceSequence: (): string => read(() => (db.prepare("SELECT CAST(last_sequence AS TEXT) AS sequence FROM execution WHERE id=1").get() as { sequence: string }).sequence),
    markProjectionGap: (reason: string): void => atomic(() => {
      if (typeof reason !== "string" || reason.trim() === "") throw new Error("Projection gap requires a reason.");
      // A single bounded marker survives outbox exhaustion and controller generations.
      let safeReason = "";
      for (const character of reason) {
        if (Buffer.byteLength(JSON.stringify({kind:"gap",payload:{reason:safeReason + character}})) > 256) break;
        safeReason += character;
      }
      db.prepare("UPDATE execution SET projection_gap=COALESCE(projection_gap,?),archive_incomplete=1 WHERE id=1").run(safeReason);
    }),
    drainProjectionGap: (): ControllerOutboxEvent | null => atomic(() => {
      const row = db.prepare("SELECT projection_gap AS reason FROM execution WHERE id=1").get() as {reason:string|null};
      if (row.reason === null) return null;
      const payload = {kind:"gap",payload:{reason:row.reason}};
      if (outboxBytes() + Buffer.byteLength(JSON.stringify(payload)) > maxOutboxBytes) return null;
      parseSourceEvent({sourceSeq:"1",...payload});
      const event = appendEvent(payload);
      db.prepare("UPDATE execution SET projection_gap=NULL WHERE id=1").run();
      return event;
    }),
    listOperations: (): ControllerOperation[] => read(() => (db.prepare("SELECT value FROM operations ORDER BY rowid").all() as { value: string }[]).map(row => json<ControllerOperation>(row.value))),
    listUnacknowledgedOperations: (limit = 100, afterOperationId?: string): ControllerOperation[] => read(() => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid operation reconciliation page size.");
      return (db.prepare("SELECT value FROM operations WHERE acknowledged=0 AND rowid > COALESCE((SELECT rowid FROM operations WHERE id=?),0) ORDER BY rowid LIMIT ?").all(afterOperationId ?? null, limit) as { value: string }[]).map(row => json<ControllerOperation>(row.value));
    }),
    markOperationAcknowledged: (id: string): void => atomic(() => { const operation = getOperation(id); if (operation === null) throw new Error("Cannot acknowledge an unknown operation."); if (["confirmed", "failed", "rejected", "expired"].includes(operation.state)) db.prepare("UPDATE operations SET acknowledged=1 WHERE id=?").run(id); }),
    getLastAcknowledgedSequence: (): string => read(() => (db.prepare("SELECT CAST(last_acknowledged AS TEXT) AS sequence FROM execution WHERE id=1").get() as { sequence: string }).sequence),
    getHistoryContentPolicy: (): SessionHistoryContentPolicy => sessionContent.contentPolicy,
    getOnlineMode: (): "legacy" | "relay" | null => read(() => {
      const row = db.prepare("SELECT online_mode FROM execution WHERE id=1").get() as { online_mode: "legacy" | "relay" | null };
      return row.online_mode;
    }),
    bindOnlineMode: (mode: "legacy" | "relay", policy: SessionHistoryContentPolicy | null): void => atomic(() => {
      const row = db.prepare("SELECT online_mode,history_content_policy FROM execution WHERE id=1").get() as { online_mode: "legacy" | "relay" | null; history_content_policy: SessionHistoryContentPolicy };
      if (row.online_mode !== null && row.online_mode !== mode) throw new Error("Controller online mode differs from the original execution.");
      if (policy !== null && policy !== row.history_content_policy) throw new Error("Controller history policy differs from the original execution.");
      if (mode === "relay" && policy === null) throw new Error("Relay requires a bound history content policy.");
      if (row.online_mode === null) db.prepare("UPDATE execution SET online_mode=? WHERE id=1").run(mode);
    }),
    getOnlineImageOccurrences,
    hasTimelineEntry: (entryId: string): boolean => read(() => botHistory?.identity(entryId) !== undefined || sessionContent.onlineTimeline.has(entryId)),
    getBotHistoryWindowRevision: (): string | null => read(() => botHistory?.revision() ?? null),
    readBotHistoryWindow: () => read(() => botHistory?.snapshot() ?? null),
    retireBotHistoryResources: (verifiedReferences?: ReadonlySet<string>): void => { if (botHistory !== null) retireBotResources(db, sessionContent, atomic, verifiedReferences); },
    getTimelineEntry: (entryId: string): TimelineEntry | undefined => read(() => sessionContent.onlineTimeline.get(entryId)),
    projectTimeline,
    saveTimelineHistory,
    associateInputMessage,
    prepareOperation: (input: Pick<ControllerOperation, "operationId" | "kind" | "payload"> & { intent?: SessionCommand }): ControllerOperation => atomic(() => {
      if (!/^[a-f0-9-]{36}$/.test(input.operationId)) throw new Error("Controller operation ID must be a UUID.");
      const images = input.kind === "send_message" && input.payload !== null && typeof input.payload === "object" && "content" in input.payload && Array.isArray(input.payload.content) && input.payload.content.some((part: unknown) => part !== null && typeof part === "object" && "type" in part && part.type === "image");
      if (images && input.intent === undefined) throw new Error("Image input requires the complete original operation intent.");
      const canonical = images ? canonicalSessionIntent(input.intent!) : null;
      const hashPayload = input.kind === "send_message" && input.payload && typeof input.payload === "object" && "origin" in input.payload && input.payload.origin === "user"
        ? (({ origin: _origin, ...payload }) => payload)(input.payload) : input.payload;
      const hash = canonical === null ? controllerPayloadHash({ kind: input.kind, payload: hashPayload }) : createHash("sha256").update(canonical).digest("hex"); const existing = getOperation(input.operationId);
      if (existing !== null) { if (existing.payloadHash !== hash) throw new Error("The operation ID has different content."); return existing; }
      if (input.kind === "initial" || input.kind === "send_message" || input.kind === "worker_input" || input.kind === "interaction_response" || input.kind === "execute_command" || input.kind === "update_setting") assertInputCapacity();
      if (canonical !== null) db.prepare("INSERT INTO input_intents VALUES(?,?,?)").run(input.operationId, canonical, hash);
      const { intent: _intent, ...operation } = input; void _intent;
      return writeOperation({ ...operation, executionGeneration: ticket.executionGeneration, payloadHash: hash, state: "accepted", result: null, error: null, createdAt: Date.now(), updatedAt: Date.now() });
    }),
    prepareRecoveredInitial: (previousTicket: ControllerLaunchTicket): ControllerOperation => atomic(() => {
      const { snapshot, operation } = recoverableInitialEvidence(db, ticket, previousTicket);
      if (snapshot.startup?.state !== "ready" || snapshot.activity !== "idle" || snapshot.currentTurnId !== null || !snapshot.capabilities.send
        || !["ready", "working"].includes(snapshot.lifecycle) || snapshot.nativeStopped || snapshot.stoppedAt !== null || snapshot.error !== null)
        throw new Error("Recovered initial input requires the original ready and idle native session.");
      if (operation === null) {
        assertInputCapacity();
        const payload = { text: ticket.initialPrompt };
        return writeOperation({ operationId: ticket.initialOperationId, kind: "initial", payload, payloadHash: controllerPayloadHash({ kind: "initial", payload }), executionGeneration: ticket.executionGeneration, state: "accepted", result: null, error: null, createdAt: Date.now(), updatedAt: Date.now() });
      }
      return operation.executionGeneration === ticket.executionGeneration ? operation : writeOperation({ ...operation, executionGeneration: ticket.executionGeneration, updatedAt: Date.now() });
    }),
    getInputIntent: (operationId: string): { canonical: string; sha256: string } | null => read(() => {
      const row = db.prepare("SELECT canonical,sha256 FROM input_intents WHERE operation_id=?").get(operationId) as { canonical: string; sha256: string } | undefined;
      return row ?? null;
    }),
    recordInputObservation: (input: InputObservation): boolean => atomic(() => {
      const observation = parseInputObservation(input), operation = getOperation(observation.operationId), snapshot = getSnapshot();
      const intent = db.prepare("SELECT sha256 FROM input_intents WHERE operation_id=?").get(observation.operationId) as { sha256: string } | undefined;
      if (!operation || !intent || intent.sha256 !== observation.intentSha256 || snapshot.nativeSessionId !== observation.nativeSessionId || ticket.provider !== observation.provider || !["dispatching", "unknown", "provider_accepted", "confirmed"].includes(operation.state)) return false;
      const previous = db.prepare("SELECT observation FROM input_observations WHERE operation_id=?").get(observation.operationId) as { observation: string } | undefined;
      const value = JSON.stringify(observation);
      if (previous && previous.observation !== value) throw new Error("Native input observation conflicts with its original operation.");
      if (operation.state === "confirmed") return previous !== undefined;
      if (!previous) db.prepare("INSERT INTO input_observations VALUES(?,?)").run(observation.operationId, value);
      return true;
    }),
    registerImageOccurrence,
    imageOccurrenceAcknowledged: (imageId: string): boolean => read(() => (db.prepare("SELECT acknowledged FROM image_occurrences WHERE image_id=?").get(imageId) as { acknowledged: number } | undefined)?.acknowledged === 1),
    markDispatching: (operationId: string): ControllerOperation => atomic(() => {
      const operation = getOperation(operationId); if (operation === null || operation.state !== "accepted") throw new Error("Controller operation cannot replay a possible native dispatch.");
      if (operation.kind === "initial") patchSnapshot({ initialInputState: "dispatching" });
      return writeOperation({ ...operation, state: "dispatching", updatedAt: Date.now() });
    }),
    recordOperation: (operationId: string, state: OperationState, result: unknown = null, error: string | null = null): ControllerOperation => atomic(() => {
      const operation = getOperation(operationId); if (operation === null) throw new Error("Controller operation is not registered.");
      if (["confirmed", "failed", "rejected", "expired"].includes(operation.state) && state !== operation.state) throw new Error("A terminal controller operation cannot be replaced.");
      if (state === "accepted" || state === "offered" || state === "dispatching") throw new Error("Use the durable dispatch boundary before native effects.");
      if (operation.kind === "initial") patchSnapshot({ initialInputState: state === "rejected" || state === "expired" ? "failed" : state });
      return writeOperation({ ...operation, state, result, error, updatedAt: Date.now() });
    }),
    disableOutboxWrites: (): void => { outboxWritesDisabled = true; },
    appendEvent,
    pendingEvents: (limit = 100): ControllerOutboxEvent[] => read(() => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid controller outbox page size.");
      return outbox.pending(null, limit).map((row) => ({ sequence: row.sequence, payload: json(row.value) }));
    }),
    bindSourceWire: (event: SourceEvent, live: boolean): SourceEvent => atomic(() => {
      assertOutboxWrites();
      const original = outbox.valueAt(BigInt(event.sourceSeq));
      if (original === undefined || JSON.stringify({ ...(JSON.parse(original) as object), sourceSeq: event.sourceSeq }) !== JSON.stringify(event)) throw new Error("Source wire event differs from its durable outbox.");
      return sourceWireEvent(db, event, live);
    }),
    acknowledgeEvents: (sequence: string): void => atomic(() => {
      assertOutboxWrites();
      const value = validSequence(sequence); const row = db.prepare("SELECT CAST(last_sequence AS TEXT) AS sequence FROM execution WHERE id=1").get() as { sequence: string };
      if (value > BigInt(row.sequence)) throw new Error("Controller ACK exceeds its durable event watermark.");
      outbox.acknowledgeThrough(value);
      clearSourceWireThrough(db, value);
      db.prepare("UPDATE image_occurrences SET acknowledged=1 WHERE CAST(source_sequence AS INTEGER)<=?").run(value);
      db.prepare("UPDATE execution SET last_acknowledged=MAX(last_acknowledged,?) WHERE id=1").run(value);
    }),
    close: (): void => {
      if (closed) return;
      try { if (quarantined) { closeSqliteDatabase(db, { file: sqliteDisplayFilename(db.name), format: controllerJournalFormat }, "unknown"); return; } closeJournal(db, sqliteDisplayFilename(db.name), () => { runSqliteImmediate(db, () => { assertCurrentSqlite(db, controllerJournalFormat); db.prepare("UPDATE execution SET owner_pid=NULL WHERE id=1 AND owner_pid=?").run(process.pid); }); }); }
      finally { closed = !db.open; }
    },
  };
  } catch (primary) {
    const outcome = initializationOutcome === "committed" ? "committed" : sqliteTransactionOutcome(primary);
    try { if (db.open) closeSqliteDatabase(db, { file, format: controllerJournalFormat }, outcome); }
    catch (cleanup) { throw new SqliteAccessError("cleanup-failed", { database: controllerJournalFormat.name, file, phase: "initialize-close" }, { cause: new AggregateError([primary, cleanup], "Controller journal initialization and shutdown failed."), outcome, connectionClosed: !db.open }); }
    if (initializationOutcome === "committed" || primary instanceof Database.SqliteError || primary instanceof SyntaxError || primary instanceof AggregateError || primary instanceof SqliteAccessError || outcome === "unknown" || outcome === "not-started") {
      throw new SqliteAccessError(primary instanceof SqliteAccessError ? primary.kind : "operation-failed", { database: controllerJournalFormat.name, file, phase: "initialize" }, { cause: primary, outcome, connectionClosed: !db.open });
    }
    throw primary;
  }
};

export const openControllerLifecycleStore = (file: string, ticket: ControllerLaunchTicket, options: ControllerLifecycleOptions = {}) => {
  parseLaunchTicket(ticket);
  const permit = options.storagePermit ?? acquireControllerStoragePermit(file);
  const owned = options.storagePermit === undefined;
  let store: ReturnType<typeof createControllerLifecycleStore>;
  try { store = createControllerLifecycleStore(file, ticket, options, permit); }
  catch (primary) {
    if (owned && (!(primary instanceof SqliteAccessError) || primary.connectionClosed)) {
      try { permit.release(); }
      catch (release) { throw new SqliteAccessError("cleanup-failed", { database: controllerJournalFormat.name, file, phase: "initialize-release" }, { cause: new AggregateError([primary, release], "Controller journal initialization and storage release failed."), outcome: primary instanceof SqliteAccessError ? primary.outcome : "not-started", connectionClosed: true }); }
    }
    throw primary;
  }
  let closed = false;
  return { ...store, close: (): void => {
    if (closed) return;
    store.close();
    if (owned) {
      try { permit.release(); }
      catch (cause) { throw new SqliteAccessError("cleanup-failed", { database: controllerJournalFormat.name, file, phase: "release" }, { cause, outcome: "committed", connectionClosed: true }); }
    }
    closed = true;
  } };
};
export type ControllerLifecycleStore = ReturnType<typeof openControllerLifecycleStore>;

/** Recovery reads may upgrade the format without acquiring a native writer. */
export const readControllerSnapshot = (file: SqliteDatabaseSource, permit?: ControllerStoragePermit): ControllerSnapshot | null => readSqliteDatabase({
  ...controllerJournalReadOptions(file, permit), onMissing: () => null,
}, db => {
  const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string } | undefined;
  return row === undefined ? null : checkedSnapshot(json<ControllerSnapshot>(row.snapshot));
});

type ControllerStopRow = { snapshot: ControllerSnapshot; rawSnapshot: string; ticketHash: string; ownerPid: number | null };
const readControllerStopRow = (file: string, deadline?: number, strictReadOnly = false, permit?: ControllerStoragePermit, historicalTicketHash?: string, allowPreviousFormat = false): ControllerStopRow | null => {
  const read = (db: Database.Database, historyAvailable = true): ControllerStopRow | null => {
    if (historicalTicketHash !== undefined) {
      if (!historyAvailable) return null;
      const historical = db.prepare("SELECT snapshot,ticket_hash FROM stopped_generations WHERE ticket_hash=?").get(historicalTicketHash) as { snapshot: string; ticket_hash: string } | undefined;
      if (historical === undefined) return null;
      const snapshot = checkedSnapshot(json<ControllerSnapshot>(historical.snapshot));
      if (isLinuxControllerLaunch(snapshot.controllerProcess)) {
        // A ticket-bound complete stop is immutable. A current row for the
        // same generation must still be that settled state; a later writer
        // may coexist with the receipt only in the same execution lineage.
        const current = db.prepare("SELECT snapshot,ticket_hash,owner_pid FROM execution WHERE id=1").get() as { snapshot: string; ticket_hash: string; owner_pid: number | null } | undefined;
        if (current === undefined) throw new Error("Controller stopped history has no current execution evidence.");
        const value = checkedSnapshot(json<ControllerSnapshot>(current.snapshot));
        if (current.ticket_hash === historical.ticket_hash) {
          if (current.owner_pid !== null || controllerPayloadHash(value) !== controllerPayloadHash(snapshot)) throw new Error("Controller stopped history conflicts with its current generation.");
        } else if (value.executionId !== snapshot.executionId || value.sessionId !== snapshot.sessionId || value.claimId !== snapshot.claimId || value.testExecutionId !== snapshot.testExecutionId
          || typeof value.executionGeneration !== "string" || !/^[1-9][0-9]{0,18}$/.test(value.executionGeneration)
          || BigInt(value.executionGeneration) <= BigInt(snapshot.executionGeneration)) throw new Error("Controller stopped history conflicts with its current execution lineage.");
      }
      return { snapshot, rawSnapshot: historical.snapshot, ticketHash: historical.ticket_hash, ownerPid: null };
    }
    const row = db.prepare("SELECT snapshot,ticket_hash,owner_pid FROM execution WHERE id=1").get() as { snapshot: string; ticket_hash: string; owner_pid: number | null } | undefined;
    return row === undefined ? null : { snapshot: checkedSnapshot(json<ControllerSnapshot>(row.snapshot)), rawSnapshot: row.snapshot, ticketHash: row.ticket_hash, ownerPid: row.owner_pid };
  };
  if (deadline === undefined && !strictReadOnly) return readSqliteDatabase({ ...controllerJournalReadOptions(file, permit), onMissing: () => null }, read);
  const remaining = () => {
    if (deadline === undefined) return 5000;
    if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new Error("Invalid controller stop deadline.");
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("Controller stop recording exceeded its deadline.");
    return Math.min(5000, left);
  };
  try {
    remaining();
    if (!path.isAbsolute(file)) throw new TypeError("The SQLite database path must be absolute.");
    if (sqliteDatabaseIsMissing(file)) { remaining(); return null; }
    const db = new Database(sqliteFilename(file), { readonly: true, fileMustExist: true, timeout: remaining() });
    let result: ControllerStopRow | null = null;
    closeJournal(db, file, () => {
      db.pragma(`busy_timeout = ${remaining()}`); remaining();
      result = db.transaction(() => {
        remaining();
        const source = allowPreviousFormat ? inspectReadCompatibleControllerJournal(db) : inspectSqlite(db, controllerJournalFormat);
        if (!allowPreviousFormat && source.kind !== "current") throw new Error("Controller stop recording requires the current journal format.");
        db.pragma(`busy_timeout = ${remaining()}`);
        const row = read(db, source.version >= 17); remaining(); return row;
      }).deferred();
    }, "not-started");
    remaining(); return result;
  } catch (cause) {
    if (deadline !== undefined && Date.now() >= deadline && !(cause instanceof Error && /deadline/.test(cause.message))) {
      const failure = new AggregateError([cause, new Error("Controller stop recording exceeded its deadline.")], "Controller stop observation failed at its deadline.", { cause });
      if (cause instanceof SqliteAccessError) throw new SqliteAccessError(cause.kind, cause.context, { cause: failure, outcome: cause.outcome, connectionClosed: cause.connectionClosed });
      throw failure;
    }
    throw cause;
  }
};

const isValidNativeProcessProof = (proof: ProcessProof): boolean => proof !== null && typeof proof === "object" && Number.isSafeInteger(proof.pid) && proof.pid > 0 && proof.pid <= 2_147_483_647 && Number.isSafeInteger(proof.parentPid) && proof.parentPid >= 0 && (proof.processGroupId === null || Number.isSafeInteger(proof.processGroupId) && proof.processGroupId > 0) && isProcessBirth(proof.startedAt) && typeof proof.commandHash === "string" && /^[a-f0-9]{64}$/.test(proof.commandHash) && (proof.jobObjectName === undefined || typeof proof.jobObjectName === "string" && proof.jobObjectName.trim() !== "" && !proof.jobObjectName.includes("\0"));
const isValidLegacyControllerProof = (proof: unknown): boolean => !hasLinuxLaunchKind(proof) && isValidNativeProcessProof(proof as ProcessProof);
const validateControllerSnapshot = (value: ControllerSnapshot, ticket: ControllerLaunchTicket, ticketHash: string): ControllerSnapshot => {
    if (value === null || typeof value !== "object" || Array.isArray(value) || ticketHash !== controllerPayloadHash(ticket)
      || value.executionId !== ticket.executionId || value.sessionId !== ticket.sessionId || value.claimId !== ticket.claimId || value.testExecutionId !== ticket.testExecutionId
      || value.executionGeneration !== ticket.executionGeneration || value.controllerInstanceId !== ticket.controllerInstanceId
      || !["starting", "ready", "working", "stopping", "stopped", "paused", "failed"].includes(value.lifecycle)
      || !["initializing", "idle", "working", "waiting_input", "stopped", "unknown"].includes(value.activity)
      || !["not_required", "not_submitted", "dispatching", "provider_accepted", "confirmed", "failed", "unknown"].includes(value.initialInputState)
      || !(value.nativeSessionId === null || typeof value.nativeSessionId === "string" && value.nativeSessionId.trim() !== "" && value.nativeSessionId.isWellFormed())
      || !(value.controllerProcess === null || isLinuxControllerLaunch(value.controllerProcess) && value.controllerProcess.launchId === ticket.launchId
        || isValidLegacyControllerProof(value.controllerProcess)) || !Array.isArray(value.nativeProcesses) || !value.nativeProcesses.every(isValidNativeProcessProof)
      || typeof value.nativeStopped !== "boolean" || !(value.stoppedAt === null || typeof value.stoppedAt === "string" && Number.isFinite(Date.parse(value.stoppedAt)))
      || !(value.error === null || typeof value.error === "string") || !(value.currentTurnId === null || typeof value.currentTurnId === "string")
      || value.capabilities === null || typeof value.capabilities !== "object" || ["send", "steer", "cancel", "respond"].some(key => typeof value.capabilities[key as keyof SessionCapabilities] !== "boolean")) throw new Error("Controller current journal conflicts with its original ticket or snapshot format.");
    return value;
};

type RecoverableInitialEvidence = { snapshot: ControllerSnapshot; operation: ControllerOperation | null; previousTicket: ControllerLaunchTicket };
const stoppedTicketInventory = new Map<string, string>();
const validateStoppedInitialTicket = (ticket: ControllerLaunchTicket, previousTicket: ControllerLaunchTicket, row: { snapshot: string; ticket_hash: string }): ControllerSnapshot => {
  parseLaunchTicket(previousTicket);
  const previous = validateControllerSnapshot(checkedSnapshot(json<ControllerSnapshot>(row.snapshot)), previousTicket, row.ticket_hash);
  if (previousTicket.claimId !== ticket.claimId || previousTicket.projectId !== ticket.projectId || previousTicket.taskId !== ticket.taskId
    || previousTicket.workerId !== ticket.workerId || previousTicket.worktreeId !== ticket.worktreeId || previousTicket.userId !== ticket.userId
    || previousTicket.serverOrigin !== ticket.serverOrigin || previousTicket.executionId !== ticket.executionId || previousTicket.controllerId !== ticket.controllerId
    || previousTicket.sessionId !== ticket.sessionId || previousTicket.provider !== ticket.provider || previousTicket.cwd !== ticket.cwd
    || previousTicket.nativeHome !== ticket.nativeHome || previousTicket.initialOperationId !== ticket.initialOperationId || previousTicket.initialPrompt !== ticket.initialPrompt
    || previousTicket.resumeNativeSessionId !== null && previousTicket.resumeNativeSessionId !== ticket.resumeNativeSessionId)
    throw new Error("Recovered initial input conflicts with the original stopped ticket.");
  if (!/^[a-f0-9]{64}$/.test(row.ticket_hash) || previous.controllerInstanceId === ticket.controllerInstanceId
    || previous.nativeSessionId !== ticket.resumeNativeSessionId || previous.initialInputState !== "not_submitted"
    || previous.lifecycle !== "stopped" || previous.nativeStopped !== true || previous.controllerProcess === null || !Array.isArray(previous.nativeProcesses)
    || typeof previous.stoppedAt !== "string" || !Number.isFinite(Date.parse(previous.stoppedAt)))
    throw new Error("Recovered initial input conflicts with the preceding stopped generation.");
  if (process.platform === "win32") validateWindowsStoredStopProof(previous, row.ticket_hash);
  return previous;
};
// The stopped receipt and input row are read together. Neither a live snapshot
// nor an absent operation alone proves that an earlier writer never dispatched.
const recoverableInitialEvidence = (db: Database.Database, ticket: ControllerLaunchTicket, previousTicket: ControllerLaunchTicket): RecoverableInitialEvidence => {
  if (ticket.claimId === undefined || BigInt(ticket.executionGeneration) <= 1n || ticket.resumeNativeSessionId === null)
    throw new Error("Recovered initial input requires a managed later generation and original native binding.");
  const owner = db.prepare("SELECT snapshot,ticket_hash FROM execution WHERE id=1").get() as { snapshot: string; ticket_hash: string } | undefined;
  if (!owner) throw new Error("Original controller journal evidence is unavailable.");
  const snapshot = validateControllerSnapshot(checkedSnapshot(json<ControllerSnapshot>(owner.snapshot)), ticket, owner.ticket_hash);
  if (snapshot.nativeSessionId !== ticket.resumeNativeSessionId || snapshot.initialInputState !== "not_submitted")
    throw new Error("Recovered initial input conflicts with the original native binding or delivery state.");
  const rows = db.prepare("SELECT snapshot,ticket_hash FROM stopped_generations WHERE json_extract(snapshot,'$.executionGeneration')=?").all(String(BigInt(ticket.executionGeneration) - 1n)) as { snapshot: string; ticket_hash: string }[];
  if (rows.length !== 1) throw new Error("Recovered initial input lacks a unique preceding stopped generation.");
  validateStoppedInitialTicket(ticket, previousTicket, rows[0]!);
  const operations = (db.prepare("SELECT value FROM operations WHERE json_extract(value,'$.kind')='initial'").all() as { value: string }[]).map(row => json<ControllerOperation>(row.value));
  if (operations.length > 1 || operations.some(operation => operation.operationId !== ticket.initialOperationId))
    throw new Error("Recovered initial input conflicts with another original operation.");
  const row = db.prepare("SELECT value FROM operations WHERE id=?").get(ticket.initialOperationId) as { value: string } | undefined;
  const operation = row === undefined ? null : json<ControllerOperation>(row.value);
  const payload = { text: ticket.initialPrompt };
  if (operation !== null && (operation.operationId !== ticket.initialOperationId || operation.kind !== "initial" || operation.state !== "accepted"
    || operation.payloadHash !== controllerPayloadHash({ kind: "initial", payload }) || controllerPayloadHash(operation.payload) !== controllerPayloadHash(payload)
    || operation.result !== null || operation.error !== null || typeof operation.executionGeneration !== "string"
    || !/^[1-9][0-9]*$/.test(operation.executionGeneration) || BigInt(operation.executionGeneration) > BigInt(ticket.executionGeneration)))
    throw new Error("Recovered initial operation is inconsistent or may already have been dispatched.");
  return { snapshot, operation, previousTicket };
};

/** Read the stopped boundary and original input without taking ownership or migrating the journal. */
export const readRecoverableInitialInput = async (file: string, ticket: ControllerLaunchTicket, home: string, deadline?: number, storageStateDirectory?: string): Promise<RecoverableInitialEvidence> => {
  const remaining = () => {
    const time = deadline === undefined ? 5000 : deadline - Date.now();
    if (time <= 0) throw new Error("Recovered initial input observation exceeded its deadline.");
    return Math.max(1, Math.min(5000, time));
  };
  const db = new Database(sqliteFilename(file), { readonly: true, fileMustExist: true, timeout: remaining() });
  let stopHash!: string;
  closeJournal(db, file, () => { stopHash = db.transaction(() => {
    inspectReadCompatibleControllerJournal(db);
    const owner = db.prepare("SELECT snapshot,ticket_hash FROM execution WHERE id=1").get() as { snapshot: string; ticket_hash: string } | undefined;
    if (!owner) throw new Error("Original controller journal evidence is unavailable.");
    validateControllerSnapshot(checkedSnapshot(json<ControllerSnapshot>(owner.snapshot)), ticket, owner.ticket_hash);
    const rows = db.prepare("SELECT ticket_hash FROM stopped_generations WHERE json_extract(snapshot,'$.executionGeneration')=?").all(String(BigInt(ticket.executionGeneration) - 1n)) as { ticket_hash: string }[];
    if (rows.length !== 1) throw new Error("Recovered initial input lacks a unique preceding stopped generation.");
    remaining(); return rows[0]!.ticket_hash;
  }).deferred(); }, "not-started");
  const directory = path.dirname(controllerTicketPath(home, ticket.launchId, storageStateDirectory));
  const cacheKey = `${directory}\0${stopHash}`;
  const cached = stoppedTicketInventory.get(cacheKey);
  let previousTicket: ControllerLaunchTicket | undefined;
  if (cached !== undefined) {
    try {
      const candidate = await readLaunchTicket(home, cached, storageStateDirectory);
      if (controllerPayloadHash(candidate) === stopHash) previousTicket = candidate;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  if (!previousTicket) {
  const names = await readdir(directory);
  if (names.length > 20_000) throw new Error("Controller launch inventory exceeds its safe bound.");
  for (const name of names) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    remaining();
    let preliminary: unknown;
    try {
      const source = path.join(directory, name), metadata = await lstat(source);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_TICKET_BYTES) continue;
      preliminary = JSON.parse(await readFile(source, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (preliminary === null || typeof preliminary !== "object" || !("executionId" in preliminary) || preliminary.executionId !== ticket.executionId) continue;
    let candidate: ControllerLaunchTicket;
    try { candidate = await readLaunchTicket(home, name.slice(0, -5), storageStateDirectory); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") continue; throw error; }
    if (controllerPayloadHash(candidate) === stopHash) {
      previousTicket = candidate;
      if (stoppedTicketInventory.size >= 64) stoppedTicketInventory.delete(stoppedTicketInventory.keys().next().value!);
      stoppedTicketInventory.set(cacheKey, candidate.launchId);
      break;
    }
  }
  }
  if (!previousTicket) throw new Error("Recovered initial input lacks the preceding stopped ticket.");
  const reread = new Database(sqliteFilename(file), { readonly: true, fileMustExist: true, timeout: remaining() });
  let result!: RecoverableInitialEvidence;
  closeJournal(reread, file, () => { result = reread.transaction(() => {
    inspectReadCompatibleControllerJournal(reread);
    const evidence = recoverableInitialEvidence(reread, ticket, previousTicket!); remaining(); return evidence;
  }).deferred(); }, "not-started");
  return result;
};

const readValidatedControllerSnapshot = (file: string, ticket: ControllerLaunchTicket, deadline: number | undefined, allowPreviousFormat: boolean): ControllerSnapshot => {
  try {
    const row = readControllerStopRow(file, deadline, true, undefined, undefined, allowPreviousFormat);
    if (row === null) throw new Error("Original controller journal evidence is unavailable.");
    const value = validateControllerSnapshot(row.snapshot, ticket, row.ticketHash);
    if (deadline !== undefined && Date.now() >= deadline) throw new Error("Controller stop recording exceeded its deadline.");
    return value;
  } catch (cause) {
    if (deadline !== undefined && Date.now() >= deadline && !(cause instanceof Error && /deadline/.test(cause.message))) throw new AggregateError([cause, new Error("Controller stop recording exceeded its deadline.")], "Controller journal observation failed at its deadline.", { cause });
    throw cause;
  }
};

/** Read the current journal without migration and verify its original ticket fence. */
export const readCurrentControllerSnapshot = (file: string, ticket: ControllerLaunchTicket, deadline?: number): ControllerSnapshot => readValidatedControllerSnapshot(file, ticket, deadline, false);

/** Read a validated v16–v19 or current snapshot without modifying protected or retained evidence. */
export const readCompatibleControllerSnapshot = (file: string, ticket: ControllerLaunchTicket, deadline?: number): ControllerSnapshot => readValidatedControllerSnapshot(file, ticket, deadline, true);

/** Immutable launch attempts can share a generation; only the journal's exact ticket owns its snapshot. */
export const readCurrentControllerInventorySnapshot = (file: string, tickets: readonly ControllerLaunchTicket[], deadline: number): { ticket: ControllerLaunchTicket; snapshot: ControllerSnapshot } | null => {
  const row = readControllerStopRow(file, deadline, true, undefined, undefined, true);
  if (row === null) return null;
  const ticket = tickets.find(candidate => controllerPayloadHash(candidate) === row.ticketHash);
  if (ticket === undefined) throw new Error("Original Controller journal generation has no matching inventory ticket.");
  const snapshot = validateControllerSnapshot(row.snapshot, ticket, row.ticketHash);
  if (Date.now() >= deadline) throw new Error("Controller journal inventory observation exceeded its deadline.");
  return { ticket, snapshot };
};

/** Hashes bind durable evidence for consistency; they are not authentication against a local writer. */
export const validateWindowsStoredStopProof = (snapshot: ControllerSnapshot, ticketHash: string): void => {
  const marker = snapshot?.windowsJobStopProof;
  if (marker === undefined) throw new Error("Windows Job stop proof is unavailable; complete process-tree stop is unconfirmed.");
  if (marker === null || typeof marker !== "object" || Array.isArray(marker) || Object.keys(marker).sort().join() !== "snapshotHash,ticketHash,version"
    || marker.version !== 1 || typeof marker.ticketHash !== "string" || !/^[a-f0-9]{64}$/.test(marker.ticketHash)
    || typeof marker.snapshotHash !== "string" || !/^[a-f0-9]{64}$/.test(marker.snapshotHash)) throw new Error("Windows Job stop proof format is invalid.");
  const { windowsJobStopProof: _marker, ...original } = snapshot;
  if (marker.ticketHash !== ticketHash || marker.snapshotHash !== controllerPayloadHash(original)
    || snapshot.lifecycle !== "stopped" || snapshot.nativeStopped !== true || typeof snapshot.stoppedAt !== "string" || !Number.isFinite(Date.parse(snapshot.stoppedAt))
    || snapshot.controllerProcess === null || isLinuxControllerLaunch(snapshot.controllerProcess) || typeof snapshot.controllerProcess?.jobObjectName !== "string" || !/^Local\\Daynight-[0-9a-f-]{36}$/.test(snapshot.controllerProcess.jobObjectName) || !Array.isArray(snapshot.nativeProcesses)) throw new Error("Windows Job stop proof conflicts with its original ticket or snapshot.");
};

export const validateWindowsControllerStopProof = (snapshot: ControllerSnapshot, ticket: ControllerLaunchTicket, ticketHash: string): void => {
  validateWindowsStoredStopProof(snapshot, ticketHash);
  if (ticketHash !== controllerPayloadHash(ticket)
    || snapshot.executionId !== ticket.executionId || snapshot.sessionId !== ticket.sessionId || snapshot.claimId !== ticket.claimId || snapshot.testExecutionId !== ticket.testExecutionId
    || snapshot.executionGeneration !== ticket.executionGeneration || snapshot.controllerInstanceId !== ticket.controllerInstanceId
    || snapshot.controllerProcess == null || isLinuxControllerLaunch(snapshot.controllerProcess) || snapshot.controllerProcess.jobObjectName !== `Local\\Daynight-${ticket.launchId}`) throw new Error("Windows Job stop proof conflicts with its original ticket or snapshot.");
};

const retainStoppedGeneration = (db: Database.Database, ticketHash: string, snapshot: ControllerSnapshot): void => {
  if (!/^[a-f0-9]{64}$/.test(ticketHash) || snapshot.lifecycle !== "stopped" || !snapshot.nativeStopped || snapshot.controllerProcess === null
    || snapshot.stoppedAt === null || !Number.isFinite(Date.parse(snapshot.stoppedAt))) throw new Error("Controller stopped generation evidence is incomplete.");
  if (process.platform === "win32") validateWindowsStoredStopProof(snapshot, ticketHash);
  const previous = db.prepare("SELECT snapshot FROM stopped_generations WHERE ticket_hash=?").get(ticketHash) as { snapshot: string } | undefined;
  if (previous !== undefined) {
    if (controllerPayloadHash(JSON.parse(previous.snapshot)) !== controllerPayloadHash(snapshot)) throw new Error("Controller stopped generation receipt conflicts with its original evidence.");
    return;
  }
  db.prepare("INSERT INTO stopped_generations(ticket_hash,snapshot) VALUES(?,?)").run(ticketHash, JSON.stringify(snapshot));
};

/** Historical receipts retain the exact stopped boundary after recovery replaces the current writer. */
export const readHistoricalWindowsStoppedControllerGeneration = (file: string, ticket: ControllerLaunchTicket, deadline: number): ControllerSnapshot | null => {
  const row = readControllerStopRow(file, deadline, true, undefined, controllerPayloadHash(ticket), true);
  if (row === null) return null;
  validateControllerSnapshot(row.snapshot, ticket, row.ticketHash);
  validateWindowsControllerStopProof(row.snapshot, ticket, row.ticketHash);
  if (Date.now() >= deadline) throw new Error("Controller stopped generation observation exceeded its deadline.");
  return row.snapshot;
};

/** Recover the exact prior ticket's stopped boundary without migrating the journal. */
export const readHistoricalStoppedControllerGeneration = (file: string, ticket: ControllerLaunchTicket, deadline: number): ControllerSnapshot | null => {
  const row = readControllerStopRow(file, deadline, true, undefined, controllerPayloadHash(ticket), true);
  if (row === null) return null;
  const snapshot = validateControllerSnapshot(row.snapshot, ticket, row.ticketHash);
  if (snapshot.lifecycle !== "stopped" || !snapshot.nativeStopped || snapshot.controllerProcess === null || snapshot.stoppedAt === null || !Number.isFinite(Date.parse(snapshot.stoppedAt)))
    throw new Error("Original historical Controller stopped boundary is incomplete.");
  if (process.platform === "win32") validateWindowsControllerStopProof(snapshot, ticket, row.ticketHash);
  if (Date.now() >= deadline) throw new Error("Controller stopped generation observation exceeded its deadline.");
  return snapshot;
};

export const readProvenWindowsStoppedControllerGeneration = (file: string, ticket: ControllerLaunchTicket, deadline?: number): ControllerSnapshot => {
  try {
    const row = readControllerStopRow(file, deadline, true, undefined, undefined, true);
    if (row === null) throw new Error("Original controller stop evidence is unavailable.");
    validateWindowsControllerStopProof(row.snapshot, ticket, row.ticketHash);
    if (deadline !== undefined && Date.now() >= deadline) throw new Error("Controller stop recording exceeded its deadline.");
    return row.snapshot;
  } catch (cause) {
    if (deadline !== undefined && Date.now() >= deadline && !(cause instanceof Error && /deadline/.test(cause.message))) throw new AggregateError([cause, new Error("Controller stop recording exceeded its deadline.")], "Windows stop proof observation failed at its deadline.", { cause });
    throw cause;
  }
};

/** Only an independent worker may commit complete process-tree stop after the writer exits. */
export type ControllerStopOptions = { permit?: ControllerStoragePermit; signal?: AbortSignal; deadline?: number; jobLease?: ControllerJobLease };
const recordStoppedWithPermit = async (file: string, ticket: ControllerLaunchTicket, options: ControllerStopOptions, permit: ControllerStoragePermit): Promise<ControllerSnapshot> => {
  assertControllerStoragePermit(permit, file);
  const { deadline, jobLease: lease } = options;

  const remaining = (): number => {
    if (deadline === undefined) return 5000;
    if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new Error("Invalid controller stop deadline.");
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("Controller stop recording exceeded its deadline.");
    return Math.min(5000, left);
  };
  const failedAtDeadline = (cause: unknown, outcome: "not-started" | "committed" | "rolled-back" | "unknown", connectionClosed: boolean): never => {
    if (deadline !== undefined && Date.now() >= deadline) {
      const failure = new AggregateError([cause, new Error("Controller stop recording exceeded its deadline.")], "Controller stop recording failed at its deadline.", { cause });
      throw new SqliteAccessError("cleanup-failed", { database: controllerJournalFormat.name, file, phase: "stop-deadline" }, { cause: failure, outcome, connectionClosed });
    }
    throw cause;
  };
  remaining();
  if (sqliteDatabaseIsMissing(file)) throw new Error("Original controller stop evidence is unavailable.");
  const inspection = new Database(sqliteFilename(file), { readonly: true, fileMustExist: true, timeout: remaining() });
  let needsUpgrade = false;
  closeJournal(inspection, file, () => { needsUpgrade = inspection.transaction(() => inspectSqlite(inspection, controllerJournalFormat).kind !== "current").deferred(); }, "not-started");
  if (needsUpgrade) {
    upgradeControllerJournal(file, permit, { ...(deadline === undefined ? {} : { deadline }) });
  }
  remaining();
  let observedRow: ControllerStopRow | null = null;
  try { observedRow = readControllerStopRow(file, deadline, true, permit); }
  catch (error) { failedAtDeadline(error, "not-started", error instanceof SqliteAccessError ? error.connectionClosed : true); }
  const observed = observedRow?.snapshot ?? null;
  const ticketHash = controllerPayloadHash(ticket);
  if (observed === null || observed.executionId !== ticket.executionId || observed.claimId !== ticket.claimId || observed.testExecutionId !== ticket.testExecutionId || observed.sessionId !== ticket.sessionId) throw new Error("Original controller stop evidence is unavailable.");
  const history = hasLinuxLaunchKind(observed.controllerProcess) || observedRow!.ticketHash !== ticketHash
    ? readControllerStopRow(file, deadline, true, permit, ticketHash) : null;
  if (history !== null && hasLinuxLaunchKind(history.snapshot.controllerProcess)) {
    const stopped = validateControllerSnapshot(history.snapshot, ticket, history.ticketHash);
    if (stopped.lifecycle !== "stopped" || !stopped.nativeStopped || stopped.stoppedAt === null) throw new Error("Controller stopped generation receipt conflicts with its original evidence.");
    if (observedRow!.ticketHash === ticketHash) {
      if (observedRow!.ownerPid !== null || controllerPayloadHash(stopped) !== controllerPayloadHash(observed)) throw new Error("Controller stopped generation receipt conflicts with its original evidence.");
    } else if (!/^[1-9][0-9]*$/.test(observed.executionGeneration) || BigInt(observed.executionGeneration) <= BigInt(ticket.executionGeneration)) throw new Error("Controller stopped generation receipt conflicts with its current execution.");
    remaining();
    return stopped;
  }
  if (observed.controllerProcess === null || observed.executionGeneration !== ticket.executionGeneration || observed.controllerInstanceId !== ticket.controllerInstanceId) throw new Error("Original controller stop evidence is unavailable.");
  if (observedRow!.ticketHash !== ticketHash || observed.sessionId !== ticket.sessionId) throw new Error("Original controller stop ticket conflicts with its journal.");
  if (hasLinuxLaunchKind(observed.controllerProcess)) {
    validateControllerSnapshot(observed, ticket, observedRow!.ticketHash);
    if (history !== null) {
      const stopped = validateControllerSnapshot(history.snapshot, ticket, history.ticketHash);
      if (observedRow!.ownerPid !== null || stopped.lifecycle !== "stopped" || !stopped.nativeStopped || stopped.stoppedAt === null
        || controllerPayloadHash(stopped) !== controllerPayloadHash(observed)) throw new Error("Controller stopped generation receipt conflicts with its original evidence.");
      remaining();
      return stopped;
    }
  }
  if (process.platform === "win32" && observed.windowsJobStopProof !== undefined) {
    try {
      validateWindowsControllerStopProof(observed, ticket, observedRow!.ticketHash); remaining();
      const db = new Database(sqliteFilename(file), { fileMustExist: true, ...(deadline === undefined ? {} : { timeout: remaining() }) });
      closeJournal(db, file, () => runSqliteImmediate(db, () => {
        remaining(); assertCurrentSqlite(db, controllerJournalFormat);
        const row = db.prepare("SELECT snapshot,ticket_hash,owner_pid FROM execution WHERE id=1").get() as { snapshot: string; ticket_hash: string; owner_pid: number | null };
        if (row.snapshot !== observedRow!.rawSnapshot || row.ticket_hash !== ticketHash || row.owner_pid !== observedRow!.ownerPid) throw new Error("The controller state changed during stop verification.");
        retainStoppedGeneration(db, ticketHash, observed); remaining();
      }));
      if (deadline !== undefined && Date.now() >= deadline) throw new SqliteAccessError("cleanup-failed", { database: controllerJournalFormat.name, file, phase: "stop-deadline" }, { outcome: "committed", connectionClosed: true, cause: new Error("Controller stop recording exceeded its deadline after commit.") });
      return observed;
    }
    catch (error) { return failedAtDeadline(error, error instanceof SqliteAccessError ? error.outcome : sqliteTransactionOutcome(error), error instanceof SqliteAccessError ? error.connectionClosed : true); }
  }
  if (process.platform === "win32" && lease === undefined) throw new Error("Windows Job stop proof and original Job lease are unavailable; complete process-tree stop is unconfirmed.");
  if (!await (lease === undefined ? confirmControllerProcessesStopped(observed.controllerProcess, observed.nativeProcesses, deadline) : confirmControllerProcessesStopped(observed.controllerProcess, observed.nativeProcesses, deadline, lease))) throw new Error("The original controller or its descendants are still running.");
  let db: Database.Database;
  try { db = new Database(sqliteFilename(file), { fileMustExist: true, ...(deadline === undefined ? {} : { timeout: remaining() }) }); }
  catch (error) { return failedAtDeadline(error, "not-started", true); }
  let stopped: ControllerSnapshot | undefined;
  try {
    closeJournal(db, file, () => {
      remaining();
      if (deadline !== undefined) db.pragma(`busy_timeout = ${remaining()}`);
      remaining();
      stopped = runSqliteImmediate(db, () => {
        remaining();
        assertCurrentSqlite(db, controllerJournalFormat);
        const row = db.prepare("SELECT snapshot,ticket_hash,owner_pid FROM execution WHERE id=1").get() as { snapshot: string; ticket_hash: string; owner_pid: number | null };
        if (row.snapshot !== observedRow!.rawSnapshot || row.ticket_hash !== ticketHash || row.owner_pid !== observedRow!.ownerPid) throw new Error("The controller state changed during stop verification.");
        const value: ControllerSnapshot = { ...observed, lifecycle: "stopped", nativeStopped: true, stoppedAt: observed.stoppedAt ?? new Date().toISOString(), activity: "stopped", capabilities: { send: false, steer: false, cancel: false, respond: false } };
        if (process.platform === "win32") {
          value.windowsJobStopProof = { version: 1, ticketHash, snapshotHash: controllerPayloadHash(value) };
          validateWindowsControllerStopProof(value, ticket, row.ticket_hash);
        }
        db.prepare("UPDATE execution SET snapshot=?,owner_pid=NULL WHERE id=1").run(JSON.stringify(value));
        retainStoppedGeneration(db, ticketHash, value);
        if (deadline !== undefined) db.pragma(`busy_timeout = ${remaining()}`);
        remaining();
        return value;
      });
    });
  } catch (error) { failedAtDeadline(error, error instanceof SqliteAccessError ? error.outcome : sqliteTransactionOutcome(error), error instanceof SqliteAccessError ? error.connectionClosed : true); }
  if (deadline !== undefined && Date.now() >= deadline) throw new SqliteAccessError("cleanup-failed", { database: controllerJournalFormat.name, file, phase: "stop-deadline" }, { outcome: "committed", connectionClosed: true, cause: new Error("Controller stop recording exceeded its deadline after commit.") });
  return stopped!;
};

/** The original storage owner remains held across process verification and the compare-and-commit. */
export const recordStoppedControllerGeneration = async (file: string, ticket: ControllerLaunchTicket, options: ControllerStopOptions): Promise<ControllerSnapshot> => {
  if (sqliteDatabaseIsMissing(file)) throw new Error("Original controller stop evidence is unavailable.");
  const permit = options.permit ?? acquireControllerStoragePermit(file, options.deadline);
  const owned = options.permit === undefined;
  let result: ControllerSnapshot | undefined, failure: unknown, failed = false;
  try { result = await recordStoppedWithPermit(file, ticket, options, permit); }
  catch (cause) { failed = true; failure = cause; }
  if (owned && (!(failure instanceof SqliteAccessError) || failure.connectionClosed)) {
    try { permit.release(); }
    catch (release) { throw new SqliteAccessError("cleanup-failed", { database: controllerJournalFormat.name, file, phase: "stop-release" }, { cause: failed ? new AggregateError([failure, release], "Controller stop recording and storage release failed.") : release, outcome: failed ? failure instanceof SqliteAccessError ? failure.outcome : "not-started" : "committed", connectionClosed: true }); }
  }
  if (failed) throw failure;
  if (options.deadline !== undefined && Date.now() >= options.deadline) throw new SqliteAccessError("cleanup-failed", { database: controllerJournalFormat.name, file, phase: "stop-deadline" }, { outcome: "committed", connectionClosed: true, cause: new Error("Controller stop recording exceeded its deadline after storage release.") });
  return result!;
};
export const readControllerOperation = (file: SqliteDatabaseSource, operationId: string, permit?: ControllerStoragePermit): ControllerOperation | null => readSqliteDatabase({
  ...controllerJournalReadOptions(file, permit),
  onMissing: (): ControllerOperation | null => { throw new Error("The controller journal does not exist."); },
}, db => {
  const row = db.prepare("SELECT value FROM operations WHERE id=?").get(operationId) as { value: string } | undefined;
  return row === undefined ? null : json<ControllerOperation>(row.value);
});

/** Live observations must not acquire migration ownership from the original Controller. */
export const readCompatibleControllerOperation = (file: string, ticket: ControllerLaunchTicket, operationId: string, deadline?: number): ControllerOperation | null => {
  const remaining = () => {
    const time = deadline === undefined ? 5000 : deadline - Date.now();
    if (time <= 0) throw new Error("Controller operation observation exceeded its deadline.");
    return Math.max(1, Math.min(5000, time));
  };
  const db = new Database(sqliteFilename(file), { readonly: true, fileMustExist: true, timeout: remaining() });
  let result: ControllerOperation | null = null;
  closeJournal(db, file, () => {
    result = db.transaction(() => {
      inspectReadCompatibleControllerJournal(db);
      const owner = db.prepare("SELECT snapshot,ticket_hash FROM execution WHERE id=1").get() as { snapshot: string; ticket_hash: string } | undefined;
      if (owner === undefined) throw new Error("Original controller journal evidence is unavailable.");
      validateControllerSnapshot(checkedSnapshot(json<ControllerSnapshot>(owner.snapshot)), ticket, owner.ticket_hash);
      const row = db.prepare("SELECT value FROM operations WHERE id=?").get(operationId) as { value: string } | undefined;
      remaining();
      return row === undefined ? null : json<ControllerOperation>(row.value);
    }).deferred();
  }, "not-started");
  return result;
};
