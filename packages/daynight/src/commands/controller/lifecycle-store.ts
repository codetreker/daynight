import { createNativeInputPublication } from "./media/native-publication.js";
import { createImageCaptureSource } from "./media/capture-source.js";
import { createMarkdownSourceStore } from "./markdown/store.js";
import type { MarkdownProjectionState } from "./markdown/projection.js";
import { createNativeImageState } from "./media/native-state.js";
import { controllerMetadataBudget } from "./media/metadata-budget.js";
import { createImageHistorySource } from "./media/history-source.js";
import { openControllerMediaStore, type ControllerMediaStore } from "./media/preparations.js";
import type { ImageDecoder } from "./media/image-decoder.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalSessionIntent, parseImageOccurrence, parseNativeImageSource, parseInputObservation, type ImageOccurrence, type ImagePart, type ImageUnavailablePart, type NativeImageSource, type InputObservation, parseProviderImageCapabilities, canonicalImageJson, type ProviderImageCapabilities } from "../../session/image-values.js";
import type { SessionCommand, TimelineEntry } from "../../session/protocol.js";
import { parseStartupObservation, type StartupObservation } from "../../session/startup.js";
import { sessionDisplayEntry } from "./wire-display.js";
import type { SessionControls } from "../../session/controls.js";
import Database from "better-sqlite3";
import { openSessionContent, type SessionContent } from "./content/session-content.js";
import { assertNoOrphanTimelineSource } from "./content/migration.js";
import { closeSqliteDatabase, openSqliteDatabase, readSqliteDatabase, runSqliteImmediate, sqliteDatabaseIsMissing, sqliteTransactionOutcome, type SqliteMigrationReporter, type SqliteDatabaseSource } from "../../platform/sqlite-access.js";
import { assertCurrentSqlite, inspectSqlite } from "../../platform/sqlite-format.js";
import { SqliteAccessError, type SqliteOutcome } from "../../platform/sqlite-error.js";
import { controllerJournalFormat } from "./journal-format.js";
import { openControllerOutbox, withOutboxTransactionOutcome } from "./outbox-store.js";
import { acquireControllerStoragePermit, assertControllerStoragePermit, type ControllerStoragePermit } from "./storage-lock.js";
import { controllerJournalReadOptions, controllerJournalWriteOptions, controllerTimelineCleanupPending, prepareControllerStorage } from "./storage-preparation.js";
import { controllerStorageMediaUsage, reserveControllerStoragePeak } from "./storage-capacity.js";
import { createLocalSessionContent } from "./local-content.js";
import { chmodSync, existsSync } from "node:fs";
import { sessionBinding, type SessionBinding, type InitialInputState, type OperationState, type SessionCapabilities } from "../../session/protocol.js";
import { controllerPayloadHash, parseLaunchTicket, type ControllerLaunchTicket } from "./launch-ticket.js";
import { parseSourceEvent, type SourceTimelineEntry } from "../../session/controller-protocol.js";
import { confirmControllerProcessesStopped, type ProcessProof } from "./process-proof.js";
import type { ControllerJobLease } from "./windows-job.js";
export type ControllerSnapshot = SessionBinding & {
  executionId: string; sessionId: string; executionGeneration: string; controllerInstanceId: string;
  lifecycle: "starting" | "ready" | "working" | "stopping" | "stopped" | "paused" | "failed";
  nativeSessionId: string | null; initialInputState: InitialInputState;
  activity: "initializing" | "idle" | "working" | "waiting_input" | "stopped" | "unknown";
  currentTurnId: string | null; capabilities: SessionCapabilities; controls?: SessionControls; controlsRevisionFloor?: string; turnStartedAt?: string | null;
  controllerProcess: ProcessProof | null; nativeProcesses: readonly ProcessProof[];
  nativeStopped: boolean; stoppedAt: string | null; error: string | null; startup?: StartupObservation;
  windowsJobStopProof?: { readonly version: 1; readonly ticketHash: string; readonly snapshotHash: string };
};
export type ControllerOperation = {
  executionGeneration?: string;
  operationId: string; kind: "initial" | "cleanup" | "send_message" | "cancel" | "interaction_response" | "update_setting" | "execute_command" | "refresh_controls";
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
type ControllerLifecycleOptions = { maxOutboxBytes?: number; contentOwnedLocally?: boolean; onMigration?: SqliteMigrationReporter; database?: Database.Database; mediaStateDirectory?: string; imageDecoder?: ImageDecoder; storagePermit?: ControllerStoragePermit; controllerProcess?: ProcessProof };
const createControllerLifecycleStore = (file: string, ticket: ControllerLaunchTicket, options: ControllerLifecycleOptions, permit: ControllerStoragePermit) => {
  assertControllerStoragePermit(permit, file);
  const maxOutboxBytes = options.maxOutboxBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxOutboxBytes) || maxOutboxBytes < 256) throw new Error("Invalid controller outbox capacity.");
  parseLaunchTicket(ticket);
  const initial: ControllerSnapshot = { executionId: ticket.executionId, ...sessionBinding(ticket), sessionId: ticket.sessionId, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: "starting", nativeSessionId: ticket.resumeNativeSessionId, initialInputState: ticket.initialInput === "none" ? "not_required" : "not_submitted", activity: "initializing", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, controllerProcess: options.controllerProcess ?? null, nativeProcesses: [], nativeStopped: false, stoppedAt: null, error: null, startup: { state: "starting", reasonCode: "initializing" } };
  let sessionContent!: SessionContent;
  let db!: Database.Database;
  let metadataBudget!: ReturnType<typeof controllerMetadataBudget>;
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
  let reservedContentCeiling = 0;
  const reserveContent = (additionalBytes: number, contentGrowth: number): void => {
    metadataBudget.assert(additionalBytes, true, contentGrowth);
    if (db.memory) return;
    const current = metadataBudget.reservationCeiling(), next = metadataBudget.reservationCeiling(contentGrowth);
    if (next <= reservedContentCeiling && current === reservedContentCeiling) return;
    const media = controllerStorageMediaUsage(file, db);
    reserveControllerStoragePeak(file, options.mediaStateDirectory ?? path.dirname(file), ticket.executionId, media.reservedBytes + next, Math.max(0, media.reservedBytes - media.actualBytes) + additionalBytes);
    reservedContentCeiling = next;
  };
  const assertTimelineWrite = (additionalBytes: number, contentGrowth = 0): void => {
    assertUsable();
    assertControllerStoragePermit(permit, file);
    if (writeDepth === 0 || !db.inTransaction) throw new Error("SQL timeline publication requires the original Controller write transaction.");
    if (additionalBytes > 0) reserveContent(additionalBytes, contentGrowth);
  };
  db = openSqliteDatabase({ ...controllerJournalWriteOptions(file, permit, options.mediaStateDirectory ?? path.dirname(file), ticket.executionId, undefined, options.onMigration), file: options.database ?? file, allowCreate: true,
    onReady: (connection) => {
      db = connection;
      metadataBudget = controllerMetadataBudget(file, db);
      if (controllerTimelineCleanupPending(db)) throw new Error("Controller timeline maintenance must finish before writer initialization.");
      if (!db.memory) chmodSync(file, 0o600);
      const existing = db.prepare("SELECT ticket_hash, owner_pid, snapshot FROM execution WHERE id=1").get() as { ticket_hash: string; owner_pid: number | null; snapshot: string } | undefined;
      if (existing === undefined) {
        assertNoOrphanTimelineSource(file);
        db.prepare("INSERT INTO execution(id,ticket_hash,owner_pid,snapshot) VALUES(1,?,?,?)").run(controllerPayloadHash(ticket), process.pid, JSON.stringify(initial));
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
      if (existing !== undefined && !existsSync(`${file}.pending-content/manifest.json`)) throw new Error("Pending archive source is missing.");
      sessionContent = openSessionContent(file, ticket.sessionId, db, { read, assertWrite: assertTimelineWrite });
      if (existing === undefined && (sessionContent.timeline.totals().entryCount !== 0 || sessionContent.resourceFiles.resources.size !== 0)) throw new Error("Pending archive source has no original controller execution.");
    },
  });
  try {
  const outbox = openControllerOutbox(db, { assertWrite: () => { assertOutboxWrites(); assertTimelineWrite(0); } });
  const markdownStore = createMarkdownSourceStore(db, { read, write: atomic }, metadataBudget);
  const getSnapshot = (): ControllerSnapshot => read(() => checkedSnapshot(json((db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string }).snapshot)));
  const getOperation = (operationId: string): ControllerOperation | null => read(() => { const row = db.prepare("SELECT value FROM operations WHERE id=?").get(operationId) as { value: string } | undefined; return row === undefined ? null : json(row.value); });
  const writeOperation = (operation: ControllerOperation): ControllerOperation => { metadataBudget.assert(Buffer.byteLength(JSON.stringify(operation)) + 16384, operation.state !== "accepted"); db.prepare("INSERT INTO operations(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,acknowledged=0").run(operation.operationId, JSON.stringify(operation)); return operation; };
  const patchSnapshot = (patch: Partial<Omit<ControllerSnapshot, "executionId" | "claimId" | "testExecutionId" | "sessionId" | "executionGeneration" | "controllerInstanceId" | "windowsJobStopProof">>): ControllerSnapshot => atomic(() => {
    metadataBudget.assert(16384, true);
    const current = getSnapshot();
    if (Object.hasOwn(patch, "windowsJobStopProof") || current.windowsJobStopProof !== undefined) throw new Error("A completed Windows Job stop proof cannot be patched by the Controller.");
    if (Object.keys(patch).some((key) => ["executionId", "claimId", "testExecutionId", "sessionId", "executionGeneration", "controllerInstanceId"].includes(key))) throw new Error("Controller identity cannot change within a generation.");
    if (current.nativeSessionId !== null && patch.nativeSessionId !== undefined && patch.nativeSessionId !== current.nativeSessionId) throw new Error("The original native session cannot be replaced.");
    const value = checkedSnapshot({ ...current, ...patch }); db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(value)); return value;
  });
  const outboxBytes = (): number => read(() => outbox.byteLength());
  const assertInputCapacity = (): void => { assertUsable(); metadataBudget.assert(); if (!options.contentOwnedLocally && outboxBytes() >= maxOutboxBytes * 0.8) throw new Error("Controller outbox capacity reached; native input is paused until durable events are acknowledged."); };
  const localContent = createLocalSessionContent(sessionContent, ticket.sessionId, { read, write: atomic });
  const appendEvent = (payload: unknown): ControllerOutboxEvent => atomic(() => {
    assertOutboxWrites();
    if (options.contentOwnedLocally && payload && typeof payload === "object" && "kind" in payload && payload.kind === "resource" && "payload" in payload) {
      const event = parseSourceEvent({ sourceSeq: "1", ...payload });
      if (event.kind === "resource") localContent.saveResource(event.payload);
    }
    const encoded = JSON.stringify(payload);
    assertOutboxWrites();
    if (encoded !== undefined) metadataBudget.assert(Buffer.byteLength(encoded) + 16384, true);
    if (encoded === undefined) throw new Error("Controller event must be serializable.");
    if (outboxBytes() + Buffer.byteLength(encoded) > maxOutboxBytes) {
      if (!options.contentOwnedLocally) throw new Error("Controller outbox capacity exceeded; event was not discarded.");
      // Content is already committed in the local projection. Only transport
      // replay is discarded; the next connection must hydrate from local data.
      outbox.clear();
      db.prepare("UPDATE execution SET source_floor=last_sequence WHERE id=1").run();
    }
    const row = db.prepare("UPDATE execution SET last_sequence=last_sequence+1 WHERE id=1 RETURNING CAST(last_sequence AS TEXT) AS sequence").get() as { sequence: string };
    if (options.contentOwnedLocally && Buffer.byteLength(encoded) > maxOutboxBytes) db.prepare("UPDATE execution SET source_floor=last_sequence WHERE id=1").run();
    else outbox.append(BigInt(row.sequence), encoded);
    return { sequence: row.sequence, payload };
  });
  let closed = false;
  let mediaInstance: ControllerMediaStore | undefined;
  const media = () => { assertUsable(); return mediaInstance ??= openControllerMediaStore(file, ticket, db, sessionContent.resourceFiles, { read, write: atomic }, getSnapshot, options.imageDecoder, options.mediaStateDirectory); };
  const projectTimeline = (entry: SourceTimelineEntry): ControllerOutboxEvent | null => atomic(() => {
    const source = db.prepare("SELECT origin FROM input_message_origins WHERE entry_id=?").get(entry.entryId) as { origin: "user" | "daynight" } | undefined;
    if (source) {
      if (entry.kind !== "user_message" || entry.origin !== undefined && entry.origin !== source.origin) throw new Error("Timeline update changed its original input origin.");
      entry = { ...entry, origin: source.origin };
    }
    metadataBudget.assert(Buffer.byteLength(JSON.stringify(entry)) * 2 + 16384, true);
    const { revision: ignored, entrySeq: ignoredSequence, ...content } = entry;
    void ignored; void ignoredSequence;
    const originals = db.prepare("SELECT i.image_id,i.resource_id,i.part_index FROM native_input_publication_images i JOIN native_input_publications p ON p.operation_id=i.operation_id WHERE json_extract(p.value,'$.receipt.identity.entryId')=?").all(entry.entryId) as { image_id: string; resource_id: string; part_index: number }[];
    for (const original of originals) {
      const part = entry.kind === "user_message" ? entry.content[original.part_index] : undefined;
      if (!part || part.type !== "image" && part.type !== "image_unavailable" || part.imageId !== original.image_id || part.type === "image" && part.resourceId !== original.resource_id) throw new Error("Timeline update cannot move or replace a committed original image association.");
    }
    const contentHash = controllerPayloadHash(content);
    const previous = sessionContent.timeline.get(entry.entryId);
    const previousContent = previous ? (({ revision, entrySeq, ...value }) => { void revision; void entrySeq; return value; })(previous) : null;
    if (previousContent !== null && controllerPayloadHash(previousContent) === contentHash) return null;
    const revision = String(previous === undefined ? 1n : BigInt(previous.revision) + 1n);
    const entrySeq = previous?.entrySeq ?? sessionContent.timeline.nextSequence();
    const payload = { ...content, revision, ...(options.contentOwnedLocally ? { entrySeq } : {}) } as SourceTimelineEntry;
    parseSourceEvent({ sourceSeq: "1", kind: "timeline_upsert", payload });
    const durableEntry = { ...payload, entrySeq } as import("../../session/protocol.js").TimelineEntry;
    sessionContent.timeline.save(durableEntry);
    return appendEvent({ kind: "timeline_upsert", payload: options.contentOwnedLocally ? sessionDisplayEntry(payload) : payload });
  });
  const associateInputMessage = (operationId: string, nativeSessionId: string, entryId: string): string => atomic(() => {
    const operation = getOperation(operationId);
    if (operation?.kind !== "send_message" || !operation.payload || typeof operation.payload !== "object" || !("origin" in operation.payload)) return entryId;
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
    const current = sessionContent.timeline.get(entryId);
    if (current && current.kind !== "user_message") throw new Error("Native input cannot replace another timeline kind.");
    if (!existing) {
      metadataBudget.assert(Buffer.byteLength(entryId + operationId + origin) + 16384, true);
      db.prepare("INSERT INTO input_message_origins VALUES(?,?,?)").run(entryId, operationId, origin);
    }
    if (current) projectTimeline(current);
    return entryId;
  });
  const publishTimelineSnapshot = (entry: TimelineEntry): ControllerOutboxEvent => atomic(() => {
    const current = sessionContent.timeline.get(entry.entryId);
    if (!current || controllerPayloadHash(current) !== controllerPayloadHash(entry)) throw new Error("Timeline publication requires its current committed content.");
    const { entrySeq, ...content } = entry;
    const payload = options.contentOwnedLocally ? { ...content, entrySeq } : content;
    parseSourceEvent({ sourceSeq: "1", kind: "timeline_upsert", payload });
    return appendEvent({ kind: "timeline_upsert", payload: options.contentOwnedLocally ? sessionDisplayEntry(payload) : payload });
  });
  const registerImageOccurrence = (input: ImageOccurrence, native: NativeImageSource | null): { occurrence: ImageOccurrence; sourceSequence: string; acknowledged: boolean } => atomic(() => {
    metadataBudget.assert(Buffer.byteLength(JSON.stringify(input)) + 16384, true);
    const occurrence = parseImageOccurrence(input), nativeSource = native === null ? null : parseNativeImageSource(native);
    if (nativeSource && (nativeSource.provider !== ticket.provider || nativeSource.nativeSessionId !== getSnapshot().nativeSessionId)) throw new Error("Image occurrence belongs to another native session.");
    const entry = sessionContent.timeline.get(occurrence.entryId);
    if (!entry || occurrence.container === "tool_output" && (entry.kind !== "tool_call" || entry.callId !== occurrence.callId) || occurrence.container === "reasoning" && entry.kind !== "reasoning" || occurrence.container === "content" && !["user_message", "assistant_message"].includes(entry.kind)) throw new Error("Image occurrence has no durable original position.");
    const value = JSON.stringify(occurrence), source = nativeSource === null ? null : JSON.stringify(nativeSource);
    const previous = db.prepare("SELECT occurrence,native_source,source_sequence,acknowledged FROM image_occurrences WHERE image_id=?").get(occurrence.imageId) as { occurrence: string; native_source: string | null; source_sequence: string; acknowledged: number } | undefined;
    if (previous) {
      if (previous.occurrence !== value || previous.native_source !== source) throw new Error("Image occurrence cannot move from its original source.");
      return { occurrence, sourceSequence: previous.source_sequence, acknowledged: previous.acknowledged === 1 };
    }
    const sequence = (db.prepare("SELECT CAST(last_sequence AS TEXT) AS sequence FROM execution WHERE id=1").get() as { sequence: string }).sequence;
    const ack = (db.prepare("SELECT CAST(last_acknowledged AS TEXT) AS sequence FROM execution WHERE id=1").get() as { sequence: string }).sequence;
    const acknowledged = BigInt(ack) >= BigInt(sequence);
    db.prepare("INSERT INTO image_occurrences VALUES(?,?,?,?,?)").run(occurrence.imageId, value, source, sequence, acknowledged ? 1 : 0);
    return { occurrence, sourceSequence: sequence, acknowledged };
  });
  return {
    markdownStore,
    publishMarkdownProjection: (state: MarkdownProjectionState, entry: SourceTimelineEntry): ControllerOutboxEvent | null => atomic(() => {
      if (state.entryId !== entry.entryId || state.input.entryId !== entry.entryId || state.input.kind !== entry.kind) throw new Error("Markdown publication changed its entry identity.");
      markdownStore.put("projection", state.entryId, state);
      return projectTimeline(entry);
    }),
    ...createNativeInputPublication({ db, ticket, content: sessionContent, read, assertUsable, quarantine, getSnapshot, getOperation, projectTimeline, associateInputMessage, publishTimelineSnapshot, registerImageOccurrence, metadataBudget }),
    ...createNativeImageState(db, { read, write: atomic }, metadataBudget),
    ...createImageHistorySource(file, db, sessionContent, { read, write: atomic }, reserveContent),
    ...createImageCaptureSource(db, { read, write: atomic }, getSnapshot, metadataBudget),
    media,
    stopMedia: async (): Promise<void> => { await mediaInstance?.close(); },
    getSnapshot, patchSnapshot, getOperation, assertInputCapacity, assertUsable,
    patchNativeImagePart: (input: ImageOccurrence, part: ImagePart | ImageUnavailablePart): TimelineEntry => atomic(() => {
      const occurrence = parseImageOccurrence(input);
      const row = db.prepare("SELECT occurrence FROM image_occurrences WHERE image_id=?").get(occurrence.imageId) as { occurrence: string } | undefined;
      if (!row || canonicalImageJson(JSON.parse(row.occurrence)) !== canonicalImageJson(occurrence) || part.imageId !== occurrence.imageId) throw new Error("Native image patch has no original committed occurrence.");
      const entry = sessionContent.timeline.get(occurrence.entryId);
      const parts = entry?.kind === "user_message" || entry?.kind === "assistant_message" ? entry.content : entry?.kind === "tool_call" ? entry.output : null;
      if (!entry || !parts || occurrence.container !== (entry.kind === "tool_call" ? "tool_output" : "content") || occurrence.callId !== (entry.kind === "tool_call" ? entry.callId : null) || parts.filter(value => (value.type === "image" || value.type === "image_unavailable") && value.imageId === occurrence.imageId).length !== 1) throw new Error("Native image patch lost its original message position.");
      const updated = parts.map(value => (value.type === "image" || value.type === "image_unavailable") && value.imageId === occurrence.imageId ? part : value);
      projectTimeline(entry.kind === "tool_call" ? { ...entry, output: updated } : { ...entry, content: updated } as SourceTimelineEntry);
      return sessionContent.timeline.get(entry.entryId)!;
    }),
    providerImageCapabilities: (value: Omit<ProviderImageCapabilities, "revision">): ProviderImageCapabilities => atomic(() => {
      const row = db.prepare("SELECT value FROM image_runtime_state WHERE key='provider_images'").get() as { value: string } | undefined;
      const previous = row ? parseProviderImageCapabilities(JSON.parse(row.value)) : null;
      const candidate = parseProviderImageCapabilities({ ...value, revision: previous?.revision ?? "1" });
      if (previous && canonicalImageJson(candidate) === canonicalImageJson(previous)) return previous;
      const next = { ...candidate, revision: previous ? String(BigInt(previous.revision) + 1n) : "1" };
      parseProviderImageCapabilities(next);
      db.prepare("INSERT INTO image_runtime_state VALUES('provider_images',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next));
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
    hasTimelineEntry: (entryId: string): boolean => read(() => sessionContent.timeline.has(entryId)),
    getTimelineEntry: (entryId: string): TimelineEntry | undefined => read(() => sessionContent.timeline.get(entryId)),
    projectTimeline,
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
      metadataBudget.assert(Buffer.byteLength(JSON.stringify(input)) * 2 + 16384);
      if (input.kind === "initial" || input.kind === "send_message" || input.kind === "interaction_response" || input.kind === "execute_command" || input.kind === "update_setting") assertInputCapacity();
      if (canonical !== null) db.prepare("INSERT INTO input_intents VALUES(?,?,?)").run(input.operationId, canonical, hash);
      const { intent: _intent, ...operation } = input; void _intent;
      return writeOperation({ ...operation, executionGeneration: ticket.executionGeneration, payloadHash: hash, state: "accepted", result: null, error: null, createdAt: Date.now(), updatedAt: Date.now() });
    }),
    getInputIntent: (operationId: string): { canonical: string; sha256: string } | null => read(() => {
      const row = db.prepare("SELECT canonical,sha256 FROM input_intents WHERE operation_id=?").get(operationId) as { canonical: string; sha256: string } | undefined;
      return row ?? null;
    }),
    recordInputObservation: (input: InputObservation): boolean => atomic(() => {
      metadataBudget.assert(Buffer.byteLength(JSON.stringify(input)) + 16384, true);
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
    acknowledgeEvents: (sequence: string): void => atomic(() => {
      assertOutboxWrites();
      const value = validSequence(sequence); const row = db.prepare("SELECT CAST(last_sequence AS TEXT) AS sequence FROM execution WHERE id=1").get() as { sequence: string };
      if (value > BigInt(row.sequence)) throw new Error("Controller ACK exceeds its durable event watermark.");
      outbox.acknowledgeThrough(value);
      db.prepare("UPDATE image_occurrences SET acknowledged=1 WHERE CAST(source_sequence AS INTEGER)<=?").run(value);
      db.prepare("UPDATE execution SET last_acknowledged=MAX(last_acknowledged,?) WHERE id=1").run(value);
    }),
    close: (): void => {
      if (closed) return;
      try { if (quarantined) { closeSqliteDatabase(db, { file: db.name, format: controllerJournalFormat }, "unknown"); return; } closeJournal(db, db.name, () => { runSqliteImmediate(db, () => { assertCurrentSqlite(db, controllerJournalFormat); db.prepare("UPDATE execution SET owner_pid=NULL WHERE id=1 AND owner_pid=?").run(process.pid); }); }); }
      finally { closed = !db.open; }
    },
  };
  } catch (primary) {
    try { if (db.open) closeSqliteDatabase(db, { file, format: controllerJournalFormat }, "committed"); }
    catch (cleanup) { throw new SqliteAccessError("cleanup-failed", { database: controllerJournalFormat.name, file, phase: "initialize-close" }, { cause: new AggregateError([primary, cleanup], "Controller journal initialization and shutdown failed."), outcome: "committed", connectionClosed: !db.open }); }
    throw new SqliteAccessError("migration-failed", { database: controllerJournalFormat.name, file, phase: "initialize" }, { cause: primary, outcome: "committed", connectionClosed: true });
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
const readControllerStopRow = (file: string, deadline?: number, strictReadOnly = false, permit?: ControllerStoragePermit): ControllerStopRow | null => {
  const read = (db: Database.Database): ControllerStopRow | null => {
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
    const db = new Database(file, { readonly: true, fileMustExist: true, timeout: remaining() });
    let result: ControllerStopRow | null = null;
    closeJournal(db, file, () => {
      db.pragma(`busy_timeout = ${remaining()}`); remaining();
      result = db.transaction(() => {
        remaining();
        const source = inspectSqlite(db, controllerJournalFormat);
        if (source.kind !== "current") throw new Error("Controller stop recording requires the current journal format.");
        db.pragma(`busy_timeout = ${remaining()}`);
        const row = read(db); remaining(); return row;
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

/** Read the current journal without migration and verify its original ticket fence. */
export const readCurrentControllerSnapshot = (file: string, ticket: ControllerLaunchTicket, deadline?: number): ControllerSnapshot => {
  try {
    const row = readControllerStopRow(file, deadline, true);
    if (row === null) throw new Error("Original controller journal evidence is unavailable.");
    const value = row.snapshot;
    const processProof = (proof: ProcessProof): boolean => proof !== null && typeof proof === "object" && Number.isSafeInteger(proof.pid) && proof.pid > 0 && proof.pid <= 2_147_483_647 && Number.isSafeInteger(proof.parentPid) && proof.parentPid >= 0 && (proof.processGroupId === null || Number.isSafeInteger(proof.processGroupId) && proof.processGroupId > 0) && typeof proof.startedAt === "string" && proof.startedAt.trim() !== "" && typeof proof.commandHash === "string" && /^[a-f0-9]{64}$/.test(proof.commandHash) && (proof.jobObjectName === undefined || typeof proof.jobObjectName === "string" && proof.jobObjectName.trim() !== "" && !proof.jobObjectName.includes("\0"));
    if (value === null || typeof value !== "object" || Array.isArray(value) || row.ticketHash !== controllerPayloadHash(ticket)
      || value.executionId !== ticket.executionId || value.sessionId !== ticket.sessionId || value.claimId !== ticket.claimId || value.testExecutionId !== ticket.testExecutionId
      || value.executionGeneration !== ticket.executionGeneration || value.controllerInstanceId !== ticket.controllerInstanceId
      || !["starting", "ready", "working", "stopping", "stopped", "paused", "failed"].includes(value.lifecycle)
      || !["initializing", "idle", "working", "waiting_input", "stopped", "unknown"].includes(value.activity)
      || !["not_required", "not_submitted", "dispatching", "provider_accepted", "confirmed", "failed", "unknown"].includes(value.initialInputState)
      || !(value.nativeSessionId === null || typeof value.nativeSessionId === "string" && value.nativeSessionId.trim() !== "" && value.nativeSessionId.isWellFormed())
      || !(value.controllerProcess === null || processProof(value.controllerProcess)) || !Array.isArray(value.nativeProcesses) || !value.nativeProcesses.every(processProof)
      || typeof value.nativeStopped !== "boolean" || !(value.stoppedAt === null || typeof value.stoppedAt === "string" && Number.isFinite(Date.parse(value.stoppedAt)))
      || !(value.error === null || typeof value.error === "string") || !(value.currentTurnId === null || typeof value.currentTurnId === "string")
      || value.capabilities === null || typeof value.capabilities !== "object" || ["send", "steer", "cancel", "respond"].some(key => typeof value.capabilities[key as keyof SessionCapabilities] !== "boolean")) throw new Error("Controller current journal conflicts with its original ticket or snapshot format.");
    if (deadline !== undefined && Date.now() >= deadline) throw new Error("Controller stop recording exceeded its deadline.");
    return value;
  } catch (cause) {
    if (deadline !== undefined && Date.now() >= deadline && !(cause instanceof Error && /deadline/.test(cause.message))) throw new AggregateError([cause, new Error("Controller stop recording exceeded its deadline.")], "Controller journal observation failed at its deadline.", { cause });
    throw cause;
  }
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
    || snapshot.controllerProcess === null || typeof snapshot.controllerProcess?.jobObjectName !== "string" || !/^Local\\Daynight-[0-9a-f-]{36}$/.test(snapshot.controllerProcess.jobObjectName) || !Array.isArray(snapshot.nativeProcesses)) throw new Error("Windows Job stop proof conflicts with its original ticket or snapshot.");
};

export const validateWindowsControllerStopProof = (snapshot: ControllerSnapshot, ticket: ControllerLaunchTicket, ticketHash: string): void => {
  validateWindowsStoredStopProof(snapshot, ticketHash);
  if (ticketHash !== controllerPayloadHash(ticket)
    || snapshot.executionId !== ticket.executionId || snapshot.sessionId !== ticket.sessionId || snapshot.claimId !== ticket.claimId || snapshot.testExecutionId !== ticket.testExecutionId
    || snapshot.executionGeneration !== ticket.executionGeneration || snapshot.controllerInstanceId !== ticket.controllerInstanceId
    || snapshot.controllerProcess?.jobObjectName !== `Local\\Daynight-${ticket.launchId}`) throw new Error("Windows Job stop proof conflicts with its original ticket or snapshot.");
};

export const readProvenWindowsStoppedControllerGeneration = (file: string, ticket: ControllerLaunchTicket, deadline?: number): ControllerSnapshot => {
  try {
    const row = readControllerStopRow(file, deadline, true);
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
export type ControllerStopOptions = { stateDirectory: string; permit?: ControllerStoragePermit; signal?: AbortSignal; deadline?: number; jobLease?: ControllerJobLease };
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
  const inspection = new Database(file, { readonly: true, fileMustExist: true, timeout: remaining() });
  let needsUpgrade = false;
  closeJournal(inspection, file, () => { needsUpgrade = inspection.transaction(() => inspectSqlite(inspection, controllerJournalFormat).kind !== "current").deferred(); }, "not-started");
  if (needsUpgrade) {
    const preparation = prepareControllerStorage({ journalFile: file, stateDirectory: options.stateDirectory, mode: "upgrade-only", ...(deadline === undefined ? {} : { deadline }) }, permit);
    if (preparation.kind === "waiting") throw preparation.cause;
  }
  remaining();
  let observedRow: ControllerStopRow | null = null;
  try { observedRow = readControllerStopRow(file, deadline, true, permit); }
  catch (error) { failedAtDeadline(error, "not-started", error instanceof SqliteAccessError ? error.connectionClosed : true); }
  const observed = observedRow?.snapshot ?? null;
  if (observed === null || observed.controllerProcess === null || observed.executionId !== ticket.executionId || observed.claimId !== ticket.claimId || observed.testExecutionId !== ticket.testExecutionId || observed.executionGeneration !== ticket.executionGeneration || observed.controllerInstanceId !== ticket.controllerInstanceId) throw new Error("Original controller stop evidence is unavailable.");
  const ticketHash = controllerPayloadHash(ticket);
  if (observedRow!.ticketHash !== ticketHash || observed.sessionId !== ticket.sessionId) throw new Error("Original controller stop ticket conflicts with its journal.");
  if (process.platform === "win32" && observed.windowsJobStopProof !== undefined) {
    try { validateWindowsControllerStopProof(observed, ticket, observedRow!.ticketHash); remaining(); return observed; }
    catch (error) { return failedAtDeadline(error, "not-started", true); }
  }
  if (process.platform === "win32" && lease === undefined) throw new Error("Windows Job stop proof and original Job lease are unavailable; complete process-tree stop is unconfirmed.");
  if (!await (lease === undefined ? confirmControllerProcessesStopped(observed.controllerProcess, observed.nativeProcesses, deadline) : confirmControllerProcessesStopped(observed.controllerProcess, observed.nativeProcesses, deadline, lease))) throw new Error("The original controller or its descendants are still running.");
  let db: Database.Database;
  try { db = new Database(file, { fileMustExist: true, ...(deadline === undefined ? {} : { timeout: remaining() }) }); }
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
