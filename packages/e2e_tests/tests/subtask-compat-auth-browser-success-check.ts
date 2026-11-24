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

test("bootstrap credentials are handed off only after the original browser stop is recorded", { timeout: 60_000 }, async () => {
  const run = path.join(repository, ".tmp", "product-e2e", randomUUID());
  await mkdir(path.join(run, "private"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(run, "results")); await mkdir(path.join(run, "artifacts"));
  const secret = `fixture-secret-${randomUUID()}`;
  const server = createServer((request, response) => {
    if (request.url === "/console/") {
      response.setHeader("Content-Type", "text/html");
      response.end(request.headers.cookie?.includes("fixture=ready") ? "<html><body>Console</body></html>" : '<html><body><button onclick="location.href=\'/provider\'">Continue with GitHub</button></body></html>');
    } else if (request.url === "/provider") {
      response.setHeader("Content-Type", "text/html");
      response.end('<html><body><button onclick="location.href=\'/finish\'">Authorize local identity</button></body></html>');
    } else if (request.url === "/finish") {
      response.writeHead(302, { Location: "/console/", "Set-Cookie": "fixture=ready; Path=/" }); response.end();
    } else if (request.url === "/console/api/session") {
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ csrf_token: "fixture-csrf" }));
    } else if (request.url === "/console/api/apps" && request.method === "POST") {
      request.resume(); request.once("end", () => { response.writeHead(201, { "Content-Type": "application/json" }); response.end(JSON.stringify({ app: { id: "fixture-app" }, secret })); });
    } else { response.writeHead(404); response.end(); }
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
    const credentials = path.join(run, "private", "bootstrap-credentials.json"), deadline = Date.now() + 20_000;
    while (true) {
      try { await stat(credentials); break; }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || Date.now() >= deadline) throw error; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.deepEqual(JSON.parse(await readFile(credentials, "utf8")), { appId: "fixture-app", appSecret: secret });
    assert.equal((await stat(credentials)).mode & 0o077, 0);
    const registry = JSON.parse(await readFile(path.join(run, "results", "browser-ownership.json"), "utf8")) as { scopes: { proof: ProcessEvidence | null; stopped: boolean }[] };
    proof = registry.scopes[0]?.proof ?? undefined;
    if (!proof) throw new Error("Original bootstrap browser proof is unavailable.");
    assert.equal(registry.scopes[0]?.stopped, true); assert.equal(await inspectProcessEvidence(proof), "stopped");
    assert.doesNotMatch(await readFile(path.join(run, "results", "auth-bootstrap.json"), "utf8"), /fixture-secret|fixture-csrf/);
    abort.abort(new Error("test interruption")); await assert.rejects(command.finished, /test interruption/);
    try { await command.stop(); } catch { /* The original cancellation remains the result. */ }
    const cleanup = await finalizeCompatEnvironment({ repository, runDirectory: run, environment: { close: async () => await writeCleanupReceipt(run, { ...receipt, state: "complete", verified: true, resourcesAbsent: true }) }, environmentComplete: true, preparingEnvironment: true, buildComplete: true });
    assert.deepEqual(cleanup.failures, []); assert.equal(cleanup.completed, true); assert.equal(cleanup.receipt?.verified, true);
    await assert.rejects(stat(credentials), { code: "ENOENT" });
    completed = true;
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (proof && await inspectProcessEvidence(proof) === "running") await stopEvidenceGroup(proof, [], Date.now() + 10_000);
    if (completed) await rm(run, { recursive: true, force: true });
    else console.error(`Unconfirmed browser fixture retained: ${run}`);
  }
});
