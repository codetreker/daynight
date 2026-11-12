import Database from "better-sqlite3";
import { ControllerBootstrapReplacedError } from "./bootstrap-error.js";
export { ControllerBootstrapReplacedError } from "./bootstrap-error.js";
import { canonicalId } from "../../api/parse.js";
import { sqliteDatabaseIsMissing, closeSqliteDatabase } from "../../platform/sqlite-access.js";
import { inspectSqlite } from "../../platform/sqlite-format.js";
import { SqliteAccessError } from "../../platform/sqlite-error.js";
import { controllerJournalFormat } from "./journal-format.js";
import { controllerPayloadHash, type ControllerLaunchTicket } from "./launch-ticket.js";
import { ControllerIpcIdentityConflictError, ControllerIpcOutcomeUnknownError, requestController } from "./local-client.js";
import { parseStartupObservation } from "../../session/startup.js";
import type { ControllerSnapshot } from "./lifecycle-store.js";
import { inspectBootstrapProcessProof, type ProcessProof } from "./process-proof.js";
import { WindowsProcessProofError, stopWindowsBootstrapProcess } from "./windows-process-proof.js";
import { acquireControllerStoragePermit, controllerStorageConnectionIsOpen, isControllerStorageLockHeld } from "./storage-lock.js";
import { ControllerStorageWaitingError } from "./storage-preparation.js";

export type ControllerLaunchObservation =
  | { kind: "observed"; snapshot: ControllerSnapshot }
  | { kind: "running-unobserved"; process: ProcessProof }
  | { kind: "controller-exited"; process: ProcessProof; snapshot: ControllerSnapshot }
  | { kind: "pre-writer-exited"; process: ProcessProof; journal: "missing" | "preceding-generation" }
  | { kind: "unknown"; cause: unknown };

export class ControllerLaunchJournalConflictError extends Error {}

export class ControllerLaunchJournalObservationError extends AggregateError {
  constructor(ipcFailure: unknown, readonly journalCause: unknown) {
    super([ipcFailure, journalCause], `Controller launch journal observation failed: ${journalCause instanceof Error ? journalCause.message : String(journalCause)}`, { cause: journalCause });
  }
}

/** A retained snapshot may be used for bounded cleanup only after a pure journal I/O failure. */
export const isControllerJournalIoFailure = (error: unknown): boolean => {
  if (!(error instanceof ControllerLaunchJournalObservationError)) return false;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 16 || value === null || typeof value !== "object" || ancestors.has(value)) return false;
    if (value instanceof ControllerLaunchJournalConflictError || value instanceof SqliteAccessError && (value.kind === "invalid-format" || value.kind === "unsupported-version")) return false;
    ancestors.add(value);
    const code = "code" in value ? value.code : undefined;
    const allowed = typeof code === "string" && /^(?:SQLITE_(?:BUSY|LOCKED|IOERR|CANTOPEN|PERM|READONLY|FULL)(?:_[A-Z0-9_]+)?|E(?:ACCES|PERM|IO|MFILE|NFILE|NOSPC|NOENT))$/.test(code);
    if (code !== undefined && !allowed) { ancestors.delete(value); return false; }
    const children: unknown[] = value instanceof AggregateError ? [...value.errors] : [];
    if (value instanceof Error && value.cause !== undefined && !children.includes(value.cause)) children.push(value.cause);
    const result = (allowed || children.length > 0) && children.every(child => visit(child, depth + 1));
    ancestors.delete(value);
    return result;
  };
  return visit(error.journalCause, 0);
};

