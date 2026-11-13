import { createOperation } from "../../../src/api/operation.js";
import { resolveToolLaunch } from "../../../src/platform/tool-executables.js";
import Database from "better-sqlite3";
import { createServer } from "node:http";
import { createWorkerBotHost } from "../../../src/commands/worker/bots/host.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import * as botEnvironment from "../../../src/commands/worker/bots/environment.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createBotDeletion } from "../../../src/commands/worker/bots/delete.js";
import type { BotDeletionReceipt } from "../../../src/commands/worker/bots/session-api.js";
import { resolveControllerIpcEndpoint } from "../../../src/commands/controller/paths.js";
import { createBotProcess } from "../../../src/commands/worker/bots/process.js";
import { openBotStore } from "../../../src/commands/worker/bots/store.js";
import { openBotExecutionStore } from "../../../src/commands/worker/bots/execution-store.js";
import type { BotDefinition, BotRecord, BotDeleted } from "../../../src/commands/worker/bots/types.js";
import { controllerExecutionDirectory, controllerTicketPath } from "../../../src/commands/controller/launch-ticket.js";
import { resolveConfigurationPaths } from "../../../src/config/paths.js";
import { readControllerSnapshot, readControllerOperation, readProvenWindowsStoppedControllerGeneration } from "../../../src/commands/controller/lifecycle-store.js";
import { requestController } from "../../../src/commands/controller/local-client.js";
import { confirmControllerProcessesStopped, inspectProcessProof, stopControllerProcesses, type ProcessProof } from "../../../src/commands/controller/process-proof.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import { acquireControllerJobLease, inspectControllerJob, releaseControllerJobLease, type ControllerJobLease } from "../../../src/commands/controller/windows-job.js";
import { createControllerJobLeases } from "../../../src/commands/worker/backends/controller-job-leases.js";
import { parseControllerMessage, RELAY_LIMITS } from "../../../src/session/controller-protocol.js";
import { SESSION_PROTOCOL, type SessionSnapshot } from "../../../src/session/protocol.js";
import snapshotFixture from "../../session/fixtures/snapshot.json" with { type: "json" };

// The subprocess uses the production Controller, native adapter, journal, IPC and
// relay. Only the Codex executable and the remote service are controlled fixtures.
const cleanups: (() => Promise<void>)[] = [];
const failureDiagnostics: (() => Promise<void>)[] = [];
// A Windows confirmation can join two 5-second identity queries and a 15-second
// Job Object query. Proof acquisition, cooperative stop, joined observation,
// escalation and failure diagnostics fit within this hook's separate budget.
const cleanupHookTimeout = 180_000;
const waitForProcessesStopped = async (controller: ProcessProof, native: readonly ProcessProof[], timeoutMs: number, lease?: ControllerJobLease): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await confirmControllerProcessesStopped(controller, native, deadline, lease)) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Original fixture processes did not stop within the observation window.");
    await delay(Math.min(100, remaining));
  }
};
const readEvidence = async (file: string) => {
  if (!existsSync(file)) return { file, exists: false };
  const handle = await open(file, "r");
  try {
    const bytes = Buffer.alloc(64 * 1024), metadata = await handle.stat();
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return { file, exists: true, text: bytes.subarray(0, bytesRead).toString("utf8"), truncated: metadata.size > bytesRead };
  } finally { await handle.close(); }
};
// Only fixed fixture processes are diagnosed here; no real service or provider
// credentials are part of these errors.
const diagnostic = (stage: string, elapsedMs: number, failure: unknown): void => {
  const describe = (value: unknown, depth = 0): unknown => {
    if (!(value instanceof Error) || depth > 4) return undefined;
    const fields = value as Error & { code?: unknown; signal?: unknown; killed?: unknown; stdout?: unknown; stderr?: unknown };
    return { name: fields.name, message: fields.message, code: fields.code, signal: fields.signal, killed: fields.killed,
      stdout: fields.stdout, stderr: fields.stderr, cause: describe(fields.cause, depth + 1) };
  };
  console.error(JSON.stringify({ fixture: "bot-process-integration", stage, elapsedMs, error: describe(failure) }));
};
const teardownIsolationDefaultTimeout = 100;
// Vitest captures the fallback deadline when the hook is registered. A short
// fallback keeps the isolation regression sensitive to a missing owner budget.
vi.setConfig({ hookTimeout: teardownIsolationDefaultTimeout });
try {
  afterEach(async ({ task }) => {
    const errors: unknown[] = [];
    const diagnostics = failureDiagnostics.splice(0);
    if (task.result?.state === "fail") for (const collect of diagnostics) try { await collect(); } catch (error) { errors.push(error); }
    for (const cleanup of cleanups.splice(0).reverse()) try { await cleanup(); } catch (error) { errors.push(error); }
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    if (errors.length) throw new AggregateError(errors, "Bot integration resources did not close safely.");
  }, cleanupHookTimeout);
} finally {
  vi.resetConfig();
}

// These adjacent cases exercise Vitest's actual hook scheduling. The first
// teardown crosses the hook's captured fallback deadline; the next case
// must retain both its environment and mock until its own teardown starts.
describe("fixture teardown isolation", { concurrent: false, shuffle: false }, () => {
  let teardownCompleted = false;
  const subject = { read: () => "original" };
  const home = path.resolve(import.meta.dirname, "../../../../../.tmp/bot-teardown-isolation");
  test("joins cleanup beyond the default hook deadline", () => {
    vi.stubEnv("DN_CONFIG_DIR", path.join(home, "first-state"));
    vi.spyOn(subject, "read").mockReturnValue("first");
    cleanups.push(async () => { await delay(300); teardownCompleted = true; });
  });
  test("keeps the next parent's ticket path aligned with its prepared child", async () => {
    const state = path.join(home, "second-state"), launchId = randomUUID();
    vi.stubEnv("DN_CONFIG_DIR", state);
    vi.spyOn(subject, "read").mockReturnValue("second");
    const preparedEnvironment = { ...process.env, DN_CONFIG_DIR: state };
    await delay(350);
    const childTicket = path.join(resolveConfigurationPaths(home, path, preparedEnvironment).stateDirectory, "controller", "launches", `${launchId}.json`);
    expect(controllerTicketPath(home, launchId)).toBe(childTicket);
    expect(subject.read()).toBe("second");
    expect(teardownCompleted).toBe(true);
  });
});

test("joins the final process observation before rejecting its expired window", async () => {
  let active = 0;
  vi.spyOn(processProof, "confirmControllerProcessesStopped").mockImplementation(async () => {
    active++;
    try { await delay(50); return false; } finally { active--; }
  });
  const proof = { pid: 1, parentPid: 1, processGroupId: 1, startedAt: "controlled", commandHash: "controlled" };
  await expect(waitForProcessesStopped(proof, [], 1)).rejects.toThrow("Original fixture processes did not stop within the observation window.");
  expect(active).toBe(0);
});

