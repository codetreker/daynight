import { toolCommand, verifyToolLaunch, type ResolvedToolLaunch } from "../../../platform/tool-executables.js";
import { spawn } from "node:child_process";
import type { Operation } from "../../../api/operation.js";
import { NativeRpc } from "../../controller/providers/native-rpc.js";
import { codexConfigurationArguments } from "./arguments.js";
import { HerdrCommandCleanupError, registerHerdrCommandCleanupConfirmation, terminateOwnedHerdrProcess } from "./command.js";

/** Read native config layers without creating or resuming an Agent session. */
export const withCodexConfigurationRpc = async (options: {
  args: readonly string[]; cwd: string; environment: NodeJS.ProcessEnv; executable?: string; detached?: boolean; toolLaunch?: ResolvedToolLaunch;
}, operation: Operation, read: (rpc: NativeRpc) => Promise<unknown>): Promise<unknown> => {
  operation.check();
  if (options.toolLaunch) {
    if (options.toolLaunch.tool !== "codex" || options.executable) throw new Error("Conflicting Codex configuration tool launch options.");
    await verifyToolLaunch(options.toolLaunch, operation);
  }
  const executable = options.executable ?? "codex";
  const script = /\.[cm]?js$/i.test(executable);
  const configuration = codexConfigurationArguments(options.args);
  const timeout = Math.max(1, Math.min(10_000, operation.remainingMs(), operation.limits.requestMs));
  const command = options.toolLaunch ? toolCommand(options.toolLaunch, [...configuration.arguments, "app-server", "--stdio"])
    : { file: script ? process.execPath : executable, args: [...(script ? [executable] : []), ...configuration.arguments, "app-server", "--stdio"] };
  const child = spawn(command.file, command.args, { cwd: options.cwd, env: options.environment, stdio: ["pipe", "pipe", "pipe"], detached: options.detached ?? true, windowsHide: true });
  let closed = false, bytes = 0;
  const exited = new Promise<void>(resolve => child.once("close", () => { closed = true; resolve(); }));
  const rpc = new NativeRpc(child, () => {}, timeout);
  let rejectFailure!: (error: unknown) => void;
  const failed = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  const abort = () => rejectFailure(operation.signal.reason);
  const timer = setTimeout(() => rejectFailure(new Error("Codex configuration inspection timed out.")), timeout);
  const accept = (data: Buffer) => {
    try {
      bytes += data.length;
      if (bytes > 1024 * 1024) throw new Error("Codex configuration inspection exceeded its output limit.");
      operation.consume(data.length);
    } catch (error) { rejectFailure(error); }
  };
  child.stdout.on("data", accept); child.stderr.on("data", accept);
  operation.signal.addEventListener("abort", abort, { once: true });
  if (operation.signal.aborted) abort();
  let failure: unknown;
  try {
    return await Promise.race([failed, (async () => {
      await rpc.request("initialize", { clientInfo: { name: "daynight", title: "Daynight configuration inspection", version: "0.31.0" }, capabilities: { experimentalApi: true } });
      rpc.notify("initialized");
      const config = await read(rpc);
      operation.check();
      return config;
    })()]);
  } catch (error) {
    failure = error;
    if (configuration.profile) throw new Error("Codex could not inspect the selected profile for Agent CLI aliases; use a CLI with profile-aware config/read or supported explicit configuration overrides.", { cause: error });
    throw error;
  }
  finally {
    clearTimeout(timer); operation.signal.removeEventListener("abort", abort);
    child.stdin.end();
    let cleanupTimer: NodeJS.Timeout | undefined;
    const wait = (ms: number) => Promise.race([exited, new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(cleanupTimer));
    try {
      if (failure === undefined) await wait(250);
      if (!closed) { if (options.detached === false) child.kill("SIGKILL"); else terminateOwnedHerdrProcess(child); }
      await wait(2_000);
      if (!closed) throw new Error("The Codex configuration process did not close after termination.");
    } catch (error) {
      const cleanup = new HerdrCommandCleanupError([error], failure);
      registerHerdrCommandCleanupConfirmation(cleanup, () => closed);
      throw cleanup;
    }
    finally { rpc.dispose(); }
  }
};

export const readCodexConfiguration = (options: Parameters<typeof withCodexConfigurationRpc>[0], operation: Operation): Promise<unknown> =>
  withCodexConfigurationRpc(options, operation, rpc => rpc.request("config/read", { cwd: options.cwd, includeLayers: false }));
