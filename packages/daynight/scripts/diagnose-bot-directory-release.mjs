import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { overlappingCases, waitCompanionReady } from "./bot-directory-context.mjs";
import { beginCapture, serveCapture } from "./bot-directory-capture-gate.mjs";
import { fileURLToPath } from "node:url";

const repository = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const fixturePath = "packages/daynight/test/commands/worker/bot-process-integration.test.ts";
const companionPath = "packages/daynight/test/cli/task.test.ts";
const profile = process.env.BOT_DIRECTORY_DIAGNOSTIC_PROFILE;
const scripts = path.join(repository, "packages/daynight/scripts");
const native = path.join(scripts, "bot-directory-etw.mjs"), filter = path.join(scripts, "filter-bot-directory-etw.py");
const output = path.resolve(process.env.BOT_DIRECTORY_DIAGNOSTIC_OUTPUT);
if (!output.startsWith(path.join(repository, ".tmp") + path.sep)) throw new Error("Diagnostic output must remain in this checkout's .tmp.");
const privateDirectory = path.join(output, "private"), results = path.join(output, "results");
const receiptPath = path.join(output, "session.json");
const systemTool = name => path.join(process.env.SystemRoot, "System32", `${name}.exe`);
const hash = data => createHash("sha256").update(data).digest("hex");
const describe = (error, depth = 0) => ({ name: error.name, message: error.message, code: error.code, pid: error.pid, completionConfirmed: error.completionConfirmed, ...(depth < 4 && error.cause instanceof Error ? { cause: describe(error.cause, depth + 1) } : {}) });
const save = async (filename, value) => await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
if (process.platform !== "win32") throw new Error("Bot directory reproduction requires native Windows.");
await mkdir(privateDirectory, { recursive: true });
await mkdir(results, { recursive: true });

const cancellation = new AbortController();
const active = new Set();
let ownedExecutionUnconfirmed = false;
const cancel = signal => {
  const failure = new Error(`Bot directory diagnosis interrupted by ${signal}.`);
  cancellation.abort(failure);
  for (const stop of active) stop(failure);
};
process.once("SIGINT", () => cancel("SIGINT"));
process.once("SIGTERM", () => cancel("SIGTERM"));

