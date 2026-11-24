import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { inspectProcessEvidence, stopEvidenceGroup, type ProcessEvidence } from "../src/process-evidence.ts";
import { recoverEnvironment, resourceIdentity, type DockerCommand } from "../src/recovery.ts";
import { cancelGuardedBrowserScope, initializeRunOwnership } from "../src/fixture-owner.ts";
import { settleCompatEnvironmentSetupFailure, startCompatPlaywright } from "../src/subtask-compat-boundary.ts";

const repository = path.resolve(import.meta.dirname, "../../..");
const ownerURL = new URL("../src/fixture-owner.ts", import.meta.url).href;
const recoveryURL = new URL("../src/recovery.ts", import.meta.url).href;
const boundaryURL = new URL("../src/subtask-compat-boundary.ts", import.meta.url).href;

const makeRun = async () => {
  const run = path.join(repository, ".tmp", "product-e2e", randomUUID());
  await mkdir(path.join(run, "private"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(run, "results"));
  await mkdir(path.join(run, "artifacts"));
  return run;
};
const waitForFile = async (filename: string): Promise<void> => {
  const deadline = Date.now() + 15_000;
  while (true) {
    try { await stat(filename); return; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || Date.now() >= deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
const absentDocker = (calls: string[][]): DockerCommand => async args => {
  calls.push([...args]);
  if (args[1] !== "inspect") throw new Error("Unexpected Docker mutation in an empty fixture.");
  return { exitCode: 1, stdout: "", stderr: `No such ${args[0]}: ${args[2]}` };
};

const launchOwner = (run: string, mode: "graceful" | "crash" | "unbound" | "confirmed" | "cancel-blocked" | "confirmed-crash" | "submitted"): ChildProcess => {
  const auth = `
    import { spawn } from 'node:child_process';
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    import { beginBrowserScope, beginGuardedBrowserScope, bindBrowserScope, cancelGuardedBrowserScope, submitGuardedBrowserScope } from ${JSON.stringify(ownerURL)};
    import { captureProcessEvidence } from ${JSON.stringify(new URL("../src/process-evidence.ts", import.meta.url).href)};
    import { prepareCompatBrowserScope } from ${JSON.stringify(new URL("../src/subtask-compat-bootstrap-scope.ts", import.meta.url).href)};
    const [repository, run, mode] = process.argv.slice(1);
    const guarded = mode === 'confirmed' || mode === 'cancel-blocked' || mode === 'confirmed-crash' || mode === 'submitted';
    if (mode === 'confirmed' || mode === 'cancel-blocked') {
      const keepAlive = setInterval(()=>{},1000);
      const cancellation = new AbortController();
      process.on('SIGINT',()=>cancellation.abort()); process.on('SIGTERM',()=>cancellation.abort());
      try {
        await prepareCompatBrowserScope({signal:cancellation.signal,
          begin:async()=>{const scope=await beginGuardedBrowserScope(repository,run);await writeFile(path.join(run,'results','auth-ready'),'ready');if(!cancellation.signal.aborted)await new Promise(resolve=>cancellation.signal.addEventListener('abort',resolve,{once:true}));return scope;},
          cancel:async id=>{if(mode==='cancel-blocked'){await writeFile(path.join(run,'results','cancel-pending'),'pending');await new Promise(()=>{});}await cancelGuardedBrowserScope(repository,run,id)},submit:id=>submitGuardedBrowserScope(repository,run,id)});
        throw new Error('Cancelled launch was submitted.');
      } catch (error) { if (!cancellation.signal.aborted) throw error; }
      const ownerStop = new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve)});
      await writeFile(path.join(run,'results','cancel-settled'),'settled');
      await ownerStop;
      clearInterval(keepAlive);
      process.exitCode = 1;
    } else {
    const scope = guarded ? await beginGuardedBrowserScope(repository, run) : await beginBrowserScope(repository, run);
    if (mode === 'confirmed-crash') {
      await cancelGuardedBrowserScope(repository, run, scope);
      await writeFile(path.join(run, 'results', 'auth-ready'), 'ready');
      setInterval(()=>{},1000);
    } else if (mode === 'submitted') {
      await submitGuardedBrowserScope(repository, run, scope);
      const browser = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {detached:true,stdio:'ignore'});
      try {
        let refused = false;
        try { await cancelGuardedBrowserScope(repository, run, scope); } catch { refused = true; }
        if (!refused) throw new Error('Submitted launch was falsely marked never started.');
        await writeFile(path.join(run, 'results', 'actual-browser-proof'), JSON.stringify(await captureProcessEvidence(browser.pid)));
      } catch (error) { browser.kill('SIGKILL'); throw error; }
      browser.unref();
      await writeFile(path.join(run, 'results', 'auth-ready'), 'ready');
      setInterval(()=>{},1000);
    } else {
    if (mode !== 'unbound') {
      const browser = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {detached:true,stdio:'ignore'});
      try { await bindBrowserScope(repository, run, scope, browser.pid); }
      catch (error) { browser.kill('SIGKILL'); throw error; }
      browser.unref();
    }
    await writeFile(path.join(run, 'results', 'auth-ready'), 'ready');
    setInterval(()=>{},1000);
    }
    }
  `;
  const script = `
    import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    import { randomUUID } from 'node:crypto';
    import { initializeRunOwnership, startOwnedPlaywright } from ${JSON.stringify(ownerURL)};
    import { markBuildComplete, resourceIdentity, writeCleanupReceipt } from ${JSON.stringify(recoveryURL)};
    import { completeCompatEnvironmentSetup, finalizeCompatEnvironment } from ${JSON.stringify(boundaryURL)};
    const [repository, run, mode, auth] = process.argv.slice(1);
    await initializeRunOwnership(repository, run);
    await markBuildComplete(run);
    const runId = randomUUID(), identity = resourceIdentity(runId), owner = await stat(run);
    const receipt = {schemaVersion:1,runId,directoryId:path.basename(run),ownerUid:owner.uid,ownerGid:owner.gid,resourceIdentity:identity,state:'pending',verified:false,resourcesAbsent:false,remaining:[],verificationErrors:[],cleanupErrors:[]};
    await writeCleanupReceipt(run,receipt);
    await completeCompatEnvironmentSetup(run);
    const abort = new AbortController();
    process.on('SIGTERM',()=>abort.abort(new Error('original interruption')));
    const command = await startOwnedPlaywright({repository,runDirectory:run,command:process.execPath,args:['--input-type=module','-e',auth,repository,run,mode],options:{cwd:path.join(run,'private'),env:process.env,timeoutMs:30000,signal:abort.signal,onOutput:()=>{}}});
    let interrupted = false;
    try { await command.finished; } catch { interrupted = true; try { await command.stop(); } catch {} }
    const environment = {close:async()=>{
      const browsers = JSON.parse(await readFile(path.join(run,'results','browser-ownership.json'),'utf8'));
      if (!browsers.scopes.every(scope => scope.stopped)) throw new Error('Browser stop was not proved before environment cleanup.');
      await writeFile(path.join(run,'results','environment-close-called'),'yes');
      await writeCleanupReceipt(run,{...receipt,state:'complete',verified:true,resourcesAbsent:true});
    }};
    const cleanup = await finalizeCompatEnvironment({repository,runDirectory:run,environment,environmentComplete:true,preparingEnvironment:true,buildComplete:true});
    await writeFile(path.join(run,'results','test-outcome.json'),JSON.stringify({interrupted,completed:cleanup.completed,failures:cleanup.failures.map(String)}));
    process.exitCode = interrupted ? 1 : 0;
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", script, repository, run, mode, auth], { cwd: repository, stdio: "inherit" });
};

const browserProof = async (run: string): Promise<ProcessEvidence> => {
  const value = JSON.parse(await readFile(path.join(run, "results", "browser-ownership.json"), "utf8")) as { scopes: { proof: ProcessEvidence | null }[] };
  assert.equal(value.scopes.length, 1);
  if (!value.scopes[0]!.proof) throw new Error("Fixture browser proof is missing.");
  return value.scopes[0]!.proof;
};

test("SIGTERM during authentication proves the original browser stop before owned environment cleanup", async () => {
  const run = await makeRun(), child = launchOwner(run, "graceful");
  let proof: ProcessEvidence | undefined;
  try {
    await waitForFile(path.join(run, "results", "auth-ready"));
    proof = await browserProof(run);
    assert.equal(await inspectProcessEvidence(proof), "running");
    const ended = once(child, "exit"); child.kill("SIGTERM"); await ended;
    assert.deepEqual(JSON.parse(await readFile(path.join(run, "results", "test-outcome.json"), "utf8")), { interrupted: true, completed: true, failures: [] });
    assert.equal(await inspectProcessEvidence(proof), "stopped");
    assert.equal(await readFile(path.join(run, "results", "environment-close-called"), "utf8"), "yes");
    const receipt = JSON.parse(await readFile(path.join(run, "results", "environment-cleanup.json"), "utf8"));
    assert.equal(receipt.verified, true); assert.equal(receipt.state, "complete");
    assert.equal(JSON.parse(await readFile(path.join(run, "results", "fixture-owner.json"), "utf8")).verified, true);
    await assert.rejects(stat(path.join(run, "private")), { code: "ENOENT" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
    if (proof && await inspectProcessEvidence(proof) === "running") await stopEvidenceGroup(proof, [], Date.now() + 10_000);
    await rm(run, { recursive: true, force: true });
  }
});

test("confirmed pre-submission cancellation cleans without a fabricated browser PID", async () => {
  const run = await makeRun(), child = launchOwner(run, "confirmed");
  try {
    await waitForFile(path.join(run, "results", "auth-ready"));
    const prepared = JSON.parse(await readFile(path.join(run, "results", "browser-ownership.json"), "utf8"));
    await assert.rejects(cancelGuardedBrowserScope(repository, run, prepared.scopes[0].id), /original launcher changed/);
    process.kill(prepared.scopes[0].launcher.pid, "SIGINT");
    await waitForFile(path.join(run, "results", "cancel-settled"));
    const settled = JSON.parse(await readFile(path.join(run, "results", "browser-ownership.json"), "utf8"));
    assert.equal(settled.scopes[0].launchState, "never_started"); assert.equal(settled.scopes[0].proof, null); assert.equal(settled.scopes[0].stopped, true);
    const ended = once(child, "exit"); child.kill("SIGTERM"); await ended;
    const outcome = JSON.parse(await readFile(path.join(run, "results", "test-outcome.json"), "utf8"));
    assert.deepEqual(outcome, { interrupted: true, completed: true, failures: [] });
    const registry = JSON.parse(await readFile(path.join(run, "results", "browser-ownership.json"), "utf8"));
    assert.equal(registry.scopes[0].launchState, "never_started"); assert.equal(registry.scopes[0].proof, null); assert.equal(registry.scopes[0].stopped, true);
    assert.equal(JSON.parse(await readFile(path.join(run, "results", "environment-cleanup.json"), "utf8")).verified, true);
  } finally { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill("SIGTERM"); await ended; } await rm(run, { recursive: true, force: true }); }
});

test("interrupted pre-submission cancellation without a persisted decision retains the environment", async () => {
  const run = await makeRun(), child = launchOwner(run, "cancel-blocked");
  try {
    await waitForFile(path.join(run, "results", "auth-ready"));
    const registry = JSON.parse(await readFile(path.join(run, "results", "browser-ownership.json"), "utf8"));
    const launcher = registry.scopes[0].launcher as ProcessEvidence;
    process.kill(launcher.pid, "SIGINT");
    await waitForFile(path.join(run, "results", "cancel-pending"));
    const ended = once(child, "exit");
    process.kill(launcher.pid, "SIGKILL"); child.kill("SIGTERM"); await ended;
    const outcome = JSON.parse(await readFile(path.join(run, "results", "test-outcome.json"), "utf8"));
    assert.equal(outcome.completed, false);
    assert.match(outcome.failures.join(" "), /browser stop is unconfirmed/);
    const observed = JSON.parse(await readFile(path.join(run, "results", "browser-ownership.json"), "utf8"));
    assert.equal(observed.scopes[0].launchState, "prepared"); assert.equal(observed.scopes[0].proof, null); assert.equal(observed.scopes[0].stopped, false);
    assert.equal((await stat(path.join(run, "private"))).isDirectory(), true);
    await assert.rejects(stat(path.join(run, "results", "environment-close-called")), { code: "ENOENT" });
  } finally { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill("SIGTERM"); await ended; } await rm(run, { recursive: true, force: true }); }
});

test("independent recovery recognizes the persisted never-started decision after owner death", async () => {
  const run = await makeRun(), child = launchOwner(run, "confirmed-crash");
  try {
    await waitForFile(path.join(run, "results", "auth-ready"));
    const ended = once(child, "exit"); child.kill("SIGKILL"); await ended;
    const calls: string[][] = [];
    await recoverEnvironment({ repository, runDirectory: run, phase: "environment", execute: absentDocker(calls) });
    const registry = JSON.parse(await readFile(path.join(run, "results", "browser-ownership.json"), "utf8"));
    assert.equal(registry.scopes[0].launchState, "never_started"); assert.equal(registry.scopes[0].proof, null);
    const receipt = JSON.parse(await readFile(path.join(run, "results", "environment-cleanup.json"), "utf8"));
    assert.equal(receipt.state, "pending"); assert.equal(receipt.recovery.verified, true);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); } await rm(run, { recursive: true, force: true }); }
});

test("a submitted launch without a browser proof remains unknown even with a live browser", async () => {
  const run = await makeRun(), child = launchOwner(run, "submitted"); let proof: ProcessEvidence | undefined;
  try {
    await waitForFile(path.join(run, "results", "auth-ready"));
    proof = JSON.parse(await readFile(path.join(run, "results", "actual-browser-proof"), "utf8"));
    const ended = once(child, "exit"); child.kill("SIGKILL"); await ended;
    const calls: string[][] = [];
    await assert.rejects(recoverEnvironment({ repository, runDirectory: run, phase: "environment", execute: absentDocker(calls) }), /ownership|stop.*unverified/i);
    assert.equal(calls.length, 0); assert.equal(await inspectProcessEvidence(proof!), "running");
    const registry = JSON.parse(await readFile(path.join(run, "results", "browser-ownership.json"), "utf8"));
    assert.equal(registry.scopes[0].launchState, "submitted"); assert.equal(registry.scopes[0].proof, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
    if (proof && await inspectProcessEvidence(proof) === "running") await stopEvidenceGroup(proof, [], Date.now() + 10_000);
    await rm(run, { recursive: true, force: true });
  }
});

test("independent recovery after SIGKILL stops the recorded authentication browser and retains its receipt", async () => {
  const run = await makeRun(), child = launchOwner(run, "crash");
  let proof: ProcessEvidence | undefined;
  try {
    await waitForFile(path.join(run, "results", "auth-ready"));
    proof = await browserProof(run);
    const ended = once(child, "exit"); child.kill("SIGKILL"); await ended;
    const calls: string[][] = [];
    await recoverEnvironment({ repository, runDirectory: run, phase: "environment", execute: absentDocker(calls) });
    assert.equal(await inspectProcessEvidence(proof), "stopped");
    const owner = JSON.parse(await readFile(path.join(run, "results", "fixture-owner.json"), "utf8"));
    assert.equal(owner.verified, true); assert.equal(owner.browserUnconfirmed, false);
    const browser = JSON.parse(await readFile(path.join(run, "results", "browser-ownership.json"), "utf8"));
    assert.deepEqual(browser.scopes[0].proof, proof); assert.equal(browser.scopes[0].stopped, true);
    const receipt = JSON.parse(await readFile(path.join(run, "results", "environment-cleanup.json"), "utf8"));
    assert.equal(receipt.state, "pending"); assert.equal(receipt.recovery.completed, true); assert.equal(receipt.recovery.verified, true);
    assert.ok(calls.length > 0);
    await assert.rejects(stat(path.join(run, "private")), { code: "ENOENT" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
    if (proof && await inspectProcessEvidence(proof) === "running") await stopEvidenceGroup(proof, [], Date.now() + 10_000);
    await rm(run, { recursive: true, force: true });
  }
});

test("missing original authentication browser proof blocks independent cleanup", async () => {
  const run = await makeRun(), child = launchOwner(run, "unbound");
  try {
    await waitForFile(path.join(run, "results", "auth-ready"));
    const ended = once(child, "exit"); child.kill("SIGKILL"); await ended;
    const calls: string[][] = [];
    await assert.rejects(recoverEnvironment({ repository, runDirectory: run, phase: "environment", execute: absentDocker(calls) }), /ownership|stop.*unverified/i);
    assert.equal(calls.length, 0);
    const browser = JSON.parse(await readFile(path.join(run, "results", "browser-ownership.json"), "utf8"));
    assert.equal(browser.scopes[0].proof, null); assert.equal(browser.scopes[0].stopped, false);
    assert.equal((await stat(path.join(run, "private"))).isDirectory(), true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
    await rm(run, { recursive: true, force: true });
  }
});

test("SIGTERM after the browser intent but before its identity preserves the unconfirmed environment", async () => {
  const run = await makeRun(), child = launchOwner(run, "unbound");
  try {
    await waitForFile(path.join(run, "results", "auth-ready"));
    const ended = once(child, "exit"); child.kill("SIGTERM"); await ended;
    const outcome = JSON.parse(await readFile(path.join(run, "results", "test-outcome.json"), "utf8")) as { interrupted: boolean; completed: boolean; failures: string[] };
    assert.equal(outcome.interrupted, true); assert.equal(outcome.completed, false);
    assert.match(outcome.failures.join(" "), /browser.*unconfirmed/i);
    const browser = JSON.parse(await readFile(path.join(run, "results", "browser-ownership.json"), "utf8"));
    assert.equal(browser.scopes[0].proof, null); assert.equal(browser.scopes[0].stopped, false);
    const receipt = JSON.parse(await readFile(path.join(run, "results", "environment-cleanup.json"), "utf8"));
    assert.equal(receipt.state, "pending"); assert.equal(receipt.verified, false);
    await assert.rejects(stat(path.join(run, "results", "environment-close-called")), { code: "ENOENT" });
    assert.equal((await stat(path.join(run, "private"))).isDirectory(), true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
    // This fixture never launches a browser; its persisted intent is the subject under test.
    await rm(run, { recursive: true, force: true });
  }
});

test("interrupted environment creation without a returned owner remains unconfirmed", async () => {
  const run = await makeRun();
  try {
    assert.equal(await settleCompatEnvironmentSetupFailure(run, false, true), false);
    await assert.rejects(stat(path.join(run, "results", "environment-complete.json")), { code: "ENOENT" });
    assert.equal((await stat(path.join(run, "private"))).isDirectory(), true);
  } finally { await rm(run, { recursive: true, force: true }); }
});

test("a joined returned environment can record its boundary despite cancellation", async () => {
  const run = await makeRun();
  try {
    assert.equal(await settleCompatEnvironmentSetupFailure(run, true, true), true);
    const marker = JSON.parse(await readFile(path.join(run, "results", "environment-complete.json"), "utf8"));
    assert.deepEqual(marker, { schemaVersion: 1, directoryId: path.basename(run), complete: true });
  } finally { await rm(run, { recursive: true, force: true }); }
});

test("cancellation already known before authentication creates no browser launch intent", async () => {
  const run = await makeRun();
  try {
    await initializeRunOwnership(repository, run);
    const abort = new AbortController(), reason = new Error("cancelled before authentication");
    abort.abort(reason);
    await assert.rejects(startCompatPlaywright({ repository, runDirectory: run, command: process.execPath, args: ["-e", "throw new Error('must not launch')"], options: { cwd: run, timeoutMs: 5_000, signal: abort.signal } }), error => error === reason);
    const owner = JSON.parse(await readFile(path.join(run, "results", "fixture-owner.json"), "utf8"));
    assert.equal(owner.playwright, null); assert.equal(owner.browserUnconfirmed, false);
    await assert.rejects(stat(path.join(run, "results", "browser-ownership.json")), { code: "ENOENT" });
  } finally { await rm(run, { recursive: true, force: true }); }
});
