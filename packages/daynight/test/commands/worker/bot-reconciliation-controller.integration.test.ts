import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { expect, test, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { resolveToolLaunch } from "../../../src/platform/tool-executables.js";
import { createWorkerBotHost } from "../../../src/commands/worker/bots/host.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import * as environment from "../../../src/commands/worker/bots/environment.js";
import { readControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import { confirmControllerProcessesStopped, inspectProcessProof, stopControllerProcesses } from "../../../src/commands/controller/process-proof.js";
import { requestController, ControllerIpcOutcomeUnknownError } from "../../../src/commands/controller/local-client.js";
import * as controllerRequests from "../../../src/commands/controller/local-client.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { acquireControllerJobLease, releaseControllerJobLease, type ControllerJobLease } from "../../../src/commands/controller/windows-job.js";
import { parseControllerMessage, RELAY_LIMITS } from "../../../src/session/controller-protocol.js";
import { parseBotHistoryCheckpoint } from "../../../src/session/bot-history-window.js";
import { SESSION_PROTOCOL, type SessionSnapshot } from "../../../src/session/protocol.js";
import type { BotDefinition, BotLaunchIntent } from "../../../src/commands/worker/bots/types.js";
import type { BotRecoveryResult } from "../../../src/commands/worker/bots/recovery-protocol.js";

// Real Host, Controller, IPC, SQLite, locks and native subprocesses; only the
// service and Codex protocol endpoint are controlled dependencies.
test.each([false, true])("a rebuilt Host reconnects the live original Controller with an empty inventory (lost stop receipt: %s)", async loseStopReceipt => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/bot-reconciliation-controller");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")), state = path.join(home, "state"), cwd = path.join(home, "cwd");
  await mkdir(cwd); vi.stubEnv("DN_CONFIG_DIR", state);
  const paths = resolveWorkerPaths(home), nativeId = randomUUID(), botId = randomUUID();
  await mkdir(state);
  await environment.prepareBotStateDirectory(paths, botId);
  const requests = path.join(home, "requests.jsonl"), launches = path.join(home, "launches.jsonl");
  const packageDirectory = path.join(home, "package"), native = path.join(home, "native.mjs");
  const dist = path.resolve(import.meta.dirname, "../../../dist");
  await mkdir(path.join(packageDirectory, "dist"), { recursive: true });
  await writeFile(path.join(packageDirectory, "package.json"), JSON.stringify({ type: "module" }));
  const source = await readFile(path.resolve(import.meta.dirname, "../controller/fixtures/codex-bot-native.mjs"), "utf8");
  await writeFile(native, source.replaceAll("c7975cdc-936b-411e-9f63-cd0a37ad7cbf", nativeId));
  await writeFile(path.join(packageDirectory, "dist/main.js"), `
import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(launches)}, JSON.stringify({pid:process.pid})+'\\n');
const {runController}=await import(${JSON.stringify(pathToFileURL(path.join(dist, "commands/controller/runtime.js")).href)});
await runController({homeDirectory:${JSON.stringify(home)},provider:process.argv[3],launchId:process.argv[5],storageStateDirectory:process.env.DAYNIGHT_CONTROLLER_STORAGE_DIR});
`);
  const http = createServer(), relay = new WebSocketServer({ server: http });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address(); if (address === null || typeof address === "string") throw new Error("Missing fixture port");
  const owner = { serverOrigin: `http://127.0.0.1:${address.port}`, ownerUserId: randomUUID(), workerId: randomUUID() };
  const newWorker = randomUUID(), errors: string[] = [], calls: string[] = [];
  const stopRequests: string[] = [], request = controllerRequests.requestController;
  let stopReceiptLost = false;
  vi.spyOn(controllerRequests, "requestController").mockImplementation(async (...args) => {
    if (args[1].kind === "stop") stopRequests.push("started");
    try {
      const result = await request(...args);
      if (args[1].kind === "stop") {
        stopRequests.push("confirmed");
        if (loseStopReceipt && !stopReceiptLost) { stopReceiptLost = true; throw new ControllerIpcOutcomeUnknownError("Fixture lost the original stop receipt."); }
      }
      return result;
    }
    catch (error) { if (args[1].kind === "stop") stopRequests.push(String(error)); throw error; }
  });
  const receipts = new Map<string, BotRecoveryResult>();
  let hostingGeneration = "1", selectedToken = "", selectedOperation = "", synchronized = false, epoch = 0;
  let intent: BotLaunchIntent | null = null, observedNative: string | null = null;
  const retainedIntent = (): BotLaunchIntent => { if (intent === null) throw new Error("Fixture launch has no intent"); return intent; };
  let bot: BotDefinition = { id: botId, workerId: owner.workerId, ownerUserId: owner.ownerUserId, version: "1", name: "Recoverable", creationOrder: "1",
    requestedOverrides: {}, resolvedConfiguration: { workerId: owner.workerId, cwd, provider: "codex", model: null, args: [] }, roleConfiguration: null,
    sessionId: null, testExecutionId: null, startupResult: { state: "pending", code: null }, deletion: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const historyEpoch = randomUUID();
  const snapshot = (): SessionSnapshot => ({ protocol: SESSION_PROTOCOL, schemaVersion: 1, projectionVersion: 1,
    sessionId: bot.sessionId!, testExecutionId: bot.testExecutionId!, executionGeneration: "1", connectionEpoch: String(Math.max(epoch, 1)),
    identity: { ownerUserId: owner.ownerUserId, provider: "codex", agentControlMode: "web", controllerId: intent!.registration.controllerId,
      controllerInstanceId: intent!.controllerInstanceId, nativeSessionId: observedNative }, initialInputState: "not_required",
    sessionRevision: "1", historyEpoch, lastEventSeq: "0", lastTimelineSeq: "0", lifecycle: "active", connectionState: synchronized ? "connected" : "disconnected",
    synchronized, activity: "idle", currentTurnId: null, capabilities: { send: true, steer: false, cancel: false, respond: false },
    operations: { canSend: synchronized, canCancel: false, canRespond: false } });
  const sockets = new Set<WebSocket>();
  relay.on("connection", (socket, request) => {
    if (request.headers.authorization !== `Bearer ${selectedToken}`) { socket.close(1008); return; }
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    const connectionEpoch = String(++epoch);
    socket.on("message", raw => {
      try {
        const message = parseControllerMessage(JSON.parse(raw.toString()));
        const fence = { protocol: SESSION_PROTOCOL, sessionId: bot.sessionId!, testExecutionId: bot.testExecutionId!, executionGeneration: "1", connectionEpoch };
        if (message.type === "hello") socket.send(JSON.stringify({ type: "welcome", protocol: SESSION_PROTOCOL, connectionEpoch, session: snapshot(), lastAckedSourceSeq: "0", limits: RELAY_LIMITS, requiresLiveSync: true, ...(message.botHistoryWindowVersion === 1 ? { botHistoryWindowVersion: 1 } : {}) }));
        else if (message.type === "reconcile") socket.send(JSON.stringify({ ...fence, type: "reconcile_result", operations: [] }));
        else if (message.type === "events") {
          for (const event of message.events) if (event.kind === "state") observedNative = event.payload.nativeSessionId;
          socket.send(JSON.stringify({ ...fence, type: "events_ack", sourceEpoch: message.sourceEpoch, batchId: message.batchId, lastAckedSourceSeq: message.events.at(-1)!.sourceSeq, lastEventSeq: message.events.at(-1)!.sourceSeq }));
        }
        else if (message.type === "sync_state") {
          observedNative = message.state.nativeSessionId; synchronized = true;
          socket.send(JSON.stringify({ ...fence, type: "sync_ack" }));
        } else if (message.type === "operation_receipt") socket.send(JSON.stringify({ ...fence, type: "receipt_ack", operation: message.operation }));
      } catch (error) { errors.push(String(error)); socket.close(1008); }
    });
  });
  http.on("request", (req, res) => {
    void (async () => {
      res.setHeader("Content-Type", "application/json"); res.setHeader("Daynight-User-ID", owner.ownerUserId);
      const route = new URL(req.url!, owner.serverOrigin).pathname;
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      calls.push(`${req.method} ${route}`);
      const send = (value: unknown) => res.end(JSON.stringify(value));
      if (req.method === "PUT" && route === `/api/v1/test-sessions/${bot.sessionId}/bot-history-window/checkpoint`) {
        if (req.headers.authorization !== `Bearer ${selectedToken}`) { res.statusCode = 401; return send({}); }
        const { entries: _entries, ...receipt } = parseBotHistoryCheckpoint(body);
        expect(receipt.sessionId).toBe(bot.sessionId);
        expect(receipt.historyEpoch).toBe(historyEpoch);
        res.setHeader("Daynight-Bot-History-Window-Version", "1");
        return send({ ...receipt, cleanupPending: false });
      }
      if (route === "/api/usage/v1/capabilities") { res.statusCode = 503; return send({ error: { code: "capability_error", message: "Usage is outside this fixture", requestId: randomUUID() } }); }
      if (req.method === "GET" && route.endsWith("/bots")) return send({ items: [], nextCursor: null });
      if (req.method === "GET" && route === `/api/v1/me/bots/${botId}`) return send(bot);
      if (req.method === "GET" && route === `/api/v1/me/bots/${botId}/observation`) {
        const observedAt = new Date().toISOString();
        return send({ schemaVersion: 1, botId, botVersion: bot.version, workerId: hostingGeneration === "1" ? owner.workerId : newWorker,
          machine: { id: owner.workerId, name: "fixture-machine" }, provider: "codex", sessionId: bot.sessionId, testExecutionId: bot.testExecutionId,
          nativeSessionId: observedNative, hostingGeneration: receipts.size === 0 ? null : hostingGeneration,
          executionGeneration: bot.sessionId === null ? null : "1", connectionEpoch: bot.sessionId === null ? null : String(Math.max(epoch, 1)),
          state: synchronized ? "idle" : "connecting", reason: "fixture_observed", observedAt, workerLastSeenAt: observedAt,
          sessionLastSeenAt: synchronized ? observedAt : null, freshUntil: null, currentTurnId: null });
      }
      if (req.method === "GET" && route.startsWith("/api/v1/test-sessions/")) return send({ session: snapshot() });
      if (req.method === "GET" && ["/api/v1/assistant-tasks", "/api/v1/assistant-task-events"].includes(route)) return send({ items: [], nextCursor: null, observedAt: new Date().toISOString() });
      if (route.includes("/recovery/v1/operations/")) {
        const result = receipts.get(route.split("/").at(-1)!); if (!result) throw new Error("Unknown fixture operation");
        return send({ ...result, current: result.receipt.kind === "register" ? hostingGeneration === "1" : result.receipt.operationId === selectedOperation });
      }
      if (route.includes("/recovery/v1/") && !route.endsWith("/report")) {
        const kind = route.split("/").at(-1)! as "register" | "grant" | "takeover", workerId = route.split("/")[5]!;
        expect(body.sessionId).toBe(bot.sessionId); expect(body.testExecutionId).toBe(bot.testExecutionId);
        expect(body.nativeSessionId).toBe(observedNative);
        if (kind === "register" || kind === "takeover") bot = { ...bot, version: String(BigInt(bot.version) + 1n) };
        if (kind === "takeover") { expect(workerId).toBe(newWorker); hostingGeneration = "2"; bot = { ...bot, startupResult: { state: "pending", code: null } }; }
        if (kind !== "register") {
          expect(body.grant.executionGeneration).toBe("1"); expect(body.grant.previousGeneration).toBeNull();
          selectedToken = body.controllerToken; selectedOperation = body.operationId; synchronized = false;
          for (const socket of sockets) socket.close(1000, "Grant changed");
        }
        const result: BotRecoveryResult = { current: true, receipt: { botRecoveryVersion: 1, operationId: body.operationId, kind, workerId,
          hostingGeneration, botVersion: bot.version, sessionId: bot.sessionId!, testExecutionId: bot.testExecutionId!, nativeSessionId: body.nativeSessionId,
          executionGeneration: "1", controllerId: intent!.registration.controllerId, controllerInstanceId: intent!.controllerInstanceId,
          grantExpiresAt: kind === "register" ? null : new Date(Date.now() + 300_000).toISOString(),
          controllerTokenHash: kind === "register" ? null : createHash("sha256").update(selectedToken).digest("hex") } };
        receipts.set(body.operationId, result); return send(result);
      }
      if (route.endsWith("/register")) {
        bot = { ...bot, version: "2", sessionId: randomUUID(), testExecutionId: body.registration.testExecutionId, roleConfiguration: body.roleConfiguration };
        return send({ bot, session: snapshot() });
      }
      if (route.endsWith("/report")) {
        expect(body.report.result.state).toBe("ready"); expect(synchronized).toBe(true);
        bot = { ...bot, version: String(BigInt(bot.version) + 1n), startupResult: body.report.result }; return send(bot);
      }
      throw new Error(`Unexpected request ${req.method} ${route}`);
    })().catch(error => { errors.push(String(error)); res.statusCode = 500; res.end(JSON.stringify({ error: { code: "fixture_error", message: "Controlled service failed", requestId: randomUUID() } })); });
  });
  const prepareEnvironment: typeof environment.prepareBotEnvironment = async () => ({
    environment: { ...process.env, DN_CONFIG_DIR: state, CODEX_HOME: path.join(home, "native-home"), CODEX_BOT_REQUEST_LOG: requests },
    aliasDirectory: null, bindings: [], release: async () => {} });
  vi.spyOn(environment, "prepareBotEnvironment").mockImplementation(prepareEnvironment);
  const selectToolLaunch = async (_agent: "codex" | "copilot", signal: AbortSignal) => {
    const operation = createOperation({ signal });
    try { return await resolveToolLaunch({ tool: "codex", context: "web", choice: { kind: "path", path: native }, environment: process.env, cwd }, operation); }
    finally { operation.dispose(); }
  };
  const hostInput = path.join(home, "original-host.json");
  await writeFile(hostInput, JSON.stringify({ dist, home, state, owner, bot, native, cwd, packageDirectory, requests }));
  const originalHost = spawn(process.execPath, [path.join(import.meta.dirname, "fixtures/bot-recovery-host.mjs"), hostInput], {
    env: { ...process.env, DN_CONFIG_DIR: state }, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
  });
  let originalOutput = "";
  originalHost.stdout!.on("data", chunk => { originalOutput += String(chunk); });
  originalHost.stderr!.on("data", chunk => { originalOutput += String(chunk); });
  const hostExited = new Promise<void>((resolve, reject) => { originalHost.once("error", reject); originalHost.once("close", () => resolve()); });
  const hostReady = new Promise<ControllerLaunchTicket>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Original host readiness exceeded its deadline: ${originalOutput}`)), 60_000);
    originalHost.once("error", error => { clearTimeout(timer); reject(error); });
    originalHost.once("close", () => { clearTimeout(timer); reject(new Error(`Original host exited before readiness: ${originalOutput}`)); });
    originalHost.on("message", (message: { kind?: string; intent?: BotLaunchIntent; ticket?: ControllerLaunchTicket }) => {
      if (message.kind === "intent" && message.intent !== undefined) { intent = message.intent; originalHost.send({ kind: "intent-received" }); }
      else if (message.kind === "ready" && message.ticket !== undefined) { clearTimeout(timer); resolve(message.ticket); }
    });
  });
  void hostReady.catch(() => {});
  let observerLease: ControllerJobLease | undefined, host: ReturnType<typeof createWorkerBotHost> | undefined;
  let running: Promise<void> | undefined;
  let ticket: ControllerLaunchTicket | undefined;
  let originalSnapshot: ReturnType<typeof readControllerSnapshot> | undefined;
  const cancellation = new AbortController();
  let stopped = false, hostClosed = false, testFailed = false;
  try {
    ticket = await hostReady;
    await vi.waitFor(() => expect(readControllerSnapshot(intent!.journalPath)).toMatchObject({ lifecycle: "ready", nativeSessionId: nativeId }), { timeout: 30_000, interval: 100 });
    const first = readControllerSnapshot(intent!.journalPath)!;
    originalSnapshot = first;
    if (process.platform === "win32") {
      if ("kind" in first.controllerProcess!) throw new Error("Linux Controller cannot own a Windows Job.");
      observerLease = await acquireControllerJobLease(intent!.launchId, first.controllerProcess!, Date.now() + 10_000);
    }
    // Crash the real owner instead of using graceful close to abandon live resources.
    originalHost.kill("SIGKILL"); await hostExited;
    expect(await inspectProcessProof(first.controllerProcess!)).toBe("running");
    host = createWorkerBotHost({ homeDirectory: home, packageDirectory, workingDirectory: cwd, paths, owner: { ...owner, workerId: newWorker },
      serverToken: "fixture-parent-token", canAdmitNewExecution: () => true, selectToolLaunch,
      configuration: () => ({ agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 3 }), recoveryLimit: () => 3,
      pollIntervalMs: () => 200, emit: event => { if (event.kind === "bot-unavailable") errors.push(event.message); } });
    const machineReportPending = "Bot recovery requires a confirmed Worker machine identity report before preparing an operation.";
    running = host.run(cancellation.signal); void running.catch(error => errors.push(String(error)));
    await vi.waitFor(() => expect(errors.some(error => error.includes(machineReportPending))).toBe(true), { timeout: 15_000, interval: 100 });
    expect(calls.filter(call => call.endsWith("/takeover"))).toHaveLength(0);
    const waiting = JSON.parse(await readFile(path.join(state, "bots", botId, "recovery.json"), "utf8"));
    expect(waiting).toMatchObject({ pending: null, current: { receipt: { workerId: owner.workerId, hostingGeneration: "1" } } });
    expect(await inspectProcessProof(first.controllerProcess!)).toBe("running");
    host.confirmMachineReport();
    await vi.waitFor(() => expect(bot.startupResult.state, errors.join("\n")).toBe("ready"), { timeout: 40_000, interval: 100 });
    const current = readControllerSnapshot(intent!.journalPath)!;
    expect(current.controllerProcess).toEqual(first.controllerProcess);
    expect(current.nativeProcesses).toEqual(first.nativeProcesses);
    expect(current).toMatchObject({ executionGeneration: "1", nativeSessionId: nativeId, initialInputState: "not_required" });
    expect(await inspectProcessProof(first.controllerProcess!)).toBe("running");
    expect((await readFile(launches, "utf8")).trim().split("\n")).toHaveLength(1);
    const nativeCalls = (await readFile(requests, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { method: string });
    expect(nativeCalls.filter(call => call.method === "thread/start")).toHaveLength(1);
    expect(nativeCalls.some(call => ["thread/resume", "turn/start"].includes(call.method))).toBe(false);
    expect(calls.filter(call => call.endsWith("/takeover"))).toHaveLength(1);
    expect(calls.some(call => call === `GET /api/v1/me/workers/${newWorker}/bots`)).toBe(true);
    expect(bot.workerId).toBe(owner.workerId); expect(bot.resolvedConfiguration.workerId).toBe(owner.workerId);
    const persisted = JSON.parse(await readFile(path.join(state, "bots", botId, "recovery.json"), "utf8"));
    expect(persisted).toMatchObject({ pending: null, current: { receipt: { workerId: newWorker, hostingGeneration: "2" } } });
    expect(errors.filter(error => !error.includes("requires a synchronized active Session") && !error.includes(machineReportPending))).toEqual([]);
  } catch (error) {
    testFailed = true;
    console.error(JSON.stringify({ errors, calls: [...new Set(calls)], synchronized, observedNative, hostingGeneration }));
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [], unknownStops: unknown[] = [];
    const onlyUnknownIpc = (error: unknown): boolean => error instanceof ControllerIpcOutcomeUnknownError
      || error instanceof AggregateError && error.errors.length > 0 && error.errors.every(onlyUnknownIpc);
    const cleanup = async (action: () => unknown | Promise<unknown>, reconcileStop = false) => {
      try { await action(); } catch (error) { (reconcileStop && onlyUnknownIpc(error) ? unknownStops : cleanupErrors).push(error); }
    };
    cancellation.abort();
    if (host) await cleanup(() => host!.shutdown(), true);
    if (originalHost.exitCode === null && originalHost.signalCode === null) originalHost.kill("SIGKILL");
    await cleanup(() => hostExited);
    if (ticket === undefined && intent !== null) await cleanup(async () => {
      if (existsSync(retainedIntent().ticketPath)) ticket = JSON.parse(await readFile(retainedIntent().ticketPath, "utf8")) as ControllerLaunchTicket;
    });
    if (running) await cleanup(() => running, true);
    await cleanup(() => {
      const retained = intent as BotLaunchIntent | null;
      stopped = retained === null || readControllerSnapshot(retained.journalPath)?.nativeStopped === true;
    });
    if (!stopped && ticket) {
      // Each fallback and cleanup runs independently: an unknown IPC result
      // cannot prevent releasing the fixture's listeners and process handles.
      if (unknownStops.length === 0) await cleanup(() => requestController(ticket!, { kind: "stop", deadline: Date.now() + 20_000 }, { timeoutMs: 25_000 }), true);
      await cleanup(async () => {
        const saved = readControllerSnapshot(retainedIntent().journalPath)!;
        if (!saved.controllerProcess) throw new Error("Fixture has no Controller process proof for cleanup");
        const deadline = Date.now() + 20_000;
        if (!await confirmControllerProcessesStopped(saved.controllerProcess, saved.nativeProcesses, deadline, observerLease)) {
          await stopControllerProcesses(saved.controllerProcess, saved.nativeProcesses, deadline, observerLease);
        }
        await vi.waitFor(async () => expect(await confirmControllerProcessesStopped(saved.controllerProcess!, saved.nativeProcesses, deadline, observerLease)).toBe(true), { timeout: 20_000, interval: 100 });
        stopped = true;
      });
    }
    let boundaryConfirmed = unknownStops.length === 0;
    if (unknownStops.length) await cleanup(async () => {
      const saved = readControllerSnapshot(retainedIntent().journalPath);
      if (saved?.controllerProcess == null) throw new Error("Original Controller boundary is unavailable for stop reconciliation.");
      const deadline = Date.now() + 20_000;
      await vi.waitFor(async () => expect(await confirmControllerProcessesStopped(saved.controllerProcess!, saved.nativeProcesses, deadline, observerLease)).toBe(true), { timeout: 20_000, interval: 100 });
      boundaryConfirmed = true;
    });
    if (host && stopped && boundaryConfirmed) await cleanup(() => host!.shutdown());
    if (unknownStops.length) await cleanup(async () => {
      // Reconcile the original generation once; a lost receipt never authorizes
      // replaying the stop request or replacing its Controller and native Session.
      const original = retainedIntent(), saved = readControllerSnapshot(original.journalPath);
      expect(saved).toMatchObject({ executionId: original.executionId, executionGeneration: original.executionGeneration,
        controllerInstanceId: original.controllerInstanceId, sessionId: ticket!.sessionId, nativeSessionId: nativeId, nativeStopped: true });
      expect(saved?.controllerProcess).toEqual(originalSnapshot?.controllerProcess);
      expect(saved?.nativeProcesses).toEqual(originalSnapshot?.nativeProcesses);
      expect(saved?.controllerProcess).not.toBeNull();
      expect(await confirmControllerProcessesStopped(saved!.controllerProcess!, saved!.nativeProcesses, Date.now() + 20_000, observerLease)).toBe(true);
      expect(stopped).toBe(true);
    });
    if (loseStopReceipt && !testFailed) await cleanup(() => {
      expect(stopReceiptLost).toBe(true); expect(unknownStops.length).toBeGreaterThan(0);
      expect(stopRequests.filter(state => state === "started")).toHaveLength(1);
    });
    if (host) await cleanup(async () => { await host!.close(); hostClosed = true; });
    if (observerLease) await cleanup(() => releaseControllerJobLease(observerLease!));
    for (const socket of sockets) await cleanup(() => socket.terminate());
    await cleanup(() => new Promise<void>((resolve, reject) => relay.close(error => error ? reject(error) : resolve())));
    await cleanup(() => new Promise<void>((resolve, reject) => { http.close(error => error ? reject(error) : resolve()); http.closeAllConnections(); }));
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    if (stopped && (!host || hostClosed)) await cleanup(() => rm(home, { recursive: true, force: true }));
    else if (intent && existsSync((intent as BotLaunchIntent).journalPath)) console.error(`Retained unconfirmed fixture evidence: ${home}`);
    if (cleanupErrors.length) {
      console.error(JSON.stringify({ stopRequests }));
      const error = new AggregateError(cleanupErrors, "Controller reconciliation fixture cleanup failed");
      if (testFailed) console.error(error);
      else throw error;
    }
  }
}, 120_000);
