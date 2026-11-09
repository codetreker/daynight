import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { createWindowsReviewJobScope, WindowsReviewJobSetupError } from "./windows-job-scope.js";
import type { WindowsReviewJobScope } from "./windows-job-scope.js";

export const windowsReviewGuardianSource = String.raw`
const spawn = require(process.argv[1]);
let admitted = false;
const send = (message, done) => { if (process.connected) process.send(message, done); else process.exit(1); };
process.on('disconnect', () => process.exit(1));
process.on('message', message => {
  if (admitted || !message || message.type !== 'run') { process.exit(1); return; }
  admitted = true;
  let failure = null;
  const failed = (error, child) => {
    const missing = error.code === 'ENOENT' && error.syscall === 'spawn ' + message.file && error.path === message.file &&
      (!child || child.pid === undefined || error.errno === 'ENOENT' && Array.isArray(error.spawnargs) &&
        error.spawnargs.length === message.args.length && error.spawnargs.every((value, index) => value === message.args[index]));
    failure = { message:String(error.message), missing };
  };
  const result = (code, signal) => send({type:'result', code, signal, failure}, () => process.exit(0));
  let child;
  try { child = spawn(message.file, message.args, {cwd:message.cwd, env:message.environment, windowsHide:true, shell:false, stdio:'inherit'}); }
  catch (error) { failed(error); result(null, null); return; }
  child.on('error', error => failed(error, child));
  child.once('close', result);
});
send({type:'ready'});
`;

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

/** A trusted Node gate is assigned before any target code, including Node preloads, may run. */
export const spawnWindowsReviewPhase = (options: {
  file: string; args: string[]; cwd: string; environment: NodeJS.ProcessEnv; deadline: number; graceMs: number;
}, dependencies: { createScope: () => Promise<WindowsReviewJobScope> } = { createScope: createWindowsReviewJobScope }): WindowsReviewPhase => {
  const environment = { ...options.environment };
  for (const name of Object.keys(environment)) if (name.toUpperCase() === "NODE_OPTIONS") delete environment[name];
  const child = spawn(process.execPath, ["-e", windowsReviewGuardianSource, createRequire(import.meta.url).resolve("cross-spawn"), ...options.args],
    { cwd: options.cwd, env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe", "ipc"] });
  let result: PhaseResult | undefined, scope: WindowsReviewJobScope | undefined;
  let closed = false, exited = false, admitted = false, stopped = false;
  let closeResolve!: () => void;
  const completion = new Promise<void>(resolve => { closeResolve = resolve; });
  let starting: Promise<void> | undefined, stopping: Promise<void> | undefined;
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => {});
  const timer = setTimeout(() => readyReject(new Error("Windows review guardian did not become ready before the phase deadline.")), Math.max(0, options.deadline - performance.now()));
  child.on("error", error => { readyReject(error); });
  const finishClose = (): void => {
    if (closed) return;
    closed = true; clearTimeout(timer);
    readyReject(new Error("Windows review guardian closed before command admission."));
    closeResolve();
  };
  // Node may omit ChildProcess.close after an explicit IPC disconnect. The
  // original process exit and each inherited pipe still need independent joins.
  const inspectClose = (): void => {
    if (exited && !child.connected && [child.stdin, child.stdout, child.stderr].every(stream => stream?.closed)) finishClose();
  };
  child.once("exit", () => { exited = true; inspectClose(); });
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream!.once("close", inspectClose);
  child.once("disconnect", () => { readyReject(new Error("Windows review guardian IPC disconnected before command admission.")); inspectClose(); });
  child.once("close", finishClose);
  child.on("message", message => {
    if (typeof message !== "object" || message === null || !("type" in message)) { child.emit("error", new Error("Invalid Windows review guardian receipt.")); return; }
    if (message.type === "ready" && !admitted) { clearTimeout(timer); readyResolve(); return; }
    const receipt = message as Partial<PhaseResult>;
    if (message.type !== "result" || !admitted || result !== undefined ||
        !(receipt.code === null || Number.isSafeInteger(receipt.code) && receipt.code! >= -0x8000_0000 && receipt.code! <= 0xffff_ffff) ||
        !(receipt.signal === null || typeof receipt.signal === "string") ||
        !(receipt.failure === null || typeof receipt.failure === "object" && receipt.failure !== undefined &&
          typeof receipt.failure.message === "string" && typeof receipt.failure.missing === "boolean")) {
      child.emit("error", new Error("Invalid Windows review guardian result.")); return;
    }
    result = { code: receipt.code!, signal: receipt.signal!, failure: receipt.failure! };
  });
  const check = (): void => {
    if (stopped || closed || child.pid === undefined || child.exitCode !== null || child.signalCode !== null || !child.connected || performance.now() >= options.deadline) {
      throw new Error("Windows review command admission is no longer available.");
    }
  };
  const phase: WindowsReviewPhase = {
    child,
    closed: completion,
    get result() { return result; },
    start: () => {
      starting ??= (async () => {
        await ready; check();
        try { scope = await dependencies.createScope(); }
        catch (error) { if (error instanceof WindowsReviewJobSetupError) scope = error.scope; throw error; }
        check(); scope.assignGuardian(child.pid!); check();
        admitted = true;
        await new Promise<void>((resolve, reject) => child.send({ type: "run", file: options.file, args: options.args, cwd: options.cwd, environment: options.environment }, error => {
          if (error !== null) reject(error); else resolve();
        }));
      })();
      return starting;
    },
    stop: () => {
      stopping ??= (async () => {
        stopped = true;
        clearTimeout(timer); readyReject(new Error("Windows review command admission was stopped."));
        // Before run admission the original guardian cannot have target children.
        if (!admitted && !closed && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await starting?.catch(() => {});
        const failures: unknown[] = [];
        try { await scope?.stop(options.graceMs); } catch (error) { failures.push(error); }
        const deadline = performance.now() + options.graceMs;
        while (!closed && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(25, options.graceMs)));
        if (!closed) failures.push(new Error("Windows review guardian and inherited streams did not close within the termination grace period."));
        if (failures.length) throw new AggregateError(failures, "Windows review phase cleanup remains unconfirmed.");
      })();
      return stopping;
    },
  };
  phases.set(child, phase);
  return phase;
};
