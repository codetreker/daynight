import type Database from "better-sqlite3";
import { closeSqliteDatabase, openSqliteDatabase, runSqliteImmediate, sqliteTransactionOutcome } from "../../platform/sqlite-access.js";
import type { SqliteOutcome } from "../../platform/sqlite-error.js";
import { assertCurrentSqlite } from "../../platform/sqlite-format.js";
import { assertResumeLeaseMigrationAllowed, nativeResumeLeaseFormat } from "./resume-lease-format.js";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalId } from "../../api/parse.js";
import type { CliContext } from "../../cli/context.js";
import { normalizeServerUrl } from "../../config/server.js";
import { parseRegistrationResponse } from "../../session/controller-protocol.js";
import type { SessionProvider } from "../../session/protocol.js";
import { controllerExecutionDirectory, readLaunchTicket, type ControllerLaunchTicket } from "./launch-ticket.js";
import { readControllerSnapshot, type ControllerSnapshot } from "./lifecycle-store.js";
import { captureProcessProof, confirmControllerProcessesStopped } from "./process-proof.js";

export type ResumeLease = { ticket: ControllerLaunchTicket; nativeSessionId: string; release(): Promise<void> };
type LocalExecution = { ticket: ControllerLaunchTicket; snapshot: ControllerSnapshot | null };
const uuid = (value: unknown): value is string => typeof value === "string" && canonicalId(value) === value;
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const privateFile = async (file: string): Promise<void> => {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error("Controller recovery evidence must be a private regular file.");
};
const inventory = async (home: string): Promise<LocalExecution[]> => {
  let files: string[];
  try { files = await readdir(path.join(home, ".daynight", "controller", "launches")); }
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
    try { await privateFile(file); snapshot = readControllerSnapshot(file); }
    catch (error) { if (!missing(error)) throw error; }
    if (snapshot && (snapshot.executionId !== ticket.executionId || snapshot.sessionId !== ticket.sessionId || snapshot.testExecutionId !== ticket.testExecutionId || snapshot.claimId !== ticket.claimId || snapshot.executionGeneration !== ticket.executionGeneration || snapshot.controllerInstanceId !== ticket.controllerInstanceId || snapshot.nativeSessionId !== null && !uuid(snapshot.nativeSessionId))) throw new Error("Controller journal does not match its latest launch ticket.");
    result.push({ ticket, snapshot });
  }
  return result;
};
const assertStopped = async ({ snapshot }: LocalExecution): Promise<void> => {
  if (!snapshot || snapshot.lifecycle !== "stopped" || !snapshot.nativeStopped || !snapshot.stoppedAt || !Number.isFinite(Date.parse(snapshot.stoppedAt)) || !snapshot.controllerProcess || !Array.isArray(snapshot.nativeProcesses)) throw new Error("The original native execution is not proven stopped; reconcile its controller evidence before resuming.");
  if (!await confirmControllerProcessesStopped(snapshot.controllerProcess, snapshot.nativeProcesses)) throw new Error("The original controller or native descendants are still running.");
};
const get = async (config: { serverUrl: string; serverToken: string }, resource: string): Promise<unknown> => {
  const response = await fetch(`${config.serverUrl}${resource}`, { headers: { authorization: `Bearer ${config.serverToken}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Resume authorization failed with HTTP ${response.status}.`); }
  const chunks: Uint8Array[] = []; let size = 0;
  if (response.body) { const reader = response.body.getReader(); try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 2_097_152) { await reader.cancel(); throw new Error("Resume response exceeds its safe bound."); } chunks.push(item.value); } } finally { reader.releaseLock(); } }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};

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
  const directory = path.join(home, ".daynight", "controller"); await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const file = path.join(directory, "native-resume-leases.sqlite");
  try { const created = await open(file, "wx", 0o600); await created.close(); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  await privateFile(file);
  const key = createHash("sha256").update(JSON.stringify([input.provider, nativeHome, nativeSessionId])).digest("hex"), nonce = randomUUID(), processProof = await captureProcessProof(process.pid);
  let db: Database.Database | undefined, acquired = false;
  const close = (outcome: SqliteOutcome = "unknown"): void => { if (db !== undefined && db.open) closeSqliteDatabase(db, { file, format: nativeResumeLeaseFormat }, outcome); };
  const release = async (): Promise<void> => {
    if (!acquired) { close("committed"); return; }
    let failed = false, failure: unknown;
    try {
      runSqliteImmediate(db!, () => {
        assertCurrentSqlite(db!, nativeResumeLeaseFormat);
        const changed = db!.prepare("DELETE FROM leases WHERE native_key=? AND nonce=?").run(key, nonce);
        if (changed.changes !== 1) throw new Error("Native resume lease ownership changed; reconciliation is required.");
      });
      acquired = false;
    } catch (cause) { failed = true; failure = cause; }
    try { close(failed ? sqliteTransactionOutcome(failure) : "committed"); }
    catch (cleanup) { if (failed) throw new AggregateError([failure, cleanup], "Native resume lease release and shutdown failed."); throw cleanup; }
    if (failed) throw failure;
  };
  try {
    db = openSqliteDatabase({ file, format: nativeResumeLeaseFormat, allowEmpty: true,
      assertMigrationAllowed: assertResumeLeaseMigrationAllowed,
      onReady: (db) => {
        if (db.prepare("SELECT native_key FROM leases WHERE native_key=?").get(key)) throw new Error("This native session already has a resume lease. Confirm and reconcile its original execution; an expired or missing launcher is not permission to replace it.");
        db.prepare("INSERT INTO leases VALUES(?,?,?,?,?)").run(key, nonce, ticket.sessionId, JSON.stringify(processProof), new Date().toISOString());
      },
    });
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
    try { if (acquired) await release(); else close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Native resume preparation and cleanup failed."); }
    throw error;
  }
};
