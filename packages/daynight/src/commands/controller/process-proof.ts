import { adoptOwnedControllerJob, createOwnedControllerJob, inspectControllerJobLease, type ControllerJobLease } from "./windows-job.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { createLinuxProcessCapture, isLinuxProcessBirth, isProcessBirth, type LinuxPartialObservation } from "./linux-process-proof.js";
import { captureWindowsProcessProof, inspectWindowsProcessProof, withWindowsProcessStopHandles } from "./windows-process-proof.js";
export type ProcessProof = { readonly pid: number; readonly parentPid: number; readonly processGroupId: number | null; readonly startedAt: string; readonly commandHash: string; readonly jobObjectName?: string };
// ps localizes lstart, so identity probes need a stable locale. Keep the
// Controller and native provider environments unchanged.
// The evidence is private to this process and tied to the exact error graph.
// A caller may retain errors, but cannot turn a changed or mixed failure into
// an observation deadline by editing its fields or aggregate members.
const observationDeadlines = new WeakMap<object, () => boolean>();
const missingLinuxStats = new WeakMap<object, { path: string; intact: () => boolean }>();
const snapshotErrors = (root: Error): (() => boolean) => {
  const snapshots = new Map<object, { prototype: object | null; descriptors: PropertyDescriptorMap }>();
  const visit = (value: unknown): void => {
    if (!(value instanceof Error) && !Array.isArray(value)) return;
    if (snapshots.has(value)) return;
    const descriptors = Object.getOwnPropertyDescriptors(value) as PropertyDescriptorMap;
    snapshots.set(value, { prototype: Object.getPrototypeOf(value), descriptors });
    for (const descriptor of Object.values(descriptors)) if ("value" in descriptor) visit(descriptor.value);
  };
  visit(root);
  return () => [...snapshots].every(([object, snapshot]) => {
    if (Object.getPrototypeOf(object) !== snapshot.prototype) return false;
    const current = Object.getOwnPropertyDescriptors(object);
    const keys = Reflect.ownKeys(snapshot.descriptors);
    return keys.length === Reflect.ownKeys(current).length && keys.every(key => {
      const before = Reflect.get(snapshot.descriptors, key) as PropertyDescriptor;
      const after = Reflect.get(current, key) as PropertyDescriptor | undefined;
      return after !== undefined && before.configurable === after.configurable && before.enumerable === after.enumerable
        && before.writable === after.writable && before.value === after.value && before.get === after.get && before.set === after.set;
    });
  });
};
export class ControllerProcessObservationDeadlineError extends Error {
  constructor(cause: unknown) {
    super("Linux process observation exceeded its deadline; stop remains unconfirmed.", { cause });
    this.name = "ControllerProcessObservationDeadlineError";
  }
}
/** True only for unchanged evidence produced by this process's timed observation. */
export const isControllerProcessObservationDeadline = (error: unknown): boolean =>
  typeof error === "object" && error !== null && observationDeadlines.get(error)?.() === true;
