import { createOperation } from "../../api/operation.js";
import { createHerdrInstance } from "./herdr/instance.js";
import { spawnHerdrProcess } from "./herdr/command.js";
import { resolveWorkerPaths } from "./paths.js";

export const attachWorker = async (options: { homeDirectory: string }): Promise<void> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("daynight worker attach requires an interactive terminal.");
  const instance = createHerdrInstance({ paths: resolveWorkerPaths(options.homeDirectory) });
  const operation = createOperation({ limits: { totalMs: 30_000 } });
  try { await instance.connect(operation); }
  finally { operation.dispose(); }
  const attachment = instance.attachment;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !attachment.unsetEnvironment.some((key) => key.toUpperCase() === name.toUpperCase())));
  Object.assign(environment, attachment.environment);
  // The explicit client connects only to an existing daemon, including if it exits after the probe.
  // https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/main.rs#L573-L577
  const child = spawnHerdrProcess(attachment.executable, [...attachment.arguments, "client"], { env: environment, stdio: "inherit", detached: false, windowsHide: false });
  const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  let failure: Error | undefined;
  const listeners = signals.map((signal) => {
    const forward = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill(signal === "SIGBREAK" ? "SIGINT" : signal); }
      catch (cause) { failure = new Error(`Cannot forward ${signal} to the Herdr attach client.`, { cause }); }
    };
    process.on(signal, forward);
    return { signal, forward };
  });
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("error", (cause) => { failure = new Error("Cannot start the Herdr attach client.", { cause }); });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (failure !== undefined) throw failure;
    if (result.code !== 0 || result.signal !== null) throw new Error(`The Herdr attach client failed: exit=${String(result.code)}, signal=${String(result.signal)}.`);
  } finally {
    for (const { signal, forward } of listeners) process.off(signal, forward);
  }
};
