import { performance } from "node:perf_hooks";
import type { WindowsCommandJobKernel, WindowsJobProcess, WindowsOwnedJobKernel } from "./windows-job.js";

export class WindowsCommandCleanupError extends AggregateError {
  constructor(errors: readonly unknown[], message = "Windows command cleanup remains unconfirmed.") {
    super([...errors], message);
    this.name = "WindowsCommandCleanupError";
  }
}
export type WindowsKillPolicy = "ON" | "OFF" | "UNKNOWN";
export type WindowsCommandOwnership = {
  readonly killPolicy: WindowsKillPolicy;
  assignGate(pid: number): void;
  stopUntil(deadline: number): Promise<void>;
  release(onReleased: () => void): void;
  restoreKillOnCloseUntil(deadline: number): readonly unknown[];
  requestFailureClose(): readonly unknown[];
  closeObservations(): readonly unknown[];
};
export type WindowsNativeCommandOwnership = WindowsCommandOwnership & {
  creationJob(): unknown;
  adoptCreatedTarget(observation: unknown, expected: { pid: number; birth: bigint }): void;
};
export class WindowsCommandJobSetupError extends Error {
  constructor(readonly scope: WindowsCommandOwnership, cause: unknown) {
    super("Windows command Job configuration failed.", { cause });
  }
}

