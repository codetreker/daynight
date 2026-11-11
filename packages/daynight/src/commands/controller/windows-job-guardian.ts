import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalId } from "../../api/parse.js";
import { sqliteTransactionOutcome } from "../../platform/sqlite-access.js";
import { SqliteAccessError } from "../../platform/sqlite-error.js";
import { loadWindowsControllerGuardianKernel, WindowsGuardianDuplicateDecodeError } from "../../platform/windows-controller-guardian.js";
import type { WindowsControllerGuardianKernel } from "../../platform/windows-controller-guardian.js";
import type { ProcessProof } from "./process-proof.js";
import type { WindowsJobAssignedSource, WindowsJobPreparedSource, WindowsJobSource, WindowsJobStopReceipt } from "./windows-job-evidence.js";

export type WindowsGuardianJournal = {
  prepare(source: WindowsJobPreparedSource): void | Promise<void>;
  assign(prepared: WindowsJobPreparedSource, assigned: WindowsJobAssignedSource): void | Promise<void>;
  readSource(): WindowsJobSource | null | Promise<WindowsJobSource | null>;
  readReceipt(): WindowsJobStopReceipt | null | Promise<WindowsJobStopReceipt | null>;
};
export type WindowsGuardianIdentity = Pick<WindowsJobPreparedSource, "launchId" | "executionId" | "executionGeneration" | "controllerInstanceId" | "ticketHash" | "controller">;
export type WindowsJobInspection = { sealed: boolean; active: number; members: readonly number[] };

const eventName = (launchId: string): string => {
  if (canonicalId(launchId) !== launchId) throw new Error("Invalid Windows guardian launch identity.");
  return `Local\\Daynight-Guardian-${launchId}`;
};
const fileTime = (value: bigint): string => {
  const ticks = value / 10n * 10n - 116444736000000000n;
  if (ticks < 0n || ticks > 2534023007999999990n) throw new Error("Invalid Windows process creation time.");
  return `${new Date(Number(ticks / 10000000n) * 1000).toISOString().slice(0, 19)}.${(ticks % 10000000n).toString().padStart(7, "0")}Z`;
};
const sameProcess = (left: ProcessProof, right: ProcessProof): boolean => left.pid === right.pid && left.parentPid === right.parentPid && left.processGroupId === right.processGroupId && left.startedAt === right.startedAt && left.commandHash === right.commandHash;
const verifyHeldProcess = async (kernel: WindowsControllerGuardianKernel, handle: unknown, expected: ProcessProof): Promise<void> => {
  if (kernel.signaled(handle)) throw new Error("The original Windows process has already exited.");
  const actual = kernel.identity(handle);
  if (actual.pid !== expected.pid || actual.parentPid !== expected.parentPid || fileTime(actual.birth) !== expected.startedAt) throw new Error("The held Windows process differs from the original instance.");
  const observed = await kernel.captureProof(expected.pid);
  if (!sameProcess(observed, expected) || kernel.signaled(handle)) throw new Error("The original Windows process identity could not be confirmed.");
};
const inspect = (kernel: WindowsControllerGuardianKernel, job: unknown): WindowsJobInspection => ({ sealed: kernel.isSealed(job), active: kernel.active(job), members: kernel.inspect(job) });
const requireEmpty = (value: WindowsJobInspection): void => {
  if (!value.sealed || value.active !== 0 || value.members.length !== 0) throw new Error("The original Windows Job is not sealed and empty.");
};
const sameReceipt = (source: WindowsJobAssignedSource, receipt: WindowsJobStopReceipt): void => {
  if (!isDeepStrictEqual(receipt.source, source) || receipt.version !== 1 || !receipt.sealed || !receipt.empty || !receipt.controllerStopped || !receipt.nativeProcessesStopped) throw new Error("The Windows Job receipt does not identify this original Job.");
};

