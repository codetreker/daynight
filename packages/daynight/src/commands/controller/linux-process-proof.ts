import type { ProcessProof } from "./process-proof.js";

const linuxBirth = /^linux:v1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(0|[1-9][0-9]{0,19})$/;
export const isLinuxProcessBirth = (value: unknown): value is string => typeof value === "string" && linuxBirth.test(value)
  && BigInt(value.slice(value.lastIndexOf(":") + 1)) <= 18_446_744_073_709_551_615n;
/** Historical platform tokens remain readable; reserved Linux formats must be understood. */
export const isProcessBirth = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && value.isWellFormed()
  && (!value.startsWith("linux:") || isLinuxProcessBirth(value));

type ProcessState = { proof: ProcessProof; zombie: boolean; exiting: boolean; status: string };
type LinuxPsSample = { parent: number; group: number; command: string; zombie: boolean };
export type LinuxPartialObservation = { boot?: string; stat?: ReturnType<typeof parseLinuxStat>; first?: LinuxPsSample; second?: LinuxPsSample; after?: ReturnType<typeof parseLinuxStat>; afterBoot?: string };

export function parseLinuxBoot(text: string): string {
  const value = text.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error("Linux boot identity cannot be established.");
  return value;
}
export function parseLinuxStat(pid: number, text: string): { parent: number; group: number; ticks: string; zombie: boolean; exiting: boolean } {
  const boundary = text.lastIndexOf(") ");
  if (text.length > 8192 || boundary < 0 || !text.startsWith(`${pid} (`)) throw new Error("Linux process stat cannot be interpreted.");
  const fields = text.slice(boundary + 2).trim().split(/\s+/);
  const ticks = fields[19], flags = fields[6];
  if (!/^[A-Za-z]$/.test(fields[0] ?? "") || !/^(0|[1-9][0-9]*)$/.test(fields[1] ?? "")
    || !/^[1-9][0-9]*$/.test(fields[2] ?? "") || ticks === undefined || !/^(0|[1-9][0-9]{0,19})$/.test(ticks)
    || BigInt(ticks) > 18_446_744_073_709_551_615n || flags === undefined || !/^(0|[1-9][0-9]{0,9})$/.test(flags)
    || BigInt(flags) > 4_294_967_295n) throw new Error("Linux process stat has invalid identity fields.");
  const parent = Number(fields[1]), group = Number(fields[2]);
  if (!Number.isSafeInteger(parent) || parent > 2_147_483_647 || !Number.isSafeInteger(group) || group > 2_147_483_647) throw new Error("Linux process stat has invalid process IDs.");
  // PF_EXITING precedes address-space teardown; it permits waiting, not a
  // stopped conclusion: https://github.com/torvalds/linux/blob/4405c18c95d2d0f99f6c581ef0ee8591a1aa6ccd/include/linux/sched.h
  return { parent, group, ticks, zombie: fields[0] === "Z", exiting: (BigInt(flags) & 4n) !== 0n };
}

/** Self-contained so the extraction child uses the same sampler before loading any tool. */
export function createLinuxProcessCapture(
  readText: (path: string, timeoutMs: number) => Promise<string>,
  readPs: (pid: number, timeoutMs: number) => Promise<string>,
  hash: (text: string) => string,
  now: () => number = () => performance.now(),
  boot: typeof parseLinuxBoot = parseLinuxBoot,
  parseStat: typeof parseLinuxStat = parseLinuxStat,
): (pid: number, timeoutMs: number, completedDeadline?: (state: ProcessState) => Error, failure?: (error: unknown, partial: LinuxPartialObservation) => unknown) => Promise<ProcessState> {
  return async (pid, timeoutMs, completedDeadline, failure) => {
    const deadline = now() + timeoutMs;
    const partial: LinuxPartialObservation = {};
    const remaining = () => {
      const left = deadline - now();
      if (left <= 0) throw new Error("Linux process identity observation exceeded its deadline.");
      return Math.max(1, Math.ceil(left));
    };
    const read = async (path: string, last = false) => { const text = await readText(path, remaining()); if (!last) remaining(); return text; };
    const stat = (text: string) => parseStat(pid, text);
    const ps = async () => {
      const output = await readPs(pid, remaining()); remaining();
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+([^\n]+)\s*$/u.exec(output);
      if (match === null || Number(match[1]) !== pid) throw new Error("Linux process command identity cannot be established.");
      return { parent: Number(match[2]), group: Number(match[3]), status: match[4]!, command: match[6]!.trim(), zombie: match[4]!.startsWith("Z") };
    };
    try {
    const beforeBoot = boot(await read("/proc/sys/kernel/random/boot_id")); partial.boot = beforeBoot;
    const before = stat(await read(`/proc/${pid}/stat`)); partial.stat = before;
    const first = await ps(); partial.first = first;
    const second = await ps(); partial.second = second;
    const after = stat(await read(`/proc/${pid}/stat`)); partial.after = after;
    const afterBoot = boot(await read("/proc/sys/kernel/random/boot_id", completedDeadline !== undefined)); partial.afterBoot = afterBoot;
    // Exit can discard the command before Z appears. PF_EXITING permits waiting
    // only; a final zombie proves this instance exited. Neither supplies a
    // running proof, and birth/group fences and descendant checks still apply.
    if (beforeBoot !== afterBoot || before.ticks !== after.ticks || before.group !== after.group
      || first.group !== before.group || second.group !== after.group
      || (!after.zombie && !after.exiting && (before.parent !== after.parent || first.parent !== before.parent || second.parent !== after.parent
        || first.command !== second.command || before.zombie || before.exiting || first.zombie || second.zombie))) {
      throw new Error("Linux process identity changed during observation; no process proof was captured.");
    }
    const state = { proof: { pid, parentPid: after.parent, processGroupId: after.group, startedAt: `linux:v1:${afterBoot}:${after.ticks}`, commandHash: hash(second.command) }, zombie: after.zombie, exiting: after.exiting && !after.zombie, status: after.zombie ? "Z" : second.status };
    if (deadline - now() <= 0 && completedDeadline !== undefined) throw completedDeadline(state);
    remaining();
    return state;
    } catch (error) { throw failure === undefined ? error : failure(error, partial); }
  };
}