/** A later successful journal read cannot erase an earlier conflicting or unclassified journal failure. */
export const hasUnsafeControllerObservationFailure = (error: unknown): boolean => {
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): boolean => {
    if (value === null || typeof value !== "object") return false;
    if (depth > 16 || ancestors.has(value)) return true;
    if (value instanceof ControllerStorageWaitingError) return false;
    if (value instanceof ControllerLaunchJournalConflictError || value instanceof ControllerIpcIdentityConflictError) return true;
    if (value instanceof ControllerLaunchJournalObservationError && !isControllerJournalIoFailure(value)) return true;
    ancestors.add(value);
    const children: unknown[] = value instanceof AggregateError ? [...value.errors] : [];
    if (value instanceof Error && value.cause !== undefined && !children.includes(value.cause)) children.push(value.cause);
    const unsafe = children.some(child => visit(child, depth + 1));
    ancestors.delete(value);
    return unsafe;
  };
  return visit(error, 0);
};

// Read the version, binding and snapshot in one short, read-only transaction.
// A bootstrap observation must never initialize or migrate the original journal.
const readExitedJournal = (file: string, ticket: ControllerLaunchTicket, process: ProcessProof, timeoutMs: number): ControllerLaunchObservation => {
  if (sqliteDatabaseIsMissing(file)) return { kind: "pre-writer-exited", process, journal: "missing" };
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: timeoutMs });
  let result: ControllerLaunchObservation | undefined, failure: unknown, failed = false;
  try {
    result = db.transaction(() => {
      const source = inspectSqlite(db, controllerJournalFormat);
      if (source.kind === "empty") return { kind: "pre-writer-exited", process, journal: "missing" } as const;
      if (source.kind !== "current") throw new ControllerLaunchJournalConflictError("Controller launch journal is not in the current format.");
      const row = db.prepare("SELECT ticket_hash, snapshot FROM execution WHERE id=1").get() as { ticket_hash: string; snapshot: string } | undefined;
      if (row === undefined) return { kind: "pre-writer-exited", process, journal: "missing" } as const;
      const snapshot = JSON.parse(row.snapshot) as ControllerSnapshot;
      if (snapshot === null || typeof snapshot !== "object" || snapshot.executionId !== ticket.executionId || snapshot.sessionId !== ticket.sessionId || snapshot.claimId !== ticket.claimId || snapshot.testExecutionId !== ticket.testExecutionId || typeof snapshot.executionGeneration !== "string" || !/^[1-9][0-9]{0,18}$/.test(snapshot.executionGeneration)) throw new ControllerLaunchJournalConflictError("Controller launch journal identity conflict.");
      const validId = (value: unknown) => typeof value === "string" && canonicalId(value) === value;
      const validProof = (proof: ProcessProof) => proof !== null && typeof proof === "object" && Number.isSafeInteger(proof.pid) && proof.pid > 0 && proof.pid <= 2_147_483_647 && Number.isSafeInteger(proof.parentPid) && proof.parentPid >= 0 && (proof.processGroupId === null || Number.isSafeInteger(proof.processGroupId) && proof.processGroupId > 0) && typeof proof.startedAt === "string" && proof.startedAt.trim() !== "" && typeof proof.commandHash === "string" && /^[a-f0-9]{64}$/.test(proof.commandHash) && (proof.jobObjectName === undefined || typeof proof.jobObjectName === "string" && proof.jobObjectName.trim() !== "" && !proof.jobObjectName.includes("\0"));
      if (!validId(snapshot.controllerInstanceId) || BigInt(snapshot.executionGeneration) > 9_223_372_036_854_775_807n || !["starting", "ready", "working", "stopping", "stopped", "paused", "failed"].includes(snapshot.lifecycle) || !["initializing", "idle", "working", "waiting_input", "stopped", "unknown"].includes(snapshot.activity) || !["not_required", "not_submitted", "dispatching", "provider_accepted", "confirmed", "failed", "unknown"].includes(snapshot.initialInputState) || typeof snapshot.nativeStopped !== "boolean" || !Array.isArray(snapshot.nativeProcesses) || !snapshot.nativeProcesses.every(validProof) || !(snapshot.nativeSessionId === null || typeof snapshot.nativeSessionId === "string" && snapshot.nativeSessionId.trim() !== "" && snapshot.nativeSessionId.isWellFormed()) || !(snapshot.controllerProcess === null || validProof(snapshot.controllerProcess)) || !(snapshot.stoppedAt === null || typeof snapshot.stoppedAt === "string" && Number.isFinite(Date.parse(snapshot.stoppedAt))) || !(snapshot.error === null || typeof snapshot.error === "string")) throw new ControllerLaunchJournalConflictError("Controller launch journal snapshot format conflict.");
      if (snapshot.startup !== undefined) parseStartupObservation(snapshot.startup);
      if (snapshot.executionGeneration === ticket.executionGeneration) {
        if (snapshot.controllerInstanceId !== ticket.controllerInstanceId || row.ticket_hash !== controllerPayloadHash(ticket)) throw new ControllerLaunchJournalConflictError("Controller launch journal ticket or instance conflict.");
        const controller = snapshot.controllerProcess;
        if (controller !== null && (controller.pid !== process.pid || controller.startedAt !== process.startedAt || controller.commandHash !== process.commandHash || controller.processGroupId !== process.processGroupId || process.processGroupId === null && controller.parentPid !== process.parentPid || (process.jobObjectName !== undefined ? process.jobObjectName !== `Local\\Daynight-${ticket.launchId}` || controller.jobObjectName !== process.jobObjectName : controller.jobObjectName !== undefined && (process.processGroupId !== null || controller.jobObjectName !== `Local\\Daynight-${ticket.launchId}`)))) throw new ControllerLaunchJournalConflictError("Controller launch journal process identity conflict.");
        return { kind: "controller-exited", process, snapshot } as const;
      }
      if (BigInt(snapshot.executionGeneration) + 1n !== BigInt(ticket.executionGeneration) || snapshot.lifecycle !== "stopped" || snapshot.nativeStopped !== true || snapshot.nativeSessionId === null || snapshot.nativeSessionId !== ticket.resumeNativeSessionId) throw new ControllerLaunchJournalConflictError("Controller launch journal generation conflict.");
      return { kind: "pre-writer-exited", process, journal: "preceding-generation" } as const;
    }).deferred();
  } catch (error) { failed = true; failure = error; }
  try { closeSqliteDatabase(db, { file, format: controllerJournalFormat }, "not-started"); }
  catch (error) { if (failed) throw new AggregateError([failure, error], "Controller launch observation and journal close failed.", { cause: failure }); throw error; }
  if (failed) throw failure;
  return result!;
};

