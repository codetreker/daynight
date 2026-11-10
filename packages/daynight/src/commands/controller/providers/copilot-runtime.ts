import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import type { ProviderOptions } from "./types.js";
import { NativeRpcTimeoutError } from "./native-rpc.js";
import type { CopilotAuthorityArtifacts } from "./copilot-read-authority-artifacts.js";
import { CopilotReadAuthority } from "./copilot-read-authority.js";

export const copilotDeadline = <T>(promise: Promise<T>, label: string, ms = 30_000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new NativeRpcTimeoutError(label)), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

// The npm loader uses spawnSync. Spawn its platform executable directly so the
// child proof and shutdown signal identify the runtime, rather than a wrapper.
export const copilotExecutable = (): string => {
  const require = createRequire(createRequire(import.meta.url).resolve("@github/copilot/package.json"));
  const platforms = process.platform === "linux" && (require("detect-libc") as { isNonGlibcLinuxSync(): boolean }).isNonGlibcLinuxSync() ? ["linuxmusl", "linux"] : [process.platform];
  for (const platform of platforms) try { return require.resolve(`@github/copilot-${platform}-${process.arch}`); } catch { /* Try the CLI's supported platform fallback. */ }
  throw new Error("The installed Copilot CLI has no native package for this platform.");
};

export const startCopilotRuntime = (options: ProviderOptions, lost: (error: Error) => void, artifacts?: CopilotAuthorityArtifacts) => {
  const token = randomBytes(32).toString("hex"), executable = options.executable ?? copilotExecutable();
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), COPILOT_CONNECTION_TOKEN: token }; delete env.NODE_DEBUG;
  const execution = randomUUID();
  if (artifacts) {
    env.DAYNIGHT_COPILOT_AUTHORITY = execution;
    env.NODE_COMPILE_CACHE = join(dirname(artifacts.entry), ".node-compile-cache");
  }
  const js = /\.[cm]?js$/i.test(executable);
  const entry = artifacts ? ["--import", new URL("./copilot-read-authority-preload.js", import.meta.url).href, artifacts.entry] : js ? [executable] : [];
  const child = spawn(artifacts || js ? process.execPath : executable, [...entry, "--headless", "--no-auto-update", ...(options.unattended && !options.resumeNativeSessionId ? ["--allow-all", "--no-ask-user", "--no-sandbox"] : [])], { cwd: options.cwd, env, stdio: artifacts ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"], detached: false, windowsHide: true });
  let closing = false, client: CopilotClient | undefined, closePromise: Promise<void> | undefined;
  let stopped = false;
  const exited = new Promise<void>(resolve => child.once("exit", () => { stopped = true; resolve(); }));
  const failed = new Promise<never>((_, reject) => {
    child.once("error", error => { if (!closing) { reject(error); lost(new Error("Native Copilot runtime failed; operation results are unknown.")); } });
    child.once("exit", () => { if (!closing) { const error = new Error("Native Copilot runtime stopped; operation results are unknown."); reject(error); lost(error); } });
  });
  void failed.catch(() => {});
  const spawned = new Promise<void>((resolve, reject) => child.once("spawn", () => {
    try { options.onSpawn(child as ChildProcess); resolve(); } catch (error) { reject(error); }
  }));
  const listening = new Promise<number>((resolve, reject) => {
    let buffer = "", found = false;
    child.stdout!.on("data", chunk => {
      if (found) return;
      buffer += String(chunk);
      if (Buffer.byteLength(buffer) > 65_536) { found = true; reject(new Error("Native Copilot startup output exceeds its limit.")); return; }
      const complete = buffer.slice(0, buffer.lastIndexOf("\n") + 1);
      const port = /listening on port (\d+)[ \t]*\r?\n/i.exec(complete)?.[1];
      if (port) { found = true; const value = Number(port); if (value >= 1 && value <= 65535) resolve(value); else reject(new Error("Invalid native Copilot listener port.")); }
    });
  });
  child.stderr!.on("data", chunk => options.onDiagnostic?.(String(chunk).slice(0, 65_536)));
  const ready = copilotDeadline(Promise.race([Promise.all([spawned, listening]), failed]), "Copilot runtime startup", 15_000).then(async ([, port]) => {
    if (closing) throw new Error("Copilot runtime closed during startup.");
    client = new CopilotClient({ connection: RuntimeConnection.forUri(`127.0.0.1:${port}`, { connectionToken: token }) });
    await copilotDeadline(Promise.race([client.start(), failed]), "Copilot SDK connection", 15_000);
    if (closing) throw new Error("Copilot runtime closed during connection.");
    return client;
  });
  const close = (force = false): Promise<void> => closePromise ??= (async () => {
    closing = true;
    authority?.invalidate();
    const errors: unknown[] = [];
    if (client) {
      if (force) {
        // Failed startup cannot establish a writable transport. Dispose it without RPCs.
        try { await copilotDeadline(client.forceStop(), "Copilot SDK transport shutdown", 1000); } catch (error) { errors.push(error); }
      } else {
        // forUri treats the runtime as external, so the owner sends this public
        // shutdown request before disposing the SDK connection.
        try { await copilotDeadline(client.rpc.runtime.shutdown(), "Copilot runtime shutdown", 1500); } catch (error) { errors.push(error); }
        try { const result = await copilotDeadline(client.stop(), "Copilot SDK shutdown", 3000); if (result.length) errors.push(...result); }
        catch (error) { errors.push(error); }
        if (errors.length) try { await copilotDeadline(client.forceStop(), "Copilot SDK transport shutdown", 1000); } catch (error) { errors.push(error); }
      }
    }
    if (!stopped && child.pid && child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGTERM"); await copilotDeadline(exited, "Copilot process termination", 2000); }
      catch {
        child.kill("SIGKILL"); await copilotDeadline(exited, "Copilot process kill", 2000);
      }
    }
    await artifacts?.cleanup();
    if (errors.length) options.onDiagnostic?.("Copilot SDK cleanup failed; the owned runtime was terminated.");
  })();
  const authority = artifacts ? new CopilotReadAuthority({ child, execution, cwd: options.cwd, publish: policy => options.onNativeReadPolicy?.(policy) }) : undefined;
  return { child, ready, close, authority };
};
