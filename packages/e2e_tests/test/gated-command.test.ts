import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { startCommand, type ManagedCommand } from "../src/command.ts";
import { startGatedCommand, stopGate } from "../src/gated-command.ts";
import { readGateReceipt, writeGateReceipt } from "../src/gated-record.ts";
import { beginBrowserScope, bindBrowserScope, finishBrowserScope, initializeRunOwnership, recoverRunOwnership, registerFixtureClaim, startOwnedAuxiliary, startOwnedPlaywright } from "../src/fixture-owner.ts";
import { captureProcessEvidence, inspectProcessEvidence, stopEvidenceGroup, type ProcessEvidence } from "../src/process-evidence.ts";

const repository = path.resolve(import.meta.dirname, "../../.."), parent = path.join(repository, ".tmp", "product-e2e");
const create = async () => { const run = path.join(parent, randomUUID()); await mkdir(path.join(run, "results"), { recursive: true }); return run; };
const wait = async (condition: () => Promise<boolean>) => {
  const deadline = Date.now() + 8_000;
  while (!await condition()) { if (Date.now() > deadline) throw new Error("Timed out waiting for fixture proof."); await new Promise(resolve => setTimeout(resolve, 20)); }
};

test("failed Playwright cleanup uses the original browser process proof", async () => {
  const run = await create(), exitFile = path.join(run, "exit");
  let browser: ReturnType<typeof spawn> | undefined, playwright: ManagedCommand | undefined, browserExit: Promise<unknown> | undefined;
  try {
    await initializeRunOwnership(repository, run);
    playwright = await startOwnedPlaywright({ repository, runDirectory: run, command: process.execPath,
      args: ["-e", `const fs=require('fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(exitFile)}))process.exit(1)},20)`], options: { cwd: run, timeoutMs: 15_000, onOutput: () => {} } });
    const scope = await beginBrowserScope(repository, run);
    browser = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    browserExit = once(browser, "exit");
    const proof = await captureProcessEvidence(browser.pid!);
    await bindBrowserScope(repository, run, scope, browser.pid!);
    await finishBrowserScope(repository, run, scope);
    assert.equal(await inspectProcessEvidence(proof), "stopped");
    await writeFile(exitFile, "exit");
    assert.equal((await playwright.finished).exitCode, 1);
    await recoverRunOwnership({ repository, runDirectory: run, mode: "owner" });
    assert.equal(JSON.parse(await readFile(path.join(run, "results", "fixture-owner.json"), "utf8")).verified, true);
  } finally {
    await playwright?.stop().catch(() => {});
    if (browser?.pid !== undefined && browser.exitCode === null && browser.signalCode === null) try { process.kill(-browser.pid, "SIGKILL"); } catch { /* Already stopped. */ }
    await browserExit;
    await rm(run, { recursive: true, force: true });
  }
});

test("unbound browser launch remains unconfirmed after Playwright fails", async () => {
  const run = await create(), exitFile = path.join(run, "exit");
  let playwright: ManagedCommand | undefined;
  try {
    await initializeRunOwnership(repository, run);
    playwright = await startOwnedPlaywright({ repository, runDirectory: run, command: process.execPath,
      args: ["-e", `const fs=require('fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(exitFile)}))process.exit(1)},20)`], options: { cwd: run, timeoutMs: 15_000, onOutput: () => {} } });
    await beginBrowserScope(repository, run);
    await writeFile(exitFile, "exit");
    assert.equal((await playwright.finished).exitCode, 1);
    await assert.rejects(recoverRunOwnership({ repository, runDirectory: run, mode: "owner" }), /browser stop is unconfirmed/);
    assert.equal(JSON.parse(await readFile(path.join(run, "results", "fixture-owner.json"), "utf8")).verified, false);
  } finally { await playwright?.stop().catch(() => {}); await rm(run, { recursive: true, force: true }); }
});