const journalOpenFailure = (error: unknown, code: "ENOENT" | "SQLITE_CANTOPEN"): boolean => {
  const seen = new Set<unknown>();
  const visit = (cause: unknown): boolean => {
    if (!(cause instanceof Error) || cause instanceof AggregateError || seen.has(cause)) return false;
    seen.add(cause);
    return "code" in cause && cause.code === code || visit(cause.cause);
  };
  return visit(error);
};

const exitedJournal = (file: string, ticket: ControllerLaunchTicket, process: ProcessProof, timeoutMs: number, requestedDeadline?: number): ControllerLaunchObservation => {
  const deadline = requestedDeadline === undefined ? Date.now() + timeoutMs : requestedDeadline;
  let permit: ReturnType<typeof acquireControllerStoragePermit>;
  for (;;) {
    if (sqliteDatabaseIsMissing(file)) return { kind: "pre-writer-exited", process, journal: "missing" };
    try { permit = acquireControllerStoragePermit(file, deadline, { fileMustExist: true }); break; }
    catch (cause) {
      if (cause instanceof Error && isControllerStorageLockHeld(cause)) throw new ControllerStorageWaitingError("lock_busy", cause);
      const missing = journalOpenFailure(cause, "ENOENT");
      if (missing || journalOpenFailure(cause, "SQLITE_CANTOPEN")) {
        if (sqliteDatabaseIsMissing(file)) return { kind: "pre-writer-exited", process, journal: "missing" };
        if (missing && Date.now() < deadline) continue;
      }
      throw cause;
    }
  }
  let result: ControllerLaunchObservation | undefined, failure: unknown, failed = false;
  try {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Controller launch journal observation exceeded its deadline.");
    result = readExitedJournal(file, ticket, process, Math.min(timeoutMs, remaining));
  }
  catch (cause) { failed = true; failure = cause; }
  try { if (!failed || !controllerStorageConnectionIsOpen(failure)) permit.release(); }
  catch (cause) { if (failed) throw new AggregateError([failure, cause], "Controller launch observation and storage release failed.", { cause: failure }); throw cause; }
  if (failed) throw failure;
  return result!;
};

