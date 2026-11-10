import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createWindowsCommandJob, WindowsCommandCleanupError, WindowsCommandJobSetupError } from "./windows-command-job.js";
import type { WindowsCommandOwnership } from "./windows-command-job.js";
import { loadWindowsJobKernel } from "./windows-job.js";
import type { WindowsCommandJobKernel } from "./windows-job.js";
import type { SerializedSpawnError, WindowsOwnedCommand, WindowsOwnedCommandDependencies, WindowsOwnedCommandOptions, WindowsTargetReceipt } from "./windows-owned-command.js";

export const windowsNodeGuardianSource = String.raw`
process.on('disconnect',()=>process.exit(1));
if(!process.connected)process.exit(1);
const nonce=process.argv[1],mode=process.argv[2];
const spawn=mode==='node'?require('node:child_process').spawn:require(process.argv[3]);
let admitted=false;
const send=(data,done)=>{if(process.connected)process.send({version:1,nonce,...data},done);else process.exit(1);};
const serialize=error=>{
 if(!(error instanceof Error))throw error;
 const result={name:error.name,message:error.message};
 for(const field of ['code','errno','syscall','path','spawnargs'])if(error[field]!==undefined)result[field]=error[field];
 return result;
};
process.on('message',message=>{
 if(admitted||!message||message.version!==1||message.nonce!==nonce||message.type!=='run'||
    typeof message.file!=='string'||!Array.isArray(message.args)||!message.args.every(v=>typeof v==='string')||
    typeof message.cwd!=='string'||!message.environment||typeof message.environment!=='object') {process.exit(1);return;}
 admitted=true;
 let child,failure=null;
 const result=(code,signal)=>{
  const receipt=child&&child.pid!==undefined?{kind:'exit',code,signal,failure}:{kind:'not-started',error:failure};
  send({type:'result',receipt},error=>process.exit(error?1:0));
 };
 try {child=spawn(message.file,message.args,{cwd:message.cwd,env:message.environment,windowsHide:true,shell:false,stdio:'inherit'});}
 catch(error){failure=serialize(error);result(null,null);return;}
 child.on('error',error=>{failure=serialize(error);});
 child.once('close',result);
});
send({type:'ready'});
`;

const bootstrapKeys = new Set(["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATH", "PATHEXT"]);
const bootstrapEnvironment = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => bootstrapKeys.has(name.toUpperCase())));
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const serializedError = (value: unknown): value is SerializedSpawnError => {
  if (!record(value) || typeof value.name !== "string" || typeof value.message !== "string") return false;
  if (["code", "syscall", "path"].some(key => value[key] !== undefined && typeof value[key] !== "string")) return false;
  if (value.errno !== undefined && typeof value.errno !== "number" && typeof value.errno !== "string") return false;
  return value.spawnargs === undefined || Array.isArray(value.spawnargs) && value.spawnargs.every(item => typeof item === "string");
};
const targetReceipt = (value: unknown): value is WindowsTargetReceipt => record(value) && (
  value.kind === "not-started" ? serializedError(value.error) :
  value.kind === "exit" && (value.code === null || Number.isSafeInteger(value.code) && Number(value.code) >= -0x8000_0000 && Number(value.code) <= 0xffff_ffff) &&
    (value.signal === null || typeof value.signal === "string") && (value.failure === null || serializedError(value.failure))
);
const errorsOf = (error: unknown): unknown[] => error instanceof WindowsCommandCleanupError ? [...error.errors] : [error];
const pause = async (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));
let kernel: Promise<WindowsCommandJobKernel> | undefined;
export type WindowsNodeGuardianDependencies = WindowsOwnedCommandDependencies & {
  createScope?: () => Promise<WindowsCommandOwnership>;
};

