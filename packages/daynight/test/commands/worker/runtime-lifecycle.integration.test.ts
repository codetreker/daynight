import path from "node:path";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import type { WorkerLifecycleClient } from "../../../src/api/worker-lifecycle-client.js";
import type { WorkerReport } from "../../../src/api/types.js";
import type { Operation } from "../../../src/api/operation.js";
import { parseLifecycleObservationEnvelope, type LifecycleInstanceRequest, type LifecycleObservationEnvelope, type LifecycleResource } from "../../../src/api/worker-lifecycle.js";
import { runLifecycleManagementOnly, runManagedWorker } from "../../../src/commands/worker/runtime.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { acquireWorkerInstanceLock, tryAcquireWorkerInstanceLock } from "../../../src/commands/worker/instance-lock.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { openLifecycleStore } from "../../../src/commands/worker/lifecycle-store.js";
import { controllerExecutionDirectory, controllerPayloadHash, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore, recordStoppedControllerGeneration, readControllerOperation } from "../../../src/commands/controller/lifecycle-store.js";
import { resolveControllerStateDirectory } from "../../../src/commands/controller/paths.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import * as executionScope from "../../../src/commands/worker/execution-scope.js";

const mocks = vi.hoisted(() => ({
  remote: vi.fn(), client: vi.fn(), coordinator: vi.fn(), git: vi.fn(), bots: vi.fn(),
  probe: vi.fn(), tools: vi.fn(), spawn: vi.fn(), tick: vi.fn(), run: vi.fn(), business: vi.fn(),
}));
vi.mock("../../../src/commands/worker/remote.js", async (original: () => Promise<object>) => ({ ...await original(), createWorkerRemote: mocks.remote }));
vi.mock("../../../src/api/worker-lifecycle-client.js", () => ({ createWorkerLifecycleClient: mocks.client }));
vi.mock("../../../src/commands/worker/coordinator.js", () => ({ createWorkerCoordinator: mocks.coordinator }));
vi.mock("../../../src/commands/worker/worktrees.js", async (original: () => Promise<object>) => ({ ...await original(), createWorkerGitManager: mocks.git }));
vi.mock("../../../src/commands/worker/bots/host.js", () => ({ createWorkerBotHost: mocks.bots }));
vi.mock("../../../src/commands/worker/native-version.js", async (original: () => Promise<object>) => ({ ...await original(), probeNativeAgentVersion: mocks.probe }));
vi.mock("../../../src/commands/worker/tool-selection-runtime.js", () => ({ createWorkerToolSelectionRuntime: mocks.tools }));
vi.mock("node:child_process", async (original: () => Promise<object>) => ({ ...await original(), spawn: mocks.spawn }));

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverOrigin: "https://daynight.example", workerId: id(4), userId: id(6) };
const time = "2026-11-21T00:00:00.000Z";
const roots: string[] = [];
const cancellations: AbortController[] = [];
const executions: Promise<void>[] = [];
const forbidden = [mocks.probe, mocks.tools, mocks.spawn, mocks.tick, mocks.run, mocks.business];