test("browser proof conflict never signals the mismatched process", async () => {
  const run = await create(); let browser: ReturnType<typeof spawn> | undefined, playwright: ManagedCommand | undefined, browserExit: Promise<unknown> | undefined;
  try {
    await initializeRunOwnership(repository, run);
    playwright = await startOwnedPlaywright({ repository, runDirectory: run, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], options: { cwd: run, timeoutMs: 15_000, onOutput: () => {} } });
    const scope = await beginBrowserScope(repository, run);
    browser = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    browserExit = once(browser, "exit");
    await bindBrowserScope(repository, run, scope, browser.pid!);
    const filename = path.join(run, "results", "browser-ownership.json"), registry = JSON.parse(await readFile(filename, "utf8"));
    registry.scopes[0].proof.commandHash = "0".repeat(64); await writeFile(filename, JSON.stringify(registry));
    await assert.rejects(finishBrowserScope(repository, run, scope));
    assert.doesNotThrow(() => process.kill(browser!.pid!, 0));
    await playwright.stopProcesses(); await playwright.finished;
  } finally {
    await playwright?.stop().catch(() => {});
    if (browser?.pid !== undefined && browser.exitCode === null && browser.signalCode === null) try { process.kill(-browser.pid, "SIGKILL"); } catch { /* Already stopped. */ }
    await browserExit;
    await rm(run, { recursive: true, force: true });
  }
});

test("independent recovery after runner SIGKILL stops the proved original browser group", async () => {
  const run = await create(), module = new URL("../src/fixture-owner.ts", import.meta.url).href;
  const source = `import {spawn} from 'node:child_process'; import {initializeRunOwnership,startOwnedPlaywright,beginBrowserScope,bindBrowserScope} from ${JSON.stringify(module)};
    await initializeRunOwnership(${JSON.stringify(repository)},${JSON.stringify(run)});
    await startOwnedPlaywright({repository:${JSON.stringify(repository)},runDirectory:${JSON.stringify(run)},command:process.execPath,args:['-e','setInterval(()=>{},1000)'],options:{cwd:${JSON.stringify(run)},timeoutMs:30000,onOutput:()=>{}}});
    const scope=await beginBrowserScope(${JSON.stringify(repository)},${JSON.stringify(run)}), browser=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    await bindBrowserScope(${JSON.stringify(repository)},${JSON.stringify(run)},scope,browser.pid);process.stdout.write('READY\\n');setInterval(()=>{},1000);`;
  const runner = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let gateId: string | undefined, proof: ProcessEvidence | undefined;
  try {
    await once(runner.stdout, "data");
    const owner = JSON.parse(await readFile(path.join(run, "results", "fixture-owner.json"), "utf8"));
    gateId = owner.playwright.id;
    await wait(async () => (await readGateReceipt(run, gateId!)).child !== null);
    proof = JSON.parse(await readFile(path.join(run, "results", "browser-ownership.json"), "utf8")).scopes[0].proof;
    assert.ok(proof);
    runner.kill("SIGKILL"); await once(runner, "exit");
    await recoverRunOwnership({ repository, runDirectory: run, mode: "independent" });
    assert.equal(await inspectProcessEvidence(proof), "stopped");
    assert.equal(JSON.parse(await readFile(path.join(run, "results", "fixture-owner.json"), "utf8")).verified, true);
  } finally {
    if (runner.exitCode === null && runner.signalCode === null) { runner.kill("SIGKILL"); await once(runner, "exit"); }
    if (gateId !== undefined) try { await stopGate(run, gateId, Date.now() + 5_000); } catch { /* Preserve original proof on uncertainty. */ }
    if (proof !== undefined) try { await stopEvidenceGroup(proof, [], Date.now() + 5_000); } catch { /* Preserve original proof on uncertainty. */ }
    await rm(run, { recursive: true, force: true });
  }
});

