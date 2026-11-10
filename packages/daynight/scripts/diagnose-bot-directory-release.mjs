import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const fixturePath = "packages/daynight/test/commands/worker/bot-process-integration.test.ts";
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
receipt = { head, base, initialStatus, fixture: { path: fixturePath, savedSha256: hash(before), mode: metadata.mode, initialStatus: await git(["status", "--porcelain", "--", fixturePath]), restored: false }, jobs: [], rounds: [] };
await persist();
receipt.fixture.baseBlob = await git(["rev-parse", `${base}:${fixturePath}`]);
receipt.fixture.headBlob = await git(["rev-parse", `HEAD:${fixturePath}`]);
receipt.production = {};
for (const name of productionPaths) receipt.production[name] = { base: await git(["rev-parse", `${base}:${name}`]), head: await git(["rev-parse", `HEAD:${name}`]) };
await persist();
receipt.sourceTree = { base: await git(["rev-parse", `${base}:packages/daynight/src`]), head: await git(["rev-parse", "HEAD:packages/daynight/src"]) };
if (receipt.sourceTree.base !== receipt.sourceTree.head) throw new Error("Diagnostic production sources differ from the selected base.");
await save(path.join(results, "source.json"), receipt);
let aliases;
const vitest = path.join(repository, "packages/daynight/node_modules/vitest/vitest.mjs");
const prefix = "fixture teardown isolation|joins the final process observation|launches one real Controller with no user turn after unknown parent observation=(false|true), then observes the same writer after browser disconnect";
const started = Date.now(), overallMs = 12 * 60_000, roundBudgetMs = 9 * 60_000;

const capture = async (name, args, targetBase) => {
  const folder = path.join(privateDirectory, name), resultDirectory = path.join(results, name);
  await mkdir(folder); await mkdir(resultDirectory);
  const etl = path.join(folder, "events.etl"), xml = path.join(folder, "events.xml");
  const markers = { begin: path.join(folder, "capture-begin"), end: path.join(folder, "capture-end") };
  receipt.session = { name: `daynight-bot-directory-${randomUUID()}`, stopped: false, requestedAt: new Date().toISOString() };
  await persist();
  const phase = { name, startedAt: new Date().toISOString(), errors: [], command: null, statistics: null, complete: false };
  try {
    await must(systemTool("logman"), ["create", "trace", receipt.session.name, "-ets", "-pf", path.join(privateDirectory, "providers.txt"), "-f", "bin", "-max", "64", "-bs", "64", "-nb", "16", "128", "-o", etl]);
    const initialThreads = JSON.parse((await must(process.execPath, [native, "threads"], { timeoutMs: 10_000 })).toString("utf8"));
    await save(path.join(folder, "initial-threads.json"), initialThreads);
    await writeFile(markers.begin, "begin\n");
    const commandResult = await command(process.execPath, [vitest, "run", ...args, "--bail=1", "--reporter=default", "--reporter=json", `--reporter=${path.join(scripts, "bot-directory-case-reporter.mjs")}`, `--outputFile=${path.join(folder, "vitest.json")}`], { timeoutMs: roundBudgetMs, stream: true, ownedTree: true, environment: { ...process.env, BOT_DIRECTORY_CASE_REPORT: path.join(folder, "cases.jsonl") } });
    phase.command = { code: commandResult.code, signal: commandResult.signal, forcedTermination: commandResult.forcedTermination, descendantsStopped: commandResult.descendantsStopped };
    await writeFile(path.join(folder, "stdout.log"), commandResult.stdout);
    await writeFile(path.join(folder, "stderr.log"), commandResult.stderr);
    await writeFile(markers.end, "end\n");
  } catch (error) {
    phase.errors.push(describe(error));
    if (error.result !== undefined) {
      phase.command = { code: error.result.code, signal: error.result.signal, forcedTermination: error.result.forcedTermination, descendantsStopped: error.result.descendantsStopped };
      try {
        await writeFile(path.join(folder, "stdout.log"), error.result.stdout);
        await writeFile(path.join(folder, "stderr.log"), error.result.stderr);
        if (!ownedExecutionUnconfirmed) await writeFile(markers.end, "end\n");
      } catch (saveError) { phase.errors.push(describe(saveError)); }
    }
  }
  finally {
    try { phase.statistics = await stopSession(); } catch (error) { phase.errors.push(describe(error)); }
  }
  try {
    const info = await stat(etl);
    phase.etlBytes = info.size;
    await must(systemTool("tracerpt"), [etl, "-o", xml, "-of", "XML", "-summary", path.join(folder, "summary.txt"), "-y"], { timeoutMs: 60_000 });
    const vitestResult = JSON.parse(await readFile(path.join(folder, "vitest.json"), "utf8"));
    phase.tests = (await readFile(path.join(folder, "cases.jsonl"), "utf8")).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    phase.failedTargets = vitestResult.testResults.flatMap(file => file.assertionResults).flatMap(test => test.failureMessages).flatMap(message => [...message.matchAll(/EBUSY[^\n]*?rmdir '([^']+)'/g)].map(match => match[1])).filter(target => {
      const relative = path.win32.relative(targetBase, target);
      return /^h-[A-Za-z0-9_-]+\\ordinary$/i.test(relative);
    });
    const request = { aliases, targetBases: [targetBase], markers, initialThreads: JSON.parse(await readFile(path.join(folder, "initial-threads.json"), "utf8")), caseWindows: phase.tests, failedTargets: phase.failedTargets };
    await save(path.join(folder, "filter-request.json"), request);
    await must("python.exe", [filter, "--events", xml, "--request", path.join(folder, "filter-request.json"), "--output", path.join(resultDirectory, "events.json")], { timeoutMs: 30_000 });
    const filtered = JSON.parse(await readFile(path.join(resultDirectory, "events.json"), "utf8"));
    phase.expectedCaseCount = name === "control" ? 1 : 5;
    phase.caseCountValid = phase.tests.length === phase.expectedCaseCount;
    phase.complete = phase.caseCountValid && phase.command?.descendantsStopped === true && phase.command.forcedTermination === false && phase.errors.length === 0 && phase.statistics !== null && phase.statistics.eventsLost === 0 && phase.statistics.logBuffersLost === 0 && phase.statistics.realTimeBuffersLost === 0
      && info.size < 64 * 1024 * 1024 && filtered.coverage.begin.seen && filtered.coverage.end.seen && filtered.ordering.complete;
    await save(path.join(resultDirectory, "tests.json"), phase.tests);
    return { phase, filtered, stdout: await readFile(path.join(folder, "stdout.log"), "utf8") };
  } catch (error) { phase.errors.push(describe(error)); return { phase, filtered: null, stdout: "" }; }
  finally { phase.finishedAt = new Date().toISOString(); await save(path.join(resultDirectory, "result.json"), phase); if (!ownedExecutionUnconfirmed) await rm(folder, { recursive: true, force: true }); }
};

