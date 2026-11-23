import Database from "better-sqlite3";
import { closeSqliteDatabase, openSqliteDatabase, runSqliteImmediate, sqliteTransactionOutcome } from "../../platform/sqlite-access.js";
import { SqliteAccessError, type SqliteOutcome } from "../../platform/sqlite-error.js";
import { assertCurrentSqlite, inspectSqlite, type SqliteSource } from "../../platform/sqlite-format.js";
import { sqliteFilename } from "../../platform/sqlite-filename.js";
import { assertResumeLeaseMigrationAllowed, nativeResumeLeaseFormat } from "./resume-lease-format.js";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalId } from "../../api/parse.js";
import type { CliContext } from "../../cli/context.js";
import { resolveConfigurationPaths } from "../../config/paths.js";
import { normalizeServerUrl } from "../../config/server.js";
import { parseRegistrationResponse } from "../../session/controller-protocol.js";
import type { SessionProvider } from "../../session/protocol.js";
import { controllerExecutionDirectory, readLaunchTicket, type ControllerLaunchTicket } from "./launch-ticket.js";
import { readControllerSnapshot, readCurrentControllerInventorySnapshot, readProvenWindowsStoppedControllerGeneration, type ControllerSnapshot } from "./lifecycle-store.js";
import { controllerJournalFormat } from "./journal-format.js";
import { captureProcessProof, confirmControllerProcessesStopped } from "./process-proof.js";

export type ResumeLease = { ticket: ControllerLaunchTicket; nativeSessionId: string; release(): Promise<void> };
type LocalExecution = { ticket: ControllerLaunchTicket; snapshot: ControllerSnapshot | null; file: string };
const uuid = (value: unknown): value is string => typeof value === "string" && canonicalId(value) === value;
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const privateFile = async (file: string): Promise<void> => {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error("Controller recovery evidence must be a private regular file.");
};
const inventorySnapshot = (file: string, ticket: ControllerLaunchTicket): ControllerSnapshot | null => {
  const db = new Database(sqliteFilename(file), { readonly: true, fileMustExist: true });
  let source: SqliteSource | undefined, failure: unknown, failed = false;
  try { source = db.transaction(() => inspectSqlite(db, controllerJournalFormat)).deferred(); }
  catch (cause) { failed = true; failure = cause; }
  try { closeSqliteDatabase(db, { file, format: controllerJournalFormat }, "not-started"); }
  catch (cause) { throw failed ? new AggregateError([failure, cause], "Controller resume inventory inspection and close failed.", { cause: failure }) : cause; }
  if (failed) throw failure;
  // Inventory must not migrate unrelated live writers. Earlier formats retain
  // the existing permit-owned migration path for their stopped journals.
  if (source!.kind === "current" || source!.kind === "outdated" && source!.version === 16)
    return readCurrentControllerInventorySnapshot(file, [ticket], Date.now() + 5000)?.snapshot ?? null;
  return readControllerSnapshot(file);
};
const inventory = async (home: string): Promise<LocalExecution[]> => {
  let files: string[];
  try { files = await readdir(path.join(resolveConfigurationPaths(home).stateDirectory, "controller", "launches")); }
  catch (error) { if (missing(error)) return []; throw error; }
  if (files.length > 20_000) throw new Error("Controller launch inventory exceeds its safe bound.");
  const tickets = new Map<string, ControllerLaunchTicket>();
  for (const file of files) {
    if (!file.endsWith(".json") || !uuid(file.slice(0, -5))) continue;
    const ticket = await readLaunchTicket(home, file.slice(0, -5));
    const previous = tickets.get(ticket.executionId);
    if (!previous || BigInt(ticket.executionGeneration) > BigInt(previous.executionGeneration)) tickets.set(ticket.executionId, ticket);
    else if (ticket.executionGeneration === previous.executionGeneration && ticket.launchId !== previous.launchId) throw new Error("Conflicting controller launch identities require reconciliation.");
  }
  const result: LocalExecution[] = [];
  for (const ticket of tickets.values()) {
    const file = path.join(controllerExecutionDirectory(home, ticket.executionId), "journal.sqlite");
    let snapshot: ControllerSnapshot | null = null;
    try { await privateFile(file); snapshot = inventorySnapshot(file, ticket); }
    catch (error) { if (!missing(error)) throw error; }
    if (snapshot && (snapshot.executionId !== ticket.executionId || snapshot.sessionId !== ticket.sessionId || snapshot.testExecutionId !== ticket.testExecutionId || snapshot.claimId !== ticket.claimId || snapshot.executionGeneration !== ticket.executionGeneration || snapshot.controllerInstanceId !== ticket.controllerInstanceId || snapshot.nativeSessionId !== null && !uuid(snapshot.nativeSessionId))) throw new Error("Controller journal does not match its latest launch ticket.");
    result.push({ ticket, snapshot, file });
  }
  return result;
};
const assertStopped = async ({ ticket, snapshot, file }: LocalExecution): Promise<void> => {
  if (!snapshot || snapshot.lifecycle !== "stopped" || !snapshot.nativeStopped || !snapshot.stoppedAt || !Number.isFinite(Date.parse(snapshot.stoppedAt)) || !snapshot.controllerProcess || !Array.isArray(snapshot.nativeProcesses)) throw new Error("The original native execution is not proven stopped; reconcile its controller evidence before resuming.");
  if (process.platform === "win32") {
    const proven = readProvenWindowsStoppedControllerGeneration(file, ticket);
    if (JSON.stringify(proven) !== JSON.stringify(snapshot)) throw new Error("The original controller evidence changed during resume verification.");
    return;
  }
  if (!await confirmControllerProcessesStopped(snapshot.controllerProcess, snapshot.nativeProcesses)) throw new Error("The original controller or native descendants are still running.");
};
const get = async (config: { serverUrl: string; serverToken: string }, resource: string): Promise<unknown> => {
  const response = await fetch(`${config.serverUrl}${resource}`, { headers: { authorization: `Bearer ${config.serverToken}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Resume authorization failed with HTTP ${response.status}.`); }
  const chunks: Uint8Array[] = []; let size = 0;
  if (response.body) { const reader = response.body.getReader(); try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 2_097_152) { await reader.cancel(); throw new Error("Resume response exceeds its safe bound."); } chunks.push(item.value); } } finally { reader.releaseLock(); } }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};

