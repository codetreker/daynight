import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createAcceptanceCli } from "../fixtures/acceptance-cli.js";

it("retains future Worker configuration through an installed manager and cache restart", async () => {
  const fixture = await createAcceptanceCli();
  try {
    const cwd = path.join(fixture.receipt.root, "configuration runtime 中文");
    await mkdir(cwd);
    const installedDist = path.dirname(fixture.receipt.entryPath);
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", String.raw`
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [dist, directory] = process.argv.slice(1);
const { decodeWorkerCloudJsonSource, parseReceivedWorkerConfigurationResource } = await import(pathToFileURL(path.join(dist, "api/worker-configuration.js")).href);
const { createWorkerConfigurationManager } = await import(pathToFileURL(path.join(dist, "commands/worker/configuration.js")).href);
const desiredJson = '{"revision":"1","updatedAt":"2026-11-17T00:00:00Z","value":{"maxConcurrent":2,"pollIntervalMs":1500,"recoveryLimit":3,"preferPlatformSpecificTasks":false,"native":{"agent":"codex","model":null,"args":[]},"projects":[],"toolPaths":{"codex":{"kind":"auto"},"copilot":{"kind":"auto"}},"future":{"integer":900719925474099312345,"nested":[null,true,-1.25,1e1000]}}}';
const observationJson = '{"baseRevision":"0","desiredRevision":"1","reportedAt":"2026-11-17T00:00:01Z","items":[{"key":{"kind":"future"},"targetRevision":"1","appliedValue":{"integer":900719925474099312345},"state":"applied","error":null,"lastFailure":null,"nextAttemptAt":null}]}';
const resource = parseReceivedWorkerConfigurationResource(decodeWorkerCloudJsonSource('{"desired":' + desiredJson + ',"observationRevision":"1","observation":' + observationJson + '}'));
const identity = { serverOrigin: "https://daynight.example", userId: "00000000-0000-4000-8000-000000000001", workerId: "00000000-0000-4000-8000-000000000002" };
const file = path.join(directory, "worker", "configuration.json");
let nativeApplications = 0;
const options = { file, identity, signal: new AbortController().signal, applyNative: async () => { nativeApplications++; } };
let manager;
try {
  manager = await createWorkerConfigurationManager(options);
  await manager.receive(resource.desired, resource.observationRevision, undefined, undefined, { observationRevision: resource.observationRevision, json: resource.observationJson });
  await manager.settle();
  await manager.stop();
  manager = undefined;
  const persisted = JSON.parse(await readFile(file, "utf8"));
  assert.equal(persisted.schemaVersion, 13);
  const native = persisted.currentItems.find(item => item.value.key.kind === "native");
  assert.equal(native.value.state, "applied");
  assert.deepEqual(native.value.appliedValue, { agent: "codex", model: null, args: [] });
  assert.equal(native.actualSource.recordId, native.recordId);
  assert.equal(persisted.currentItems.some(item => item.value.key.kind === "agentControlMode"), false);
  assert.equal(nativeApplications, 1);
  assert.equal(persisted.authority.desiredJson, desiredJson);
  assert.deepEqual(persisted.remoteObservation, { observationRevision: "1", json: observationJson });
  manager = await createWorkerConfigurationManager(options);
  assert.equal(manager.current().desired.revision, "1");
  assert.equal(Object.hasOwn(manager.current().desired.value, "future"), false);
  assert.equal(manager.current().effective.native, null);
  await manager.receive(resource.desired, resource.observationRevision);
  await manager.settle();
  const report = manager.report();
  assert.equal(report.observation.desiredRevision, "1");
  assert.ok(report.observation.items.length > 0);
  assert.ok(report.observation.items.some(item => item.key.kind === "native" && item.state === "applied" && item.appliedValue.agent === "codex"));
  assert.ok(report.observation.items.every(item => item.key.kind !== "agentControlMode"));
  assert.equal(nativeApplications, 2);
  assert.ok(report.observation.items.every(item => item.key.kind !== "future"));
  const reopened = JSON.parse(await readFile(file, "utf8"));
  assert.equal(reopened.authority.desiredJson, desiredJson);
  assert.deepEqual(reopened.remoteObservation, persisted.remoteObservation);
} finally {
  if (manager !== undefined) await manager.stop();
}
`, installedDist, cwd], { cwd, encoding: "utf8", timeout: 30_000, windowsHide: true });
    if (result.error !== undefined) throw result.error;
    expect(result.status, result.stderr).toBe(0);
  } finally { await fixture.cleanup(); }
});