const fixture = async (options: { identityMissing?: boolean; stopping?: boolean; credentialsMissing?: boolean } = {}) => {
  const parent = path.resolve(import.meta.dirname, "../../../../../.tmp/runtime-lifecycle-tests");
  await mkdir(parent, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(parent, "w-")); roots.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory);
  await mkdir(paths.workerDirectory, { recursive: true });
  if (process.platform !== "win32") await chmod(paths.workerDirectory, 0o700);
  const source = stringify({ serverUrl: identity.serverOrigin, ...(options.credentialsMissing ? {} : { serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890" }),
    ...(options.identityMissing ? {} : { workerId: identity.workerId }), worker: { repositories: [], maxConcurrent: 1 } });
  await writeFile(paths.configFile, source);
  const file = path.join(paths.workerDirectory, "lifecycle.sqlite");
  if (!options.identityMissing) {
    const worker = openWorkerStore(paths.databaseFile);
    try { worker.adoptLifecycle(identity); } finally { worker.close(); }
    const lifecycle = openLifecycleStore({ file, identity, allowCreate: true });
    try {
      lifecycle.bindInstance({ instanceId: id(7), intentVersion: "2", desired: "disabled" });
      lifecycle.closeAdmission({ operationId: id(20), local: true });
      if (!options.stopping) {
        const snapshot = lifecycle.snapshot();
        lifecycle.markStopped({ localEpoch: snapshot.state.localEpoch, inventoryRevision: snapshot.inventoryRevision, owners: [] });
      }
    } finally { lifecycle.close(); }
  }
  const state = () => {
    const lifecycle = openLifecycleStore({ file, identity, allowCreate: false });
    try { return lifecycle.readState(); } finally { lifecycle.close(); }
  };
  return { homeDirectory, workingDirectory: homeDirectory, packageDirectory: path.resolve("packages/daynight"), version: "0.41.0", paths, file, source, state };
};

const controlledCloud = () => {
  let cloud: LifecycleResource = { protocolVersion: 1, workerId: identity.workerId, intentVersion: "2", desired: "disabled",
    admission: "closed", operationId: id(21), instance: { instanceId: id(7) }, capability: "supported", observation: null, observedAt: time };
  const api: WorkerLifecycleClient = {
    read: vi.fn(async () => structuredClone(cloud)),
    register: vi.fn(async (request: LifecycleInstanceRequest) => {
      const receipt = { protocolVersion: 1 as const, workerId: identity.workerId, operationId: request.operationId,
        instanceId: request.instanceId, intentVersion: "2", desired: "disabled" as const,
        admission: "closed" as const, reconnectAllowed: false, observedAt: time };
      cloud = { ...cloud, instance: { instanceId: receipt.instanceId } };
      return receipt;
    }),
    report: vi.fn(async (envelope: LifecycleObservationEnvelope) => {
      parseLifecycleObservationEnvelope(envelope);
      expect(envelope.operationId).toBe(cloud.operationId);
      expect(envelope.instanceId).toBe(cloud.instance?.instanceId);
      expect(envelope.observation.phase).toBe("disabled");
      return { protocolVersion: 1 as const, accepted: true as const, instanceId: envelope.instanceId,
        intentVersion: envelope.intentVersion, reportSequence: envelope.reportSequence, receivedAt: time };
    }),
    intent: mocks.business, activate: mocks.business, operation: mocks.business, resolve: mocks.business,
  };
  const remote = { currentUserId: vi.fn(async () => identity.userId),
    report: vi.fn(async (_workerId: string, _report: WorkerReport, _operation: Operation) => ({ observedAt: time, lastReportedAt: time })),
    configuration: mocks.business, readTask: mocks.business, resolveProject: mocks.business, project: mocks.business };
  mocks.client.mockReturnValue(api); mocks.remote.mockReturnValue(remote);
  return { api, remote };
};
const start = (f: Awaited<ReturnType<typeof fixture>>) => {
  const cancellation = new AbortController(); cancellations.push(cancellation);
  const scope = vi.fn(), log = vi.fn<(message: string) => void>();
  const running = runManagedWorker({ ...f, signal: cancellation.signal, onExecutionScope: scope, log });
  executions.push(running); void running.catch(() => {});
  return { cancellation, scope, running, log };
};
const released = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const next = await tryAcquireWorkerInstanceLock(f.paths);
  try { expect(next).not.toBeNull(); } finally { await next?.release(); }
};
const manage = (f: Awaited<ReturnType<typeof fixture>>) => runLifecycleManagementOnly({ ...f, workerId: identity.workerId, operationId: id(20), kind: "disable" });

beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("DN_CONFIG_DIR", undefined);
  for (const mock of forbidden) mock.mockImplementation(() => { throw new Error("Disabled runtime attempted business execution."); });
  mocks.coordinator.mockReturnValue({ tick: mocks.tick, shutdown: vi.fn(async () => true), executionSnapshot: () => ({ recovery: [] }) });
  mocks.bots.mockReturnValue({ snapshot: () => ({ resources: [], recovery: [] }), run: mocks.run, shutdown: vi.fn(async () => {}), close: vi.fn(async () => {}) });
  mocks.git.mockReturnValue({ dispose: vi.fn(async () => {}), prepareRepository: mocks.business, listWorktrees: mocks.business });
});
afterEach(async () => {
  for (const cancellation of cancellations.splice(0)) cancellation.abort();
  await Promise.allSettled(executions.splice(0));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const mock of forbidden) expect(mock).not.toHaveBeenCalled();
});