const command = async (file, args, { timeoutMs = 30_000, stream = false, environment = process.env, ownedTree = false, ignoreCancellation = false } = {}) => {
  if (!ignoreCancellation) cancellation.signal.throwIfAborted();
  const api = ownedTree ? await (await import("../dist/platform/windows-job.js")).loadWindowsJobKernel() : null;
  const ownership = api === null ? null : { name: `Local\\Daynight-Bot-Directory-${randomUUID()}`, pid: null, stopped: false };
  if (ownership !== null) { receipt.jobs.push(ownership); await persist(); }
  const job = api === null ? null : api.create(ownership.name);
  try { if (api !== null) api.killOnClose(job); }
  catch (error) { try { api.close(job); } catch (cleanup) { throw new AggregateError([error, cleanup], "Diagnostic Job configuration and release failed.", { cause: error }); } throw error; }
  const recordForcedStop = reason => {
    const observation = { at: new Date().toISOString(), reason, members: api.inspect(job), active: api.active(job) };
    ownership.forcedTermination = true;
    ownership.stopObservation = observation;
    appendFileSync(path.join(results, "forced-stops.jsonl"), `${JSON.stringify({ job: ownership.name, ...observation })}\n`);
    api.terminate(job);
  };
  const releaseJob = async () => {
    if (api === null) return;
    if (api.active(job) !== 0 || api.inspect(job).length !== 0) recordForcedStop("members-remained-after-root-close");
    const deadline = Date.now() + 5000;
    while (api.active(job) !== 0 || api.inspect(job).length !== 0) {
      if (Date.now() >= deadline) throw new Error("The owned diagnostic Job did not become empty.");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    api.close(job);
    ownership.stopped = true;
    await persist();
  };
  if (!ignoreCancellation && cancellation.signal.aborted) { await releaseJob(); cancellation.signal.throwIfAborted(); }
  return await new Promise((resolve, reject) => {
    const launchArgs = ownedTree ? [path.join(scripts, "bot-directory-vitest-child.mjs"), ...args] : args;
    const child = spawn(file, launchArgs, { cwd: ownedTree ? path.join(repository, "packages/daynight") : repository, env: { ...environment, PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["ignore", "pipe", "pipe", ...(ownedTree ? ["ipc"] : [])], windowsHide: true });
    const chunks = { stdout: [], stderr: [] }, bytes = { stdout: 0, stderr: 0 };
    let failure, timer, joinTimer, settled = false;
    const stop = error => {
      if (failure !== undefined) return;
      failure = error;
      try { if (api !== null) recordForcedStop(error.message); } catch (cleanup) { failure = new AggregateError([error, cleanup], "Diagnostic cancellation and Job termination failed.", { cause: error }); }
      child.kill("SIGKILL");
      joinTimer = setTimeout(async () => {
        if (settled) return;
        settled = true; clearTimeout(timer); active.delete(stop);
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        try { await releaseJob(); } catch (cleanup) { ownedExecutionUnconfirmed ||= ownedTree; failure = new AggregateError([failure, cleanup], "Diagnostic termination remains unconfirmed.", { cause: failure }); }
        reject(Object.assign(new Error("Owned diagnostic command did not close after termination.", { cause: failure }), { pid: child.pid, completionConfirmed: false }));
      }, 5000);
    };
    active.add(stop);
    if (ownedTree) child.once("message", async message => {
      try {
        if (message !== "ready" || child.pid === undefined) throw new Error("Diagnostic launcher did not establish its identity.");
        api.assign(job, child.pid);
        ownership.pid = child.pid;
        await persist();
        if (failure !== undefined || !ignoreCancellation && cancellation.signal.aborted) { stop(cancellation.signal.reason); return; }
        child.send("start", error => { if (error) stop(error); });
      } catch (error) { stop(error); }
    });
    for (const channel of ["stdout", "stderr"]) child[channel].on("data", value => {
      bytes[channel] += value.length;
      if (bytes[channel] <= 1024 * 1024) chunks[channel].push(value);
      else if (failure === undefined) stop(new Error(`Diagnostic ${channel} exceeded 1 MiB.`));
      if (stream) process[channel].write(value);
    });
    child.once("error", error => { stop(error); });
    timer = setTimeout(() => stop(new Error(`Diagnostic command ${path.basename(file)} exceeded ${timeoutMs} ms.`)), timeoutMs);
    child.once("close", async (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(joinTimer); active.delete(stop);
      try { await releaseJob(); } catch (cleanup) { ownedExecutionUnconfirmed ||= ownedTree; failure = failure === undefined ? cleanup : new AggregateError([failure, cleanup], "Diagnostic command and descendant cleanup failed.", { cause: failure }); }
      const result = { code, signal, stdout: Buffer.concat(chunks.stdout), stderr: Buffer.concat(chunks.stderr), forcedTermination: ownership?.forcedTermination === true, descendantsStopped: ownership?.stopped };
      if (failure !== undefined) reject(Object.assign(failure, { result })); else resolve(result);
    });
  });
};

const must = async (file, args, options) => {
  const result = await command(file, args, options);
  if (result.code !== 0 || result.signal !== null) throw new Error(`${path.basename(file)} failed (exit=${result.code}, signal=${result.signal}): ${result.stderr.toString("utf8").slice(-4096)}`);
  return result.stdout;
};
const git = async (args, options) => (await must("git.exe", args, options)).toString("utf8").trim();
const fixture = path.join(repository, fixturePath), backup = path.join(privateDirectory, "fixture-backup.bin");
let receipt;
let receiptWrites = Promise.resolve();
const persist = async () => {
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  const write = async () => {
    const temporary = `${receiptPath}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, bytes, { flag: "wx" }); await rename(temporary, receiptPath); }
    finally { await rm(temporary, { force: true }); }
  };
  const current = receiptWrites.then(write, write);
  receiptWrites = current;
  await current;
};
const restore = async () => {
  if (receipt?.fixture === undefined || receipt.fixture.restored) return;
  if (ownedExecutionUnconfirmed || receipt.jobs.some(job => !job.stopped)) throw new Error("Original fixture is retained until all diagnostic descendants are confirmed stopped.");
  const bytes = await readFile(backup);
  if (hash(bytes) !== receipt.fixture.savedSha256) throw new Error("The saved Bot fixture bytes failed verification.");
  await writeFile(fixture, bytes);
  await chmod(fixture, receipt.fixture.mode & 0o777);
  if (hash(await readFile(fixture)) !== receipt.fixture.savedSha256) throw new Error("The original working-tree fixture bytes were not restored.");
  if (((await stat(fixture)).mode & 0o777) !== (receipt.fixture.mode & 0o777)) throw new Error("The original working-tree fixture mode was not restored.");
  if (await git(["status", "--porcelain", "--", fixturePath], { ignoreCancellation: true }) !== receipt.fixture.initialStatus) throw new Error("The restored Bot fixture changed Git status.");
  receipt.fixture.restored = true;
  await persist();
};
const stopSession = async () => {
  if (receipt?.session === undefined || receipt.session.stopped) return null;
  if (receipt.session.state === "pending") { receipt.session.stopped = true; receipt.session.notStarted = true; await persist(); return null; }
  const session = receipt.session.name;
  if (!/^daynight-bot-directory-[0-9a-f-]{36}$/.test(session)) throw new Error("Refusing an unknown ETW session identity.");
  try {
    const value = JSON.parse((await must(process.execPath, [native, "stop", session], { timeoutMs: 10_000, ignoreCancellation: true })).toString("utf8"));
    receipt.session.stopped = true;
    await persist();
    return value;
  } catch (error) {
    const result = await command(systemTool("logman"), ["stop", session, "-ets"], { timeoutMs: 10_000, ignoreCancellation: true });
    receipt.session.fallbackStop = { code: result.code, signal: result.signal };
    receipt.session.stopped = result.code === 0;
    await persist();
    throw error;
  }
};
if (process.argv[2] === "--cleanup") {
  try { receipt = JSON.parse(await readFile(receiptPath, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    if ((await readdir(privateDirectory)).length !== 0) throw new Error("The diagnostic receipt is missing; private evidence is retained.");
    process.exit(0);
  }
  const errors = [];
  try { await stopSession(); } catch (error) { errors.push(error); }
  for (const job of receipt.jobs) if (!job.stopped) {
    try {
      await must(process.execPath, [native, "stop-job", job.name], { timeoutMs: 10_000, ignoreCancellation: true });
      job.stopped = true; await persist();
    } catch (error) { errors.push(error); }
  }
  try { await restore(); } catch (error) { errors.push(error); }
  await save(path.join(results, "cleanup.json"), { fixtureRestored: receipt.fixture.restored, jobs: receipt.jobs, session: receipt.session, errors: errors.map(error => describe(error)) });
  if (receipt.fixture.restored && receipt.jobs.every(job => job.stopped)) await rm(privateDirectory, { recursive: true, force: true });
  if (errors.length !== 0) throw new AggregateError(errors, "Independent diagnostic cleanup failed.");
  process.exit(0);
}

const base = process.env.BOT_FIXTURE_BASE_SHA;
const expectedHead = process.env.BOT_DIRECTORY_DIAGNOSTIC_HEAD;
const sourceKind = process.env.BOT_DIRECTORY_DIAGNOSTIC_SOURCE_KIND;
if (!/^[0-9a-f]{40}$/.test(base)) throw new Error("An exact PR base SHA is required.");
const productionPaths = [
  "packages/daynight/src/commands/worker/backends/controller-process.ts",
  "packages/daynight/src/commands/worker/bots/process.ts",
  "packages/daynight/src/commands/controller/runtime.ts",
  "packages/daynight/src/commands/controller/process-proof.ts",
  "packages/daynight/src/commands/controller/windows-process-proof.ts",
  "packages/daynight/src/commands/controller/windows-job.ts",
  "packages/daynight/src/commands/controller/providers/codex.ts",
  "packages/daynight/src/commands/controller/launch-ticket.ts",
  "packages/daynight/src/platform/windows-job.ts",
];
const head = await git(["rev-parse", "HEAD"]), initialStatus = await git(["status", "--porcelain"]);
if (initialStatus !== "") throw new Error("Diagnostic source must be clean before the original-fixture control.");
const before = await readFile(fixture), metadata = await stat(fixture);
await writeFile(backup, before, { flag: "wx" });
receipt = { head, base, initialStatus, profile, context: { sourceKind, expectedHead, githubSha: process.env.GITHUB_SHA ?? null,
  node: process.version, platform: process.platform, architecture: process.arch, osRelease: os.release(),
  runnerOs: process.env.RUNNER_OS ?? null, runnerArchitecture: process.env.RUNNER_ARCH ?? null,
  imageOs: process.env.ImageOS ?? null, imageVersion: process.env.ImageVersion ?? null }, fixture: { path: fixturePath, savedSha256: hash(before), mode: metadata.mode, initialStatus: await git(["status", "--porcelain", "--", fixturePath]), restored: false }, jobs: [], rounds: [] };
await persist();
receipt.fixture.baseBlob = await git(["rev-parse", `${base}:${fixturePath}`]);
receipt.fixture.headBlob = await git(["rev-parse", `HEAD:${fixturePath}`]);
receipt.production = {};
for (const name of productionPaths) receipt.production[name] = { base: await git(["rev-parse", `${base}:${name}`]), head: await git(["rev-parse", `HEAD:${name}`]) };
await persist();
receipt.sourceTree = { base: await git(["rev-parse", `${base}:packages/daynight/src`]), head: await git(["rev-parse", "HEAD:packages/daynight/src"]) };
await save(path.join(results, "source.json"), receipt);
const normalInputScopes = ["packages/daynight/test", "packages/daynight/vitest*.config.ts", "packages/daynight/scripts/test-bootstrap.ts", "packages/daynight/scripts/test-isolation.cts", "packages/daynight/scripts/test-isolation.regression.mjs", "packages/daynight/tsconfig*.json", "packages/daynight/package.json", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "patches", ".github/workflows/checks.yml"];
const normalDiff = await git(["diff", "--name-status", base, "HEAD", "--", ...normalInputScopes]);
receipt.normalSuiteInputs = { testTree: { base: await git(["rev-parse", `${base}:packages/daynight/test`]), head: await git(["rev-parse", "HEAD:packages/daynight/test"]) }, differences: normalDiff === "" ? [] : normalDiff.split(/\r?\n/).map(line => { const [status, ...names] = line.split("\t"); return { status, names }; }) };
receipt.companion = { path: companionPath, baseBlob: await git(["rev-parse", `${base}:${companionPath}`]), headBlob: await git(["rev-parse", `HEAD:${companionPath}`]) };
await persist();
await save(path.join(results, "source.json"), receipt);
let aliases;
const vitest = path.join(repository, "packages/daynight/node_modules/vitest/vitest.mjs");
const prefix = "fixture teardown isolation|joins the final process observation|launches one real Controller with no user turn after unknown parent observation=(false|true), then observes the same writer after browser disconnect";
const fullSuiteProfile = profile === "full-normal-cli-context";
const started = Date.now(), overallMs = (fullSuiteProfile ? 18 : 12) * 60_000, roundBudgetMs = (fullSuiteProfile ? 16 : 9) * 60_000;

const readCases = async filename => (await readFile(filename, "utf8")).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const commandReceipt = result => ({ code: result.code, signal: result.signal, forcedTermination: result.forcedTermination, descendantsStopped: result.descendantsStopped });
const vitestArguments = (args, folder, label, bail = true) => [vitest, "run", ...args, ...(bail ? ["--bail=1"] : []), "--reporter=default", "--reporter=json", `--reporter=${path.join(scripts, "bot-directory-case-reporter.mjs")}`, `--outputFile=${path.join(folder, `${label}-vitest.json`)}`];

const capture = async (name, args, targetBase) => {
  const folder = path.join(privateDirectory, name), resultDirectory = path.join(results, name);
  await mkdir(folder); await mkdir(resultDirectory);
  const etl = path.join(folder, "events.etl"), xml = path.join(folder, "events.xml");
  const markers = { begin: path.join(folder, "capture-begin"), end: path.join(folder, "capture-end") };
  const fullSuite = name === "full-suite";
  receipt.session = { name: `daynight-bot-directory-${randomUUID()}`, stopped: false, state: fullSuite ? "pending" : "starting", requestedAt: new Date().toISOString() };
  await persist();
  const phase = { name, startedAt: new Date().toISOString(), errors: [], command: null, statistics: null, complete: false };
  const contextual = name !== "control" && profile === "original-prefix-with-task-cli";
  let companionCompletion, gate, windowTimer, captureStop;
  const endWindow = async explicit => {
    clearTimeout(windowTimer);
    captureStop ??= (async () => {
      if (explicit) await writeFile(markers.end, "end\n");
      phase.statistics = await stopSession(); phase.captureStoppedAt = new Date().toISOString();
    })();
    await captureStop;
    if (explicit && phase.captureDeadlineExceeded) throw new Error("The original Bot capture boundary arrived after the diagnostic window.");
  };
  const begin = async () => {
    receipt.session.state = "starting";
    await persist();
    await must(systemTool("logman"), ["create", "trace", receipt.session.name, "-ets", "-pf", path.join(privateDirectory, "providers.txt"), "-f", "bin", "-max", "64", "-bs", "64", "-nb", "16", "128", "-o", etl]);
    phase.traceStartedAt = new Date().toISOString();
    if (fullSuite) windowTimer = setTimeout(() => {
      phase.captureDeadlineExceeded = true;
      phase.errors.push({ name: "CaptureWindowError", message: "The original Bot end boundary was not observed within twenty seconds; the normal suite continues." });
      void endWindow(false).catch(error => phase.errors.push(describe(error)));
    }, 20_000);
    const initialThreads = JSON.parse((await must(process.execPath, [native, "threads"], { timeoutMs: 10_000 })).toString("utf8"));
    await save(path.join(folder, "initial-threads.json"), initialThreads);
    await writeFile(markers.begin, "begin\n");
    phase.captureStartedAt = new Date().toISOString();
  };
  try {
    if (fullSuite) gate = serveCapture(folder, path.join(repository, fixturePath), {
      start: async () => { await beginCapture(begin, () => endWindow(false)); },
      end: async () => { await endWindow(true); },
    });
    else await begin();
    if (contextual) {
      phase.companion = { ready: null, command: null, tests: [], overlaps: [], overlapConfirmed: false };
      companionCompletion = command(process.execPath, vitestArguments(["test/cli/task.test.ts"], folder, "companion"), {
        timeoutMs: roundBudgetMs, stream: true, ownedTree: true,
        environment: { ...process.env, BOT_DIRECTORY_CASE_REPORT: path.join(folder, "companion-cases.jsonl"), BOT_DIRECTORY_CASE_READY_REPORT: path.join(folder, "companion-ready.json") },
      }).then(result => ({ result }), error => ({ result: error.result, error }));
      phase.companion.ready = await waitCompanionReady(path.join(folder, "companion-ready.json"), companionCompletion, path.join(repository, companionPath));
    }
    const commandResult = await command(process.execPath, vitestArguments(args, folder, "original", !fullSuite), { timeoutMs: name === "control" ? 9 * 60_000 : roundBudgetMs, stream: true, ownedTree: true, environment: { ...process.env, BOT_DIRECTORY_CASE_REPORT: path.join(folder, "cases.jsonl"), ...(fullSuite ? { BOT_DIRECTORY_CAPTURE_GATE: folder, BOT_DIRECTORY_CAPTURE_MODULE: path.join(repository, fixturePath), BOT_DIRECTORY_CASE_MODULES: JSON.stringify([path.join(repository, fixturePath), path.join(repository, companionPath)]) } : {}) } });
    phase.command = commandReceipt(commandResult);
    await writeFile(path.join(folder, "stdout.log"), commandResult.stdout);
    await writeFile(path.join(folder, "stderr.log"), commandResult.stderr);
    if (!fullSuite) await writeFile(markers.end, "end\n");
  } catch (error) {
    phase.errors.push(describe(error));
    if (error.result !== undefined) {
      phase.command = commandReceipt(error.result);
      try {
        await writeFile(path.join(folder, "stdout.log"), error.result.stdout);
        await writeFile(path.join(folder, "stderr.log"), error.result.stderr);
        if (!fullSuite && !ownedExecutionUnconfirmed) await writeFile(markers.end, "end\n");
      } catch (saveError) { phase.errors.push(describe(saveError)); }
    }
  }
  finally {
    clearTimeout(windowTimer);
    if (gate !== undefined) {
      phase.gate = await gate.close();
      phase.errors.push(...phase.gate.errors);
      try { phase.gate.workerErrors = (await readFile(path.join(folder, "worker-errors.jsonl"), "utf8")).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); phase.errors.push(...phase.gate.workerErrors); }
      catch (error) { if (error.code !== "ENOENT") phase.errors.push(describe(error)); }
    }
    if (captureStop !== undefined) try { await captureStop; } catch (error) { phase.errors.push(describe(error)); }
    if (phase.statistics === null) try { phase.statistics = await stopSession(); } catch (error) { phase.errors.push(describe(error)); }
    if (companionCompletion !== undefined) try {
      const outcome = await companionCompletion;
      if (outcome.error !== undefined) phase.errors.push(describe(outcome.error));
      if (outcome.result !== undefined) {
        phase.companion.command = commandReceipt(outcome.result);
        await writeFile(path.join(folder, "companion-stdout.log"), outcome.result.stdout);
        await writeFile(path.join(folder, "companion-stderr.log"), outcome.result.stderr);
      }
      try { phase.companion.tests = await readCases(path.join(folder, "companion-cases.jsonl")); }
      catch (error) { phase.errors.push(describe(error)); }
      await save(path.join(resultDirectory, "companion.json"), phase.companion);
    } catch (error) { phase.errors.push(describe(error)); }
  }
  // Test outcomes remain available even if ETW conversion or final suite JSON fails.
  try {
    phase.tests = await readCases(path.join(folder, "cases.jsonl"));
    if (fullSuite) {
      phase.observedTests = phase.tests;
      phase.tests = phase.tests.filter(test => path.normalize(test.moduleId) === path.normalize(path.join(repository, fixturePath)) && new RegExp(prefix).test(test.name));
      phase.originalCaseStatus = phase.tests.find(test => test.name.includes("unknown parent observation=true, then observes the same writer after browser disconnect"))?.status ?? null;
    }
    if (contextual) {
      const originalCase = phase.tests.find(test => test.name.includes("unknown parent observation=true, then observes the same writer after browser disconnect"));
      if (originalCase !== undefined) {
        phase.companion.overlaps = overlappingCases(originalCase, phase.companion.tests, path.join(repository, companionPath));
      }
      phase.companion.overlapConfirmed = phase.companion.overlaps.length !== 0;
      await save(path.join(resultDirectory, "companion.json"), phase.companion);
    }
    await save(path.join(resultDirectory, "tests.json"), phase.tests);
  } catch (error) { phase.errors.push(describe(error)); }
  try {
    const vitestResult = JSON.parse(await readFile(path.join(folder, "original-vitest.json"), "utf8"));
    if (fullSuite) {
      phase.suite = { total: vitestResult.numTotalTests, passed: vitestResult.numPassedTests, failed: vitestResult.numFailedTests, pending: vitestResult.numPendingTests, modules: vitestResult.testResults.length,
        failures: vitestResult.testResults.flatMap(file => file.assertionResults.filter(test => test.status === "failed").map(test => ({ moduleId: file.name, name: test.fullName }))) };
    }
    phase.failedTargets = vitestResult.testResults.flatMap(file => file.assertionResults).flatMap(test => test.failureMessages).flatMap(message => [...message.matchAll(/EBUSY[^\n]*?rmdir '([^']+)'/g)].map(match => match[1])).filter(target => {
      const relative = path.win32.relative(targetBase, target);
      return /^h-[A-Za-z0-9_-]+\\ordinary$/i.test(relative);
    });
  } catch (error) { phase.errors.push(describe(error)); }
  try {
    const info = await stat(etl);
    phase.etlBytes = info.size;
    await must(systemTool("tracerpt"), [etl, "-o", xml, "-of", "XML", "-summary", path.join(folder, "summary.txt"), "-y"], { timeoutMs: 60_000 });
    if (name === "control") {
      const observedSchema = path.join(resultDirectory, "observed-schema.json");
      await must("python.exe", [filter, "--validate-control-events", xml, "--file-schema", path.join(results, "file-schema.json"), "--thread-schema", path.join(results, "thread-schema.json"), "--output", observedSchema]);
      phase.decodedSchema = JSON.parse(await readFile(observedSchema, "utf8"));
    }
    const request = { aliases, targetBases: [targetBase], markers, initialThreads: JSON.parse(await readFile(path.join(folder, "initial-threads.json"), "utf8")), caseWindows: phase.tests, failedTargets: phase.failedTargets };
    await save(path.join(folder, "filter-request.json"), request);
    await must("python.exe", [filter, "--events", xml, "--request", path.join(folder, "filter-request.json"), "--output", path.join(resultDirectory, "events.json")], { timeoutMs: 30_000 });
    const filtered = JSON.parse(await readFile(path.join(resultDirectory, "events.json"), "utf8"));
    phase.expectedCaseCount = name === "control" ? 1 : 5;
    phase.caseCountValid = Array.isArray(phase.tests) && phase.tests.length === phase.expectedCaseCount && phase.tests.every(test => path.normalize(test.moduleId) === path.normalize(path.join(repository, fullSuite ? fixturePath : path.join("packages/daynight", args[0]))));
    phase.complete = (!fullSuite || phase.gate?.startSeen && phase.gate.endSeen) && (!contextual || phase.companion.overlapConfirmed && phase.companion.command?.code === 0 && phase.companion.command.signal === null && phase.companion.command.descendantsStopped === true && phase.companion.command.forcedTermination === false) && (name !== "control" || phase.decodedSchema?.valid === true) && phase.caseCountValid && phase.command?.descendantsStopped === true && phase.command.forcedTermination === false && phase.errors.length === 0 && phase.statistics !== null && phase.statistics.eventsLost === 0 && phase.statistics.logBuffersLost === 0 && phase.statistics.realTimeBuffersLost === 0
      && info.size < 64 * 1024 * 1024 && filtered.coverage.begin.seen && filtered.coverage.end.seen && filtered.ordering.complete;
    return { phase, filtered, stdout: await readFile(path.join(folder, "stdout.log"), "utf8") };
  } catch (error) { phase.errors.push(describe(error)); return { phase, filtered: null, stdout: "" }; }
  finally { phase.finishedAt = new Date().toISOString(); await save(path.join(resultDirectory, "result.json"), phase); if (!ownedExecutionUnconfirmed) await rm(folder, { recursive: true, force: true }); }
};

let exitCode = 0;
const errors = [];
try {
  if (!["original-prefix", "original-prefix-with-task-cli", "full-normal-cli-context"].includes(profile)) throw new Error("An explicit original-fixture diagnostic profile is required.");
  if (profile === "original-prefix-with-task-cli" && receipt.companion.baseBlob !== receipt.companion.headBlob) throw new Error("The Task CLI companion does not match the selected original source.");
  if (fullSuiteProfile) {
    const allowed = new Map([[fixturePath, "M"], ["packages/daynight/test/commands/worker/bot-process-directory-lock.windows.test.ts", "A"], ["packages/daynight/test/commands/worker/fixtures/windows-directory-handles.mjs", "A"], ["packages/daynight/test/commands/worker/windows-directory-handles.fixtures.ts", "A"], ["packages/daynight/vitest.bot-directory-diagnostic.config.ts", "A"]]);
    if (receipt.normalSuiteInputs.differences.some(change => change.names.length !== 1 || allowed.get(change.names[0]) !== change.status)) throw new Error("The normal suite has test/config/bootstrap/lock changes outside the exact diagnostic controls.");
  }
  if (sourceKind !== "pull-request-head" || !/^[0-9a-f]{40}$/.test(expectedHead)) throw new Error("An exact diagnostic PR-head source identity is required.");
  if (head !== expectedHead) throw new Error("The diagnostic checkout does not match the selected PR head.");
  if (receipt.sourceTree.base !== receipt.sourceTree.head) throw new Error("Diagnostic production sources differ from the selected base.");
  aliases = JSON.parse((await must(process.execPath, [native, "aliases", repository], { timeoutMs: 10_000 })).toString("utf8"));
  for (const [label, provider] of [["file", "Microsoft-Windows-Kernel-File"], ["thread", "Microsoft-Windows-Kernel-Process"]]) {
    const manifest = path.join(results, `${label}-provider-manifest.xml`);
    await writeFile(manifest, await must(systemTool("wevtutil"), ["gp", provider, "/ge:true", "/gm:true", "/f:xml"]));
    const schemaFile = path.join(results, `${label}-schema.json`);
    await must("python.exe", [filter, "--manifest", manifest, "--output", schemaFile]);
    const schema = JSON.parse(await readFile(schemaFile, "utf8"));
    if (schema.descriptorsValid !== true) throw new Error(`The ${label} ETW provider descriptors are unsupported: ${JSON.stringify(schema.descriptorErrors).slice(0, 2048)}`);
  }
  await writeFile(path.join(privateDirectory, "providers.txt"), "{edd08927-9cc4-4e65-b970-c2560fb5c289} 0x4f0 5\n{22fb2cd6-0e7b-422b-a0c7-2fad1fd0e716} 0x20 5\n");
  const control = await capture("control", ["test/commands/worker/bot-process-directory-lock.windows.test.ts"], path.join(repository, ".tmp/bot-directory-lock"));
  const line = control.stdout.split(/\r?\n/).map(value => value.slice(value.indexOf('{"fixture":"windows-directory-lock"'))).find(value => value.startsWith('{"fixture":"windows-directory-lock"'));
  const known = line === undefined ? null : JSON.parse(line);
  const events = control.filtered?.events ?? [];
  const pointer = value => { try { const parsed = BigInt(value); return parsed > 0n ? parsed.toString(16) : null; } catch { return null; } };
  const create = events.find(event => event.providerGuid === "edd08927-9cc4-4e65-b970-c2560fb5c289" && event.eventId === 12 && event.attributedPid === known?.holderPid && Number(event.fields.ShareAccess) === 3 && pointer(event.fields.FileObject) !== null);
  const related = [];
  let lifetimeUnambiguous = true, denialWindowEnd = events.length;
  if (create !== undefined) for (const event of events.slice(events.indexOf(create) + 1)) {
    if (pointer(event.fields.FileObject) !== pointer(create.fields.FileObject)) continue;
    if (event.eventId === 12) { lifetimeUnambiguous = false; denialWindowEnd = events.indexOf(event); break; }
    related.push(event);
    if (denialWindowEnd === events.length && (event.eventId === 13 || event.eventId === 14)) denialWindowEnd = events.indexOf(event);
    if (event.eventId === 14) break;
  }
  const sharingViolationsSeen = create === undefined ? 0 : events.slice(events.indexOf(create) + 1, denialWindowEnd).filter(event => event.providerGuid === create.providerGuid && event.target === create.target && event.eventId === 24 && Number(event.fields.Status ?? event.fields.NtStatus) === 0xc0000043).length;
  const validation = { sharingViolationsSeen, knownHolder: known, create: create ?? null, cleanupSeen: related.some(event => event.eventId === 13), closeSeen: related.some(event => event.eventId === 14), lifetimeUnambiguous, complete: control.phase.complete, decodedSchemaValid: control.phase.decodedSchema?.valid === true };
  await save(path.join(results, "control-validation.json"), validation);
  if (sharingViolationsSeen < 2 || control.phase.command?.code !== 0 || !known?.blockedBeforeTrace || !known?.blockedAfterTrace || !known?.removedAfterRelease || create === undefined || !validation.cleanupSeen || !validation.closeSeen || !validation.lifetimeUnambiguous || !validation.complete) throw new Error("Native ETW control did not establish the known holder's sharing and lifetime; original-case attribution is not admitted.");
  const original = await must("git.exe", ["show", `${base}:${fixturePath}`]);
  await writeFile(fixture, original);
  receipt.fixture.replacementSha256 = hash(original);
  receipt.fixture.controlBlob = await git(["hash-object", "--no-filters", fixturePath]);
  if (receipt.fixture.controlBlob !== receipt.fixture.baseBlob) throw new Error("The original fixture control did not match its selected Git blob.");
  receipt.fixture.intentionalDirtyStatus = await git(["status", "--porcelain", "--", fixturePath]);
  await persist();
  const maximumRounds = fullSuiteProfile ? 1 : profile === "original-prefix-with-task-cli" ? 2 : 5;
  for (let index = 0; index < maximumRounds; index++) {
    if (overallMs - (Date.now() - started) < roundBudgetMs + 60_000) { receipt.stopReason = "cleanup-reserve"; break; }
    const result = await capture(fullSuiteProfile ? "full-suite" : `round-${index + 1}`, fullSuiteProfile ? ["--config", path.join(repository, "packages/daynight/vitest.bot-directory-diagnostic.config.ts")] : ["test/commands/worker/bot-process-integration.test.ts", "-t", prefix], path.join(repository, ".tmp/bot-process-integration"));
    receipt.rounds.push(result.phase);
    await persist();
    if (result.phase.command === null) { exitCode = 1; receipt.stopReason = "original-case-not-run"; break; }
    if (result.phase.command.code !== 0 || result.phase.command.signal !== null) { exitCode = result.phase.command.code || 1; receipt.stopReason = !fullSuiteProfile || result.phase.originalCaseStatus === "failed" ? "original-case-failure" : result.phase.originalCaseStatus === "passed" ? "normal-suite-failure" : "suite-failure-without-original-case-result"; break; }
    if (result.phase.companion !== undefined && (result.phase.companion.command?.code !== 0 || result.phase.companion.command.signal !== null)) { exitCode = result.phase.companion.command?.code || 1; receipt.stopReason = "companion-failure"; break; }
    if (!result.phase.complete) { exitCode = 1; receipt.stopReason = "incomplete-capture"; break; }
  }
  if (receipt.rounds.length === 0) throw new Error("No original-prefix round ran within the cleanup reserve; diagnostic evidence is incomplete.");
} catch (error) { errors.push(describe(error)); exitCode = 1; }
finally {
  try { await stopSession(); } catch (error) { errors.push(describe(error)); }
  try { await restore(); } catch (error) { errors.push(describe(error)); }
  if (cancellation.signal.aborted) { errors.push(describe(cancellation.signal.reason)); if (exitCode === 0) exitCode = 130; }
  receipt.errors = errors;
  receipt.exitCode = exitCode || (errors.length === 0 ? 0 : 1);
  receipt.finishedAt = new Date().toISOString();
  await persist();
  await save(path.join(results, "result.json"), receipt);
  if (receipt.fixture.restored && !ownedExecutionUnconfirmed && receipt.jobs.every(job => job.stopped)) await rm(privateDirectory, { recursive: true, force: true });
}
process.exitCode = receipt.exitCode;
