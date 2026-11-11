import type { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { spawnNodeGuardianCommand, windowsNodeGuardianSource } from "../../platform/windows-node-guardian.js";
import type { WindowsCommandOwnership } from "../../platform/windows-command-job.js";
import { WindowsCommandJobSetupError } from "../../platform/windows-command-job.js";
import { createWindowsReviewJobScope, WindowsReviewJobSetupError } from "./windows-job-scope.js";
import type { WindowsReviewJobScope } from "./windows-job-scope.js";

export const windowsReviewGuardianSource = windowsNodeGuardianSource;
type PhaseResult = { code: number | null; signal: NodeJS.Signals | null; failure: { message: string; missing: boolean } | null };
export type WindowsReviewPhase = {
  readonly child: ChildProcess;
  readonly closed: Promise<void>;
  readonly result: PhaseResult | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
};
const phases = new WeakMap<ChildProcess, WindowsReviewPhase>();
export const windowsReviewPhase = (child: ChildProcess): WindowsReviewPhase | undefined => phases.get(child);
const ownership = (scope: WindowsReviewJobScope): WindowsCommandOwnership => ({
  killPolicy: "UNKNOWN",
  assignGate: pid => scope.assignGuardian(pid),
  stopUntil: deadline => scope.stop(Math.max(0, deadline - performance.now())),
  release: () => { throw new Error("Review ownership cannot be released without stopping."); },
  restoreKillOnCloseUntil: () => { throw new Error("Review does not disarm kill-on-close."); },
  requestFailureClose: () => { throw new Error("Review retains uncertain ownership."); },
  closeObservations: () => { throw new Error("Review retains uncertain observations."); },
});

export const spawnWindowsReviewPhase = (options: {
  file: string; args: string[]; cwd: string; environment: NodeJS.ProcessEnv; deadline: number; graceMs: number;
}, dependencies: { createScope: () => Promise<WindowsReviewJobScope> } = { createScope: createWindowsReviewJobScope }): WindowsReviewPhase => {
  const backend = spawnNodeGuardianCommand({ ...options, stdin: "pipe", resolver: "cross-spawn", pipeCloseMs: options.graceMs,
    normalDisposition: "stop", stopAdmission: "membership", failureDisposition: "retain" }, {
    createScope: async () => {
      try { return ownership(await dependencies.createScope()); }
      catch (error) {
        if (error instanceof WindowsReviewJobSetupError) throw new WindowsCommandJobSetupError(ownership(error.scope), error.cause);
        throw error;
      }
    },
  });
  const phase: WindowsReviewPhase = {
    child: backend.guardianChild,
    closed: backend.physicalClosed,
    get result() {
      const result = backend.command.result;
      if (result === undefined) return undefined;
      const failure = result.kind === "not-started" ? result.error : result.failure;
      const missing = failure !== null && failure.code === "ENOENT" && failure.syscall === `spawn ${options.file}` && failure.path === options.file &&
        (result.kind === "not-started" || failure.errno === "ENOENT" && Array.isArray(failure.spawnargs) && failure.spawnargs.length === options.args.length && failure.spawnargs.every((value, index) => value === options.args[index]));
      return { code: result.kind === "not-started" ? null : result.code, signal: result.kind === "not-started" ? null : result.signal,
        failure: failure === null ? null : { message: failure.message, missing } };
    },
    start: () => backend.command.start(),
    stop: () => backend.command.stop(),
  };
  phases.set(phase.child, phase);
  return phase;
};
