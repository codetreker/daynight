import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { readControllerSnapshot, readWindowsJobReceipt, readWindowsJobSource, commitWindowsJobStop, type ControllerSnapshot } from "./lifecycle-store.js";
import { matchesWindowsJobController, WindowsJobEvidenceConflictError, type WindowsJobAssignedSource, type WindowsJobStopReceipt } from "./windows-job-evidence.js";
import { openWindowsGuardianJob, recoverWindowsGuardianJob, wakeWindowsJobGuardian, WindowsGuardianLeaseError, type RetainedWindowsGuardianJob } from "./windows-job-guardian.js";
import { confirmControllerProcessesStopped, inspectProcessProof, stopControllerProcesses, type ProcessProof } from "./process-proof.js";
import type { ControllerLaunchTicket } from "./launch-ticket.js";

type Lease = Awaited<ReturnType<typeof openWindowsGuardianJob>>;
export class ControllerStopIdentityError extends Error {}
export const isControllerStopIdentityConflict = (error: unknown, seen = new Set<unknown>()): boolean => {
  if (typeof error !== "object" || error === null || seen.has(error)) return false;
  seen.add(error);
  if (error instanceof ControllerStopIdentityError || error instanceof WindowsJobEvidenceConflictError) return true;
  if (error instanceof AggregateError && error.errors.some(item => isControllerStopIdentityConflict(item, seen))) return true;
  return error instanceof Error && isControllerStopIdentityConflict(error.cause, seen);
};
type CommitHooks = { onVerified(): void; onConflict(error: unknown): void };
export const recoverWindowsControllerProof = (file: string, ticket: ControllerLaunchTicket): ProcessProof | null => {
  const source = readWindowsJobSource(file, ticket);
  return source?.phase === "assigned" ? { ...source.controller, jobObjectName: `Local\\Daynight-${ticket.launchId}` } : null;
};
type Held = { source: WindowsJobAssignedSource; lease?: Lease; retained?: RetainedWindowsGuardianJob };
// A duplicate whose guardian has disappeared remains the only evidence of the
// original object. Keep it until the exact generation has a durable receipt.
const retained = new Map<string, Held[]>();
const keep = (entry: Held): void => { const items = retained.get(entry.source.launchId) ?? []; if (!items.includes(entry)) items.push(entry); retained.set(entry.source.launchId, items); };
const forget = (entry: Held): void => { const items = retained.get(entry.source.launchId)?.filter(item => item !== entry) ?? []; if (items.length) retained.set(entry.source.launchId, items); else retained.delete(entry.source.launchId); };
const snapshotFor = (file: string, ticket: ControllerLaunchTicket): ControllerSnapshot => {
  const value = readControllerSnapshot(file);
  if (!value) throw new Error("The original Controller generation is unavailable.");
  if (value.executionId !== ticket.executionId || value.claimId !== ticket.claimId || value.testExecutionId !== ticket.testExecutionId || value.sessionId !== ticket.sessionId || value.executionGeneration !== ticket.executionGeneration || value.controllerInstanceId !== ticket.controllerInstanceId) throw new ControllerStopIdentityError("The original Controller generation changed.");
  return value;
};
const sameOriginal = (snapshot: ControllerSnapshot, source: WindowsJobAssignedSource, controller: ProcessProof): void => {
  if (!matchesWindowsJobController(controller, source) || snapshot.controllerProcess !== null && !matchesWindowsJobController(snapshot.controllerProcess, source)) throw new ControllerStopIdentityError("The original Windows Controller identity conflicts with the Job source.");
  if (snapshot.controllerProcess === null && (snapshot.nativeProcesses.length !== 0 || !["starting", "paused", "stopping", "failed"].includes(snapshot.lifecycle) || snapshot.nativeStopped || snapshot.stoppedAt !== null || !["not_submitted", "not_required"].includes(snapshot.initialInputState))) throw new ControllerStopIdentityError("The original Windows startup snapshot cannot be recovered from its Job source.");
};
const allStopped = async (snapshot: ControllerSnapshot, source: WindowsJobAssignedSource): Promise<boolean> => {
  for (const proof of [snapshot.controllerProcess ?? source.controller, ...snapshot.nativeProcesses]) if (await inspectProcessProof(proof) === "running") return false;
  return true;
};
const empty = (lease: Lease): boolean => { const value = lease.inspect(); return value.sealed && value.active === 0 && value.members.length === 0; };