test("gate binds process evidence before a target starts, and stops its real process group", async () => {
  const run = await create(), gateId = randomUUID(), marker = path.join(run, "target");
  try {
    const gate = await startGatedCommand({ runDirectory: run, gateId, command: process.execPath,
      args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000)`], options: { cwd: run, timeoutMs: 15_000, onOutput: () => {} } });
    await wait(async () => { try { return (await readGateReceipt(run, gateId)).child !== null && (await readFile(marker, "utf8")) === "started"; } catch { return false; } });
    const receipt = await readGateReceipt(run, gateId); assert.equal(receipt.state, "released"); assert.ok(receipt.child);
    await gate.stopProcesses(); await gate.finished;
  } finally { await rm(run, { recursive: true, force: true }); }
});

test("a released gate with a lost original leader and missing child proof remains unknown", async () => {
  const run = await create(), gateId = randomUUID();
  try {
    const gate = await startGatedCommand({ runDirectory: run, gateId, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], options: { cwd: run, timeoutMs: 15_000, onOutput: () => {} } });
    await wait(async () => (await readGateReceipt(run, gateId)).child !== null);
    await gate.stopProcesses(); await gate.finished;
    const receipt = await readGateReceipt(run, gateId); await writeGateReceipt(run, { ...receipt, child: null });
    await assert.rejects(stopGate(run, gateId, Date.now() + 5_000), /lacks a live original instance/);
  } finally { await rm(run, { recursive: true, force: true }); }
});

test("independent recovery after real runner SIGKILL retains unconfirmed ownership", async () => {
  const run = await create(), module = new URL("../src/fixture-owner.ts", import.meta.url).href;
  const source = `import { initializeRunOwnership, startOwnedPlaywright } from ${JSON.stringify(module)}; await initializeRunOwnership(${JSON.stringify(repository)},${JSON.stringify(run)}); await startOwnedPlaywright({repository:${JSON.stringify(repository)},runDirectory:${JSON.stringify(run)},command:process.execPath,args:['-e','setInterval(()=>{},1000)'],options:{cwd:${JSON.stringify(run)},timeoutMs:30000,onOutput:()=>{}}}); process.stdout.write('READY\\n'); setInterval(()=>{},1000);`;
  const runner = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await once(runner.stdout, "data");
    const owner = JSON.parse(await readFile(path.join(run, "results", "fixture-owner.json"), "utf8"));
    await wait(async () => (await readGateReceipt(run, owner.playwright.id)).child !== null);
    runner.kill("SIGKILL"); await once(runner, "exit");
    await assert.rejects(recoverRunOwnership({ repository, runDirectory: run, mode: "independent" }), /browser stop is unconfirmed|group has no live instance proof/);
    await assert.rejects(recoverRunOwnership({ repository, runDirectory: run, mode: "independent" }), /browser stop is unconfirmed|group has no live instance proof/);
    assert.equal(JSON.parse(await readFile(path.join(run, "results", "fixture-owner.json"), "utf8")).verified, false);
  } finally { if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL"); await rm(run, { recursive: true, force: true }); }
});

test("a live runner excludes independent recovery", async () => {
  const run = await create();
  try { await initializeRunOwnership(repository, run); await assert.rejects(recoverRunOwnership({ repository, runDirectory: run, mode: "independent" }), /does not permit recovery/); }
  finally { await rm(run, { recursive: true, force: true }); }
});

test("closed child stdin reports EPIPE without an unhandled stream error", async () => {
  const run = await create();
  try {
    let ready!: () => void; const announced = new Promise<void>(resolve => { ready = resolve; });
    const child = startCommand(process.execPath, ["-e", "require('fs').closeSync(0);process.stdout.write('READY');setInterval(()=>{},1000)"], { cwd: run, stdin: "pipe", timeoutMs: 5_000, onOutput: () => ready() });
    await announced; await new Promise(resolve => setTimeout(resolve, 50));
    await assert.rejects(child.writeInput("x".repeat(1024 * 1024)));
    await assert.rejects(child.finished);
  } finally { await rm(run, { recursive: true, force: true }); }
});

test("gate handshake accepts fragmented and combined output without losing target output", async () => {
  const { gateReadyDecoder } = await import("../src/gated-command.ts");
  const decode = gateReadyDecoder();
  assert.equal(decode("DAYNIGHT_GATE_"), null);
  assert.equal(decode("READY\nfirst"), "first");
  assert.equal(decode("second"), "second");
  assert.throws(() => gateReadyDecoder()("INVALID\n"), /invalid/);
});

test("gate rejects EOF before authorization and accepts fragmented GO only with durable proof", async () => {
  const { captureProcessEvidence } = await import("../src/process-evidence.ts");
  const run = await create(), gateId = randomUUID(), marker = path.join(run, "started"), gatePath = path.resolve(import.meta.dirname, "../src/gated-runner.mjs");
  const args = [gatePath, run, gateId, process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000)`];
  const first = spawn(process.execPath, args, { cwd: run, detached: true, stdio: ["pipe", "pipe", "ignore"] });
  try {
    await once(first.stdout, "data"); first.stdin.end(); await once(first, "exit");
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    const gate = spawn(process.execPath, args, { cwd: run, detached: true, stdio: ["pipe", "pipe", "ignore"] });
    try {
      await once(gate.stdout, "data");
      const leader = await captureProcessEvidence(gate.pid!);
      await writeGateReceipt(run, { schemaVersion: 1, runId: path.basename(run), gateId, state: "released", leader, child: null });
      gate.stdin.write("G"); await new Promise(resolve => setTimeout(resolve, 20)); gate.stdin.write("O");
      await new Promise(resolve => setTimeout(resolve, 20)); await assert.rejects(readFile(marker), { code: "ENOENT" });
      gate.stdin.write("\n");
      await wait(async () => { try { return (await readGateReceipt(run, gateId)).child !== null && (await readFile(marker, "utf8")) === "started"; } catch { return false; } });
      await stopGate(run, gateId, Date.now() + 5_000);
    } finally { gate.stdin.end(); if (gate.exitCode === null && gate.signalCode === null) gate.kill("SIGKILL"); }
  } finally { if (first.exitCode === null && first.signalCode === null) first.kill("SIGKILL"); await rm(run, { recursive: true, force: true }); }
});

test("fixture claim binding is durable and refuses a different claim", async () => {
  const { prepareFixtureOwnership, registerFixtureIdentity, registerFixtureClaim } = await import("../src/fixture-owner.ts");
  const run = await create(), root = path.join(repository, ".tmp", "product-e2e-retained", path.basename(run));
  try {
    await initializeRunOwnership(repository, run);
    const file = path.join(run, "results", "fixture-owner.json"), value = JSON.parse(await readFile(file, "utf8"));
    value.playwright = { id: randomUUID(), stopped: false }; await writeFile(file, JSON.stringify(value));
    await prepareFixtureOwnership(repository, run);
    await registerFixtureIdentity(repository, run, { projectId: randomUUID(), taskId: randomUUID(), workerId: randomUUID(), userId: randomUUID(), serverOrigin: "https://example.test", repository: path.join(root, "repository") });
    const claim = randomUUID(); await registerFixtureClaim(repository, run, claim); await registerFixtureClaim(repository, run, claim);
    await assert.rejects(registerFixtureClaim(repository, run, randomUUID()), /conflicts/);
    assert.equal(JSON.parse(await readFile(file, "utf8")).fixture.identity.claimId, claim);
  } finally { await rm(root, { recursive: true, force: true }); await rm(run, { recursive: true, force: true }); }
});

test("recovery stops a separately owned fixture command after the real runner is killed", async () => {
  const run = await create(), ownerModule = new URL("../src/fixture-owner.ts", import.meta.url).href, marker = path.join(run, "descendant");
  const payload = `require('fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,ppid:process.ppid}));setInterval(()=>{},1000)`;
  const target = `import { startOwnedAuxiliary } from ${JSON.stringify(ownerModule)}; await startOwnedAuxiliary({repository:${JSON.stringify(repository)},runDirectory:${JSON.stringify(run)},command:process.execPath,args:['-e',${JSON.stringify(payload)}],options:{cwd:${JSON.stringify(run)},timeoutMs:30000,onOutput:()=>{}}}); setInterval(()=>{},1000);`;
  const source = `import { initializeRunOwnership, startOwnedPlaywright } from ${JSON.stringify(ownerModule)}; await initializeRunOwnership(${JSON.stringify(repository)},${JSON.stringify(run)}); await startOwnedPlaywright({repository:${JSON.stringify(repository)},runDirectory:${JSON.stringify(run)},command:process.execPath,args:['--input-type=module','-e',${JSON.stringify(target)}],options:{cwd:${JSON.stringify(run)},timeoutMs:30000,onOutput:()=>{}}}); setInterval(()=>{},1000);`;
  const runner = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "ignore", "ignore"] });
  try {
    let payloadIdentity: { pid: number; ppid: number } | undefined;
    await wait(async () => { try { payloadIdentity = JSON.parse(await readFile(marker, "utf8")); return Number.isInteger(payloadIdentity?.pid) && Number.isInteger(payloadIdentity?.ppid); } catch { return false; } });
    assert.ok(payloadIdentity);
    const owner = JSON.parse(await readFile(path.join(run, "results", "fixture-owner.json"), "utf8"));
    assert.equal(owner.commands.length, 1);
    const receipt = await readGateReceipt(run, owner.commands[0].id);
    assert.equal(receipt.state, "released");
    assert.ok(receipt.child);
    assert.equal(receipt.child.pid, payloadIdentity.ppid);
    const payloadProof = await captureProcessEvidence(payloadIdentity.pid);
    runner.kill("SIGKILL"); await once(runner, "exit");
    await assert.rejects(recoverRunOwnership({ repository, runDirectory: run, mode: "independent" }), /browser stop is unconfirmed/);
    assert.equal(await inspectProcessEvidence(receipt.child), "stopped");
    assert.equal(await inspectProcessEvidence(payloadProof), "stopped");
    const recovered = JSON.parse(await readFile(path.join(run, "results", "fixture-owner.json"), "utf8"));
    assert.equal(recovered.commands[0].stopped, true);
    assert.equal(recovered.browserUnconfirmed, true);
    assert.equal(recovered.verified, false);
  } finally { if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL"); await rm(run, { recursive: true, force: true }); }
});

