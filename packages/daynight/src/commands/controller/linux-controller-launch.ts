import { readFile } from "node:fs/promises";
import path from "node:path";

export type LinuxControllerLaunch = { readonly kind: "linux-controller-launch"; readonly pid: number; readonly launchId: string };
export type LinuxControllerLaunchState = "running" | "stopped" | "mismatch";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validPid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
const validId = (value: unknown): value is string => typeof value === "string" && uuid.test(value);

export function isLinuxControllerLaunch(value: unknown): value is LinuxControllerLaunch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3 && record.kind === "linux-controller-launch" && validPid(record.pid) && validId(record.launchId);
}

export function parseLinuxControllerLaunch(value: unknown): LinuxControllerLaunch {
  if (!isLinuxControllerLaunch(value)) throw new Error("Invalid Linux Controller launch identity.");
  return { kind: value.kind, pid: value.pid, launchId: value.launchId };
}

/** Parse the kernel's NUL-delimited argv; never include command contents in errors. */
export function parseLinuxControllerLaunchArgv(cmdline: Uint8Array): string | null {
  if (cmdline.length === 0 || cmdline.length > 131_072 || cmdline[cmdline.length - 1] !== 0) return null;
  let args: string[];
  try { args = new TextDecoder("utf-8", { fatal: true }).decode(cmdline).slice(0, -1).split("\0"); }
  catch { return null; }
  if (args.length !== 7 || args.some(arg => arg.length === 0) || args.filter(arg => arg === "--launch-id").length !== 1
    || path.posix.basename(args[1]!) !== "controller-bootstrap.js" || path.posix.basename(args[2]!) !== "main.js"
    || !["codex", "claude", "copilot"].includes(args[3]!) || args[4] !== "--launch-id" || !validId(args[5])) return null;
  return args[5];
}

export interface LinuxControllerLaunchObserverDependencies {
  read(path: string, signal: AbortSignal): Promise<Uint8Array>;
  /** Throws ESRCH only when the PID is independently confirmed absent. */
  probe(pid: number): void;
}

/** The observer establishes one PID's state; callers separately verify descendants and the process group. */
export function createLinuxControllerLaunchObserver(dependencies: LinuxControllerLaunchObserverDependencies) {
  const inspect = async (value: LinuxControllerLaunch, timeoutMs = 5000): Promise<LinuxControllerLaunchState> => {
    const launch = parseLinuxControllerLaunch(value);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error("Invalid Linux Controller observation timeout.");
    const deadline = performance.now() + timeoutMs;
    const remaining = () => {
      const left = deadline - performance.now();
      if (left <= 0) throw new Error("Linux Controller observation exceeded its deadline.");
      return left;
    };
    const read = async (name: string): Promise<Uint8Array> => {
      const controller = new AbortController();
      const budget = remaining();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const bytes = await Promise.race([
          dependencies.read(`/proc/${launch.pid}/${name}`, controller.signal),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Linux Controller observation exceeded its deadline.")); }, Math.ceil(budget)); }),
        ]);
        remaining();
        return bytes;
      } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
    };
    const stat = async () => {
      const bytes = await read("stat");
      if (bytes.length > 8192) throw new Error("Linux process stat cannot be interpreted.");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const boundary = text.lastIndexOf(") ");
      if (boundary < 0 || !text.startsWith(`${launch.pid} (`)) throw new Error("Linux process stat cannot be interpreted.");
      const fields = text.slice(boundary + 2).trim().split(/\s+/);
      const state = fields[0], group = fields[2], flags = fields[6];
      if (!/^[A-Za-z]$/.test(state ?? "") || !/^[1-9][0-9]*$/.test(group ?? "")
        || !validPid(Number(group)) || !/^(0|[1-9][0-9]{0,9})$/.test(flags ?? "") || BigInt(flags!) > 4_294_967_295n)
        throw new Error("Linux process stat has invalid state or group.");
      // PF_EXITING permits waiting only, not a stopped conclusion.
      return { group: Number(group), zombie: state === "Z", exiting: (BigInt(flags!) & 4n) !== 0n };
    };
    try {
      for (;;) {
        const before = await stat();
        if (before.zombie) return "stopped";
        if (before.exiting) {
          await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(25, remaining()))));
          remaining();
          continue;
        }
        const argv = await read("cmdline");
        const secondArgv = await read("cmdline");
        const after = await stat();
        if (before.group !== after.group) throw new Error("Linux Controller process group changed during observation.");
        if (after.zombie) return "stopped";
        if (after.exiting) {
          await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(25, remaining()))));
          remaining();
          continue;
        }
        return after.group === launch.pid && parseLinuxControllerLaunchArgv(argv) === launch.launchId
          && Buffer.from(argv).equals(secondArgv) ? "running" : "mismatch";
      }
    } catch (cause) {
      // A procfs error alone does not establish that the PID is gone.
      try { dependencies.probe(launch.pid); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return "stopped"; }
      throw new Error(`Linux Controller identity could not be established for PID ${launch.pid}, launchId ${launch.launchId}; observation remains unknown.`, { cause });
    }
  };
  const capture = async (pid: number, launchId: string, timeoutMs = 5000): Promise<LinuxControllerLaunch> => {
    const launch = parseLinuxControllerLaunch({ kind: "linux-controller-launch", pid, launchId });
    if (await inspect(launch, timeoutMs) !== "running") throw new Error(`Linux Controller launch identity or process group mismatch for PID ${pid}, launchId ${launchId}.`);
    return launch;
  };
  return { inspect, capture };
}

const observer = createLinuxControllerLaunchObserver({
  read: (file, signal) => readFile(file, { signal }),
  probe: pid => { process.kill(pid, 0); },
});

export function captureLinuxControllerLaunch(pid: number, launchId: string, timeoutMs?: number): Promise<LinuxControllerLaunch> {
  if (process.platform !== "linux") throw new Error("Linux Controller launch observation requires Linux.");
  return observer.capture(pid, launchId, timeoutMs);
}

export function inspectLinuxControllerLaunch(launch: LinuxControllerLaunch, timeoutMs?: number): Promise<LinuxControllerLaunchState> {
  if (process.platform !== "linux") throw new Error("Linux Controller launch observation requires Linux.");
  return observer.inspect(launch, timeoutMs);
}
