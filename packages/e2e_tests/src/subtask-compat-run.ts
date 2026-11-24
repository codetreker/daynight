import { createHash, randomUUID } from "node:crypto";
import { copyFile, cp, link, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { buildArtifacts, sourceFingerprint } from "./build.ts";
import { browserCommandOptions } from "./browser.ts";
import { assertCommandQuiescence, CommandFailure, runCommand, type ManagedCommand } from "./command.ts";
import { startEnvironment, type Environment } from "./environment.ts";
import { initializeRunOwnership } from "./fixture-owner.ts";
import { completeFailedBuild, markBuildComplete } from "./recovery.ts";
import { completeCompatEnvironmentSetup, finalizeCompatEnvironment, settleCompatEnvironmentSetupFailure, startCompatPlaywright } from "./subtask-compat-boundary.ts";
import { publishCandidateArtifact, verifyCandidateArtifact } from "./subtask-compat-artifact.ts";
import { executedScenario, goalWorkerName, mixedVersionName, type WorkerVariant } from "./subtask-compat-process.ts";
import { verifyCandidateCombination } from "./subtask-compat-recovery-provenance.ts";

const repository = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const args = process.argv.slice(2);
const parsed = parseArgs({ args: args[0] === "--" ? args.slice(1) : args, options: { "auth-source": { type: "string" }, "baseline-web": { type: "string" }, "baseline-source": { type: "string" }, "old-server": { type: "string" }, "old-cli": { type: "string" }, "baseline": { type: "string" }, "candidate-sha": { type: "string" }, "candidate-artifact-out": { type: "string" }, "candidate-artifact-in": { type: "string" }, "candidate-artifact-sha256": { type: "string" }, "candidate-manifest": { type: "string" }, "worker-variant": { type: "string" }, server: { type: "string" } } });
if (!["baseline", "candidate"].includes(parsed.values.server ?? "") || !parsed.values["candidate-sha"] || !parsed.values["baseline-web"] || !parsed.values["baseline-source"] || !parsed.values["old-server"] || !parsed.values["old-cli"] || !parsed.values.baseline) throw new Error("Compatibility runner is missing its validated inputs.");
const workerVariant = parsed.values["worker-variant"] as WorkerVariant | undefined;
if (workerVariant !== undefined && (!['candidate', 'npm-0.72.0'].includes(workerVariant) || parsed.values.server !== 'candidate' || !parsed.values['candidate-artifact-in'] || !parsed.values['candidate-artifact-sha256'] || !parsed.values['candidate-manifest'] || parsed.values['candidate-artifact-out'])) throw new Error('Goal Worker run requires one variant and the original candidate artifact and manifest.');
if (workerVariant === undefined && (parsed.values['candidate-artifact-in'] || parsed.values['candidate-artifact-sha256'] || parsed.values['candidate-manifest'])) throw new Error('Candidate artifact input is reserved for Goal Worker runs.');
if (process.platform !== "linux") throw new Error("Product E2E is supported on Linux.");
const runDirectory = path.join(repository, ".tmp", "product-e2e", randomUUID());
await mkdir(runDirectory, { recursive: true, mode: 0o700 });
await mkdir(path.join(runDirectory, "results"));
await mkdir(path.join(runDirectory, "private"), { mode: 0o700 });
console.log(`Product E2E results: ${runDirectory}`);
const pointer = process.env.DAYNIGHT_E2E_RUN_POINTER;
const candidateArtifactOut = parsed.values["candidate-artifact-out"];
if (candidateArtifactOut !== undefined || workerVariant !== undefined) {
  const reportDirectory = pointer === undefined ? "" : path.dirname(path.resolve(pointer));
  const reportParent = path.join(repository, ".tmp", "product-e2e-compat");
  if (parsed.values.server !== "candidate" || path.dirname(reportDirectory) !== reportParent || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(path.basename(reportDirectory)) ||
      path.resolve(candidateArtifactOut ?? parsed.values['candidate-artifact-in']!) !== path.join(reportDirectory, "private", "candidate-server")) throw new Error("Candidate artifact handoff does not identify this compatibility report.");
}
const writeRunPointer = async (phase: "build" | "environment", initial = false): Promise<void> => {
  if (pointer === undefined) return;
  const filename = path.resolve(pointer);
  if (!filename.startsWith(`${repository}${path.sep}`)) throw new Error("The E2E run pointer must stay inside the checkout.");
  await mkdir(path.dirname(filename), { recursive: true });
  if (initial) {
    await writeFile(filename, `${JSON.stringify({ schemaVersion: 1, runDirectory, phase })}\n`, { flag: "wx", mode: 0o600 });
    return;
  }
  await writeFile(`${filename}.tmp`, `${JSON.stringify({ schemaVersion: 1, runDirectory, phase })}\n`, { mode: 0o600 });
  await rename(`${filename}.tmp`, filename);
};
await writeRunPointer("build", true);
await initializeRunOwnership(repository, runDirectory);
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(repository, ".tmp", "playwright-browsers");
process.env.TMPDIR = path.join(runDirectory, "private");
const cancellation = new AbortController();
const cancel = (signal: NodeJS.Signals) => cancellation.abort(new Error(`Product E2E interrupted by ${signal}.`));
const interrupt = () => cancel("SIGINT");
const terminate = () => cancel("SIGTERM");
process.once("SIGINT", interrupt);
process.once("SIGTERM", terminate);

const waitForCredentials = async (filename: string, signal: AbortSignal): Promise<{ appId: string; appSecret: string }> => {
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    try {
      const value = JSON.parse(await readFile(filename, "utf8")) as { appId?: unknown; appSecret?: unknown };
      if (typeof value.appId !== "string" || value.appId === "" || typeof value.appSecret !== "string" || value.appSecret === "") throw new Error("Bootstrap credentials are invalid.");
      signal.throwIfAborted();
      return { appId: value.appId, appSecret: value.appSecret };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await delay(100, undefined, { signal });
  }
  throw new Error("OAuth bootstrap did not produce credentials before its deadline.");
};

let environment: Environment | undefined;
let playwright: ManagedCommand | undefined;
const failures: unknown[] = [];
const manifest: Record<string, unknown> = { startedAt: new Date().toISOString(), status: "running", cleanup: { completed: false } };
let phase = "ownership";
const setPhase = async (value: string): Promise<void> => {
  phase = value;
  manifest.phase = value;
  const filename = path.join(runDirectory, "results", "phase.json");
  await writeFile(`${filename}.tmp`, `${JSON.stringify({ phase: value })}\n`, { mode: 0o600 });
  await rename(`${filename}.tmp`, filename);
};
const lockFile = path.join(repository, ".tmp", "product-e2e-build-lock");
const hashTree = async (directory: string): Promise<string> => {
  const hash = createHash("sha256");
  const visit = async (parent: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(parent, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = prefix + entry.name, filename = path.join(parent, entry.name);
      if (entry.isDirectory()) await visit(filename, `${name}/`);
      else if (entry.isFile()) hash.update(name).update("\0").update(await readFile(filename)).update("\0");
      else throw new Error(`Nonregular Web artifact: ${filename}`);
    }
  };
  await visit(directory, "");
  return hash.digest("hex");
};
const harnessFingerprint = async (): Promise<string> => {
  const hash = createHash("sha256");
  const packageRoot = path.join(repository, "packages/e2e_tests");
  const names = ["package.json", "playwright.config.ts", "tests/fixtures.ts", "tests/native-worker-peer.mjs", "tests/subtask-compat-worker.ts", "tests/subtask-compat-worker-observer.ts", "tests/subtask-compat.spec.ts", "tests/subtask-compat-goal-worker.spec.ts"];
  for (const entry of await readdir(path.join(packageRoot, "src"), { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:ts|mjs|cjs)$/.test(entry.name) && (!entry.name.startsWith("subtask-compat-recovery") || entry.name === "subtask-compat-recovery-provenance.ts")) names.push(`src/${entry.name}`);
  }
  for (const name of names.sort()) {
    hash.update(name).update("\0").update(await readFile(path.join(packageRoot, name))).update("\0");
  }
  return hash.digest("hex");
};
let ownsLock = false;
let preparingEnvironment = false;
let buildComplete = false;
let environmentComplete = false;
try {
  const ownerRecord = path.join(runDirectory, "private", "build-lock-owner.json");
  await writeFile(ownerRecord, `${JSON.stringify({ schemaVersion: 1, runDirectory })}\n`);
  await link(ownerRecord, lockFile);
  ownsLock = true;
  await setPhase("candidate-build");
  const harnessHash = await harnessFingerprint();
  manifest.harnessSHA256 = harnessHash;
  const artifacts = await buildArtifacts({ repository, runDirectory, authSource: parsed.values["auth-source"], signal: cancellation.signal });
  if (artifacts.sourceRevision !== parsed.values["candidate-sha"]) throw new Error("Candidate build revision differs from the requested commit.");
  const headAfterBuild = await runCommand("git", ["rev-parse", "HEAD"], { cwd: repository, signal: cancellation.signal, timeoutMs: 15_000, onOutput: () => {} });
  if (headAfterBuild.stdout.trim() !== parsed.values["candidate-sha"]) throw new Error("Candidate HEAD changed during the build.");
  manifest.artifacts = artifacts;
  manifest.combination = { server: parsed.values.server, baseline: parsed.values.baseline, ...(workerVariant === undefined ? {} : { workerVariant }) };
  await setPhase("baseline-source");
  // The baseline is rebuilt in a full private clone; a supplied bundle hash or
  // claimed revision is never treated as proof of that build's origin.
  const baselineSource = path.join(runDirectory, "private", "baseline-source");
  const buildOptions = { cwd: repository, signal: cancellation.signal, timeoutMs: 120_000 };
  await runCommand("git", ["diff", "--quiet", parsed.values.baseline!, artifacts.sourceRevision, "--", "pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json", "patches", "packages/daynight-web/package.json"], buildOptions);
  await runCommand("git", ["clone", "--no-hardlinks", "--no-checkout", parsed.values["baseline-source"]!, baselineSource], buildOptions);
  await runCommand("git", ["checkout", "--detach", parsed.values.baseline!], { ...buildOptions, cwd: baselineSource });
  const revision = await runCommand("git", ["rev-parse", "HEAD"], { ...buildOptions, cwd: baselineSource, onOutput: () => {} });
  const shallow = await runCommand("git", ["rev-parse", "--is-shallow-repository"], { ...buildOptions, cwd: baselineSource, onOutput: () => {} });
  if (revision.stdout.trim() !== parsed.values.baseline || shallow.stdout.trim() !== "false") throw new Error("Private baseline clone does not identify the complete requested revision.");
  const fingerprintBefore = await sourceFingerprint(baselineSource, cancellation.signal);
  await symlink(path.join(repository, "node_modules"), path.join(baselineSource, "node_modules"), "dir");
  await symlink(path.join(repository, "packages/daynight-web/node_modules"), path.join(baselineSource, "packages/daynight-web/node_modules"), "dir");
  await setPhase("baseline-web-build");
  const baselineWebSource = path.join(baselineSource, "packages/daynight-web");
  await runCommand(path.join(repository, "packages/daynight-web/node_modules/.bin/tsc"), ["--project", "tsconfig.build.json"], { cwd: baselineWebSource, signal: cancellation.signal, timeoutMs: 1_200_000 });
  await runCommand(path.join(repository, "packages/daynight-web/node_modules/.bin/vite"), ["build"], { cwd: baselineWebSource, signal: cancellation.signal, timeoutMs: 1_200_000 });
  await runCommand(process.execPath, ["scripts/publish-assets.mts"], { cwd: baselineWebSource, signal: cancellation.signal, timeoutMs: 60_000 });
  await unlink(path.join(baselineSource, "packages/daynight-web/node_modules"));
  await unlink(path.join(baselineSource, "node_modules"));
  await setPhase("baseline-server-build");
  const baselineWeb = path.join(baselineSource, "packages/daynight-web/dist");
  const baselineServer = path.join(artifacts.directory, "baseline-server");
  const cache = path.join(repository, ".tmp", "product-e2e-cache");
  await runCommand("go", ["build", "-trimpath", "-o", baselineServer, "./cmd/daynight-server"], { cwd: path.join(baselineSource, "packages/daynight-server"), signal: cancellation.signal, timeoutMs: 1_200_000, env: { ...process.env, GOCACHE: path.join(cache, "go-build"), GOMODCACHE: path.join(cache, "go-mod"), GOPATH: path.join(cache, "go"), GOENV: "off", GOTOOLCHAIN: "go1.27.2", CGO_ENABLED: "0", TMPDIR: path.join(cache, "tmp") } });
  const fingerprintAfter = await sourceFingerprint(baselineSource, cancellation.signal);
  const baselineHeadAfter = await runCommand("git", ["rev-parse", "HEAD"], { ...buildOptions, cwd: baselineSource, onOutput: () => {} });
  if (fingerprintBefore !== fingerprintAfter || baselineHeadAfter.stdout.trim() !== parsed.values.baseline) throw new Error("Baseline product source changed during its build.");
  const webHash = await hashTree(baselineWeb);
  const binaryHash = createHash("sha256").update(await readFile(baselineServer)).digest("hex");
  const suppliedWebHash = await hashTree(parsed.values["baseline-web"]!);
  const suppliedServerHash = createHash("sha256").update(await readFile(parsed.values["old-server"]!)).digest("hex");
  manifest.baselineArtifacts = { sourceRevision: revision.stdout.trim(), sourceFingerprint: fingerprintAfter, webSHA256: webHash, serverSHA256: binaryHash, goVersion: "go1.27.2", suppliedWebMatches: webHash === suppliedWebHash, suppliedServerMatches: binaryHash === suppliedServerHash };
  await cp(baselineWeb, path.join(artifacts.directory, "web-baseline"), { recursive: true });
  if (await hashTree(path.join(artifacts.directory, "web-baseline")) !== webHash || createHash("sha256").update(await readFile(baselineServer)).digest("hex") !== binaryHash) throw new Error("Baseline artifact changed after its build.");
  await cp(path.join(repository, "packages/daynight-web/dist"), path.join(artifacts.directory, "web-candidate"), { recursive: true });
  if (workerVariant !== undefined) {
    await setPhase('worker-candidate-handoff');
    const reportDirectory = path.dirname(path.resolve(pointer!));
    const candidatePointer = JSON.parse(await readFile(path.join(reportDirectory, 'candidate-run-pointer.json'), 'utf8')) as { runDirectory?: string };
    if (typeof candidatePointer.runDirectory !== 'string' || path.dirname(candidatePointer.runDirectory) !== path.join(repository, '.tmp', 'product-e2e') || !/^[a-f0-9-]{36}$/.test(path.basename(candidatePointer.runDirectory)) || path.resolve(parsed.values['candidate-manifest']!) !== path.join(candidatePointer.runDirectory, 'results', 'manifest.json')) throw new Error('Worker run does not identify the original candidate manifest.');
    const candidateManifest: unknown = JSON.parse(await readFile(parsed.values['candidate-manifest']!, 'utf8'));
    verifyCandidateCombination({ manifest: candidateManifest, candidate: parsed.values['candidate-sha']!, baseline: parsed.values.baseline!, sha256: parsed.values['candidate-artifact-sha256']!, sourceFingerprint: artifacts.sourceFingerprint });
    if (!await verifyCandidateArtifact(parsed.values['candidate-artifact-in']!, parsed.values['candidate-artifact-sha256']!, parsed.values['candidate-sha']!, repository)) throw new Error('Worker candidate artifact does not match the original build.');
    await copyFile(parsed.values['candidate-artifact-in']!, path.join(artifacts.directory, 'daynight-server'));
  }
  if (parsed.values.server === "baseline") await copyFile(baselineServer, path.join(artifacts.directory, "daynight-server"));
  const expectedServerHash = workerVariant !== undefined ? parsed.values['candidate-artifact-sha256'] : parsed.values.server === "baseline" ? binaryHash : artifacts.hashes.server;
  const verifyArtifacts = async (): Promise<void> => {
    const server = createHash("sha256").update(await readFile(path.join(artifacts.directory, "daynight-server"))).digest("hex");
    if (server !== expectedServerHash || await hashTree(path.join(artifacts.directory, "web-baseline")) !== webHash || await hashTree(path.join(artifacts.directory, "web-candidate")) !== artifacts.hashes.web) throw new Error("A selected Server or Web artifact changed after its build.");
  };
  await verifyArtifacts();
  manifest.selectedArtifacts = { server: expectedServerHash, baselineWeb: webHash, candidateWeb: artifacts.hashes.web };
  await copyFile(path.join(artifacts.directory, "runtime/src/subtask-compat-runtime.js"), path.join(artifacts.directory, "runtime/src/runtime.js"));
  const oldCliRoot = path.join(runDirectory, "private", "old-cli");
  await mkdir(oldCliRoot);
  await setPhase("old-cli-install");
  await runCommand("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", oldCliRoot, parsed.values["old-cli"]!], { cwd: repository, signal: cancellation.signal, timeoutMs: 300_000 });
  const oldCliEntry = path.join(oldCliRoot, "node_modules/@codetreker/daynight/dist/main.js");
  const oldCliVersion = await runCommand(process.execPath, [oldCliEntry, "--version"], { cwd: repository, signal: cancellation.signal, timeoutMs: 30_000 });
  if (oldCliVersion.stdout.trim() !== "0.72.0") throw new Error("Installed baseline CLI has the wrong version.");
  const schemas: Record<string, unknown> = {};
  for (const filename of ["task_tools.json", "task_queries.json"]) {
    const read = await runCommand("git", ["show", `${parsed.values.baseline}:packages/daynight-server/internal/server/mcp/${filename}`], { cwd: repository, signal: cancellation.signal, timeoutMs: 30_000, onOutput: () => {} });
    schemas[filename] = JSON.parse(read.stdout);
  }
  await writeFile(path.join(runDirectory, "private", "baseline-mcp.json"), JSON.stringify(schemas));
  const decoder = path.join(artifacts.directory, "image-validator");
  await runCommand(process.execPath, [path.join(repository, "packages/daynight/scripts/package-image-validation.ts"), decoder], {
    cwd: repository, signal: cancellation.signal, timeoutMs: 60_000,
  });
  manifest.decoder = Object.fromEntries(await Promise.all(["image-validation-helper.js", "image-validation-manifest.json"].map(async name => [name, createHash("sha256").update(await readFile(path.join(decoder, name))).digest("hex")])));
  const headBeforeRuntime = await runCommand("git", ["rev-parse", "HEAD"], { cwd: repository, signal: cancellation.signal, timeoutMs: 15_000, onOutput: () => {} });
  if (headBeforeRuntime.stdout.trim() !== parsed.values["candidate-sha"] || await sourceFingerprint(repository, cancellation.signal) !== artifacts.sourceFingerprint || await harnessFingerprint() !== harnessHash) throw new Error("Candidate or compatibility source changed after its build.");
  if (candidateArtifactOut !== undefined) {
    await setPhase("candidate-artifact-handoff");
    await publishCandidateArtifact(path.join(artifacts.directory, "daynight-server"), candidateArtifactOut, artifacts.hashes.server!);
    manifest.candidateHandoff = { path: candidateArtifactOut, sha256: artifacts.hashes.server, sourceRevision: artifacts.sourceRevision };
  }
  assertCommandQuiescence();
  await markBuildComplete(runDirectory);
  buildComplete = true;
  await rm(lockFile);
  ownsLock = false;
  preparingEnvironment = true;
  await writeRunPointer("environment");
  await setPhase("environment-start");
  environment = await startEnvironment({ repository, runDirectory, artifactsDirectory: artifacts.directory, signal: cancellation.signal });
  await verifyArtifacts();
  manifest.resources = environment.resourceIdentity;
  // The returned environment has joined its setup commands. Authentication
  // runs afterwards under the original Playwright gate and browser proofs.
  await completeCompatEnvironmentSetup(runDirectory);
  environmentComplete = true;
  const descriptor = {
    baseURL: environment.baseURL,
    authURL: environment.authURL,
    proxyURL: environment.proxyURL,
    cliEntry: artifacts.cliEntry,
    cliConfigDirectory: path.join(runDirectory, "private", "cli"),
    oldCliEntry,
    oldCliConfigDirectory: path.join(runDirectory, "private", "old-cli-config"),
    serverVersion: parsed.values.server,
    baselineSchema: path.join(runDirectory, "private", "baseline-mcp.json"),
    ...(workerVariant === undefined ? {} : { workerVariant }),
  };
  await mkdir(descriptor.cliConfigDirectory);
  await mkdir(descriptor.oldCliConfigDirectory);
  await writeFile(path.join(descriptor.cliConfigDirectory, "config.yml"), `serverUrl: ${environment.baseURL}\n`, { mode: 0o600 });
  await writeFile(path.join(descriptor.oldCliConfigDirectory, "config.yml"), `serverUrl: ${environment.baseURL}\n`, { mode: 0o600 });
  await writeFile(path.join(runDirectory, "environment.json"), `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
  const resolver = path.join(repository, "packages/e2e_tests/src/resolve-local.cjs");
  const browserOptions = browserCommandOptions(runDirectory);
  const credentialsFile = path.join(runDirectory, "private", "bootstrap-credentials.json");
  const readyFile = path.join(runDirectory, "private", "bootstrap-server-ready");
  await setPhase("authentication");
  manifest.playwrightResults = path.join(runDirectory, "results", "playwright.json");
  playwright = await startCompatPlaywright({ repository, runDirectory, command: process.execPath, args: [path.join(repository, "packages/e2e_tests/src/subtask-compat-session.ts")], options: {
    ...browserOptions,
    env: { ...browserOptions.env, DAYNIGHT_E2E_RUN_DIRECTORY: runDirectory, NODE_EXTRA_CA_CERTS: path.join(artifacts.directory, "daynight-ca.pem"), NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(resolver)}` },
    signal: cancellation.signal,
    timeoutMs: 900_000,
  } });
  const bootstrapWait = new AbortController();
  let credentials: { appId: string; appSecret: string };
  try {
    credentials = await Promise.race([
      waitForCredentials(credentialsFile, AbortSignal.any([cancellation.signal, bootstrapWait.signal])),
      playwright.finished.then(result => { throw new CommandFailure("OAuth bootstrap", result); }),
    ]);
  } finally { bootstrapWait.abort(); }
  await environment.startServer(credentials);
  await rm(credentialsFile);
  await setPhase("playwright");
  await writeFile(readyFile, "ready\n", { flag: "wx", mode: 0o600 });
  const playwrightResult = await playwright.finished;
  if (await harnessFingerprint() !== harnessHash) throw new Error("Compatibility source changed while its scenario was running.");
  if (playwrightResult.exitCode !== 0) throw new CommandFailure("playwright", playwrightResult);
  const name = workerVariant === undefined ? mixedVersionName(parsed.values.server as 'candidate' | 'baseline') : goalWorkerName(workerVariant);
  const result: unknown = JSON.parse(await readFile(path.join(runDirectory, 'results', 'playwright.json'), 'utf8'));
  if (!executedScenario(result, name)) throw new Error('The required compatibility scenario was not executed successfully.');
  manifest.scenarios = [{ name, status: 'passed' }];
  manifest.status = "passed";
} catch (error) {
  failures.push(error);
  manifest.status = "failed";
  const diagnosticCodes = error instanceof CommandFailure ? [...new Set((`${error.result.stdout}\n${error.result.stderr}`).match(/\bERR_[A-Z0-9_]+\b/g) ?? [])].slice(0, 20) : [];
  const systemCode = error instanceof Error && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,60}$/.test(error.code) ? error.code : undefined;
  manifest.failure = { phase, category: error instanceof Error ? error.name : "unknown", ...(systemCode ? { systemCode } : {}), ...(error instanceof CommandFailure ? { exitCode: error.result.exitCode, command: error.message.split("\n", 1)[0], diagnosticCodes } : {}) };
  if (playwright !== undefined) {
    try { await playwright.stop(); }
    catch (stopError) { if (stopError !== error) failures.push(stopError); }
  }
  if (ownsLock && !buildComplete) {
    try { buildComplete = await completeFailedBuild(runDirectory, cancellation.signal.aborted); }
    catch { /* Preserve original resources when the build boundary cannot be recorded. */ }
  }
  if (preparingEnvironment && !environmentComplete) {
    // A returned environment is already joined, and no browser can start until
    // after its completion marker. Interrupted setup without a returned owner
    // still retains its original uncertain resources.
    try { environmentComplete = await settleCompatEnvironmentSetupFailure(runDirectory, environment !== undefined, cancellation.signal.aborted); }
    catch { /* Preserve original resources when setup quiescence is unconfirmed. */ }
  }
} finally {
  if (ownsLock && buildComplete) {
    try { await rm(lockFile); }
    catch (error) { failures.push(error); }
  }
  const cleanup = await finalizeCompatEnvironment({ repository, runDirectory, environment, environmentComplete, preparingEnvironment, buildComplete });
  if (cleanup.receipt !== undefined) { manifest.resources = cleanup.receipt.resourceIdentity; manifest.runtimeCleanup = cleanup.receipt; }
  failures.push(...cleanup.failures);
  if (cleanup.failures.length > 0) manifest.status = "failed";
  manifest.cleanup = { completed: cleanup.completed };
  manifest.finishedAt = new Date().toISOString();
  await writeFile(path.join(runDirectory, "results", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
}
if (failures.length === 1) throw failures[0];
if (failures.length > 1) throw new AggregateError(failures, "Product E2E execution or cleanup failed.");
console.log("Product E2E passed; isolated runtime resources removed.");