export const reconcileSubmittedControllerLaunch = async (input: { journalFile: string; ticket: ControllerLaunchTicket; spawnProof: ProcessProof; signal: AbortSignal; deadline?: number }): Promise<ControllerLaunchObservation> => {
  if (input.deadline !== undefined && (!Number.isSafeInteger(input.deadline) || input.deadline <= 0)) throw new Error("Invalid controller observation deadline.");
  const check = () => {
    input.signal.throwIfAborted();
    if (input.deadline !== undefined && Date.now() >= input.deadline) throw new Error("Controller launch observation exceeded its deadline.");
  };
  const timeout = (maximum: number) => { check(); return Math.max(1, Math.min(maximum, input.deadline === undefined ? maximum : input.deadline - Date.now())); };
  const checkAfterFailure = (failure: unknown): void => {
    try { check(); }
    catch (interruption) {
      if (interruption === failure) throw failure;
      throw new AggregateError([failure, interruption], "Controller launch observation failed and was interrupted.", { cause: failure });
    }
  };
  const timeoutAfterFailure = (maximum: number, failure: unknown): number => {
    try { return timeout(maximum); }
    catch (interruption) { throw new AggregateError([failure, interruption], "Controller launch observation failed and was interrupted.", { cause: failure }); }
  };
  let ipcFailure: unknown, response: Awaited<ReturnType<typeof requestController>> | undefined;
  const ipcTimeout = timeout(2000);
  try { response = await requestController(input.ticket, { kind: "observe" }, { signal: input.signal, timeoutMs: ipcTimeout }); }
  catch (error) {
    checkAfterFailure(error);
    if (!(error instanceof ControllerIpcOutcomeUnknownError)) throw error;
    ipcFailure = error;
  }
  if (response === undefined) checkAfterFailure(ipcFailure); else check();
  if (response !== undefined) {
    if (response.snapshot.sessionId !== input.ticket.sessionId) throw new ControllerIpcIdentityConflictError("Controller IPC session identity mismatch.");
    return { kind: "observed", snapshot: response.snapshot };
  }
  let state: Awaited<ReturnType<typeof inspectBootstrapProcessProof>>, mismatch: { sameBirth: boolean } | undefined;
  const processTimeout = timeoutAfterFailure(5000, ipcFailure);
  try { state = await inspectBootstrapProcessProof(input.spawnProof, processTimeout, evidence => { mismatch = evidence; }); }
  catch (cause) {
    const failure = new AggregateError([ipcFailure, cause], "Controller IPC and process observation failed.", { cause });
    checkAfterFailure(failure);
    return { kind: "unknown", cause: failure };
  }
  checkAfterFailure(ipcFailure);
  if (state === "running" || state === "exiting") return { kind: "running-unobserved", process: input.spawnProof };
  // A different creation time proves the original instance has exited. It
  // permits journal observation but never an operation on the replacement.
  if (state === "replaced" && mismatch?.sameBirth !== false) return { kind: "unknown", cause: new AggregateError([ipcFailure, new Error("Controller bootstrap process identity was replaced.")], "Controller IPC and process observation failed.", { cause: ipcFailure }) };
  let result: ControllerLaunchObservation;
  const journalTimeout = timeoutAfterFailure(5000, ipcFailure);
  try { result = exitedJournal(input.journalFile, input.ticket, input.spawnProof, journalTimeout, input.deadline); }
  catch (cause) {
    if (cause instanceof ControllerStorageWaitingError) {
      checkAfterFailure(cause);
      throw new ControllerStorageWaitingError(cause.reason, new AggregateError([ipcFailure, cause], "Controller launch observation awaits storage maintenance.", { cause }));
    }
    const failure = new ControllerLaunchJournalObservationError(ipcFailure, cause);
    checkAfterFailure(failure);
    throw failure;
  }
  checkAfterFailure(ipcFailure);
  return result;
};