let exitCode = 0;
const errors = [];
try {
  aliases = JSON.parse((await must(process.execPath, [native, "aliases", repository], { timeoutMs: 10_000 })).toString("utf8"));
  for (const [label, provider] of [["file", "Microsoft-Windows-Kernel-File"], ["thread", "Microsoft-Windows-Kernel-Process"]]) {
    const manifest = path.join(results, `${label}-provider-manifest.xml`);
    await writeFile(manifest, await must(systemTool("wevtutil"), ["gp", provider, "/ge:true", "/gm:true", "/f:xml"]));
    const schemaFile = path.join(results, `${label}-schema.json`);
    await must("python.exe", [filter, "--manifest", manifest, "--output", schemaFile]);
    const schema = JSON.parse(await readFile(schemaFile, "utf8"));
    if (schema.valid !== true) throw new Error(`The ${label} ETW schema is unsupported: ${JSON.stringify(schema.errors).slice(0, 2048)}`);
  }
  await writeFile(path.join(privateDirectory, "providers.txt"), "{edd08927-9cc4-4e65-b970-c2560fb5c289} 0x4f0 5\n{22fb2cd6-0e7b-422b-a0c7-2fad1fd0e716} 0x20 5\n");
  const control = await capture("control", ["test/commands/worker/bot-process-directory-lock.windows.test.ts"], path.join(repository, ".tmp/bot-directory-lock"));
  const line = control.stdout.split(/\r?\n/).map(value => value.slice(value.indexOf('{"fixture":"windows-directory-lock"'))).find(value => value.startsWith('{"fixture":"windows-directory-lock"'));
  const known = line === undefined ? null : JSON.parse(line);
  const events = control.filtered?.events ?? [];
  const pointer = value => { try { const parsed = BigInt(value); return parsed > 0n ? parsed.toString(16) : null; } catch { return null; } };
  const create = events.find(event => event.providerGuid === "edd08927-9cc4-4e65-b970-c2560fb5c289" && event.eventId === 12 && event.attributedPid === known?.holderPid && Number(event.fields.ShareAccess) === 3 && pointer(event.fields.FileObject) !== null);
  const related = [];
  let lifetimeUnambiguous = true;
  if (create !== undefined) for (const event of events.slice(events.indexOf(create) + 1)) {
    if (pointer(event.fields.FileObject) !== pointer(create.fields.FileObject)) continue;
    if (event.eventId === 12) { lifetimeUnambiguous = false; break; }
    related.push(event);
    if (event.eventId === 14) break;
  }
  const validation = { knownHolder: known, create: create ?? null, cleanupSeen: related.some(event => event.eventId === 13), closeSeen: related.some(event => event.eventId === 14), lifetimeUnambiguous, complete: control.phase.complete };
  await save(path.join(results, "control-validation.json"), validation);
  if (control.phase.command?.code !== 0 || !known?.blockedBeforeTrace || !known?.blockedAfterTrace || !known?.removedAfterRelease || create === undefined || !validation.cleanupSeen || !validation.closeSeen || !validation.lifetimeUnambiguous || !validation.complete) throw new Error("Native ETW control did not establish the known holder's sharing and lifetime; original-case attribution is not admitted.");
  const original = await must("git.exe", ["show", `${base}:${fixturePath}`]);
  await writeFile(fixture, original);
  receipt.fixture.replacementSha256 = hash(original);
  receipt.fixture.controlBlob = await git(["hash-object", "--no-filters", fixturePath]);
  if (receipt.fixture.controlBlob !== receipt.fixture.baseBlob) throw new Error("The original fixture control did not match its selected Git blob.");
  receipt.fixture.intentionalDirtyStatus = await git(["status", "--porcelain", "--", fixturePath]);
  await persist();
  for (let index = 0; index < 5; index++) {
    if (overallMs - (Date.now() - started) < roundBudgetMs + 60_000) { receipt.stopReason = "cleanup-reserve"; break; }
    const result = await capture(`round-${index + 1}`, ["test/commands/worker/bot-process-integration.test.ts", "-t", prefix], path.join(repository, ".tmp/bot-process-integration"));
    receipt.rounds.push(result.phase);
    await persist();
    if (result.phase.command?.code !== 0 || result.phase.command.signal !== null) { exitCode = result.phase.command?.code || 1; receipt.stopReason = "original-case-failure"; break; }
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