it("waits for the Worker heartbeat receipt before registering lifecycle authority", async () => {
  const f = await fixture(), { api, remote } = controlledCloud();
  const receipt = Promise.withResolvers<{ observedAt: string; lastReportedAt: string }>();
  remote.report.mockImplementationOnce(() => receipt.promise);
  const execution = start(f);
  try {
    await vi.waitFor(() => expect(remote.report).toHaveBeenCalledOnce());
    expect(api.register).not.toHaveBeenCalled();
    expect(execution.scope).not.toHaveBeenCalled();
    for (const operation of forbidden) expect(operation).not.toHaveBeenCalled();
    receipt.resolve({ observedAt: time, lastReportedAt: time });
    await vi.waitFor(() => expect(api.report).toHaveBeenCalled());
    expect(api.register).toHaveBeenCalledOnce();
    expect(remote.report).toHaveBeenCalledOnce();
    expect(f.state()).toMatchObject({ admission: "closed", phase: "disabled" });
  } finally {
    receipt.resolve({ observedAt: time, lastReportedAt: time });
    execution.cancellation.abort();
    await expect(execution.running).rejects.toMatchObject({ name: "AbortError", cause: execution.cancellation.signal.reason });
  }
  await released(f);
});

describe("Worker lifecycle runtime assembly", () => {
  it("cold-starts a disabled Worker with a management heartbeat and no business scope", async () => {
    const f = await fixture(), cloud = controlledCloud(), runtime = start(f);
    try {
      await vi.waitFor(() => expect(cloud.api.report).toHaveBeenCalled());
      await vi.waitFor(() => expect(cloud.remote.report).toHaveBeenCalled());
      expect(cloud.remote.report.mock.calls[0]![0]).toBe(identity.workerId);
      expect(cloud.remote.report.mock.calls[0]![1]).toMatchObject({ taskInventory: null,
        versions: { daynight: f.version, codex: { code: "unavailable" }, copilot: { code: "unavailable" } } });
      expect(f.state()).toMatchObject({ admission: "closed", phase: "disabled", stop: "confirmed", save: "durable", inventoryComplete: true });
      expect(runtime.scope).not.toHaveBeenCalled();
      expect(runtime.log.mock.calls.filter(([message]: [string]) => /^Worker (lifecycle:|management heartbeat:)/.test(message))).toEqual([]);
      expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
      expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
    } finally { runtime.cancellation.abort(); await Promise.allSettled([runtime.running]); }
    await released(f);
  });

  it("leaves an occupied original instance lock with its owner", async () => {
    const f = await fixture(); controlledCloud();
    const owner = await acquireWorkerInstanceLock(f.paths);
    try {
      const original = await readFile(f.paths.lockFile, "utf8");
      await manage(f);
      expect(await readFile(f.paths.lockFile, "utf8")).toBe(original);
      expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
      expect(mocks.client).not.toHaveBeenCalled(); expect(mocks.remote).not.toHaveBeenCalled();
    } finally { await owner.release(); }
    await released(f);
  });

  it("rejects missing original identity without creating a replacement Worker", async () => {
    const f = await fixture({ identityMissing: true }); controlledCloud();
    await expect(manage(f)).rejects.toThrow("original Worker identity is missing");
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
    expect(existsSync(f.file)).toBe(false);
    expect(mocks.client).not.toHaveBeenCalled(); expect(mocks.remote).not.toHaveBeenCalled();
    await released(f);
  });

  it.each([false, true])("finishes local stop offline using original owners (credentials missing: %s)", async (credentialsMissing: boolean) => {
    const f = await fixture({ stopping: true, credentialsMissing }), cloud = controlledCloud();
    for (const method of Object.values(cloud.api)) vi.mocked(method).mockRejectedValue(new Error("Offline"));
    cloud.remote.currentUserId.mockRejectedValue(new Error("Offline"));
    await manage(f);
    expect(f.state()).toMatchObject({ admission: "closed", phase: "disabled", stop: "confirmed", save: "durable", inventoryComplete: true, localVeto: true });
    expect(mocks.coordinator.mock.results[0]!.value.shutdown).toHaveBeenCalledOnce();
    expect(mocks.bots.mock.results[0]!.value.shutdown).toHaveBeenCalledOnce();
    for (const method of Object.values(cloud.api)) expect(method).not.toHaveBeenCalled();
    expect(cloud.remote.currentUserId).not.toHaveBeenCalled(); expect(cloud.remote.report).not.toHaveBeenCalled();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
    await released(f);
  });

  it("releases the original lock when aborted during registration before any execution scope", async () => {
    const f = await fixture(), cloud = controlledCloud();
    vi.mocked(cloud.api.register).mockImplementation(async (_request: LifecycleInstanceRequest, signal?: AbortSignal) => {
      signal!.throwIfAborted();
      return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    });
    const runtime = start(f);
    await vi.waitFor(() => expect(cloud.api.register).toHaveBeenCalledOnce());
    expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
    runtime.cancellation.abort(); await Promise.allSettled([runtime.running]);
    expect(runtime.scope).not.toHaveBeenCalled();
    expect(f.state().admission).toBe("closed");
    await released(f);
  });

  it("retains the lock after owner close fails and reobserves that owner before constructing a replacement", async () => {
    const f = await fixture({ stopping: true }); controlledCloud();
    const original = mocks.bots(); mocks.bots.mockClear();
    const close = vi.fn(async () => {}).mockRejectedValueOnce(new Error("Original Bot close failed"));
    mocks.bots.mockReturnValue({ ...original, close });
    try {
      await expect(manage(f)).rejects.toThrow("Original Bot close failed");
      const lock = await readFile(f.paths.lockFile, "utf8");
      expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
      expect(mocks.bots).toHaveBeenCalledOnce();
      expect(f.state().admission).toBe("closed");
      close.mockImplementationOnce(async () => {
        expect(mocks.bots).toHaveBeenCalledOnce();
        expect(await readFile(f.paths.lockFile, "utf8")).toBe(lock);
      });
      await manage(f);
      expect(close).toHaveBeenCalledTimes(3);
      await released(f);
    } finally { close.mockResolvedValue(undefined); await manage(f); }
  });

  it.each(["management", "managed"] as const)("joins late original closure and releases its lock after %s exits without a scope", async (kind: "management" | "managed") => {
    const f = await fixture({ stopping: true }); controlledCloud();
    const original = mocks.bots(); mocks.bots.mockClear();
    const gate = Promise.withResolvers<void>();
    const close = vi.fn(async () => { await gate.promise; });
    mocks.bots.mockReturnValue({ ...original, close });
    const within = executionScope.withinExecutionDeadline;
    vi.spyOn(executionScope, "withinExecutionDeadline").mockImplementation(<T>(work: Promise<T>, deadline: number): Promise<T> => within(work, Math.min(deadline, Date.now() + 50)));
    const runtime = kind === "managed" ? start(f) : undefined;
    const running = runtime?.running ?? manage(f); void running.catch(() => {});
    try {
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      runtime?.cancellation.abort();
      await Promise.allSettled([running]);
      expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
      expect(mocks.bots).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
      expect(runtime?.scope.mock.calls ?? []).toHaveLength(0);
      gate.resolve();
      await vi.waitFor(() => expect(existsSync(f.paths.lockFile)).toBe(false));
      expect(close).toHaveBeenCalledOnce();
      await released(f);
    } finally { gate.resolve(); runtime?.cancellation.abort(); await Promise.allSettled([running]); await manage(f); }
  });
});


