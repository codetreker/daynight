import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { controllerExecutionDirectory, controllerPayloadHash, controllerTicketPath, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import { resolveControllerIpcEndpoint, resolveControllerStateDirectory } from "../../../src/commands/controller/paths.js";
import * as processProofs from "../../../src/commands/controller/process-proof.js";
import { settleControllerLaunch } from "../../../src/commands/controller/worker-lifecycle.js";
import { openControllerWorkerLifecycle } from "../../../src/commands/controller/worker-lifecycle.js";
import { createWebControllerLauncher } from "../../../src/commands/worker/backends/web-process.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import type { WorkerSessionApi } from "../../../src/commands/worker/backends/session-api.js";
import { withWorkerLifecycle } from "../../../src/commands/worker/lifecycle-context.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { createControllerJobLeases } from "../../../src/commands/worker/backends/controller-job-leases.js";
import { createRetiredClaimNativeCleanup, type LocatedClaimNative } from "../../../src/commands/worker/backends/retired-claim-native.js";
import { retiredClaimKey } from "../../../src/commands/worker/backends/retired-claim-tickets.js";
import type { CleanupTarget } from "../../../src/commands/worker/execution-stop.js";
import { hasLifecycleUnreleasedControllerGateProof } from "../../../src/commands/worker/lifecycle-controller-ticket.js";
import { openLifecycleStore, type LifecycleBinding, type LifecycleStore } from "../../../src/commands/worker/lifecycle-store.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";

const roots: string[] = [], stores: LifecycleStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/retired-claim-native");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "case-")); roots.push(home);
  vi.stubEnv("DN_CONFIG_DIR", path.join(home, "state"));
  const lifecycleFile = path.join(resolveWorkerPaths(home).workerDirectory, "lifecycle.sqlite");
  await mkdir(path.dirname(lifecycleFile), { recursive: true, mode: 0o700 });
  const identity = { serverOrigin: "https://daynight.example", workerId: randomUUID(), userId: randomUUID() };
  const target = { projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID() };
  const jobLeases = createControllerJobLeases();
  const ticket = (overrides: Partial<ControllerLaunchTicket> = {}, root?: string): ControllerLaunchTicket => {
    const launchId = randomUUID(), executionId = randomUUID();
    return { schemaVersion: 1, ...identity, ...target, launchId, executionId, controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(),
      executionGeneration: "1", provider: "codex", cwd: home, nativeHome: path.join(home, "native"),
      configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "managed",
      resumeNativeSessionId: null, credentialFile: path.join(controllerExecutionDirectory(home, executionId, root), "credential.json"),
      ipcEndpoint: resolveControllerIpcEndpoint(home, launchId, process.platform, root), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString(), ...overrides } as ControllerLaunchTicket;
  };
  const lifecycle = (active = false) => {
    const store = openLifecycleStore({ file: lifecycleFile, identity, allowCreate: true }); stores.push(store);
    const instanceId = randomUUID(), state = store.bindInstance({ instanceId, instanceEpoch: "1", intentVersion: "1", desired: active ? "enabled" : "disabled" });
    const binding: LifecycleBinding = { ...identity, instanceId, instanceEpoch: "1", intentVersion: "1", localEpoch: state.localEpoch, scopeGeneration: state.scopeGeneration };
    if (active) {
      store.markStopped({ localEpoch: binding.localEpoch, inventoryRevision: store.readState().inventoryRevision });
      const activation = { binding, operationId: randomUUID(), action: "bootstrap" as const };
      store.prepareActivation(activation);
      store.commitActivation({ ...activation, receipt: { protocolVersion: 1, action: "bootstrap", admission: "open", operationId: activation.operationId,
        workerId: binding.workerId, instanceEpoch: binding.instanceEpoch, localEpoch: binding.localEpoch, intentVersion: binding.intentVersion, scopeGeneration: binding.scopeGeneration } });
    }
    return { store, binding };
  };
  return { home, identity, target, ticket, jobLeases, lifecycle, adapter: () => createRetiredClaimNativeCleanup({ homeDirectory: home, identity, jobLeases }) };
};
const locate = async (adapter: ReturnType<typeof createRetiredClaimNativeCleanup>, targets: readonly CleanupTarget[]) => {
  const operation = createOperation();
  try { return await adapter.locate(targets, operation); } finally { operation.dispose(); }
};
const located = async (adapter: ReturnType<typeof createRetiredClaimNativeCleanup>, target: CleanupTarget): Promise<LocatedClaimNative> => {
  const entry = (await locate(adapter, [target])).get(retiredClaimKey(target))!;
  if ("error" in entry) throw entry.error;
  return entry.located;
};
const request = () => ({ deadline: Date.now() + 10_000, signal: new AbortController().signal });

