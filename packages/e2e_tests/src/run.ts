import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildArtifacts } from "./build.ts";
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

const registerAuth = async (environment: Environment): Promise<{ appId: string; appSecret: string }> => {
  const { chromium, expect } = await import("@playwright/test");
  const browser = await chromium.launch({ proxy: { server: environment.proxyURL, bypass: "127.0.0.1,localhost" } });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "en-US" });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(`${environment.authURL}/console/`);
    await page.getByRole("button", { name: "Continue with GitHub", exact: true }).click();
    await page.getByRole("button", { name: "Authorize local identity", exact: true }).click();
    await expect(page).toHaveURL(`${environment.authURL}/console/`);
    const session = await context.request.get(`${environment.authURL}/console/api/session`);
    if (session.status() !== 200) throw new Error(`UniAuth Console session failed (${session.status()}).`);
    const user = await session.json() as { csrf_token: string };
    if (typeof user.csrf_token !== "string") throw new Error("UniAuth did not return a Console CSRF token.");
    const response = await context.request.post(`${environment.authURL}/console/api/apps`, {
      headers: { Origin: environment.authURL, "X-CSRF-Token": user.csrf_token },
      data: {
        name: "Product E2E",
        enabled: true,
        redirect_uris: [`${environment.baseURL}/auth/callback`],
        providers: ["github"],
        initial_secret: { name: "E2E backend" },
      },
    });
    if (response.status() !== 201) throw new Error(`UniAuth App registration failed (${response.status()}): ${await response.text()}`);
    const creation = await response.json() as { app: { id: string }; secret: string };
    if (typeof creation.app.id !== "string" || typeof creation.secret !== "string") throw new Error("UniAuth did not return the registered App credentials.");
    await context.close();
    return { appId: creation.app.id, appSecret: creation.secret };
  } finally { await browser.close(); }
};

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
  manifest.artifacts = artifacts;
  const decoder = path.join(artifacts.directory, "image-validator");
  await runCommand(process.execPath, [path.join(repository, "packages/daynight/scripts/package-image-validation.ts"), decoder], {
    cwd: repository, signal: cancellation.signal, timeoutMs: 60_000,
  });
  manifest.decoder = Object.fromEntries(await Promise.all(["image-validation-helper.js", "image-validation-manifest.json"].map(async name => [name, createHash("sha256").update(await readFile(path.join(decoder, name))).digest("hex")])));
  await rm(lockFile);
  ownsLock = false;
  preparingEnvironment = true;
  await writeRunPointer("environment");
  environment = await startEnvironment({ repository, runDirectory, artifactsDirectory: artifacts.directory, signal: cancellation.signal });
  manifest.resources = environment.resourceIdentity;
  const credentials = await registerAuth(environment);
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
