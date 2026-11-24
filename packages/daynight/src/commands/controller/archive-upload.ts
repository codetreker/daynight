import { sqliteFilename, sqliteDisplayFilename } from "../../platform/sqlite-filename.js";
import { ArchiveRepairRequiredError, ArchiveRequestError, archiveRepairCode, type ArchiveProbeResult } from "./archive-error.js";
import Database from "better-sqlite3";
import path from "node:path";
import { withStoppedControllerStorage } from "./stopped-storage.js";
import { acquireControllerStoragePermit, controllerStorageConnectionIsOpen } from "./storage-lock.js";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { parseSessionResource, sessionBinding, type TimelineEntry, type SessionResource } from "../../session/protocol.js";
import { jsonPieces } from "../../session/json-pieces.js";
import { parseSessionArchive, parseSessionArchiveManifest, parseSessionArchivePreparation, parseSessionArchiveFileReceipt, parseSessionArchiveStatus, parseSessionArchiveTimeline, sessionArchiveReferences, SESSION_ARCHIVE_RESOURCE_MAX_BYTES, type SessionArchiveStatus, type SessionArchiveFileReceipt } from "../../session/archive.js";
import { controllerPayloadHash, type ControllerLaunchTicket } from "./launch-ticket.js";
import type { ControllerSnapshot } from "./lifecycle-store.js";
import { assertJournalMigrationAllowed, controllerJournalFormat } from "./journal-format.js";
import { assertCurrentSqlite, currentSqliteVersion, inspectSqlite } from "../../platform/sqlite-format.js";
import { closeSqliteDatabase, runSqliteImmediate, sqliteTransactionOutcome } from "../../platform/sqlite-access.js";
import { SqliteAccessError } from "../../platform/sqlite-error.js";
import { openSessionContent, readSessionHistoryContentPolicy, retireStoppedOnlineContent } from "./content/session-content.js";
import { createArchiveRequest } from "./archive-request.js";
import { ARCHIVE_ROUND_TIMEOUT_MS, ARCHIVE_STREAM_ROUND_TIMEOUT_MS, archiveRetryRuntime, type ArchiveRetryEvent, type ArchiveRetryRuntime } from "./archive-retry.js";
import { transferArchiveStream } from "./archive-stream.js";
import type { ControlledResourceLease, ResourceFiles } from "./content/resource-files.js";
import { syncDirectory, writeDurableJson } from "../../platform/durable-json.js";
import { replayStoppedControllerHistory, type StoppedSourceTailReceipt, type StoppedSourceRecoveryReceipt } from "./stopped-history.js";

const stoppedSnapshot = (db: Database.Database, ticket: ControllerLaunchTicket): ControllerSnapshot => {
  const version = Number(db.pragma("user_version", { simple: true }));
  if (version < 2 || version > currentSqliteVersion(controllerJournalFormat)) throw new SqliteAccessError("unsupported-version", { database: controllerJournalFormat.name, file: sqliteDisplayFilename(db.name), phase: "archive-admission", fromVersion: version, toVersion: currentSqliteVersion(controllerJournalFormat) });
  inspectSqlite(db, controllerJournalFormat);
  const row = db.prepare("SELECT snapshot,ticket_hash FROM execution WHERE id=1").get() as { snapshot: string; ticket_hash: string } | undefined;
  let observed: ControllerSnapshot | null;
  try { observed = row === undefined ? null : JSON.parse(row.snapshot) as ControllerSnapshot; }
  catch (cause) { throw new SqliteAccessError("invalid-format", { database: controllerJournalFormat.name, file: sqliteDisplayFilename(db.name), phase: "archive-decode" }, { cause }); }
  if (!observed || row?.ticket_hash !== controllerPayloadHash(ticket) || !observed.nativeStopped || observed.lifecycle !== "stopped" || observed.sessionId !== ticket.sessionId || observed.executionGeneration !== ticket.executionGeneration || observed.controllerInstanceId !== ticket.controllerInstanceId || observed.executionId !== ticket.executionId || observed.claimId !== ticket.claimId || observed.testExecutionId !== ticket.testExecutionId) throw new Error("Session archive requires the original stopped controller generation.");
  return observed;
};
const withClosedJournal = <T>(db: Database.Database, action: () => T): T => {
  let result: T | undefined, failed = false, failure: unknown;
  try { result = action(); } catch (cause) { failed = true; failure = cause; }
  const outcome = failed ? failure instanceof SqliteAccessError ? failure.outcome : sqliteTransactionOutcome(failure) : "committed";
  try { closeSqliteDatabase(db, { file: sqliteDisplayFilename(db.name), format: controllerJournalFormat }, outcome); }
  catch (close) {
    throw new SqliteAccessError("cleanup-failed", { database: controllerJournalFormat.name, file: sqliteDisplayFilename(db.name), phase: "archive-close" }, {
      cause: failed ? new AggregateError([failure, close], "Archive journal operation and shutdown failed.", { cause: failure }) : close,
      outcome, connectionClosed: !db.open,
    });
  }
  if (failed) {
    if (failure instanceof SqliteAccessError) throw new SqliteAccessError(failure.kind, failure.context, { cause: failure, outcome: failure.outcome, connectionClosed: !db.open });
    throw failure;
  }
  return result!;
};

