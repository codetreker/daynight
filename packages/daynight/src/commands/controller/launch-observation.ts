import Database from "better-sqlite3";
import { ControllerBootstrapReplacedError } from "./bootstrap-error.js";
export { ControllerBootstrapReplacedError } from "./bootstrap-error.js";
import { canonicalId } from "../../api/parse.js";
import { sqliteDatabaseIsMissing, closeSqliteDatabase } from "../../platform/sqlite-access.js";
import { inspectSqlite } from "../../platform/sqlite-format.js";
import { controllerJournalFormat } from "./journal-format.js";
import { controllerPayloadHash, type ControllerLaunchTicket } from "./launch-ticket.js";
import { ControllerIpcOutcomeUnknownError, requestController } from "./local-client.js";
import { parseStartupObservation } from "../../session/startup.js";
import type { ControllerSnapshot } from "./lifecycle-store.js";
import { inspectBootstrapProcessProof, type ProcessProof } from "./process-proof.js";
import { WindowsProcessProofError, stopWindowsBootstrapProcess } from "./windows-process-proof.js";

export type ControllerLaunchObservation =
  | { kind: "observed"; snapshot: ControllerSnapshot }
  | { kind: "running-unobserved"; process: ProcessProof }
  | { kind: "controller-exited"; process: ProcessProof; snapshot: ControllerSnapshot }
  | { kind: "pre-writer-exited"; process: ProcessProof; journal: "missing" | "preceding-generation" }
  | { kind: "unknown"; cause: unknown };