test("interrupted Test Session with a live detached controller retains original evidence", async () => {
  const run = await create(), ownerModule = new URL("../src/fixture-owner.ts", import.meta.url).href, marker = path.join(run, "detached");
  const detached = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));setInterval(()=>{},1000);`;
  const target = `import { startOwnedAuxiliary } from ${JSON.stringify(ownerModule)}; await startOwnedAuxiliary({repository:${JSON.stringify(repository)},runDirectory:${JSON.stringify(run)},command:process.execPath,args:['-e',${JSON.stringify(detached)}],independentController:true,options:{cwd:${JSON.stringify(run)},timeoutMs:30000,onOutput:()=>{}}});setInterval(()=>{},1000);`;
  const source = `import { initializeRunOwnership, startOwnedPlaywright } from ${JSON.stringify(ownerModule)};await initializeRunOwnership(${JSON.stringify(repository)},${JSON.stringify(run)});await startOwnedPlaywright({repository:${JSON.stringify(repository)},runDirectory:${JSON.stringify(run)},command:process.execPath,args:['--input-type=module','-e',${JSON.stringify(target)}],options:{cwd:${JSON.stringify(run)},timeoutMs:30000,onOutput:()=>{}}});setInterval(()=>{},1000);`;
  const runner = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "ignore", "ignore"] });
  const evidence = await import("../src/process-evidence.ts");
  let proof: Awaited<ReturnType<typeof evidence.captureProcessEvidence>> | undefined;
  try {
    await wait(async () => { try { return (await readFile(marker, "utf8")) !== ""; } catch { return false; } });
    proof = await evidence.captureProcessEvidence(Number(await readFile(marker, "utf8")));
    runner.kill("SIGKILL"); await once(runner, "exit");
    await assert.rejects(recoverRunOwnership({ repository, runDirectory: run, mode: "independent" }), /Controller stop is unconfirmed/);
    assert.equal(await evidence.inspectProcessEvidence(proof), "running");
    assert.equal(JSON.parse(await readFile(path.join(run, "results", "fixture-owner.json"), "utf8")).verified, false);
  } finally {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
    if (proof) await evidence.stopEvidenceGroup(proof, [], Date.now() + 5_000);
    await rm(run, { recursive: true, force: true });
  }
});

test("short gated commands return exact target output without the internal handshake", async () => {
  const run = await create(), gateId = randomUUID();
  try {
    const gate = await startGatedCommand({ runDirectory: run, gateId, command: process.execPath, args: ["-e", "process.stdout.write('{\\\"ok\\\":true}')"], options: { cwd: run, timeoutMs: 5_000, onOutput: () => {} } });
    const result = await gate.finished;
    assert.equal(result.exitCode, 0); assert.deepEqual(JSON.parse(result.stdout), { ok: true });
  } finally { await rm(run, { recursive: true, force: true }); }
});

test("killed Worker with an untracked detached helper retains its fixture state", async () => {
  const run = await create(), ownerModule = new URL("../src/fixture-owner.ts", import.meta.url).href, marker = path.join(run, "worker-helper"), root = path.join(repository, ".tmp", "product-e2e-retained", path.basename(run));
  const worker = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));setInterval(()=>{},1000);`;
  const target = `import {prepareFixtureOwnership,registerFixtureIdentity,startOwnedFixture} from ${JSON.stringify(ownerModule)};import {randomUUID} from 'node:crypto';const root=await prepareFixtureOwnership(${JSON.stringify(repository)},${JSON.stringify(run)});await registerFixtureIdentity(${JSON.stringify(repository)},${JSON.stringify(run)},{projectId:randomUUID(),taskId:randomUUID(),workerId:randomUUID(),userId:randomUUID(),serverOrigin:'https://example.test',repository:root+'/repository'});await startOwnedFixture({repository:${JSON.stringify(repository)},runDirectory:${JSON.stringify(run)},command:process.execPath,args:['-e',${JSON.stringify(worker)}],options:{cwd:root,timeoutMs:30000,onOutput:()=>{}}});setInterval(()=>{},1000);`;
  const source = `import {initializeRunOwnership,startOwnedPlaywright} from ${JSON.stringify(ownerModule)};await initializeRunOwnership(${JSON.stringify(repository)},${JSON.stringify(run)});await startOwnedPlaywright({repository:${JSON.stringify(repository)},runDirectory:${JSON.stringify(run)},command:process.execPath,args:['--input-type=module','-e',${JSON.stringify(target)}],options:{cwd:${JSON.stringify(run)},timeoutMs:30000,onOutput:()=>{}}});setInterval(()=>{},1000);`;
  const runner = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "ignore", "ignore"] });
  const evidence = await import("../src/process-evidence.ts");
  let proof: Awaited<ReturnType<typeof evidence.captureProcessEvidence>> | undefined;
  try {
    await wait(async () => { try { return (await readFile(marker, "utf8")) !== ""; } catch { return false; } });
    proof = await evidence.captureProcessEvidence(Number(await readFile(marker, "utf8")));
    const owner = JSON.parse(await readFile(path.join(run, "results", "fixture-owner.json"), "utf8"));
    const receipt = await readGateReceipt(run, owner.fixture.launches[0].id);
    process.kill(receipt.leader.pid, "SIGKILL"); runner.kill("SIGKILL"); await once(runner, "exit");
    await assert.rejects(recoverRunOwnership({ repository, runDirectory: run, mode: "independent" }));
    const latest = JSON.parse(await readFile(path.join(run, "results", "fixture-owner.json"), "utf8"));
    assert.equal(latest.fixture.interrupted, true); assert.equal(latest.verified, false);
    assert.equal(await evidence.inspectProcessEvidence(proof), "running");
    await readFile(path.join(run, "results", "fixture-owner.json"));
  } finally {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
    if (proof) await evidence.stopEvidenceGroup(proof, [], Date.now() + 5_000);
    await rm(root, { recursive: true, force: true }); await rm(run, { recursive: true, force: true });
  }
});

