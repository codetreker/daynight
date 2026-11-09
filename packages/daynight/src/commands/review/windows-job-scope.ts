import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { loadWindowsJobKernel } from "../../platform/windows-job.js";
import type { WindowsJobProcess, WindowsOwnedJobKernel } from "../../platform/windows-job.js";

type Member = WindowsJobProcess & { handle: unknown };
export type WindowsReviewJobScope = {
  assignGuardian(pid: number): void;
  stop(graceMs: number): Promise<void>;
};
export class WindowsReviewJobSetupError extends Error {
  constructor(readonly scope: WindowsReviewJobScope, cause: unknown) {
    super("Windows review Job configuration failed; its ownership must be retained until cleanup is confirmed.", { cause });
  }
}
let kernel: Promise<WindowsOwnedJobKernel> | undefined;

/** Own ordinary inherited Job members; only captured process objects receive a signaled proof. */
export const createWindowsReviewJobScope = async (suppliedKernel?: WindowsOwnedJobKernel): Promise<WindowsReviewJobScope> => {
  const api = suppliedKernel ?? await (kernel ??= loadWindowsJobKernel());
  const job = api.create(`Local\\Daynight-review-${randomUUID()}`);
  const members: Member[] = [];
  let stopping: Promise<void> | undefined;
  let assigned = false;
  const capture = (pid: number): Member | null => {
    const handle = api.open(pid);
    if (handle === null) return null;
    // Keep even partially observed handles so cleanup cannot lose their identity.
    const member: Member = { pid, parentPid: 0, birth: 0n, handle };
    members.push(member);
    Object.assign(member, api.identity(handle));
    if (member.pid !== pid) throw new Error("Windows review Job member identity changed during capture.");
    return member;
  };
  const scope: WindowsReviewJobScope = {
    assignGuardian: pid => {
      if (assigned || stopping !== undefined) throw new Error("Windows review Job admission is closed.");
      const guardian = capture(pid);
      if (guardian === null || guardian.parentPid !== process.pid || api.signaled(guardian.handle)) throw new Error("Windows review guardian identity is unavailable before assignment.");
      api.assignHandle(job, guardian.handle);
      if (!api.contains(job, guardian.handle) || api.signaled(guardian.handle)) throw new Error("Windows review guardian Job membership is unconfirmed.");
      assigned = true;
    },
    stop: graceMs => {
      stopping ??= (async () => {
        const failures: unknown[] = [];
        const deadline = performance.now() + graceMs;
        try {
          for (const pid of api.inspect(job)) {
            if (performance.now() >= deadline) throw new Error("Windows review Job inventory exceeded its deadline.");
            if (members.some(member => member.pid === pid)) continue;
            const member = capture(pid);
            if (member !== null && !api.contains(job, member.handle)) {
              // A PID-list entry may have exited and been reused. This new
              // object is not a termination target; the Job handle owns targets.
              api.closeProcess(member.handle); members.splice(members.indexOf(member), 1);
            }
          }
        } catch (error) { failures.push(error); }
        try { api.terminate(job); } catch (error) { failures.push(error); }
        try {
          while (members.some(member => !api.signaled(member.handle))) {
            if (performance.now() >= deadline) throw new Error("Captured Windows review Job processes did not signal exit within the termination grace period.");
            await new Promise<void>(resolve => setTimeout(resolve, Math.min(25, graceMs)));
          }
        } catch (error) { failures.push(error); }
        // Release only signaled objects; an empty Job list cannot override an
        // observed object's pending exit or a native observation failure.
        for (const member of [...members]) {
          try {
            if (api.signaled(member.handle)) { api.closeProcess(member.handle); members.splice(members.indexOf(member), 1); }
          } catch (error) { failures.push(error); }
        }
        try {
          while (api.active(job) !== 0) {
            if (performance.now() >= deadline) throw new Error("Windows review Job members remain active after termination.");
            await new Promise<void>(resolve => setTimeout(resolve, Math.min(25, graceMs)));
          }
        } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, "Windows review Job termination remains unconfirmed; its handle was retained.");
        api.close(job);
      })();
      return stopping;
    },
  };
  try { api.killOnClose(job); }
  catch (cause) { throw new WindowsReviewJobSetupError(scope, cause); }
  return scope;
};
