import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { sessionBinding } from "../../session/protocol.js";
import { parseSessionArchive, parseSessionArchiveStatus, verifySessionArchiveResources, type SessionArchiveStatus } from "../../session/archive.js";
import type { ControllerLaunchTicket } from "./launch-ticket.js";
import type { ControllerSnapshot } from "./lifecycle-store.js";
import { assertJournalMigrationAllowed, controllerJournalFormat } from "./journal-format.js";
import { assertCurrentSqlite, inspectSqlite } from "../../platform/sqlite-format.js";
import { closeSqliteDatabase, openSqliteDatabase, runSqliteImmediate, sqliteTransactionOutcome } from "../../platform/sqlite-access.js";
import { SqliteAccessError } from "../../platform/sqlite-error.js";
import { reconcilePendingContent, openPendingContent, writeDurableJson } from "./pending-content.js";

const stoppedSnapshot = (db: Database.Database, ticket: ControllerLaunchTicket): ControllerSnapshot => {
  const version = Number(db.pragma("user_version", { simple: true }));
  if (version < 2 || version > 6) throw new SqliteAccessError("unsupported-version", { database: controllerJournalFormat.name, file: db.name, phase: "archive-admission", fromVersion: version, toVersion: 6 });
  inspectSqlite(db, controllerJournalFormat);
  const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string } | undefined;
  let observed: ControllerSnapshot | null;
  try { observed = row === undefined ? null : JSON.parse(row.snapshot) as ControllerSnapshot; }
  catch (cause) { throw new SqliteAccessError("invalid-format", { database: controllerJournalFormat.name, file: db.name, phase: "archive-decode" }, { cause }); }
  if (!observed || !observed.nativeStopped || observed.lifecycle !== "stopped" || observed.sessionId !== ticket.sessionId || observed.executionGeneration !== ticket.executionGeneration || observed.controllerInstanceId !== ticket.controllerInstanceId || observed.executionId !== ticket.executionId || observed.claimId !== ticket.claimId || observed.testExecutionId !== ticket.testExecutionId) throw new Error("Session archive requires the original stopped controller generation.");
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

export const uploadStoppedControllerArchive = async (options: { journalPath: string; ticket: ControllerLaunchTicket; serverToken: string; request?: typeof fetch; signal?: AbortSignal }): Promise<SessionArchiveStatus> => {
  const { ticket, journalPath } = options;
  const fence = { sessionId: ticket.sessionId, ...sessionBinding(ticket), executionGeneration: ticket.executionGeneration, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId };
  const root = ticket.testExecutionId !== undefined ? `/api/v1/test-sessions/${ticket.sessionId}` : `/api/v1/projects/${ticket.projectId}/tasks/${ticket.taskId}/sessions/${ticket.sessionId}`;
  const request = options.request ?? fetch;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const call = async (method: string, body?: string): Promise<SessionArchiveStatus> => {
    const response = await request(`${ticket.serverOrigin}${root}/archive`, { method, redirect: "error", headers: { Authorization: `Bearer ${options.serverToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body }), signal });
    if (!response.ok) throw new Error(`Session archive request failed (${response.status}).`);
    return parseSessionArchiveStatus((await response.json() as { archive: unknown }).archive);
  };
  // Inspect the original schema and stop evidence without auto-upgrading first:
  // archive admission deliberately excludes v1 and unproven native generations.
  let original: Database.Database;
  try { original = new Database(journalPath, { readonly: true, fileMustExist: true }); }
  catch (cause) { throw new SqliteAccessError("invalid-format", { database: controllerJournalFormat.name, file: journalPath, phase: "archive-open" }, { cause, connectionClosed: true }); }
  const observed = withClosedJournal(original, () => original.transaction(() => stoppedSnapshot(original, ticket)).deferred());
  const receiptPath = `${journalPath}.archive-receipt-${ticket.executionGeneration}.json`;
  let receipt: SessionArchiveStatus | null = null;
  if (existsSync(receiptPath)) {
    receipt = parseSessionArchiveStatus(JSON.parse(readFileSync(receiptPath, "utf8")));
    if (receipt.state !== "ready") throw new Error("Invalid local archive receipt.");
    const current = await call("GET");
    if (current.state === "ready") {
      if (current.sha256 !== receipt.sha256 || current.byteLength !== receipt.byteLength) throw new Error("Server archive differs from the confirmed receipt.");
      return current;
    }
  }
  let body: string;
  try {
    const assertOriginal = (db: Database.Database): void => {
      if (JSON.stringify(stoppedSnapshot(db, ticket)) !== JSON.stringify(observed)) throw new Error("The stopped controller evidence changed before archival.");
    };
    const db = openSqliteDatabase({ file: journalPath, format: controllerJournalFormat, allowCreate: false,
      assertMigrationAllowed: (db, source) => { assertOriginal(db); assertJournalMigrationAllowed(db, source); },
      onReady: assertOriginal,
    });
    const archive = withClosedJournal(db, () => runSqliteImmediate(db, () => {
      assertCurrentSqlite(db, controllerJournalFormat);
      assertOriginal(db);
      if (!existsSync(`${journalPath}.pending-content/manifest.json`)) throw new Error("Pending archive source is missing.");
      const content = openPendingContent(journalPath, ticket.sessionId);
      reconcilePendingContent(db, content);
      const gap = db.prepare("SELECT projection_gap,archive_incomplete FROM execution WHERE id=1").get() as { projection_gap: string | null; archive_incomplete: number };
      if (gap.archive_incomplete !== 0 || gap.projection_gap !== null && gap.projection_gap !== "Recovered pending timeline requires full relay resynchronization.") throw new Error("Pending archive has an unresolved projection gap.");
      return parseSessionArchive({ schemaVersion: 1, ...fence, provider: ticket.provider, nativeSessionId: observed.nativeSessionId, entries: [...content.entries.values()].sort((a,b) => BigInt(a.entrySeq) < BigInt(b.entrySeq) ? -1 : 1), resources: [...content.resources.values()].sort((a,b) => a.resource.resourceId.localeCompare(b.resource.resourceId)) });
    }));
    await verifySessionArchiveResources(archive);
    body = JSON.stringify(archive);
  } catch (error) {
    await call("POST", JSON.stringify({ ...fence, state: "failed", errorCode: "archive_incomplete" })).catch(() => {});
    throw error;
  }
  const sha256 = createHash("sha256").update(body).digest("hex"), byteLength = String(Buffer.byteLength(body));
  const matches = (status: SessionArchiveStatus) => status.state === "ready" && status.sha256 === sha256 && status.byteLength === byteLength;
  if (receipt && !matches(receipt)) throw new Error("Archive receipt does not match the original content.");
  try {
    const current = await call("GET");
    if (current.state === "ready") {
      if (!matches(current)) throw new Error("Server archive differs from the stopped execution.");
      writeDurableJson(receiptPath, current); return current;
    }
    await call("POST", JSON.stringify({ ...fence, state: "pending", errorCode: null }));
    const uploaded = await call("PUT", body);
    if (!matches(uploaded)) throw new Error("Session archive upload was not confirmed with matching integrity.");
    writeDurableJson(receiptPath, uploaded); return uploaded;
  } catch (error) {
    await call("POST", JSON.stringify({ ...fence, state: "failed", errorCode: "upload_failed" })).catch(() => {});
    throw error;
  }
};
