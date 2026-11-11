import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createWindowsCommandJob, WindowsCommandJobSetupError } from "../../platform/windows-command-job.js";
import type { WindowsCommandOwnership } from "../../platform/windows-command-job.js";
import { loadWindowsJobKernel } from "../../platform/windows-job.js";
import type { WindowsOwnedJobKernel } from "../../platform/windows-job.js";

export type WindowsReviewJobScope = { assignGuardian(pid: number): void; stop(graceMs: number): Promise<void> };
export class WindowsReviewJobSetupError extends Error {
  constructor(readonly scope: WindowsReviewJobScope, cause: unknown) {
    super("Windows review Job configuration failed; its ownership must be retained until cleanup is confirmed.", { cause });
  }
}
let kernel: Promise<WindowsOwnedJobKernel> | undefined;
const reviewScope = (owner: WindowsCommandOwnership): WindowsReviewJobScope => ({
  assignGuardian: pid => owner.assignGate(pid),
  stop: graceMs => owner.stopUntil(performance.now() + graceMs),
});

export const createWindowsReviewJobScope = async (suppliedKernel?: WindowsOwnedJobKernel): Promise<WindowsReviewJobScope> => {
  const api = suppliedKernel ?? await (kernel ??= loadWindowsJobKernel());
  try { return reviewScope(createWindowsCommandJob(api, { anonymous: false, seal: false, name: `Local\\Daynight-review-${randomUUID()}` })); }
  catch (error) {
    if (error instanceof WindowsCommandJobSetupError) throw new WindowsReviewJobSetupError(reviewScope(error.scope), error.cause);
    throw error;
  }
};