const fixture = async (options: { rejectRole?: boolean; args?: string[]; aliases?: boolean; hosted?: boolean; managedTools?: boolean } = {}) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/bot-process-integration");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")), state = path.join(home, "state"), cwd = path.join(home, "ordinary");
  await mkdir(cwd); vi.stubEnv("DN_CONFIG_DIR", state);
  const socketDirectory = process.platform === "win32" ? null : path.dirname(resolveControllerIpcEndpoint(home, "fixture"));
  const packageDirectory = path.join(home, "package"), dist = path.resolve(import.meta.dirname, "../../../dist");
  await mkdir(path.join(packageDirectory, "dist"), { recursive: true });
  const requestLog = path.join(home, "native-requests.jsonl"), launchLog = path.join(home, "controllers.jsonl"), nativeId = randomUUID();
  const nativeFixture = path.join(home, "codex-native.mjs");
  // The copied fixture runs outside this package's dependency tree.
  const nativeSource = (await readFile(path.resolve(import.meta.dirname, "../controller/fixtures/codex-native.mjs"), "utf8"))
    .replace("from 'better-sqlite3'", `from ${JSON.stringify(import.meta.resolve("better-sqlite3"))}`)
    .replaceAll("native-thread", nativeId);
  await writeFile(nativeFixture, nativeSource);
  const providerURL = pathToFileURL(path.join(dist, "commands/controller/providers/codex.js")).href;
  const runtimeURL = pathToFileURL(path.join(dist, "commands/controller/runtime.js")).href;
  const wrapper = path.join(packageDirectory, "provider.mjs"), wrapperURL = pathToFileURL(wrapper).href;
  await writeFile(wrapper, `import { openCodexProvider as open } from ${JSON.stringify(providerURL)};\nexport const openCodexProvider = options => open({ ...options, ...(options.toolLaunch ? {} : { executable: ${JSON.stringify(nativeFixture)} }) });\n`);
  await writeFile(path.join(packageDirectory, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(packageDirectory, "dist/main.js"), `
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (result.url === ${JSON.stringify(providerURL)} && context.parentURL !== ${JSON.stringify(wrapperURL)}) return { url: ${JSON.stringify(wrapperURL)}, shortCircuit: true };
  return result;
} });
appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + '\\n');
const { runController } = await import(${JSON.stringify(runtimeURL)});
await runController({ homeDirectory: ${JSON.stringify(home)}, provider: process.argv[3], launchId: process.argv[5] });
`);
  const http = options.hosted ? createServer() : null;
  const relay = http === null ? new WebSocketServer({ host: "127.0.0.1", port: 0 }) : new WebSocketServer({ server: http });
  if (http === null) await once(relay, "listening");
  else { http.listen(0, "127.0.0.1"); await once(http, "listening"); }
  const address = http?.address() ?? relay.address(); if (typeof address === "string" || address === null) throw new Error("Missing fixture relay address.");
  const owner = { serverOrigin: `http://127.0.0.1:${address.port}`, ownerUserId: randomUUID(), workerId: randomUUID() };
  const store = openBotStore(path.join(home, "worker.sqlite"), { onMigration: () => {} });
  const executions = openBotExecutionStore(path.join(home, "worker.sqlite"), { onMigration: () => {} });
  let bot: BotDefinition = { id: randomUUID(), ownerUserId: owner.ownerUserId, workerId: owner.workerId, version: "1", name: "Name only", creationOrder: "1", requestedOverrides: {},
    resolvedConfiguration: { workerId: owner.workerId, cwd, provider: "codex", model: null, args: options.args ?? [] }, roleConfiguration: null, sessionId: null, testExecutionId: null,
    startupResult: { state: "pending", code: null }, deletion: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  store.observe(owner, bot, Date.now());
  const current = () => store.get(owner, bot.id)!;
  const snapshot = (record: BotRecord): SessionSnapshot => {
    const { claimId: _claim, identity: _identity, ...baseSnapshot } = snapshotFixture;
    return { ...baseSnapshot, protocol: SESSION_PROTOCOL, schemaVersion: 1, projectionVersion: 1, testExecutionId: record.intent!.executionId, sessionId: bot.sessionId!, executionGeneration: record.intent!.executionGeneration, connectionEpoch: "1",
      identity: { ownerUserId: owner.ownerUserId, controllerId: record.intent!.registration.controllerId, controllerInstanceId: record.intent!.controllerInstanceId, provider: "codex", agentControlMode: "web", nativeSessionId: nativeId },
      initialInputState: "not_required", historyEpoch: "bot-fixture-history", lastEventSeq: "0", lastTimelineSeq: "0", lifecycle: "active", connectionState: "connected", synchronized: true, activity: "idle" };
  };
  const register = vi.fn(async (record: BotRecord) => {
    expect(record.intent?.roleConfiguration).not.toBeNull();
    bot = { ...bot, version: "2", sessionId: randomUUID(), testExecutionId: record.intent!.executionId, roleConfiguration: record.intent!.roleConfiguration };
    return { bot, snapshot: snapshot(record) };
  });
  const grant = vi.fn(async (record: BotRecord) => ({ token: "controlled-relay-grant", expiresAt: new Date(Date.now() + 900_000).toISOString(), sessionId: bot.sessionId!, testExecutionId: record.intent!.executionId, executionGeneration: record.intent!.executionGeneration, controllerId: record.intent!.registration.controllerId, controllerInstanceId: record.intent!.controllerInstanceId }));
  const api = { completeDeletion: async (): Promise<never> => { throw new Error("Unexpected deletion receipt"); }, register, grant, readSession: async (record: BotRecord) => snapshot(record), report: async () => bot };
  const prepareEnvironment = async () => {
    let aliasDirectory: string | null = null;
    if (options.aliases) {
      const aliases = path.join(state, "agent-cli-aliases"); await mkdir(aliases, { recursive: true });
      aliasDirectory = await mkdtemp(path.join(aliases, "execution-"));
      await writeFile(path.join(aliasDirectory, "fixture-shim"), "retained fixture shim");
    }
    const retained = aliasDirectory;
    return { environment: { ...process.env, DN_CONFIG_DIR: state, CODEX_HOME: path.join(home, "native"), CODEX_TEST_REQUEST_LOG: requestLog, EXPECT_WORKER_PERMISSIONS: "no", ...(options.rejectRole ? { CODEX_TEST_REJECT_ROLE: "Fixture role configuration refused" } : {}) }, aliasDirectory, bindings: [], release: async () => { if (retained !== null) await rm(retained, { recursive: true, force: true }); } };
  };
  const stopProcesses: typeof stopControllerProcesses = async (controller, native, deadline, lease) => {
    const started = Date.now();
    try { await stopControllerProcesses(controller, native, deadline, lease); }
    catch (error) {
      diagnostic("stop-original-processes", Date.now() - started, error);
      // Only inspect identities created by this fixture; retain the original
      // failure even if a diagnostic probe also fails.
      const identities = await Promise.all([controller, ...native].map(async proof => ({ pid: proof.pid, state: await inspectProcessProof(proof).catch(() => "unconfirmed") })));
      const jobMembers = controller.jobObjectName === undefined ? null : await inspectControllerJob(controller.jobObjectName).catch(() => "unconfirmed");
      console.error(JSON.stringify({ fixture: "bot-process-integration", stage: "stop-original-process-evidence", elapsedMs: Date.now() - started, deadlineExpired: Date.now() >= deadline, identities, jobMembers }));
      throw error;
    }
  };
  const toolReceipts = path.join(home, "tool-processes.jsonl"), toolEntries = { A: nativeFixture, B: path.join(home, "codex-B.mjs") };
  type ToolReceipt = { tool: "A" | "B"; pid: number; execPath: string; argv: string[]; cwd: string };
  const receipts = async (): Promise<ToolReceipt[]> => existsSync(toolReceipts) ? (await readFile(toolReceipts, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as ToolReceipt) : [];
  const probeEnvironment = { ...process.env, DN_CONFIG_DIR: state, CODEX_HOME: path.join(home, "probe-native"), CODEX_TEST_REQUEST_LOG: requestLog };
  let tools: ReturnType<typeof import("../../../src/commands/worker/tool-selection-runtime.js").createWorkerToolSelectionRuntime> | undefined;
  if (options.managedTools) {
    for (const [tool, entry] of Object.entries(toolEntries)) {
      const version = tool === "A" ? "1.10.1" : "1.20.2", model = `model-${tool}`;
      const header = `#!/usr/bin/env node
import { appendFileSync as recordTool } from 'node:fs';
recordTool(${JSON.stringify(toolReceipts)}, JSON.stringify({tool:${JSON.stringify(tool)},pid:process.pid,execPath:process.execPath,argv:process.argv,cwd:process.cwd()})+'\\n');
if (process.argv.includes('--version')) { console.log(${JSON.stringify(`codex-cli ${version}`)}); process.exit(0); }
if (process.argv.includes('--help')) { console.log('app-server --stdio'); process.exit(0); }
process.env.CODEX_TEST_MODELS = ${JSON.stringify(JSON.stringify([{ model, displayName: `Model ${tool}`, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low" }]))};
`;
      await writeFile(entry, header + nativeSource.replace("JSON.stringify(m)+'\\n'", `JSON.stringify({...m,fixtureTool:${JSON.stringify(tool)}})+'\\n'`));
      await chmod(entry, 0o755);
      const bin = path.join(home, `path-${tool}`); await mkdir(bin);
      if (process.platform === "win32") await writeFile(path.join(bin, "codex.cmd"), `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`);
      else await symlink(entry, path.join(bin, "codex"));
    }
    // Load compiled production modules so owned model probes execute their actual sibling entry points.
    const compiled = await import(pathToFileURL(path.join(dist, "commands/worker/tool-selection-runtime.js")).href) as typeof import("../../../src/commands/worker/tool-selection-runtime.js");
    tools = compiled.createWorkerToolSelectionRuntime({ workerDirectory: path.join(state, "worker"), cwd, environment: probeEnvironment,
      localToolPaths: { codex: { kind: "path", path: toolEntries.A }, copilot: { kind: "path", path: path.join(home, "missing-copilot") }, herdr: { kind: "auto" } }, readActiveSelections: () => [] });
  }
  const selectToolLaunch = vi.fn(async (_agent: "codex" | "copilot", signal: AbortSignal) => {
    if (tools !== undefined) return tools.selectToolLaunch("codex", signal);
    const operation = createOperation({ limits: { totalMs: 20_000 } });
    try { return await resolveToolLaunch({ tool: "codex", context: "web", choice: { kind: "path", path: nativeFixture }, environment: process.env, cwd }, operation); }
    finally { operation.dispose(); }
  });
  const observerJobs = new Map<string, ControllerJobLease>();
  const managers: ReturnType<typeof createControllerJobLeases>[] = [];
  const observerFor = (proof: ProcessProof): ControllerJobLease | undefined => proof.jobObjectName === undefined ? undefined : observerJobs.get(proof.jobObjectName);
  const create = () => {
    const owned = createControllerJobLeases(); managers.push(owned);
    const jobLeases = { ...owned, retain: async (launchId: string, proof: ProcessProof, deadline: number) => {
      const lease = await owned.retain(launchId, proof, deadline);
      if (process.platform === "win32") {
        const name = `Local\\Daynight-${launchId}`;
        if (!observerJobs.has(name)) observerJobs.set(name, await acquireControllerJobLease(launchId, proof, deadline));
      }
      return lease;
    } };
    return createBotProcess({ homeDirectory: home, packageDirectory, store, executions, sessionApi: api, recoveryLimit: 3, canAdmitNewExecution: () => true, selectToolLaunch, jobLeases,
      ...(tools === undefined ? {} : { toolObservationFor: tools.toolObservationFor }), dependencies: { prepareEnvironment, stopProcesses } });
  };
  const botProcess = create();
  const frames: ReturnType<typeof parseControllerMessage>[] = [], relayErrors: unknown[] = [];
  let browserConnections = 0, deleted = false;
  const controllers = new Set<WebSocket>();
  relay.on("connection", (socket, request) => {
    if (request.url === "/browser-fixture") { browserConnections++; return; }
    if (request.url !== "/api/v1/controller-channel" || request.headers.authorization !== "Bearer controlled-relay-grant") { socket.close(1008); return; }
    controllers.add(socket); socket.once("close", () => controllers.delete(socket));
    socket.on("message", raw => {
      if (deleted) { socket.close(1008); return; }
      try {
        const message = parseControllerMessage(JSON.parse(raw.toString())); frames.push(message);
        const fence = { protocol: SESSION_PROTOCOL, sessionId: bot.sessionId!, testExecutionId: current().intent!.executionId, executionGeneration: current().intent!.executionGeneration, connectionEpoch: "1" };
        if (message.type === "hello") socket.send(JSON.stringify({ type: "welcome", protocol: SESSION_PROTOCOL, connectionEpoch: "1", session: snapshot(current()), lastAckedSourceSeq: "0", limits: RELAY_LIMITS, requiresLiveSync: true }));
        else if (message.type === "reconcile") socket.send(JSON.stringify({ ...fence, type: "reconcile_result", operations: [] }));
        else if (message.type === "events") socket.send(JSON.stringify({ ...fence, type: "events_ack", sourceEpoch: message.sourceEpoch, batchId: message.batchId, lastAckedSourceSeq: message.events.at(-1)!.sourceSeq, lastEventSeq: message.events.at(-1)!.sourceSeq }));
        else if (message.type === "sync_state") socket.send(JSON.stringify({ ...fence, type: "sync_ack" }));
        else if (message.type === "operation_begin") socket.send(JSON.stringify({ ...fence, type: "operation_authorized", operationId: message.operationId }));
        else if (message.type === "operation_receipt") socket.send(JSON.stringify({ ...fence, type: "receipt_ack", operation: message.operation }));
      } catch (error) { relayErrors.push(error); socket.close(1008); }
    });
  });
  const journal = () => { const intent = current().intent; return intent === null ? null : readControllerSnapshot(path.join(controllerExecutionDirectory(home, intent.executionId), "journal.sqlite")); };
  const collectEvidence = async () => {
    const record = current(), intent = record.intent;
    const saved = journal();
    const childState = resolveConfigurationPaths(home, path, { DN_CONFIG_DIR: state }).stateDirectory;
    const expectedTicket = intent === null ? null : path.join(childState, "controller", "launches", `${intent.launchId}.json`);
    const parentTicket = intent === null ? null : controllerTicketPath(home, intent.launchId);
    const directory = intent === null ? null : path.join(childState, "controller", "executions", intent.executionId);
    const expectedJournal = directory === null ? null : readControllerSnapshot(path.join(directory, "journal.sqlite"));
    const summarize = (snapshot: typeof saved) => snapshot === null ? null : { lifecycle: snapshot.lifecycle, startup: snapshot.startup,
      error: snapshot.error, controllerProcess: snapshot.controllerProcess, nativeProcesses: snapshot.nativeProcesses };
    const logs = await Promise.all([launchLog, ...(directory === null ? [] : [path.join(directory, "controller.log")])].map(readEvidence));
    console.error(JSON.stringify({ fixture: "bot-process-integration", stage: "original-startup-evidence", home, state,
      parentTicket, expectedTicket, ticketPathsMatch: parentTicket === expectedTicket,
      parentTicketExists: parentTicket !== null && existsSync(parentTicket), expectedTicketExists: expectedTicket !== null && existsSync(expectedTicket),
      parentState: resolveConfigurationPaths(home).stateDirectory, launchSubmission: intent === null ? null : executions.get(record)?.launchSubmission,
      parentJournal: summarize(saved), expectedJournal: summarize(expectedJournal), logs }));
  };
  failureDiagnostics.push(collectEvidence);
  cleanups.push(async () => {
    let stopped = true, cleanupFailure: unknown;
    try {
      const record = current(), execution = record.intent === null ? null : executions.get(record);
      if (execution !== null && execution.launchSubmission !== "not-submitted") {
        // The parent can lose its spawn observation before the child writes its
        // ownership. Retain the original child's journal, including its Windows
        // Job Object, rather than freezing that earlier empty snapshot.
        const evidenceStarted = Date.now();
        let saved = journal();
        try {
          saved = await vi.waitFor(() => {
            const latest = journal();
            if (latest?.controllerProcess == null) throw new Error("Original fixture process proof is not durable yet.");
            return latest;
          }, { timeout: 30_000, interval: 100 });
        } catch (error) { diagnostic("cleanup-await-original-proof", Date.now() - evidenceStarted, error); }
        const proof = saved?.controllerProcess ?? execution.controllerProcess;
        const ticket = await botProcess.readTicket(record);
        let lease = proof === null ? undefined : observerFor(proof);
        let alreadyProven = false;
        if (process.platform === "win32" && lease === undefined && proof !== null) {
          if (saved?.windowsJobStopProof !== undefined) { readProvenWindowsStoppedControllerGeneration(record.intent!.journalPath, ticket); alreadyProven = true; }
          else { lease = await acquireControllerJobLease(ticket.launchId, execution.controllerProcess ?? proof, Date.now() + 10_000); observerJobs.set(`Local\\Daynight-${ticket.launchId}`, lease); }
        }
        if (!alreadyProven) try { await requestController(ticket, { kind: "stop", deadline: Date.now() + 10_000 }, { timeoutMs: 12_000 }); } catch { /* Process proof below owns cleanup completion. */ }
        // Shutdown joins startup, which can publish native proofs after the
        // first snapshot. Preserve both observations before checking cleanup.
        const native = [...new Map([...(saved?.nativeProcesses ?? []), ...(journal()?.nativeProcesses ?? [])]
          .map(proof => [JSON.stringify([proof.pid, proof.startedAt, proof.commandHash]), proof])).values()];
        if (proof !== null) {
          // A cooperative stop can finish between process/group probes. Observe
          // that completion before escalating the exact retained process group.
          if (process.platform === "win32" && lease === undefined) stopped = readProvenWindowsStoppedControllerGeneration(record.intent!.journalPath, ticket).nativeStopped;
          else {
            try { await waitForProcessesStopped(proof, native, 5000, lease); }
            catch { await stopControllerProcesses(proof, native, Date.now() + 10_000, lease); }
            stopped = await confirmControllerProcessesStopped(proof, native, undefined, lease);
          }
          expect(stopped).toBe(true);
        } else { stopped = false; throw new Error("Spawned fixture has no process proof; evidence retained."); }
      }
      const recordNow = current();
      if (recordNow.intent !== null && process.platform !== "win32") {
        const ticket = await botProcess.readTicket(recordNow).catch(() => null);
        if (ticket !== null) await rm(path.dirname(ticket.ipcEndpoint), { recursive: true, force: true });
      }
    } catch (error) {
      stopped = false; cleanupFailure = error;
      try { await collectEvidence(); } catch (diagnosticError) { diagnostic("read-original-startup-evidence", 0, diagnosticError); }
      throw error;
    }
    finally {
      const failures: unknown[] = [];
      for (const manager of managers) try { await manager.close(); } catch (error) { failures.push(error); }
      for (const lease of observerJobs.values()) try { releaseControllerJobLease(lease); } catch (error) { failures.push(error); }
      observerJobs.clear();
      for (const socket of relay.clients) socket.terminate();
      try { await new Promise<void>((resolve, reject) => relay.close(error => error ? reject(error) : resolve())); } catch (error) { failures.push(error); }
      try { if (http !== null) await new Promise<void>((resolve, reject) => { http.close(error => error ? reject(error) : resolve()); http.closeAllConnections(); }); } catch (error) { failures.push(error); }
      try { await tools?.close(); } catch (error) { failures.push(error); }
      try { executions.close(); } catch (error) { failures.push(error); }
      try { store.close(); } catch (error) { failures.push(error); }
      if (stopped && failures.length === 0) {
        if (socketDirectory !== null) await rm(socketDirectory, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
      }
      if (failures.length) throw new AggregateError(cleanupFailure === undefined ? failures : [cleanupFailure, ...failures], "Bot integration cleanup and handle release failed.", { cause: cleanupFailure });
    }
  });
  const requests = async () => (await readFile(requestLog, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { method?: string; params?: Record<string, unknown>; fixtureTool?: "A" | "B" });
  const launches = async () => existsSync(launchLog) ? (await readFile(launchLog, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { pid: number }) : [];
  const send = async (text: string): Promise<string> => {
    const intent = current().intent!, operationId = randomUUID();
    await vi.waitFor(() => expect(frames.some(frame => frame.type === "sync_state" && frame.executionGeneration === intent.executionGeneration && frame.testExecutionId === intent.executionId)).toBe(true), { timeout: 10_000 });
    const fence = { protocol: SESSION_PROTOCOL, sessionId: intent.sessionId!, testExecutionId: intent.executionId, executionGeneration: intent.executionGeneration };
    for (const socket of controllers) socket.send(JSON.stringify({ ...fence, connectionEpoch: "1", type: "operation_offer", operationSeq: "1", command: { ...fence,
      requestId: randomUUID(), operationId, kind: "send_message", payload: { content: [{ type: "text", text }], expectedTurnId: null } } }));
    await vi.waitFor(() => expect(readControllerOperation(intent.journalPath, operationId)?.state).toBe("confirmed"), { timeout: 10_000 });
    return operationId;
  };
  return { home, cwd, packageDirectory, prepareEnvironment, selectToolLaunch, tools, toolEntries, receipts, probeEnvironment, send, http, snapshot, getBot: () => bot, setBot: (value: BotDefinition) => { bot = value; }, current, store, executions, api, revoke: () => { deleted = true; for (const client of relay.clients) client.close(1008); }, process: botProcess, create, observerFor, register, grant, requests, launches, frames, relayErrors, owner, journal, nativeId, browserConnections: () => browserConnections };
};

const launchAndObserveReady = async (f: Awaited<ReturnType<typeof fixture>>, signal: AbortSignal) => {
  const started = Date.now();
  try { await f.process.advance(f.current(), signal); }
  catch (error) {
    const record = f.current(), execution = record.intent === null ? null : f.executions.get(record);
    if (execution?.launchSubmission !== "unknown" || execution.startup?.state === "failed") throw error;
    diagnostic("launch-observation-unknown", Date.now() - started, error);
  }
  const originalTicket = await f.process.readTicket(f.current());
  // An interrupted parent can return before the child acquires its own proof,
  // creates the Windows Job and captures native ownership. Reconciliation waits
  // for that sequence through the original authenticated ticket.
  await vi.waitFor(async () => expect(await f.process.observe(f.current(), signal)).toMatchObject({ lifecycle: "ready", activity: "idle", nativeSessionId: f.nativeId, initialInputState: "not_required" }), { timeout: 60_000, interval: 100 });
  expect(await f.process.readTicket(f.current())).toEqual(originalTicket);
};

test("keeps A/B version, host, models and native Bot launches on their selected recipes across restart and removal", async () => {
  const f = await fixture({ managedTools: true }), signal = AbortSignal.timeout(150_000), runtime = f.tools!;
  const dist = path.resolve(import.meta.dirname, "../../../dist");
  const hostModule = await import(pathToFileURL(path.join(dist, "commands/worker/bots/host-capabilities.js")).href) as typeof import("../../../src/commands/worker/bots/host-capabilities.js");
  const modelModule = await import(pathToFileURL(path.join(dist, "commands/worker/read-only/models.js")).href) as typeof import("../../../src/commands/worker/read-only/models.js");
  const host = hostModule.createAssistantHostCollector({ workingDirectory: f.cwd, environment: f.probeEnvironment,
    configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 3 },
    resolveExecutable: () => path.join(f.home, "missing-unrelated-provider"),
    selectToolLaunch: async provider => provider === "codex" ? runtime.manager.currentSelection("codex", "web") : undefined,
    toolInspector: runtime.hostInspector, toolRuntimeRoot: runtime.toolRuntimeRoot });
  const models = modelModule.createWorkerModelDiscovery({ defaultCwd: f.cwd, environment: f.probeEnvironment,
    prepare: async (provider, operation) => { expect(provider).toBe("codex"); await runtime.manager.prepare("codex", "web", operation); },
    configuration: () => ({ native: { agent: "codex", model: null, args: [] }, report: { agent: "codex", model: { value: null, source: "native" }, reasoningEffort: { value: null, source: "native" } },
      toolSelections: [runtime.manager.currentSelection("codex", "web")?.selectionKey] }),
    verifier: { discover: async (input, operation) => {
      const toolLaunch = await runtime.manager.selectForNewExecution("codex", "web", operation);
      return runtime.inspector.discover({ ...input, toolLaunch, mode: "web", toolRuntimeRoot: runtime.toolRuntimeRoot }, operation);
    } } });
  cleanups.push(async () => { models.close(); await host.close(); });
  const inspect = async (tool: "A" | "B", version: string) => {
    const operation = createOperation({ signal, limits: { totalMs: 30_000 } });
    try {
      await runtime.manager.prepare("codex", "web", operation);
      const launch = runtime.manager.currentSelection("codex", "web")!;
      expect(runtime.manager.snapshot().entries.find(entry => entry.tool === "codex" && entry.context === "web"))
        .toMatchObject({ state: "applied", actual: { selectionKey: launch.selectionKey, entryPath: f.toolEntries[tool], version } });
      const beforeHost = await f.receipts();
      expect((await host.collect(operation)).assistantHost.providers.find(entry => entry.provider === "codex")).toMatchObject({ available: true, reason: null });
      expect(await f.receipts()).toEqual(beforeHost);
      expect(await models.discover({ provider: "codex" }, signal)).toMatchObject({ models: [{ id: `model-${tool}` }], defaults: { model: { value: `model-${tool}`, source: "native" } }, selectionError: null });
      return launch;
    } finally { operation.dispose(); }
  };
  const a = await inspect("A", "1.10.1");
  expect((await f.requests()).some(request => request.method === "thread/start" || request.method === "thread/resume" || request.method === "turn/start")).toBe(false);
  await launchAndObserveReady(f, signal);
  const original = f.current().intent!, originalDefinition = f.getBot();
  expect(original).toMatchObject({ toolLaunch: a, toolObservation: { version: "1.10.1" } });
  expect((await f.process.readTicket(f.current())).configuration).toMatchObject({ toolLaunch: a, toolObservation: original.toolObservation });
  const operationId = await f.send("first user input");
  expect((await f.requests()).filter(request => request.method === "turn/start")).toMatchObject([{ fixtureTool: "A", params: { input: [{ type: "text", text: "first user input" }] } }]);
  await f.create().shutdown(f.current(), signal);

  vi.stubEnv("PATH", path.join(f.home, "path-B") + path.delimiter + (process.env.PATH ?? ""));
  runtime.setTargets({ source: "cloud", revision: "2", choices: { codex: { kind: "path", path: f.toolEntries.B }, copilot: { kind: "path", path: path.join(f.home, "missing-copilot") }, herdr: { kind: "auto" } } });
  const b = await inspect("B", "1.20.2");
  expect(b.selectionKey).not.toBe(a.selectionKey);
  const nextDefinition: BotDefinition = { ...originalDefinition, id: randomUUID(), version: "1", creationOrder: "2", sessionId: null, testExecutionId: null, roleConfiguration: null, startupResult: { state: "pending", code: null } };
  f.setBot(nextDefinition); f.store.observe(f.owner, nextDefinition, Date.now());
  await launchAndObserveReady(f, signal);
  expect(f.current().intent).toMatchObject({ toolLaunch: b, toolObservation: { version: "1.20.2" } });
  expect((await f.process.readTicket(f.current())).configuration.toolLaunch).toEqual(b);
  expect(f.current().intent!.sessionId).not.toBe(original.sessionId);
  expect((await f.requests()).filter(request => request.method === "thread/start").map(request => request.fixtureTool)).toEqual(["A", "B"]);
  await f.create().shutdown(f.current(), signal);

  f.setBot(originalDefinition);
  await f.create().advance(f.current(), signal);
  await vi.waitFor(async () => expect(await f.process.observe(f.current(), signal)).toMatchObject({ lifecycle: "ready", nativeSessionId: f.nativeId }), { timeout: 20_000, interval: 100 });
  expect(f.current().intent).toMatchObject({ sessionId: original.sessionId, executionId: original.executionId, nativeSessionId: f.nativeId, toolLaunch: a, toolObservation: original.toolObservation });
  expect((await f.process.readTicket(f.current())).configuration.toolLaunch).toEqual(a);
  expect((await f.requests()).filter(request => request.method === "thread/resume")).toMatchObject([{ fixtureTool: "A", params: { threadId: f.nativeId } }]);
  expect(readControllerOperation(original.journalPath, operationId)).toMatchObject({ state: "confirmed" });
  expect((await f.requests()).filter(request => request.method === "turn/start")).toHaveLength(1);
  await f.create().shutdown(f.current(), signal);

  const beforeRemoval = await f.receipts();
  await rm(f.toolEntries.A);
  await f.create().advance(f.current(), signal).catch(() => {});
  await vi.waitFor(() => expect(f.journal()).toMatchObject({ error: expect.stringMatching(/tool_identity_changed|not_found/), nativeProcesses: [] }), { timeout: 20_000, interval: 100 });
  const refused = f.journal()!;
  await waitForProcessesStopped(refused.controllerProcess!, refused.nativeProcesses, 10_000, f.observerFor(refused.controllerProcess!));
  expect(f.current().intent).toMatchObject({ sessionId: original.sessionId, executionId: original.executionId, nativeSessionId: f.nativeId, toolLaunch: a });
  expect(await f.receipts()).toEqual(beforeRemoval);
  expect((await f.requests()).filter(request => request.method === "turn/start")).toHaveLength(1);
  expect(f.register).toHaveBeenCalledTimes(2);
  expect(f.selectToolLaunch).toHaveBeenCalledTimes(2);
  const node = await realpath(process.execPath);
  for (const receipt of beforeRemoval) {
    expect(await realpath(receipt.execPath)).toBe(node);
    expect(receipt.argv.slice(0, 2)).toEqual([receipt.execPath, f.toolEntries[receipt.tool]]);
    expect(receipt.argv.slice(2)).toEqual(expect.arrayContaining(receipt.argv.includes("--version") ? ["--version"] : receipt.argv.includes("--help") ? ["--help"] : ["app-server", "--stdio"]));
  }
  for (const tool of ["A", "B"] as const) {
    expect(beforeRemoval.some(receipt => receipt.tool === tool && receipt.argv.includes("--version"))).toBe(true);
    expect(beforeRemoval.some(receipt => receipt.tool === tool && receipt.argv.includes("--help"))).toBe(true);
    expect((await f.requests()).some(request => request.fixtureTool === tool && request.method === "model/list")).toBe(true);
  }
  expect(f.relayErrors).toEqual([]);
}, 180_000);

test.each([false, true])("launches one real Controller with no user turn after unknown parent observation=%s, then observes the same writer after browser disconnect", async interruptedObservation => {
  const f = await fixture(), signal = AbortSignal.timeout(60_000);
  if (interruptedObservation) vi.spyOn(processProof, "captureProcessProof").mockRejectedValueOnce(new Error("Fixture parent observation interrupted"));
  await launchAndObserveReady(f, signal);
  const ticket = await f.process.readTicket(f.current());
  expect(ticket).toMatchObject({ initialInput: "none", initialPrompt: "", cwd: f.cwd, instructions: f.current().intent!.roleConfiguration!.instructions });
  expect(ticket).not.toHaveProperty("claimId"); expect(existsSync(path.join(f.cwd, ".git"))).toBe(false);
  expect((await f.requests()).filter(request => request.method === "thread/start")).toHaveLength(1);
  expect((await f.requests()).find(request => request.method === "thread/start")?.params).toMatchObject({ developerInstructions: ticket.instructions });
  expect((await f.requests()).some(request => request.method === "turn/start")).toBe(false);
  const first = await f.process.observe(f.current(), signal);
  expect(first.controllerProcess?.pid).toBe((await f.launches())[0]?.pid);
  const browser = new WebSocket(f.owner.serverOrigin.replace(/^http/, "ws") + "/browser-fixture"); await once(browser, "open");
  const closed = once(browser, "close"); browser.close(); await closed;
  expect(f.browserConnections()).toBe(1);
  if (interruptedObservation) {
    expect((await f.create().advance(f.current(), signal)).controllerProcess).toEqual(first.controllerProcess);
    await expect(f.create().shutdown(f.current(), signal)).rejects.toThrow(/no original spawn proof/);
    expect(await f.launches()).toHaveLength(1);
    return;
  }
  const observed = await f.create().advance(f.current(), signal);
  expect(observed.controllerProcess).toEqual(first.controllerProcess);
  expect(observed.nativeProcesses).toEqual(first.nativeProcesses);
  expect(await inspectProcessProof(observed.controllerProcess!)).toBe("running");
  expect(await f.launches()).toHaveLength(1); expect(f.register).toHaveBeenCalledOnce(); expect(f.grant).toHaveBeenCalledOnce();
  expect((await f.requests()).some(request => request.method === "turn/start")).toBe(false);
  await vi.waitFor(() => expect(f.frames.some(frame => frame.type === "sync_state")).toBe(true), { timeout: 10_000 });
  expect(f.relayErrors).toEqual([]);
}, 60_000);

test("retains a native protocol role rejection without another writer or an initialization user turn", async () => {
  const f = await fixture({ rejectRole: true }), signal = AbortSignal.timeout(30_000);
  await f.process.advance(f.current(), signal).catch(() => {});
  await vi.waitFor(() => expect(f.journal()).toMatchObject({ startup: { state: "failed", reasonCode: "native_rejected" }, nativeSessionId: null, initialInputState: "not_required" }), { timeout: 20_000, interval: 100 });
  const before = await f.launches(); expect(before).toHaveLength(1);
  await f.create().advance(f.current(), signal).catch(() => {});
  expect(await f.launches()).toEqual(before);
  expect((await f.requests()).some(request => request.method === "turn/start")).toBe(false);
  expect(f.register).toHaveBeenCalledOnce();
}, 60_000);

test("rejects unsupported Provider arguments before registration or native process creation", async () => {
  const f = await fixture({ args: ["--unsupported-fixture-setting"] });
  await expect(f.process.advance(f.current(), AbortSignal.timeout(5000))).rejects.toThrow(/Unsupported/);
  expect(f.register).not.toHaveBeenCalled(); expect(await f.launches()).toEqual([]); expect(f.current().intent).toBeNull();
}, 20_000);

test("recovers cleanup evidence from the original journal when the parent process observation fails first", async () => {
  const f = await fixture();
  vi.spyOn(processProof, "captureProcessProof").mockRejectedValueOnce(new Error("Fixture parent observation interrupted"));
  await expect(f.process.advance(f.current(), AbortSignal.timeout(30_000))).rejects.toThrow("Fixture parent observation interrupted");
  expect(f.executions.get(f.current())!.controllerProcess).toBeNull();
  // afterEach must wait for the child's durable evidence instead of retaining
  // the empty snapshot taken before its process ownership was captured.
}, 60_000);


test("four orderly Worker restarts preserve the real journal, native session, role and unknown user operation without spending recovery budget", async () => {
  const f = await fixture(), signal = AbortSignal.timeout(90_000);
  await launchAndObserveReady(f, signal);
  const original = f.current().intent!, operationId = randomUUID();
  const operation = { operationId, executionGeneration: "1", kind: "send_message", payload: { text: "already submitted" }, payloadHash: "a".repeat(64), state: "unknown", result: null, error: null, createdAt: 1, updatedAt: 1 };
  for (let generation = 1; generation <= 4; generation++) {
    await f.create().shutdown(f.current(), signal);
    expect(f.journal()).toMatchObject({ nativeStopped: true, lifecycle: "stopped", nativeSessionId: f.nativeId });
    if (generation === 1) {
      // Insert a crash-surviving unknown receipt only after OS stop proof. The
      // production Controller must retain and reconcile it without dispatch.
      const db = new Database(original.journalPath);
      try { db.prepare("INSERT INTO operations(id,value,acknowledged) VALUES (?,?,0)").run(operationId, JSON.stringify(operation)); }
      finally { db.close(); }
    }
    expect(f.executions.get(f.current())!.recoveryCount).toBe(0);
    await f.create().advance(f.current(), signal);
    await vi.waitFor(async () => expect(await f.process.observe(f.current(), signal)).toMatchObject({ lifecycle: "ready", nativeSessionId: f.nativeId }), { timeout: 20_000, interval: 100 });
    expect(f.current().intent).toMatchObject({ executionGeneration: String(generation + 1), sessionId: original.sessionId, executionId: original.executionId, nativeSessionId: f.nativeId, roleConfiguration: original.roleConfiguration, initialOperationId: original.initialOperationId });
    expect(readControllerOperation(original.journalPath, operationId)).toMatchObject({ operationId, state: "unknown" });
    expect(f.executions.get(f.current())!.recoveryCount).toBe(0);
  }
  expect(f.register).toHaveBeenCalledOnce(); expect(await f.launches()).toHaveLength(5);
  const requests = await f.requests();
  expect(requests.filter(request => request.method === "thread/start")).toHaveLength(1);
  expect(requests.filter(request => request.method === "thread/resume")).toHaveLength(4);
  for (const request of requests.filter(request => request.method === "thread/resume")) expect(request.params).toMatchObject({ threadId: f.nativeId, developerInstructions: original.roleConfiguration!.instructions });
  expect(requests.some(request => request.method === "turn/start")).toBe(false);
  expect(f.relayErrors).toEqual([]);
}, 120_000);


test("deletes every private generation after real Controller stop while preserving cwd, native history and an independent Task worktree", async () => {
  const f = await fixture({ aliases: true }), signal = AbortSignal.timeout(100_000);
  const nativeHome = path.join(f.home, "native"), repository = path.join(f.home, "task-repository"), worktree = path.join(repository, ".worktrees", "independent");
  const hooks = path.join(f.home, "empty-hooks"); await mkdir(hooks); await mkdir(nativeHome, { recursive: true });
  const sentinels = [path.join(f.cwd, "user-file.txt"), path.join(nativeHome, "native-history.txt")];
  for (const file of sentinels) await writeFile(file, "independent user content");
  const git = (args: string[]) => execFileSync("git", ["--no-pager", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "--initial-branch=main", repository]);
  git(["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "Fixture"]);
  git(["-C", repository, "worktree", "add", "--detach", worktree, "HEAD"]);
  const worktreeFile = path.join(worktree, "unfinished-task.txt"); await writeFile(worktreeFile, "independent task content");
  const worktrees = git(["-C", repository, "worktree", "list", "--porcelain"]);
  const workerFile = path.join(f.home, "worker.sqlite"), projectId = randomUUID(), taskId = randomUUID(), claimId = randomUUID(), worktreeId = randomUUID();
  const independentRows = () => {
    const db = new Database(workerFile);
    try { return [db.prepare("SELECT * FROM projects").all(), db.prepare("SELECT * FROM tasks").all(), db.prepare("SELECT * FROM cleanup_schedules").all()]; }
    finally { db.close(); }
  };
  const db = new Database(workerFile);
  try {
    db.prepare("INSERT INTO projects VALUES (?,?,?)").run(projectId, "https://example.test/independent", repository);
    db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?)").run(projectId, taskId, claimId, "active", "codex", randomUUID(), "web");
    db.prepare("INSERT INTO cleanup_schedules(project_id, task_id, claim_id, worktree_id, deadline, failures, next_attempt_at, stage, last_error) VALUES (?,?,?,?,?,?,?,?,?)").run(projectId, taskId, claimId, worktreeId, 1234, 1, 5678, "backend-close", "unrelated retained responsibility");
  } finally { db.close(); }
  const rows = independentRows();
  await launchAndObserveReady(f, signal);
  const first = f.current().intent!;
  const tickets = [await f.process.readTicket(f.current())];
  for (let generation = 1; generation <= 2; generation++) {
    await f.process.shutdown(f.current(), signal);
    await f.process.advance(f.current(), signal);
    await vi.waitFor(async () => expect(await f.process.observe(f.current(), signal)).toMatchObject({ lifecycle: "ready", nativeSessionId: f.nativeId, executionGeneration: String(generation + 1) }), { timeout: 20_000, interval: 100 });
    tickets.push(await f.process.readTicket(f.current()));
  }
  const original = f.current(), execution = f.executions.get(original)!, finalWriter = await f.process.observe(original, signal);
  expect(await inspectProcessProof(finalWriter.controllerProcess!)).toBe("running");
  const aliases = [...execution.retainedAliasDirectories, execution.aliasDirectory!];
  expect(aliases).toHaveLength(3);
  expect(existsSync(first.journalPath)).toBe(true);
  expect(existsSync(`${first.journalPath}.pending-content/manifest.json`)).toBe(true);
  const deletionId = randomUUID();
  let remote: BotDeleted = { id: original.botId, workerId: f.owner.workerId, version: String(BigInt(original.observed.version) + 1n), deletion: { deletionId, requestedVersion: original.observed.version, workerCleanup: { state: "pending", code: null }, serverCleanup: { state: "pending", code: null } } };
  f.store.observe(f.owner, remote, Date.now()); f.revoke();
  const receipts: BotDeletionReceipt[] = [];
  const api = { ...f.api, completeDeletion: async (_record: BotRecord, receipt: BotDeletionReceipt): Promise<BotDeleted> => {
    if (receipt.result.state === "completed") {
      expect(await confirmControllerProcessesStopped(finalWriter.controllerProcess!, finalWriter.nativeProcesses, undefined, f.observerFor(finalWriter.controllerProcess!))).toBe(true);
      expect(existsSync(controllerExecutionDirectory(f.home, first.executionId))).toBe(false);
    }
    receipts.push(structuredClone(receipt));
    remote = { ...remote, version: String(BigInt(remote.version) + 1n), deletion: { ...remote.deletion, workerCleanup: receipt.result, serverCleanup: { state: "completed", code: null } } };
    return remote;
  } };
  const deletion = createBotDeletion({ homeDirectory: f.home, store: f.store, executions: f.executions, process: f.process, sessionApi: api, remote: { owner: f.owner, read: async () => remote, list: async () => [remote] } });
  await deletion.advance(f.current(), signal);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ deletionId, result: { state: "completed", code: null }, stop: { sessionId: first.sessionId, testExecutionId: first.executionId, executionGeneration: "3", controllerInstanceId: original.intent!.controllerInstanceId, stopProof: { recordId: original.intent!.launchId, previousControllerInstanceId: original.intent!.controllerInstanceId } } });
  expect(receipts[0]!.stop!.stopProof).not.toHaveProperty("kind");
  for (const ticket of tickets) {
    expect(existsSync(path.join(path.dirname(original.intent!.ticketPath), `${ticket.launchId}.json`))).toBe(false);
    if (process.platform !== "win32") expect(existsSync(ticket.ipcEndpoint)).toBe(false);
  }
  for (const alias of aliases) expect(existsSync(alias)).toBe(false);
  expect(f.current()).toMatchObject({ intent: null, definition: null, cleanup: { localCompleted: true, targets: [] } });
  for (const file of sentinels) expect(await readFile(file, "utf8")).toBe("independent user content");
  expect(await readFile(worktreeFile, "utf8")).toBe("independent task content");
  expect(git(["-C", repository, "worktree", "list", "--porcelain"])).toBe(worktrees);
  expect(independentRows()).toEqual(rows);
  await expect(f.process.advance(original, signal)).rejects.toThrow(/active definition/);
  await deletion.advance(f.current(), signal);
  expect(receipts).toHaveLength(1);
  expect(await f.launches()).toHaveLength(3);
  expect((await f.requests()).some(request => request.method === "turn/start")).toBe(false);
  expect(f.relayErrors).toEqual([]);
}, 120_000);


test("runs the production Bot host through HTTP discovery, native recovery and precise deletion", async () => {
  const f = await fixture({ hosted: true }), errors: string[] = [], calls: { method: string; path: string; body: any }[] = [];
  // Native credentials and command aliases are fixture-owned; the host, stores,
  // HTTP adapters, Controller, journal, IPC, provider adapter and deletion run unchanged.
  vi.spyOn(botEnvironment, "prepareBotEnvironment").mockImplementation(f.prepareEnvironment);
  let deleted: BotDeleted | null = null, serverGeneration = "1", serverInstance: string | null = null;
  const parentToken = "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890";
  f.http!.on("request", (request, response) => {
    void (async () => {
      response.setHeader("content-type", "application/json"); response.setHeader("Daynight-User-ID", f.owner.ownerUserId);
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      const pathname = new URL(request.url!, f.owner.serverOrigin).pathname;
      calls.push({ method: request.method!, path: pathname, body });
      expect(request.headers.authorization).toBe(`Bearer ${parentToken}`);
      const send = (value: unknown) => response.end(JSON.stringify(value));
      if (request.method === "GET" && ["/api/v1/assistant-tasks", "/api/v1/assistant-task-events"].includes(pathname)) {
        return send({ items: [], nextCursor: null, observedAt: new Date().toISOString() });
      }
      if (request.method === "GET" && pathname.endsWith(`/workers/${f.owner.workerId}/bots`)) return send({ items: [deleted ?? f.getBot()], nextCursor: null });
      if (request.method === "GET" && pathname.endsWith(`/me/bots/${f.getBot().id}`)) return send(deleted ?? f.getBot());
      if (request.method === "POST" && pathname.endsWith("/register")) {
        expect(body.registration).toEqual(f.current().intent!.registration);
        expect(body.roleConfiguration).toEqual(f.current().intent!.roleConfiguration);
        const registered = await f.api.register(f.current()); serverInstance = registered.snapshot.identity.controllerInstanceId;
        return send({ bot: registered.bot, session: registered.snapshot });
      }
      if (request.method === "GET" && pathname.startsWith("/api/v1/test-sessions/")) {
        const session = f.snapshot(f.current());
        return send({ session: { ...session, executionGeneration: serverGeneration,
          identity: { ...session.identity, controllerInstanceId: serverInstance! } } });
      }
      if (request.method === "POST" && pathname.endsWith("/grant")) {
        if (body.grant.executionGeneration !== serverGeneration) {
          expect(body.grant.previousGeneration).toBe(serverGeneration);
          expect(body.grant.stopProof.previousControllerInstanceId).toBe(serverInstance);
        }
        serverGeneration = body.grant.executionGeneration; serverInstance = body.grant.controllerInstanceId;
        return send(await f.api.grant(f.current()));
      }
      if (request.method === "POST" && pathname.endsWith("/report")) {
        f.setBot({ ...f.getBot(), version: String(BigInt(f.getBot().version) + 1n), startupResult: body.result });
        return send(f.getBot());
      }
      if (request.method === "POST" && pathname.endsWith("/deletion-complete")) {
        expect(deleted).not.toBeNull(); expect(body.deletionId).toBe(deleted!.deletion.deletionId);
        deleted = { ...deleted!, version: String(BigInt(deleted!.version) + 1n), deletion: { ...deleted!.deletion,
          workerCleanup: body.result, serverCleanup: { state: "completed", code: null } } };
        return send(deleted);
      }
      throw new Error(`Unexpected hosted fixture request ${request.method} ${pathname}`);
    })().catch(error => { errors.push(String(error)); response.statusCode = 500; response.end(JSON.stringify({ error: { code: "fixture_error", message: "Controlled HTTP failed", requestId: "fixture" } })); });
  });
  const paths = { ...resolveWorkerPaths(f.home), databaseFile: path.join(f.home, "worker.sqlite") };
  const makeHost = () => createWorkerBotHost({ homeDirectory: f.home, packageDirectory: f.packageDirectory, workingDirectory: f.cwd, paths, owner: f.owner,
    serverToken: parentToken, canAdmitNewExecution: () => true, selectToolLaunch: f.selectToolLaunch, configuration: () => ({ agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 3 }),
    recoveryLimit: () => 3, pollIntervalMs: () => 50, emit: event => { if (event.kind === "bot-unavailable") errors.push(event.message); } });
  let host = makeHost(), cancellation = new AbortController(), running = host.run(cancellation.signal);
  void running.catch(error => errors.push(String(error)));
  const stop = async () => { cancellation.abort(); try { await host.shutdown(); await running; } finally { host.close(); } };
  // This cleanup runs before the fixture's original-process cleanup, even on failure.
  cleanups.push(stop);
  await vi.waitFor(() => expect(f.getBot().startupResult.state, errors.join("\n")).toBe("ready"), { timeout: 60_000, interval: 100 });
  const first = f.current().intent!;
  const sentinel = path.join(f.cwd, "keep.txt"); await writeFile(sentinel, "user data");
  expect(await f.launches()).toHaveLength(1);
  await stop();
  expect(f.journal()).toMatchObject({ nativeStopped: true, nativeSessionId: f.nativeId });
  host = makeHost(); cancellation = new AbortController(); running = host.run(cancellation.signal);
  void running.catch(error => errors.push(String(error)));
  await vi.waitFor(() => expect(f.journal()).toMatchObject({ lifecycle: "ready", nativeSessionId: f.nativeId, executionGeneration: "2" }), { timeout: 60_000, interval: 100 });
  expect(f.current().intent).toMatchObject({ sessionId: first.sessionId, executionId: first.executionId, roleConfiguration: first.roleConfiguration });
  expect(f.executions.get(f.current())!.recoveryCount).toBe(0);
  const current = f.getBot();
  deleted = { id: current.id, workerId: current.workerId, version: String(BigInt(current.version) + 1n), deletion: { deletionId: randomUUID(), requestedVersion: current.version,
    workerCleanup: { state: "pending", code: null }, serverCleanup: { state: "pending", code: null } } };
  f.revoke();
  await vi.waitFor(() => expect(deleted!.deletion.workerCleanup.state, errors.join("\n")).toBe("completed"), { timeout: 60_000, interval: 100 });
  expect(f.current()).toMatchObject({ intent: null, definition: null, cleanup: { localCompleted: true } });
  expect(existsSync(first.journalPath)).toBe(false); expect(existsSync(first.ticketPath)).toBe(false);
  expect(await readFile(sentinel, "utf8")).toBe("user data");
  expect(calls.filter(call => call.path.endsWith("/register"))).toHaveLength(1);
  expect(calls.filter(call => call.path.endsWith("/deletion-complete"))).toHaveLength(1);
  expect((await f.requests()).filter(request => request.method === "thread/start")).toHaveLength(1);
  expect((await f.requests()).filter(request => request.method === "thread/resume")).toHaveLength(1);
  expect((await f.requests()).some(request => request.method === "turn/start")).toBe(false);
  expect(errors).toEqual([]); expect(f.relayErrors).toEqual([]);
  await stop();
}, 180_000);