/** Node is only the trusted admission and byte-pipe backend, not the target's process identity. */
export const spawnNodeGuardianCommand = (options: WindowsOwnedCommandOptions, dependencies: WindowsNodeGuardianDependencies = {}): {
  command: WindowsOwnedCommand; guardianChild: ChildProcess; physicalClosed: Promise<void>;
} => {
  if (options.normalDisposition === "release" && options.onReleased === undefined) throw new TypeError("Windows command release requires an atomic commit callback.");
  const nonce = randomUUID(), cwd = path.resolve(options.cwd), environment = { ...options.environment };
  const resolverPath = options.resolver === "cross-spawn" ? createRequire(import.meta.url).resolve("cross-spawn") : "node:child_process";
  const child = spawn(process.execPath, ["-e", windowsNodeGuardianSource, "--", nonce, options.resolver, resolverPath], {
    // Git's background work must outlive the CLI's libuv Job after release; detached skips that extra Job assignment.
    // https://github.com/nodejs/node/blob/f7f273a9bb6445f6f7fb6349105e7532972045fb/deps/uv/src/win/process.c#L1052-L1085
    cwd, env: bootstrapEnvironment(), windowsHide: true, detached: options.normalDisposition === "release", stdio: [options.stdin, "pipe", "pipe", "ipc"],
  });
  let result: WindowsTargetReceipt | undefined, scope: WindowsCommandOwnership | undefined;
  let closed = false, exited = false, admitted = false, stopped = false, released = false, readySeen = false, assisted = false;
  let lifecycleError: unknown;
  let starting: Promise<void> | undefined, stopping: Promise<void> | undefined, releasing: Promise<void> | undefined;
  let physicalResolve!: () => void, closeResolve!: () => void, closeReject!: (error: unknown) => void;
  const physicalClosed = new Promise<void>(resolve => { physicalResolve = resolve; });
  const completion = new Promise<void>((resolve, reject) => { closeResolve = resolve; closeReject = reject; });
  void completion.catch(() => {});
  let readyResolve!: () => void, readyReject!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => {});
  const fail = (error: unknown): void => { lifecycleError ??= error; readyReject(error); };
  const finishClose = (): void => {
    if (closed) return;
    closed = true; clearTimeout(timer);
    readyReject(new Error("Windows command guardian closed before command admission."));
    if (admitted && result === undefined && !stopped && lifecycleError === undefined) lifecycleError = new Error("Windows command guardian closed without a target result.");
    physicalResolve();
    if (lifecycleError !== undefined) closeReject(lifecycleError); else closeResolve();
  };
  const inspectClose = (): void => {
    if (exited && !child.connected && [child.stdin, child.stdout, child.stderr].every(stream => stream === null || stream.closed)) finishClose();
  };
  const timer = setTimeout(() => readyReject(new Error("Windows command guardian did not become ready before the command deadline.")), Math.max(0, options.deadline - performance.now()));
  timer.unref();
  child.on("error", fail);
  child.once("exit", () => { exited = true; inspectClose(); });
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.once("close", inspectClose);
  child.once("disconnect", () => { readyReject(new Error("Windows command guardian IPC disconnected before command admission.")); inspectClose(); });
  child.once("close", finishClose);
  child.on("message", message => {
    if (!record(message) || message.version !== 1 || message.nonce !== nonce) { child.emit("error", new Error("Invalid Windows command guardian receipt.")); return; }
    if (message.type === "ready" && !readySeen && !admitted) { readySeen = true; readyResolve(); return; }
    if (message.type !== "result" || !admitted || result !== undefined || !targetReceipt(message.receipt)) {
      child.emit("error", new Error("Invalid Windows command guardian target result.")); return;
    }
    result = message.receipt;
  });
  const checkAdmission = (): void => {
    if (stopped || closed || lifecycleError !== undefined || child.pid === undefined || child.exitCode !== null || child.signalCode !== null || !child.connected || performance.now() >= options.deadline) {
      throw new Error("Windows command admission is no longer available.");
    }
  };
  const createScope = dependencies.createScope ?? (async () => {
    const api = await (dependencies.loadKernel === undefined ? kernel ??= loadWindowsJobKernel() : dependencies.loadKernel());
    checkAdmission();
    return options.normalDisposition === "release"
      ? createWindowsCommandJob(api, { anonymous: true, seal: true, name: null })
      : createWindowsCommandJob(api, { anonymous: false, seal: false, name: `Local\\Daynight-command-${randomUUID()}` });
  });
  const joinPipes = async (failures: unknown[], deadline: number): Promise<void> => {
    while (!closed && performance.now() < deadline) await pause(Math.min(25, options.pipeCloseMs));
    if (!closed) {
      failures.push(new Error("Windows command guardian and inherited streams did not close within the termination grace period."));
      if (options.failureDisposition === "last-close") {
        assisted = true;
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
        if (child.connected) child.disconnect();
        child.unref();
      }
    }
  };
  const stopOwned = async (failures: unknown[], deadline: number): Promise<void> => {
    try { await scope?.stopUntil(deadline); } catch (error) { failures.push(...errorsOf(error)); }
    if (failures.length && options.failureDisposition === "last-close") failures.push(...scope?.requestFailureClose() ?? []);
    await joinPipes(failures, performance.now() + options.pipeCloseMs);
    if (failures.length && options.failureDisposition === "last-close") failures.push(...scope?.closeObservations() ?? []);
  };
  const command: WindowsOwnedCommand = {
    stdin: child.stdin,
    stdout: child.stdout!,
    stderr: child.stderr!,
    get result() { return result; },
    closed: completion,
    start: () => {
      starting ??= (async () => {
        await ready; checkAdmission();
        try { scope = await createScope(); }
        catch (error) { if (error instanceof WindowsCommandJobSetupError) scope = error.scope; throw error; }
        checkAdmission(); scope.assignGate(child.pid!); checkAdmission(); admitted = true;
        await new Promise<void>((resolve, reject) => child.send({ version: 1, nonce, type: "run", file: options.file, args: [...options.args], cwd, environment }, error => {
          if (error !== null) reject(error); else resolve();
        }));
      })();
      return starting;
    },
    stop: () => {
      if (released) return Promise.reject(new Error("Windows command ownership was already released."));
      stopping ??= (async () => {
        stopped = true; clearTimeout(timer); readyReject(new Error("Windows command admission is no longer available."));
        const failures: unknown[] = [];
        try { if (!admitted && !closed && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
        catch (error) { failures.push(error); }
        await starting?.catch(() => {});
        await stopOwned(failures, performance.now() + options.graceMs);
        if (failures.length) throw new WindowsCommandCleanupError(failures);
      })();
      return stopping;
    },
    release: () => {
      if (releasing !== undefined) return releasing;
      if (stopped || options.normalDisposition !== "release" || scope === undefined || !closed || result === undefined || lifecycleError !== undefined || assisted || !child.stdout!.readableEnded || !child.stderr!.readableEnded) {
        const invalid = new Error("Windows command has not reached natural completion before release.");
        if (options.normalDisposition !== "release" || stopped || released) return Promise.reject(invalid);
        releasing = (async () => {
          const failures: unknown[] = [invalid];
          try { await command.stop(); } catch (error) { failures.push(...errorsOf(error)); }
          throw new WindowsCommandCleanupError(failures);
        })();
        return releasing;
      }
      const deadline = performance.now() + options.graceMs;
      let resolveRelease!: () => void, rejectRelease!: (error: unknown) => void;
      releasing = new Promise<void>((resolve, reject) => { resolveRelease = resolve; rejectRelease = reject; });
      try {
        scope.release(() => { released = true; options.onReleased!(); });
        resolveRelease();
      } catch (error) {
        const failures = errorsOf(error);
        if (scope.killPolicy === "OFF") {
          failures.push(...scope.closeObservations());
          rejectRelease(new WindowsCommandCleanupError(failures));
        } else {
          failures.push(...scope.restoreKillOnCloseUntil(deadline));
          stopped = true;
          void stopOwned(failures, deadline).then(() => rejectRelease(new WindowsCommandCleanupError(failures)), rejectRelease);
        }
      }
      return releasing;
    },
  };
  return { command, guardianChild: child, physicalClosed };
};
