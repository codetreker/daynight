import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { frozenToolLaunch } from "../../helpers/tool-launch.js";
import { createWebControllerLauncher } from "../../../src/commands/worker/backends/web-process.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { createWebExecutionBackend, type WebBackendOptions } from "../../../src/commands/worker/backends/web.js";
import type { WorkerSessionApi } from "../../../src/commands/worker/backends/session-api.js";
import { ConfigurationAdmissionWaiting } from "../../../src/commands/worker/configuration-admission.js";
import { openLifecycleStore, type LifecycleBinding } from "../../../src/commands/worker/lifecycle-store.js";
import { withWorkerLifecycle } from "../../../src/commands/worker/lifecycle-context.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { openControllerWorkerLifecycle } from "../../../src/commands/controller/worker-lifecycle.js";
import { controllerExecutionDirectory, readLaunchTicket, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { prepareControllerIpcEndpoint } from "../../../src/commands/controller/paths.js";
import { readLaunchToolSelection, writeLaunchToolSelection } from "../../../src/commands/controller/launch-tool-selection.js";
import { openControllerLifecycleStore, readControllerSnapshot, recordStoppedControllerGeneration, type ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerJobLease } from "../../../src/commands/controller/windows-job.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), suspended: vi.fn(), capture: vi.fn(), reconcile: vi.fn() }));
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: native.spawn }));
vi.mock("../../../src/platform/windows-suspended-process.js", () => ({ createSuspendedProcess: native.suspended }));
vi.mock("../../../src/commands/controller/windows-job.js", async original => ({ ...await original<typeof import("../../../src/commands/controller/windows-job.js")>(),
  createControllerJobLease: vi.fn(async () => ({})), releaseControllerJobLease: vi.fn() }));
vi.mock("../../../src/commands/controller/process-proof.js", async original => ({ ...await original<typeof import("../../../src/commands/controller/process-proof.js")>(),
  captureProcessProof: native.capture, confirmControllerProcessesStopped: vi.fn(async () => true) }));
vi.mock("../../../src/commands/controller/launch-observation.js", async original => ({ ...await original<typeof import("../../../src/commands/controller/launch-observation.js")>(), reconcileSubmittedControllerLaunch: native.reconcile }));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup(); });