const recordObservationDeadline = <T extends Error>(error: T, prior?: unknown): T => {
  const intact = snapshotErrors(error);
  observationDeadlines.set(error, () => intact() && (prior === undefined || isControllerProcessObservationDeadline(prior)));
  return error;
};
const run = (file: string, args: string[], timeout = 5000, strictObservation = false): Promise<string> => new Promise((resolve, reject) => {
  const timedLinuxIdentity = strictObservation && process.platform === "linux" && file === "ps" && args[0] === "-p";
  let launched = false, terminated = false, finished = false;
  const child = execFile(file, args, { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...(file === "ps" ? { env: { ...process.env, LC_ALL: "C" } } : {}) }, (error, stdout) => {
    finished = true;
    if (error === null) { resolve(stdout); return; }
    if (timedLinuxIdentity && launched && terminated && error.killed === true && error.signal === "SIGTERM" && error.code === null) {
      reject(recordObservationDeadline(new ControllerProcessObservationDeadlineError(error)));
    } else reject(error);
  });
  if (timedLinuxIdentity && !finished) {
    // execFile owns this child and destroys its pipes before its timeout kill.
    // Its only other internal kill is for maxBuffer, which retains its distinct
    // error code and cannot satisfy the callback's deadline evidence above.
    const kill = child.kill.bind(child);
    child.kill = (signal) => {
      const sent = kill(signal);
      if (launched && (signal === "SIGTERM" || signal === osConstants.signals.SIGTERM) && sent) terminated = true;
      return sent;
    };
    child.once("spawn", () => { launched = true; });
  }
});
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const linuxCapture = (strictObservation: boolean) => createLinuxProcessCapture(
  async (file, timeout) => {
    const signal = AbortSignal.timeout(timeout);
    try { return await readFile(file, { encoding: "utf8", signal }); }
    catch (error) {
      if (strictObservation && error instanceof Error && /^\/proc\/[1-9][0-9]*\/stat$/.test(file) && "code" in error && error.code === "ENOENT"
        && "syscall" in error && error.syscall === "open" && "path" in error && error.path === file) {
        missingLinuxStats.set(error, { path: file, intact: snapshotErrors(error) });
      }
      if (strictObservation && error instanceof Error && error.name === "AbortError" && signal.aborted && error.cause === signal.reason) {
        throw recordObservationDeadline(new ControllerProcessObservationDeadlineError(error));
      }
      throw error;
    }
  },
  (pid, timeout) => run("ps", ["-p", String(pid), "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat=", "-o", "lstart=", "-o", "command="], timeout, strictObservation),
  hash,
);
const captureLinuxProcessState = linuxCapture(false), captureStrictLinuxProcessState = linuxCapture(true);
const validPid = (pid: number): void => { if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) throw new Error("Invalid process identity."); };
const capturePosixProcessState = async (pid: number, timeoutMs: number, expected?: ProcessProof): Promise<{ proof: ProcessProof; zombie: boolean; exiting: boolean; status: string }> => {
  if (process.platform === "linux") return expected === undefined ? captureLinuxProcessState(pid, timeoutMs) : captureStrictLinuxProcessState(pid, timeoutMs, observed => completedLinuxObservationDeadline(expected, observed), (error, partial) => retainPartialIdentityFailure(expected, error, partial));
  const output = await run("ps", ["-p", String(pid), "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat=", "-o", "lstart=", "-o", "command="], timeoutMs);
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+([^\n]+)\s*$/u.exec(output);
  if (match === null || Number(match[1]) !== pid) throw new Error("Process identity cannot be established.");
  return { proof: { pid, parentPid: Number(match[2]), processGroupId: Number(match[3]), startedAt: match[5]!.replace(/\s+/g, " "), commandHash: hash(match[6]!.trim()) }, zombie: match[4]!.startsWith("Z"), exiting: process.platform === "darwin" && match[4]!.includes("E"), status: match[4]! };
};
export const captureProcessProof = async (pid: number, timeoutMs = process.platform === "win32" ? 15_000 : 5000): Promise<ProcessProof> => {
  validPid(pid);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error("Process identity timeout must be a positive supported integer.");
  if (process.platform === "win32") return captureWindowsProcessProof(pid, timeoutMs);
  const observed = await capturePosixProcessState(pid, timeoutMs);
  if (observed.zombie || observed.exiting) throw new Error("An exiting process cannot supply a running process proof.");
  return observed.proof;
};
export const captureControllerProcessProof = async (launchId: string): Promise<ProcessProof> => {
  const proof = await captureProcessProof(process.pid);
  return process.platform === "win32" ? { ...proof, jobObjectName: await (process.env.DAYNIGHT_CONTROLLER_ASSIGNED_JOB === launchId ? adoptOwnedControllerJob(launchId) : createOwnedControllerJob(launchId, process.pid)) } : proof;
};
type ProcessMismatch = { status: string | null; sameBirth: boolean; sameParent: boolean; sameGroup: boolean; sameCommand: boolean };
export class ControllerProcessIdentityConflictError extends Error {
  constructor(readonly pid: number, readonly evidence: ProcessMismatch) {
    super("An original process has conflicting identity evidence; complete stop is unconfirmed.");
  }
}
const completedLinuxObservationDeadline = (expected: ProcessProof, observed: { proof: ProcessProof; zombie: boolean; exiting: boolean; status: string }): Error => {
  const current = observed.proof;
  const evidence = { status: observed.status, sameBirth: current.startedAt === expected.startedAt, sameParent: current.parentPid === expected.parentPid, sameGroup: current.processGroupId === expected.processGroupId, sameCommand: current.commandHash === expected.commandHash };
  if (!observed.zombie && evidence.sameBirth && evidence.sameParent && evidence.sameGroup && evidence.sameCommand) {
    return recordObservationDeadline(new ControllerProcessObservationDeadlineError(undefined));
  }
  if (!observed.zombie && !observed.exiting && evidence.sameBirth && (!evidence.sameGroup || !evidence.sameCommand)) return new ControllerProcessIdentityConflictError(expected.pid, evidence);
  return new Error("Linux process observation exceeded its deadline with incomplete or conflicting identity evidence; stop remains unconfirmed.");
};
const retainPartialIdentityFailure = (expected: ProcessProof, error: unknown, partial: LinuxPartialObservation): unknown => {
  const stat = partial.stat, first = partial.first;
  const birth = stat === undefined || partial.boot === undefined ? undefined : `linux:v1:${partial.boot}:${stat.ticks}`;
  const conflict = partial.boot !== undefined && !expected.startedAt.startsWith(`linux:v1:${partial.boot}:`)
    || birth !== undefined && birth !== expected.startedAt
    || stat !== undefined && stat.group !== expected.processGroupId
    || stat !== undefined && !stat.zombie && !stat.exiting && stat.parent !== expected.parentPid
    || stat !== undefined && first !== undefined && (first.group !== stat.group || !stat.zombie && !stat.exiting && (first.parent !== stat.parent || first.zombie || hash(first.command) !== expected.commandHash));
  if (!conflict) return error;
  return new AggregateError([error, new Error("Linux process identity conflicts with the original or with the partial observation.")], `Linux process observation failed with conflicting identity evidence: ${error instanceof Error ? error.message : "unknown failure"}`, { cause: error });
};
const isMissingLinuxStat = (error: unknown, pid: number): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const evidence = missingLinuxStats.get(error);
  return evidence !== undefined && evidence.path === `/proc/${pid}/stat` && evidence.intact();
};
/** An authenticated signal was sent, but the original group did not finish within the observation budget. */
export class ControllerProcessWaitDeadlineError extends Error {
  constructor(readonly phase: "term" | "kill") {
    super("Controller process operation exceeded its deadline.");
    this.name = "ControllerProcessWaitDeadlineError";
  }
}
type ProcessObservationOptions = { strictObservation?: boolean };
const inspectProcessState = async (proof: ProcessProof, timeoutMs: number, onMismatch?: (evidence: ProcessMismatch) => void, options: ProcessObservationOptions = {}): Promise<"running" | "stopped" | "replaced" | "exiting"> => {
  validPid(proof.pid);
  if (process.platform === "win32") return inspectWindowsProcessProof(proof, timeoutMs, onMismatch);
  try { process.kill(proof.pid, 0); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return "stopped"; throw new Error("Process liveness could not be established.", { cause: error }); }
  if (!isProcessBirth(proof.startedAt)) throw new Error("The saved process birth identity has an unsupported or invalid format; original evidence is retained.");
  if (process.platform === "linux" && !isLinuxProcessBirth(proof.startedAt)) throw new Error("The saved Linux process proof lacks a stable kernel birth identity; the live process cannot be authorized for recovery or stopping, and original evidence is retained.");
  let current: ProcessProof, zombie = false, exiting = false, status: string | null = null;
  try {
    let observed: Awaited<ReturnType<typeof capturePosixProcessState>>;
    if (process.platform === "linux") {
      const deadline = performance.now() + timeoutMs;
      let completed: Awaited<ReturnType<typeof capturePosixProcessState>> | undefined;
      const budget = () => {
        const left = deadline - performance.now();
        if (left <= 0) throw options.strictObservation !== true || completed === undefined ? new Error("Linux process observation exceeded its deadline; stop remains unconfirmed.") : completedLinuxObservationDeadline(proof, completed);
        return left;
      };
      for (;;) {
        observed = await capturePosixProcessState(proof.pid, Math.max(1, Math.ceil(budget())), options.strictObservation === true ? proof : undefined);
        completed = observed;
        const left = budget();
        // Linux can clear argv before becoming a zombie. Its kernel exit flag
        // permits only a bounded wait, never signaling or declaring it stopped.
        if (!observed.exiting || observed.proof.startedAt !== proof.startedAt
          || observed.proof.processGroupId !== proof.processGroupId) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(25, left)));
      }
    } else observed = await capturePosixProcessState(proof.pid, timeoutMs);
    current = observed.proof; zombie = observed.zombie; exiting = observed.exiting; status = observed.status;
  }
  catch (error) {
    if (process.platform !== "linux" || options.strictObservation !== true || isMissingLinuxStat(error, proof.pid)) {
      try { process.kill(proof.pid, 0); } catch (missing) { if (missing instanceof Error && "code" in missing && missing.code === "ESRCH") return "stopped"; }
    }
    throw error;
  }
  // A zombie's parent and command can change after the original parent exits.
  // Birth and group still fence this single exited process, not its descendants.
  if (current.startedAt === proof.startedAt && current.processGroupId === proof.processGroupId) {
    if (zombie) return "stopped";
    // Darwin can discard the command line before the process becomes a zombie.
    // This state permits waiting only, not signaling on incomplete identity.
    if (exiting && current.parentPid === proof.parentPid) return "exiting";
  }
  if (current.startedAt === proof.startedAt && current.commandHash === proof.commandHash && current.processGroupId === proof.processGroupId) return "running";
  onMismatch?.({ status, sameBirth: current.startedAt === proof.startedAt, sameParent: current.parentPid === proof.parentPid, sameGroup: current.processGroupId === proof.processGroupId, sameCommand: current.commandHash === proof.commandHash });
  return "replaced";
};
export const inspectProcessProof = async (proof: ProcessProof, timeoutMs = 5000, options: ProcessObservationOptions = {}): Promise<"running" | "stopped" | "replaced"> => {
  const state = await inspectProcessState(proof, timeoutMs, undefined, options);
  if (state === "exiting") throw new Error("The original process is exiting and its full identity cannot be rechecked yet.");
  return state;
};
export const inspectBootstrapProcessProof = (proof: ProcessProof, timeoutMs = 5000, onMismatch?: (evidence: ProcessMismatch) => void): Promise<"running" | "stopped" | "replaced" | "exiting"> => inspectProcessState(proof, timeoutMs, onMismatch);
const remaining = (deadline: number | undefined, maximum = 5000): number => {
  if (deadline === undefined) return maximum;
  if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new Error("Invalid controller process deadline.");
  const left = deadline - Date.now();
  if (left <= 0) throw new Error("Controller process operation exceeded its deadline.");
  return Math.min(maximum, left);
};
const bounded = async <T>(deadline: number | undefined, action: () => Promise<T>): Promise<T> => {
  try { return await action(); }
  catch (cause) {
    if (deadline !== undefined && Date.now() >= deadline) {
      const aggregate = new AggregateError([cause, new Error("Controller process operation exceeded its deadline.")], "Controller process observation failed at its deadline.", { cause });
      throw isControllerProcessObservationDeadline(cause) ? recordObservationDeadline(aggregate, cause) : aggregate;
    }
    throw cause;
  }
};
const groupMembers = async (group: number, deadline?: number, waitPhase?: "term" | "kill"): Promise<number[]> => {
  if (waitPhase !== undefined && deadline !== undefined && Date.now() >= deadline) throw new ControllerProcessWaitDeadlineError(waitPhase);
  const rows = await bounded(deadline, () => run("ps", ["-A", "-o", "pid=", "-o", "pgid=", "-o", "stat="], remaining(deadline)));
  const result: number[] = [];
  for (const row of rows.split("\n")) { if (row.trim() === "") continue; const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(row); if (match === null) throw new Error("Cannot interpret process group inventory."); if (Number(match[2]) === group && !match[3]!.startsWith("Z")) result.push(Number(match[1])); }
  if (waitPhase !== undefined && deadline !== undefined && Date.now() >= deadline) throw new ControllerProcessWaitDeadlineError(waitPhase);
  remaining(deadline);
  return result;
};
const confirmRetainedProcessesStopped = async (controller: ProcessProof, native: readonly ProcessProof[], deadline?: number, options: ProcessObservationOptions = {}): Promise<boolean> => {
  for (const proof of [controller, ...native]) {
    let mismatch: ProcessMismatch | undefined;
    const state = await bounded(deadline, () => inspectProcessState(proof, remaining(deadline), evidence => { mismatch = evidence; }, options));
    remaining(deadline);
    if (state === "running" || state === "exiting") return false;
    if (state === "replaced" && mismatch?.sameBirth === true) throw new ControllerProcessIdentityConflictError(proof.pid, mismatch);
  }
  return true;
};
export const confirmControllerProcessesStopped = async (controller: ProcessProof, native: readonly ProcessProof[], deadline?: number, lease?: ControllerJobLease, options: ProcessObservationOptions = {}): Promise<boolean> => {
  if (!await confirmRetainedProcessesStopped(controller, native, deadline, options)) return false;
  if (process.platform === "win32") {
    if (controller.jobObjectName === undefined) throw new Error("The original Windows controller has no Job Object boundary; its descendants cannot be inferred stopped.");
    if (lease === undefined) throw new Error("The original Windows Job Object lease is unavailable; complete process-tree stop is unconfirmed.");
    remaining(deadline);
    const members = await bounded(deadline, () => inspectControllerJobLease(lease, controller, false, deadline));
    remaining(deadline);
    return members.length === 0;
  }
  if (controller.processGroupId !== controller.pid) throw new Error("Controller was not launched in its own process group.");
  return (await groupMembers(controller.pid, deadline)).length === 0;
};
/** Only the original command owner can supply its joined child handle. */
export const confirmClosedOwnedCommandGroup = async (proof: ProcessProof, child: { pid?: number | undefined; exitCode: number | null; signalCode: NodeJS.Signals | null }, deadline: number): Promise<boolean> => {
  if (process.platform !== "linux" || child.pid !== proof.pid || child.exitCode === null && child.signalCode === null) throw new Error("Original owned command child closure is unconfirmed.");
  if (proof.processGroupId !== proof.pid) throw new Error("Owned command was not launched in its own process group.");
  return (await groupMembers(proof.pid, deadline)).length === 0;
};
export const stopControllerProcesses = async (controller: ProcessProof, native: readonly ProcessProof[], deadline: number, lease?: ControllerJobLease, options: ProcessObservationOptions & { guardian?: boolean } = {}): Promise<void> => {
  remaining(deadline);
  if (process.platform === "win32") {
    if (controller.jobObjectName === undefined) throw new Error("The original Windows controller has no Job Object boundary; cleanup retains its unknown descendants.");
    if (lease === undefined) throw new Error("The original Windows Job Object lease is unavailable; complete process-tree stop is unconfirmed.");
    await withWindowsProcessStopHandles([controller, ...native], deadline, async () => {
      await bounded(deadline, () => inspectControllerJobLease(lease, controller, true, deadline));
      remaining(deadline);
    });
    return;
  }
  if (controller.processGroupId !== controller.pid) throw new Error("Refusing a process group not owned by the original controller.");
  const signal = async (value: NodeJS.Signals): Promise<boolean> => {
    if ((await groupMembers(controller.pid, deadline)).length === 0) return false;
    let attributable = false, originalsStopped = true;
    for (const proof of [controller, ...native]) {
      if (proof.processGroupId !== controller.pid) continue;
      const state = await bounded(deadline, () => inspectProcessProof(proof, remaining(deadline), options));
      remaining(deadline);
      if (state === "running") attributable = true;
      if (state !== "stopped") originalsStopped = false;
    }
    if (!attributable) {
      // Original Linux instances can finish before their descendants. Once all
      // originals stopped, wait without signaling; conflicts never admit this wait.
      if (process.platform === "linux") {
        while ((await groupMembers(controller.pid, deadline)).length > 0) {
          if (!originalsStopped) throw new Error("The remaining process group has no original process-instance proof; resources are retained.");
          await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining(deadline))));
        }
        return false;
      }
      throw new Error("The remaining process group has no original process-instance proof; resources are retained.");
    }
    remaining(deadline);
    try { process.kill(-controller.pid, value); return true; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return false; throw error; }
  };
  if (!await signal("SIGTERM")) return;
  const graceful = Math.min(deadline, Date.now() + 2000);
  while (Date.now() < graceful) {
    // Do not start a new ps process when its available time is shorter than
    // the polling interval. The completed signal remains the last action.
    if (deadline - Date.now() <= 25) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now())));
      throw new ControllerProcessWaitDeadlineError("term");
    }
    const members = await groupMembers(controller.pid, deadline, "term");
    // A trusted command guardian remains alive solely to preserve the original
    // group identity. With no descendants left it needs no graceful interval;
    // signal() still authenticates the original proof before the final kill.
    if (members.length === 0 || options.guardian === true && members.length === 1 && members[0] === controller.pid) break;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(25, graceful - Date.now()))));
  }
  if (Date.now() >= deadline) throw new ControllerProcessWaitDeadlineError("term");
  if (!await signal("SIGKILL")) return;
  while (Date.now() < deadline) {
    if (deadline - Date.now() <= 25) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now())));
      throw new ControllerProcessWaitDeadlineError("kill");
    }
    if ((await groupMembers(controller.pid, deadline, "kill")).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
  }
  if (Date.now() >= deadline) throw new ControllerProcessWaitDeadlineError("kill");
};