type Member = WindowsJobProcess & { handle: unknown; closeAttempted: boolean };
type GitPolicy = { anonymous: true; seal: true; name: null };
type ReviewPolicy = { anonymous: false; seal: false; name: string };
type Policy = GitPolicy | ReviewPolicy;
type CreateWindowsCommandJob = {
  (api: WindowsCommandJobKernel, policy: GitPolicy): WindowsNativeCommandOwnership;
  (api: WindowsOwnedJobKernel, policy: ReviewPolicy): WindowsCommandOwnership;
};
const pause = async (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

/** A held Job owns ordinary inherited members; process-object proof applies to captured objects. */
export const createWindowsCommandJob: CreateWindowsCommandJob = (api: WindowsOwnedJobKernel, policy: Policy): WindowsNativeCommandOwnership => {
  const extended = api as WindowsCommandJobKernel;
  const job = policy.anonymous ? extended.createAnonymousJob() : api.create(policy.name);
  const members: Member[] = [];
  let killPolicy: WindowsKillPolicy = "UNKNOWN", assigned = false, terminationAttempted = false, closeAttempted = false;
  let stopping: Promise<void> | undefined;
  let restoration: readonly unknown[] | undefined;
  const capture = (pid: number): Member | null => {
    const handle = api.open(pid);
    if (handle === null) return null;
    const member: Member = { pid, parentPid: 0, birth: 0n, handle, closeAttempted: false };
    members.push(member);
    Object.assign(member, api.identity(handle));
    if (member.pid !== pid) throw new Error("Windows command Job member identity changed during capture.");
    return member;
  };
  const closeMember = (member: Member): void => {
    if (member.closeAttempted) return;
    member.closeAttempted = true;
    api.closeProcess(member.handle);
    members.splice(members.indexOf(member), 1);
  };
  const closeJob = (): void => {
    if (closeAttempted) return;
    closeAttempted = true;
    api.close(job);
  };
  const terminate = (): void => {
    if (terminationAttempted) return;
    terminationAttempted = true;
    api.terminate(job);
  };
  const checkDeadline = (deadline: number, message: string): void => {
    if (performance.now() >= deadline) throw new Error(message);
  };
  const scope: WindowsNativeCommandOwnership = {
    get killPolicy() { return killPolicy; },
    creationJob: () => {
      if (!policy.anonymous || assigned || stopping !== undefined || closeAttempted || killPolicy !== "ON") throw new Error("Windows native command Job admission is closed.");
      return job;
    },
    adoptCreatedTarget: (handle, expected) => {
      try {
        if (!policy.anonymous || assigned || stopping !== undefined || closeAttempted || killPolicy !== "ON") throw new Error("Windows native command Job admission is closed.");
        const identity = api.identity(handle);
        if (identity.pid !== expected.pid || identity.birth !== expected.birth || identity.parentPid !== process.pid ||
            !api.contains(job, handle) || api.signaled(handle)) throw new Error("Windows native command creation identity or Job membership is unconfirmed.");
        members.push({ ...identity, handle, closeAttempted: false }); assigned = true;
      } catch (error) {
        try { api.closeProcess(handle); }
        catch (closeError) { throw new WindowsCommandCleanupError([error, closeError]); }
        throw error;
      }
    },
    assignGate: pid => {
      if (assigned || stopping !== undefined || closeAttempted) throw new Error("Windows command Job admission is closed.");
      const guardian = capture(pid);
      if (guardian === null || guardian.parentPid !== process.pid || api.signaled(guardian.handle)) throw new Error("Windows command guardian identity is unavailable before assignment.");
      api.assignHandle(job, guardian.handle);
      if (!api.contains(job, guardian.handle) || api.signaled(guardian.handle)) throw new Error("Windows command guardian Job membership is unconfirmed.");
      assigned = true;
    },
    stopUntil: deadline => {
      stopping ??= (async () => {
        const failures: unknown[] = [];
        const pollMs = Math.min(25, Math.max(0, deadline - performance.now()));
        if (policy.seal) {
          try { checkDeadline(deadline, "Windows command Job seal exceeded its deadline."); extended.sealAdmissions(job); }
          catch (error) { failures.push(error); }
        }
        try {
          checkDeadline(deadline, "Windows command Job inventory exceeded its deadline.");
          for (const pid of api.inspect(job)) {
            checkDeadline(deadline, "Windows command Job inventory exceeded its deadline.");
            if (members.some(member => member.pid === pid)) continue;
            const member = capture(pid);
            if (member !== null && !api.contains(job, member.handle)) closeMember(member);
          }
        } catch (error) { failures.push(error); }
        try { terminate(); } catch (error) { failures.push(error); }
        try {
          while (members.some(member => !api.signaled(member.handle))) {
            checkDeadline(deadline, "Captured Windows command Job processes did not signal exit within the termination grace period.");
            await pause(pollMs);
          }
        } catch (error) { failures.push(error); }
        // Review retains pending observations. Git's terminal failure policy closes them after its final witness.
        if (!policy.seal || failures.length === 0) {
          for (const member of [...members]) {
            try { if (api.signaled(member.handle)) closeMember(member); } catch (error) { failures.push(error); }
          }
        }
        try {
          while (api.active(job) !== 0) {
            checkDeadline(deadline, "Windows command Job members remain active after termination.");
            await pause(pollMs);
          }
        } catch (error) { failures.push(error); }
        if (failures.length) throw new WindowsCommandCleanupError(failures, "Windows command Job termination remains unconfirmed.");
        try { closeJob(); } catch (error) { throw new WindowsCommandCleanupError([error]); }
      })();
      return stopping;
    },
    release: onReleased => {
      if (!policy.anonymous || stopping !== undefined || closeAttempted || killPolicy === "OFF") throw new Error("Windows command Job cannot be released in its current state.");
      if (!assigned || members.some(member => !api.signaled(member.handle))) throw new Error("Windows command guardian has not confirmed exit before release.");
      killPolicy = "UNKNOWN";
      extended.clearKillOnClose(job);
      killPolicy = "OFF";
      const failures: unknown[] = [];
      // The caller commits its normal result before any asynchronous boundary or final handle release.
      try { onReleased(); } catch (error) { failures.push(error); }
      try { closeJob(); } catch (error) { failures.push(error); }
      failures.push(...scope.closeObservations());
      if (failures.length) throw new WindowsCommandCleanupError(failures);
    },
    restoreKillOnCloseUntil: deadline => {
      if (killPolicy !== "UNKNOWN") return [];
      if (restoration !== undefined) return restoration;
      try {
        checkDeadline(deadline, "Windows command Job kill-on-close restoration exceeded its deadline.");
        extended.restoreKillOnClose(job); killPolicy = "ON";
        restoration = [];
      } catch (error) { restoration = [error]; }
      return restoration;
    },
    requestFailureClose: () => {
      if (killPolicy === "OFF") return [new Error("Windows command Job ownership was already released.")];
      const failures: unknown[] = [];
      try { terminate(); } catch (error) { failures.push(error); }
      try { closeJob(); } catch (error) { failures.push(error); }
      return failures;
    },
    closeObservations: () => {
      const failures: unknown[] = [];
      for (const member of [...members]) {
        try { closeMember(member); } catch (error) { failures.push(error); }
      }
      return failures;
    },
  };
  try { api.killOnClose(job); killPolicy = "ON"; }
  catch (cause) { throw new WindowsCommandJobSetupError(scope, cause); }
  return scope;
};