const fixture = () => {
  const root = path.resolve(import.meta.dirname, "../../../../../.tmp/task-launch-reservation");
  mkdirSync(root, { recursive: true });
  const home = mkdtempSync(path.join(root, "case-"));
  const worker = resolveWorkerPaths(home).workerDirectory;
  mkdirSync(worker, { recursive: true, mode: 0o700 });
  const identity = { serverOrigin: "https://daynight.example", userId: id(1), workerId: id(2) };
  const authority = openLifecycleStore({ file: path.join(worker, "lifecycle.sqlite"), identity, allowCreate: true });
  const file = path.join(home, "tasks.sqlite");
  let store = openWebExecutionStore(file, { onMigration: () => {} });
  cleanups.push(() => { store.close(); authority.close(); rmSync(home, { recursive: true, force: true }); });
  authority.bindInstance({ instanceId: id(80), instanceEpoch: "1", intentVersion: "1", desired: "enabled" });
  const activate = (action: "bootstrap" | "resume", scopeGeneration: string): LifecycleBinding => {
    const state = authority.readState();
    authority.markStopped({ localEpoch: state.localEpoch, inventoryRevision: state.inventoryRevision, owners: [] });
    const binding = { ...identity, instanceId: id(80), instanceEpoch: "1", intentVersion: "1", localEpoch: state.localEpoch, scopeGeneration };
    const activation = { binding, action, operationId: id(action === "bootstrap" ? 81 : 82) };
    authority.prepareActivation(activation);
    authority.commitActivation({ ...activation, receipt: { protocolVersion: 1, admission: "open", action, operationId: activation.operationId,
      workerId: identity.workerId, instanceEpoch: "1", intentVersion: "1", localEpoch: binding.localEpoch, scopeGeneration } });
    return binding;
  };
  let binding = activate("bootstrap", "1"), complete = true;
  const project = { projectId: id(3), repoUrl: "https://example.test/repo.git", localPath: home };
  const claim = { ...identity, project, projectId: project.projectId, taskId: id(4), claimId: id(5), worktreeId: id(6) };
  store.register({ ...claim, configuration: { agent: "codex", agentControlMode: "web", model: "frozen-model", args: [], recoveryLimit: 3, toolLaunch: frozenToolLaunch() } }, 1);
  store.bindWorktree(claim, { repositoryPath: home, commonDirectory: path.join(home, ".git"), worktreePath: home, branch: "daynight/task" }, 2);
  store.initializeWebExecution(claim, 3);
  store.updateWebExecution(claim, { nativeHome: path.join(home, "native") }, 4);
  const current = () => store.getTask(claim)!;
  const register = vi.fn(async () => ({ sessionId: id(7) }) as Awaited<ReturnType<WorkerSessionApi["register"]>>);
  const grant = vi.fn<WorkerSessionApi["grant"]>(async (task, execution) => ({ claimId: task.claimId, sessionId: id(7), executionGeneration: execution.executionGeneration,
    token: "fixture-grant", expiresAt: new Date(Date.now() + 60_000).toISOString(), controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId }));
  const sessionApi = { register, grant } as unknown as WorkerSessionApi;
  const leases = { enabled: false, retainBirthCleanup: () => () => {}, cleanupBirth: async () => {}, adopt: () => {},
    retain: async () => undefined, get: async () => undefined, release: async () => {}, close: async () => {} };
  const create = () => createWebControllerLauncher({ homeDirectory: home, packageDirectory: home, store, sessionApi, now: () => 1000, jobLeases: leases });
  let launcher = create();
  const proof = { pid: 987, parentPid: 1, processGroupId: 987, startedAt: "original", commandHash: "a".repeat(64) };
  const dispatch = vi.fn(), child = Object.assign(new EventEmitter(), { pid: proof.pid, connected: true, exitCode: null, signalCode: null,
    unref: vi.fn(), send: dispatch, resume: dispatch, close: vi.fn(), terminate: vi.fn(), hasExited: () => true });
  native.spawn.mockImplementation(() => { queueMicrotask(() => child.emit("spawn")); return child; });
  native.suspended.mockResolvedValue(child); native.capture.mockResolvedValue(proof);
  native.reconcile.mockImplementation(async ({ ticket }: { ticket: ControllerLaunchTicket }) => {
    const snapshot: ControllerSnapshot = { executionId: ticket.executionId, claimId: ticket.claimId!, sessionId: ticket.sessionId,
      executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: "ready", nativeSessionId: id(9),
      initialInputState: "not_submitted", activity: "idle", currentTurnId: null, capabilities: { send: true, steer: false, cancel: false, respond: true },
      controllerProcess: process.platform === "win32" ? { ...proof, jobObjectName: `Local\\Daynight-${ticket.launchId}` } : proof,
      nativeProcesses: [], nativeStopped: false, stoppedAt: null, error: null };
    return { kind: "observed", snapshot };
  });
  const signal = AbortSignal.timeout(10_000), prompt = vi.fn(() => "Frozen managed Task assignment.");
  const context = <T>(action: () => Promise<T>) => withWorkerLifecycle({ store: authority, binding, failed: error => { throw error; } }, action);
  const prepare = () => context(() => launcher.prepare(current(), prompt, signal, () => complete));
  const prepareLegacy = async () => {
    // A pre-existing ticket can omit the inline selection while the Task already
    // retains its frozen tool. Seed that historical format without rewriting it.
    const task = current(), execution = task.webExecution!;
    const registered = await sessionApi.register(task, execution, signal);
    const initialPrompt = prompt(), directory = controllerExecutionDirectory(home, execution.executionId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const { toolLaunch: selection, ...configuration } = task.configuration!;
    const ticket: ControllerLaunchTicket = { schemaVersion: 2, lifecycleBinding: binding,
      launchId: execution.launchId, executionId: execution.executionId, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId,
      sessionId: registered.sessionId, executionGeneration: execution.executionGeneration, serverOrigin: task.serverOrigin,
      projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId, userId: task.userId!,
      provider: "codex", cwd: home, nativeHome: execution.nativeHome!, configuration, initialOperationId: execution.initialOperationId, initialPrompt,
      resumeNativeSessionId: null, credentialFile: path.join(directory, "credential.json"), ipcEndpoint: await prepareControllerIpcEndpoint(home, execution.launchId),
      ipcSecret: "a".repeat(64), createdAt: new Date(1000).toISOString() };
    const ticketPath = await writeLaunchTicket(home, ticket);
    await writeLaunchToolSelection(home, ticket, selection!, () => authority.assertAdmission(binding));
    store.updateWebExecution(task, { sessionId: registered.sessionId, initialPrompt, ticketPath }, 1000);
    return ticket;
  };
  const launch = (ticket: ControllerLaunchTicket) => context(() => launcher.launch(current(), ticket, signal, () => complete));
  const run = async () => { const ticket = await prepare(); await launch(ticket); return ticket; };
  const restart = () => { store.close(); store = openWebExecutionStore(file, { onMigration: () => {} }); launcher = create(); };
  const resume = () => { authority.closeAdmission({ operationId: id(83), local: true }); binding = activate("resume", "2"); };
  const startupReport = () => createWebExecutionBackend({ homeDirectory: home, store, launcher, jobLeases: leases,
    git: new Proxy({} as WebBackendOptions["git"], { get: () => { throw new Error("Startup reporting must not invoke Git."); } }),
    platform: "linux", buildPrompt: prompt, emit: () => {}, now: () => 1000 }).observeStartupReport(current());
  return { home, authority, current, prepare, prepareLegacy, launch, run, restart, resume, register, grant, dispatch, prompt, startupReport, proof,
    store: () => store, binding: () => binding, setComplete: (value: boolean) => { complete = value; } };
};

test.each(["saved ticket before reservation", "same lifecycle configuration refusal", "resumed lifecycle configuration refusal", "legacy sidecar configuration refusal"] as const)(
  "launches the same frozen Task with a replacement reservation after %s", async mode => {
    const f = fixture();
    const original = await (mode === "legacy sidecar configuration refusal" ? f.prepareLegacy() : f.prepare());
    if (mode !== "saved ticket before reservation") {
      const open = fs.open;
      const refusal = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const file = await open(...args);
        if (String(args[0]).endsWith("controller.log")) f.setComplete(false);
        return file;
      });
      await expect(f.launch(original)).rejects.toBeInstanceOf(ConfigurationAdmissionWaiting);
      refusal.mockRestore();
      expect(f.authority.getResource(original.launchId)).toMatchObject({ stage: "not_dispatched", saveState: "durable", processProof: null, stopProof: null });
      expect(readControllerSnapshot(path.join(controllerExecutionDirectory(f.home, original.executionId), "journal.sqlite"))).toBeNull();
      expect(f.startupReport()).toMatchObject({ startup: { state: "unknown", reasonCode: "evidence_missing" } });
    } else expect(f.authority.getResource(original.launchId)).toBeNull();
    const task = f.current(), resource = f.authority.getResource(original.launchId);
    expect(task.webExecution).toMatchObject({ launchSubmission: "not-submitted", controllerProcess: null, nativeProcesses: [], executionGeneration: "1" });
    expect(native.spawn).not.toHaveBeenCalled(); expect(native.suspended).not.toHaveBeenCalled();
    f.restart();
    if (mode === "saved ticket before reservation" || mode === "resumed lifecycle configuration refusal") f.resume();
    f.setComplete(true);
    f.prompt.mockImplementation(() => { throw new Error("A saved assignment must not be regenerated."); });
    const replacement = await f.run();
    expect(replacement.launchId).not.toBe(original.launchId);
    expect(replacement).toEqual({ ...original, launchId: replacement.launchId, ipcEndpoint: replacement.ipcEndpoint,
      ipcSecret: replacement.ipcSecret, lifecycleBinding: f.binding() });
    expect(f.current()).toMatchObject({ claimId: task.claimId, taskId: task.taskId, configuration: task.configuration, resources: task.resources, recovery: task.recovery,
      webExecution: { ...task.webExecution!, launchId: replacement.launchId, ticketPath: f.current().webExecution!.ticketPath,
        launchSubmission: "acknowledged", controllerProcess: expect.any(Object), nativeProcesses: [] } });
    expect(await readLaunchTicket(f.home, original.launchId)).toEqual(original);
    expect(await readLaunchToolSelection(f.home, original)).toEqual(task.configuration!.toolLaunch);
    expect(await readLaunchToolSelection(f.home, replacement)).toEqual(task.configuration!.toolLaunch);
    expect(f.authority.getResource(original.launchId)).toEqual(resource);
    expect(f.authority.getResource(replacement.launchId)).toMatchObject({ stage: "running", scopeGeneration: f.binding().scopeGeneration });
    const stale = openControllerWorkerLifecycle(f.home, original)!;
    try { expect(() => stale.reserveLaunch()).toThrow(); } finally { stale.close(); }
    expect(f.register).toHaveBeenCalledOnce(); expect(f.prompt).toHaveBeenCalledOnce(); expect(f.dispatch).toHaveBeenCalledOnce();
  });

