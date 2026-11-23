import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { controllerExecutionDirectory, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore, readControllerOperation, recordStoppedControllerGeneration } from "../../../src/commands/controller/lifecycle-store.js";
import { openControllerWorkerLifecycle } from "../../../src/commands/controller/worker-lifecycle.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import { openLifecycleStore, type LifecycleBinding, type LifecycleStore } from "../../../src/commands/worker/lifecycle-store.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { reconcilePreparedInitialReservation } from "../../../src/commands/worker/lifecycle-input-recovery.js";

const roots: string[] = [], stores: LifecycleStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const fixture = async (adoptReservation: boolean) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/lifecycle-input-recovery");
  await mkdir(base, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(base, "h-")); roots.push(homeDirectory);
  vi.stubEnv("DN_CONFIG_DIR", path.join(homeDirectory, "state"));
  const paths = resolveWorkerPaths(homeDirectory); await mkdir(paths.workerDirectory, { recursive: true, mode: 0o700 });
  const identity = { serverOrigin: "https://daynight.example", userId: randomUUID(), workerId: randomUUID() };
  const lifecycle = openLifecycleStore({ file: path.join(paths.workerDirectory, "lifecycle.sqlite"), identity, allowCreate: true }); stores.push(lifecycle);
  const binding: LifecycleBinding = { ...identity, instanceId: randomUUID(), instanceEpoch: "1", intentVersion: "1", localEpoch: "1", scopeGeneration: "1" };
  lifecycle.bindInstance({ ...binding, desired: "enabled" });
  lifecycle.markStopped({ localEpoch: "1", inventoryRevision: lifecycle.readState().inventoryRevision });
  const activation = { binding, operationId: randomUUID(), action: "bootstrap" as const };
  lifecycle.prepareActivation(activation);
  lifecycle.commitActivation({ ...activation, receipt: { protocolVersion: 1, admission: "open", action: "bootstrap", workerId: identity.workerId,
    operationId: activation.operationId, instanceEpoch: "1", intentVersion: "1", localEpoch: "1", scopeGeneration: "1" } });
  const first: ControllerLaunchTicket = { schemaVersion: 2, lifecycleBinding: binding, launchId: randomUUID(), executionId: randomUUID(),
    controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", ...identity,
    projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID(), provider: "codex", cwd: homeDirectory,
    nativeHome: path.join(homeDirectory, "native"), configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 },
    initialOperationId: randomUUID(), initialPrompt: "frozen original", resumeNativeSessionId: null, credentialFile: path.join(homeDirectory, "grant.json"),
    ipcEndpoint: path.join(homeDirectory, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  await writeLaunchTicket(homeDirectory, first);
  const file = path.join(controllerExecutionDirectory(homeDirectory, first.executionId), "journal.sqlite"); await mkdir(path.dirname(file), { recursive: true });
  const firstProof = { pid: 987651, parentPid: 1, processGroupId: 987651, startedAt: "original", commandHash: "a".repeat(64) };
  const nativeId = randomUUID();
  let journal = openControllerLifecycleStore(file, first, { controllerProcess: firstProof, onMigration: () => {} });
  const operation = journal.prepareOperation({ operationId: first.initialOperationId, kind: "initial", payload: { text: first.initialPrompt } });
  const firstOwner = openControllerWorkerLifecycle(homeDirectory, first)!;
  try { firstOwner.reserve(operation, nativeId); } finally { firstOwner.close(); }
  journal.patchSnapshot({ nativeSessionId: nativeId, lifecycle: "stopped", activity: "stopped", nativeStopped: true, stoppedAt: new Date().toISOString() });
  journal.close();
  const ticket = { ...first, launchId: randomUUID(), controllerInstanceId: randomUUID(), executionGeneration: "2", resumeNativeSessionId: nativeId };
  await writeLaunchTicket(homeDirectory, ticket);
  const currentProof = { ...firstProof, pid: 987652, processGroupId: 987652, startedAt: "recovered" };
  journal = openControllerLifecycleStore(file, ticket, { controllerProcess: currentProof });
  journal.patchSnapshot({ lifecycle: "ready", activity: "idle", nativeSessionId: nativeId, nativeStopped: false, stoppedAt: null,
    startup: { state: "ready", reasonCode: "ready" }, capabilities: { send: true, steer: false, cancel: false, respond: false } });
  const currentOperation = journal.prepareRecoveredInitial(first);
  const currentOwner = openControllerWorkerLifecycle(homeDirectory, ticket)!;
  try {
    currentOwner.reserveLaunch(); currentOwner.bindLaunch(currentProof);
    if (adoptReservation) currentOwner.reserve(currentOperation, nativeId, { resource: lifecycle.getResource(first.initialOperationId)!, ticket: first });
  } finally { currentOwner.close(); }
  journal.patchSnapshot({ lifecycle: "stopped", activity: "stopped", nativeStopped: true, stoppedAt: new Date().toISOString() });
  journal.close();
  vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  await recordStoppedControllerGeneration(file, ticket, { deadline: Date.now() + 10_000 });
  vi.mocked(processProof.confirmControllerProcessesStopped).mockClear();
  lifecycle.closeAdmission({ operationId: randomUUID(), local: true });
  return { homeDirectory, identity, lifecycle, ticket, file, resource: lifecycle.getResource(first.initialOperationId)! };
};