it.skipIf(process.platform === "win32").each(["previous", "adopted", "retry"] as const)("management disable settles a recovered prepared input using the original stopped Controller (%s)", async scenario => {
  const f = await fixture({ stopping: true }); controlledCloud();
  const store = openLifecycleStore({ file: f.file, identity, allowCreate: false });
  try {
    const state = store.readState();
    const binding = { ...identity, instanceId: state.instanceId!, intentVersion: state.intentVersion!, localEpoch: state.localEpoch, scopeGeneration: state.scopeGeneration };
    const first: ControllerLaunchTicket = { schemaVersion: 2, lifecycleBinding: binding, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(),
      controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", ...identity, projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID(),
      provider: "codex", cwd: f.homeDirectory, nativeHome: path.join(f.homeDirectory, "native"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 },
      initialOperationId: randomUUID(), initialPrompt: "frozen original", resumeNativeSessionId: null, credentialFile: path.join(f.homeDirectory, "grant.json"),
      ipcEndpoint: path.join(f.homeDirectory, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
    await writeLaunchTicket(f.homeDirectory, first);
    const file = path.join(controllerExecutionDirectory(f.homeDirectory, first.executionId), "journal.sqlite"); await mkdir(path.dirname(file), { recursive: true });
    const oldProof = { pid: 987651, parentPid: 1, processGroupId: 987651, startedAt: "original", commandHash: "a".repeat(64) }, nativeId = randomUUID();
    let journal = openControllerLifecycleStore(file, first, { controllerProcess: oldProof, onMigration: () => {} });
    journal.prepareOperation({ operationId: first.initialOperationId, kind: "initial", payload: { text: first.initialPrompt } });
    journal.patchSnapshot({ nativeSessionId: nativeId, lifecycle: "stopped", activity: "stopped", nativeStopped: true, stoppedAt: new Date().toISOString() }); journal.close();
    const current = { ...first, launchId: randomUUID(), controllerInstanceId: randomUUID(), executionGeneration: "2", resumeNativeSessionId: nativeId };
    await writeLaunchTicket(f.homeDirectory, current);
    const proof = { ...oldProof, pid: 987652, processGroupId: 987652, startedAt: "current" };
    journal = openControllerLifecycleStore(file, current, { controllerProcess: proof });
    journal.patchSnapshot({ lifecycle: "ready", activity: "idle", nativeSessionId: nativeId, startup: { state: "ready", reasonCode: "ready" },
      capabilities: { send: true, steer: false, cancel: false, respond: false } });
    journal.prepareRecoveredInitial(first);
    journal.patchSnapshot({ lifecycle: "stopped", activity: "stopped", nativeStopped: true, stoppedAt: new Date().toISOString() }); journal.close();
    vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
    await recordStoppedControllerGeneration(file, current, { deadline: Date.now() + 10_000 });
    const resourceIdentity = (ticket: ControllerLaunchTicket) => ({ executionId: ticket.executionId, sessionId: ticket.sessionId, executionGeneration: ticket.executionGeneration,
      controllerInstanceId: ticket.controllerInstanceId, controllerId: ticket.controllerId, launchId: ticket.launchId,
      storageStateDirectory: resolveControllerStateDirectory(f.homeDirectory), ticketHash: controllerPayloadHash(ticket), journalFile: file,
      projectId: ticket.projectId!, taskId: ticket.taskId!, claimId: ticket.claimId!, worktreeId: ticket.worktreeId! });
    for (const [ticket, process] of [[first, oldProof], [current, proof]] as const) {
      for (const [kind, resourceId] of [["launch", ticket.launchId], ["provider", ticket.controllerInstanceId]] as const) {
        store.importResource({ binding, resourceId, operationId: ticket.launchId, ownerKind: "controller", identity: { ...resourceIdentity(ticket), kind },
          stage: "running", processProof: process });
      }
    }
    const source = scenario === "adopted" ? current : first;
    store.importResource({ binding, resourceId: first.initialOperationId, operationId: first.initialOperationId, ownerKind: "controller", identity: { ...resourceIdentity(source), kind: "input", operationKind: "initial", nativeSessionId: nativeId }, stage: "reserved" });
    if (scenario === "retry") {
      vi.mocked(processProof.confirmControllerProcessesStopped).mockResolvedValueOnce(false);
      await expect(manage(f)).rejects.toThrow();
      expect(store.getResource(first.initialOperationId)?.stage).toBe("reserved");
    }
    await manage(f);
    expect(store.getResource(first.initialOperationId)).toMatchObject({ stage: "not_dispatched", saveState: "durable" });
    for (const id of [first.launchId, first.controllerInstanceId, current.launchId, current.controllerInstanceId]) expect(store.getResource(id)?.stage).toBe("stopped");
    expect(readControllerOperation(file, first.initialOperationId)).toMatchObject({ state: "accepted", executionGeneration: "2" });
    expect(f.state()).toMatchObject({ phase: "disabled", admission: "closed", inventoryComplete: true });
  } finally { store.close(); }
});
