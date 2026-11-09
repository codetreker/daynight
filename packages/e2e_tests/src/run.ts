import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildArtifacts } from "./build.ts";
import { registerAuth } from "./auth-bootstrap.ts";
import { runCommand } from "./command.ts";
import { startEnvironment, type CleanupReceipt, type Environment } from "./environment.ts";

const repository = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const args = process.argv.slice(2);
const parsed = parseArgs({ args: args[0] === "--" ? args.slice(1) : args, options: { "auth-source": { type: "string" } } });
if (process.platform !== "linux") throw new Error("Product E2E is supported on Linux.");
const runDirectory = path.join(repository, ".tmp", "product-e2e", randomUUID());
await mkdir(runDirectory, { recursive: true, mode: 0o700 });
await mkdir(path.join(runDirectory, "results"));
await mkdir(path.join(runDirectory, "private"), { mode: 0o700 });
console.log(`Product E2E results: ${runDirectory}`);
const pointer = process.env.DAYNIGHT_E2E_RUN_POINTER;
const writeRunPointer = async (phase: "build" | "environment"): Promise<void> => {
  if (pointer === undefined) return;
  const filename = path.resolve(pointer);
  if (!filename.startsWith(`${repository}${path.sep}`)) throw new Error("The E2E run pointer must stay inside the checkout.");
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(`${filename}.tmp`, `${JSON.stringify({ schemaVersion: 1, runDirectory, phase })}\n`, { mode: 0o600 });
  await rename(`${filename}.tmp`, filename);
};
await writeRunPointer("build");
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(repository, ".tmp", "playwright-browsers");
process.env.TMPDIR = path.join(runDirectory, "private");
const cancellation = new AbortController();
const cancel = (signal: NodeJS.Signals) => cancellation.abort(new Error(`Product E2E interrupted by ${signal}.`));
const interrupt = () => cancel("SIGINT");
const terminate = () => cancel("SIGTERM");
process.once("SIGINT", interrupt);
process.once("SIGTERM", terminate);

let environment: Environment | undefined;
const failures: unknown[] = [];
const manifest: Record<string, unknown> = { startedAt: new Date().toISOString(), status: "running", cleanup: { completed: false } };
const lockFile = path.join(repository, ".tmp", "product-e2e-build-lock");
let ownsLock = false;
let preparingEnvironment = false;
try {
  const ownerRecord = path.join(runDirectory, "private", "build-lock-owner.json");
  await writeFile(ownerRecord, `${JSON.stringify({ schemaVersion: 1, runDirectory })}\n`);
  await link(ownerRecord, lockFile);
  ownsLock = true;
  const artifacts = await buildArtifacts({ repository, runDirectory, authSource: parsed.values["auth-source"], signal: cancellation.signal });
  await rm(lockFile);
  ownsLock = false;
  manifest.artifacts = artifacts;
  preparingEnvironment = true;
  await writeRunPointer("environment");
  environment = await startEnvironment({ repository, runDirectory, artifactsDirectory: artifacts.directory, signal: cancellation.signal });
  manifest.resources = environment.resourceIdentity;
  const credentials = await registerAuth(environment, (event) => appendFileSync(path.join(runDirectory, "logs", "auth-bootstrap.jsonl"), `${JSON.stringify(event)}\n`));
  await environment.startServer(credentials);
  const descriptor = {
    baseURL: environment.baseURL,
    authURL: environment.authURL,
    proxyURL: environment.proxyURL,
    cliEntry: artifacts.cliEntry,
    cliConfigDirectory: path.join(runDirectory, "private", "cli"),
  };
  await mkdir(descriptor.cliConfigDirectory);
  await writeFile(path.join(descriptor.cliConfigDirectory, "config.yml"), `serverUrl: ${environment.baseURL}\n`, { mode: 0o600 });
  await writeFile(path.join(runDirectory, "environment.json"), `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
  await runCommand("pnpm", ["--filter", "@codetreker/daynight-e2e", "exec", "playwright", "test"], {
    cwd: repository,
    env: { ...process.env, DAYNIGHT_E2E_RUN_DIRECTORY: runDirectory },
    signal: cancellation.signal,
    timeoutMs: 300_000,
  });
  manifest.status = "passed";
} catch (error) {
  failures.push(error);
  manifest.status = "failed";
} finally {
  if (ownsLock) {
    try { await rm(lockFile); }
    catch (error) { failures.push(error); }
  }
  const cleanupFailures: unknown[] = [];
  if (environment !== undefined) {
    try { await environment.close(); }
    catch (error) { cleanupFailures.push(error); }
  }
  let runtimeVerified = !preparingEnvironment;
  if (preparingEnvironment) {
    try {
      const receipt = JSON.parse(await readFile(path.join(runDirectory, "results", "environment-cleanup.json"), "utf8")) as CleanupReceipt;
      manifest.resources = receipt.resourceIdentity;
      manifest.runtimeCleanup = receipt;
      runtimeVerified = receipt.verified;
      if (!runtimeVerified && cleanupFailures.length === 0) cleanupFailures.push(new Error("Runtime cleanup did not produce a verified successful receipt."));
    } catch (error) { cleanupFailures.push(error); }
  }
  for (const directory of ["private", "artifacts"]) {
    try { await rm(path.join(runDirectory, directory), { recursive: true, force: true }); }
    catch (error) { cleanupFailures.push(error); }
  }
  failures.push(...cleanupFailures);
  if (cleanupFailures.length > 0) manifest.status = "failed";
  manifest.cleanup = { completed: runtimeVerified && cleanupFailures.length === 0 };
  manifest.finishedAt = new Date().toISOString();
  await writeFile(path.join(runDirectory, "results", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
}
if (failures.length === 1) throw failures[0];
if (failures.length > 1) throw new AggregateError(failures, "Product E2E execution or cleanup failed.");
console.log("Product E2E passed; isolated runtime resources removed.");