test("reuses a saved Task ticket with no reservation in the same lifecycle", async () => {
  const f = fixture(), original = await f.prepare();
  f.restart();
  expect(await f.run()).toEqual(original);
  expect(f.authority.listResources()).toHaveLength(1);
  expect(f.register).toHaveBeenCalledOnce(); expect(f.prompt).toHaveBeenCalledOnce(); expect(f.dispatch).toHaveBeenCalledOnce();
});

test.each(["reserved", "unknown", "pending save", "wrong ticket", "new local veto", "unknown controller start"] as const)(
  "refuses Task reservation replacement with %s evidence", async state => {
    const f = fixture(), original = await f.prepare();
    const reservationTicket = state === "wrong ticket" ? { ...original, ipcSecret: "b".repeat(64) } : original;
    const lifecycle = openControllerWorkerLifecycle(f.home, reservationTicket)!;
    try { lifecycle.reserveLaunch(); } finally { lifecycle.close(); }
    if (state !== "reserved") f.authority.recordResource({ resourceId: original.launchId,
      stage: state === "unknown" ? "unknown" : "not_dispatched", saveState: state === "pending save" ? "pending" : "durable" });
    if (state === "new local veto") f.authority.closeAdmission({ operationId: id(85), local: true });
    if (state === "unknown controller start") f.store().observeStartup(f.current(), { state: "unknown", reasonCode: "controller_start_unknown" }, 1000);
    const task = f.current(), resources = f.authority.listResources(), grants = f.grant.mock.calls.length;
    f.restart();
    await expect(f.run()).rejects.toThrow();
    expect(f.current()).toEqual(task);
    expect(await readLaunchTicket(f.home, original.launchId)).toEqual(original);
    expect(f.authority.listResources()).toEqual(resources);
    expect(f.grant).toHaveBeenCalledTimes(grants);
    expect(f.register).toHaveBeenCalledOnce(); expect(f.prompt).toHaveBeenCalledOnce();
    expect(native.spawn).not.toHaveBeenCalled(); expect(native.suspended).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
  });

