import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

// The callback interception is confined to a child process: the real ps has
// succeeded, but its result is delivered after the observation budget expires.
const preload = String.raw`
const fs = require('node:fs');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const original = cp.execFile;
cp.execFile = function(file, args, options, callback) {
  if (file !== 'ps' || !Array.isArray(args) || args[0] !== '-p' || typeof callback !== 'function') return original.apply(this, arguments);
  return original.call(this, file, args, options, function(error, ...rest) {
    if (error === null && fs.existsSync(process.env.TEST_LATE_PS_MARKER)) {
      fs.writeFileSync(process.env.TEST_LATE_PS_MARKER + '.delivered', 'success');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1800);
    }
    return callback(error, ...rest);
  });
};
syncBuiltinESMExports();
`;

const probe = String.raw`
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.TEST_DAYNIGHT_DIST;
const load = name => import(pathToFileURL(path.join(root, name)).href);
const { createAssistantHostCollector } = await load('commands/worker/bots/host-capabilities.js');
const { createWorkerReporter } = await load('commands/worker/reporter.js');
const { openExecutionResourceJournal } = await load('commands/worker/execution-resource-journal.js');
const { runLifecycleOwnedCommand, reconcileOwnedCommandBoundary, retainedOwnedCommandBoundaries } = await load('commands/worker/owned-command-lifecycle.js');
const { isConfirmedOwnedCommandCleanupWait, hasOwnedCommandCleanupFailure } = await load('commands/worker/owned-command.js');
const marker = process.env.TEST_LATE_PS_MARKER;
const identity = { serverOrigin: 'https://example.test', userId: randomUUID(), workerId: randomUUID() };
const directory = path.join(process.env.TEST_CASE_DIR, 'journal');
const journal = await openExecutionResourceJournal({ directory, identity });
const sink = journal.sink('1');
const outputGate = Promise.withResolvers();
let output = '', issue;
const events = [];
const save = async event => { await sink(event); events.push(event.stage); };
const code = 'const fs=require("node:fs");process.stdout.write("original output");setTimeout(()=>fs.writeFileSync(' + JSON.stringify(marker) + ',"armed"),3000);process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);';
const command = async (value, operation) => value.file === 'fake-claude'
  ? runLifecycleOwnedCommand({ file: process.execPath, args: ['-e', code], environment: process.env }, operation, save, { cleanupWithinDeadline: true, onStdout: async chunk => { output += chunk.toString(); await outputGate.promise; } })
  : { stdout: value.file === 'fake-codex' ? (value.args.includes('--version') ? 'codex-cli 0.172.0' : 'app-server --stdio') : (value.args.includes('--version') ? 'GitHub Copilot CLI 1.0.108' : '--no-auto-update'), stderr: '' };
const collector = createAssistantHostCollector({ workingDirectory: process.env.TEST_CASE_DIR, configuration: { agent: 'codex', model: null, args: [], agentControlMode: 'web', recoveryLimit: 2 }, environment: process.env, resolveExecutable: provider => 'fake-' + provider, runCommand: command });
const ready = Promise.withResolvers(), controller = new AbortController();
const reporter = createWorkerReporter({ signal: controller.signal, collect: async operation => {
  const sample = await collector.collect(operation);
  issue = sample.issues.find(value => value.provider === 'claude')?.error;
  ready.resolve();
  return { telemetry: {}, issues: sample.issues.map(value => ({ component: 'assistantHost_' + value.provider, code: value.reason, error: value.error })) };
}, send: async () => ({}), emit: () => {} });
let resourceId;
try {
  await ready.promise;
  const first = await reporter.stop().then(() => null, error => error);
  const [boundary] = retainedOwnedCommandBoundaries();
  if (!boundary) throw new Error('Original boundary was not retained');
  resourceId = boundary.resourceId;
  const before = (await journal.read()).find(value => value.event.resourceId === resourceId);
  const whileUnconfirmed = await reporter.stop().then(() => null, error => error);
  const delayed = await readFile(marker + '.delivered', 'utf8');
  await unlink(marker);
  const notJoined = await reconcileOwnedCommandBoundary(resourceId, sink, Date.now() + 1000).then(() => false, () => true);
  const retainedBeforeOutput = retainedOwnedCommandBoundaries().some(value => value.resourceId === resourceId);
  const stopBeforeOutput = await reporter.stop().then(() => null, error => error);
  outputGate.resolve();
  await reconcileOwnedCommandBoundary(resourceId, sink, Date.now() + 15000);
  await journal.assertClosed();
  const reopened = await openExecutionResourceJournal({ directory, identity });
  await reopened.assertClosed();
  const after = (await reopened.read()).find(value => value.event.resourceId === resourceId);
  const second = await reporter.stop().then(() => true, () => false);
  console.log(JSON.stringify({ delayed, output, events, firstIsIssue: first === issue, firstCleanup: hasOwnedCommandCleanupFailure(first), whileUnconfirmed: whileUnconfirmed === first, notJoined, retainedBeforeOutput, stopBeforeOutput: stopBeforeOutput === first, before: before?.event.stage, after: after?.event.stage, afterProof: after?.event.proof, originalProof: boundary.proof, retainedAfter: retainedOwnedCommandBoundaries().some(value => value.resourceId === resourceId), settled: isConfirmedOwnedCommandCleanupWait(issue), second }));
} finally {
  controller.abort();
  outputGate.resolve();
  await unlink(marker).catch(() => {});
  for (const boundary of retainedOwnedCommandBoundaries()) if (boundary.resourceId === resourceId) await reconcileOwnedCommandBoundary(boundary.resourceId, sink, Date.now() + 15000);
  await collector.close();
}
`;

it.skipIf(process.platform !== "linux")("settles a successful late ps observation after the original owner and journal close", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../.tmp/late-observation");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "case-"));
  try {
    const hook = path.join(directory, "preload.cjs"), script = path.join(directory, "probe.mjs");
    await writeFile(hook, preload);
    await writeFile(script, probe);
    const { stdout } = await promisify(execFile)(process.execPath, ["--require", hook, script], {
      env: { ...process.env, TEST_CASE_DIR: directory, TEST_LATE_PS_MARKER: path.join(directory, "slow-ps"), TEST_DAYNIGHT_DIST: path.resolve(import.meta.dirname, "../../../dist") },
      timeout: 35_000,
    });
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ delayed: "success", output: "original output", firstIsIssue: true, firstCleanup: true, whileUnconfirmed: true, notJoined: true, retainedBeforeOutput: true, stopBeforeOutput: true, before: "unknown", after: "stopped", retainedAfter: false, settled: true, second: true });
    expect(result.originalProof.processGroupId).toBe(result.originalProof.pid);
    expect(result.afterProof).toEqual(result.originalProof);
    expect(result.events).toContain("bound");
    expect(result.events).toContain("unknown");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rmdir(parent).catch(() => {});
  }
}, 40_000);
