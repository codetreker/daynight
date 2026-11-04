import { execFileSync } from "node:child_process";
import crossSpawn from "cross-spawn";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { InstalledCliReceipt } from "../test/fixtures/installed-cli.js";
import type { BudgetProbeReceipt, BudgetProbeSuite } from "./project-task-budgets.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const serverRoot = path.join(repositoryRoot, "packages/daynight-server");
const e2ePackage = "github.com/codetreker/daynight/packages/daynight-server/cmd/e2e_tests";
// The pinned tool uses substring matching for package exclusions. Guard the entire
// matching directory tree so this selection can never hide production statements.
// https://github.com/codetreker/go-cov/blob/d6caf2759e330b48d69a543695e37002a48feb1d/internal/coverage/run.go#L195-L202
const coverageArgs = ["run", "github.com/codetreker/go-cov/cmd/go-cov@d6caf2759e330b48d69a543695e37002a48feb1d", "--config", ".go-cov.toml", "--ci", "--coverprofile", ".tmp/coverage.out", "--exclude-packages", e2ePackage];

type ValidationMode = "all" | "coverage" | "e2e";

export const coveragePackages = (packages: readonly string[]): string[] => {
  if (!packages.includes(e2ePackage) || packages.some((name) => name.includes(e2ePackage) && name !== e2ePackage)) {
    throw new Error("Coverage exclusion must match exactly the cmd/e2e_tests package.");
  }
  return packages.filter((name) => name !== e2ePackage);
};

export const requireTestOnlyE2E = async (directory: string): Promise<void> => {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) await requireTestOnlyE2E(path.join(directory, entry.name));
    else if (entry.name.endsWith(".go") && !entry.name.endsWith("_test.go")) {
      throw new Error("cmd/e2e_tests must remain test-only; production Go files cannot be excluded from coverage.");
    }
  }
};

type CommandReceipt = { command: string; args: readonly string[]; elapsedMs: number; exitCode: number | null; signal: NodeJS.Signals | null };
type ServiceEvidence = {
  schemaVersion: 1;
  suite: BudgetProbeSuite;
  mode: Exclude<ValidationMode, "all">;
  source?: { revision: string; tree: string; dirty: boolean };
  packages?: string[];
  passed: boolean;
  installed?: InstalledCliReceipt;
  build?: CommandReceipt;
  goCoverage?: CommandReceipt;
  goE2E?: CommandReceipt;
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

export const runProjectTaskAcceptance = async (suite: BudgetProbeSuite = "deadlines", mode: ValidationMode = "all"): Promise<void> => {
  if (suite === "stress-budgets" && process.env.CI) throw new Error("CLI resource-budget stress tests run only on local machines.");
  if (mode === "all") {
    await runProjectTaskAcceptance(suite, "coverage");
    await runProjectTaskAcceptance("deadlines", "e2e");
    return;
  }
  const receiptPath = path.join(repositoryRoot, mode === "e2e" ? ".tmp/project-task-e2e-evidence.json" : suite === "deadlines" ? ".tmp/project-task-service-evidence.json" : ".tmp/project-task-stress-evidence.json");
  await rm(receiptPath, { force: true });
  await rm(path.join(serverRoot, mode === "e2e" ? ".tmp/acceptance-evidence.json" : ".tmp/coverage.out"), { force: true });
  const fixtureModule: typeof import("../test/fixtures/installed-cli.js") = await import(new URL("../test/fixtures/installed-cli.ts", import.meta.url).href);
  const budgets: typeof import("./project-task-budgets.js") = await import(new URL("./project-task-budgets.ts", import.meta.url).href);
  const evidence: ServiceEvidence = { schemaVersion: 1, suite, mode, passed: false, probes: [], installedFixtureRemoved: false, failures: [] };
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
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", timeout: 10_000 }).trim();
    evidence.source = { revision: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirty: git("status", "--porcelain") !== "" };
    await requireTestOnlyE2E(path.join(serverRoot, "cmd/e2e_tests"));
    const packages = execFileSync("go", ["list", "./..."], { cwd: serverRoot, env: process.env, encoding: "utf8", timeout: 120_000 }).trim().split(/\r?\n/);
    const productionPackages = coveragePackages(packages);
    evidence.packages = mode === "e2e" ? [e2ePackage] : productionPackages;
    try { evidence.build = await runCommand("pnpm", ["--dir", repositoryRoot, "build"], repositoryRoot, process.env, fixtureModule.terminateInstalledProcess, cancellation.signal, 120_000); }
    catch (error) {
      if (typeof error === "object" && error !== null && "commandReceipt" in error) evidence.build = error.commandReceipt as CommandReceipt;
      throw error;
    }
    fixture = await fixtureModule.createInstalledCli({ signal: cancellation.signal });
    evidence.installed = fixture.receipt;
    const budgetTokenFile = path.join(fixture.receipt.root, "budget-token.json");
    const env = { ...process.env, DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT: fixture.receiptPath, ...(mode === "coverage" ? { DAYNIGHT_TEST_CLI_BUDGET_TOKEN_FILE: budgetTokenFile } : {}) };
    if (mode === "e2e") {
      try { evidence.goE2E = await runCommand("go", ["test", "-race", "-count=1", "-timeout=10m", "./cmd/e2e_tests"], serverRoot, env, fixtureModule.terminateInstalledProcess, cancellation.signal, 12 * 60_000); }
      catch (error) {
        if (typeof error === "object" && error !== null && "commandReceipt" in error) evidence.goE2E = error.commandReceipt as CommandReceipt;
        throw error;
      }
    } else {
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
      try { evidence.probes = await budgets.runBudgetProbes(suite, fixture.receipt, repositoryRoot, serverToken, cancellation.signal); }
      catch (error) {
        if (error instanceof budgets.BudgetAcceptanceError) evidence.probes = error.receipts;
        throw error;
      }
    }
  } catch (error) {
    fail(error);
  } finally {
    for (const { name, listener } of listeners) process.removeListener(name, listener);
    if (fixture !== undefined) {
      try { await fixture.cleanup(); evidence.installedFixtureRemoved = true; }
      catch (error) { fail(error); }
    }
    const expectedProbes = mode === "e2e" ? [] : budgets.budgetProbeNames(suite);
    evidence.passed = evidence.failures.length === 0 && evidence.installedFixtureRemoved && evidence.probes.length === expectedProbes.length && expectedProbes.every((name) => evidence.probes.some((probe) => probe.name === name && probe.passed));
    try {
      await mkdir(path.dirname(receiptPath), { recursive: true });
      await writeFile(receiptPath, `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(`Project/task service acceptance evidence: ${path.relative(repositoryRoot, receiptPath)}.`);
    } catch (error) { fail(error); evidence.passed = false; }
  }
  if (!evidence.passed) throw new AggregateError(failures, "Project/task service acceptance failed.");
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args[0] !== undefined && !["--coverage", "--e2e", "--stress-budgets"].includes(args[0])) throw new Error("Usage: node packages/daynight/scripts/project-task-acceptance.ts [--coverage|--e2e|--stress-budgets]");
  await runProjectTaskAcceptance(args[0] === "--stress-budgets" ? "stress-budgets" : "deadlines", args[0] === "--coverage" ? "coverage" : args[0] === "--e2e" ? "e2e" : "all");
}
