import { createControllerJob, inspectControllerJob } from "./windows-job.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
export type ProcessProof = { readonly pid: number; readonly parentPid: number; readonly processGroupId: number | null; readonly startedAt: string; readonly commandHash: string; readonly jobObjectName?: string };
// ps localizes lstart, so identity probes need a stable locale. Keep the
// Controller and native provider environments unchanged.
const run = (file: string, args: string[]): Promise<string> => new Promise((resolve, reject) => execFile(file, args, { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...(file === "ps" ? { env: { ...process.env, LC_ALL: "C" } } : {}) }, (error, stdout) => error === null ? resolve(stdout) : reject(error)));
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const validPid = (pid: number): void => { if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) throw new Error("Invalid process identity."); };
export const captureProcessProof = async (pid: number): Promise<ProcessProof> => {
  validPid(pid);
  if (process.platform === "win32") {
    const output = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId,ParentProcessId,@{Name='Birth';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},CommandLine | ConvertTo-Json -Compress`]);
    const value = JSON.parse(output) as { ProcessId: number; ParentProcessId: number; Birth: string; CommandLine: string };
    if (value.ProcessId !== pid || typeof value.Birth !== "string" || typeof value.CommandLine !== "string") throw new Error("Process identity cannot be established.");
    return { pid, parentPid: value.ParentProcessId, processGroupId: null, startedAt: value.Birth, commandHash: hash(value.CommandLine) };
  }
  const output = await run("ps", ["-p", String(pid), "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "lstart=", "-o", "command="]);
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+([^\n]+)\s*$/u.exec(output);
  if (match === null || Number(match[1]) !== pid) throw new Error("Process identity cannot be established.");
  return { pid, parentPid: Number(match[2]), processGroupId: Number(match[3]), startedAt: match[4]!.replace(/\s+/g, " "), commandHash: hash(match[5]!.trim()) };
};
export const captureControllerProcessProof = async (launchId: string): Promise<ProcessProof> => {
  const proof = await captureProcessProof(process.pid);
  return process.platform === "win32" ? { ...proof, jobObjectName: await createControllerJob(launchId, process.pid) } : proof;
};
export const inspectProcessProof = async (proof: ProcessProof): Promise<"running" | "stopped" | "replaced"> => {
  validPid(proof.pid);
  try { process.kill(proof.pid, 0); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return "stopped"; throw new Error("Process liveness could not be established.", { cause: error }); }
  let current: ProcessProof;
  try { current = await captureProcessProof(proof.pid); }
  catch (error) { try { process.kill(proof.pid, 0); } catch (missing) { if (missing instanceof Error && "code" in missing && missing.code === "ESRCH") return "stopped"; } throw error; }
  return current.startedAt === proof.startedAt && current.commandHash === proof.commandHash && current.processGroupId === proof.processGroupId ? "running" : "replaced";
};
const groupMembers = async (group: number): Promise<number[]> => {
  const rows = await run("ps", ["-A", "-o", "pid=", "-o", "pgid=", "-o", "stat="]);
  const result: number[] = [];
  for (const row of rows.split("\n")) { if (row.trim() === "") continue; const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(row); if (match === null) throw new Error("Cannot interpret process group inventory."); if (Number(match[2]) === group && !match[3]!.startsWith("Z")) result.push(Number(match[1])); }
  return result;
};
export const confirmControllerProcessesStopped = async (controller: ProcessProof, native: readonly ProcessProof[]): Promise<boolean> => {
  for (const proof of [controller, ...native]) if (await inspectProcessProof(proof) === "running") return false;
  if (process.platform === "win32") { if (controller.jobObjectName === undefined) throw new Error("The original Windows controller has no Job Object boundary; its descendants cannot be inferred stopped."); return (await inspectControllerJob(controller.jobObjectName)).length === 0; }
  if (controller.processGroupId !== controller.pid) throw new Error("Controller was not launched in its own process group.");
  return (await groupMembers(controller.pid)).length === 0;
};
export const stopControllerProcesses = async (controller: ProcessProof, native: readonly ProcessProof[], deadline: number): Promise<void> => {
  if (process.platform === "win32") {
    if (controller.jobObjectName === undefined) throw new Error("The original Windows controller has no Job Object boundary; cleanup retains its unknown descendants.");
    await inspectControllerJob(controller.jobObjectName, true);
    while (Date.now() < deadline && (await inspectControllerJob(controller.jobObjectName)).length > 0) await new Promise(resolve=>setTimeout(resolve,25));
    if (!await confirmControllerProcessesStopped(controller,native)) throw new Error("The original Windows Job Object did not stop completely.");
    return;
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
