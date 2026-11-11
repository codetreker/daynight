import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { createOperation } from "../../../api/operation.js";
import { copilotExecutable, toolCommand, verifyToolLaunch, type ResolvedToolLaunch } from "../../../platform/tool-executables.js";
import { NativeRpcTimeoutError } from "./native-rpc.js";
import type { CopilotAuthorityArtifacts } from "./copilot-read-authority-artifacts.js";
import { CopilotReadAuthority } from "./copilot-read-authority.js";
import type { NativeReadPolicy } from "./types.js";

export const copilotDeadline = <T>(promise: Promise<T>, label: string, ms = 30_000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new NativeRpcTimeoutError(label)), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
export type CopilotProcessOptions = {
  cwd: string; env?: NodeJS.ProcessEnv; executable?: string; toolLaunch?: ResolvedToolLaunch; toolRuntimeRoot?: string;
  unattended?: boolean; resumeNativeSessionId?: string | null;
  onSpawn(child: ChildProcess): void;
  onDiagnostic?(line: string): void;
  onNativeReadPolicy?(policy: NativeReadPolicy | null): void;
};

/** Own the selected headless process independently of its SDK transport. */
export const startCopilotProcess = (options: CopilotProcessOptions, lost: (error: Error) => void, artifacts?: CopilotAuthorityArtifacts) => {
  const token = randomBytes(32).toString("hex"), execution = randomUUID();
  const startup = createOperation({ limits: { totalMs: 15_000 } });
  let child: ChildProcess | undefined, authority: CopilotReadAuthority | undefined;
  let closing = false, stopped = false, termRequested = false, killRequested = false, closePromise: Promise<void> | undefined;
  let exited: Promise<void> = Promise.resolve(), gracefulExit: Promise<void> | undefined;
  let rejectFailure!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => { rejectFailure = reject; }); void failed.catch(() => {});
  const ready = (async () => {
    if (options.toolLaunch) {
      if (options.toolLaunch.tool !== "copilot" || artifacts || options.executable) throw new Error("Conflicting Copilot tool launch options.");
      await verifyToolLaunch(options.toolLaunch, startup, options.toolRuntimeRoot ? { trustedRuntimeRoot: options.toolRuntimeRoot } : {});
    }
    startup.check();
    if (closing) throw new Error("Copilot runtime closed before startup.");
    const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), COPILOT_CONNECTION_TOKEN: token }; delete env.NODE_DEBUG;
    const profile = options.toolLaunch?.runtimeProfile;
    if (profile || artifacts) env.DAYNIGHT_COPILOT_AUTHORITY = execution;
    if (profile) { delete env.NODE_COMPILE_CACHE; env.NODE_DISABLE_COMPILE_CACHE = "1"; }
    else if (artifacts) env.NODE_COMPILE_CACHE = join(dirname(artifacts.entry), ".node-compile-cache");
    const executable = options.toolLaunch?.command.file ?? options.executable ?? copilotExecutable(), js = /\.[cm]?js$/i.test(executable);
    const entry = artifacts ? ["--import", new URL("./copilot-read-authority-preload.js", import.meta.url).href, artifacts.entry] : js ? [executable] : [];
    const logical = ["--headless", "--no-auto-update", ...(options.unattended && !options.resumeNativeSessionId ? ["--allow-all", "--no-ask-user", "--no-sandbox"] : [])];
    const command = options.toolLaunch ? toolCommand(options.toolLaunch, logical) : { file: artifacts || js ? process.execPath : executable, args: [...entry, ...logical] };
    child = spawn(command.file, command.args, { cwd: options.cwd, env, stdio: profile || artifacts ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"], detached: false, windowsHide: true });
    const owned = child;
    exited = new Promise<void>(resolve => {
      const finish = () => { stopped = true; resolve(); };
      owned.once("exit", finish); owned.once("close", finish);
    });
    owned.once("error", error => { rejectFailure(error); if (!closing) lost(new Error("Native Copilot runtime failed; operation results are unknown.")); });
    owned.once("exit", () => { if (!closing) { const error = new Error("Native Copilot runtime stopped; operation results are unknown."); rejectFailure(error); lost(error); } });
    const spawned = new Promise<void>((resolve, reject) => owned.once("spawn", () => { try { options.onSpawn(owned); resolve(); } catch (error) { reject(error); } }));
    const listening = new Promise<number>((resolve, reject) => {
      let buffer = "", found = false;
      owned.stdout!.on("data", chunk => {
        if (found) return;
        buffer += String(chunk);
        if (Buffer.byteLength(buffer) > 65_536) { found = true; reject(new Error("Native Copilot startup output exceeds its limit.")); return; }
        const complete = buffer.slice(0, buffer.lastIndexOf("\n") + 1), port = /listening on port (\d+)[ \t]*\r?\n/i.exec(complete)?.[1];
        if (port) { found = true; const value = Number(port); if (value >= 1 && value <= 65535) resolve(value); else reject(new Error("Invalid native Copilot listener port.")); }
      });
    });
    owned.stderr!.on("data", chunk => options.onDiagnostic?.(String(chunk).slice(0, 65_536)));
    authority = profile || artifacts ? new CopilotReadAuthority({ child: owned, execution, cwd: options.cwd, publish: policy => options.onNativeReadPolicy?.(policy) }) : undefined;
    const [, port] = await copilotDeadline(Promise.race([Promise.all([spawned, listening]), failed]), "Copilot runtime startup", Math.max(1, startup.remainingMs()));
    if (closing) throw new Error("Copilot runtime closed during startup.");
    return { child: owned, port, token, execution };
  })().finally(() => startup.dispose());
  void ready.catch(() => {});
  const close = (gracefulAcknowledged = false): Promise<void> => {
    if (closePromise) return closePromise;
    const attempt = (async () => {
      closing = true; authority?.invalidate(); startup.dispose();
      rejectFailure(new Error("Copilot runtime closed during startup."));
      // Joining readiness prevents a late verification from spawning after close.
      await ready.catch(() => {});
      if (child && !stopped && gracefulAcknowledged) {
        gracefulExit ??= copilotDeadline(exited, "Copilot graceful process exit", 1500).catch(() => {});
        await gracefulExit;
      }
      if (child && !stopped && !termRequested && child.pid) {
        termRequested = true;
        try { child.kill("SIGTERM"); await copilotDeadline(exited, "Copilot process termination", 2000); }
        catch { /* Escalate once; retries only observe this original process. */ }
      }
      if (child && !stopped) {
        if (!killRequested && child.pid) { killRequested = true; child.kill("SIGKILL"); }
        await copilotDeadline(exited, "Copilot process kill", 2000);
      }
      if (!child || stopped) await artifacts?.cleanup();
    })();
    closePromise = attempt;
    const settled = () => { if (closePromise === attempt) closePromise = undefined; };
    void attempt.then(settled, settled);
    return attempt;
  };
  return { get child() { return child; }, get authority() { return authority; }, get stopped() { return stopped; }, ready, failed, close };
};
