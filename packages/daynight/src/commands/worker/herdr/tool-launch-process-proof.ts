import { readFile } from "node:fs/promises";
import { captureProcessProof, inspectProcessProof, type ProcessProof } from "../../controller/process-proof.js";
import { inspectWindowsProcessProof } from "../../controller/windows-process-proof.js";

export type MappingProcessProof = ProcessProof & { readonly birthToken?: string };
export const validLinuxBirthToken = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]+$/.test(value);
export const parseLinuxProcessBirth = (pid: number, stat: string, bootId: string): { token: string; parentPid: number; processGroupId: number } => {
  const end = stat.lastIndexOf(")"), prefix = stat.slice(0, end + 1), fields = stat.slice(end + 1).trim().split(/\s+/), token = `${bootId.trim()}:${fields[19]}`;
  const positive = (value: string | undefined, zero = false) => value !== undefined && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= (zero ? 0 : 1);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !prefix.startsWith(`${pid} (`) || end < 0 || fields.length < 20 || fields[0] === "Z" || !positive(fields[1], true) || !positive(fields[2]) || !validLinuxBirthToken(token)) throw new Error("The original Linux process birth identity cannot be established.");
  return { token, parentPid: Number(fields[1]), processGroupId: Number(fields[2]) };
};
const linuxBirth = async (pid: number) => {
  const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8")]);
  return parseLinuxProcessBirth(pid, stat, boot);
};

/** Linux lstart has only second precision; proc start ticks fence same-second PID reuse. */
export const captureMappingProcessProof = async (pid: number, timeoutMs = 5000): Promise<MappingProcessProof> => {
  if (process.platform !== "linux") return captureProcessProof(pid, timeoutMs);
  const before = await linuxBirth(pid), proof = await captureProcessProof(pid, timeoutMs), after = await linuxBirth(pid);
  if (before.token !== after.token || before.parentPid !== after.parentPid || before.processGroupId !== after.processGroupId || proof.parentPid !== after.parentPid || proof.processGroupId !== after.processGroupId) throw new Error("The original Linux process changed during birth registration.");
  return { ...proof, birthToken: after.token };
};
const inspect = async (proof: MappingProcessProof, cleanup: boolean): Promise<"running" | "stopped" | "replaced"> => {
  if (process.platform === "linux" && !validLinuxBirthToken(proof.birthToken)) throw new Error("The original Linux process has no precise birth identity.");
  const state = await inspectProcessProof(proof);
  if (state !== "running" || process.platform !== "linux") return state;
  try { const current = await linuxBirth(proof.pid); return current.token === proof.birthToken && (cleanup || current.parentPid === proof.parentPid) && current.processGroupId === proof.processGroupId ? "running" : "replaced"; }
  catch (cause) {
    try { process.kill(proof.pid, 0); } catch (missing) { if ((missing as NodeJS.ErrnoException)?.code === "ESRCH") return "stopped"; }
    throw cause;
  }
};

export const inspectMappingProcessProof = (proof: MappingProcessProof): Promise<"running" | "stopped" | "replaced"> => inspect(proof, false);
/** A registered birth remains cleanup responsibility after its original parent exits.
 * Windows exit transitions permit waiting only, never input or completion.
 */
export const inspectMappingProcessForCleanup = (proof: MappingProcessProof): Promise<"running" | "stopped" | "replaced" | "exiting"> => process.platform === "win32" ? inspectWindowsProcessProof(proof, 5000) : inspect(proof, true);
