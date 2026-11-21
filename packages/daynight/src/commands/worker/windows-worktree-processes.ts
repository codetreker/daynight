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
};

const runTaskkill = async (holder: WindowsDirectoryHolder, operation: Operation): Promise<void> => {
  operation.check();
  const timeout = Math.max(1, Math.floor(Math.min(operation.remainingMs(), operation.limits.requestMs)));
  await new Promise<void>((resolve, reject) => {
    // /T covers descendants the holder spawned, which is the part of this
    // action the Worker does not own and the configuration target authorizes.
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
  operation.check();
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
  try {
    for (const holder of inventory.holders) {
      operation.check();
      // The open handle from the inventory pins this identifier, so Windows
      // cannot have recycled it onto an unrelated process before this call.
      try { await terminate(holder, operation); terminated.push(holder.pid); }
      catch (error) { failures.push(error); }
    }
  } finally { inventory.release(); }
  if (failures.length > 0 && terminated.length === 0) {
    throw new AggregateError(failures, `No Windows worktree holder could be terminated for ${target}.`, { cause: failures[0] });
  }
  operation.check();
  return { observed: inventory.holders.map(({ pid, image, directory }) => ({ pid, image, directory })), terminated };
};
