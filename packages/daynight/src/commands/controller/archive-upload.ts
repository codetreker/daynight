import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { sessionBinding } from "../../session/protocol.js";
import { parseSessionArchive, parseSessionArchiveManifest, parseSessionArchivePreparation, parseSessionArchiveFileReceipt, parseSessionArchiveStatus, parseSessionArchiveTimeline, sessionArchiveReferences, SESSION_ARCHIVE_RESOURCE_MAX_BYTES, type SessionArchiveStatus, type SessionArchiveFileReceipt } from "../../session/archive.js";
import { controllerPayloadHash, type ControllerLaunchTicket } from "./launch-ticket.js";
import type { ControllerSnapshot } from "./lifecycle-store.js";
import { assertJournalMigrationAllowed, controllerJournalFormat } from "./journal-format.js";
import { assertCurrentSqlite, currentSqliteVersion, inspectSqlite } from "../../platform/sqlite-format.js";
import { closeSqliteDatabase, openSqliteDatabase, runSqliteImmediate, sqliteTransactionOutcome } from "../../platform/sqlite-access.js";
import { SqliteAccessError } from "../../platform/sqlite-error.js";
import { finalizePendingMigration, reconcilePendingContent, openPendingContent, writeDurableJson } from "./pending-content.js";
import { replayStoppedControllerHistory, type StoppedSourceTailReceipt } from "./stopped-history.js";

const stoppedSnapshot = (db: Database.Database, ticket: ControllerLaunchTicket): ControllerSnapshot => {
  const version = Number(db.pragma("user_version", { simple: true }));
  if (version < 2 || version > currentSqliteVersion(controllerJournalFormat)) throw new SqliteAccessError("unsupported-version", { database: controllerJournalFormat.name, file: db.name, phase: "archive-admission", fromVersion: version, toVersion: currentSqliteVersion(controllerJournalFormat) });
  inspectSqlite(db, controllerJournalFormat);
  const row = db.prepare("SELECT snapshot,ticket_hash FROM execution WHERE id=1").get() as { snapshot: string; ticket_hash: string } | undefined;
  let observed: ControllerSnapshot | null;
  try { observed = row === undefined ? null : JSON.parse(row.snapshot) as ControllerSnapshot; }
  catch (cause) { throw new SqliteAccessError("invalid-format", { database: controllerJournalFormat.name, file: db.name, phase: "archive-decode" }, { cause }); }
  if (!observed || row?.ticket_hash !== controllerPayloadHash(ticket) || !observed.nativeStopped || observed.lifecycle !== "stopped" || observed.sessionId !== ticket.sessionId || observed.executionGeneration !== ticket.executionGeneration || observed.controllerInstanceId !== ticket.controllerInstanceId || observed.executionId !== ticket.executionId || observed.claimId !== ticket.claimId || observed.testExecutionId !== ticket.testExecutionId) throw new Error("Session archive requires the original stopped controller generation.");
  return observed;
};
const withClosedJournal = <T>(db: Database.Database, action: () => T): T => {
  let result: T | undefined, failed = false, failure: unknown;
  try { result = action(); } catch (cause) { failed = true; failure = cause; }
  try { closeSqliteDatabase(db, { file: db.name, format: controllerJournalFormat }, failed ? sqliteTransactionOutcome(failure) : "committed"); }
  catch (close) { if (failed) throw new AggregateError([failure, close], "Archive journal operation and shutdown failed."); throw close; }
  if (failed) throw failure;
  return result!;
};

