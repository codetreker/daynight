import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const input = JSON.parse(readFileSync(0, "utf8"));
const moduleAt = name => import(pathToFileURL(path.join(process.argv[2], name)).href);
const { createWorkerRemote } = await moduleAt("commands/worker/remote.js");
const { createWorkerReporter } = await moduleAt("commands/worker/reporter.js");
const { createApiClient } = await moduleAt("api/client.js");
const { createOperation } = await moduleAt("api/operation.js");
const signal = new AbortController().signal;
const remote = createWorkerRemote({ serverUrl: input.serverUrl, serverToken: input.aliceToken });
assert.equal(await remote.currentUserId(signal), input.aliceId);
const workerId = randomUUID();
const projects = [input.a, input.b].map(project => ({ projectId: project.id, repoUrl: project.repoUrl, localPath: "/fixture" }));
const http = async (token, method, url, body, status) => {
  const response = await fetch(input.serverUrl + url, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.status, status);
  return status === 204 ? undefined : await response.json();
};
const getTask = id => remote.readTask(input.a.id, id, signal);
const descriptor = () => ({ claimId: randomUUID(), workerId, worktreeId: randomUUID(), machine: { id: randomUUID(), name: "Fixture" }, platform: "linux", agent: "codex" });
const a = await getTask(input.aTaskId);
const aClaim = await remote.claim(a, descriptor(), signal);
const initial = await remote.ownInventory(projects, workerId, signal);
assert.deepEqual([...initial.coveredProjectIds].sort(), [input.a.id, input.b.id].sort());
assert.equal(initial.tasks[0].id, a.id);
const stamp = new Date().toISOString();
const telemetry = { machine: { id: randomUUID(), name: "Fixture" }, platform: "linux", workingDirectory: "/fixture", sampledAt: stamp,
  os: { state: "ok", checkedAt: stamp, value: { type: "Linux", release: "6", version: "fixture", arch: "x64" } },
  cpu: { state: "ok", checkedAt: stamp, value: { model: "fixture", logicalProcessors: 1, usagePercent: 0 } },
  memory: { state: "ok", checkedAt: stamp, value: { usedBytes: 1, totalBytes: 2 } },
  disk: { state: "ok", checkedAt: stamp, value: { availableBytes: 1, totalBytes: 2 } },
  versions: { daynight: input.packageVersion, herdr: { state: "not_running", checkedAt: stamp }, codex: { state: "not_installed", checkedAt: stamp }, copilot: { state: "not_installed", checkedAt: stamp } } };
const reports = [];
const reporter = createWorkerReporter({ signal, collect: async () => ({ telemetry, issues: [] }), send: async (value, operation) => { const receipt = await remote.report(workerId, value, operation); reports.push(value); return receipt; }, emit: event => { throw new Error(`report failed: ${event.kind}`); } });
const wait = async predicate => { const deadline = Date.now() + 5000; while (!predicate()) { if (Date.now() > deadline) throw new Error("report timed out"); await new Promise(resolve => setTimeout(resolve, 10)); } };
const publish = result => reporter.publishInventory({ observedAt: new Date().toISOString(), claims: result.tasks.map(task => ({ projectId: task.projectId, taskId: task.id, claimId: task.properties.worker.claimId })) });
try {
  publish(initial);
  await wait(() => reports.some(report => report.taskInventory?.claims.some(claim => claim.taskId === a.id)));
  await http(input.bobToken, "DELETE", `/api/v1/projects/${input.a.id}/members/${input.aliceId}`, { version: input.grantVersion, expectedUserId: input.bobId }, 204);
  const partial = await remote.ownInventory(projects, workerId, signal);
  assert.deepEqual([...partial.coveredProjectIds], [input.b.id]);
  assert.deepEqual([...partial.unavailableProjectIds], [input.a.id]);
  assert.deepEqual(partial.tasks, []);
  const partialStart = reports.length;
  reporter.publishInventory(null);
  await assert.rejects(remote.resolveProject({ repoUrl: input.a.repoUrl, projectId: input.a.id }, signal), error => error.status === 404);
  const candidates = [];
  for await (const candidate of remote.candidates(input.b.id, "linux", signal)) candidates.push(candidate);
  assert.equal(candidates.length, 1);
  const claimed = await remote.claim(candidates[0], descriptor(), signal);
  reporter.recordClaim({ projectId: claimed.projectId, taskId: claimed.id, claimId: claimed.properties.worker.claimId });
  await wait(() => reports.slice(partialStart).some(report => report.taskInventory === null));
  assert.equal(reports.at(-1).taskInventory, null);
  // The deterministic fixture agent completes exactly the granted claim against the real service.
  const operation = createOperation();
  try { await createApiClient({ serverUrl: input.serverUrl, serverToken: input.aliceToken, expectedUserId: input.aliceId, operation }).completeWorkerTask(claimed.projectId, claimed.id, { version: claimed.version, claimId: claimed.properties.worker.claimId }); }
  finally { operation.dispose(); }
  const invitation = await http(input.bobToken, "POST", `/api/v1/projects/${input.a.id}/invitations`, { expectedUserId: input.bobId }, 201);
  await http(input.aliceToken, "POST", "/api/v1/invitations/accept", { token: new URL(invitation.link).hash.slice(1), expectedUserId: input.aliceId }, 200);
  const restored = await remote.ownInventory(projects, workerId, signal);
  assert.deepEqual([...restored.coveredProjectIds].sort(), [input.a.id, input.b.id].sort());
  assert.equal(restored.unavailableProjectIds.length, 0);
  assert.deepEqual(restored.tasks.map(task => task.properties.worker.claimId), [aClaim.properties.worker.claimId]);
  publish(restored);
  await wait(() => reports.at(-1).taskInventory?.claims.some(claim => claim.claimId === aClaim.properties.worker.claimId));
  process.stdout.write("real-service-worker-isolation-ok\n");
} finally { await reporter.stop(); }