test("recovery lock rejects concurrent ownership and releases after holder SIGKILL", async () => {
  const run = await create(), ownerModule = new URL("../src/fixture-owner.ts", import.meta.url).href;
  const setup = spawn(process.execPath, ["--input-type=module", "-e", `import {initializeRunOwnership} from ${JSON.stringify(ownerModule)};await initializeRunOwnership(${JSON.stringify(repository)},${JSON.stringify(run)});`], { stdio: "ignore" });
  await once(setup, "exit"); assert.equal(setup.exitCode, 0);
  const locker = spawn(process.execPath, ["--input-type=module", "-e", `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(path.join(run, "results", "fixture-owner-lock.sqlite"))});db.exec('BEGIN IMMEDIATE');process.stdout.write('READY');setInterval(()=>{},1000);`], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await once(locker.stdout, "data");
    await assert.rejects(recoverRunOwnership({ repository, runDirectory: run, mode: "independent" }));
    locker.kill("SIGKILL"); await once(locker, "exit");
    await recoverRunOwnership({ repository, runDirectory: run, mode: "independent" });
  } finally { if (locker.exitCode === null && locker.signalCode === null) locker.kill("SIGKILL"); await rm(run, { recursive: true, force: true }); }
});

test("concurrent auxiliary commands serialize ownership and a failed operation releases its turn", { timeout: 20_000 }, async () => {
  const run = await create(), exitFile = path.join(run, "exit");
  let playwright: ManagedCommand | undefined;
  const commands: ManagedCommand[] = [];
  try {
    await initializeRunOwnership(repository, run);
    playwright = await startOwnedPlaywright({ repository, runDirectory: run, command: process.execPath,
      args: ["-e", `const fs=require('fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(exitFile)}))process.exit(0)},20)`], options: { cwd: run, timeoutMs: 15_000, onOutput: () => {} } });
    const failed = registerFixtureClaim(repository, run, randomUUID());
    const launches = Array.from({ length: 6 }, (_, index) => startOwnedAuxiliary({ repository, runDirectory: run, command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(String(index))})`], options: { cwd: run, timeoutMs: 10_000, onOutput: () => {} } }));
    const results = await Promise.allSettled([failed, ...launches]);
    assert.equal(results[0]!.status, "rejected");
    for (const result of results.slice(1)) {
      assert.equal(result.status, "fulfilled");
      if (result.status === "fulfilled") commands.push(result.value as ManagedCommand);
    }
    const completed = await Promise.all(commands.map(command => command.finished));
    assert.deepEqual(completed.map(result => result.stdout), ["0", "1", "2", "3", "4", "5"]);
    assert.ok(completed.every(result => result.exitCode === 0));
    const owner = JSON.parse(await readFile(path.join(run, "results", "fixture-owner.json"), "utf8")) as { commands: { stopped: boolean }[] };
    assert.equal(owner.commands.length, 6);
    assert.ok(owner.commands.every(command => command.stopped));
    await writeFile(exitFile, "exit"); assert.equal((await playwright.finished).exitCode, 0);
    await recoverRunOwnership({ repository, runDirectory: run, mode: "owner" });
  } finally {
    await Promise.allSettled(commands.map(command => command.stop()));
    await playwright?.stop().catch(() => {});
    await rm(run, { recursive: true, force: true });
  }
});

test("detached browser after Playwright interruption prevents verified cleanup", async () => {
  const run = await create(), ownerModule = new URL("../src/fixture-owner.ts", import.meta.url).href, marker = path.join(run, "browser");
  const browser = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));setInterval(()=>{},1000);`;
  const source = `import {initializeRunOwnership,startOwnedPlaywright} from ${JSON.stringify(ownerModule)};await initializeRunOwnership(${JSON.stringify(repository)},${JSON.stringify(run)});await startOwnedPlaywright({repository:${JSON.stringify(repository)},runDirectory:${JSON.stringify(run)},command:process.execPath,args:['-e',${JSON.stringify(browser)}],options:{cwd:${JSON.stringify(run)},timeoutMs:30000,onOutput:()=>{}}});setInterval(()=>{},1000);`;
  const runner = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "ignore", "ignore"] });
  const evidence = await import("../src/process-evidence.ts");
  let proof: Awaited<ReturnType<typeof evidence.captureProcessEvidence>> | undefined;
  try {
    await wait(async () => { try { return (await readFile(marker, "utf8")) !== ""; } catch { return false; } });
    proof = await evidence.captureProcessEvidence(Number(await readFile(marker, "utf8")));
    runner.kill("SIGKILL"); await once(runner, "exit");
    await assert.rejects(recoverRunOwnership({ repository, runDirectory: run, mode: "independent" }), /browser stop is unconfirmed/);
    assert.equal(await evidence.inspectProcessEvidence(proof), "running");
    assert.equal(JSON.parse(await readFile(path.join(run, "results", "fixture-owner.json"), "utf8")).verified, false);
  } finally {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
    if (proof) await evidence.stopEvidenceGroup(proof, [], Date.now() + 5_000);
    await rm(run, { recursive: true, force: true });
  }
});