// Read the version, binding and snapshot in one short, read-only transaction.
// A bootstrap observation must never initialize or migrate the original journal.
const exitedJournal = (file: string, ticket: ControllerLaunchTicket, process: ProcessProof, timeoutMs: number): ControllerLaunchObservation => {
  if (sqliteDatabaseIsMissing(file)) return { kind: "pre-writer-exited", process, journal: "missing" };
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: timeoutMs });
  let result: ControllerLaunchObservation | undefined, failure: unknown, failed = false;
  try {
    result = db.transaction(() => {
      const source = inspectSqlite(db, controllerJournalFormat);
      if (source.kind === "empty") return { kind: "pre-writer-exited", process, journal: "missing" } as const;
      if (source.kind !== "current") throw new Error("Controller launch journal is not in the current format.");
      const row = db.prepare("SELECT ticket_hash, snapshot FROM execution WHERE id=1").get() as { ticket_hash: string; snapshot: string } | undefined;
      if (row === undefined) return { kind: "pre-writer-exited", process, journal: "missing" } as const;
      const snapshot = JSON.parse(row.snapshot) as ControllerSnapshot;
      if (snapshot === null || typeof snapshot !== "object" || snapshot.executionId !== ticket.executionId || snapshot.sessionId !== ticket.sessionId || snapshot.claimId !== ticket.claimId || snapshot.testExecutionId !== ticket.testExecutionId || typeof snapshot.executionGeneration !== "string" || !/^[1-9][0-9]{0,18}$/.test(snapshot.executionGeneration)) throw new Error("Controller launch journal identity conflict.");
      const validId = (value: unknown) => typeof value === "string" && canonicalId(value) === value;
      const validProof = (proof: ProcessProof) => proof !== null && typeof proof === "object" && Number.isSafeInteger(proof.pid) && proof.pid > 0 && proof.pid <= 2_147_483_647 && Number.isSafeInteger(proof.parentPid) && proof.parentPid >= 0 && (proof.processGroupId === null || Number.isSafeInteger(proof.processGroupId) && proof.processGroupId > 0) && typeof proof.startedAt === "string" && proof.startedAt.trim() !== "" && typeof proof.commandHash === "string" && /^[a-f0-9]{64}$/.test(proof.commandHash) && (proof.jobObjectName === undefined || typeof proof.jobObjectName === "string" && proof.jobObjectName.trim() !== "" && !proof.jobObjectName.includes("\0"));
      if (!validId(snapshot.controllerInstanceId) || BigInt(snapshot.executionGeneration) > 9_223_372_036_854_775_807n || !["starting", "ready", "working", "stopping", "stopped", "paused", "failed"].includes(snapshot.lifecycle) || !["initializing", "idle", "working", "waiting_input", "stopped", "unknown"].includes(snapshot.activity) || !["not_required", "not_submitted", "dispatching", "provider_accepted", "confirmed", "failed", "unknown"].includes(snapshot.initialInputState) || typeof snapshot.nativeStopped !== "boolean" || !Array.isArray(snapshot.nativeProcesses) || !snapshot.nativeProcesses.every(validProof) || !(snapshot.nativeSessionId === null || typeof snapshot.nativeSessionId === "string" && snapshot.nativeSessionId.trim() !== "" && snapshot.nativeSessionId.isWellFormed()) || !(snapshot.controllerProcess === null || validProof(snapshot.controllerProcess)) || !(snapshot.stoppedAt === null || typeof snapshot.stoppedAt === "string" && Number.isFinite(Date.parse(snapshot.stoppedAt))) || !(snapshot.error === null || typeof snapshot.error === "string")) throw new Error("Controller launch journal snapshot format conflict.");
      if (snapshot.startup !== undefined) parseStartupObservation(snapshot.startup);
      if (snapshot.executionGeneration === ticket.executionGeneration) {
        if (snapshot.controllerInstanceId !== ticket.controllerInstanceId || row.ticket_hash !== controllerPayloadHash(ticket)) throw new Error("Controller launch journal ticket or instance conflict.");
        const controller = snapshot.controllerProcess;
        if (controller !== null && (controller.pid !== process.pid || controller.startedAt !== process.startedAt || controller.commandHash !== process.commandHash || controller.processGroupId !== process.processGroupId || process.processGroupId === null && controller.parentPid !== process.parentPid || (process.jobObjectName !== undefined ? process.jobObjectName !== `Local\\Daynight-${ticket.launchId}` || controller.jobObjectName !== process.jobObjectName : controller.jobObjectName !== undefined && (process.processGroupId !== null || controller.jobObjectName !== `Local\\Daynight-${ticket.launchId}`)))) throw new Error("Controller launch journal process identity conflict.");
        return { kind: "controller-exited", process, snapshot } as const;
      }
      if (BigInt(snapshot.executionGeneration) + 1n !== BigInt(ticket.executionGeneration) || snapshot.lifecycle !== "stopped" || snapshot.nativeStopped !== true || snapshot.nativeSessionId === null || snapshot.nativeSessionId !== ticket.resumeNativeSessionId) throw new Error("Controller launch journal generation conflict.");
      return { kind: "pre-writer-exited", process, journal: "preceding-generation" } as const;
    }).deferred();
  } catch (error) { failed = true; failure = error; }
  try { closeSqliteDatabase(db, { file, format: controllerJournalFormat }, "not-started"); }
  catch (error) { if (failed) throw new AggregateError([failure, error], "Controller launch observation and journal close failed.", { cause: failure }); throw error; }
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
  let ipcFailure: unknown;
  try {
    const response = await requestController(input.ticket, { kind: "observe" }, { signal: input.signal, timeoutMs: timeout(2000) });
    check();
    if (response.snapshot.sessionId !== input.ticket.sessionId) throw new Error("Controller IPC session identity mismatch.");
    return { kind: "observed", snapshot: response.snapshot };
  } catch (error) {
    check();
    if (!(error instanceof ControllerIpcOutcomeUnknownError)) throw error;
    ipcFailure = error;
  }
  let state: Awaited<ReturnType<typeof inspectBootstrapProcessProof>>, mismatch: { sameBirth: boolean } | undefined;
  try { state = await inspectBootstrapProcessProof(input.spawnProof, timeout(5000), evidence => { mismatch = evidence; }); check(); }
  catch (cause) { check(); return { kind: "unknown", cause: new AggregateError([ipcFailure, cause], "Controller IPC and process observation failed.", { cause }) }; }
  if (state === "running" || state === "exiting") return { kind: "running-unobserved", process: input.spawnProof };
  // A different creation time proves the original instance has exited. It
  // permits journal observation but never an operation on the replacement.
  if (state === "replaced" && mismatch?.sameBirth !== false) return { kind: "unknown", cause: new AggregateError([ipcFailure, new Error("Controller bootstrap process identity was replaced.")], "Controller IPC and process observation failed.", { cause: ipcFailure }) };
  try {
    const result = exitedJournal(input.journalFile, input.ticket, input.spawnProof, timeout(5000));
    check();
    return result;
  } catch (cause) {
    check();
    throw new AggregateError([ipcFailure, cause], `Controller launch journal observation failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
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
  const remaining = () => { if (Date.now() >= deadline) throw new Error("Controller bootstrap stop exceeded its deadline."); };
  const check = async () => {
    remaining();
    let mismatch: unknown;
    const state = await inspectBootstrapProcessProof(proof, Math.max(1, Math.min(5000, deadline - Date.now())), evidence => { mismatch = evidence; });
    remaining();
    if (state === "replaced") {
      const message = `Controller bootstrap process identity ${mismatch !== undefined && (mismatch as { sameBirth: boolean }).sameBirth === false ? "was replaced" : "conflicts"} (${JSON.stringify(mismatch)}).`;
      if (mismatch !== undefined && (mismatch as { sameBirth: boolean }).sameBirth === false) throw new ControllerBootstrapReplacedError(message);
      throw new Error(message);
    }
    return state;
  };
  const signal = async (value: NodeJS.Signals): Promise<"signaled" | "stopped" | "exiting"> => {
    const state = await check();
    if (state === "stopped" || state === "exiting") return state;
    try { process.kill(proof.pid, value); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return "stopped"; throw error; }
    return "signaled";
  };
  if (await signal("SIGTERM") === "stopped") return;
  const graceful = Math.min(deadline, Date.now() + 2000);
  while (Date.now() < graceful) {
    if (await check() === "stopped") return;
    await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(0, graceful - Date.now()))));
  }
  let killed = false;
  while (Date.now() < deadline) {
    if (!killed) {
      const state = await signal("SIGKILL");
      if (state === "stopped") return;
      killed = state === "signaled";
    } else if (await check() === "stopped") return;
    await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(0, deadline - Date.now()))));
  }
  throw new Error("Controller bootstrap stop exceeded its deadline.");
};