/** Bound repeated guardian diagnostics while retaining the first distinct failure causes. */
export const createGuardianErrorReporter = (write: (message: string) => void, limit = 16): ((error: unknown) => void) => {
  let count = 0, last = "", suppressed = false;
  return error => {
    const describe = (value: unknown, depth: number): string => {
      if (!(value instanceof Error)) return String(value);
      const message = `${value.name}: ${value.message}`;
      return depth < 3 && value.cause !== undefined ? `${message}; caused by ${describe(value.cause, depth + 1)}` : message;
    };
    const message = describe(error, 0).replace(/[\r\n]+/g, " ").slice(0, 2048);
    if (message === last) return;
    last = message;
    if (count < limit) { count += 1; write(message); }
    else if (!suppressed) { suppressed = true; write("Further Windows guardian errors are suppressed."); }
  };
};

/** A successful return owns every handle until the source has a matching stop receipt. */
export const createWindowsJobGuardian = async (input: { identity: WindowsGuardianIdentity; journal: WindowsGuardianJournal; kernel?: WindowsControllerGuardianKernel }) => {
  const identity = structuredClone(input.identity);
  const kernel = input.kernel ?? await loadWindowsControllerGuardianKernel();
  const controller = kernel.open(identity.controller.pid);
  if (controller === null) throw new Error("The original Windows Controller process is unavailable.");
  let job: unknown | undefined, wake: unknown | undefined;
  try {
    await verifyHeldProcess(kernel, controller, identity.controller);
    const guardian = await kernel.captureProof(process.pid);
    if (guardian.parentPid !== identity.controller.pid) throw new Error("The guardian is not a child of the original Controller.");
    const name = eventName(identity.launchId);
    job = kernel.create(`Local\\Daynight-${identity.launchId}`);
    kernel.killOnCloseConfirmed(job);
    wake = kernel.createWake(name);
    const prepared: WindowsJobPreparedSource = { version: 1, phase: "prepared", ...identity, guardian, jobHandle: kernel.handleValue(job) };
    const assigned: WindowsJobAssignedSource = { ...prepared, phase: "assigned" };
    let started = false, closed = false, startAttempted = false, lastError: unknown;
    const ownedJob = job, ownedWake = wake;
    const start = async (): Promise<WindowsJobAssignedSource> => {
      if (startAttempted) throw new Error("The original Windows guardian startup must not be replayed.");
      startAttempted = true;
      try { await input.journal.prepare(structuredClone(prepared)); }
      catch (error) {
        const outcome = error instanceof SqliteAccessError ? error.outcome : sqliteTransactionOutcome(error);
        if (outcome === "rolled-back" || outcome === "not-started") {
          let empty = false;
          try { empty = kernel.active(ownedJob) === 0 && kernel.inspect(ownedJob).length === 0 && !kernel.contains(ownedJob, controller); }
          catch (cause) { throw new AggregateError([error, cause], "Windows guardian preparation rolled back but Job emptiness is unconfirmed.", { cause: error }); }
          if (empty) {
            closed = true;
            const failures: unknown[] = [];
            try { kernel.close(ownedJob); } catch (cause) { failures.push(cause); }
            try { kernel.closeProcess(controller); } catch (cause) { failures.push(cause); }
            try { kernel.close(ownedWake); } catch (cause) { failures.push(cause); }
            if (failures.length) throw new AggregateError([error, ...failures], "Windows guardian preparation was rolled back but handle release failed.", { cause: error });
          }
        }
        throw error;
      }
      await verifyHeldProcess(kernel, controller, identity.controller);
      kernel.assignHandle(ownedJob, controller);
      if (!kernel.contains(ownedJob, controller) || kernel.signaled(controller)) throw new Error("The original Controller Job assignment is unconfirmed.");
      await input.journal.assign(structuredClone(prepared), structuredClone(assigned));
      started = true;
      return structuredClone(assigned);
    };
    const runUntilReleased = async (onError: (error: unknown) => void): Promise<void> => {
      if (closed) return;
      let pending = false;
      for (;;) {
        try {
          if (!started && startAttempted) {
            const current = await input.journal.readSource();
            if (current !== null && isDeepStrictEqual(current, assigned)) started = true;
          }
          if (kernel.signaled(controller) && !kernel.isSealed(ownedJob)) kernel.sealAdmissions(ownedJob);
          pending ||= kernel.consumeWake(ownedWake);
          if (pending) {
            const receipt = await input.journal.readReceipt();
            if (receipt === null) pending = false;
            else {
              if (!started) throw new Error("The original guardian assignment was not confirmed.");
              sameReceipt(assigned, receipt);
              if (!kernel.signaled(controller)) throw new Error("The original Controller has not exited.");
              requireEmpty(inspect(kernel, ownedJob));
              closed = true;
              const failures: unknown[] = [];
              try { kernel.close(ownedJob); } catch (error) { failures.push(error); }
              try { kernel.closeProcess(controller); } catch (error) { failures.push(error); }
              try { kernel.close(ownedWake); } catch (error) { failures.push(error); }
              if (failures.length) throw new AggregateError(failures, "Windows guardian handle release is incomplete.");
              return;
            }
          }
        } catch (error) {
          if (closed) throw error;
          lastError = error;
          try { onError(error); } catch (cause) { lastError = new AggregateError([error, cause], "Guardian failure and diagnostic reporting both failed.", { cause: error }); }
        }
        await delay(500);
      }
    };
    return { prepared: structuredClone(prepared), assigned: structuredClone(assigned), start, runUntilReleased, lastError: () => lastError };
  } catch (error) {
    // No source has been submitted and no process assigned at this point.
    const errors: unknown[] = [error];
    if (wake !== undefined) try { kernel.close(wake); } catch (cause) { errors.push(cause); }
    if (job !== undefined) try { kernel.close(job); } catch (cause) { errors.push(cause); }
    try { kernel.closeProcess(controller); } catch (cause) { errors.push(cause); }
    if (errors.length > 1) throw new AggregateError(errors, "Windows guardian setup and handle release failed.", { cause: error });
    throw error;
  }
};