test("replaces a refused Task recovery launch without consuming another generation or recovery attempt", async () => {
  const f = fixture(), initial = await f.prepare();
  const journalFile = path.join(controllerExecutionDirectory(f.home, initial.executionId), "journal.sqlite");
  const proof = process.platform === "win32" ? { ...f.proof, jobObjectName: `Local\\Daynight-${initial.launchId}` } : f.proof;
  // The stopped native owner is a controlled boundary input; its journal, Task
  // generation transition and subsequent launch reservations use real SQLite.
  const journal = openControllerLifecycleStore(journalFile, initial, { controllerProcess: proof });
  try { journal.patchSnapshot({ nativeSessionId: id(9), initialInputState: "confirmed", lifecycle: "ready", activity: "idle" }); }
  finally { journal.close(); }
  const previous = await recordStoppedControllerGeneration(journalFile, initial, process.platform === "win32" ? { jobLease: {} as ControllerJobLease } : {});
  f.store().updateWebExecution(f.current(), { launchSubmission: "acknowledged", controllerProcess: proof, initialInputState: "confirmed" }, 1000);
  f.store().bindNativeSession(f.current(), { source: "controller", sessionId: id(9) }, 1000);
  f.store().beginRecovery(f.current(), 1000);
  f.store().beginWebGeneration(f.current(), previous, 1000);
  const original = await f.prepare();
  const open = fs.open;
  const refusal = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await open(...args);
    if (String(args[0]).endsWith("controller.log")) f.setComplete(false);
    return file;
  });
  await expect(f.launch(original)).rejects.toBeInstanceOf(ConfigurationAdmissionWaiting);
  refusal.mockRestore();
  const resource = f.authority.getResource(original.launchId);
  expect(resource).toMatchObject({ stage: "not_dispatched", saveState: "durable", processProof: null });
  expect(f.startupReport()).toMatchObject({ executionGeneration: "2", startup: { state: "unknown", reasonCode: "evidence_missing" } });
  const task = f.current();
  expect(task.recovery).toMatchObject({ count: 1, retryAuthorized: false });
  f.restart(); f.setComplete(true);
  f.prompt.mockImplementation(() => { throw new Error("Recovery must retain its original assignment."); });
  const replacement = await f.run();
  expect(replacement.launchId).not.toBe(original.launchId);
  expect(replacement).toEqual({ ...original, launchId: replacement.launchId, ipcEndpoint: replacement.ipcEndpoint, ipcSecret: replacement.ipcSecret });
  expect(replacement).toMatchObject({ sessionId: initial.sessionId, executionGeneration: "2", resumeNativeSessionId: id(9), initialPrompt: initial.initialPrompt });
  expect(f.current()).toMatchObject({ configuration: task.configuration, resources: task.resources, recovery: task.recovery,
    webExecution: { ...task.webExecution!, launchId: replacement.launchId, ticketPath: f.current().webExecution!.ticketPath,
      launchSubmission: "acknowledged", controllerProcess: expect.any(Object), nativeProcesses: [] } });
  expect(readControllerSnapshot(journalFile)).toEqual(previous);
  expect(await readLaunchTicket(f.home, original.launchId)).toEqual(original);
  expect(f.authority.getResource(original.launchId)).toEqual(resource);
  expect(f.authority.getResource(replacement.launchId)).toMatchObject({ stage: "running" });
  expect(f.grant.mock.calls.some(([, execution, , predecessor]) => execution.launchId === original.launchId
    && predecessor?.generation === "1" && predecessor.instanceId === initial.controllerInstanceId && predecessor.stoppedAt === previous.stoppedAt)).toBe(true);
  expect(f.register).toHaveBeenCalledOnce(); expect(f.prompt).toHaveBeenCalledOnce(); expect(f.dispatch).toHaveBeenCalledOnce();
});
