import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { afterEach, expect, test, vi } from "vitest";
import { controllerExecutionDirectory, readLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { readControllerOperation, readControllerSnapshot, readProvenWindowsStoppedControllerGeneration } from "../../../src/commands/controller/lifecycle-store.js";
import { resolveControllerIpcEndpoint } from "../../../src/commands/controller/paths.js";
import { confirmControllerProcessesStopped, inspectProcessProof, type ProcessProof } from "../../../src/commands/controller/process-proof.js";
import { createWebExecutionBackend } from "../../../src/commands/worker/backends/web.js";
import { createWebControllerLauncher } from "../../../src/commands/worker/backends/web-process.js";
import { createControllerJobLeases } from "../../../src/commands/worker/backends/controller-job-leases.js";
import { acquireControllerJobLease, inspectControllerJobLease, releaseControllerJobLease, type ControllerJobLease } from "../../../src/commands/controller/windows-job.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import type { LocalTask } from "../../../src/commands/worker/backends/web-types.js";
import type { WorkerSessionApi } from "../../../src/commands/worker/backends/session-api.js";
import type { WorkerGitManager } from "../../../src/commands/worker/execution.js";
import type { ClaimIdentity, WorktreeBinding } from "../../../src/commands/worker/types.js";
import { parseControllerMessage, RELAY_LIMITS } from "../../../src/session/controller-protocol.js";
import { parseSessionSnapshot, SESSION_PROTOCOL } from "../../../src/session/protocol.js";
import snapshotFixture from "../../session/fixtures/snapshot.json" with { type: "json" };

// Store, backend, launcher, Controller, journal, IPC and Provider use their real
// implementations. Only Git binding, the remote service and native CLI are fixtures.
const cleanups: (() => Promise<void>)[] = [];
const diagnostics: (() => Promise<void>)[] = [];
afterEach(async ({ task }) => {
  const errors: unknown[] = [];
  if (task.result?.state === "fail") for (const diagnose of diagnostics) try { await diagnose(); } catch (error) { errors.push(error); }
  diagnostics.length = 0;
  for (const cleanup of cleanups.splice(0).reverse()) try { await cleanup(); } catch (error) { errors.push(error); }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (errors.length) throw new AggregateError(errors, "Web tool selection fixture cleanup remains unconfirmed.");
}, 180_000);

const stopped = async (controller: ProcessProof, native: readonly ProcessProof[], lease?: ControllerJobLease): Promise<void> => {
  await vi.waitFor(async () => expect(await confirmControllerProcessesStopped(controller, native, undefined, lease)).toBe(true), { timeout: 20_000, interval: 100 });
};

type NativeReceipt = { invocationId: string; tool: "A" | "B"; pid: number; execPath: string; argv: string[]; cwd: string };
type NativeRequest = { fixtureInvocationId: string; fixtureTool: "A" | "B"; fixturePid: number; method?: string; params?: Record<string, unknown> };
type ExpectedNativeInvocation = { tool: "A" | "B"; execPath: string; entryPath: string; cwd: string };

const assertNativeInvocation = (request: NativeRequest, receipts: readonly NativeReceipt[], expected: ExpectedNativeInvocation): void => {
  expect(request.fixtureInvocationId).toEqual(expect.any(String));
  expect(request.fixtureInvocationId).not.toBe("");
  expect(request.fixtureTool).toBe(expected.tool);
  const matches = receipts.filter(receipt => receipt.invocationId === request.fixtureInvocationId);
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({
    tool: expected.tool, pid: request.fixturePid, execPath: expected.execPath,
    argv: [expected.execPath, expected.entryPath, "app-server", "--stdio"], cwd: expected.cwd,
  });
};

const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/web-tool-selection");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")), state = path.join(home, "state"), repository = path.join(home, "repository");
  await mkdir(repository); vi.stubEnv("DN_CONFIG_DIR", state); vi.stubEnv("CODEX_HOME", path.join(home, "native"));
  const requestLog = path.join(home, "native-requests.jsonl"), receiptLog = path.join(home, "native-processes.jsonl"), controllerLog = path.join(home, "controllers.jsonl");
  vi.stubEnv("CODEX_TEST_REQUEST_LOG", requestLog); vi.stubEnv("EXPECT_WORKER_PERMISSIONS", "");
  const toolEntries = { A: path.join(home, "codex-A.mjs"), B: path.join(home, "codex-B.mjs") }, nativeIds = { A: randomUUID(), B: randomUUID() };
  const nativeSource = (await readFile(path.resolve(import.meta.dirname, "../controller/fixtures/codex-native.mjs"), "utf8"))
    .replace("from 'better-sqlite3'", `from ${JSON.stringify(import.meta.resolve("better-sqlite3"))}`);
  for (const tool of ["A", "B"] as const) {
    const header = `#!/usr/bin/env node
import { appendFileSync as recordTool } from 'node:fs';
import { randomUUID as fixtureRandomUUID } from 'node:crypto';
const fixtureInvocationId = fixtureRandomUUID();
recordTool(${JSON.stringify(receiptLog)}, JSON.stringify({invocationId:fixtureInvocationId,tool:${JSON.stringify(tool)},pid:process.pid,execPath:process.execPath,argv:process.argv,cwd:process.cwd()})+'\\n');
if (process.argv.includes('--version')) { console.log(${JSON.stringify(`codex-cli ${tool === "A" ? "1.10.1" : "1.20.2"}`)}); process.exit(0); }
if (process.argv.includes('--help')) { console.log('app-server --stdio'); process.exit(0); }
`;
    await writeFile(toolEntries[tool], header + nativeSource.replaceAll("native-thread", nativeIds[tool])
      .replace("JSON.stringify(m)+'\\n'", `JSON.stringify({...m,fixtureInvocationId,fixtureTool:${JSON.stringify(tool)},fixturePid:process.pid})+'\\n'`));
    await chmod(toolEntries[tool], 0o755);
    const bin = path.join(home, `path-${tool}`); await mkdir(bin);
    if (process.platform === "win32") await writeFile(path.join(bin, "codex.cmd"), `@echo off\r\n"${process.execPath}" "${toolEntries[tool]}" %*\r\n`);
    else await symlink(toolEntries[tool], path.join(bin, "codex"));
  }
  const dist = path.resolve(import.meta.dirname, "../../../dist"), packageDirectory = path.join(home, "package");
  await mkdir(path.join(packageDirectory, "dist"), { recursive: true });
  await writeFile(path.join(packageDirectory, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(packageDirectory, "dist/main.js"), `
import { appendFileSync } from 'node:fs';
import { runController } from ${JSON.stringify(pathToFileURL(path.join(dist, "commands/controller/runtime.js")).href)};
appendFileSync(${JSON.stringify(controllerLog)}, JSON.stringify({pid:process.pid,argv:process.argv})+'\\n');
await runController({homeDirectory:${JSON.stringify(home)},provider:process.argv[3],launchId:process.argv[5]});
`);
  const compiled = await import(pathToFileURL(path.join(dist, "commands/worker/tool-selection-runtime.js")).href) as typeof import("../../../src/commands/worker/tool-selection-runtime.js");
  const tools = compiled.createWorkerToolSelectionRuntime({ workerDirectory: path.join(state, "worker"), cwd: repository, environment: { ...process.env },
    localToolPaths: { codex: { kind: "path", path: toolEntries.A }, copilot: { kind: "path", path: path.join(home, "missing-copilot") }, herdr: { kind: "auto" } }, readActiveSelections: () => [] });
  const selectToolLaunch = vi.fn(tools.selectToolLaunch);
  const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(relay, "listening");
  const address = relay.address(); if (typeof address === "string" || address === null) throw new Error("Missing fixture relay address.");
  const origin = `http://127.0.0.1:${address.port}`, workerId = randomUUID(), userId = randomUUID(), projectId = randomUUID();
  const database = path.join(home, "worker.sqlite");
  let store = openWebExecutionStore(database);
  const bindings = new Map<string, WorktreeBinding>(), tasks = new Map<string, { tool: "A" | "B"; sessionId: string }>();
  const current = (identity: ClaimIdentity): LocalTask => store.getTask(identity)!;
  const snapshot = (task: LocalTask): Awaited<ReturnType<WorkerSessionApi["register"]>> => {
    const execution = task.webExecution!, remote = tasks.get(task.claimId)!;
    const value: Awaited<ReturnType<WorkerSessionApi["register"]>> = { ...snapshotFixture, protocol: SESSION_PROTOCOL, schemaVersion: 1, projectionVersion: 1, claimId: task.claimId, sessionId: remote.sessionId,
      executionGeneration: execution.executionGeneration, connectionEpoch: "1", historyEpoch: `fixture-${task.claimId}`, lastEventSeq: "0", lastTimelineSeq: "0",
      identity: { projectId: task.projectId, taskId: task.taskId, workerId, worktreeId: task.worktreeId, controllerId: execution.controllerId,
        controllerInstanceId: execution.controllerInstanceId, provider: "codex", agentControlMode: "web", nativeSessionId: nativeIds[remote.tool] },
      initialInputState: execution.initialInputState, lifecycle: "active", connectionState: "connected", synchronized: true, activity: "idle",
      operations: { canSend: execution.initialInputState === "confirmed", canCancel: false, canRespond: false } };
    parseSessionSnapshot(value); return value;
  };
  const register = vi.fn<WorkerSessionApi["register"]>(async task => {
    expect(task.configuration?.toolLaunch).toBeDefined();
    return snapshot(current(task));
  });
  const grant = vi.fn<WorkerSessionApi["grant"]>(async (task, execution, _signal, previous) => {
    if (previous !== undefined) {
      const saved = readControllerSnapshot(path.join(controllerExecutionDirectory(home, execution.executionId), "journal.sqlite"))!;
      expect(saved).toMatchObject({ claimId: task.claimId, executionGeneration: previous.generation, controllerInstanceId: previous.instanceId, nativeStopped: true, stoppedAt: previous.stoppedAt });
      if (process.platform === "win32") {
        const name = saved.controllerProcess!.jobObjectName!;
        const ticket = await readLaunchTicket(home, name.slice("Local\\Daynight-".length));
        expect(readProvenWindowsStoppedControllerGeneration(path.join(controllerExecutionDirectory(home, execution.executionId), "journal.sqlite"), ticket)).toEqual(saved);
      } else expect(await confirmControllerProcessesStopped(saved.controllerProcess!, saved.nativeProcesses)).toBe(true);
    }
    return { token: "controlled-web-grant", expiresAt: new Date(Date.now() + 900_000).toISOString(), claimId: task.claimId, sessionId: execution.sessionId!,
      executionGeneration: execution.executionGeneration, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId };
  });
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected remote service operation."); };
  const sessionApi: WorkerSessionApi = { register, grant, supportsStartupReports: unexpected, verifySupport: unexpected, verifyUnregistered: unexpected };
  const git = { prepareWorktree: vi.fn<WorkerGitManager["prepareWorktree"]>(async (project, task, operation, cwd, requireBranch, original) => {
    const binding = bindings.get(task.claimId); if (binding === undefined) throw new Error("Unknown fixture worktree binding.");
    operation.check();
    expect(project).toMatchObject({ projectId: task.projectId, localPath: repository });
    expect(cwd).toBe(binding.worktreePath); expect(requireBranch).toBe(true); expect(original).toEqual(binding);
    expect((await lstat(binding.worktreePath)).isDirectory()).toBe(true);
    return binding;
  }), prepareRepository: unexpected, findWorktree: unexpected, removeWorktree: unexpected, dispose: unexpected } as unknown as WorkerGitManager;
  const buildPrompt = vi.fn((task: LocalTask) => `original assignment ${tasks.get(task.claimId)!.tool}`);
  const leaseOwners: ReturnType<typeof createControllerJobLeases>[] = [];
  const observerJobs = new Map<string, ControllerJobLease>();
  const observerFor = (proof: ProcessProof) => proof.jobObjectName === undefined ? undefined : observerJobs.get(proof.jobObjectName);
  const stack = () => {
    const owned = createControllerJobLeases(); leaseOwners.push(owned);
    const jobLeases = { ...owned, retain: async (launchId: string, proof: ProcessProof, deadline: number) => {
      const lease = await owned.retain(launchId, proof, deadline);
      if (process.platform === "win32") {
        const name = `Local\\Daynight-${launchId}`;
        if (!observerJobs.has(name)) observerJobs.set(name, await acquireControllerJobLease(launchId, proof, deadline));
      }
      return lease;
    } };
    const launcher = createWebControllerLauncher({ homeDirectory: home, packageDirectory, store, sessionApi, jobLeases, now: Date.now, selectToolLaunch, toolObservationFor: tools.toolObservationFor });
    const backend = createWebExecutionBackend({ homeDirectory: home, store, git, launcher, jobLeases, platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux", buildPrompt, emit: () => {}, now: Date.now });
    return { launcher, backend };
  };
  let execution = stack();
  const relayErrors: unknown[] = [];
  relay.on("connection", (socket, request) => {
    if (request.url !== "/api/v1/controller-channel" || request.headers.authorization !== "Bearer controlled-web-grant") { socket.close(1008); return; }
    socket.on("message", raw => {
      try {
        const message = parseControllerMessage(JSON.parse(raw.toString()));
        const task = store.listUnfinishedTasks().find(task => task.claimId === message.claimId);
        if (task === undefined) throw new Error("Relay message has no original fixture claim.");
        const fence = { protocol: SESSION_PROTOCOL, claimId: task.claimId, sessionId: task.webExecution!.sessionId!, executionGeneration: task.webExecution!.executionGeneration, connectionEpoch: "1" };
        if (message.type === "hello") socket.send(JSON.stringify({ type: "welcome", protocol: SESSION_PROTOCOL, connectionEpoch: "1", session: snapshot(task), lastAckedSourceSeq: "0", limits: RELAY_LIMITS, requiresLiveSync: true }));
        else if (message.type === "reconcile") socket.send(JSON.stringify({ ...fence, type: "reconcile_result", operations: [] }));
        else if (message.type === "events") socket.send(JSON.stringify({ ...fence, type: "events_ack", sourceEpoch: message.sourceEpoch, batchId: message.batchId, lastAckedSourceSeq: message.events.at(-1)!.sourceSeq, lastEventSeq: message.events.at(-1)!.sourceSeq }));
        else if (message.type === "sync_state") socket.send(JSON.stringify({ ...fence, type: "sync_ack" }));
        else if (message.type === "operation_begin") socket.send(JSON.stringify({ ...fence, type: "operation_authorized", operationId: message.operationId }));
        else if (message.type === "operation_receipt") socket.send(JSON.stringify({ ...fence, type: "receipt_ack", operation: message.operation }));
      } catch (error) { relayErrors.push(error); socket.close(1008); }
    });
  });
  const journal = (identity: ClaimIdentity) => readControllerSnapshot(path.join(controllerExecutionDirectory(home, current(identity).webExecution!.executionId), "journal.sqlite"));
  const lines = async <T>(file: string): Promise<T[]> => existsSync(file) ? (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as T) : [];
  const receipts = () => lines<NativeReceipt>(receiptLog), requests = () => lines<NativeRequest>(requestLog);
  diagnostics.push(async () => {
    const records = store.listUnfinishedTasks();
    const generations = await Promise.all(records.map(async record => {
      const e = record.webExecution;
      const file = e === null ? null : path.join(controllerExecutionDirectory(home, e.executionId), "controller.log");
      return { claimId: record.claimId, execution: e, snapshot: e === null ? null : journal(record), log: file !== null && existsSync(file) ? (await readFile(file, "utf8")).slice(-32_768) : null };
    }));
    console.error(JSON.stringify({ fixture: "web-tool-selection", generations, nativeReceipts: await receipts(), nativeRequests: await requests(), relayErrors }));
  });
  const shutdown = async (identity: ClaimIdentity) => {
    let result: Awaited<ReturnType<typeof execution.backend.cleanup>>;
    try { result = await execution.backend.cleanup(current(identity), { kind: "shutdown", deadline: Date.now() + 20_000, signal: AbortSignal.timeout(60_000), immediateStop: true }); }
    catch (error) {
      if (process.platform === "win32") {
        try {
          const task = current(identity), original = task.webExecution!, file = path.join(controllerExecutionDirectory(home, original.executionId), "journal.sqlite"), proof = original.controllerProcess;
          const files = await Promise.all([file, `${file}-wal`, `${file}-shm`].map(async name => {
            try { const metadata = await lstat(name); return { name: path.basename(name), size: metadata.size, modifiedAt: metadata.mtime.toISOString() }; }
            catch (failure) { return { name: path.basename(name), error: String(failure) }; }
          }));
          const lease = proof === null ? undefined : observerFor(proof);
          const members = proof === null || lease === undefined ? null : await inspectControllerJobLease(lease, proof, false, Date.now() + 5000).catch(failure => String(failure));
          const processes = await Promise.all([...(proof === null ? [] : [proof]), ...original.nativeProcesses].map(async item => ({ pid: item.pid, state: await inspectProcessProof(item).catch(failure => String(failure)) })));
          console.error(JSON.stringify({ fixture: "web-tool-selection", stage: "stop-journal-failure", files, members, processes }));
        } catch (failure) { console.error(JSON.stringify({ fixture: "web-tool-selection", stage: "stop-journal-diagnostic-failure", error: String(failure) })); }
      }
      throw error;
    }
    expect(result.complete).toBe(true);
    const saved = journal(identity);
    if (saved?.controllerProcess) {
      if (process.platform === "win32") {
        const ticket = await readLaunchTicket(home, current(identity).webExecution!.launchId);
        expect(readProvenWindowsStoppedControllerGeneration(path.join(controllerExecutionDirectory(home, ticket.executionId), "journal.sqlite"), ticket)).toEqual(saved);
      } else await stopped(saved.controllerProcess, saved.nativeProcesses);
    }
    return result.task;
  };
  cleanups.push(async () => {
    let safe = true, cleanupFailure: unknown;
    try { for (const task of store.listUnfinishedTasks()) if (task.webExecution?.launchSubmission !== "not-submitted" && task.webExecution !== null) await shutdown(task); }
    catch (error) { safe = false; cleanupFailure = error; throw error; }
    finally {
      const failures: unknown[] = [];
      for (const owner of leaseOwners) try { await owner.close(); } catch (error) { failures.push(error); }
      for (const lease of observerJobs.values()) try { releaseControllerJobLease(lease); } catch (error) { failures.push(error); }
      observerJobs.clear();
      for (const socket of relay.clients) socket.terminate();
      try { await new Promise<void>((resolve, reject) => relay.close(error => error ? reject(error) : resolve())); } catch (error) { failures.push(error); }
      try { await tools.close(); } catch (error) { failures.push(error); }
      try { store.close(); } catch (error) { failures.push(error); }
      if (safe && failures.length === 0) {
        if (process.platform !== "win32") await rm(path.dirname(resolveControllerIpcEndpoint(home, "fixture")), { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
      }
      if (failures.length) throw new AggregateError(cleanupFailure === undefined ? failures : [cleanupFailure, ...failures], "Web fixture cleanup and handle release failed.", { cause: cleanupFailure });
    }
  });
  const addTask = async (tool: "A" | "B") => {
    const identity = { projectId, taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID() };
    const worktreePath = path.join(repository, ".worktrees", "daynight", identity.taskId);
    await mkdir(worktreePath, { recursive: true });
    const binding = { repositoryPath: repository, commonDirectory: path.join(repository, ".git"), worktreePath, branch: `daynight/${identity.taskId}` };
    bindings.set(identity.claimId, binding); tasks.set(identity.claimId, { tool, sessionId: randomUUID() });
    const project = { projectId, repoUrl: "https://example.test/fixture.git", localPath: repository };
    store.register({ ...identity, serverOrigin: origin, workerId, userId, project, configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 3 } }, Date.now());
    store.bindWorktree(identity, binding, Date.now());
    return identity;
  };
  const ready = async (identity: ClaimIdentity, signal: AbortSignal) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      await execution.backend.advance(current(identity), signal);
      const saved = journal(identity);
      if (saved?.lifecycle === "ready" && saved.initialInputState === "confirmed") {
        expect(saved.nativeSessionId).toBe(nativeIds[tasks.get(identity.claimId)!.tool]); return current(identity);
      }
      if (Date.now() >= deadline) throw new Error("Original Web generation did not become ready with its confirmed initial input.");
      await delay(100);
    }
  };
  return { home, tools, toolEntries, nativeIds, current, journal, addTask, ready, shutdown, observerFor, register, grant, selectToolLaunch, buildPrompt, requests, receipts, relayErrors,
    get backend() { return execution.backend; }, get store() { return store; },
    reopen: () => { store.close(); store = openWebExecutionStore(database); execution = stack(); },
  };
};

test("correlates native invocations when a PID is reused", () => {
  const execPath = "node", pid = 6044;
  const expectedA: ExpectedNativeInvocation = { tool: "A", execPath, entryPath: "codex-A.mjs", cwd: "worktree-A" };
  const expectedB: ExpectedNativeInvocation = { tool: "B", execPath, entryPath: "codex-B.mjs", cwd: "worktree-B" };
  const receiptB: NativeReceipt = { invocationId: "invocation-B", tool: "B", pid, execPath, argv: [execPath, expectedB.entryPath, "app-server", "--stdio"], cwd: expectedB.cwd };
  const receiptA: NativeReceipt = { invocationId: "invocation-A-resumed", tool: "A", pid, execPath, argv: [execPath, expectedA.entryPath, "app-server", "--stdio"], cwd: expectedA.cwd };
  const requestB: NativeRequest = { fixtureInvocationId: receiptB.invocationId, fixtureTool: "B", fixturePid: pid };
  const requestA: NativeRequest = { fixtureInvocationId: receiptA.invocationId, fixtureTool: "A", fixturePid: pid };
  const receipts = [receiptB, receiptA];
  assertNativeInvocation(requestB, receipts, expectedB);
  assertNativeInvocation(requestA, receipts, expectedA);

  const mismatches: NativeReceipt[] = [
    { ...receiptA, tool: "B" },
    { ...receiptA, argv: [execPath, expectedB.entryPath, "app-server", "--stdio"] },
    { ...receiptA, execPath: "other-node" },
    { ...receiptA, cwd: expectedB.cwd },
    { ...receiptA, pid: pid + 1 },
  ];
  for (const mismatch of mismatches) expect(() => assertNativeInvocation(requestA, [receiptB, mismatch], expectedA)).toThrow();
  expect(() => assertNativeInvocation({ ...requestA, fixtureTool: "B" }, receipts, expectedA)).toThrow();
  expect(() => assertNativeInvocation(requestA, [receiptB], expectedA)).toThrow();
  expect(() => assertNativeInvocation(requestA, [...receipts, receiptA], expectedA)).toThrow();
});

test("restores the original Web claim with A after target B and refuses missing A without replacing its native Session or replaying its prompt", async () => {
  const f = await fixture(), signal = AbortSignal.timeout(150_000);
  const identityA = await f.addTask("A"), original = await f.ready(identityA, signal), initial = original.webExecution!;
  const ticketA = await readLaunchTicket(f.home, initial.launchId), ticketBytes = await readFile(initial.ticketPath!, "utf8"), a = original.configuration!.toolLaunch!;
  expect(a.entryPath).toBe(f.toolEntries.A);
  expect(original.configuration!.toolObservation).toMatchObject({ version: "1.10.1" });
  expect(ticketA).toMatchObject({ claimId: identityA.claimId, taskId: identityA.taskId, worktreeId: identityA.worktreeId, initialPrompt: "original assignment A", configuration: original.configuration });
  expect((await f.requests()).filter(request => request.method === "turn/start")).toMatchObject([{ fixtureTool: "A", params: { input: [{ type: "text", text: "original assignment A" }] } }]);
  await f.shutdown(identityA);

  vi.stubEnv("PATH", path.join(f.home, "path-B") + path.delimiter + (process.env.PATH ?? ""));
  f.tools.setTargets({ source: "cloud", revision: "2", choices: { codex: { kind: "path", path: f.toolEntries.B }, copilot: { kind: "path", path: path.join(f.home, "missing-copilot") }, herdr: { kind: "auto" } } });
  const identityB = await f.addTask("B"), next = await f.ready(identityB, signal), b = next.configuration!.toolLaunch!;
  expect(b.entryPath).toBe(f.toolEntries.B); expect(b.selectionKey).not.toBe(a.selectionKey);
  expect(next.configuration!.toolObservation).toMatchObject({ version: "1.20.2" });
  expect((await readLaunchTicket(f.home, next.webExecution!.launchId)).configuration.toolLaunch).toEqual(b);
  expect((await f.requests()).filter(request => request.method === "thread/start").map(request => request.fixtureTool)).toEqual(["A", "B"]);
  await f.shutdown(identityB);

  f.reopen();
  expect(f.current(identityA)).toMatchObject({ ...identityA, configuration: original.configuration, cleanup: { kind: "shutdown" }, resources: { nativeSession: { sessionId: f.nativeIds.A } } });
  expect(f.tools.manager.currentSelection("codex", "web")!.selectionKey).toBe(b.selectionKey);
  f.store.clearShutdown(identityA, Date.now());
  const resumed = await f.ready(identityA, signal), resumedExecution = resumed.webExecution!;
  expect(resumed).toMatchObject({ ...identityA, configuration: original.configuration, resources: { nativeSession: original.resources.nativeSession }, recovery: { count: 0, pauseReason: null, retryAuthorized: false } });
  expect(resumedExecution).toMatchObject({ executionId: initial.executionId, sessionId: initial.sessionId, executionGeneration: "2", initialOperationId: initial.initialOperationId, initialPrompt: initial.initialPrompt, initialInputState: "confirmed" });
  const resumedTicket = await readLaunchTicket(f.home, resumedExecution.launchId);
  expect(resumedTicket).toMatchObject({ claimId: identityA.claimId, resumeNativeSessionId: f.nativeIds.A, configuration: ticketA.configuration, initialOperationId: ticketA.initialOperationId, initialPrompt: ticketA.initialPrompt });
  expect(f.grant.mock.calls.some(([task, , , previous]) => task.claimId === identityA.claimId && previous?.generation === "1" && previous.instanceId === initial.controllerInstanceId)).toBe(true);
  expect(await readFile(initial.ticketPath!, "utf8")).toBe(ticketBytes);
  expect((await f.requests()).filter(request => request.method === "thread/resume")).toMatchObject([{ fixtureTool: "A", params: { threadId: f.nativeIds.A } }]);
  const journalPath = path.join(controllerExecutionDirectory(f.home, initial.executionId), "journal.sqlite");
  expect(readControllerOperation(journalPath, initial.initialOperationId)).toMatchObject({ state: "confirmed", kind: "initial" });
  expect((await f.requests()).filter(request => request.method === "turn/start" && request.fixtureTool === "A")).toHaveLength(1);
  await f.shutdown(identityA);

  const beforeRemoval = await f.receipts();
  await rm(f.toolEntries.A);
  f.store.clearShutdown(identityA, Date.now());
  await f.backend.advance(f.current(identityA), signal).catch(() => {});
  await vi.waitFor(() => expect(f.journal(identityA)).toMatchObject({ error: expect.stringContaining("tool_identity_changed"), nativeProcesses: [] }), { timeout: 20_000, interval: 100 });
  const refused = f.journal(identityA)!; await stopped(refused.controllerProcess!, refused.nativeProcesses, f.observerFor(refused.controllerProcess!));
  expect(f.current(identityA)).toMatchObject({ ...identityA, configuration: original.configuration, resources: { nativeSession: { sessionId: f.nativeIds.A } }, webExecution: { executionId: initial.executionId, sessionId: initial.sessionId, executionGeneration: "3", initialOperationId: initial.initialOperationId, initialPrompt: initial.initialPrompt } });
  expect(await f.receipts()).toEqual(beforeRemoval);
  expect((await f.requests()).filter(request => request.method === "turn/start" && request.fixtureTool === "A")).toHaveLength(1);
  expect(f.register).toHaveBeenCalledTimes(2); expect(f.selectToolLaunch).toHaveBeenCalledTimes(2); expect(f.buildPrompt).toHaveBeenCalledTimes(2);
  const node = await realpath(process.execPath);
  for (const receipt of beforeRemoval) {
    expect(await realpath(receipt.execPath)).toBe(node);
    expect(receipt.argv.slice(0, 2)).toEqual([receipt.execPath, f.toolEntries[receipt.tool]]);
    if (!receipt.argv.includes("--version") && !receipt.argv.includes("--help")) expect(receipt.argv.slice(2)).toEqual(["app-server", "--stdio"]);
  }
  expect(new Set(beforeRemoval.map(receipt => receipt.invocationId)).size).toBe(beforeRemoval.length);
  for (const receipt of beforeRemoval) expect(receipt.invocationId).toEqual(expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
  const starts = (await f.requests()).filter(request => request.method === "thread/start" || request.method === "thread/resume");
  const expectedInvocations: ExpectedNativeInvocation[] = [
    { tool: "A", execPath: node, entryPath: f.toolEntries.A, cwd: original.resources.worktree!.worktreePath },
    { tool: "B", execPath: node, entryPath: f.toolEntries.B, cwd: next.resources.worktree!.worktreePath },
    { tool: "A", execPath: node, entryPath: f.toolEntries.A, cwd: original.resources.worktree!.worktreePath },
  ];
  expect(starts).toHaveLength(expectedInvocations.length);
  starts.forEach((request, index) => assertNativeInvocation(request, beforeRemoval, expectedInvocations[index]!));
  expect(f.relayErrors).toEqual([]);
}, 180_000);