type ArchiveIntent = {
  schemaVersion: 1; fence: object; controllerId: string; controllerInstanceId: string;
  historyEpoch: string; sourceThrough: string; history: { fileId: string; sha256: string; byteLength: string };
  timeline: { fileId: string; sha256: string; byteLength: string };
  resources: { resourceId: string; fileId: string }[];
};
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export const uploadStoppedControllerArchive = async (options: { journalPath: string; ticket: ControllerLaunchTicket; serverToken: string; request?: typeof fetch; signal?: AbortSignal }): Promise<SessionArchiveStatus> => {
  const { ticket, journalPath } = options;
  const fence = { sessionId: ticket.sessionId, ...sessionBinding(ticket), executionGeneration: ticket.executionGeneration };
  const identity = { fence, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId };
  const base = ticket.testExecutionId !== undefined ? `/api/v1/test-sessions/${ticket.sessionId}` : `/api/v1/projects/${ticket.projectId}/tasks/${ticket.taskId}/sessions/${ticket.sessionId}`;
  const request = options.request ?? fetch;
  const roundSignal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
  const call = async (method: string, suffix: string, body?: string | Uint8Array, extra: Record<string,string> = {}, sourceSignal?: AbortSignal): Promise<unknown> => {
    roundSignal.throwIfAborted();
    const signal = AbortSignal.any([roundSignal, AbortSignal.timeout(15_000), ...(sourceSignal ? [sourceSignal] : [])]);
    const response = await request(`${ticket.serverOrigin}${base}/archive${suffix}`, { method, redirect: "error", headers: { Authorization: `Bearer ${options.serverToken}`, ...(body === undefined ? {} : { "Content-Type": typeof body === "string" ? "application/json" : "application/octet-stream" }), ...extra }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : Uint8Array.from(body) }), signal });
    if (!response.ok) throw Object.assign(new Error(`Session archive request failed (${response.status}).`), { status: response.status });
    return response.json();
  };
  const status = async (): Promise<SessionArchiveStatus> => parseSessionArchiveStatus((await call("GET", "") as { archive: unknown }).archive);
  let original: Database.Database;
  try { original = new Database(journalPath, { readonly: true, fileMustExist: true }); }
  catch (cause) { throw new SqliteAccessError("invalid-format", { database: controllerJournalFormat.name, file: journalPath, phase: "archive-open" }, { cause, connectionClosed: true }); }
  const observed = withClosedJournal(original, () => original.transaction(() => stoppedSnapshot(original, ticket)).deferred());
  const assertOriginal = (db: Database.Database): void => { if (JSON.stringify(stoppedSnapshot(db, ticket)) !== JSON.stringify(observed)) throw new Error("The stopped controller evidence changed before archival."); };
  const inspectOriginal = <T>(inspect: (db: Database.Database) => T): T => {
    const current = new Database(journalPath, { readonly: true, fileMustExist: true });
    return withClosedJournal(current, () => current.transaction(() => { assertOriginal(current); assertJournalMigrationAllowed(current, inspectSqlite(current, controllerJournalFormat)); return inspect(current); }).deferred());
  };
  const receiptPath = `${journalPath}.archive-receipt-${ticket.executionGeneration}.json`;
  if (existsSync(receiptPath)) {
    const receipt = parseSessionArchiveStatus(JSON.parse(readFileSync(receiptPath, "utf8"))), current = await status();
    const sameRepresentation = current.sha256 === receipt.sha256 && current.byteLength === receipt.byteLength;
    const migratedOriginal = receipt.schemaVersion === undefined && current.migration?.sourceSha256 === receipt.sha256 && current.migration.sourceByteLength === receipt.byteLength;
    if (receipt.state !== "ready" || current.state !== "ready" || current.schemaVersion !== 3 || !(receipt.schemaVersion === 3 ? sameRepresentation : migratedOriginal)) throw new Error("Server archive differs from the confirmed receipt.");
    inspectOriginal(() => undefined);
    if (receipt.schemaVersion === undefined) writeDurableJson(receiptPath, current);
    return current;
  }
  const db = openSqliteDatabase({ file: journalPath, format: controllerJournalFormat, allowCreate: false,
    assertMigrationAllowed: (db, source) => { assertOriginal(db); assertJournalMigrationAllowed(db, source); }, onReady: assertOriginal,
  });
  const frozen = withClosedJournal(db, () => {
   if (existsSync(`${journalPath}.pending-content/manifest.json`)) finalizePendingMigration(db,openPendingContent(journalPath,ticket.sessionId));
   return runSqliteImmediate(db, () => {
    assertCurrentSqlite(db, controllerJournalFormat); assertOriginal(db); assertJournalMigrationAllowed(db, inspectSqlite(db, controllerJournalFormat));
    if (!existsSync(`${journalPath}.pending-content/manifest.json`)) throw new Error("Pending archive source is missing.");
    const content = openPendingContent(journalPath, ticket.sessionId); reconcilePendingContent(db, content);
    const source = db.prepare("SELECT CAST(last_sequence AS TEXT) AS sourceThrough,CAST(last_acknowledged AS TEXT) AS acknowledgedThrough,projection_gap,archive_incomplete FROM execution WHERE id=1").get() as { sourceThrough:string; acknowledgedThrough:string; projection_gap:string|null; archive_incomplete:number };
    if (source.archive_incomplete !== 0 || source.projection_gap !== null && source.projection_gap !== "Recovered pending timeline requires full relay resynchronization.") throw new Error("Pending archive has an unresolved projection gap.");
    const timeline = parseSessionArchiveTimeline({ entries: [...content.entries.values()].sort((a,b) => BigInt(a.entrySeq) < BigInt(b.entrySeq) ? -1 : 1) });
    const allResources = [...content.resources.values()].map(value => value.resource).sort((a,b) => a.resourceId.localeCompare(b.resourceId));
    const refs = sessionArchiveReferences(timeline.entries), resources = [...refs.resources].sort().map(id => { const resource = content.resources.get(id)?.resource; if (!resource || resource.status === "pending") throw new Error("Pending archive resource is incomplete."); return resource; });
    const epochRow = db.prepare("SELECT value FROM image_runtime_state WHERE key='history_epoch'").get() as {value:string}|undefined;
    return { content, timeline, resources, allResources, refs, source, historyEpoch: epochRow ? JSON.parse(epochRow.value) as string : null };
  }); });
  const assertFrozen = (requireAcknowledged = true): void => inspectOriginal(current => {
    const source = current.prepare("SELECT CAST(last_sequence AS TEXT) AS through,CAST(last_acknowledged AS TEXT) AS acknowledged FROM execution WHERE id=1").get() as {through:string;acknowledged:string};
    if (source.through !== frozen.source.sourceThrough || source.acknowledged !== (requireAcknowledged ? source.through : frozen.source.acknowledgedThrough)) throw new Error("The stopped source checkpoint was not completely acknowledged.");
    const pending = openPendingContent(journalPath, ticket.sessionId);
    const timeline = {entries:[...pending.entries.values()].sort((a,b)=>BigInt(a.entrySeq)<BigInt(b.entrySeq)?-1:1)};
    const resources = [...pending.resources.values()].map(value => value.resource).sort((a,b) => a.resourceId.localeCompare(b.resourceId));
    if (JSON.stringify(timeline) !== JSON.stringify(frozen.timeline) || JSON.stringify(resources) !== JSON.stringify(frozen.allResources)) throw new Error("The stopped archive source changed during transfer.");
  });
  const intentPath = `${journalPath}.archive-intent-${ticket.executionGeneration}.json`;
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
      const lease = frozen.content.acquireResource(value.resource.resourceId);
      try {
        const bytes = Buffer.alloc(Number(value.resource.byteLength!));
        for (let offset = 0; offset < bytes.length;) { const block = lease.read(String(offset), 524288); block.copy(bytes, offset); offset += block.length; }
        if (sha256(bytes) !== value.resource.sha256) throw new Error("The original legacy resource content changed.");
        value.data = bytes.toString("base64");
      } finally { lease.close(); }
    }
    const bytes = Buffer.from(JSON.stringify(parseSessionArchive(source)));
    if (sha256(bytes) !== existing.migration.sourceSha256 || String(bytes.length) !== existing.migration.sourceByteLength) throw new Error("Server archive migration differs from the original legacy source.");
    assertFrozen(false);
    writeDurableJson(receiptPath, existing);
    return existing;
  }
  if (existing.state === "ready" && (existing.schemaVersion !== 3 || !existsSync(intentPath))) throw new Error("Server archive has no confirmed original source or upload intent.");
  if (frozen.source.sourceThrough !== frozen.source.acknowledgedThrough) {
    await replayStoppedControllerHistory({ journalPath, ticket, signal: roundSignal, send: async (batch, signal) => await call("POST", "/source-tail", JSON.stringify({ ...identity, ...batch }), {}, signal) as StoppedSourceTailReceipt });
  }
  assertFrozen();
  const prepared = parseSessionArchivePreparation(await call("POST", "/prepare", JSON.stringify(identity)));
  if (prepared.recordId !== ticket.sessionId || prepared.phase === "failed" || prepared.sourceThrough !== frozen.source.sourceThrough || frozen.historyEpoch !== null && frozen.historyEpoch !== prepared.historyEpoch) throw new Error("Archive source differs from the original service checkpoint.");
  const timelineBytes = Buffer.from(JSON.stringify(frozen.timeline));
  const historyBytes = Buffer.from(JSON.stringify({ historyEpoch: prepared.historyEpoch, sourceThrough: prepared.sourceThrough, entries: frozen.timeline.entries, resources: frozen.resources }));
  let intent: ArchiveIntent;
  if (existsSync(intentPath)) {
    const value = JSON.parse(readFileSync(intentPath,"utf8")) as unknown;
    const keys = (value: unknown, names: string): value is Record<string,unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === names;
    const id = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
    const file = (value: unknown, bytes: Uint8Array): boolean => keys(value,"byteLength,fileId,sha256") && id(value.fileId) && value.sha256 === sha256(bytes) && value.byteLength === String(bytes.length);
    const expectedResources = frozen.resources.filter(resource=>resource.status === "available" && resource.revision === undefined).map(resource=>resource.resourceId).sort();
    if (!keys(value,"controllerId,controllerInstanceId,fence,history,historyEpoch,resources,schemaVersion,sourceThrough,timeline") || value.schemaVersion !== 1 || JSON.stringify(value.fence) !== JSON.stringify(fence) || value.controllerId !== ticket.controllerId || value.controllerInstanceId !== ticket.controllerInstanceId || value.historyEpoch !== prepared.historyEpoch || value.sourceThrough !== prepared.sourceThrough || !file(value.history,historyBytes) || !file(value.timeline,timelineBytes) || !Array.isArray(value.resources) || !value.resources.every(resource=>keys(resource,"fileId,resourceId")&&id(resource.fileId)&&id(resource.resourceId)) || JSON.stringify(value.resources.map(resource=>resource.resourceId).sort())!==JSON.stringify(expectedResources)) throw new Error("Stopped archive intent cannot change identity.");
    intent = value as ArchiveIntent;
    const fileIds = [intent.history.fileId,intent.timeline.fileId,...intent.resources.map(resource=>resource.fileId)];
    if (new Set(fileIds).size !== fileIds.length) throw new Error("Stopped archive file identities must be distinct.");
  } else {
    intent = { schemaVersion:1, ...identity, historyEpoch:prepared.historyEpoch,sourceThrough:prepared.sourceThrough,history:{fileId:randomUUID(),sha256:sha256(historyBytes),byteLength:String(historyBytes.length)},timeline:{fileId:randomUUID(),sha256:sha256(timelineBytes),byteLength:String(timelineBytes.length)},resources:frozen.resources.filter(resource => resource.status === "available" && resource.revision === undefined).map(resource => ({resourceId:resource.resourceId,fileId:randomUUID()})) };
    writeDurableJson(intentPath,intent);
  }
  let historyRevision: string | null = null;
  const transfer = async (purpose:"history"|"timeline"|"resource", file:{fileId:string;sha256:string;byteLength:string}, read:(offset:string,limit:number)=>Uint8Array, descriptor?: unknown): Promise<void> => {
    const path = purpose === "history" ? `/prepare/history/${file.fileId}` : `/files/${file.fileId}`;
    const parse = (raw: unknown): SessionArchiveFileReceipt => {
      if (purpose !== "history") return parseSessionArchiveFileReceipt(raw);
      if (!raw || typeof raw !== "object") throw new Error("Invalid archive history receipt.");
      const {syncId,timelineRevision,...rest} = raw as Record<string,unknown>;
      if (Object.keys(raw).length !== 7 || rest.state === "complete" && (typeof timelineRevision !== "string" || !/^[1-9][0-9]*$/.test(timelineRevision)) || rest.state !== "complete" && timelineRevision !== null) throw new Error("Invalid archive history checkpoint.");
      if (rest.state === "complete") historyRevision = timelineRevision as string;
      return parseSessionArchiveFileReceipt({fileId:syncId,...rest});
    };
    let receipt: SessionArchiveFileReceipt | null = null;
    try { receipt=parse(await call("GET",`${path}/status`)); } catch(error) { if (!(error && typeof error === "object" && "status" in error && error.status === 404)) throw error; }
    const check = (receipt: SessionArchiveFileReceipt): void => { if (receipt.fileId !== file.fileId || receipt.byteLength !== file.byteLength || receipt.sha256 !== file.sha256 || receipt.state === "failed") throw new Error("Archive file differs from its original intent."); };
    if (receipt) check(receipt);
    while (receipt?.state !== "complete") {
      roundSignal.throwIfAborted();
      const offset=receipt?.acceptedOffset??"0";
      // All bytes with a receiving receipt still require validation. An exact
      // retry of the final original block asks the same writer to reconcile it.
      const start=offset===file.byteLength ? String(Math.floor((Number(offset)-1)/524288)*524288) : offset;
      const block=read(start,524288);
      try { receipt=parse(await call("PUT",`${path}?offset=${start}${purpose==="resource"?"&purpose=resource&migrationOnly=true":""}`,block,{"Daynight-File-Byte-Length":file.byteLength,"Daynight-File-SHA256":file.sha256,"Daynight-Chunk-SHA256":sha256(block),...(descriptor===undefined?{}:{"Daynight-Resource-Descriptor":JSON.stringify(descriptor)})})); }
      catch(error) { const current=parse(await call("GET",`${path}/status`));check(current);if (current.state!=="complete" && current.acceptedOffset===offset) throw error;receipt=current; }
      check(receipt);
    }
  };
  if (prepared.phase === "settling") {
    await transfer("history",intent.history,(offset,limit)=>historyBytes.subarray(Number(offset),Number(offset)+limit));
    assertFrozen();
    const checkpoint = openSqliteDatabase({file:journalPath,format:controllerJournalFormat,allowCreate:false,onReady:assertOriginal});
    withClosedJournal(checkpoint,()=>runSqliteImmediate(checkpoint,()=>{
      assertCurrentSqlite(checkpoint,controllerJournalFormat);assertOriginal(checkpoint);
      checkpoint.prepare("INSERT INTO image_runtime_state VALUES('archive_history_checkpoint',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({...identity,historyEpoch:intent.historyEpoch,sourceThrough:intent.sourceThrough,history:intent.history,timelineRevision:historyRevision}));
    }));
    for (const resourceIntent of intent.resources) {
      const resource=frozen.resources.find(resource=>resource.resourceId===resourceIntent.resourceId)!;
      const lease=frozen.content.acquireResource(resource.resourceId);
      try { await transfer("resource",{fileId:resourceIntent.fileId,sha256:resource.sha256!,byteLength:resource.byteLength!},(offset,limit)=>lease.read(offset,limit),resource); }
      finally { lease.close(); }
    }
  }
  const sealed=parseSessionArchivePreparation(await call("POST","/seal"));
  if (sealed.phase!=="sealed"||sealed.recordId!==ticket.sessionId||sealed.historyEpoch!==intent.historyEpoch||sealed.sourceThrough!==intent.sourceThrough) throw new Error("Archive seal was not confirmed.");
  const partial=frozen.refs.unavailable||frozen.resources.some(resource=>resource.status!=="available");
  const manifest=parseSessionArchiveManifest({schemaVersion:3,contentKind:"native_timeline",recordId:ticket.sessionId,...identity,provider:ticket.provider,nativeSessionId:observed.nativeSessionId,timeline:intent.timeline,resources:sealed.resources,completeness:partial?"partial":"complete"});
  await transfer("timeline",intent.timeline,(offset,limit)=>timelineBytes.subarray(Number(offset),Number(offset)+limit));
  const body=JSON.stringify(manifest),hash=sha256(Buffer.from(body)),length=String(Buffer.byteLength(body));
  const matches=(value:SessionArchiveStatus)=>value.state==="ready"&&value.schemaVersion===3&&value.sha256===hash&&value.byteLength===length&&value.completeness===manifest.completeness;
  let current=await status();
  if (current.state!=="ready") {
    assertFrozen();
    try { current=parseSessionArchiveStatus((await call("PUT","/content",body) as {archive:unknown}).archive); }
    catch(error) { current=await status();if(!matches(current))throw error; }
  }
  if(!matches(current))throw new Error("Session archive commit was not confirmed with matching integrity.");
  assertFrozen();
  writeDurableJson(receiptPath,current);
  return current;
};
