import crossSpawn from "cross-spawn";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { InstalledCliReceipt } from "../test/fixtures/installed-cli.js";
import type { BudgetProbeReceipt } from "./project-task-budgets.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const serverRoot = path.join(repositoryRoot, "packages/daynight-server");
const receiptPath = path.join(repositoryRoot, ".tmp/project-task-service-evidence.json");
// Test-only packages have no coverage denominator. Skip their result summary while retaining test execution and failures.
// https://github.com/codetreker/go-cov/blob/d6caf2759e330b48d69a543695e37002a48feb1d/internal/coverage/parse.go#L295-L300
const coverageArgs = ["run", "github.com/codetreker/go-cov/cmd/go-cov@d6caf2759e330b48d69a543695e37002a48feb1d", "--config", ".go-cov.toml", "--ci", "--coverprofile", ".tmp/coverage.out", "--skip-result-packages", "cmd/e2e_tests"];

type CommandReceipt = { command: string; args: readonly string[]; elapsedMs: number; exitCode: number | null; signal: NodeJS.Signals | null };
type ServiceEvidence = {
  schemaVersion: 1;
  passed: boolean;
  installed?: InstalledCliReceipt;
  build?: CommandReceipt;
  goCoverage?: CommandReceipt;
  strictCoverage?: CommandReceipt;
  probes: BudgetProbeReceipt[];
  installedFixtureRemoved: boolean;
  failures: string[];
};

type TerminateInstalledProcess = typeof import("../test/fixtures/installed-cli.js").terminateInstalledProcess;

export const readBudgetToken = async (file: string): Promise<string> => {
  const entry = await lstat(file);
  if (!entry.isFile() || process.platform !== "win32" && (entry.mode & 0o777) !== 0o600) throw new Error("Installed CLI budget credentials must be stored in a private regular file.");
  const source = await readFile(file, "utf8");
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new Error("Installed CLI budget credential metadata is invalid."); }
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("serverToken" in value) || typeof value.serverToken !== "string" || !/^[\x21-\x7e]+$/.test(value.serverToken)) throw new Error("Installed CLI budget credential metadata is invalid.");
  return value.serverToken;
};

const runCommand = async (command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, terminate: TerminateInstalledProcess, signal: AbortSignal, watchdogMs: number): Promise<CommandReceipt> => {
  signal.throwIfAborted();
  const started = performance.now();
  const child = crossSpawn(command, [...args], { cwd, env, stdio: "inherit", windowsHide: true, detached: process.platform !== "win32" });
  let launchFailure: unknown;
  child.once("error", (error) => { launchFailure = error; });
  const spawned = new Promise<void>((resolve) => { child.once("spawn", resolve); child.once("error", () => resolve()); });
  const closed = new Promise<CommandReceipt>((resolve) => child.once("close", (exitCode, childSignal) => resolve({ command, args, elapsedMs: Math.round(performance.now() - started), exitCode, signal: childSignal })));
  const stopping = Promise.withResolvers<Error>();
  const cancel = (): void => stopping.resolve(new Error("Project/task acceptance was cancelled.", { cause: signal.reason }));
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => stopping.resolve(new Error(`${command} exceeded the outer acceptance watchdog.`)), watchdogMs);
  if (signal.aborted) cancel();
  try {
    const result = await Promise.race([closed, stopping.promise]);
    if (result instanceof Error) {
      try { await spawned; await terminate(child, closed); }
      catch (cleanupError) { throw new AggregateError([result, cleanupError], "Acceptance command and cleanup failed."); }
      throw Object.assign(result, { commandReceipt: await closed });
    }
    if (launchFailure !== undefined) throw launchFailure;
    if (result.exitCode !== 0 || result.signal !== null) throw Object.assign(new Error(`${command} failed (${result.signal === null ? `exit ${result.exitCode}` : `signal ${result.signal}`}).`), { commandReceipt: result });
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
};

