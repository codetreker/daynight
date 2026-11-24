import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { controllerExecutionDirectory, controllerPayloadHash, controllerTicketPath, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore, readProvenWindowsStoppedControllerGeneration, type ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import { openControllerWorkerLifecycle } from "../../../src/commands/controller/worker-lifecycle.js";
import { resolveControllerStateDirectory } from "../../../src/commands/controller/paths.js";
import { resolveBotPaths } from "../../../src/commands/worker/bots/paths.js";
import { readLifecycleControllerTicket } from "../../../src/commands/worker/lifecycle-controller-ticket.js";
import { openLifecycleStore, type LifecycleBinding, type LifecycleResource, type LifecycleStore } from "../../../src/commands/worker/lifecycle-store.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";

const roots: string[] = [], stores: LifecycleStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const fixture = async (privateBotRoot: boolean) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/lifecycle-controller-ticket");
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "owner-")); roots.push(home);
  vi.stubEnv("DN_CONFIG_DIR", path.join(home, "state"));
  const paths = resolveWorkerPaths(home);
  await mkdir(paths.workerDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(paths.workerDirectory, 0o700);
  const identity = { serverOrigin: "https://daynight.example", userId: randomUUID(), workerId: randomUUID() };
  const store = openLifecycleStore({ file: path.join(paths.workerDirectory, "lifecycle.sqlite"), identity, allowCreate: true }); stores.push(store);
  const binding: LifecycleBinding = { ...identity, instanceId: randomUUID(), localEpoch: "1", intentVersion: "1", scopeGeneration: "1" };
  store.bindInstance({ ...binding, desired: "enabled" });
  store.markStopped({ localEpoch: "1", inventoryRevision: store.readState().inventoryRevision, owners: [] });
  const activation = { binding, action: "bootstrap" as const, operationId: randomUUID() };
  store.prepareActivation(activation);
  store.commitActivation({ ...activation, receipt: { protocolVersion: 1, admission: "open", action: "bootstrap", operationId: activation.operationId,
    workerId: identity.workerId, instanceId: binding.instanceId, intentVersion: "1", localEpoch: "1", scopeGeneration: "1" } });
  const bot = resolveBotPaths(paths.stateDirectory, randomUUID()), storageRoot = privateBotRoot ? bot.controllerStateDirectory : undefined;
  const executionId = randomUUID(), launchId = randomUUID(), execution = controllerExecutionDirectory(home, executionId, storageRoot);
  const common = { schemaVersion: 2 as const, lifecycleBinding: binding, launchId, executionId, controllerId: randomUUID(), controllerInstanceId: randomUUID(),
    sessionId: randomUUID(), executionGeneration: "1", serverOrigin: identity.serverOrigin, provider: "codex" as const, cwd: home, nativeHome: path.join(home, "native"),
    configuration: { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 },
    initialOperationId: randomUUID(), resumeNativeSessionId: null, credentialFile: path.join(execution, "credential.json"), ipcEndpoint: path.join(home, "c.sock"),
    ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const ticket: ControllerLaunchTicket = privateBotRoot
    ? { ...common, testExecutionId: executionId, ownerUserId: identity.userId, initialInput: "none", initialPrompt: "",
      codexBotRecovery: { botId: path.basename(bot.directory), directory: bot.codexRecoveryDirectory } }
    : { ...common, userId: identity.userId, workerId: identity.workerId, projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID(), initialPrompt: "Original task" };
  await writeLaunchTicket(home, ticket, storageRoot);
  const proof = { pid: 987654, parentPid: 1, processGroupId: null, startedAt: "original", commandHash: "a".repeat(64), jobObjectName: `Local\\Daynight-${launchId}` };
  const lifecycle = openControllerWorkerLifecycle(home, ticket, storageRoot)!;
  try { lifecycle.reserveLaunch(); lifecycle.bindLaunch(proof); lifecycle.startProvider(proof); } finally { lifecycle.close(); }
  await mkdir(execution, { recursive: true });
  const journalFile = path.join(execution, "journal.sqlite"), journal = openControllerLifecycleStore(journalFile, ticket, { controllerProcess: proof, onMigration: () => {} });
  let snapshot: ControllerSnapshot;
  try { snapshot = { ...journal.getSnapshot(), lifecycle: "stopped", nativeStopped: true, stoppedAt: new Date().toISOString(), activity: "stopped" }; }
  finally { journal.close(); }
  // A supplied stopped Job receipt isolates path/identity validation from native
  // stopping. The production Windows reader still validates the real journal.
  snapshot.windowsJobStopProof = { version: 1, ticketHash: controllerPayloadHash(ticket), snapshotHash: controllerPayloadHash(snapshot) };
  const db = new Database(journalFile);
  try { db.prepare("UPDATE execution SET snapshot=?,owner_pid=NULL WHERE id=1").run(JSON.stringify(snapshot)); } finally { db.close(); }
  return { home, identity, store, ticket, journalFile, storageRoot, snapshot,
    resource: () => store.getResource(ticket.launchId)!, provider: () => store.getResource(ticket.controllerInstanceId)! };
};
const legacy = (resource: LifecycleResource): LifecycleResource => {
  const { storageStateDirectory: _root, ticketHash: _hash, controllerId: _controller, ...identity } = resource.identity;
  return { ...resource, identity };
};

it.each([false, true])("reads original launch and Provider tickets and Windows stop receipts (Bot private root: %s)", async (privateBotRoot: boolean) => {
  const f = await fixture(privateBotRoot);
  await writeFile(f.ticket.credentialFile, "rotated access credential", { mode: 0o600 });
  for (const resource of [f.resource(), f.provider()]) {
    expect(resource.identity).toMatchObject({ storageStateDirectory: resolveControllerStateDirectory(f.home, f.storageRoot), ticketHash: controllerPayloadHash(f.ticket) });
    for (const original of [resource, legacy(resource)]) {
      const ticket = await readLifecycleControllerTicket(f.home, f.identity, original);
      expect(ticket).toEqual(f.ticket);
      expect(readProvenWindowsStoppedControllerGeneration(f.journalFile, ticket)).toEqual(f.snapshot);
    }
  }
});

it("never replaces a missing Bot private ticket with a same-launch ticket from the default root", async () => {
  const f = await fixture(true);
  await writeLaunchTicket(f.home, f.ticket);
  await rm(controllerTicketPath(f.home, f.ticket.launchId, f.storageRoot));
  for (const resource of [f.resource(), legacy(f.resource())])
    await expect(readLifecycleControllerTicket(f.home, f.identity, resource)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.resource().stage).toBe("running");
});

it("rejects another owner, execution, instance, scope or frozen location without settling the original responsibility", async () => {
  const f = await fixture(true), resource = f.resource();
  await expect(readLifecycleControllerTicket(f.home, { ...f.identity, workerId: randomUUID() }, resource)).rejects.toThrow("identity is unavailable");
  for (const changed of [
    { ...resource, instanceId: randomUUID() }, { ...resource, scopeGeneration: "2" },
    { ...resource, identity: { ...resource.identity, storageStateDirectory: resolveControllerStateDirectory(f.home) } },
    { ...legacy(resource), identity: { ...legacy(resource).identity, executionId: randomUUID() } },
    { ...resource, identity: { ...resource.identity, ticketHash: "0".repeat(64) } },
    { ...resource, identity: { ...resource.identity, testExecutionId: randomUUID() } },
  ]) await expect(readLifecycleControllerTicket(f.home, f.identity, changed)).rejects.toThrow("identity is unavailable");
  expect(f.resource()).toEqual(resource);
});