export type RetainedWindowsGuardianJob = { source: WindowsJobAssignedSource; guardian: unknown; kernel: WindowsControllerGuardianKernel } & ({ job: unknown; rawJob?: never } | { job?: never; rawJob: string });
export class WindowsGuardianReleaseError extends AggregateError {
  constructor(errors: unknown[], readonly retained: { guardian: unknown; job: unknown; jobCloseConfirmed: boolean; guardianCloseConfirmed: boolean }) {
    super(errors, "Windows guardian handle release is incomplete."); this.name = "WindowsGuardianReleaseError";
  }
}
export class WindowsGuardianLeaseError extends Error {
  constructor(message: string, readonly retained: RetainedWindowsGuardianJob, options?: ErrorOptions) { super(message, options); this.name = "WindowsGuardianLeaseError"; }
}

export class WindowsGuardianTemporaryHandleError extends AggregateError {
  constructor(errors: unknown[], readonly retained: { source: WindowsJobAssignedSource; guardian: unknown; job: unknown; temporary: unknown }) {
    super(errors, "Windows guardian temporary handle release is unconfirmed."); this.name = "WindowsGuardianTemporaryHandleError";
  }
}

const adopt = ({ source, guardian, job, kernel }: { source: WindowsJobAssignedSource; guardian: unknown; job: unknown; kernel: WindowsControllerGuardianKernel }) => {
  // Querying the original object also verifies that kill-on-close remains set.
  if (!kernel.hasKillOnClose(job)) throw new Error("The original Windows Job lost kill-on-close.");
  inspect(kernel, job);
  let closed = false, releaseFailure: WindowsGuardianReleaseError | WindowsGuardianTemporaryHandleError | undefined;
  const requireOpen = () => { if (releaseFailure) throw releaseFailure; if (closed) throw new Error("The original Windows Job lease is closed."); };
  const release = (): void => {
    const failures: unknown[] = [];
    let jobCloseConfirmed = false, guardianCloseConfirmed = false;
    closed = true;
    try { kernel.close(job); jobCloseConfirmed = true; } catch (error) { failures.push(error); }
    try { kernel.closeProcess(guardian); guardianCloseConfirmed = true; } catch (error) { failures.push(error); }
    if (failures.length) { releaseFailure = new WindowsGuardianReleaseError(failures, { guardian, job, jobCloseConfirmed, guardianCloseConfirmed }); throw releaseFailure; }
  };
  return {
    inspect: (): WindowsJobInspection => { requireOpen(); return inspect(kernel, job); },
    terminate: (): void => { requireOpen(); kernel.terminate(job); },
    seal: (): void => {
      requireOpen(); kernel.sealAdmissions(job);
      if (!kernel.isSealed(job)) throw new Error("The original Windows Job admission seal was not confirmed.");
    },
    sealAndObserveEmpty: (): WindowsJobInspection => {
      requireOpen(); kernel.sealAdmissions(job);
      const value = inspect(kernel, job); requireEmpty(value);
      return value;
    },
    close: (): void => {
      requireOpen();
      if (kernel.signaled(guardian)) throw new Error("The guardian exited; the original Job handle must be retained until a stop receipt commits.");
      const original = kernel.duplicateJob(guardian, source.jobHandle);
      let failure: unknown, failed = false;
      try { if (!kernel.sameJob(job, original) || kernel.signaled(guardian)) throw new Error("The guardian no longer owns the original Job object."); }
      catch (error) { failed = true; failure = error; }
      try { kernel.close(original); } catch (error) {
        releaseFailure = new WindowsGuardianTemporaryHandleError(failed ? [failure, error] : [error], { source, guardian, job, temporary: original });
        throw releaseFailure;
      }
      if (failed) throw failure;
      release();
    },
    closeAfterCommit: (receipt: WindowsJobStopReceipt): void => {
      requireOpen(); sameReceipt(source, receipt); requireEmpty(inspect(kernel, job));
      release();
    },
  };
};

