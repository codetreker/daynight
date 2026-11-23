import { vi } from "vitest";
import type { stopControllerProcesses } from "../../../../src/commands/controller/process-proof.js";

type ExecObserver = (target: (...args: any[]) => unknown, receiver: unknown, args: any[]) => unknown;
export type ExecHook = { observe: ExecObserver | undefined };

// The observer wraps the original callback and never substitutes an inventory.
export const withProbeGrace = async (
  stop: typeof stopControllerProcesses,
  args: Parameters<typeof stopControllerProcesses>,
  hook: ExecHook,
  recordFailure: (failure: Error) => void,
): Promise<void> => {
  const [proof] = args;
  const now = Date.now, kill = process.kill, schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout;
  let base: number | undefined, logical = 0, offset: number | undefined, killed = false, eligible = false, failed = false;
  let inventories = 0, killAt: number | undefined;
  const polls: number[] = [], violations: string[] = [];
  const current = () => base === undefined ? now() : offset === undefined ? logical : now() + offset;
  const fallback = (reason: string) => {
    violations.push(reason); failed = true;
    if (base !== undefined && offset === undefined) offset = 0;
    eligible = false;
  };
  const watchdog = schedule(() => fallback("Grace observation watchdog expired."), Math.max(1, args[2] - now()));
  const dateSpy = vi.spyOn(Date, "now").mockImplementation(current);
  const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    const result = kill(pid, signal);
    if (pid === -proof.pid && signal === "SIGTERM") {
      if (base !== undefined) fallback("Repeated SIGTERM.");
      else { base = now(); logical = base; if (failed) offset = 0; }
    } else if (pid === -proof.pid && signal === "SIGKILL") {
      killAt = current(); killed = true; cancel(watchdog);
      if (base === undefined) fallback("SIGKILL preceded SIGTERM.");
      else if (offset === undefined) offset = logical - now();
      eligible = false;
    }
    return result;
  });
  const controlledSchedule = ((callback: (...args: any[]) => void, milliseconds?: number, ...callbackArgs: any[]) => {
    if (!eligible || base === undefined || offset !== undefined || killed) return schedule(callback, milliseconds, ...callbackArgs);
    eligible = false;
    if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds <= 0) {
      fallback("Invalid grace poll duration.");
      return schedule(callback, milliseconds, ...callbackArgs);
    }
    polls.push(milliseconds);
    return schedule(function (this: unknown) {
      if (offset === undefined && base !== undefined) logical = polls.length === 1 ? base + 1_999 : logical + milliseconds;
      Reflect.apply(callback, this, callbackArgs);
    }, 0);
  }) as typeof globalThis.setTimeout;
  globalThis.setTimeout = controlledSchedule;
  const observer: ExecObserver = (target, receiver, callArgs) => {
    const [file, argv, , callback] = callArgs;
    if (file !== "ps" || !Array.isArray(argv) || argv.join("\0") !== ["-A", "-o", "pid=", "-o", "pgid=", "-o", "stat="].join("\0") || typeof callback !== "function") {
      return Reflect.apply(target, receiver, callArgs);
    }
    const wrapped = [...callArgs];
    wrapped[3] = function (this: unknown, error: unknown, stdout: unknown, stderr: unknown) {
      Reflect.apply(callback, this, [error, stdout, stderr]);
      if (base === undefined || killed || offset !== undefined) return;
      if (error !== null || typeof stdout !== "string") { fallback("Process inventory failed during grace."); return; }
      const alive = stdout.split("\n").some(row => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(row);
        return match !== null && Number(match[2]) === proof.pid && !match[3]!.startsWith("Z");
      });
      if (alive) { inventories++; eligible = true; }
      else fallback("No live process group in post-TERM inventory.");
    };
    return Reflect.apply(target, receiver, wrapped);
  };
  hook.observe = observer;
  let failure: unknown;
  try { await stop(...args); } catch (error) { failure = error; }
  finally {
    cancel(watchdog);
    if (hook.observe === observer) hook.observe = undefined;
    else violations.push("Process inventory observer ownership changed.");
    if (globalThis.setTimeout === controlledSchedule) globalThis.setTimeout = schedule;
    else violations.push("Grace timer ownership changed.");
    killSpy.mockRestore(); dateSpy.mockRestore();
  }
  if (base === undefined || !killed || killAt === undefined) violations.push("Expected real TERM and KILL signals.");
  else if (killAt - base !== 2_000) violations.push(`Expected 2000 ms TERM-to-KILL, got ${killAt - base}.`);
  if (inventories < 2) violations.push(`Expected two live post-TERM inventories, got ${inventories}.`);
  if (polls.length !== 2 || polls[0] !== 25 || polls[1] !== 1) violations.push(`Expected grace polls [25,1], got [${polls.join(",")}].`);
  const traceFailure = violations.length === 0 ? undefined : new Error(violations.join(" "));
  if (traceFailure !== undefined) recordFailure(traceFailure);
  if (failure !== undefined) throw failure;
};
