import { loadWindowsJobKernel, WindowsJobError } from "../../../platform/windows-job.js";
import type { WindowsJobKernel } from "../../../platform/windows-job.js";

export { WindowsJobError as WindowsBotJobError };
export type WindowsBotJobKernel = WindowsJobKernel;

export type WindowsBotJobLease = {
  readonly name: string;
  assign(pid: number): void;
  inspect(): readonly number[];
  terminate(): void;
  /** Close only after the members and the owning guardian have stopped. */
  close(): void;
};

export class WindowsBotJobSetupError extends Error {
  constructor(readonly lease: WindowsBotJobLease) {
    super("Windows Bot probe Job Object setup failed with an unclosed owned handle.");
    this.name = "WindowsBotJobSetupError";
  }
}

let kernel: Promise<WindowsJobKernel> | undefined;

/**
 * Keep the original handle while any process can belong to the job. A temporary
 * object's name disappears when its last handle closes even if process references
 * keep its body alive; reopening by name cannot replace this ownership lease.
 */
export const createWindowsBotJobLease = async (launchId: string, suppliedKernel?: WindowsBotJobKernel): Promise<WindowsBotJobLease> => {
  const name = `Local\\Daynight-${launchId}`;
  if (!/^Local\\Daynight-[0-9a-f-]{36}$/.test(name)) throw new Error("Invalid Windows Bot probe Job Object identity.");
  const api = suppliedKernel ?? await (kernel ??= loadWindowsJobKernel());
  const handle = api.create(name);
  let closed = false;
  const lease: WindowsBotJobLease = {
    name,
    assign: pid => {
      if (closed) throw new Error("The Windows Bot probe Job Object handle is closed.");
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) throw new Error("Invalid Windows Bot probe process ID.");
      api.assign(handle, pid);
    },
    inspect: () => closed ? [] : api.inspect(handle),
    terminate: () => { if (!closed) api.terminate(handle); },
    close: () => {
      if (closed) return;
      if (api.inspect(handle).length !== 0) throw new Error("Cannot close the Windows Bot probe Job Object while members remain.");
      api.close(handle); closed = true;
    },
  };
  try { api.killOnClose(handle); }
  catch (error) {
    try { lease.close(); }
    catch { throw new WindowsBotJobSetupError(lease); }
    throw error;
  }
  return lease;
};