export const stopControllerBootstrap = async (proof: ProcessProof, deadline: number): Promise<void> => {
  if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new Error("Invalid controller bootstrap deadline.");
  if (Date.now() >= deadline) throw new Error("Controller bootstrap stop exceeded its deadline.");
  if (process.platform === "win32") {
    try { return await stopWindowsBootstrapProcess(proof, deadline); }
    catch (error) {
      // ERROR_INVALID_PARAMETER means the PID may have disappeared before open.
      // Only a separate liveness check can establish that no process remains.
      if (!(error instanceof WindowsProcessProofError) || error.stage !== "open-process" || error.code !== 87 || Date.now() >= deadline) throw error;
      let mismatch: { sameBirth: boolean } | undefined;
      const state = await inspectBootstrapProcessProof(proof, Math.max(1, Math.min(5000, deadline - Date.now())), evidence => { mismatch = evidence; });
      if (Date.now() >= deadline) throw error;
      if (state === "stopped") return;
      if (state === "replaced" && mismatch?.sameBirth === false) throw new ControllerBootstrapReplacedError(undefined, { cause: error });
      throw error;
    }
  }
  let uncertainty: Error | undefined;
  const deadlineError = () => new Error("Controller bootstrap stop exceeded its deadline.", uncertainty === undefined ? {} : { cause: uncertainty });
  const remaining = () => { if (Date.now() >= deadline) throw deadlineError(); };
  const check = async (): Promise<"running" | "stopped" | "exiting" | "uncertain"> => {
    remaining();
    let mismatch: { sameBirth: boolean; sameParent: boolean; sameGroup: boolean } | undefined;
    let state: Awaited<ReturnType<typeof inspectBootstrapProcessProof>>;
    try { state = await inspectBootstrapProcessProof(proof, Math.max(1, Math.min(5000, deadline - Date.now())), evidence => { mismatch = evidence; }); }
    catch (cause) {
      if (Date.now() >= deadline || uncertainty !== undefined) throw new AggregateError(uncertainty === undefined ? [cause] : [uncertainty, cause], Date.now() >= deadline ? "Controller bootstrap observation failed at its deadline." : "Controller bootstrap identity and process observation are uncertain.", { cause });
      throw cause;
    }
    const conflict = state === "replaced" ? new Error(`Controller bootstrap process identity conflicts (${JSON.stringify(mismatch)}).`) : undefined;
    if (Date.now() >= deadline && conflict !== undefined) uncertainty = conflict;
    remaining();
    if (state === "replaced") {
      if (mismatch?.sameBirth === false) throw new ControllerBootstrapReplacedError(conflict!.message);
      if (mismatch?.sameBirth === true && mismatch.sameParent && mismatch.sameGroup) {
        uncertainty = conflict;
        return "uncertain";
      }
      throw conflict;
    }
    uncertainty = undefined;
    return state;
  };
  let gracefulUntil: number | undefined, killed = false;
  while (Date.now() < deadline) {
    const state = await check();
    if (state === "stopped") return;
    if (state === "running" && (!killed && (gracefulUntil === undefined || Date.now() >= gracefulUntil))) {
      const value = gracefulUntil === undefined ? "SIGTERM" : "SIGKILL";
      try { process.kill(proof.pid, value); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return; throw error; }
      if (value === "SIGTERM") gracefulUntil = Date.now() + 2000;
      else killed = true;
    }
    const delay = Math.min(25, Math.max(0, deadline - Date.now()), gracefulUntil !== undefined && !killed && gracefulUntil > Date.now() ? gracefulUntil - Date.now() : 25);
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw deadlineError();
};
