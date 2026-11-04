import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, expect, test, vi } from "vitest";
import { createBotProcess } from "../../../src/commands/worker/bots/process.js";
import { openBotStore } from "../../../src/commands/worker/bots/store.js";
import { openBotExecutionStore } from "../../../src/commands/worker/bots/execution-store.js";
import type { BotDefinition, BotRecord } from "../../../src/commands/worker/bots/types.js";
import { controllerExecutionDirectory } from "../../../src/commands/controller/launch-ticket.js";
import { readControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import { requestController } from "../../../src/commands/controller/local-client.js";
import { confirmControllerProcessesStopped, inspectProcessProof, stopControllerProcesses } from "../../../src/commands/controller/process-proof.js";
import { parseControllerMessage, RELAY_LIMITS } from "../../../src/session/controller-protocol.js";
import { SESSION_PROTOCOL, type SessionSnapshot } from "../../../src/session/protocol.js";
import snapshotFixture from "../../session/fixtures/snapshot.json" with { type: "json" };

// The subprocess uses the production Controller, native adapter, journal, IPC and
// relay. Only the Codex executable and the remote service are controlled fixtures.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) try { await cleanup(); } catch (error) { errors.push(error); }
  vi.unstubAllEnvs();
  if (errors.length) throw new AggregateError(errors, "Bot integration resources did not close safely.");
});

