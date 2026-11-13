import path from "node:path";
import { statSync } from "node:fs";
import { createOperation } from "../../api/operation.js";
import { readHerdrLifecycleRecords } from "./herdr/lifecycle-store.js";
import { createMacProcessControl } from "./herdr/native-macos.js";
import type { HerdrLocalRun } from "./herdr/lifecycle-types.js";
import { createHerdrInstance } from "./herdr/instance.js";
import { spawnHerdrProcess } from "./herdr/command.js";
import { resolveWorkerPaths } from "./paths.js";
import { toolCommand, ToolSelectionError, verifyToolLaunch } from "../../platform/tool-executables.js";
import { readHerdrSharedInstance } from "./herdr/shared-instance-store.js";
import { inspectProcessProof } from "../controller/process-proof.js";

export const attachWorker = async (options: { homeDirectory: string }): Promise<void> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("daynight worker attach requires an interactive terminal.");
  const paths = resolveWorkerPaths(options.homeDirectory);
  const journal = path.join(paths.workerDirectory, "herdr-executions.sqlite");
  let hasJournal = false;
  if (process.platform === "darwin") {
    try { statSync(journal); hasJournal = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  let run: HerdrLocalRun | undefined;
  if (hasJournal) {
    const candidates = readHerdrLifecycleRecords(journal).filter(record => {
      const current = record.runs.at(-1);
      return current !== undefined && current.phase !== "stopped_confirmed";
    });
    if (candidates.length === 0) throw new Error("No recorded Herdr runtime is available for attachment.");
    const { select } = await import("@inquirer/prompts");
    const selected = candidates.length === 1 ? candidates[0]! : await select({
      message: "Select the original task runtime to attach",
      choices: candidates.map(record => ({ name: `${record.owner.taskId} · ${record.claimId} · ${record.owner.provider}`, value: record })),
    });
    run = selected.runs.at(-1)!;
    if (run.daemon === null) throw new Error("The original Herdr daemon identity is unavailable; attachment is prohibited.");
  }
  const shared = run === undefined ? readHerdrSharedInstance(paths) : null;
  const toolLaunch = run === undefined ? shared?.current?.launch ?? undefined : run.launches?.herdr;
  const instance = createHerdrInstance({ ...(run === undefined ? { paths } : { paths: { ...paths, herdrDirectory: run.instanceDirectory, logsDirectory: path.join(run.instanceDirectory, "logs") }, isolatedRun: true }), ...(toolLaunch === undefined ? {} : { toolLaunch }) });
  const native = run === undefined ? undefined : createMacProcessControl();
  const verifyDaemon = async (): Promise<void> => {
    if (shared !== null) {
      const current = shared.current;
      if (shared.pending === null && current?.phase === "ready" && current.launch === null) throw new ToolSelectionError("herdr", "herdr", "launch", "legacy_tool_identity_missing");
      if (shared.pending !== null || current?.phase !== "ready" || current.daemon === null || await inspectProcessProof(current.daemon) !== "running") throw new Error("The original shared Herdr daemon cannot be verified; attachment is prohibited.");
    }
    if (run === undefined || native === undefined) return;
    const original = run.daemon!;
    if (await native.observe(original) !== "same") throw new Error("The original Herdr daemon cannot be verified; attachment is prohibited.");
    for (const endpoint of [instance.paths.apiEndpoint, instance.paths.clientEndpoint]) {
      const peer = await native.peer(endpoint);
      if (peer.pid !== original.pid || peer.bootId !== original.bootId || peer.birthToken !== original.birthToken || JSON.stringify(peer.auditToken) !== JSON.stringify(original.auditToken)) throw new Error("The endpoint no longer belongs to the original Herdr daemon; attachment is prohibited.");
    }
  };
  const operation = createOperation({ limits: { totalMs: 30_000 } });
  try {
    await verifyDaemon(); await instance.connect(operation); await verifyDaemon();
    if (toolLaunch === undefined) throw new ToolSelectionError("herdr", "herdr", "launch", "legacy_tool_identity_missing");
    await verifyToolLaunch(toolLaunch, operation);
    await verifyDaemon();
  }
  finally { operation.dispose(); }
  const attachment = instance.attachment;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !attachment.unsetEnvironment.some((key) => key.toUpperCase() === name.toUpperCase())));
  Object.assign(environment, attachment.environment);
  // The explicit client connects only to an existing daemon, including if it exits after the probe.
  // https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/main.rs#L573-L577
  const command = toolCommand(toolLaunch!, ["--session", "w", "client"]);
  const child = spawnHerdrProcess(command.file, command.args, { env: environment, stdio: "inherit", detached: false, windowsHide: false, shell: false });
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
