import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { captureWindowsProcessProof } from "./windows-process-proof.js";
import type { ControllerLaunchTicket } from "./launch-ticket.js";
export type ProcessProof = { readonly pid: number; readonly parentPid: number; readonly processGroupId: number | null; readonly startedAt: string; readonly commandHash: string; readonly jobObjectName?: string };
// ps localizes lstart, so identity probes need a stable locale. Keep the
// Controller and native provider environments unchanged.
const run = (file: string, args: string[], timeout = 5000): Promise<string> => new Promise((resolve, reject) => execFile(file, args, { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...(file === "ps" ? { env: { ...process.env, LC_ALL: "C" } } : {}) }, (error, stdout) => error === null ? resolve(stdout) : reject(error)));
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const validPid = (pid: number): void => { if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) throw new Error("Invalid process identity."); };
export const captureProcessProof = async (pid: number, timeoutMs = process.platform === "win32" ? 15_000 : 5000): Promise<ProcessProof> => {
  validPid(pid);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error("Process identity timeout must be a positive supported integer.");
  if (process.platform === "win32") return captureWindowsProcessProof(pid, timeoutMs);
  const output = await run("ps", ["-p", String(pid), "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "lstart=", "-o", "command="], timeoutMs);
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+([^\n]+)\s*$/u.exec(output);
  if (match === null || Number(match[1]) !== pid) throw new Error("Process identity cannot be established.");
  return { pid, parentPid: Number(match[2]), processGroupId: Number(match[3]), startedAt: match[4]!.replace(/\s+/g, " "), commandHash: hash(match[5]!.trim()) };
};
export const captureControllerProcessProof = async (launchId: string, context?: { ticket: ControllerLaunchTicket; journalPath: string }): Promise<ProcessProof> => {
  const proof = await captureProcessProof(process.pid);
  if (process.platform !== "win32") return proof;
  if (context === undefined || context.ticket.launchId !== launchId) throw new Error("The original Windows Controller Job context is required.");
  const { startWindowsJobGuardian } = await import("./windows-job-launch.js");
  await startWindowsJobGuardian({ ...context, controller: proof });
  return { ...proof, jobObjectName: `Local\\Daynight-${launchId}` };
};
export const inspectProcessProof = async (proof: ProcessProof): Promise<"running" | "stopped" | "replaced"> => {
  validPid(proof.pid);
  try { process.kill(proof.pid, 0); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return "stopped"; throw new Error("Process liveness could not be established.", { cause: error }); }
  let current: ProcessProof;
  try { current = await captureProcessProof(proof.pid, 5000); }
  catch (error) { try { process.kill(proof.pid, 0); } catch (missing) { if (missing instanceof Error && "code" in missing && missing.code === "ESRCH") return "stopped"; } throw error; }
  // The original birth still identifies a live Windows process. Conflicting
  // command evidence cannot authorize releasing its resources as a reused PID.
  if (process.platform === "win32" && current.startedAt === proof.startedAt && (current.commandHash !== proof.commandHash || current.processGroupId !== proof.processGroupId)) throw new Error("The original Windows process has inconsistent identity evidence; ownership remains unknown.");
  return current.startedAt === proof.startedAt && current.commandHash === proof.commandHash && current.processGroupId === proof.processGroupId ? "running" : "replaced";
};
const groupMembers = async (group: number): Promise<number[]> => {
  const rows = await run("ps", ["-A", "-o", "pid=", "-o", "pgid=", "-o", "stat="]);
  const result: number[] = [];
  for (const row of rows.split("\n")) { if (row.trim() === "") continue; const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(row); if (match === null) throw new Error("Cannot interpret process group inventory."); if (Number(match[2]) === group && !match[3]!.startsWith("Z")) result.push(Number(match[1])); }
  return result;
};
export const confirmControllerProcessesStopped = async (controller: ProcessProof, native: readonly ProcessProof[]): Promise<boolean> => {
  if (process.platform === "win32") throw new Error("Windows Controller stop requires the original held Job and its receipt.");
  for (const proof of [controller, ...native]) if (await inspectProcessProof(proof) === "running") return false;
  if (controller.processGroupId !== controller.pid) throw new Error("Controller was not launched in its own process group.");
  return (await groupMembers(controller.pid)).length === 0;
};
export const stopControllerProcesses = async (controller: ProcessProof, native: readonly ProcessProof[], deadline: number): Promise<void> => {
  if (process.platform === "win32") {
    throw new Error("Windows Controller stop requires the original held Job and its receipt.");
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