const leaseTransaction = (db: Database.Database, file: string, phase: string, action: () => void): void => {
  let actionFailed = false, actionFailure: unknown;
  try {
    runSqliteImmediate(db, () => {
      try { assertCurrentSqlite(db, nativeResumeLeaseFormat); action(); }
      catch (cause) { actionFailed = true; actionFailure = cause; throw cause; }
    });
  } catch (cause) {
    const outcome = sqliteTransactionOutcome(cause);
    const sqliteError = cause instanceof Error && "code" in cause && typeof cause.code === "string" && cause.code.startsWith("SQLITE_");
    if (cause instanceof SqliteAccessError) throw new SqliteAccessError(cause.kind, cause.context, { cause, outcome, connectionClosed: false });
    if (!actionFailed || cause !== actionFailure || sqliteError) throw new SqliteAccessError("operation-failed", { database: nativeResumeLeaseFormat.name, file, phase }, { cause, outcome });
    throw cause;
  }
};

const closedLeaseFailure = (failure: unknown, closed: boolean): unknown => failure instanceof SqliteAccessError
  ? new SqliteAccessError(failure.kind, failure.context, { cause: failure.cause, outcome: failure.outcome, connectionClosed: closed })
  : failure;

/** Acquire one stopped local Test Session's native writer. The caller releases
 * the lease only after proving its new controller and descendants stopped; an
 * uncertain stop deliberately retains the lease for explicit reconciliation. */
