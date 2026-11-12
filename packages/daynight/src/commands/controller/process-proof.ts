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
const capturePosixProcessState = async (pid: number, timeoutMs: number): Promise<{ proof: ProcessProof; zombie: boolean; exiting: boolean }> => {
  const output = await run("ps", ["-p", String(pid), "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat=", "-o", "lstart=", "-o", "command="], timeoutMs);
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+([^\n]+)\s*$/u.exec(output);
  if (match === null || Number(match[1]) !== pid) throw new Error("Process identity cannot be established.");
  return { proof: { pid, parentPid: Number(match[2]), processGroupId: Number(match[3]), startedAt: match[5]!.replace(/\s+/g, " "), commandHash: hash(match[6]!.trim()) }, zombie: match[4]!.startsWith("Z"), exiting: process.platform === "darwin" && match[4]!.includes("E") };
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
const inspectProcessState = async (proof: ProcessProof, timeoutMs: number): Promise<"running" | "stopped" | "replaced" | "exiting"> => {
  validPid(proof.pid);
  try { process.kill(proof.pid, 0); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return "stopped"; throw new Error("Process liveness could not be established.", { cause: error }); }
  let current: ProcessProof, zombie = false, exiting = false;
  try {
    if (process.platform === "win32") current = await captureProcessProof(proof.pid, timeoutMs);
    else { const observed = await capturePosixProcessState(proof.pid, timeoutMs); current = observed.proof; zombie = observed.zombie; exiting = observed.exiting; }
  }
  catch (error) { try { process.kill(proof.pid, 0); } catch (missing) { if (missing instanceof Error && "code" in missing && missing.code === "ESRCH") return "stopped"; } throw error; }
  // POSIX may retain a dead child as a zombie until its parent reaps it. Its
  // command display can change, so use the same observation's birth and group.
  if (current.startedAt === proof.startedAt && current.processGroupId === proof.processGroupId && current.parentPid === proof.parentPid) {
    if (zombie) return "stopped";
    // Darwin can discard the command line before the process becomes a zombie.
    // This state permits waiting only, not signaling on incomplete identity.
    if (exiting) return "exiting";
  }
  // The original birth still identifies a live Windows process. Conflicting
  // command evidence cannot authorize releasing its resources as a reused PID.
  if (process.platform === "win32" && current.startedAt === proof.startedAt && (current.commandHash !== proof.commandHash || current.processGroupId !== proof.processGroupId)) throw new Error("The original Windows process has inconsistent identity evidence; ownership remains unknown.");
  return current.startedAt === proof.startedAt && current.commandHash === proof.commandHash && current.processGroupId === proof.processGroupId ? "running" : "replaced";
};
export const inspectProcessProof = async (proof: ProcessProof, timeoutMs = 5000): Promise<"running" | "stopped" | "replaced"> => {
  const state = await inspectProcessState(proof, timeoutMs);
  if (state === "exiting") throw new Error("The original process is exiting and its full identity cannot be rechecked yet.");
  return state;
};
export const inspectBootstrapProcessProof = (proof: ProcessProof, timeoutMs = 5000): Promise<"running" | "stopped" | "replaced" | "exiting"> => inspectProcessState(proof, timeoutMs);
const groupMembers = async (group: number): Promise<number[]> => {
  const rows = await run("ps", ["-A", "-o", "pid=", "-o", "pgid=", "-o", "stat="]);
  const result: number[] = [];
  for (const row of rows.split("\n")) { if (row.trim() === "") continue; const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(row); if (match === null) throw new Error("Cannot interpret process group inventory."); if (Number(match[2]) === group && !match[3]!.startsWith("Z")) result.push(Number(match[1])); }
  return result;
};
export const confirmControllerProcessesStopped = async (controller: ProcessProof, native: readonly ProcessProof[]): Promise<boolean> => {
  for (const proof of [controller, ...native]) {
    const state = await inspectProcessState(proof, 5000);
    if (state === "running" || state === "exiting") return false;
  }
  if (process.platform === "win32") { if (controller.jobObjectName === undefined) throw new Error("The original Windows controller has no Job Object boundary; its descendants cannot be inferred stopped."); return (await inspectControllerJob(controller.jobObjectName)).length === 0; }
  if (controller.processGroupId !== controller.pid) throw new Error("Controller was not launched in its own process group.");
  return (await groupMembers(controller.pid)).length === 0;
};
export const stopControllerProcesses = async (controller: ProcessProof, native: readonly ProcessProof[], deadline: number): Promise<void> => {
  if (process.platform === "win32") {
    if (controller.jobObjectName === undefined) throw new Error("The original Windows controller has no Job Object boundary; cleanup retains its unknown descendants.");
    await inspectControllerJob(controller.jobObjectName, true);
    // Job termination is asynchronous. An empty inventory is insufficient until
    // every retained original process identity also confirms it has stopped.
    while (Date.now() < deadline) {
      if (await confirmControllerProcessesStopped(controller, native)) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
    }
    throw new Error("The original Windows Job Object did not stop completely.");
  }
  if (controller.processGroupId !== controller.pid) throw new Error("Refusing a process group not owned by the original controller.");
  if ((await groupMembers(controller.pid)).length === 0) return;
  let attributable = false;
  for (const proof of [controller, ...native]) if (proof.processGroupId === controller.pid && await inspectProcessProof(proof) === "running") attributable = true;
  if (!attributable) throw new Error("The remaining process group has no original process-instance proof; resources are retained.");
  const signal = (value: NodeJS.Signals): void => { try { process.kill(-controller.pid, value); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; } };
  signal("SIGTERM"); const graceful = Math.min(deadline, Date.now() + 2000);
  while (Date.now() < graceful && (await groupMembers(controller.pid)).length > 0) await new Promise((resolve) => setTimeout(resolve, 25));
  if ((await groupMembers(controller.pid)).length > 0) signal("SIGKILL");
  while (Date.now() < deadline && (await groupMembers(controller.pid)).length > 0) await new Promise((resolve) => setTimeout(resolve, 25));
  if ((await groupMembers(controller.pid)).length > 0) throw new Error("Original controller process group did not stop by its deadline.");
};