/** Metadata admission only. A receipt is an opportunity to reconcile, never proof of success. */
export const probeStoppedControllerArchive = async (options: { journalPath: string; ticket: ControllerLaunchTicket; signal?: AbortSignal }): Promise<ArchiveProbeResult> => {
  options.signal?.throwIfAborted();
  const db = new Database(sqliteFilename(options.journalPath), { readonly: true, fileMustExist: true, timeout: 1000 });
  const result = withClosedJournal(db, () => db.transaction((): ArchiveProbeResult => {
    stoppedSnapshot(db, options.ticket);
    if (existsSync(`${options.journalPath}.archive-receipt-${options.ticket.executionGeneration}.json`)) return { kind: "attempt" };
    const version = Number(db.pragma("user_version", { simple: true }));
    // Older supported formats retain their original migration and archive admission path.
    if (version < 6) return { kind: "attempt" };
    assertJournalMigrationAllowed(db, inspectSqlite(db, controllerJournalFormat));
    const source = db.prepare("SELECT projection_gap,archive_incomplete FROM execution WHERE id=1").get() as { projection_gap: string | null; archive_incomplete: number };
    const code = archiveRepairCode(source);
    if (code !== null) return { kind: "blocked", code };
    if (version >= 10) {
      // Inspect the SQL projection marker without opening resource manifests or
      // materializing the whole history. Full archival still validates each entry.
      const failed = db.prepare("SELECT 1 FROM timeline_entries WHERE json_type(value,'$.imageProjectionError') NOT IN ('null') LIMIT 1").get();
      if (failed !== undefined) return { kind: "blocked", code: "markdown_projection_failed" };
    }
    return { kind: "complete" };
  }).deferred());
  options.signal?.throwIfAborted();
  return result;
};

