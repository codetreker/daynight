import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

export type ProcessEvidence = { pid: number; group: number; start: string; boot: string; commandHash: string };
type Observation = { group: number; start: string; state: string };
const observe = async (pid: number): Promise<Observation | null> => {
  try {
    const line = await readFile(`/proc/${pid}/stat`, "utf8"), end = line.lastIndexOf(") ");
    const fields = line.slice(end + 2).trim().split(/\s+/);
    if (end < 0 || fields.length < 20 || !/^\d+$/.test(fields[2]!) || !/^\d+$/.test(fields[19]!)) throw new Error("Process identity is malformed.");
    return { state: fields[0]!, group: Number(fields[2]), start: fields[19]! };
  } catch (error) { if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return null; throw error; }
};
export const captureProcessEvidence = async (pid: number): Promise<ProcessEvidence> => {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Process identity is invalid.");
  const before = await observe(pid);
  if (before === null || ["Z", "X"].includes(before.state)) throw new Error("Original process is not running.");
  const command = await readFile(`/proc/${pid}/cmdline`), boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const after = await observe(pid);
  if (!command.length || !boot || after === null || before.group !== after.group || before.start !== after.start || ["Z", "X"].includes(after.state)) throw new Error("Original process identity changed during capture.");
  return { pid, group: before.group, start: before.start, boot, commandHash: createHash("sha256").update(command).digest("hex") };
};
export const inspectProcessEvidence = async (proof: ProcessEvidence): Promise<"running" | "stopped"> => {
  if (!proof || !Number.isSafeInteger(proof.pid) || proof.pid <= 0 || !Number.isSafeInteger(proof.group) || proof.group <= 0
    || !/^\d+$/.test(proof.start) || !/^[0-9a-f-]{36}$/.test(proof.boot) || !/^[0-9a-f]{64}$/.test(proof.commandHash)) throw new Error("Original process proof is invalid.");
  const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (boot !== proof.boot) throw new Error("Original process boot identity conflicts.");
  const first = await observe(proof.pid);
  if (first === null) return "stopped";
  if (first.start !== proof.start || first.group !== proof.group) throw new Error("Original process identity conflicts.");
  if (["Z", "X"].includes(first.state)) return "stopped";
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const actual = await captureProcessEvidence(proof.pid);
      if (JSON.stringify(actual) !== JSON.stringify(proof)) throw new Error("Original process identity conflicts.");
      return "running";
    } catch (error) {
      const after = await observe(proof.pid);
      if (after === null || after.start === proof.start && after.group === proof.group && ["Z", "X"].includes(after.state)) return "stopped";
      if (after.start !== proof.start || after.group !== proof.group || attempt === 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error("Original process identity is unavailable.");
};
const groupMembers = async (group: number): Promise<number[]> => {
  const members: number[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name), entry = await observe(pid);
    if (entry !== null && entry.group === group && !["Z", "X"].includes(entry.state)) members.push(pid);
  }
  return members;
};
export const stopEvidenceGroup = async (leader: ProcessEvidence, children: readonly ProcessEvidence[], deadline: number): Promise<void> => {
  if (leader.pid !== leader.group || children.some(child => child.group !== leader.group)) throw new Error("Original process group proof is invalid.");
  const members = async () => { if (Date.now() >= deadline) throw new Error("Original process group stop exceeded its deadline."); return groupMembers(leader.group); };
  const signal = async (value: NodeJS.Signals): Promise<void> => {
    if ((await members()).length === 0) return;
    let attributable = false;
    for (const proof of [leader, ...children]) if (await inspectProcessEvidence(proof) === "running") attributable = true;
    if (!attributable) {
      if ((await members()).length === 0) return;
      throw new Error("Original process group has no live instance proof.");
    }
    try { process.kill(-leader.group, value); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
  };
  await signal("SIGTERM");
  const graceful = Math.min(deadline, Date.now() + 2_000);
  while (Date.now() < graceful && (await members()).length > 0) await new Promise(resolve => setTimeout(resolve, 25));
  await signal("SIGKILL");
  while ((await members()).length > 0) await new Promise(resolve => setTimeout(resolve, 25));
  for (const proof of [leader, ...children]) if (await inspectProcessEvidence(proof) === "running") throw new Error("Original process did not stop.");
};