export const acquireResume = async (input: { provider: SessionProvider; sessionId?: string }, context: CliContext, config: { serverUrl: string; serverToken: string }): Promise<ResumeLease> => {
  if (normalizeServerUrl(config.serverUrl) !== config.serverUrl || !config.serverToken) throw new Error("Resume requires a canonical configured server and authenticated token.");
  if (input.sessionId !== undefined && !uuid(input.sessionId)) throw new Error("Resume requires a canonical Daynight Test Session ID, not a native session ID.");
  const home = context.homeDirectory(), cwd = await realpath(context.workingDirectory());
  const records = await inventory(home), candidates: LocalExecution[] = [];
  for (const record of records) {
    const { ticket, snapshot } = record;
    if (!ticket.testExecutionId || ticket.provider !== input.provider || ticket.serverOrigin !== config.serverUrl || !snapshot?.nativeSessionId || snapshot.lifecycle !== "stopped" || !snapshot.nativeStopped) continue;
    if (await realpath(ticket.cwd).catch(() => null) === cwd) candidates.push(record);
  }
  candidates.sort((a, b) => Date.parse(b.snapshot!.stoppedAt ?? b.ticket.createdAt) - Date.parse(a.snapshot!.stoppedAt ?? a.ticket.createdAt));
  let sessionId = input.sessionId;
  if (!sessionId) {
    if (!candidates.length) throw new Error("No stopped local Test Sessions match this provider, server and current directory.");
    if (!context.prompt?.isInteractive) {
      context.stdout(candidates.map(({ ticket, snapshot }) => `${ticket.sessionId}  ${ticket.provider}  ${snapshot!.stoppedAt ?? ticket.createdAt}\n`).join(""));
      throw new Error("Choose a Test Session ID: daynight controller " + input.provider + " resume <session-id>.");
    }
    sessionId = await context.prompt.select({ message: "Resume a stopped Test Session", choices: candidates.map(({ ticket, snapshot }) => ({ name: `${ticket.sessionId} · ${snapshot!.stoppedAt ?? ticket.createdAt}`, value: ticket.sessionId })), default: candidates[0]!.ticket.sessionId }, new AbortController().signal);
  }
  const selected = candidates.find(item => item.ticket.sessionId === sessionId);
  if (!selected) throw new Error("No stopped local Test Session matches that ID, provider, server and current directory.");
  const { ticket, snapshot } = selected, nativeSessionId = snapshot!.nativeSessionId!, nativeHome = await realpath(ticket.nativeHome);
  if (!(await lstat(nativeHome)).isDirectory()) throw new Error("The original native home is not a directory.");
  await assertStopped(selected);
  const me = await get(config, "/api/v1/me");
  if (!me || typeof me !== "object" || !("id" in me) || me.id !== ticket.ownerUserId) throw new Error("The configured account does not own the original Test Session.");
  const session = parseRegistrationResponse(await get(config, `/api/v1/test-sessions/${ticket.sessionId}`)).session;
  if (session.sessionId !== ticket.sessionId || session.testExecutionId !== ticket.testExecutionId || session.executionGeneration !== ticket.executionGeneration || session.identity.ownerUserId !== ticket.ownerUserId || session.identity.controllerId !== ticket.controllerId || session.identity.controllerInstanceId !== ticket.controllerInstanceId || session.identity.provider !== ticket.provider || session.identity.nativeSessionId !== nativeSessionId || session.lifecycle !== "archived") throw new Error("The original server Test Session does not confirm the local stopped native identity and owner.");
  const directory = path.join(resolveConfigurationPaths(home).stateDirectory, "controller"); await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const file = path.join(directory, "native-resume-leases.sqlite");
  try { const created = await open(file, "wx", 0o600); await created.close(); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  await privateFile(file);
  const key = createHash("sha256").update(JSON.stringify([input.provider, nativeHome, nativeSessionId])).digest("hex"), nonce = randomUUID(), processProof = await captureProcessProof(process.pid);
  let db: Database.Database | undefined, acquired = false, outcome: SqliteOutcome = "not-started";
  const close = (outcome: SqliteOutcome = "unknown"): void => { if (db !== undefined && db.open) closeSqliteDatabase(db, { file, format: nativeResumeLeaseFormat }, outcome); };
  const release = async (): Promise<void> => {
    if (!acquired) { close("committed"); return; }
    let failed = false, failure: unknown;
    try {
      leaseTransaction(db!, file, "lease-release", () => {
        const changed = db!.prepare("DELETE FROM leases WHERE native_key=? AND nonce=?").run(key, nonce);
        if (changed.changes !== 1) throw new Error("Native resume lease ownership changed; reconciliation is required.");
      });
      acquired = false;
    } catch (cause) { failed = true; failure = cause; }
    const releaseOutcome = failed ? failure instanceof SqliteAccessError ? failure.outcome : sqliteTransactionOutcome(failure) : "committed";
    try { close(releaseOutcome); }
    catch (cleanup) { throw new SqliteAccessError("cleanup-failed", { database: nativeResumeLeaseFormat.name, file, phase: "lease-release-close" }, { cause: failed ? new AggregateError([failure, cleanup], "Native resume lease release and shutdown failed.") : cleanup, outcome: releaseOutcome, connectionClosed: db === undefined || !db.open }); }
    if (failed) throw closedLeaseFailure(failure, db === undefined || !db.open);
  };
  try {
    db = openSqliteDatabase({ file, format: nativeResumeLeaseFormat, allowCreate: true,
      assertMigrationAllowed: assertResumeLeaseMigrationAllowed,
    });
    try {
      leaseTransaction(db, file, "lease-acquire", () => {
        if (db!.prepare("SELECT native_key FROM leases WHERE native_key=?").get(key)) throw new Error("This native session already has a resume lease. Confirm and reconcile its original execution; an expired or missing launcher is not permission to replace it.");
        db!.prepare("INSERT INTO leases VALUES(?,?,?,?,?)").run(key, nonce, ticket.sessionId, JSON.stringify(processProof), new Date().toISOString());
      });
      outcome = "committed";
    } catch (cause) { outcome = cause instanceof SqliteAccessError ? cause.outcome : sqliteTransactionOutcome(cause); throw cause; }
    acquired = true;
    // Another continuation may have been launched since selection. Reinspect
    // every execution for this native identity while the shared lease is held.
    for (const item of await inventory(home)) {
      if (item.ticket.provider !== input.provider || (item.snapshot?.nativeSessionId ?? item.ticket.resumeNativeSessionId) !== nativeSessionId) continue;
      if (await realpath(item.ticket.nativeHome) !== nativeHome) continue;
      await assertStopped(item);
    }
    return { ticket: { ...ticket, cwd, nativeHome }, nativeSessionId, release };
  } catch (error) {
    try {
      if (acquired) await release();
      else close(outcome);
    }
    catch (cleanup) { throw new SqliteAccessError("cleanup-failed", { database: nativeResumeLeaseFormat.name, file, phase: "lease-acquire-close" }, { cause: new AggregateError([error, cleanup], "Native resume preparation and cleanup failed."), outcome: cleanup instanceof SqliteAccessError ? cleanup.outcome : acquired ? sqliteTransactionOutcome(cleanup) : outcome, connectionClosed: db === undefined ? error instanceof SqliteAccessError && error.connectionClosed : !db.open }); }
    throw db === undefined ? error : closedLeaseFailure(error, !db.open);
  }
};
