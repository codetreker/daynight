import { createControllerJob, inspectControllerJob } from "./windows-job.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { captureWindowsProcessProof } from "./windows-process-proof.js";
export type ProcessProof = { readonly pid: number; readonly parentPid: number; readonly processGroupId: number | null; readonly startedAt: string; readonly commandHash: string; readonly jobObjectName?: string };
// ps localizes lstart, so identity probes need a stable locale. Keep the
// Controller and native provider environments unchanged.
const run = (file: string, args: string[], timeout = 5000): Promise<string> => new Promise((resolve, reject) => execFile(file, args, { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...(file === "ps" ? { env: { ...process.env, LC_ALL: "C" } } : {}) }, (error, stdout) => error === null ? resolve(stdout) : reject(error)));
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const validPid = (pid: number): void => { if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) throw new Error("Invalid process identity."); };
const capturePosixProcessState = async (pid: number, timeoutMs: number): Promise<{ proof: ProcessProof; zombie: boolean; exiting: boolean; status: string }> => {
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
  return process.platform === "win32" ? { ...proof, jobObjectName: await createControllerJob(launchId, process.pid) } : proof;
};
type ProcessMismatch = { status: string | null; sameBirth: boolean; sameParent: boolean; sameGroup: boolean; sameCommand: boolean };
const inspectProcessState = async (proof: ProcessProof, timeoutMs: number, onMismatch?: (evidence: ProcessMismatch) => void): Promise<"running" | "stopped" | "replaced" | "exiting"> => {
  validPid(proof.pid);
  try { process.kill(proof.pid, 0); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return "stopped"; throw new Error("Process liveness could not be established.", { cause: error }); }
  let current: ProcessProof, zombie = false, exiting = false, status: string | null = null;
  try {
    if (process.platform === "win32") current = await captureProcessProof(proof.pid, timeoutMs);
    else { const observed = await capturePosixProcessState(proof.pid, timeoutMs); current = observed.proof; zombie = observed.zombie; exiting = observed.exiting; status = observed.status; }
  }
  catch (error) { try { process.kill(proof.pid, 0); } catch (missing) { if (missing instanceof Error && "code" in missing && missing.code === "ESRCH") return "stopped"; } throw error; }
  // A zombie's parent and command can change after the original parent exits.
  // Birth and group still fence this single exited process, not its descendants.
  if (current.startedAt === proof.startedAt && current.processGroupId === proof.processGroupId) {
    if (zombie) return "stopped";
    // Darwin can discard the command line before the process becomes a zombie.
    // This state permits waiting only, not signaling on incomplete identity.
    if (exiting && current.parentPid === proof.parentPid) return "exiting";
  }
  // The original birth still identifies a live Windows process. Conflicting
  // command evidence cannot authorize releasing its resources as a reused PID.
  if (process.platform === "win32" && current.startedAt === proof.startedAt && (current.commandHash !== proof.commandHash || current.processGroupId !== proof.processGroupId)) throw new Error("The original Windows process has inconsistent identity evidence; ownership remains unknown.");
  if (current.startedAt === proof.startedAt && current.commandHash === proof.commandHash && current.processGroupId === proof.processGroupId) return "running";
  onMismatch?.({ status, sameBirth: current.startedAt === proof.startedAt, sameParent: current.parentPid === proof.parentPid, sameGroup: current.processGroupId === proof.processGroupId, sameCommand: current.commandHash === proof.commandHash });
  return "replaced";
};
export const inspectProcessProof = async (proof: ProcessProof, timeoutMs = 5000): Promise<"running" | "stopped" | "replaced"> => {
  const state = await inspectProcessState(proof, timeoutMs);
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
    if (deadline !== undefined && Date.now() >= deadline) throw new AggregateError([cause, new Error("Controller process operation exceeded its deadline.")], "Controller process observation failed at its deadline.", { cause });
    throw cause;
  }
};
const groupMembers = async (group: number, deadline?: number): Promise<number[]> => {
  const rows = await bounded(deadline, () => run("ps", ["-A", "-o", "pid=", "-o", "pgid=", "-o", "stat="], remaining(deadline)));
  remaining(deadline);
  const result: number[] = [];
  for (const row of rows.split("\n")) { if (row.trim() === "") continue; const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(row); if (match === null) throw new Error("Cannot interpret process group inventory."); if (Number(match[2]) === group && !match[3]!.startsWith("Z")) result.push(Number(match[1])); }
  return result;
};
const confirmRetainedProcessesStopped = async (controller: ProcessProof, native: readonly ProcessProof[], deadline?: number): Promise<boolean> => {
  for (const proof of [controller, ...native]) {
    let mismatch: ProcessMismatch | undefined;
    const state = await bounded(deadline, () => inspectProcessState(proof, remaining(deadline), evidence => { mismatch = evidence; }));
    remaining(deadline);
    if (state === "running" || state === "exiting") return false;
    if (state === "replaced" && mismatch?.sameBirth === true) throw new Error("An original process has conflicting identity evidence; complete stop is unconfirmed.");
  }
  return true;
};
export const confirmControllerProcessesStopped = async (controller: ProcessProof, native: readonly ProcessProof[], deadline?: number): Promise<boolean> => {
  if (!await confirmRetainedProcessesStopped(controller, native, deadline)) return false;
  if (process.platform === "win32") {
    if (controller.jobObjectName === undefined) throw new Error("The original Windows controller has no Job Object boundary; its descendants cannot be inferred stopped.");
    remaining(deadline);
    const members = await bounded(deadline, () => inspectControllerJob(controller.jobObjectName!, false, deadline));
    remaining(deadline);
    return members.length === 0;
  }
  if (controller.processGroupId !== controller.pid) throw new Error("Controller was not launched in its own process group.");
  return (await groupMembers(controller.pid, deadline)).length === 0;
};
export const stopControllerProcesses = async (controller: ProcessProof, native: readonly ProcessProof[], deadline: number): Promise<void> => {
  remaining(deadline);
  if (process.platform === "win32") {
    if (controller.jobObjectName === undefined) throw new Error("The original Windows controller has no Job Object boundary; cleanup retains its unknown descendants.");
    await bounded(deadline, () => inspectControllerJob(controller.jobObjectName!, true, deadline, [controller, ...native]));
    remaining(deadline);
    // Job termination is asynchronous. An empty inventory is insufficient until
    // every retained original process identity also confirms it has stopped.
    while (Date.now() < deadline) {
      if (await confirmRetainedProcessesStopped(controller, native, deadline)) return;
      const left = deadline - Date.now();
      if (left <= 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(25, left)));
    }
    throw new Error("The original Windows Job Object did not stop completely.");
  }
  if (controller.processGroupId !== controller.pid) throw new Error("Refusing a process group not owned by the original controller.");
  const signal = async (value: NodeJS.Signals): Promise<boolean> => {
    if ((await groupMembers(controller.pid, deadline)).length === 0) return false;
    let attributable = false;
    for (const proof of [controller, ...native]) {
      if (proof.processGroupId !== controller.pid) continue;
      const state = await bounded(deadline, () => inspectProcessProof(proof, remaining(deadline)));
      remaining(deadline);
      if (state === "running") attributable = true;
    }
    if (!attributable) throw new Error("The remaining process group has no original process-instance proof; resources are retained.");
    remaining(deadline);
    try { process.kill(-controller.pid, value); return true; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return false; throw error; }
  };
  if (!await signal("SIGTERM")) return;
  const graceful = Math.min(deadline, Date.now() + 2000);
  while (Date.now() < graceful && (await groupMembers(controller.pid, deadline)).length > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(25, graceful - Date.now())));
  if (!await signal("SIGKILL")) return;
  while (Date.now() < deadline && (await groupMembers(controller.pid, deadline)).length > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
  if ((await groupMembers(controller.pid, deadline)).length > 0) throw new Error("Original controller process group did not stop by its deadline.");
};