type ArchiveIntent = {
  schemaVersion: 1; fence: object; controllerId: string; controllerInstanceId: string;
  historyEpoch: string; sourceThrough: string; history: { fileId: string; sha256: string; byteLength: string };
  timeline: { fileId: string; sha256: string; byteLength: string };
  resources: { resourceId: string; fileId: string }[];
};
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const openFrozenFile = (file: string, expected: { byteLength: string; sha256: string }): number => {
  const named = lstatSync(file), fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!named.isFile() || named.isSymbolicLink() || !stat.isFile() || named.dev !== stat.dev || named.ino !== stat.ino || process.platform !== "win32" && (stat.mode & 0o077) !== 0 || String(stat.size) !== expected.byteLength) throw new Error("Frozen archive source identity changed.");
    const hash = createHash("sha256"), block = Buffer.alloc(524288); let offset = 0;
    while (offset < stat.size) { const size = readSync(fd, block, 0, Math.min(block.length, stat.size - offset), offset); if (size === 0) throw new Error("Frozen archive source is incomplete."); hash.update(block.subarray(0, size)); offset += size; }
    if (hash.digest("hex") !== expected.sha256) throw new Error("Frozen archive source integrity changed.");
    return fd;
  } catch (error) { closeSync(fd); throw error; }
};
const semanticHash = (value: unknown): string => { const hash = createHash("sha256"); for (const piece of jsonPieces(value, true)) hash.update(piece); return hash.digest("hex"); };
const publishFrozenFile = (file: string, value: unknown): { byteLength: string; sha256: string } => {
  const temporary = `${file}.${randomUUID()}.tmp`, fd = openSync(temporary, "wx", 0o600);
  const hash = createHash("sha256"); let length = 0, closed = false;
  try {
    for (const piece of jsonPieces(value)) { const bytes = Buffer.from(piece); hash.update(bytes); length += bytes.length; let written = 0; while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written); }
    fsyncSync(fd); closeSync(fd); closed = true; renameSync(temporary, file); syncDirectory(path.dirname(file));
    return { byteLength: String(length), sha256: hash.digest("hex") };
  } catch (error) { if (!closed) closeSync(fd); if (existsSync(temporary)) unlinkSync(temporary); throw error; }
};
const withFrozenFile = async <T>(file: string, expected: { byteLength: string; sha256: string }, action: (read: (offset: string, limit: number) => Uint8Array) => Promise<T>): Promise<T> => {
  const fd = openFrozenFile(file, expected);
  try { return await action((offset, limit) => { const length = Math.min(limit, Number(expected.byteLength) - Number(offset)); if (!Number.isSafeInteger(length) || length < 0 || limit < 1 || limit > 524288) throw new Error("Invalid frozen archive source offset."); const block = Buffer.alloc(length); if (length && readSync(fd, block, 0, length, Number(offset)) !== length) throw new Error("Frozen archive source is incomplete."); return block; }); }
  finally { closeSync(fd); }
};
const withFrozenResource = async <T>(source: Pick<ResourceFiles, "acquireResource">, expected: SessionResource, action: (lease: ControlledResourceLease) => T | Promise<T>): Promise<T> => {
  const lease = source.acquireResource(expected.resourceId);
  let failed = false, failure: unknown;
  try {
    if (JSON.stringify(parseSessionResource(lease.resource)) !== JSON.stringify(expected) || expected.status !== "available" || expected.byteLength === null || expected.sha256 === null) throw new Error("Frozen archive resource differs from its original descriptor.");
    const hash = createHash("sha256"), length = BigInt(expected.byteLength);
    let offset = 0n;
    while (offset < length) {
      const block = lease.read(String(offset), 524288);
      if (block.length === 0 || offset + BigInt(block.length) > length) throw new Error("The original archive resource content changed.");
      hash.update(block); offset += BigInt(block.length);
    }
    if (hash.digest("hex") !== expected.sha256) throw new Error("The original archive resource content changed.");
    // The verified FD remains the source for this resource's status, retry and
    // chunk sequence. Acquiring it does not establish a new SQL snapshot.
    return await action(lease);
  } catch (error) { failed = true; failure = error; throw error; }
  finally {
    try { lease.close(); }
    catch (close) { throw failed ? new AggregateError([failure, close], "Archive resource operation and lease shutdown failed.", { cause: failure }) : close; }
  }
};
export const uploadStoppedControllerArchive = async (options: { journalPath: string; ticket: ControllerLaunchTicket; serverToken: string; request?: typeof fetch; signal?: AbortSignal; retryRuntime?: ArchiveRetryRuntime; onRetry?(event: ArchiveRetryEvent): void }): Promise<SessionArchiveStatus> => {
  const { ticket, journalPath } = options;
  let bodyOnly = false;
  const fence = { sessionId: ticket.sessionId, ...sessionBinding(ticket), executionGeneration: ticket.executionGeneration };
  const identity = { fence, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId };
  const base = ticket.testExecutionId !== undefined ? `/api/v1/test-sessions/${ticket.sessionId}` : `/api/v1/projects/${ticket.projectId}/tasks/${ticket.taskId}/sessions/${ticket.sessionId}`;
  const request = options.request ?? fetch;
  const runtime = options.retryRuntime ?? archiveRetryRuntime;
  const started = runtime.now();
  let deadline = started + ARCHIVE_ROUND_TIMEOUT_MS;
  const signalFor = (timeout: number): AbortSignal => options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  const legacySignal = signalFor(ARCHIVE_ROUND_TIMEOUT_MS);
  let roundSignal = legacySignal;
  const streamSignal = signalFor(ARCHIVE_STREAM_ROUND_TIMEOUT_MS);
  const makeCall = () => createArchiveRequest({ request, url: `${ticket.serverOrigin}${base}/archive`, serverToken: options.serverToken, bodyOnly: () => bodyOnly, signal: roundSignal, ...(options.signal === undefined ? {} : { parentSignal: options.signal }), deadline, sessionId: ticket.sessionId, retryRuntime: runtime, ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }) });
  let call = makeCall();
  const status = async (): Promise<SessionArchiveStatus> => parseSessionArchiveStatus((await call("GET", "", true) as { archive: unknown }).archive);
  let original: Database.Database;
  try { original = new Database(sqliteFilename(journalPath), { readonly: true, fileMustExist: true }); }
  catch (cause) { throw new SqliteAccessError("invalid-format", { database: controllerJournalFormat.name, file: journalPath, phase: "archive-open" }, { cause, connectionClosed: true }); }
  const observed = withClosedJournal(original, () => original.transaction(() => stoppedSnapshot(original, ticket)).deferred());
  const assertOriginal = (db: Database.Database): void => { if (JSON.stringify(stoppedSnapshot(db, ticket)) !== JSON.stringify(observed)) throw new Error("The stopped controller evidence changed before archival."); };
  const inspectOriginal = <T>(inspect: (db: Database.Database) => T): T => {
    const current = new Database(sqliteFilename(journalPath), { readonly: true, fileMustExist: true });
    return withClosedJournal(current, () => current.transaction(() => { assertOriginal(current); assertJournalMigrationAllowed(current, inspectSqlite(current, controllerJournalFormat)); return inspect(current); }).deferred());
  };
  const local = <T>(action: (db: Database.Database) => T): T => withStoppedControllerStorage({ journalPath, ticket, assertOriginal }, action);
  const localFiles = <T>(action: () => T): T => {
    const permit = acquireControllerStoragePermit(journalPath);
    let value: T | undefined, failure: unknown, failed = false;
    try { inspectOriginal(() => undefined); value = action(); }
    catch (error) { failed = true; failure = error; }
    if (failed && controllerStorageConnectionIsOpen(failure)) throw failure;
    try { permit.release(); }
    catch (release) { throw new SqliteAccessError("cleanup-failed", { database: controllerJournalFormat.name, file: journalPath, phase: "archive-file-release" }, { cause: failed ? new AggregateError([failure, release], "Archive file operation and storage release failed.") : release, outcome: "not-started", connectionClosed: true }); }
    if (failed) throw failure;
    return value!;
  };
  const receiptPath = `${journalPath}.archive-receipt-${ticket.executionGeneration}.json`;
  const intentPath = `${journalPath}.archive-intent-${ticket.executionGeneration}.json`;
  const historyPath = `${intentPath}.history`, timelinePath = `${intentPath}.timeline`;
  const cleanupFrozen = (): void => localFiles(() => { let changed = false; for (const file of [historyPath, timelinePath]) if (existsSync(file)) { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid frozen archive source during cleanup."); unlinkSync(file); changed = true; } if (changed) syncDirectory(path.dirname(intentPath)); });
  bodyOnly = inspectOriginal(readSessionHistoryContentPolicy) === "task_body";
  const retireOnline = () => { if (bodyOnly) local(db => retireStoppedOnlineContent(journalPath, ticket.sessionId, db)); };
  if (existsSync(receiptPath)) {
    const receipt = parseSessionArchiveStatus(JSON.parse(readFileSync(receiptPath, "utf8"))), current = await status();
    const sameRepresentation = current.sha256 === receipt.sha256 && current.byteLength === receipt.byteLength;
    const migratedOriginal = receipt.schemaVersion === undefined && current.migration?.sourceSha256 === receipt.sha256 && current.migration.sourceByteLength === receipt.byteLength;
    if (receipt.state !== "ready" || current.state !== "ready" || current.schemaVersion !== 3 || !(receipt.schemaVersion === 3 ? sameRepresentation : migratedOriginal)) throw new Error("Server archive differs from the confirmed receipt.");
    inspectOriginal(() => undefined);
    if (receipt.schemaVersion === undefined) localFiles(() => writeDurableJson(receiptPath, current));
    retireOnline();
    cleanupFrozen();
    return current;
  }
  const admission = await probeStoppedControllerArchive({ journalPath, ticket, signal: roundSignal });
  if (admission.kind === "blocked") throw new ArchiveRepairRequiredError(admission.code);
  const readContent = (db: Database.Database) => {
    if (!existsSync(`${journalPath}.pending-content/manifest.json`)) throw new Error("Pending archive source is missing.");
    return openSessionContent(journalPath, ticket.sessionId, db, {
      read: action => db.inTransaction ? action() : db.transaction(action).deferred(),
      assertWrite: () => { throw new Error("Archive reads cannot publish timeline entries."); },
    });
  };
  const materializeTimeline = (content: ReturnType<typeof readContent>) => {
    const entries: TimelineEntry[] = [];
    content.timeline.iterate(entry => { entries.push(entry); });
    return parseSessionArchiveTimeline({ entries });
  };
  const frozen = local(db => db.transaction(() => {
    assertCurrentSqlite(db, controllerJournalFormat); assertOriginal(db); assertJournalMigrationAllowed(db, inspectSqlite(db, controllerJournalFormat));
    const content = readContent(db);
    const source = db.prepare("SELECT CAST(last_sequence AS TEXT) AS sourceThrough,CAST(last_acknowledged AS TEXT) AS acknowledgedThrough,projection_gap,archive_incomplete FROM execution WHERE id=1").get() as { sourceThrough:string; acknowledgedThrough:string; projection_gap:string|null; archive_incomplete:number };
    const repairCode = archiveRepairCode(source);
    if (repairCode !== null) throw new ArchiveRepairRequiredError(repairCode);
    const timeline = materializeTimeline(content);
    if (timeline.entries.some(entry => entry.imageProjectionError != null)) throw new ArchiveRepairRequiredError("markdown_projection_failed");
    const allResources = [...content.resourceFiles.resources.values()].map(value => parseSessionResource(JSON.parse(JSON.stringify(value.resource)))).sort((a,b) => a.resourceId.localeCompare(b.resourceId));
    const refs = sessionArchiveReferences(timeline.entries), resources = [...refs.resources].sort().map(id => { const resource = allResources.find(resource => resource.resourceId === id); if (!resource || resource.status === "pending") throw new Error("Pending archive resource is incomplete."); return resource; });
    const epochRow = db.prepare("SELECT value FROM image_runtime_state WHERE key='history_epoch'").get() as {value:string}|undefined;
    const resourceSource = { acquireResource: content.resourceFiles.acquireResource };
    return { resourceSource, timeline, resources, allResources, refs, source, historyEpoch: epochRow ? JSON.parse(epochRow.value) as string : null };
  }).deferred());
  const initialTimelineHash = semanticHash(frozen.timeline), initialResourceHash = semanticHash(frozen.allResources);
  const assertFrozen = (requireAcknowledged = true): void => inspectOriginal(current => {
    const source = current.prepare("SELECT CAST(last_sequence AS TEXT) AS through,CAST(last_acknowledged AS TEXT) AS acknowledged FROM execution WHERE id=1").get() as {through:string;acknowledged:string};
    if (source.through !== frozen.source.sourceThrough || source.acknowledged !== (requireAcknowledged ? source.through : frozen.source.acknowledgedThrough)) throw new Error("The stopped source checkpoint was not completely acknowledged.");
    const content = readContent(current), timeline = materializeTimeline(content);
    const resources = [...content.resourceFiles.resources.values()].map(value => value.resource).sort((a,b) => a.resourceId.localeCompare(b.resourceId));
    if (semanticHash(timeline) !== initialTimelineHash || semanticHash(resources) !== initialResourceHash) throw new Error("The stopped archive source changed during transfer.");
  });
  const existing = await status();
  if (existing.state === "ready" && existing.schemaVersion === 3 && existing.migration) {
    // The old PUT could commit before its receipt reached the Controller. A
    // reader may already have converted that exact source to a sealed bundle.
    // Reconstruct the old wire document, including unreferenced artifacts,
    // rather than competing with its deterministic migration file identities.
    const resources = frozen.allResources.map(resource => ({ resource, data: null as string | null }));
    const source = { schemaVersion: 1, ...fence, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, provider: ticket.provider, nativeSessionId: observed.nativeSessionId, entries: frozen.timeline.entries, resources };
    let length = Buffer.byteLength(JSON.stringify(source));
    for (const { resource } of resources) {
      if (resource.status === "pending" || resource.status === "available" && BigInt(resource.byteLength!) > BigInt(SESSION_ARCHIVE_RESOURCE_MAX_BYTES)) throw new Error("Server archive migration differs from the original legacy source.");
      if (resource.status === "available") length += Math.ceil(Number(resource.byteLength!) / 3) * 4 - 2;
    }
    // Check the bounded old representation before allocating any base64 copy.
    if (String(length) !== existing.migration.sourceByteLength) throw new Error("Server archive migration differs from the original legacy source.");
    for (const value of resources) {
      if (value.resource.status !== "available") continue;
      await withFrozenResource(frozen.resourceSource, value.resource, lease => {
        const bytes = Buffer.alloc(Number(value.resource.byteLength!));
        for (let offset = 0; offset < bytes.length;) { const block = lease.read(String(offset), 524288); block.copy(bytes, offset); offset += block.length; }
        if (sha256(bytes) !== value.resource.sha256) throw new Error("The original legacy resource content changed.");
        value.data = bytes.toString("base64");
      });
    }
    const bytes = Buffer.from(JSON.stringify(parseSessionArchive(source)));
    if (sha256(bytes) !== existing.migration.sourceSha256 || String(bytes.length) !== existing.migration.sourceByteLength) throw new Error("Server archive migration differs from the original legacy source.");
    assertFrozen(false);
    localFiles(() => writeDurableJson(receiptPath, existing));
    return existing;
  }
  if (existing.state === "ready" && (existing.schemaVersion !== 3 || !existsSync(intentPath))) throw new Error("Server archive has no confirmed original source or upload intent.");
  if (frozen.source.sourceThrough !== frozen.source.acknowledgedThrough) {
    // The durable batch identity and bytes survive retries, including reconciliation after response loss.
    await replayStoppedControllerHistory({ journalPath, ticket, signal: roundSignal, send: async (batch, signal) => await call("POST", "/source-tail", true, JSON.stringify({ ...identity, ...batch }), {}, signal) as StoppedSourceTailReceipt, recover: async (batch, signal) => await call("POST", "/source-tail/recover", true, JSON.stringify({ ...identity, ...batch }), {}, signal) as StoppedSourceRecoveryReceipt });
  }
  assertFrozen();
  // Only identity-preserving preparation is replayable; reset requests need their own policy.
  let offeredVersion: string | null = null;
  const prepared = parseSessionArchivePreparation(await call("POST", "/prepare", true, JSON.stringify(identity), {}, undefined, { onResponse: response => { offeredVersion = response.headers.get("Daynight-Archive-Upload-Version"); } }));
  if (offeredVersion !== null && offeredVersion !== "2") throw new Error("Invalid archive upload capability.");
  if (prepared.recordId !== ticket.sessionId || prepared.phase === "failed" || prepared.sourceThrough !== frozen.source.sourceThrough || frozen.historyEpoch !== null && frozen.historyEpoch !== prepared.historyEpoch) throw new Error("Archive source differs from the original service checkpoint.");
  const historyValue = { ...(bodyOnly ? { contentPolicy: "task_body", onlineImageOccurrences: [] } : {}), historyEpoch: prepared.historyEpoch, sourceThrough: prepared.sourceThrough, entries: frozen.timeline.entries, resources: frozen.resources };
  const sourceSemantic = { history: semanticHash(historyValue), timeline: semanticHash(frozen.timeline) };
  const streamIntentPath = `${intentPath}.transfer.json`;
  const intent = localFiles((): ArchiveIntent => {
    const keys = (value: unknown, names: string): value is Record<string,unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === names;
    const id = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
    const expectedResources = frozen.resources.filter(resource => resource.status === "available" && resource.revision === undefined).map(resource => resource.resourceId).sort();
    if (!existsSync(intentPath)) {
      // No request can precede the durable intent; any interrupted preparation
      // is an unregistered local source and can be rebuilt under the permit.
      for (const file of [historyPath, timelinePath]) if (existsSync(file)) { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid frozen archive source."); unlinkSync(file); }
      const history = publishFrozenFile(historyPath, historyValue), timeline = publishFrozenFile(timelinePath, frozen.timeline);
      const value: ArchiveIntent = { schemaVersion: 1, ...identity, historyEpoch: prepared.historyEpoch, sourceThrough: prepared.sourceThrough, history: { fileId: randomUUID(), ...history }, timeline: { fileId: randomUUID(), ...timeline }, resources: expectedResources.map(resourceId => ({ resourceId, fileId: randomUUID() })) };
      writeDurableJson(intentPath, value); return value;
    }
    const value = JSON.parse(readFileSync(intentPath, "utf8")) as unknown;
    const file = (item: unknown): boolean => keys(item, "byteLength,fileId,sha256") && id(item.fileId) && typeof item.sha256 === "string" && /^[a-f0-9]{64}$/.test(item.sha256) && typeof item.byteLength === "string" && /^(0|[1-9][0-9]*)$/.test(item.byteLength);
    if (!keys(value,"controllerId,controllerInstanceId,fence,history,historyEpoch,resources,schemaVersion,sourceThrough,timeline") || value.schemaVersion !== 1 || JSON.stringify(value.fence) !== JSON.stringify(fence) || value.controllerId !== ticket.controllerId || value.controllerInstanceId !== ticket.controllerInstanceId || value.historyEpoch !== prepared.historyEpoch || value.sourceThrough !== prepared.sourceThrough || !file(value.history) || !file(value.timeline) || !Array.isArray(value.resources) || !value.resources.every(resource => keys(resource,"fileId,resourceId") && id(resource.fileId) && id(resource.resourceId)) || JSON.stringify(value.resources.map(resource => resource.resourceId).sort()) !== JSON.stringify(expectedResources)) throw new Error("Stopped archive intent cannot change identity.");
    const intent = value as ArchiveIntent;
    const fileIds = [intent.history.fileId, intent.timeline.fileId, ...intent.resources.map(resource => resource.fileId)];
    if (new Set(fileIds).size !== fileIds.length) throw new Error("Stopped archive file identities must be distinct.");
    const prior = existsSync(streamIntentPath) ? JSON.parse(readFileSync(streamIntentPath, "utf8")) as { sourceSemantic?: unknown } : null;
    if (prior && !isDeepStrictEqual(prior.sourceSemantic, sourceSemantic)) throw new Error("Stopped archive source changed from its frozen identity.");
    for (const [filePath, expected, source] of [[historyPath, intent.history, historyValue], [timelinePath, intent.timeline, frozen.timeline]] as const) {
      if (!existsSync(filePath)) {
        const created = publishFrozenFile(filePath, source);
        if (created.sha256 !== expected.sha256 || created.byteLength !== expected.byteLength) { unlinkSync(filePath); syncDirectory(path.dirname(filePath)); throw new Error("Stopped archive intent cannot change identity."); }
      } else {
        const fd = openFrozenFile(filePath, expected);
        try { if (!prior && !isDeepStrictEqual(JSON.parse(readFileSync(fd, "utf8")), source)) throw new Error("Stopped archive intent cannot change identity."); } finally { closeSync(fd); }
      }
    }
    return intent;
  });
  // Each file can have started under a different capability; status identifies
  // an existing registration and prepare selects only a not-yet-started file.
  const streamSource = { history: intent.history, timeline: intent.timeline, resources: intent.resources.map(value => ({ ...value, descriptor: frozen.resources.find(resource => resource.resourceId === value.resourceId)! })) };
  type TransferIntent = { schemaVersion: 1; versions: Record<string, 1 | 2>; source: typeof streamSource; sourceSemantic: typeof sourceSemantic; timelineRevision: string | null; replacements: Record<string, string> };
  const transferIntent = localFiles((): TransferIntent => {
    if (!existsSync(streamIntentPath)) {
      const value: TransferIntent = { schemaVersion: 1, versions: {}, source: streamSource, sourceSemantic, timelineRevision: null, replacements: {} };
      writeDurableJson(streamIntentPath, value); return value;
    }
    const value = JSON.parse(readFileSync(streamIntentPath, "utf8")) as TransferIntent;
    const id = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
    if (!value || Object.keys(value).sort().join() !== "replacements,schemaVersion,source,sourceSemantic,timelineRevision,versions" || value.schemaVersion !== 1 || !value.versions || typeof value.versions !== "object" || Array.isArray(value.versions) || !Object.entries(value.versions).every(([key, version]) => id(key) && (version === 1 || version === 2)) || JSON.stringify(value.source) !== JSON.stringify(streamSource) || !isDeepStrictEqual(value.sourceSemantic, sourceSemantic) || value.timelineRevision !== null && (typeof value.timelineRevision !== "string" || !/^[1-9][0-9]*$/.test(value.timelineRevision)) || !value.replacements || typeof value.replacements !== "object" || Array.isArray(value.replacements) || !Object.entries(value.replacements).every(([old, next]) => id(old) && id(next) && old !== next) || new Set(Object.values(value.replacements)).size !== Object.values(value.replacements).length) throw new Error("Stopped archive transfer intent cannot change identity.");
    return value;
  });
  const saveTransferIntent = (): void => { localFiles(() => writeDurableJson(streamIntentPath, transferIntent)); };
  let historyRevision: string | null = null;
  const transfer = async (purpose:"history"|"timeline"|"resource", file:{fileId:string;sha256:string;byteLength:string}, read:(offset:string,limit:number)=>Uint8Array, descriptor?: unknown): Promise<string> => {
    const path = purpose === "history" ? `/prepare/history/${file.fileId}` : `/files/${file.fileId}`;
    const parse = (raw: unknown): SessionArchiveFileReceipt => {
      if (purpose !== "history") return parseSessionArchiveFileReceipt(raw);
      if (!raw || typeof raw !== "object") throw new Error("Invalid archive history receipt.");
      const {syncId,timelineRevision,...rest} = raw as Record<string,unknown>;
      if (Object.keys(raw).length !== (Object.hasOwn(raw, "successorFileId") ? 8 : 7) || rest.state === "complete" && (typeof timelineRevision !== "string" || !/^[1-9][0-9]*$/.test(timelineRevision)) || rest.state !== "complete" && timelineRevision !== null) throw new Error("Invalid archive history checkpoint.");
      if (rest.state === "complete") historyRevision = timelineRevision as string;
      return parseSessionArchiveFileReceipt({fileId:syncId,...rest});
    };
    let receipt: SessionArchiveFileReceipt | null = null, initial: { raw: unknown; corrupt: boolean } | null = null;
    let statusVersion: string | null = null;
    try { const raw = await call("GET",`${path}/status`,true,undefined,{},undefined,{onResponse: response => { statusVersion = response.headers.get("Daynight-Archive-Upload-Version"); }}); initial = { raw, corrupt: false }; receipt = parse(raw); }
    catch(error) {
      if (error instanceof ArchiveRequestError && error.status === 404) { /* Unregistered. */ }
      else if (error instanceof ArchiveRequestError && error.status === 409 && error.code === "staging_corrupt" && error.uploadVersion === "2" && error.payload && typeof error.payload === "object" && "file" in error.payload) { statusVersion = "2"; initial = { raw: error.payload.file, corrupt: true }; receipt = parse(initial.raw); }
      else throw error;
    }
    if (receipt && (receipt.fileId !== file.fileId || receipt.byteLength !== file.byteLength || receipt.sha256 !== file.sha256)) throw new Error("Archive file differs from its original intent.");
    if (receipt && statusVersion !== null && statusVersion !== "1" && statusVersion !== "2") throw new Error("Invalid archive file upload version.");
    const observedVersion = receipt ? statusVersion === "2" ? 2 : 1 : null;
    const version = transferIntent.versions[file.fileId] ?? observedVersion ?? (offeredVersion === "2" ? 2 : 1);
    if (observedVersion !== null && observedVersion !== version) throw new Error("Archive file upload version differs from its original intent.");
    if (transferIntent.versions[file.fileId] === undefined) { transferIntent.versions[file.fileId] = version; saveTransferIntent(); }
    deadline = started + (version === 2 ? ARCHIVE_STREAM_ROUND_TIMEOUT_MS : ARCHIVE_ROUND_TIMEOUT_MS); roundSignal = version === 2 ? streamSignal : legacySignal; call = makeCall();
    if (version === 2) return transferArchiveStream({ purpose, file, read, call, signal: roundSignal, runtime, deadline, replacements: transferIntent.replacements, initial, ...(descriptor === undefined ? {} : { descriptor }), onHistoryRevision: revision => { historyRevision = revision; }, reserveReplacement: id => { const replacement = randomUUID(); transferIntent.replacements[id] = replacement; saveTransferIntent(); return replacement; } });
    const check = (receipt: SessionArchiveFileReceipt): void => { if (receipt.fileId !== file.fileId || receipt.byteLength !== file.byteLength || receipt.sha256 !== file.sha256 || receipt.state === "failed") throw new Error("Archive file differs from its original intent."); };
    if (receipt) check(receipt);
    while (receipt?.state !== "complete") {
      roundSignal.throwIfAborted();
      const offset=receipt?.acceptedOffset??"0";
      // All bytes with a receiving receipt still require validation. An exact
      // retry of the final original block asks the same writer to reconcile it.
      const start=offset===file.byteLength && offset!=="0" ? String(Math.floor((Number(offset)-1)/524288)*524288) : offset;
      const block=read(start,524288);
      try { receipt=parse(await call("PUT",`${path}?offset=${start}${purpose==="resource"?"&purpose=resource&migrationOnly=true":""}`,true,block,{"Daynight-File-Byte-Length":file.byteLength,"Daynight-File-SHA256":file.sha256,"Daynight-Chunk-SHA256":sha256(block),...(descriptor===undefined?{}:{"Daynight-Resource-Descriptor":JSON.stringify(descriptor)})})); }
      catch(error) { if (roundSignal.aborted || error instanceof ArchiveRequestError && error.busy) throw error; const current=parse(await call("GET",`${path}/status`,true));check(current);if (current.state!=="complete" && current.acceptedOffset===offset) throw error;receipt=current; }
      check(receipt);
    }
    return file.fileId;
  };
  if (prepared.phase === "settling") {
    const historyId = await withFrozenFile(historyPath, intent.history, read => transfer("history",intent.history,read));
    assertFrozen();
    local(checkpoint=>runSqliteImmediate(checkpoint,()=>{
      assertCurrentSqlite(checkpoint,controllerJournalFormat);assertOriginal(checkpoint);
      checkpoint.prepare("INSERT INTO image_runtime_state VALUES('archive_history_checkpoint',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({...identity,historyEpoch:intent.historyEpoch,sourceThrough:intent.sourceThrough,history:{...intent.history,fileId:historyId},timelineRevision:historyRevision}));
    }));
    for (const resourceIntent of intent.resources) {
      const resource=frozen.resources.find(resource=>resource.resourceId===resourceIntent.resourceId)!;
      await withFrozenResource(frozen.resourceSource, resource, lease => transfer("resource",{fileId:resourceIntent.fileId,sha256:resource.sha256!,byteLength:resource.byteLength!},(offset,limit)=>lease.read(offset,limit),resource));
    }
  }
  const sealed=parseSessionArchivePreparation(await call("POST","/seal",true));
  if (sealed.phase!=="sealed"||sealed.recordId!==ticket.sessionId||sealed.historyEpoch!==intent.historyEpoch||sealed.sourceThrough!==intent.sourceThrough) throw new Error("Archive seal was not confirmed.");
  if (transferIntent) { if (transferIntent.timelineRevision !== null && transferIntent.timelineRevision !== sealed.timelineRevision) throw new Error("Archive revision differs from its original intent."); if (transferIntent.timelineRevision === null) { transferIntent.timelineRevision = sealed.timelineRevision; saveTransferIntent(); } }
  const partial=frozen.refs.unavailable||frozen.resources.some(resource=>resource.status!=="available");
  const timelineId = await withFrozenFile(timelinePath, intent.timeline, read => transfer("timeline",intent.timeline,read));
  const manifest=parseSessionArchiveManifest({schemaVersion:3,contentKind:"native_timeline",...(bodyOnly?{contentPolicy:"task_body"}:{}),recordId:ticket.sessionId,...identity,provider:ticket.provider,nativeSessionId:observed.nativeSessionId,timeline:{...intent.timeline,fileId:timelineId},resources:sealed.resources,completeness:partial?"partial":"complete"});
  const body=JSON.stringify(manifest),hash=sha256(Buffer.from(body)),length=String(Buffer.byteLength(body));
  const matches=(value:SessionArchiveStatus)=>value.state==="ready"&&value.schemaVersion===3&&value.sha256===hash&&value.byteLength===length&&value.completeness===manifest.completeness;
  let current=await status();
  if (current.state!=="ready") {
    assertFrozen();
    try { current=parseSessionArchiveStatus((await call("PUT","/content",true,body) as {archive:unknown}).archive); }
    catch(error) { if (roundSignal.aborted || error instanceof ArchiveRequestError && error.busy) throw error; current=await status();if(!matches(current))throw error; }
  }
  if(!matches(current))throw new Error("Session archive commit was not confirmed with matching integrity.");
  assertFrozen();
  localFiles(() => writeDurableJson(receiptPath,current));
  retireOnline();
  cleanupFrozen();
  return current;
};