test("successful Playwright completion records browser cleanup and remains idempotently recoverable", async () => {
  const { startOwnedPlaywright } = await import("../src/fixture-owner.ts");
  const run = await create();
  try {
    await initializeRunOwnership(repository, run);
    const gate = await startOwnedPlaywright({ repository, runDirectory: run, command: process.execPath, args: ["-e", "process.exitCode=0"], options: { cwd: run, timeoutMs: 5_000, onOutput: () => {} } });
    assert.equal((await gate.finished).exitCode, 0);
    await recoverRunOwnership({ repository, runDirectory: run, mode: "owner" });
    await recoverRunOwnership({ repository, runDirectory: run, mode: "owner" });
    assert.equal(JSON.parse(await readFile(path.join(run, "results", "fixture-owner.json"), "utf8")).verified, true);
  } finally { await rm(run, { recursive: true, force: true }); }
});

test("normal Worker SIGINT is forwarded through both gates and recorded only after exit zero", async () => {
  const { prepareFixtureOwnership, registerFixtureIdentity, startOwnedFixture, markFixtureStopped } = await import("../src/fixture-owner.ts");
  const { stopFixtureWorker } = await import("../src/worker-cleanup.ts");
  const run = await create(), root = path.join(repository, ".tmp", "product-e2e-retained", path.basename(run));
  try {
    await initializeRunOwnership(repository, run);
    const file = path.join(run, "results", "fixture-owner.json"), value = JSON.parse(await readFile(file, "utf8"));
    value.playwright = { id: randomUUID(), stopped: false }; await writeFile(file, JSON.stringify(value));
    await prepareFixtureOwnership(repository, run);
    await registerFixtureIdentity(repository, run, { projectId: randomUUID(), taskId: randomUUID(), workerId: randomUUID(), userId: randomUUID(), serverOrigin: "https://example.test", repository: path.join(root, "repository") });
    let ready!: () => void; const announced = new Promise<void>(resolve => { ready = resolve; });
    const gate = await startOwnedFixture({ repository, runDirectory: run, command: process.execPath, args: ["-e", "process.on('SIGINT',()=>process.exit(0));process.stdout.write('READY');setInterval(()=>{},1000)"], options: { cwd: run, timeoutMs: 5_000, onOutput: (_channel, chunk) => { if (chunk.includes('READY')) ready(); } } });
    await announced; await stopFixtureWorker(gate, false); await markFixtureStopped(repository, run);
    assert.equal(JSON.parse(await readFile(file, "utf8")).fixture.launches[0].stopped, true);
  } finally { await rm(root, { recursive: true, force: true }); await rm(run, { recursive: true, force: true }); }
});