export const runProjectTaskAcceptance = async (): Promise<void> => {
  await rm(receiptPath, { force: true });
  const fixtureModule: typeof import("../test/fixtures/installed-cli.js") = await import(new URL("../test/fixtures/installed-cli.ts", import.meta.url).href);
  const budgets: typeof import("./project-task-budgets.js") = await import(new URL("./project-task-budgets.ts", import.meta.url).href);
  const evidence: ServiceEvidence = { schemaVersion: 1, passed: false, probes: [], installedFixtureRemoved: false, failures: [] };
  const failures: unknown[] = [];
  const fail = (error: unknown): void => { failures.push(error); evidence.failures.push(budgets.describeAcceptanceError(error)); };
  const cancellation = new AbortController();
  const signalNames: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
  const listeners = signalNames.map((name) => {
    const listener = (): void => cancellation.abort(new Error(`Project/task acceptance received ${name}.`));
    process.once(name, listener);
    return { name, listener };
  });
  let fixture: Awaited<ReturnType<typeof fixtureModule.createInstalledCli>> | undefined;
  try {
    try { evidence.build = await runCommand("pnpm", ["--dir", repositoryRoot, "build"], repositoryRoot, process.env, fixtureModule.terminateInstalledProcess, cancellation.signal, 120_000); }
    catch (error) {
      if (typeof error === "object" && error !== null && "commandReceipt" in error) evidence.build = error.commandReceipt as CommandReceipt;
      throw error;
    }
    fixture = await fixtureModule.createInstalledCli({ signal: cancellation.signal });
    evidence.installed = fixture.receipt;
    const budgetTokenFile = path.join(fixture.receipt.root, "budget-token.json");
    const env = { ...process.env, DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT: fixture.receiptPath, DAYNIGHT_TEST_CLI_BUDGET_TOKEN_FILE: budgetTokenFile };
    try { evidence.goCoverage = await runCommand("go", coverageArgs, serverRoot, env, fixtureModule.terminateInstalledProcess, cancellation.signal, 12 * 60_000); }
    catch (error) {
      if (typeof error === "object" && error !== null && "commandReceipt" in error) evidence.goCoverage = error.commandReceipt as CommandReceipt;
      throw error;
    }
    try { evidence.strictCoverage = await runCommand(process.execPath, ["scripts/coverage.mts", ".tmp/coverage.out"], serverRoot, env, fixtureModule.terminateInstalledProcess, cancellation.signal, 10_000); }
    catch (error) {
      if (typeof error === "object" && error !== null && "commandReceipt" in error) evidence.strictCoverage = error.commandReceipt as CommandReceipt;
      throw error;
    }
    const serverToken = await readBudgetToken(budgetTokenFile);
    await rm(budgetTokenFile);
    try { evidence.probes = await budgets.runProductionBudgetProbes(fixture.receipt, repositoryRoot, serverToken, cancellation.signal); }
    catch (error) {
      if (error instanceof budgets.BudgetAcceptanceError) evidence.probes = error.receipts;
      throw error;
    }
  } catch (error) {
    fail(error);
  } finally {
    for (const { name, listener } of listeners) process.removeListener(name, listener);
    if (fixture !== undefined) {
      try { await fixture.cleanup(); evidence.installedFixtureRemoved = true; }
      catch (error) { fail(error); }
    }
    evidence.passed = evidence.failures.length === 0 && evidence.installedFixtureRemoved && evidence.probes.length === 6 && evidence.probes.every((probe) => probe.passed);
    try {
      await mkdir(path.dirname(receiptPath), { recursive: true });
      await writeFile(receiptPath, `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(`Project/task service acceptance evidence: ${path.relative(repositoryRoot, receiptPath)}.`);
    } catch (error) { fail(error); evidence.passed = false; }
  }
  if (!evidence.passed) throw new AggregateError(failures, "Project/task service acceptance failed.");
};

if (import.meta.main) {
  if (process.argv.length !== 2) throw new Error("Usage: node packages/daynight/scripts/project-task-acceptance.ts");
  await runProjectTaskAcceptance();
}