const fixture = async (options: { rejectRole?: boolean; args?: string[] } = {}) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/bot-process-integration");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")), state = path.join(home, "state"), cwd = path.join(home, "ordinary");
  await mkdir(cwd); vi.stubEnv("DN_CONFIG_DIR", state);
  const packageDirectory = path.join(home, "package"), dist = path.resolve(import.meta.dirname, "../../../dist");
  await mkdir(path.join(packageDirectory, "dist"), { recursive: true });
  const requestLog = path.join(home, "native-requests.jsonl"), launchLog = path.join(home, "controllers.jsonl"), nativeId = randomUUID();
  const nativeFixture = path.join(home, "codex-native.mjs");
  await writeFile(nativeFixture, (await readFile(path.resolve(import.meta.dirname, "../controller/fixtures/codex-native.mjs"), "utf8")).replaceAll("native-thread", nativeId));
  const providerURL = pathToFileURL(path.join(dist, "commands/controller/providers/codex.js")).href;
  const runtimeURL = pathToFileURL(path.join(dist, "commands/controller/runtime.js")).href;
  const wrapper = path.join(packageDirectory, "provider.mjs"), wrapperURL = pathToFileURL(wrapper).href;
  await writeFile(wrapper, `import { openCodexProvider as open } from ${JSON.stringify(providerURL)};\nexport const openCodexProvider = options => open({ ...options, executable: ${JSON.stringify(nativeFixture)} });\n`);
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
  const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(relay, "listening");
  const address = relay.address(); if (typeof address === "string" || address === null) throw new Error("Missing fixture relay address.");
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
    return { ...baseSnapshot, protocol: SESSION_PROTOCOL, schemaVersion: 1, projectionVersion: 1, testExecutionId: record.intent!.executionId, sessionId: bot.sessionId!, executionGeneration: "1", connectionEpoch: "1",
      identity: { ownerUserId: owner.ownerUserId, controllerId: record.intent!.registration.controllerId, controllerInstanceId: record.intent!.registration.controllerInstanceId, provider: "codex", agentControlMode: "web", nativeSessionId: nativeId },
      initialInputState: "not_required", historyEpoch: "bot-fixture-history", lastEventSeq: "0", lastTimelineSeq: "0", lifecycle: "active", connectionState: "connected", synchronized: true, activity: "idle" };
  };
  const register = vi.fn(async (record: BotRecord) => {
    expect(record.intent?.roleConfiguration).not.toBeNull();
    bot = { ...bot, version: "2", sessionId: randomUUID(), testExecutionId: record.intent!.executionId, roleConfiguration: record.intent!.roleConfiguration };
    return { bot, snapshot: snapshot(record) };
  });
  const grant = vi.fn(async (record: BotRecord) => ({ token: "controlled-relay-grant", expiresAt: new Date(Date.now() + 900_000).toISOString(), sessionId: bot.sessionId!, testExecutionId: record.intent!.executionId, executionGeneration: "1", controllerId: record.intent!.registration.controllerId, controllerInstanceId: record.intent!.registration.controllerInstanceId }));
  const api = { register, grant, readSession: async (record: BotRecord) => snapshot(record), report: async () => bot };
  const prepareEnvironment = async () => ({ environment: { ...process.env, DN_CONFIG_DIR: state, CODEX_HOME: path.join(home, "native"), CODEX_TEST_REQUEST_LOG: requestLog, EXPECT_WORKER_PERMISSIONS: "no", ...(options.rejectRole ? { CODEX_TEST_REJECT_ROLE: "Fixture role configuration refused" } : {}) }, aliasDirectory: null, bindings: [], release: async () => {} });
  const create = () => createBotProcess({ homeDirectory: home, packageDirectory, store, executions, sessionApi: api, recoveryLimit: 3, dependencies: { prepareEnvironment } });
  const botProcess = create();
  const frames: ReturnType<typeof parseControllerMessage>[] = [], relayErrors: unknown[] = [];
  let browserConnections = 0;
  relay.on("connection", (socket, request) => {
    if (request.url === "/browser-fixture") { browserConnections++; return; }
    if (request.url !== "/api/v1/controller-channel" || request.headers.authorization !== "Bearer controlled-relay-grant") { socket.close(1008); return; }
    socket.on("message", raw => {
      try {
        const message = parseControllerMessage(JSON.parse(raw.toString())); frames.push(message);
        const fence = { protocol: SESSION_PROTOCOL, sessionId: bot.sessionId!, testExecutionId: current().intent!.executionId, executionGeneration: "1", connectionEpoch: "1" };
        if (message.type === "hello") socket.send(JSON.stringify({ type: "welcome", protocol: SESSION_PROTOCOL, connectionEpoch: "1", session: snapshot(current()), lastAckedSourceSeq: "0", limits: RELAY_LIMITS, requiresLiveSync: true }));
        else if (message.type === "reconcile") socket.send(JSON.stringify({ ...fence, type: "reconcile_result", operations: [] }));
        else if (message.type === "events") socket.send(JSON.stringify({ ...fence, type: "events_ack", sourceEpoch: message.sourceEpoch, batchId: message.batchId, lastAckedSourceSeq: message.events.at(-1)!.sourceSeq, lastEventSeq: message.events.at(-1)!.sourceSeq }));
        else if (message.type === "sync_state") socket.send(JSON.stringify({ ...fence, type: "sync_ack" }));
      } catch (error) { relayErrors.push(error); socket.close(1008); }
    });
  });
  const journal = () => { const intent = current().intent; return intent === null ? null : readControllerSnapshot(path.join(controllerExecutionDirectory(home, intent.executionId), "journal.sqlite")); };
  cleanups.push(async () => {
    let stopped = true;
    try {
      const record = current(), execution = record.intent === null ? null : executions.get(record), saved = journal();
      if (execution !== null && execution.launchSubmission !== "not-submitted") {
        const proof = saved?.controllerProcess ?? execution.controllerProcess, native = saved?.nativeProcesses ?? [];
        try { const ticket = await botProcess.readTicket(record); await requestController(ticket, { kind: "stop", deadline: Date.now() + 10_000 }, { timeoutMs: 12_000 }); } catch { /* Process proof below owns cleanup completion. */ }
        if (proof !== null) {
          // A cooperative stop can finish between process/group probes. Observe
          // that completion before escalating the exact retained process group.
          try { await vi.waitFor(async () => expect(await confirmControllerProcessesStopped(proof, native)).toBe(true), { timeout: 5000, interval: 100 }); }
          catch { await stopControllerProcesses(proof, native, Date.now() + 10_000); }
          stopped = await confirmControllerProcessesStopped(proof, native);
          expect(stopped).toBe(true);
        } else { stopped = false; throw new Error("Spawned fixture has no process proof; evidence retained."); }
      }
      const recordNow = current();
      if (recordNow.intent !== null && process.platform !== "win32") {
        const ticket = await botProcess.readTicket(recordNow).catch(() => null);
        if (ticket !== null) await rm(path.dirname(ticket.ipcEndpoint), { recursive: true, force: true });
      }
    } catch (error) { stopped = false; throw error; }
    finally {
      for (const socket of relay.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => relay.close(error => error ? reject(error) : resolve()));
      executions.close(); store.close();
      if (stopped) await rm(home, { recursive: true, force: true });
    }
  });
  const requests = async () => (await readFile(requestLog, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
  const launches = async () => existsSync(launchLog) ? (await readFile(launchLog, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { pid: number }) : [];
  return { home, cwd, current, store, executions, process: botProcess, create, register, grant, requests, launches, frames, relayErrors, owner, journal, nativeId, browserConnections: () => browserConnections };
};

test("launches the real Controller and Codex adapter with no user turn, then observes the same writer after browser disconnect", async () => {
  const f = await fixture(), signal = AbortSignal.timeout(30_000);
  await f.process.advance(f.current(), signal);
  await vi.waitFor(async () => expect(await f.process.observe(f.current(), signal)).toMatchObject({ lifecycle: "ready", activity: "idle", nativeSessionId: f.nativeId, initialInputState: "not_required" }), { timeout: 20_000, interval: 100 });
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