/** Retry observation using the already duplicated object; this never reopens by name. */
export const recoverWindowsGuardianJob = (retained: RetainedWindowsGuardianJob) => {
  const job = retained.rawJob === undefined ? retained.job : retained.kernel.decodeDuplicatedJob(retained.rawJob);
  return adopt({ source: retained.source, guardian: retained.guardian, job, kernel: retained.kernel });
};

/** Copy the original guardian's handle after holding and validating that exact process. */
export const openWindowsGuardianJob = async (source: WindowsJobAssignedSource, suppliedKernel?: WindowsControllerGuardianKernel) => {
  source = structuredClone(source);
  const kernel = suppliedKernel ?? await loadWindowsControllerGuardianKernel();
  if (source.phase !== "assigned" || source.guardian.parentPid !== source.controller.pid) throw new Error("The original Windows Job assignment is incomplete or conflicting.");
  const guardian = kernel.openGuardian(source.guardian.pid);
  let job: unknown | undefined;
  try {
    await verifyHeldProcess(kernel, guardian, source.guardian);
    job = kernel.duplicateJob(guardian, source.jobHandle);
    return adopt({ source, guardian, job, kernel });
  } catch (error) {
    if (job !== undefined) throw new WindowsGuardianLeaseError("The duplicated original Job requires retained ownership after an observation failure.", { source, guardian, job, kernel }, { cause: error });
    if (error instanceof WindowsGuardianDuplicateDecodeError) throw new WindowsGuardianLeaseError("The duplicated original Job handle requires retained ownership after decoding failed.", { source, guardian, rawJob: error.rawHandle, kernel }, { cause: error });
    try { kernel.closeProcess(guardian); }
    catch (cause) { throw new AggregateError([error, cause], "Windows guardian observation and process handle release failed.", { cause: error }); }
    throw error;
  }
};

export const wakeWindowsJobGuardian = async (launchId: string, suppliedKernel?: WindowsControllerGuardianKernel): Promise<void> => {
  const kernel = suppliedKernel ?? await loadWindowsControllerGuardianKernel();
  kernel.wake(eventName(launchId));
};