test("gate setup and unconfirmed cleanup preserve both failures", async () => {
  const run = await create();
  try {
    await rm(path.join(run, "results"), { recursive: true, force: true });
    await assert.rejects(startGatedCommand({ runDirectory: run, gateId: randomUUID(), command: process.execPath,
      args: ["-e", "process.exit(0)"], options: { cwd: run, timeoutMs: 5_000, onOutput: () => {} } }), error => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.some((failure: unknown) => failure instanceof Error && "code" in failure && failure.code === "ENOENT"));
      assert.ok(error.errors.some((failure: unknown) => failure instanceof Error && /stop was not confirmed/.test(failure.message)));
      return true;
    });
  } finally { await rm(run, { recursive: true, force: true }); }
});

test("gated target signal is retained separately from the gate exit", async () => {
  const run = await create(), gateId = randomUUID();
  try {
    const gate = await startGatedCommand({ runDirectory: run, gateId, command: process.execPath,
      args: ["-e", "process.stderr.write('target evidence');process.kill(process.pid,'SIGTERM')"], options: { cwd: run, timeoutMs: 5_000, onOutput: () => {} } });
    const result = await gate.finished;
    assert.equal(result.exitCode, 1);
    assert.deepEqual(gate.diagnostics().targetExit, { code: null, signal: "SIGTERM" });
    assert.match(gate.diagnostics().stderr, /target evidence/);
  } finally { await rm(run, { recursive: true, force: true }); }
});

test("inner gate cannot launch its target when the proof writer disappears before authorization", async () => {
  const run = await create(), marker = path.join(run, "started"), gatePath = path.resolve(import.meta.dirname, "../src/gated-target.mjs");
  const gate = spawn(process.execPath, [gatePath, process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'started')`], { stdio: ["pipe", "ignore", "ignore"] });
  try { gate.stdin.end(); await once(gate, "exit"); await assert.rejects(readFile(marker), { code: "ENOENT" }); }
  finally { if (gate.exitCode === null && gate.signalCode === null) gate.kill("SIGKILL"); await rm(run, { recursive: true, force: true }); }
});
