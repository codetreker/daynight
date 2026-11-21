import { execFile } from "node:child_process";
import { windowsDirectoryHolders, type WindowsDirectoryHolder, type WindowsDirectoryHolderKernel } from "../../platform/windows-directory-holders.js";
import type { Operation } from "../../api/operation.js";

export type WindowsWorktreeProcessStop = {
  /** Holders observed inside the verified worktree before any termination. */
  readonly observed: readonly { readonly pid: number; readonly image: string; readonly directory: string }[];
  /** Holders this attempt asked Windows to terminate, with their descendants. */
  readonly terminated: readonly number[];
};

export type WindowsWorktreeProcessOptions = {
  readonly holders?: typeof windowsDirectoryHolders;
  readonly kernel?: WindowsDirectoryHolderKernel;
  readonly terminate?: (holder: WindowsDirectoryHolder, operation: Operation) => Promise<void>;
  /** Called with each holder the moment it has been terminated, before
   * anything else here can fail.
   *
   * Termination cannot be undone, so the caller's record of it must not depend
   * on this function returning. Cancellation or the deadline can arrive while
   * a later holder is being processed, and the accumulated result would be
   * discarded with the throw; a caller reading only the return value would
   * then report that nothing had been terminated. */
  readonly onTerminated?: (holder: { readonly pid: number; readonly image: string; readonly directory: string }) => void;
};

const runTaskkill = async (holder: WindowsDirectoryHolder, operation: Operation): Promise<void> => {
  operation.check();
  const timeout = Math.max(1, Math.floor(Math.min(operation.remainingMs(), operation.limits.requestMs)));
  await new Promise<void>((resolve, reject) => {
    // /T also ends the processes Windows can attribute to this holder as its
    // children, which is the part of the action the Worker does not own and the
    // configuration target authorizes. It is not a guarantee: a grandchild
    // whose parent already exited may no longer be attributable and can
    // survive, in which case the caller's retry meets the same obstacle.
    const child = execFile("taskkill", ["/PID", String(holder.pid), "/T", "/F"], { timeout, windowsHide: true }, error => {
      operation.signal.removeEventListener("abort", abort);
      // 128 is "process not found": the holder exited between inventory and
      // termination, which is the outcome this call wanted.
      if (error === null || (error as { code?: unknown }).code === 128) { resolve(); return; }
      reject(new Error(`Windows worktree holder termination failed for process ${holder.pid}.`, { cause: error }));
    });
    const abort = (): void => { child.kill("SIGKILL"); };
    operation.signal.addEventListener("abort", abort, { once: true });
  });
  // No check follows the termination. Once taskkill has returned, the holder
  // is gone whether or not the operation has since been cancelled, and a throw
  // here would be recorded as a failure to terminate rather than as what it
  // is. The caller checks before the next holder and after the loop.
};

/** Terminate the processes whose working directory keeps a verified worktree
 * open, so an ordinary removal that exhausted its busy retries can proceed.
 *
 * The caller must have proven that `target` is the worktree it owns before
 * calling, and must prove it again before removing anything: this function
 * only acts on processes, never on the directory itself.
 *
 * Only working-directory holders are recovered. A process that merely holds an
 * open file inside the tree also blocks removal and is not reported here, so
 * the caller keeps its original error when the retry still fails.
 */
export const stopWindowsWorktreeProcesses = async (
  target: string,
  operation: Operation,
  options: WindowsWorktreeProcessOptions = {},
): Promise<WindowsWorktreeProcessStop> => {
  const list = options.holders ?? windowsDirectoryHolders;
  const terminate = options.terminate ?? runTaskkill;
  operation.check();
  const inventory = await list(target, () => operation.check(), options.kernel);
  const failures: unknown[] = [], terminated: number[] = [];
  let failed = false, failure: unknown;
  try {
    for (const holder of inventory.holders) {
      operation.check();
      // The open handle from the inventory pins this identifier, so Windows
      // cannot have recycled it onto an unrelated process before this call.
      try {
        await terminate(holder, operation);
        terminated.push(holder.pid);
        options.onTerminated?.({ pid: holder.pid, image: holder.image, directory: holder.directory });
      }
      catch (error) { failures.push(error); }
    }
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    // A throw from here would otherwise replace the error that is already on
    // its way out — the cancellation or deadline that ended the loop — and the
    // caller would see a handle failure where the real cause was elsewhere.
    try { inventory.release(); }
    catch (error) {
      if (failed) throw new AggregateError([failure, error], `Windows worktree holder termination and handle release failed for ${target}.`, { cause: failure });
      throw error;
    }
  }
  if (failures.length > 0 && terminated.length === 0) {
    throw new AggregateError(failures, `No Windows worktree holder could be terminated for ${target}.`, { cause: failures[0] });
  }
  operation.check();
  return { observed: inventory.holders.map(({ pid, image, directory }) => ({ pid, image, directory })), terminated };
};
