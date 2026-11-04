import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { CopilotProcessOutcome } from "./adapters/copilot.js";
import type { AttemptIdentity, ReviewState } from "./model.js";

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, milliseconds); });
const command = (file: string, args: string[], timeout: number): Promise<string> => new Promise((resolve, reject) => {
  execFile(file, args, { encoding: "utf8", windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    if (error !== null) reject(error); else resolve(stdout);
  });
});
type ManagedProcess = { child: ChildProcess; pid: number; closed: boolean; excluded: boolean; stopping?: Promise<void> };
const attemptKey = (attempt: AttemptIdentity): string => `${attempt.reviewId}:${attempt.attempt}`;

export const processGroupIsExecuting = async (
  pid: number,
  operations: { probe: (pid: number) => void; readStatus: () => Promise<string> },
): Promise<boolean> => {
  let permissionError: Error | undefined;
  try { operations.probe(pid); }
  catch (error) {
    if (!(error instanceof Error && "code" in error)) throw error;
    if (error.code === "ESRCH") return false;
    if (error.code !== "EPERM") throw error;
    // Darwin can reject a zombie-only group probe; live members must still preserve the denial.
    // https://github.com/apple-oss-distributions/xnu/blob/ac9718fb1af618d5ce8678d0dc6e8a58f252216f/bsd/kern/kern_sig.c#L1703-L1719
    permissionError = error;
  }
  const output = await operations.readStatus();
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (match === null) throw new Error("Cannot interpret the process-group status returned by ps.");
    if (Number(match[2]) === pid && !match[3]!.startsWith("Z")) {
      if (permissionError !== undefined) throw permissionError;
      return true;
    }
  }
  return false;
};

/** Supervises only handles launched by this CLI; persisted PIDs are never termination targets. */
export const createProcessSupervisor = (options: { graceMs?: number; previousProcessesExcluded?: true } = {}) => {
  const grace = options.graceMs === undefined ? 5_000 : options.graceMs;
  if (!Number.isSafeInteger(grace) || grace < 1 || grace > 2_147_483_647) throw new Error("Process termination grace must be a positive supported integer.");
  const managed = new Map<string, ManagedProcess>();
  let safe = true;
  const uncertain = (message: string, cause?: unknown): never => {
    safe = false;
    throw new Error(message, { cause });
  };
  const onProcess = (child: ChildProcess, attempt: AttemptIdentity): void => {
    const key = attemptKey(attempt);
    const existing = managed.get(key);
    if (existing !== undefined) {
      if (existing.child !== child) uncertain("An attempt was associated with more than one process.");
      return;
    }
    if (child.pid === undefined) throw new Error("Cannot supervise an agent before its process has spawned.");
    const entry: ManagedProcess = { child, pid: child.pid, closed: false, excluded: false };
    child.once("close", () => { entry.closed = true; });
    managed.set(key, entry);
  };
  const waitForClose = async (entry: ManagedProcess): Promise<void> => {
    const deadline = Date.now() + grace;
    while (!entry.closed && Date.now() < deadline) await delay(Math.min(25, grace));
    if (!entry.closed) uncertain("The managed agent did not close its process and streams within the termination grace period.");
  };
  const liveGroup = (pid: number): Promise<boolean> => processGroupIsExecuting(pid, {
    probe: (group) => { process.kill(-group, 0); },
    readStatus: () => command("ps", ["-A", "-o", "pid=", "-o", "pgid=", "-o", "stat="], grace),
  });
  const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
    try { process.kill(-pid, signal); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
  };
  const stopGroup = async (entry: ManagedProcess): Promise<void> => {
    if (await liveGroup(entry.pid)) {
      signalGroup(entry.pid, "SIGTERM");
      const deadline = Date.now() + grace;
      while (await liveGroup(entry.pid)) {
        if (Date.now() >= deadline) break;
        await delay(Math.min(25, grace));
      }
      if (await liveGroup(entry.pid)) {
        signalGroup(entry.pid, "SIGKILL");
        const forcedDeadline = Date.now() + grace;
        while (await liveGroup(entry.pid)) {
          if (Date.now() >= forcedDeadline) uncertain("The managed agent process group still has executing members after forced termination.");
          await delay(Math.min(25, grace));
        }
      }
    }
    await waitForClose(entry);
    entry.excluded = true;
  };
  const stop = async (child: ChildProcess, attempt: AttemptIdentity): Promise<void> => {
    if (child.pid === undefined) return;
    onProcess(child, attempt);
    const entry = managed.get(attemptKey(attempt))!;
    if (entry.excluded) return;
    if (entry.stopping === undefined) entry.stopping = (async () => {
      try {
        if (process.platform === "win32") {
          if (entry.closed || child.exitCode !== null || child.signalCode !== null) uncertain("The Windows agent exited before its current process tree could be terminated; operator recovery is required.");
          await command("taskkill", ["/PID", String(entry.pid), "/T", "/F"], grace);
          await waitForClose(entry);
          entry.excluded = true;
        } else await stopGroup(entry);
      } catch (cause) { uncertain("Cannot confirm that the current agent and its foreground tools have stopped; execution state was retained.", cause); }
    })();
    await entry.stopping;
  };
  const exclude = async (review: ReviewState, outcome?: CopilotProcessOutcome): Promise<{ processesExcluded: true }> => {
    const entry = managed.get(attemptKey({ reviewId: review.id, attempt: review.attemptCount }));
    if (entry === undefined) {
      if (review.processId !== null) uncertain("This review references an agent not launched by this CLI; operator-confirmed startup recovery is required.");
      if (outcome !== undefined && !outcome.directProcessClosed) uncertain("The agent launch did not establish direct-process closure.");
      return { processesExcluded: true };
    }
    if (entry.closed && outcome?.directProcessClosed && outcome.launchFailure === "command-not-found") {
      managed.delete(attemptKey({ reviewId: review.id, attempt: review.attemptCount }));
      return { processesExcluded: true };
    }
    if (entry.stopping !== undefined) await entry.stopping;
    if (!entry.excluded) {
      if (process.platform === "win32") {
        if (outcome?.directProcessClosed && outcome.captureComplete && outcome.interruption === null && outcome.signal === null &&
          outcome.exitCode !== null && outcome.exitCode >= 0 && outcome.exitCode <= 255) entry.excluded = true;
        else await stop(entry.child, { reviewId: review.id, attempt: review.attemptCount });
      } else {
        try { await stopGroup(entry); }
        catch (cause) { uncertain("Cannot finalize the current agent process group; execution state was retained.", cause); }
      }
    }
    managed.delete(attemptKey({ reviewId: review.id, attempt: review.attemptCount }));
    return { processesExcluded: true };
  };
  return {
    onProcess, stop, exclude,
    // Recovering a dead CLI's lock does not exclude its surviving agents or repository operations.
    recover: async (_review?: ReviewState): Promise<{ processesExcluded: true; operationsStopped: true }> => {
      if (options.previousProcessesExcluded !== true) uncertain("Startup recovery requires the instance-lock owner's confirmation that the previous CLI and agents have stopped.");
      return { processesExcluded: true, operationsStopped: true };
    },
    get safeToReleaseLock(): boolean { return safe; },
  };
};