/** Hold the original Windows Job from before IPC stop through durable settlement. */
export const openControllerStop = async (input: { journalPath: string; ticket: ControllerLaunchTicket; controller: ProcessProof; native: readonly ProcessProof[] }) => {
  const { journalPath: file, ticket, controller } = input;
  const windowsSource = process.platform === "win32" || controller.processGroupId === null || controller.jobObjectName !== undefined;
  if (!windowsSource) return {
    confirm: () => confirmControllerProcessesStopped(controller, input.native),
    stop: (deadline: number) => stopControllerProcesses(controller, input.native, deadline),
    commit: async (hooks?: CommitHooks) => { const { recordStoppedControllerGeneration } = await import("./lifecycle-store.js"); hooks?.onVerified(); return recordStoppedControllerGeneration(file, ticket); },
    close: async () => {},
  };
  const source = readWindowsJobSource(file, ticket);
  if (!source || source.phase !== "assigned") throw new Error("The original Windows Job assignment is unavailable.");
  const current = snapshotFor(file, ticket);
  sameOriginal(current, source, controller);
  if (input.native.length > current.nativeProcesses.length || !input.native.every((proof, index) => isDeepStrictEqual(proof, current.nativeProcesses[index]))) throw new ControllerStopIdentityError("The original Windows native process evidence changed.");
  let receipt = readWindowsJobReceipt(file, ticket), held: Held | undefined;
  if (receipt !== null) {
    if (!isDeepStrictEqual(receipt.source, source) || !isDeepStrictEqual(receipt.snapshot, current)) throw new ControllerStopIdentityError("The original Windows Job receipt conflicts with the current generation.");
  } else {
    if (process.platform !== "win32") throw new Error("The original Windows Job cannot be inspected on this platform without its stop receipt.");
    held = retained.get(source.launchId)?.find(entry => isDeepStrictEqual(entry.source, source));
    if (held?.retained) {
      held.lease = recoverWindowsGuardianJob(held.retained);
      delete held.retained;
    }
    if (!held) {
      try { held = { source, lease: await openWindowsGuardianJob(source) }; }
      catch (error) {
        if (error instanceof WindowsGuardianLeaseError) keep({ source, retained: error.retained });
        throw error;
      }
    }
    forget(held);
  }
  let closed = false;
  const check = () => { if (closed) throw new Error("The original Controller stop operation is closed."); };
  const confirm = async (): Promise<boolean> => {
    check();
    const snapshot = snapshotFor(file, ticket); sameOriginal(snapshot, source, controller);
    if (current.nativeProcesses.length > snapshot.nativeProcesses.length || !current.nativeProcesses.every((proof, index) => isDeepStrictEqual(proof, snapshot.nativeProcesses[index]))) throw new ControllerStopIdentityError("The original Windows native process evidence changed during stop observation.");
    if (receipt !== null) return isDeepStrictEqual(snapshot, receipt.snapshot);
    return held?.lease !== undefined && empty(held.lease) && await allStopped(snapshot, source);
  };
  const stop = async (deadline: number): Promise<void> => {
    check();
    if (receipt !== null) { if (!await confirm()) throw new Error("The original stopped generation no longer matches its receipt."); return; }
    const lease = held?.lease;
    if (!lease) throw new Error("The original Windows Job handle is unavailable.");
    lease.seal(); lease.terminate();
    while (Date.now() < deadline) {
      if (await confirm()) return;
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    }
    throw new Error("The original Windows Job did not stop completely by its deadline.");
  };
  const commit = async (hooks?: CommitHooks): Promise<ControllerSnapshot> => {
    check();
    try {
      if (receipt !== null) { if (!await confirm()) throw new ControllerStopIdentityError("The original stopped generation no longer matches its receipt."); hooks?.onVerified(); return receipt.snapshot; }
      if (!held?.lease || !await confirm()) throw new Error("The original Windows Job stop remains unconfirmed.");
      const snapshot = snapshotFor(file, ticket); sameOriginal(snapshot, source, controller);
      if (!empty(held.lease) || !await allStopped(snapshot, source)) throw new Error("The original Windows Job changed before its stop receipt.");
      // Notification and the synchronous CAS share one turn: a source conflict
      // can revoke the notice before the coordinator acts on its wake.
      hooks?.onVerified();
      let stopped: ControllerSnapshot;
      try { stopped = commitWindowsJobStop(file, ticket, snapshot, source); }
      catch (error) {
        // The transaction may have committed even if closing its connection failed.
        let observedReceipt: WindowsJobStopReceipt | null;
        try { observedReceipt = readWindowsJobReceipt(file, ticket); }
        catch (cause) { throw new AggregateError([error, cause], "Windows Job stop commit and receipt reconciliation failed.", { cause: error }); }
        if (!observedReceipt || !isDeepStrictEqual(observedReceipt.source, source) || !isDeepStrictEqual(observedReceipt.observedSnapshot, snapshot)) throw error;
        receipt = observedReceipt;
        return receipt.snapshot;
      }
      receipt = readWindowsJobReceipt(file, ticket);
      if (!receipt) throw new Error("The original Windows Job stop receipt could not be read back.");
      if (!isDeepStrictEqual(receipt.snapshot, stopped)) throw new ControllerStopIdentityError("The original Windows Job stop receipt conflicts with its committed snapshot.");
      return stopped;
    } catch (error) {
      if (isControllerStopIdentityConflict(error)) hooks?.onConflict(error);
      throw error;
    }
  };
  const close = async (): Promise<void> => {
    if (closed) return;
    if (held?.lease) {
      try {
        if (receipt) held.lease.closeAfterCommit(receipt); else held.lease.close();
      } catch (error) { keep(held); throw error; }
      forget(held); held = undefined;
    }
    if (receipt && process.platform === "win32") {
      await wakeWindowsJobGuardian(ticket.launchId).catch(async error => {
        if (await inspectProcessProof(source.guardian) === "running") throw error;
      });
      const deadline = Date.now() + 15_000;
      while (await inspectProcessProof(source.guardian) === "running") {
        if (Date.now() >= deadline) throw new Error("The original Windows guardian did not exit after its stop receipt.");
        await delay(25);
      }
    }
    closed = true;
  };
  return { confirm, stop, commit, close };
};

export type ControllerStop = Awaited<ReturnType<typeof openControllerStop>>;
