import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Environment, RunCommand } from "./external-image-harness/auth.js";
import type { ControllerLaunchTicket } from "../src/commands/controller/launch-ticket.js";
import type { MarkdownCaptureRecord } from "../src/commands/controller/markdown/coordinator.js";
import type { ImageCaptureReceipt } from "../src/session/image-values.js";

const repository = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const parsed = parseArgs({ options: { "run-directory": { type: "string" }, cleanup: { type: "boolean", default: false } } });
// Network mutations are confined to disposable, standard hosted Linux VMs.
assert.equal(process.platform, "linux", "External source regression requires a Linux hosted VM.");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(await realpath(process.env.GITHUB_WORKSPACE!), await realpath(repository));
assert(parsed.values["run-directory"] && path.isAbsolute(parsed.values["run-directory"]));
const runDirectory = path.resolve(parsed.values["run-directory"]);
assert(runDirectory.startsWith(path.join(repository, ".tmp", "external-image-acceptance") + path.sep));
const results = path.join(runDirectory, "results"), privateDirectory = path.join(runDirectory, "private");
const networkDirectory = path.join(privateDirectory, "network");
const networkScript = path.join(repository, "packages/daynight/scripts/external-image-network.sh");
const harness = path.join(repository, "packages/daynight/scripts/external-image-harness");
const preserve = "--preserve-env=GITHUB_ACTIONS,RUNNER_ENVIRONMENT,GITHUB_WORKSPACE,GITHUB_RUN_ID,GITHUB_RUN_ATTEMPT";
const sourceURLs: [string, string] = ["http://httpbin.org/image/png", "https://httpbin.org/image/png"];
type CommandResult = Awaited<ReturnType<RunCommand>>;
type ManagedCommand = { readonly pid: number; finished: Promise<CommandResult>; stop(): Promise<void> };
type RunRecord = { schemaVersion: 1; runtimeDirectory: string; phase: "build" | "environment"; ownerUid: number; ownerGid: number; githubRunId: string; githubRunAttempt: string };
const e2e = async <T>(name: string): Promise<T> => import(new URL(`../../e2e_tests/src/${name}.ts`, import.meta.url).href) as Promise<T>;
const { runCommand, startCommand } = await e2e<{ runCommand: RunCommand; startCommand(command: string, args: readonly string[], options: Parameters<RunCommand>[2]): ManagedCommand }>("command");
const { recoverEnvironment } = await e2e<{ recoverEnvironment(options: { repository: string; runDirectory: string; phase: "build" | "environment" }): Promise<void> }>("recovery");
const exists = async (filename: string): Promise<boolean> => {
  try { await stat(filename); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};
const persist = async (filename: string, value: unknown): Promise<void> => {
  await writeFile(`${filename}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(`${filename}.tmp`, filename);
};
const networkArgs = (operation: string, extra: string[] = []) => [preserve, "bash", networkScript, operation, networkDirectory, ...extra];
const network = async (operation: string, extra: string[] = []): Promise<CommandResult> => runCommand("sudo", networkArgs(operation, extra), {
  cwd: repository, env: process.env, timeoutMs: operation === "setup" ? 90_000 : 30_000,
});
const copyNetworkEvidence = async (): Promise<void> => {
  if (!await exists(networkDirectory)) return;
  const target = path.join(results, "network"); await mkdir(target, { recursive: true });
  for (const name of await readdir(networkDirectory)) {
    if (name === "ownership.json" || !/^(?:network.*\.json|service-assets\.json|deployment-assets\.json|translation-verification\.json|sources-blocked\.json|policy.*\.nft)$/.test(name)) continue;
    await copyFile(path.join(networkDirectory, name), path.join(target, name));
  }
};
const loadRun = async (): Promise<RunRecord> => {
  assert.equal(await realpath(runDirectory), runDirectory);
  const record = JSON.parse(await readFile(path.join(runDirectory, "run.json"), "utf8")) as RunRecord;
  const owner = await stat(runDirectory);
  assert.equal(record.schemaVersion, 1); assert.equal(record.ownerUid, owner.uid); assert.equal(record.ownerGid, owner.gid);
  assert.equal(record.githubRunId, process.env.GITHUB_RUN_ID); assert.equal(record.githubRunAttempt, process.env.GITHUB_RUN_ATTEMPT ?? "1");
  assert.equal(path.dirname(record.runtimeDirectory), path.join(repository, ".tmp/product-e2e"));
  assert.match(path.basename(record.runtimeDirectory), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return record;
};
const recover = async (): Promise<void> => {
  if (!await exists(path.join(runDirectory, "run.json"))) return;
  const record = await loadRun(), errors: unknown[] = [];
  try { await network("cleanup"); } catch (error) { errors.push(error); }
  try { await copyNetworkEvidence(); } catch (error) { errors.push(error); }
  try {
    await recoverEnvironment({ repository, runDirectory: record.runtimeDirectory, phase: record.phase });
    const receipt = path.join(record.runtimeDirectory, "results/environment-cleanup.json");
    if (await exists(receipt)) await copyFile(receipt, path.join(results, "environment-cleanup.json"));
  } catch (error) { errors.push(error); }
  if (!errors.length) await rm(privateDirectory, { recursive: true, force: true });
  await persist(path.join(results, "independent-cleanup.json"), { verified: errors.length === 0, finishedAt: new Date().toISOString(), failures: errors.map(String) });
  if (errors.length) throw new AggregateError(errors, "External image regression recovery failed.");
};
if (parsed.values.cleanup) { await recover(); process.exit(0); }

await mkdir(results, { recursive: true }); await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
assert.equal(await realpath(runDirectory), runDirectory);
assert(!await exists(path.join(runDirectory, "run.json")), "A run identity cannot be reused.");
const runtimeDirectory = path.join(repository, ".tmp/product-e2e", randomUUID());
await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
await mkdir(path.join(runtimeDirectory, "results")); await mkdir(path.join(runtimeDirectory, "private"), { mode: 0o700 });
const owner = await stat(runDirectory);
const record: RunRecord = { schemaVersion: 1, runtimeDirectory, phase: "build", ownerUid: owner.uid, ownerGid: owner.gid,
  githubRunId: process.env.GITHUB_RUN_ID!, githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "1" };
await persist(path.join(runDirectory, "run.json"), record);
const cancellation = new AbortController();
const interrupt = () => cancellation.abort(new Error("External image regression interrupted."));
process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
let environment: Environment | undefined, controller: ManagedCommand | undefined;
let forward: Awaited<ReturnType<typeof startForward>> | undefined;
const errors: unknown[] = [];
const manifest: Record<string, unknown> = { startedAt: new Date().toISOString(), status: "running", sourceURLs,
  scope: "external Markdown source integration regression", input: "controlled complete Markdown; no native model invocation", sourceTransport: "real public HTTP/HTTPS; production DNS, peer and certificate checks", service: "real isolated Go/PostgreSQL/UniAuth; controlled OAuth identity" };

async function startForward(target: string) {
  const destination = new URL(target), sockets = new Set<Socket>(); let accepted = 0;
  const listener = createServer(incoming => {
    accepted++;
    const outgoing = connect({ host: destination.hostname, port: Number(destination.port) });
    for (const socket of [incoming, outgoing]) {
      sockets.add(socket); socket.once("close", () => { sockets.delete(socket); });
      socket.once("error", () => { incoming.destroy(); outgoing.destroy(); });
    }
    incoming.pipe(outgoing).pipe(incoming);
    incoming.once("close", () => outgoing.destroy());
  });
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "0.0.0.0", resolve); });
  const address = listener.address(); assert(address && typeof address !== "string");
  return { port: address.port, accepted: () => accepted, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  } };
}
const load = async <T>(name: string): Promise<T> => import(new URL(`../dist/${name}.js`, import.meta.url).href) as Promise<T>;
try {
  console.log(`External image source regression: ${runDirectory}`);
  const { buildArtifacts } = await e2e<{ buildArtifacts(options: { repository: string; runDirectory: string; signal: AbortSignal }): Promise<{ directory: string; sourceRevision: string; sourceFingerprint: string; hashes: Record<string, string> }> }>("build");
  const artifacts = await buildArtifacts({ repository, runDirectory: runtimeDirectory, signal: cancellation.signal });
  manifest.artifacts = artifacts;
  const decoder = path.join(artifacts.directory, "image-validator");
  await runCommand(process.execPath, [path.join(repository, "packages/daynight/scripts/package-image-validation.ts"), decoder], { cwd: repository, signal: cancellation.signal, timeoutMs: 60_000 });
  manifest.decoder = Object.fromEntries(await Promise.all(["image-validation-helper.js", "image-validation-manifest.json"].map(async name => [name, createHash("sha256").update(await readFile(path.join(decoder, name))).digest("hex")])));
  // The existing environment owns the process. Its artifact wrapper supplies the
  // production decoder settings without changing shared E2E runtime behavior.
  const binary = path.join(artifacts.directory, "daynight-server");
  await rename(binary, `${binary}.bin`);
  await writeFile(binary, '#!/bin/sh\nset -eu\nexport DAYNIGHT_IMAGE_NODE_PATH=/usr/local/bin/node\nexport DAYNIGHT_IMAGE_HELPER_PATH=/opt/e2e/image-validator/image-validation-helper.js\nexport DAYNIGHT_IMAGE_MANIFEST_PATH=/opt/e2e/image-validator/image-validation-manifest.json\nexport DAYNIGHT_IMAGE_TEMP_DIRECTORY=/run/private/image-validation\nexec /opt/e2e/daynight-server.bin\n', { mode: 0o755 });
  await mkdir(path.join(runtimeDirectory, "private/image-validation"), { mode: 0o700 });
  const { startEnvironment } = await e2e<{ startEnvironment(options: { repository: string; runDirectory: string; artifactsDirectory: string; signal: AbortSignal }): Promise<Environment> }>("environment");
  record.phase = "environment"; await persist(path.join(runDirectory, "run.json"), record);
  environment = await startEnvironment({ repository, runDirectory: runtimeDirectory, artifactsDirectory: artifacts.directory, signal: cancellation.signal });
  manifest.resources = environment.resourceIdentity;
  const { authenticate } = await import(new URL("./external-image-harness/auth.ts", import.meta.url).href) as typeof import("./external-image-harness/auth.js");
  const identity = await authenticate({ environment, directory: privateDirectory, artifacts: artifacts.directory, repository, run: runCommand, signal: cancellation.signal });
  manifest.authentication = { userId: identity.userId, tokenId: identity.tokenId, provider: "isolated OAuth provider", certificateVerification: "explicit fixture CA; no TLS verification bypass" };
  forward = await startForward(environment.baseURL);
  await mkdir(networkDirectory, { mode: 0o700 });
  const assets = environment.resourceIdentity;
  await persist(path.join(networkDirectory, "service-assets.json"), {
    containerNames: [assets.applicationContainer, assets.postgresContainer],
    aliases: ["postgres", assets.applicationContainer, assets.postgresContainer],
    networkNames: [assets.network, assets.ingressNetwork],
  });
  const before = forward.accepted();
  await network("setup", [String(forward.port), ...sourceURLs]);
  const setupConnections = forward.accepted() - before; assert.equal(setupConnections, 1, "DNAT probe reached the protected control listener.");
  await persist(path.join(results, "control-listener.json"), { setupConnections, expectedControlProbeConnections: 1, translatedProbeConnections: setupConnections - 1 });
  const topology = JSON.parse(await readFile(path.join(networkDirectory, "network.json"), "utf8")) as { serviceOrigin: string; externalImages: unknown; sourceURLs: string[] };
  assert.deepEqual(topology.sourceURLs, sourceURLs);
  const request = async (target: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${environment!.baseURL}${target}`, { method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { authorization: `Bearer ${identity.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(15_000)]) });
    assert(response.ok, `Real service ${target} returned HTTP ${response.status}.`);
    return response.json();
  };
  const { SESSION_PROTOCOL } = await load<typeof import("../src/session/protocol.js")>("session/protocol");
  const { parseRegistrationResponse, parseControllerGrantResponse } = await load<typeof import("../src/session/controller-protocol.js")>("session/controller-protocol");
  const { writeLaunchTicket } = await load<typeof import("../src/commands/controller/launch-ticket.js")>("commands/controller/launch-ticket");
  const { writeControllerCredential } = await load<typeof import("../src/commands/worker/backends/session-api.js")>("commands/worker/backends/session-api");
  const home = path.join(privateDirectory, "controller-home"), stateDirectory = path.join(home, ".daynight"), cwd = path.join(privateDirectory, "work");
  for (const directory of [home, stateDirectory, cwd]) await mkdir(directory, { recursive: true, mode: 0o700 });
  process.env.DN_CONFIG_DIR = stateDirectory;
  await writeFile(path.join(stateDirectory, "config.yml"), `${JSON.stringify({ serverUrl: topology.serviceOrigin, controller: { externalImages: topology.externalImages } })}\n`, { mode: 0o600 });
  const executionId = randomUUID(), launchId = randomUUID(), controllerId = randomUUID(), controllerInstanceId = randomUUID();
  const registration = { protocol: SESSION_PROTOCOL, schemaVersion: 1, projectionVersion: 1, registrationId: randomUUID(), testExecutionId: executionId, controllerId, controllerInstanceId, provider: "codex", initialInput: "none" };
  const session = parseRegistrationResponse(await request("/api/v1/test-sessions", registration)).session;
  assert.equal(session.testExecutionId, executionId); assert.equal(session.identity.ownerUserId, identity.userId);
  assert.equal(session.identity.controllerId, controllerId); assert.equal(session.identity.controllerInstanceId, controllerInstanceId);
  const prefix = `/api/v1/test-sessions/${session.sessionId}`;
  const grant = parseControllerGrantResponse(await request(`${prefix}/controller-grant`, { protocol: SESSION_PROTOCOL, testExecutionId: executionId, controllerId, controllerInstanceId, executionGeneration: "1", kind: "bootstrap", previousGeneration: null, stopProof: null }));
  assert.equal(grant.sessionId, session.sessionId); assert.equal(grant.testExecutionId, executionId);
  const credentialFile = path.join(privateDirectory, "controller-grant.json"); await writeControllerCredential(credentialFile, grant);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId, executionId, controllerId, controllerInstanceId, sessionId: session.sessionId, executionGeneration: "1", testExecutionId: executionId, ownerUserId: identity.userId, initialInput: "none", serverOrigin: topology.serviceOrigin,
    provider: "codex", cwd, nativeHome: home, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 0 }, initialOperationId: randomUUID(), initialPrompt: "", resumeNativeSessionId: null,
    credentialFile, ipcEndpoint: path.join(privateDirectory, "unused-harness.sock"), ipcSecret: randomBytes(32).toString("hex"), createdAt: new Date().toISOString() };
  const ticketFile = await writeLaunchTicket(home, ticket);
  const { token: _token, ...publicGrant } = grant;
  await persist(path.join(results, "session-registration.json"), { registration, session, grant: publicGrant, launchId, ticketSHA256: createHash("sha256").update(await readFile(ticketFile)).digest("hex") });
  const controllerConfig = path.join(privateDirectory, "controller.json");
  await persist(controllerConfig, { home, launchId, directory: privateDirectory, results, sourceURLs });
  controller = startCommand("sudo", networkArgs("exec", ["--", "/usr/bin/env", `DN_CONFIG_DIR=${stateDirectory}`, process.execPath, path.join(harness, "controller.ts"), controllerConfig]), {
    cwd: repository, env: process.env, signal: cancellation.signal, timeoutMs: 300_000,
    onOutput: (channel, text) => { appendFileSync(path.join(results, `controller.${channel}.log`), text); process[channel].write(text); },
  });
  let controllerEnded = false, controllerFailure: unknown;
  void controller.finished.then(() => { controllerEnded = true; }, error => { controllerEnded = true; controllerFailure = error; });
  const commitDeadline = Date.now() + 150_000;
  while (!await exists(path.join(results, "controller-committed.json"))) {
    cancellation.signal.throwIfAborted();
    if (controllerEnded) throw controllerFailure ?? new Error("Controller exited before committed evidence.");
    assert(Date.now() < commitDeadline, "Original public captures did not commit.");
    await delay(100);
  }
  const committed = JSON.parse(await readFile(path.join(results, "controller-committed.json"), "utf8")) as {
    sessionId: string; captures: MarkdownCaptureRecord[];
    requests: { transport: "http" | "https"; actualPeer: string }[];
  };
  assert.equal(committed.sessionId, session.sessionId); assert.equal(committed.captures.length, 2);
  const receipts = committed.captures.map(item => item.receipt as ImageCaptureReceipt);
  assert(receipts.every(receipt => receipt.state === "committed" && receipt.resource));
  const readerPids = new Set<number>();
  const readOriginals = async (phase: string) => {
    const configuration = path.join(privateDirectory, `reader-${phase}.json`), result = path.join(results, `history-${phase}.json`);
    await persist(configuration, { origin: environment!.baseURL, token: identity.token, sessionId: session.sessionId, receipts, result, phase });
    await runCommand(process.execPath, [path.join(harness, "reader.ts"), configuration], { cwd: repository, signal: cancellation.signal, timeoutMs: 45_000 });
    const observed = JSON.parse(await readFile(result, "utf8")) as { readerPid: number; reads: unknown[] };
    assert(!readerPids.has(observed.readerPid)); readerPids.add(observed.readerPid);
    return observed.reads;
  };
  const original = await readOriginals("saved");
  await network("block-sources");
  const denial = [];
  const denyCounters = async (): Promise<{ httpPackets: number; httpsPackets: number }> => {
    await network("inspect");
    const observed = JSON.parse(await readFile(path.join(networkDirectory, "network-observed.json"), "utf8")) as { sourceDenyCounters: { httpPackets: number; httpsPackets: number } };
    assert(Number.isSafeInteger(observed.sourceDenyCounters.httpPackets)); assert(Number.isSafeInteger(observed.sourceDenyCounters.httpsPackets));
    return observed.sourceDenyCounters;
  };
  for (const url of sourceURLs) {
    const parsedURL = new URL(url), https = parsedURL.protocol === "https:", transport = https ? "https" : "http";
    const captured = committed.requests.find(request => request.transport === transport); assert(captured);
    const countersBefore = await denyCounters();
    const probe = await startCommand("sudo", networkArgs("exec", ["--", "/usr/bin/curl", "--silent", "--show-error", "--noproxy", "*", "--max-time", "8", "--resolve", `${parsedURL.hostname}:${https ? 443 : 80}:${captured.actualPeer}`, "--output", "/dev/null", "--write-out", "%{http_code}", url]), { cwd: repository, env: process.env, timeoutMs: 15_000, onOutput() {} }).finished;
    assert.notEqual(probe.exitCode, 0); assert.equal(probe.stdout, "000");
    const countersAfter = await denyCounters(), counter = https ? "httpsPackets" : "httpPackets";
    assert(countersAfter[counter] > countersBefore[counter], "The same source peer must hit the installed deny rule.");
    denial.push({ url, selectedAddress: captured.actualPeer, exitCode: probe.exitCode, httpStatus: probe.stdout, error: probe.stderr.trim(), countersBefore, countersAfter });
  }
  await persist(path.join(results, "source-denial.json"), { attempts: denial });
  await network("inspect");
  assert.deepEqual(await readOriginals("source-blocked"), original);
  await writeFile(path.join(privateDirectory, "stop"), "stop\n", { mode: 0o600 });
  let shutdownTimer: NodeJS.Timeout | undefined;
  const closed = await Promise.race([controller.finished, new Promise<never>((_resolve, reject) => {
    shutdownTimer = setTimeout(() => reject(new Error("Controller did not finish its original shutdown.")), 30_000);
  })]).finally(() => clearTimeout(shutdownTimer));
  assert.equal(closed.exitCode, 0); controller = undefined;
  const stopped = JSON.parse(await readFile(path.join(results, "controller-closed.json"), "utf8")) as { succeeded: boolean; requestCount: number };
  assert(stopped.succeeded); assert.equal(stopped.requestCount, 2);
  const disconnectDeadline = Date.now() + 10_000;
  let observed = parseRegistrationResponse(await request(prefix)).session;
  while (observed.connectionState !== "disconnected") { assert(Date.now() < disconnectDeadline); await delay(100); observed = parseRegistrationResponse(await request(prefix)).session; }
  await persist(path.join(results, "session-disconnected.json"), observed);
  assert.deepEqual(await readOriginals("controller-stopped"), original);
  manifest.status = "passed";
} catch (error) { errors.push(error); manifest.status = "failed"; }
finally {
  const cleanupErrors: unknown[] = [];
  if (controller) { try { await controller.stop(); } catch (error) { cleanupErrors.push(error); } }
  try { await network("cleanup"); } catch (error) { cleanupErrors.push(error); }
  try { await copyNetworkEvidence(); } catch (error) { cleanupErrors.push(error); }
  try { await forward?.close(); } catch (error) { cleanupErrors.push(error); }
  try { await environment?.close(); } catch (error) { cleanupErrors.push(error); }
  try {
    await recoverEnvironment({ repository, runDirectory: runtimeDirectory, phase: record.phase });
    const receipt = path.join(runtimeDirectory, "results/environment-cleanup.json");
    if (await exists(receipt)) await copyFile(receipt, path.join(results, "environment-cleanup.json"));
  } catch (error) { cleanupErrors.push(error); }
  if (!cleanupErrors.length) { try { await rm(privateDirectory, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); } }
  errors.push(...cleanupErrors);
  manifest.finishedAt = new Date().toISOString(); manifest.cleanupVerified = cleanupErrors.length === 0;
  manifest.failures = errors.map(String); if (errors.length) manifest.status = "failed";
  await persist(path.join(results, "manifest.json"), manifest);
  process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
}
if (errors.length) throw new AggregateError(errors, "External image source regression failed.");
console.log("External image source regression passed; owned runtime and network cleanup verified.");
