import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { browserCommandOptions } from "../src/browser.ts";
import { initializeRunOwnership, startOwnedPlaywright } from "../src/fixture-owner.ts";
import { inspectProcessEvidence, stopEvidenceGroup, type ProcessEvidence } from "../src/process-evidence.ts";
import { markBuildComplete, resourceIdentity, writeCleanupReceipt } from "../src/recovery.ts";
import { completeCompatEnvironmentSetup, finalizeCompatEnvironment } from "../src/subtask-compat-boundary.ts";

const repository = path.resolve(import.meta.dirname, "../../..");

test("real bootstrap Chromium interrupted during a stalled auth request is stopped before environment cleanup", { timeout: 60_000 }, async () => {
  const run = path.join(repository, ".tmp", "product-e2e", randomUUID());
  await mkdir(path.join(run, "private"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(run, "results")); await mkdir(path.join(run, "artifacts"));
  let arrived!: () => void;
  const requestStarted = new Promise<void>(resolve => { arrived = resolve; });
  const server = createServer((request, response) => {
    if (request.url === "/console/") { arrived(); return; }
    response.writeHead(404); response.end();
  });
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  let proof: ProcessEvidence | undefined, completed = false;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture auth listener unavailable.");
    await writeFile(path.join(run, "environment.json"), JSON.stringify({ baseURL: "https://app.daynight.localhost:1", authURL: `http://127.0.0.1:${address.port}`, proxyURL: "http://127.0.0.1:1" }), { mode: 0o600 });
    await initializeRunOwnership(repository, run); await markBuildComplete(run);
    const runId = randomUUID(), owner = await stat(run);
    const receipt = { schemaVersion: 1 as const, runId, directoryId: path.basename(run), ownerUid: owner.uid, ownerGid: owner.gid, resourceIdentity: resourceIdentity(runId), state: "pending" as const, verified: false, resourcesAbsent: false, remaining: [], verificationErrors: [], cleanupErrors: [] };
    await writeCleanupReceipt(run, receipt); await completeCompatEnvironmentSetup(run);
    const abort = new AbortController(), options = browserCommandOptions(run);
    const command = await startOwnedPlaywright({ repository, runDirectory: run, command: process.execPath, args: [path.join(repository, "packages/e2e_tests/src/subtask-compat-session.ts")], options: {
      ...options, env: { ...options.env, DAYNIGHT_E2E_RUN_DIRECTORY: run }, signal: abort.signal, timeoutMs: 30_000, onOutput: () => {},
    } });
    await Promise.race([requestStarted, command.finished.then(() => { throw new Error("Bootstrap exited before the auth request."); })]);
    const registry = JSON.parse(await readFile(path.join(run, "results", "browser-ownership.json"), "utf8")) as { scopes: { proof: ProcessEvidence | null }[] };
    proof = registry.scopes[0]?.proof ?? undefined;
    if (!proof) throw new Error("Original bootstrap browser proof is unavailable.");
    assert.equal(await inspectProcessEvidence(proof), "running");
    abort.abort(new Error("test interruption"));
    await assert.rejects(command.finished, /test interruption/);
    try { await command.stop(); } catch { /* The original cancellation remains the result. */ }
    const environment = { close: async () => {
      const ownerRecord = JSON.parse(await readFile(path.join(run, "results", "fixture-owner.json"), "utf8")) as { verified: boolean };
      assert.equal(ownerRecord.verified, true);
      assert.equal(await inspectProcessEvidence(proof!), "stopped");
      await writeCleanupReceipt(run, { ...receipt, state: "complete", verified: true, resourcesAbsent: true });
    } };
    const cleanup = await finalizeCompatEnvironment({ repository, runDirectory: run, environment, environmentComplete: true, preparingEnvironment: true, buildComplete: true });
    assert.deepEqual(cleanup.failures, []); assert.equal(cleanup.completed, true); assert.equal(cleanup.receipt?.verified, true);
    assert.equal(await inspectProcessEvidence(proof), "stopped");
    assert.equal(JSON.parse(await readFile(path.join(run, "results", "environment-complete.json"), "utf8")).complete, true);
    completed = true;
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (proof && await inspectProcessEvidence(proof) === "running") await stopEvidenceGroup(proof, [], Date.now() + 10_000);
    if (completed) await rm(run, { recursive: true, force: true });
    else console.error(`Unconfirmed browser fixture retained: ${run}`);
  }
});