it("certifies a complete empty inventory without inventing an execution or worktree owner", async () => {
  const f = await fixture(), adapter = f.adapter();
  expect(await adapter.stop(await located(adapter, f.target), request())).toMatchObject({ target: f.target, owners: [], stoppedExecutions: [], inventoryComplete: true, resourcesCleared: true });
});

it("retains every original generation and preserves ticket-only inventory as resource clearance", async () => {
  const f = await fixture(), first = f.ticket(), second = f.ticket({ executionId: first.executionId, sessionId: first.sessionId, executionGeneration: "2" });
  for (const ticket of [first, second]) await writeLaunchTicket(f.home, ticket);
  const adapter = f.adapter(), inventory = await located(adapter, f.target);
  expect(inventory.controllers.map(item => item.ticket.executionGeneration).sort()).toEqual(["1", "2"]);
  expect(await adapter.stop(inventory, request())).toMatchObject({ owners: [f.target], stoppedExecutions: [], resourcesCleared: true });
  for (const ticket of [first, second]) expect(JSON.parse(await readFile(controllerTicketPath(f.home, ticket.launchId), "utf8"))).toEqual(ticket);
});

it("clears the immutable attempts produced by an actual same-generation Web launch replacement", async () => {
  const f = await fixture(), { store, binding } = f.lifecycle(true), web = openWebExecutionStore(createMemoryDatabase());
  try {
    const configuration = { agent: "claude" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
    const project = { projectId: f.target.projectId, repoUrl: "https://example.test/repo.git", localPath: f.home };
    let task = web.register({ ...f.identity, ...f.target, project, configuration }, 1);
    task = web.bindWorktree(task, { repositoryPath: f.home, commonDirectory: path.join(f.home, ".git"), worktreePath: f.home, branch: "daynight/task" }, 2);
    task = web.initializeWebExecution(task, 3);
    const sessionId = randomUUID(), sessionApi = {
      register: vi.fn(async () => ({ sessionId })),
      grant: vi.fn<WorkerSessionApi["grant"]>(async (_task, execution) => ({ claimId: task.claimId, sessionId, executionGeneration: execution.executionGeneration,
        token: "fixture-grant", expiresAt: new Date(Date.now() + 60_000).toISOString(), controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId })),
    } as unknown as WorkerSessionApi;
    const launcher = createWebControllerLauncher({ homeDirectory: f.home, packageDirectory: f.home, store: web, sessionApi, now: Date.now });
    const context = { store, binding, failed: (error: unknown) => { throw error; } }, signal = new AbortController().signal;
    const original = await withWorkerLifecycle(context, () => launcher.prepare(task, "managed", signal));
    const lifecycle = openControllerWorkerLifecycle(f.home, original)!;
    try { lifecycle.reserveLaunch(); lifecycle.settleLaunch({ kind: "not_dispatched" }); } finally { lifecycle.close(); }
    const replacement = await withWorkerLifecycle(context, () => launcher.prepare(web.getTask(task)!, "managed", signal));
    expect(replacement.launchId).not.toBe(original.launchId);
    expect(replacement.executionGeneration).toBe(original.executionGeneration);
    const journalFile = path.join(controllerExecutionDirectory(f.home, replacement.executionId), "journal.sqlite");
    const journal = openControllerLifecycleStore(journalFile, replacement); journal.close();
    const adapter = createRetiredClaimNativeCleanup({ homeDirectory: f.home, identity: f.identity, lifecycle: store, jobLeases: f.jobLeases });
    const inventory = await located(adapter, f.target);
    expect(inventory.controllers.map(item => item.ticket.launchId).sort()).toEqual([original.launchId, replacement.launchId].sort());
    expect(await adapter.stop(inventory, request())).toMatchObject({ resourcesCleared: true, stoppedExecutions: [] });
    expect(store.getResource(original.launchId)?.stage).toBe("not_dispatched");
    for (const ticket of [original, replacement]) expect(JSON.parse(await readFile(controllerTicketPath(f.home, ticket.launchId), "utf8"))).toEqual(ticket);
  } finally { web.close(); }
});

it("accepts historical and unlaunched tickets around the actual current journal generation without rewriting it", async () => {
  const f = await fixture(), first = f.ticket(), current = f.ticket({ executionId: first.executionId, sessionId: first.sessionId, executionGeneration: "2" }), next = f.ticket({ executionId: first.executionId, sessionId: first.sessionId, executionGeneration: "3" });
  for (const ticket of [first, current, next]) await writeLaunchTicket(f.home, ticket);
  const journalFile = path.join(controllerExecutionDirectory(f.home, current.executionId), "journal.sqlite");
  await mkdir(path.dirname(journalFile), { recursive: true });
  const journal = openControllerLifecycleStore(journalFile, current); journal.close();
  const before = await readFile(journalFile), adapter = f.adapter();
  expect(await adapter.stop(await located(adapter, f.target), request())).toMatchObject({ resourcesCleared: true, stoppedExecutions: [] });
  expect(await readFile(journalFile)).toEqual(before);
});

it("isolates another Worker and conflicting generation from an independent claim in the same batch", async () => {
  const f = await fixture(), wrong = f.ticket({ workerId: randomUUID() }), other = { ...f.target, taskId: randomUUID(), claimId: randomUUID() };
  await writeLaunchTicket(f.home, wrong);
  const adapter = f.adapter(), result = await locate(adapter, [f.target, other]);
  expect(result.get(retiredClaimKey(f.target))).toHaveProperty("error");
  expect(result.get(retiredClaimKey(other))).toMatchObject({ located: { controllers: [] } });
  await rm(controllerTicketPath(f.home, wrong.launchId));
  const one = f.ticket(), conflict = f.ticket({ executionId: one.executionId, sessionId: one.sessionId });
  await writeLaunchTicket(f.home, one); await writeLaunchTicket(f.home, conflict);
  expect((await locate(adapter, [f.target])).get(retiredClaimKey(f.target))).toHaveProperty("error");
});

it.each(["serverOrigin", "userId", "worktreeId"] as const)("refuses a matching claim with a different %s", async field => {
  const f = await fixture(), ticket = f.ticket({ [field]: field === "serverOrigin" ? "https://another.example" : randomUUID() });
  await writeLaunchTicket(f.home, ticket);
  expect((await locate(f.adapter(), [f.target])).get(retiredClaimKey(f.target))).toHaveProperty("error");
});

it("refuses an actual journal generation absent from the ticket inventory", async () => {
  const f = await fixture(), historical = f.ticket(), current = f.ticket({ executionId: historical.executionId, sessionId: historical.sessionId, executionGeneration: "2" });
  await writeLaunchTicket(f.home, historical);
  const journalFile = path.join(controllerExecutionDirectory(f.home, current.executionId), "journal.sqlite");
  await mkdir(path.dirname(journalFile), { recursive: true });
  const journal = openControllerLifecycleStore(journalFile, current); journal.close();
  const adapter = f.adapter();
  await expect(adapter.stop(await located(adapter, f.target), request())).rejects.toThrow("no matching inventory ticket");
});

it("does not search a private Controller root without its original lifecycle binding", async () => {
  const f = await fixture(), privateRoot = path.join(f.home, "private-controller"), ticket = f.ticket({}, privateRoot);
  await writeLaunchTicket(f.home, ticket, privateRoot);
  expect((await located(f.adapter(), f.target)).controllers).toEqual([]);
});

it("uses an authenticated lifecycle location and preserves terminal evidence while retrying a failed receipt write", async () => {
  const f = await fixture(), { store, binding } = f.lifecycle(), privateRoot = path.join(f.home, "original-controller");
  const ticket = f.ticket({ schemaVersion: 2, lifecycleBinding: binding }, privateRoot);
  await writeLaunchTicket(f.home, ticket, privateRoot);
  const journalFile = path.join(controllerExecutionDirectory(f.home, ticket.executionId, privateRoot), "journal.sqlite");
  const identity = { ...f.target, kind: "launch", executionId: ticket.executionId, sessionId: ticket.sessionId, executionGeneration: ticket.executionGeneration,
    controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, launchId: ticket.launchId, storageStateDirectory: resolveControllerStateDirectory(f.home, privateRoot), ticketHash: controllerPayloadHash(ticket), journalFile };
  const proof = { pid: 987650, parentPid: 1, processGroupId: null, startedAt: "original-controller", commandHash: "a".repeat(64), jobObjectName: `Local\\Daynight-${ticket.launchId}` };
  store.importResource({ binding, resourceId: ticket.launchId, ownerKind: "controller", identity, operationId: ticket.launchId, stage: "running", processProof: proof });
  const inputId = randomUUID(), originalStopProof = { kind: "input_receipt", accepted: true };
  store.importResource({ binding, resourceId: inputId, ownerKind: "controller", identity: { ...identity, kind: "input" }, operationId: inputId, stage: "confirmed", stopProof: originalStopProof });
  const failure = new Error("durable receipt write failed"), recordResource = vi.fn(store.recordResource);
  recordResource.mockImplementationOnce(() => { throw failure; });
  vi.spyOn(processProofs, "stopControllerProcesses").mockResolvedValue();
  vi.spyOn(processProofs, "confirmControllerProcessesStopped").mockResolvedValue(true);
  const adapter = createRetiredClaimNativeCleanup({ homeDirectory: f.home, identity: f.identity, jobLeases: createControllerJobLeases("linux"), lifecycle: { listResources: store.listResources, recordResource } });
  const inventory = await located(adapter, f.target);
  expect(inventory.controllers).toHaveLength(1);
  await expect(adapter.stop(inventory, request())).rejects.toBe(failure);
  expect(store.getResource(ticket.launchId)?.stage).toBe("running");
  expect(await adapter.stop(inventory, request())).toMatchObject({ resourcesCleared: true, owners: [f.target], stoppedExecutions: [{ launchId: ticket.launchId }] });
  const stopped = store.getResource(ticket.launchId)!;
  expect(stopped).toMatchObject({ stage: "stopped", saveState: "durable", stopProof: { boundaryEmpty: true, controllerProcess: proof } });
  expect(store.getResource(inputId)?.stopProof).toEqual(originalStopProof);
  await adapter.stop(inventory, request());
  expect(store.getResource(ticket.launchId)).toEqual(stopped);
});

it.each(["reserved", "unknown"] as const)("retains an ambiguous %s launch whose process birth was never saved", async stage => {
  const f = await fixture(), { store, binding } = f.lifecycle(), ticket = f.ticket({ schemaVersion: 2, lifecycleBinding: binding });
  await writeLaunchTicket(f.home, ticket);
  store.importResource({ binding, resourceId: ticket.launchId, ownerKind: "controller", operationId: ticket.launchId, stage,
    identity: { ...f.target, kind: "launch", executionId: ticket.executionId, sessionId: ticket.sessionId, executionGeneration: ticket.executionGeneration,
      controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, launchId: ticket.launchId,
      storageStateDirectory: resolveControllerStateDirectory(f.home), ticketHash: controllerPayloadHash(ticket), journalFile: path.join(controllerExecutionDirectory(f.home, ticket.executionId), "journal.sqlite") } });
  const original = store.getResource(ticket.launchId), adapter = createRetiredClaimNativeCleanup({ homeDirectory: f.home, identity: f.identity, lifecycle: store, jobLeases: f.jobLeases });
  await expect(adapter.stop(await located(adapter, f.target), request())).rejects.toThrow("no Controller boundary proof");
  expect(store.getResource(ticket.launchId)).toEqual(original);
});

it("propagates unreadable canonical inventory and honors cancellation before issuing clearance", async () => {
  const f = await fixture(), ticket = f.ticket();
  await writeLaunchTicket(f.home, ticket);
  await writeFile(controllerTicketPath(f.home, ticket.launchId), "{broken", { mode: 0o600 });
  await expect(locate(f.adapter(), [f.target])).rejects.toThrow();
  await rm(controllerTicketPath(f.home, ticket.launchId));
  const adapter = f.adapter(), inventory = await located(adapter, f.target), abort = new AbortController(), reason = new Error("stop cancelled"); abort.abort(reason);
  await expect(adapter.stop(inventory, { deadline: Date.now() + 10_000, signal: abort.signal })).rejects.toBe(reason);
});

it("keeps independent live Provider responsibility despite a durable original boundary receipt", async () => {
  const f = await fixture(), { store, binding } = f.lifecycle(), ticket = f.ticket({ schemaVersion: 2, lifecycleBinding: binding });
  await writeLaunchTicket(f.home, ticket);
  const proof = { pid: 987651, parentPid: 1, processGroupId: null, startedAt: "original-controller", commandHash: "a".repeat(64), jobObjectName: `Local\\Daynight-${ticket.launchId}` };
  const provider = { ...proof, pid: 987652, parentPid: proof.pid, startedAt: "original-provider" };
  const identity = { ...f.target, executionId: ticket.executionId, sessionId: ticket.sessionId, executionGeneration: ticket.executionGeneration,
    controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, launchId: ticket.launchId,
    storageStateDirectory: resolveControllerStateDirectory(f.home), ticketHash: controllerPayloadHash(ticket), journalFile: path.join(controllerExecutionDirectory(f.home, ticket.executionId), "journal.sqlite") };
  store.importResource({ binding, resourceId: ticket.launchId, ownerKind: "controller", identity: { ...identity, kind: "launch" }, operationId: ticket.launchId,
    stage: "stopped", processProof: proof, stopProof: { kind: "retired_claim_controller_boundary", launchId: ticket.launchId, executionId: ticket.executionId,
      executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, ticketHash: controllerPayloadHash(ticket),
      controllerProcess: proof, nativeProcesses: [], boundaryEmpty: true, windowsJobStopped: true } });
  store.importResource({ binding, resourceId: ticket.controllerInstanceId, ownerKind: "controller", identity: { ...identity, kind: "provider" },
    operationId: ticket.launchId, stage: "running", processProof: provider });
  // Only process observation is controlled: the original durable receipt and
  // independently retained Provider responsibility use real lifecycle storage.
  const inspect = vi.spyOn(processProofs, "inspectBootstrapProcessProof").mockImplementation(async value => value.pid === proof.pid ? "stopped" : "running");
  const adapter = createRetiredClaimNativeCleanup({ homeDirectory: f.home, identity: f.identity, lifecycle: store, jobLeases: createControllerJobLeases("win32") });
  await expect(adapter.stop(await located(adapter, f.target), request())).rejects.toThrow("conflicts with its durable boundary stop receipt");
  expect(inspect.mock.calls.map(call => call[0].pid)).toEqual([proof.pid, provider.pid]);
  expect(store.getResource(ticket.controllerInstanceId)?.stage).toBe("running");
});

it("reuses the original unreleased-gate receipt without a journal or retained Windows Job", async () => {
  const f = await fixture(), { store, binding } = f.lifecycle(), ticket = f.ticket({ schemaVersion: 2, lifecycleBinding: binding });
  await writeLaunchTicket(f.home, ticket);
  const proof = { pid: 987653, parentPid: 1, processGroupId: null, startedAt: "original-gated-controller", commandHash: "a".repeat(64), jobObjectName: `Local\\Daynight-${ticket.launchId}` };
  store.importResource({ binding, resourceId: ticket.launchId, ownerKind: "controller", operationId: ticket.launchId, stage: "running", processProof: proof,
    identity: { ...f.target, kind: "launch", executionId: ticket.executionId, sessionId: ticket.sessionId, executionGeneration: ticket.executionGeneration,
      controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, launchId: ticket.launchId,
      storageStateDirectory: resolveControllerStateDirectory(f.home), ticketHash: controllerPayloadHash(ticket), journalFile: path.join(controllerExecutionDirectory(f.home, ticket.executionId), "journal.sqlite") } });
  settleControllerLaunch(f.home, ticket, { kind: "stopped", pid: proof.pid, proof });
  const original = store.getResource(ticket.launchId)!;
  expect(hasLifecycleUnreleasedControllerGateProof(ticket, original, proof)).toBe(true);
  for (const changed of [{ gateReleased: true }, { launchId: randomUUID() }, { binding: { ...binding, scopeGeneration: "2" } }, { originalProcessProof: { ...proof, pid: proof.pid + 1 } }])
    expect(hasLifecycleUnreleasedControllerGateProof(ticket, { ...original, stopProof: { ...(original.stopProof as object), ...changed } }, proof)).toBe(false);
  const inspect = vi.spyOn(processProofs, "inspectBootstrapProcessProof").mockResolvedValue("stopped");
  const leases = createControllerJobLeases("win32"), retain = vi.spyOn(leases, "retain");
  const adapter = createRetiredClaimNativeCleanup({ homeDirectory: f.home, identity: f.identity, lifecycle: store, jobLeases: leases });
  const inventory = await located(adapter, f.target);
  expect(await adapter.stop(inventory, request())).toMatchObject({ resourcesCleared: true, stoppedExecutions: [{ launchId: ticket.launchId }] });
  expect(inspect).toHaveBeenCalled(); expect(retain).not.toHaveBeenCalled();
  expect(store.getResource(ticket.launchId)).toEqual(original);
  await expect(readFile(path.join(controllerExecutionDirectory(f.home, ticket.executionId), "journal.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
});