it.skipIf(process.platform === "win32").each([false, true])("settles a stopped prepared initial reservation without dispatch (reservation adopted=%s)", async adopted => {
  const f = await fixture(adopted);
  const stop = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  await reconcilePreparedInitialReservation({ ...f, deadline: Date.now() + 10_000 });
  expect(stop).toHaveBeenCalled();
  expect(f.lifecycle.getResource(f.ticket.initialOperationId)).toMatchObject({ stage: "not_dispatched", saveState: "durable" });
  expect(readControllerOperation(f.file, f.ticket.initialOperationId)).toMatchObject({ state: "accepted", executionGeneration: "2", payload: { text: f.ticket.initialPrompt } });
});

it.skipIf(process.platform === "win32").each(["unproven-stop", "wrong-owner", "wrong-reservation"] as const)("retains the input reservation when %s evidence is unavailable", async conflict => {
  const f = await fixture(false), before = f.lifecycle.getResource(f.ticket.initialOperationId);
  vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(conflict !== "unproven-stop");
  const identity = conflict === "wrong-owner" ? { ...f.identity, workerId: randomUUID() } : f.identity;
  const resource = conflict === "wrong-reservation" ? { ...f.resource, identity: { ...f.resource.identity, claimId: randomUUID() } } : f.resource;
  await reconcilePreparedInitialReservation({ ...f, identity, resource, deadline: Date.now() + 10_000 }).catch(() => undefined);
  expect(f.lifecycle.getResource(f.ticket.initialOperationId)).toEqual(before);
  expect(readControllerOperation(f.file, f.ticket.initialOperationId)).toMatchObject({ state: "accepted", executionGeneration: "2" });
});


it.skipIf(process.platform === "win32").each(["dispatching", "unknown", "confirmed"] as const)("retains a reservation when the durable operation is %s", async state => {
  const f = await fixture(false), before = f.lifecycle.getResource(f.ticket.initialOperationId);
  vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  const db = new Database(f.file);
  try {
    const row = db.prepare("SELECT value FROM operations WHERE id=?").get(f.ticket.initialOperationId) as { value: string };
    db.prepare("UPDATE operations SET value=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(row.value), state }), f.ticket.initialOperationId);
  } finally { db.close(); }
  await reconcilePreparedInitialReservation({ ...f, deadline: Date.now() + 10_000 }).catch(() => undefined);
  expect(f.lifecycle.getResource(f.ticket.initialOperationId)).toEqual(before);
  expect(readControllerOperation(f.file, f.ticket.initialOperationId)?.state).toBe(state);
});
