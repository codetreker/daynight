import Database from "better-sqlite3";
import { createServer } from "node:http";
import { createWorkerBotHost } from "../../../src/commands/worker/bots/host.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import * as botEnvironment from "../../../src/commands/worker/bots/environment.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { readControllerSnapshot, readControllerOperation, readWindowsJobReceipt, readWindowsJobSource } from "../../../src/commands/controller/lifecycle-store.js";
import { requestController } from "../../../src/commands/controller/local-client.js";
import { openControllerStop, type ControllerStop } from "../../../src/commands/controller/controller-stop.js";
import { confirmControllerProcessesStopped, inspectProcessProof, type ProcessProof } from "../../../src/commands/controller/process-proof.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import { inspectControllerJob } from "../../../src/commands/controller/windows-job.js";
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
const waitForProcessesStopped = async (controller: ProcessProof, native: readonly ProcessProof[], timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await confirmControllerProcessesStopped(controller, native)) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Original fixture processes did not stop within the observation window.");
    await delay(Math.min(100, remaining));
  }
};
const stopFixtureProcesses = async (operation: Pick<ControllerStop, "stop">, proof: ProcessProof, native: readonly ProcessProof[], graceful: boolean): Promise<void> => {
  try { await operation.stop(Date.now() + 10_000, { graceful }); }
  catch (error) {
    // The original process may exit between the group inventory and identity
    // checks. Do not signal an unattributed group; wait for it to empty.
    if (process.platform === "win32" || !(error instanceof Error) || error.message !== "The remaining process group has no original process-instance proof; resources are retained.") throw error;
    try { await waitForProcessesStopped(proof, native, 2000); }
    catch (cause) { throw new AggregateError([error, cause], "Original fixture stop remains unconfirmed.", { cause: error }); }
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

test.skipIf(process.platform === "win32")("fixture cleanup only accepts an unattributed group after it is confirmed empty", async () => {
  const proof: ProcessProof = { pid: 123, parentPid: 12, processGroupId: 123, startedAt: "original", commandHash: "a".repeat(64) };
  const original = new Error("The remaining process group has no original process-instance proof; resources are retained.");
  const stop = vi.fn(async () => { throw original; });
  const confirm = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("group inventory unavailable"));
  await expect(stopFixtureProcesses({ stop }, proof, [], true)).resolves.toBeUndefined();
  expect(stop).toHaveBeenCalledWith(expect.any(Number), { graceful: true });
  expect(confirm).toHaveBeenCalledWith(proof, []);
  await expect(stopFixtureProcesses({ stop }, proof, [], false)).rejects.toMatchObject({ errors: [original, expect.objectContaining({ message: "group inventory unavailable" })] });
});

const fixture = async (options: { rejectRole?: boolean; args?: string[]; aliases?: boolean; hosted?: boolean } = {}) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/bot-process-integration");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")), state = path.join(home, "state"), cwd = path.join(home, "ordinary");
  await mkdir(cwd); vi.stubEnv("DN_CONFIG_DIR", state);
  const socketDirectory = process.platform === "win32" ? null : path.dirname(resolveControllerIpcEndpoint(home, "fixture"));
  const packageDirectory = path.join(home, "package"), dist = path.resolve(import.meta.dirname, "../../../dist");
  await mkdir(path.join(packageDirectory, "dist"), { recursive: true });
  const requestLog = path.join(home, "native-requests.jsonl"), launchLog = path.join(home, "controllers.jsonl"), guardianExitLog = path.join(home, "guardian-exits.jsonl"), nativeId = randomUUID();
  const nativeFixture = path.join(home, "codex-native.mjs");
  // The copied fixture runs outside this package's dependency tree.
  const nativeSource = (await readFile(path.resolve(import.meta.dirname, "../controller/fixtures/codex-native.mjs"), "utf8"))
    .replace("from 'better-sqlite3'", `from ${JSON.stringify(import.meta.resolve("better-sqlite3"))}`)
    .replaceAll("native-thread", nativeId);
  await writeFile(nativeFixture, nativeSource);
  const providerURL = pathToFileURL(path.join(dist, "commands/controller/providers/codex.js")).href;
  const runtimeURL = pathToFileURL(path.join(dist, "commands/controller/runtime.js")).href;
  const proofURL = pathToFileURL(path.join(dist, "commands/controller/process-proof.js")).href;
  const wrapper = path.join(packageDirectory, "provider.mjs"), wrapperURL = pathToFileURL(wrapper).href;
  await writeFile(wrapper, `import { openCodexProvider as open } from ${JSON.stringify(providerURL)};\nexport const openCodexProvider = options => open({ ...options, executable: ${JSON.stringify(nativeFixture)} });\n`);
  await writeFile(path.join(packageDirectory, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(packageDirectory, "dist/main.js"), `
import { registerHooks } from 'node:module';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import childProcess from 'node:child_process';
const originalSpawn = childProcess.spawn;
let guardianExit;
let guardianIdentity;
childProcess.spawn = (...args) => {
  const child = originalSpawn(...args);
  if (typeof args[1]?.[0] === 'string' && args[1][0].endsWith('windows-job-guardian-child.js')) {
    guardianIdentity = new Promise(resolve => child.once('spawn', () => {
      appendFileSync(${JSON.stringify(guardianExitLog)}, JSON.stringify({ launchId: process.argv[5], pid: child.pid, started: true }) + '\\n');
      void captureProcessProof(child.pid).then(proof => {
        appendFileSync(${JSON.stringify(guardianExitLog)}, JSON.stringify({ launchId: process.argv[5], pid: child.pid, proof }) + '\\n');
      }).catch(() => {}).finally(resolve);
    }));
    guardianExit = new Promise(resolve => child.once('exit', (code, signal) => {
      appendFileSync(${JSON.stringify(guardianExitLog)}, JSON.stringify({ launchId: process.argv[5], pid: child.pid, exited: true, code, signal }) + '\\n');
      resolve();
    }));
  }
  return child;
};
syncBuiltinESMExports();
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (result.url === ${JSON.stringify(providerURL)} && context.parentURL !== ${JSON.stringify(wrapperURL)}) return { url: ${JSON.stringify(wrapperURL)}, shortCircuit: true };
  return result;
} });
const { captureProcessProof } = await import(${JSON.stringify(proofURL)});
const proof = await captureProcessProof(process.pid);
appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify({ pid: process.pid, proof, argv: process.argv.slice(2) }) + '\\n');
const { runController } = await import(${JSON.stringify(runtimeURL)});
try { await runController({ homeDirectory: ${JSON.stringify(home)}, provider: process.argv[3], launchId: process.argv[5] }); }
catch (error) {
  if (guardianIdentity) await Promise.race([guardianIdentity, new Promise(resolve => setTimeout(resolve, 2000))]);
  if (guardianExit) await Promise.race([guardianExit, new Promise(resolve => setTimeout(resolve, 2000))]);
  throw error;
}
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
  let sqliteFailureObserved = false;
  const openStop: typeof openControllerStop = async input => {
    // A missing receipt forces openControllerStop to retain the original Job.
    // If this independent read fails, skip the writable diagnostic entirely.
    let beforeReceiptMissing = false;
    if (process.platform === "win32") try { beforeReceiptMissing = readWindowsJobReceipt(input.journalPath, input.ticket) === null; } catch { /* Diagnostic eligibility is unknown. */ }
    const operation = await openControllerStop(input);
    let holdsOriginalJob = false;
    if (beforeReceiptMissing) try { holdsOriginalJob = readWindowsJobReceipt(input.journalPath, input.ticket) === null; } catch { /* Diagnostic eligibility is unknown. */ }
    const inspectFailure = async (error: unknown) => {
      const hasTruncateError = (value: unknown, seen = new Set<unknown>()): boolean => {
        if (!(value instanceof Error) || seen.has(value)) return false;
        seen.add(value);
        return (value as Error & { code?: string }).code === "SQLITE_IOERR_TRUNCATE"
          || hasTruncateError(value.cause, seen)
          || value instanceof AggregateError && value.errors.some(child => hasTruncateError(child, seen));
      };
      if (process.platform !== "win32" || sqliteFailureObserved || !hasTruncateError(error)) return;
      sqliteFailureObserved = true;
      const files = await Promise.all([input.journalPath, `${input.journalPath}-wal`, `${input.journalPath}-shm`].map(async file => {
        try { const metadata = await stat(file); return { file, exists: true, size: metadata.size }; }
        catch (cause) { return { file, exists: false, error: cause instanceof Error && "code" in cause ? cause.code : String(cause) }; }
      }));
      const controllerState = await inspectProcessProof(input.controller).catch(() => "unconfirmed" as const);
      let writableProbe: unknown = { attempted: false };
      if (holdsOriginalJob && controllerState === "stopped") {
        let db: Database.Database | undefined;
        try { db = new Database(input.journalPath, { fileMustExist: true, timeout: 5000 }); writableProbe = { attempted: true, userVersion: db.pragma("user_version", { simple: true }) }; }
        catch (cause) { writableProbe = { attempted: true, error: cause instanceof Error ? { name: cause.name, message: cause.message, code: "code" in cause ? cause.code : undefined } : String(cause) }; }
        finally { if (db) try { db.close(); } catch (cause) { diagnostic("sqlite-writable-probe-close", 0, cause); } }
      }
      diagnostic("sqlite-truncate-original-error", 0, error);
      console.error(JSON.stringify({ fixture: "bot-process-integration", stage: "sqlite-truncate-evidence", files, controllerState, holdsOriginalJob, writableProbe }));
    };
    return { ...operation, confirm: async () => {
      try { return await operation.confirm(); } catch (error) { await inspectFailure(error).catch(cause => diagnostic("sqlite-truncate-diagnostic", 0, cause)); throw error; }
    }, commit: async hooks => {
      try { return await operation.commit(hooks); } catch (error) { await inspectFailure(error).catch(cause => diagnostic("sqlite-truncate-diagnostic", 0, cause)); throw error; }
    }, stop: async (deadline, options) => {
    const started = Date.now();
    try { await operation.stop(deadline, options); }
    catch (error) {
      diagnostic("stop-original-processes", Date.now() - started, error);
      await inspectFailure(error).catch(cause => diagnostic("sqlite-truncate-diagnostic", 0, cause));
      // Only inspect identities created by this fixture; retain the original
      // failure even if a diagnostic probe also fails.
      const identities = await Promise.all([input.controller, ...input.native].map(async proof => ({ pid: proof.pid, state: await inspectProcessProof(proof).catch(() => "unconfirmed") })));
      const jobMembers = input.controller.jobObjectName === undefined ? null : await inspectControllerJob(input.controller.jobObjectName).catch(() => "unconfirmed");
      console.error(JSON.stringify({ fixture: "bot-process-integration", stage: "stop-original-process-evidence", elapsedMs: Date.now() - started, deadlineExpired: Date.now() >= deadline, identities, jobMembers }));
      throw error;
    } } };
  };
  const create = () => createBotProcess({ homeDirectory: home, packageDirectory, store, executions, sessionApi: api, recoveryLimit: 3, dependencies: { prepareEnvironment, openStop } });
  const botProcess = create();
  const frames: ReturnType<typeof parseControllerMessage>[] = [], relayErrors: unknown[] = [];
  let browserConnections = 0, deleted = false;
  relay.on("connection", (socket, request) => {
    if (request.url === "/browser-fixture") { browserConnections++; return; }
    if (request.url !== "/api/v1/controller-channel" || request.headers.authorization !== "Bearer controlled-relay-grant") { socket.close(1008); return; }
    socket.on("message", raw => {
      if (deleted) { socket.close(1008); return; }
      try {
        const message = parseControllerMessage(JSON.parse(raw.toString())); frames.push(message);
        const fence = { protocol: SESSION_PROTOCOL, sessionId: bot.sessionId!, testExecutionId: current().intent!.executionId, executionGeneration: current().intent!.executionGeneration, connectionEpoch: "1" };
        if (message.type === "hello") socket.send(JSON.stringify({ type: "welcome", protocol: SESSION_PROTOCOL, connectionEpoch: "1", session: snapshot(current()), lastAckedSourceSeq: "0", limits: RELAY_LIMITS, requiresLiveSync: true }));
        else if (message.type === "reconcile") socket.send(JSON.stringify({ ...fence, type: "reconcile_result", operations: [] }));
        else if (message.type === "events") socket.send(JSON.stringify({ ...fence, type: "events_ack", sourceEpoch: message.sourceEpoch, batchId: message.batchId, lastAckedSourceSeq: message.events.at(-1)!.sourceSeq, lastEventSeq: message.events.at(-1)!.sourceSeq }));
        else if (message.type === "sync_state") socket.send(JSON.stringify({ ...fence, type: "sync_ack" }));
      } catch (error) { relayErrors.push(error); socket.close(1008); }
    });
  });
  const journal = () => { const intent = current().intent; return intent === null ? null : readControllerSnapshot(path.join(controllerExecutionDirectory(home, intent.executionId), "journal.sqlite")); };
  const launches = async () => existsSync(launchLog) ? (await readFile(launchLog, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { pid: number; proof: ProcessProof; argv: string[] }) : [];
  const guardianEvents = async () => existsSync(guardianExitLog) ? (await readFile(guardianExitLog, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { launchId: string; pid: number; proof?: ProcessProof; started?: boolean; exited?: boolean }) : [];
  const guardianExitFailure = async (): Promise<Error | null> => {
    const record = current(), intent = record.intent, saved = journal();
    if (intent === null || saved?.controllerProcess != null || !saved?.error || !["Original Windows guardian exited before its startup was confirmed.", "Windows guardian startup failed:"].some(value => saved.error!.startsWith(value)) || saved.nativeProcesses.length !== 0) return null;
    const launch = (await launches()).find(value => value.argv[3] === intent.launchId);
    if (!launch || launch.pid !== launch.proof?.pid || await inspectProcessProof(launch.proof) === "running") return null;
    const ticket = await botProcess.readTicket(record);
    if (readWindowsJobSource(intent.journalPath, ticket) !== null) return null;
    const log = await readEvidence(path.join(path.dirname(intent.journalPath), `guardian-${intent.launchId}.log`));
    return new Error(`Original fixture Controller exited after guardian startup failed; source remains unknown. ${log.exists ? log.text : "Guardian log unavailable."}`);
  };
  const stopUnassignedGuardian = async (): Promise<void> => {
    const intent = current().intent;
    if (!intent) throw new Error("Original fixture guardian identity is unavailable.");
    const events = (await guardianEvents()).filter(event => event.launchId === intent.launchId);
    const started = events.filter(event => event.started === true && Number.isSafeInteger(event.pid) && event.pid > 0);
    if (started.length === 0) throw new Error("Original fixture guardian launch is unconfirmed; its responsibility is retained.");
    for (const event of started) {
      if (events.some(item => item.exited === true && item.pid === event.pid)) continue;
      const original = events.find(item => item.pid === event.pid && item.proof?.pid === event.pid)?.proof;
      if (!original) throw new Error("Original fixture guardian exit or process identity is unconfirmed; its responsibility is retained.");
      if (await inspectProcessProof(original) !== "running") continue;
      process.kill(original.pid, "SIGKILL");
      await vi.waitFor(async () => expect(await inspectProcessProof(original)).not.toBe("running"), { timeout: 15_000, interval: 100 });
    }
  };
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
    let stopped = true;
    try {
      const record = current(), execution = record.intent === null ? null : executions.get(record);
      if (execution !== null && execution.launchSubmission !== "not-submitted") {
        // The parent can lose its spawn observation before the child writes its
        // ownership. Retain the original child's journal, including its Windows
        // Job Object, rather than freezing that earlier empty snapshot.
        const evidenceStarted = Date.now();
        let saved = journal();
        try {
          while (saved?.controllerProcess == null && Date.now() - evidenceStarted < 30_000) {
            const failure = await guardianExitFailure();
            if (failure) throw failure;
            await delay(100);
            saved = journal();
          }
          if (saved?.controllerProcess == null) throw new Error("Original fixture process proof is not durable yet.");
        } catch (error) {
          if (await guardianExitFailure()) {
            try { await stopUnassignedGuardian(); }
            catch (cause) { throw new AggregateError([error, cause], "Guardian startup and fixture process cleanup remain unconfirmed.", { cause: error }); }
            throw error;
          }
          diagnostic("cleanup-await-original-proof", Date.now() - evidenceStarted, error);
        }
        saved = journal() ?? saved;
        const proof = saved?.controllerProcess ?? execution.controllerProcess;
        if (proof !== null) {
          const ticket = await botProcess.readTicket(record), operation = await openStop({ journalPath: record.intent!.journalPath, ticket, controller: proof, native: saved?.nativeProcesses ?? [] });
          try {
            let graceful = false;
            try { await requestController(ticket, { kind: "stop", deadline: Date.now() + 10_000 }, { timeoutMs: 12_000 }); graceful = true; } catch { /* OS evidence still owns cleanup completion. */ }
            await stopFixtureProcesses(operation, proof, saved?.nativeProcesses ?? [], graceful);
            stopped = await operation.confirm();
            expect(stopped).toBe(true);
            await operation.commit();
          } finally { await operation.close(); }
          operation.recheck();
        } else { stopped = false; throw new Error("Spawned fixture has no process proof; evidence retained."); }
      }
      const recordNow = current();
      if (recordNow.intent !== null && process.platform !== "win32") {
        const ticket = await botProcess.readTicket(recordNow).catch(() => null);
        if (ticket !== null) await rm(path.dirname(ticket.ipcEndpoint), { recursive: true, force: true });
      }
    } catch (error) {
      stopped = false;
      try { await collectEvidence(); } catch (diagnosticError) { diagnostic("read-original-startup-evidence", 0, diagnosticError); }
      throw error;
    }
    finally {
      for (const socket of relay.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => relay.close(error => error ? reject(error) : resolve()));
      if (http !== null) await new Promise<void>((resolve, reject) => { http.close(error => error ? reject(error) : resolve()); http.closeAllConnections(); });
      executions.close(); store.close();
      if (stopped && !sqliteFailureObserved) {
        if (socketDirectory !== null) await rm(socketDirectory, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
      }
    }
  });
  const requests = async () => (await readFile(requestLog, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
  return { home, cwd, packageDirectory, prepareEnvironment, http, snapshot, getBot: () => bot, setBot: (value: BotDefinition) => { bot = value; }, current, store, executions, api, revoke: () => { deleted = true; for (const client of relay.clients) client.close(1008); }, process: botProcess, create, register, grant, requests, launches, frames, relayErrors, owner, journal, guardianExitFailure, nativeId, browserConnections: () => browserConnections };
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
  await waitForFixture(f, async () => expect(await f.process.observe(f.current(), signal)).toMatchObject({ lifecycle: "ready", activity: "idle", nativeSessionId: f.nativeId, initialInputState: "not_required" }), 60_000);
  expect(await f.process.readTicket(f.current())).toEqual(originalTicket);
};

const waitForFixture = async (f: Awaited<ReturnType<typeof fixture>>, check: () => void | Promise<void>, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let failure: unknown;
  for (;;) {
    const exited = await f.guardianExitFailure();
    if (exited) throw exited;
    try { await check(); return; } catch (error) { failure = error; }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw failure;
    await delay(Math.min(100, remaining));
  }
};

test("reports a confirmed guardian startup exit without retrying readiness", async () => {
  const failure = new Error("Original fixture guardian exited"), check = vi.fn();
  const f = { guardianExitFailure: async () => failure } as Awaited<ReturnType<typeof fixture>>;
  await expect(waitForFixture(f, check, 60_000)).rejects.toBe(failure);
  expect(check).not.toHaveBeenCalled();
});

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
  await waitForFixture(f, () => { expect(f.journal()).toMatchObject({ startup: { state: "failed", reasonCode: "native_rejected" }, nativeSessionId: null, initialInputState: "not_required" }); }, 20_000);
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
    await waitForFixture(f, async () => { expect(await f.process.observe(f.current(), signal)).toMatchObject({ lifecycle: "ready", nativeSessionId: f.nativeId }); }, 20_000);
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
    await waitForFixture(f, async () => { expect(await f.process.observe(f.current(), signal)).toMatchObject({ lifecycle: "ready", nativeSessionId: f.nativeId, executionGeneration: String(generation + 1) }); }, 20_000);
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
      for (const proof of [finalWriter.controllerProcess!, ...finalWriter.nativeProcesses]) expect(await inspectProcessProof(proof)).not.toBe("running");
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
    serverToken: parentToken, configuration: () => ({ agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 3 }),
    recoveryLimit: () => 3, pollIntervalMs: () => 50, emit: event => { if (event.kind === "bot-unavailable") errors.push(event.message); } });
  let host = makeHost(), cancellation = new AbortController(), running = host.run(cancellation.signal);
  void running.catch(error => errors.push(String(error)));
  const stop = async () => { cancellation.abort(); try { await host.shutdown(); await running; } finally { host.close(); } };
  // This cleanup runs before the fixture's original-process cleanup, even on failure.
  cleanups.push(stop);
  await waitForFixture(f, () => { expect(f.getBot().startupResult.state, errors.join("\n")).toBe("ready"); }, 60_000);
  const first = f.current().intent!;
  const sentinel = path.join(f.cwd, "keep.txt"); await writeFile(sentinel, "user data");
  expect(await f.launches()).toHaveLength(1);
  await stop();
  expect(f.journal()).toMatchObject({ nativeStopped: true, nativeSessionId: f.nativeId });
  host = makeHost(); cancellation = new AbortController(); running = host.run(cancellation.signal);
  void running.catch(error => errors.push(String(error)));
  await waitForFixture(f, () => { expect(f.journal()).toMatchObject({ lifecycle: "ready", nativeSessionId: f.nativeId, executionGeneration: "2" }); }, 60_000);
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
