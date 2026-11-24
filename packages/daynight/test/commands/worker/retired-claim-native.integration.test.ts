import { createHash, randomUUID } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import Database from "better-sqlite3";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { controllerExecutionDirectory, controllerPayloadHash, controllerTicketPath, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import { resolveControllerIpcEndpoint, resolveControllerStateDirectory } from "../../../src/commands/controller/paths.js";
import type { ControllerJobLease } from "../../../src/commands/controller/windows-job.js";
import * as processProofs from "../../../src/commands/controller/process-proof.js";
import { createControllerJobLeases } from "../../../src/commands/worker/backends/controller-job-leases.js";
import { createRetiredClaimNativeCleanup, type LocatedClaimNative } from "../../../src/commands/worker/backends/retired-claim-native.js";
import { retiredClaimKey } from "../../../src/commands/worker/backends/retired-claim-tickets.js";
import type { CleanupTarget } from "../../../src/commands/worker/execution-stop.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";

import { hasLegacyUnreleasedControllerGateProof, readLegacyWorkerResources, type LegacyWorkerResource } from "../../../src/commands/worker/backends/legacy-retired-evidence.js";

const roots: string[] = [], stores: Database.Database[] = [];
const encode = (value: unknown) => JSON.stringify(value, (_key, item: unknown) =>
  item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
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
  const lifecycle = (version: 1 | 2 = 1) => {
    const db = new Database(lifecycleFile); stores.push(db);
    db.pragma("journal_mode = WAL"); db.pragma("wal_autocheckpoint = 0");
    db.exec(`
      PRAGMA user_version=${version};
      CREATE TABLE lifecycle_state(singleton INTEGER, server_origin TEXT, user_id TEXT, worker_id TEXT, format_version INTEGER);
      CREATE TABLE resource_owners(resource_id TEXT PRIMARY KEY, owner_kind TEXT, identity_json TEXT, instance_id TEXT, ${version === 1 ? "instance_epoch INTEGER," : ""}
        scope_generation INTEGER, admission_operation_id TEXT, stage TEXT, process_proof_json TEXT, stop_proof_json TEXT, save_state TEXT, last_error TEXT);
      CREATE TABLE resource_history(resource_id TEXT PRIMARY KEY, content_hash TEXT, payload BLOB);
    `);
    db.prepare("INSERT INTO lifecycle_state VALUES(1, ?, ?, ?, 1)").run(identity.serverOrigin, identity.userId, identity.workerId);
    const binding = { ...identity, instanceId: randomUUID(), instanceEpoch: "1", intentVersion: "1", localEpoch: "1", scopeGeneration: "1" };
    const register = (input: Pick<LegacyWorkerResource, "resourceId" | "ownerKind" | "identity" | "operationId" | "stage">
      & { processProof?: unknown; stopProof?: unknown }, history = false) => {
      const row = { ...input, instanceId: binding.instanceId, ...(version === 1 ? { instanceEpoch: binding.instanceEpoch } : {}), scopeGeneration: binding.scopeGeneration,
        processProof: input.processProof ?? null, stopProof: input.stopProof ?? null, saveState: input.stage === "reserved" ? "pending" : "durable", error: null };
      if (history) {
        const source = encode(row);
        db.prepare("INSERT INTO resource_history VALUES(?, ?, ?)").run(row.resourceId, createHash("sha256").update(source).digest("hex"), deflateRawSync(source));
      } else {
        db.prepare(`INSERT INTO resource_owners VALUES(?, ?, ?, ?, ${version === 1 ? "?," : ""} ?, ?, ?, ?, ?, ?, ?)`).run(row.resourceId, row.ownerKind, encode(row.identity),
          row.instanceId, ...(version === 1 ? [row.instanceEpoch!] : []), row.scopeGeneration, row.operationId, row.stage, row.processProof === null ? null : encode(row.processProof),
          row.stopProof === null ? null : encode(row.stopProof), row.saveState, row.error);
      }
    };
    const getResource = (id: string) => readLegacyWorkerResources(home, identity, "controller").find(resource => resource.resourceId === id);
    return { store: { register, getResource }, binding, db };
  };
  return { home, identity, target, ticket, jobLeases, lifecycle, lifecycleFile, adapter: () => createRetiredClaimNativeCleanup({ homeDirectory: home, identity, jobLeases }) };
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
const mockedJournalLeases = () => {
  const leases = createControllerJobLeases();
  if (leases.enabled) vi.spyOn(leases, "retain").mockResolvedValue({} as ControllerJobLease);
  return leases;
};
const journalProcessFixture = async (platform: "posix" | "windows", change: Partial<processProofs.ProcessProof>) => {
  const f = await fixture(), { store, binding } = f.lifecycle(), ticket = f.ticket({ schemaVersion: 2, lifecycleBinding: binding });
  await writeLaunchTicket(f.home, ticket);
  const journalFile = path.join(controllerExecutionDirectory(f.home, ticket.executionId), "journal.sqlite");
  await mkdir(path.dirname(journalFile), { recursive: true });
  const launchProof: processProofs.ProcessProof = { pid: 987654, parentPid: 987653, processGroupId: platform === "posix" ? 987654 : null,
    startedAt: "original-controller", commandHash: "a".repeat(64), ...(platform === "windows" ? { jobObjectName: `Local\\Daynight-${ticket.launchId}` } : {}) };
  const journalProof = { ...launchProof, ...change };
  const journal = openControllerLifecycleStore(journalFile, ticket);
  journal.patchSnapshot({ controllerProcess: journalProof }); journal.close();
  store.register({ resourceId: ticket.launchId, ownerKind: "controller", operationId: ticket.launchId, stage: "running", processProof: launchProof,
    identity: { ...f.target, kind: "launch", executionId: ticket.executionId, sessionId: ticket.sessionId, executionGeneration: ticket.executionGeneration,
      controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, launchId: ticket.launchId,
      storageStateDirectory: resolveControllerStateDirectory(f.home), ticketHash: controllerPayloadHash(ticket), journalFile } });
  const adapter = createRetiredClaimNativeCleanup({ homeDirectory: f.home, identity: f.identity, jobLeases: createControllerJobLeases("linux") });
  return { ...f, store, ticket, launchProof, journalProof, adapter };
};

it.skipIf(process.platform === "win32")("stops the original detached POSIX Controller after its journal self-capture observes a new parent", async () => {
  const f = await journalProcessFixture("posix", { parentPid: 1 });
  const stop = vi.spyOn(processProofs, "stopControllerProcesses").mockResolvedValue();
  vi.spyOn(processProofs, "confirmControllerProcessesStopped").mockResolvedValue(true);
  expect(await f.adapter.stop(await located(f.adapter, f.target), request())).toMatchObject({ resourcesCleared: true, stoppedExecutions: [{ launchId: f.ticket.launchId }] });
  expect(stop).toHaveBeenCalledExactlyOnceWith(f.journalProof, [], expect.any(Number), undefined);
  expect(f.store.getResource(f.ticket.launchId)).toMatchObject({ stage: "running", processProof: f.launchProof, stopProof: null });
});

it.each([
  { field: "PID", platform: "posix", change: { pid: 987655 } },
  { field: "birth", platform: "posix", change: { startedAt: "another-controller" } },
  { field: "command", platform: "posix", change: { commandHash: "b".repeat(64) } },
  { field: "process group", platform: "posix", change: { processGroupId: 987655 } },
  { field: "Windows parent", platform: "windows", change: { parentPid: 1 } },
  { field: "Windows Job", platform: "windows", change: { jobObjectName: `Local\\Daynight-${randomUUID()}` } },
] as const)("retains responsibility when the journal changes the original $field identity", async ({ platform, change }) => {
  const f = await journalProcessFixture(platform, change), original = f.store.getResource(f.ticket.launchId);
  const stop = vi.spyOn(processProofs, "stopControllerProcesses").mockRejectedValue(new Error("Conflicting process must not be stopped."));
  await expect(f.adapter.stop(await located(f.adapter, f.target), request())).rejects.toThrow("conflicting lifecycle and journal process proofs");
  expect(stop).not.toHaveBeenCalled();
  expect(f.store.getResource(f.ticket.launchId)).toEqual(original);
});

it("certifies a complete empty inventory without inventing an execution or worktree owner", async () => {
  const f = await fixture(), adapter = f.adapter();
  expect(await adapter.stop(await located(adapter, f.target), request())).toMatchObject({ target: f.target, owners: [], stoppedExecutions: [], inventoryComplete: true, resourcesCleared: true });
});

it("retains every original generation when the only evidence is a ticket", async () => {
  const f = await fixture(), first = f.ticket(), second = f.ticket({ executionId: first.executionId, sessionId: first.sessionId, executionGeneration: "2" });
  for (const ticket of [first, second]) await writeLaunchTicket(f.home, ticket);
  const adapter = f.adapter(), inventory = await located(adapter, f.target);
  expect(inventory.controllers.map(item => item.ticket.executionGeneration).sort()).toEqual(["1", "2"]);
  await expect(adapter.stop(inventory, request())).rejects.toThrow("no Controller boundary proof or authoritative non-submission evidence");
  for (const ticket of [first, second]) expect(JSON.parse(await readFile(controllerTicketPath(f.home, ticket.launchId), "utf8"))).toEqual(ticket);
});

it("locates legacy same-generation attempts using the journal's exact immutable ticket", async () => {
  const f = await fixture(), { store, binding } = f.lifecycle();
  const original = f.ticket({ schemaVersion: 2, lifecycleBinding: binding });
  const launchId = randomUUID();
  const replacement = { ...original, launchId, ipcEndpoint: resolveControllerIpcEndpoint(f.home, launchId), ipcSecret: "b".repeat(64) };
  for (const ticket of [original, replacement]) await writeLaunchTicket(f.home, ticket);
  const journalFile = path.join(controllerExecutionDirectory(f.home, original.executionId), "journal.sqlite");
  await mkdir(path.dirname(journalFile), { recursive: true });
  const proof = { pid: 987659, parentPid: 1, processGroupId: null, startedAt: "original-controller", commandHash: "a".repeat(64), jobObjectName: `Local\\Daynight-${replacement.launchId}` };
  const journal = openControllerLifecycleStore(journalFile, replacement);
  journal.patchSnapshot({ controllerProcess: proof }); journal.close();
  store.register({ resourceId: original.launchId, ownerKind: "controller", operationId: original.launchId, stage: "not_dispatched",
    identity: { ...f.target, kind: "launch", launchId: original.launchId, executionId: original.executionId, sessionId: original.sessionId,
      executionGeneration: original.executionGeneration, controllerInstanceId: original.controllerInstanceId, journalFile, ticketHash: controllerPayloadHash(original) } }, true);
  vi.spyOn(processProofs, "stopControllerProcesses").mockResolvedValue();
  vi.spyOn(processProofs, "confirmControllerProcessesStopped").mockResolvedValue(true);
  const adapter = createRetiredClaimNativeCleanup({ homeDirectory: f.home, identity: f.identity, jobLeases: mockedJournalLeases() });
  const inventory = await located(adapter, f.target);
  expect(inventory.controllers.map(item => item.ticket.launchId).sort()).toEqual([original.launchId, replacement.launchId].sort());
  expect(await adapter.stop(inventory, request())).toMatchObject({ resourcesCleared: true, stoppedExecutions: [{ launchId: replacement.launchId }] });
  expect(store.getResource(original.launchId)?.stage).toBe("not_dispatched");
  await writeFile(`${controllerTicketPath(f.home, original.launchId)}.submitted`, "", { mode: 0o600 });
  await expect(adapter.stop(inventory, request())).rejects.toThrow("no Controller boundary proof or authoritative non-submission evidence");
});

it("keeps historical and later ticket-only generations unresolved without rewriting the current journal", async () => {
  const f = await fixture(), first = f.ticket(), current = f.ticket({ executionId: first.executionId, sessionId: first.sessionId, executionGeneration: "2" }), next = f.ticket({ executionId: first.executionId, sessionId: first.sessionId, executionGeneration: "3" });
  for (const ticket of [first, current, next]) await writeLaunchTicket(f.home, ticket);
  const journalFile = path.join(controllerExecutionDirectory(f.home, current.executionId), "journal.sqlite");
  await mkdir(path.dirname(journalFile), { recursive: true });
  const journal = openControllerLifecycleStore(journalFile, current); journal.close();
  const before = await readFile(journalFile), adapter = f.adapter();
  await expect(adapter.stop(await located(adapter, f.target), request())).rejects.toThrow("no Controller boundary proof or authoritative non-submission evidence");
  expect(await readFile(journalFile)).toEqual(before);
});

it("keeps an original v2 launch unresolved when the lifecycle database and journal are missing", async () => {
  const f = await fixture();
  const ticket = f.ticket({ schemaVersion: 2, lifecycleBinding: { ...f.identity, instanceId: randomUUID(), instanceEpoch: "1",
    intentVersion: "1", localEpoch: "1", scopeGeneration: "1" } });
  await writeLaunchTicket(f.home, ticket);
  const adapter = f.adapter();
  await expect(adapter.stop(await located(adapter, f.target), request())).rejects.toThrow("no Controller boundary proof or authoritative non-submission evidence");
});

it("rejects a malformed submission marker before issuing clearance", async () => {
  const f = await fixture(), ticket = f.ticket();
  await writeLaunchTicket(f.home, ticket);
  await mkdir(`${controllerTicketPath(f.home, ticket.launchId)}.submitted`);
  const adapter = f.adapter();
  await expect(adapter.stop(await located(adapter, f.target), request())).rejects.toThrow("evidence must be an ordinary file");
});

it("keeps a current v1 launch unresolved when its exact journal has no process proof", async () => {
  const f = await fixture(), ticket = f.ticket();
  await writeLaunchTicket(f.home, ticket);
  const journalFile = path.join(controllerExecutionDirectory(f.home, ticket.executionId), "journal.sqlite");
  await mkdir(path.dirname(journalFile), { recursive: true });
  const journal = openControllerLifecycleStore(journalFile, ticket); journal.close();
  const adapter = f.adapter();
  await expect(adapter.stop(await located(adapter, f.target), request())).rejects.toThrow("no Controller boundary proof or authoritative non-submission evidence");
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

it.each([1, 2] as const)("uses legacy v%s WAL to locate a private Controller and leaves compressed and current evidence intact", async version => {
  const f = await fixture(), { store, binding } = f.lifecycle(version), privateRoot = path.join(f.home, "original-controller");
  const ticket = f.ticket({ schemaVersion: 2, lifecycleBinding: binding }, privateRoot);
  await writeLaunchTicket(f.home, ticket, privateRoot);
  const journalFile = path.join(controllerExecutionDirectory(f.home, ticket.executionId, privateRoot), "journal.sqlite");
  const identity = { ...f.target, kind: "launch", executionId: ticket.executionId, sessionId: ticket.sessionId, executionGeneration: ticket.executionGeneration,
    controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, launchId: ticket.launchId, storageStateDirectory: resolveControllerStateDirectory(f.home, privateRoot), ticketHash: controllerPayloadHash(ticket), journalFile };
  const proof = { pid: 987650, parentPid: 1, processGroupId: null, startedAt: "original-controller", commandHash: "a".repeat(64), jobObjectName: `Local\\Daynight-${ticket.launchId}` };
  store.register({ resourceId: ticket.launchId, ownerKind: "controller", identity, operationId: ticket.launchId, stage: "running", processProof: proof });
  const inputId = randomUUID(), originalStopProof = { kind: "input_receipt", accepted: true };
  store.register({ resourceId: inputId, ownerKind: "controller", identity: { ...identity, kind: "input" }, operationId: inputId, stage: "confirmed", stopProof: originalStopProof }, true);
  const before = await Promise.all([f.lifecycleFile, `${f.lifecycleFile}-wal`].map(file => readFile(file)));
  vi.spyOn(processProofs, "stopControllerProcesses").mockResolvedValue();
  vi.spyOn(processProofs, "confirmControllerProcessesStopped").mockResolvedValue(true);
  const adapter = createRetiredClaimNativeCleanup({ homeDirectory: f.home, identity: f.identity, jobLeases: createControllerJobLeases("linux") }), inventory = await located(adapter, f.target);
  expect(inventory.controllers).toHaveLength(1);
  expect(await adapter.stop(inventory, request())).toMatchObject({ resourcesCleared: true, owners: [f.target], stoppedExecutions: [{ launchId: ticket.launchId }] });
  expect(store.getResource(ticket.launchId)?.stage).toBe("running");
  expect(store.getResource(inputId)?.stopProof).toEqual(originalStopProof);
  expect(await Promise.all([f.lifecycleFile, `${f.lifecycleFile}-wal`].map(file => readFile(file)))).toEqual(before);
});

it.each(["reserved", "unknown"] as const)("retains an ambiguous %s launch whose process birth was never saved", async stage => {
  const f = await fixture(), { store, binding } = f.lifecycle(), ticket = f.ticket({ schemaVersion: 2, lifecycleBinding: binding });
  await writeLaunchTicket(f.home, ticket);
  store.register({ resourceId: ticket.launchId, ownerKind: "controller", operationId: ticket.launchId, stage,
    identity: { ...f.target, kind: "launch", executionId: ticket.executionId, sessionId: ticket.sessionId, executionGeneration: ticket.executionGeneration,
      controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, launchId: ticket.launchId,
      storageStateDirectory: resolveControllerStateDirectory(f.home), ticketHash: controllerPayloadHash(ticket), journalFile: path.join(controllerExecutionDirectory(f.home, ticket.executionId), "journal.sqlite") } });
  const original = store.getResource(ticket.launchId), adapter = createRetiredClaimNativeCleanup({ homeDirectory: f.home, identity: f.identity, jobLeases: f.jobLeases });
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
  store.register({ resourceId: ticket.launchId, ownerKind: "controller", identity: { ...identity, kind: "launch" }, operationId: ticket.launchId,
    stage: "stopped", processProof: proof, stopProof: { kind: "retired_claim_controller_boundary", launchId: ticket.launchId, executionId: ticket.executionId,
      executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, ticketHash: controllerPayloadHash(ticket),
      controllerProcess: proof, nativeProcesses: [], boundaryEmpty: true, windowsJobStopped: true } });
  store.register({ resourceId: ticket.controllerInstanceId, ownerKind: "controller", identity: { ...identity, kind: "provider" },
    operationId: ticket.launchId, stage: "running", processProof: provider });
  // Only process observation is controlled: the original durable receipt and
  // independently retained Provider responsibility use real lifecycle storage.
  const inspect = vi.spyOn(processProofs, "inspectBootstrapProcessProof").mockImplementation(async value => value.pid === proof.pid ? "stopped" : "running");
  const adapter = createRetiredClaimNativeCleanup({ homeDirectory: f.home, identity: f.identity, jobLeases: createControllerJobLeases("win32") });
  await expect(adapter.stop(await located(adapter, f.target), request())).rejects.toThrow("conflicts with its durable boundary stop receipt");
  expect(inspect.mock.calls.map(call => call[0].pid)).toEqual([proof.pid, provider.pid]);
  expect(store.getResource(ticket.controllerInstanceId)?.stage).toBe("running");
  const ticketFile = controllerTicketPath(f.home, ticket.launchId);
  await writeFile(`${ticketFile}.retired-stop`, JSON.stringify(store.getResource(ticket.launchId)?.stopProof), { mode: 0o600 });
  await writeFile(`${ticketFile}.submitted`, "", { mode: 0o600 });
  inspect.mockClear();
  await expect(adapter.stop(await located(adapter, f.target), request())).rejects.toThrow("no Controller boundary proof or authoritative non-submission evidence");
  expect(inspect).not.toHaveBeenCalled();
});

it.each([[1, true], [2, true], [2, false]] as const)(
  "reuses the original unreleased-gate receipt (database v%s, ticket epoch=%s)", async (version, ticketHasEpoch) => {
  const f = await fixture(), { store, binding } = f.lifecycle(version);
  const { instanceEpoch: _instanceEpoch, ...uuidBinding } = binding;
  const ticket = f.ticket({ schemaVersion: 2, lifecycleBinding: ticketHasEpoch ? binding : uuidBinding });
  const receiptBinding = version === 1 ? binding : uuidBinding;
  await writeLaunchTicket(f.home, ticket);
  const proof = { pid: 987653, parentPid: 1, processGroupId: null, startedAt: "original-gated-controller", commandHash: "a".repeat(64), jobObjectName: `Local\\Daynight-${ticket.launchId}` };
  store.register({ resourceId: ticket.launchId, ownerKind: "controller", operationId: ticket.launchId, stage: "stopped", processProof: proof,
    stopProof: { kind: "controller_unreleased_gate", binding: receiptBinding, launchId: ticket.launchId, controllerInstanceId: ticket.controllerInstanceId, pid: proof.pid, originalProcessProof: proof, gateReleased: false, boundaryEmpty: true },
    identity: { ...f.target, kind: "launch", executionId: ticket.executionId, sessionId: ticket.sessionId, executionGeneration: ticket.executionGeneration,
      controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId, launchId: ticket.launchId,
      storageStateDirectory: resolveControllerStateDirectory(f.home), ticketHash: controllerPayloadHash(ticket), journalFile: path.join(controllerExecutionDirectory(f.home, ticket.executionId), "journal.sqlite") } });
  const original = store.getResource(ticket.launchId)!;
  const incorrectFence = version === 1 ? { ...original, instanceEpoch: "2" } : { ...original, instanceId: randomUUID() };
  expect(hasLegacyUnreleasedControllerGateProof(ticket, incorrectFence, proof)).toBe(false);
  expect(hasLegacyUnreleasedControllerGateProof(ticket, original, proof)).toBe(true);
  for (const changed of [{ gateReleased: true }, { launchId: randomUUID() }, { binding: { ...receiptBinding, scopeGeneration: "2" } }, { binding: { ...receiptBinding, instanceId: randomUUID() } }, { originalProcessProof: { ...proof, pid: proof.pid + 1 } }])
    expect(hasLegacyUnreleasedControllerGateProof(ticket, { ...original, stopProof: { ...(original.stopProof as object), ...changed } }, proof)).toBe(false);
  const inspect = vi.spyOn(processProofs, "inspectBootstrapProcessProof").mockResolvedValue("stopped");
  const leases = createControllerJobLeases("win32"), retain = vi.spyOn(leases, "retain");
  const adapter = createRetiredClaimNativeCleanup({ homeDirectory: f.home, identity: f.identity, jobLeases: leases });
  const inventory = await located(adapter, f.target);
  expect(await adapter.stop(inventory, request())).toMatchObject({ resourcesCleared: true, stoppedExecutions: [{ launchId: ticket.launchId }] });
  expect(inspect).toHaveBeenCalled(); expect(retain).not.toHaveBeenCalled();
  expect(store.getResource(ticket.launchId)).toEqual(original);
  const journalFile = path.join(controllerExecutionDirectory(f.home, ticket.executionId), "journal.sqlite");
  await expect(readFile(journalFile)).rejects.toMatchObject({ code: "ENOENT" });

  await writeFile(`${controllerTicketPath(f.home, ticket.launchId)}.submitted`, "", { mode: 0o600 });
  inspect.mockClear();
  await expect(adapter.stop(inventory, request())).rejects.toThrow("no Controller boundary proof or authoritative non-submission evidence");
  expect(inspect).not.toHaveBeenCalled();

  await mkdir(path.dirname(journalFile), { recursive: true });
  const journal = openControllerLifecycleStore(journalFile, ticket);
  const newProcess = { ...proof, pid: proof.pid + 1 };
  journal.patchSnapshot({ controllerProcess: newProcess }); journal.close();
  const stop = vi.spyOn(processProofs, "stopControllerProcesses").mockResolvedValue();
  vi.spyOn(processProofs, "confirmControllerProcessesStopped").mockResolvedValue(true);
  const resumed = createRetiredClaimNativeCleanup({ homeDirectory: f.home, identity: f.identity, jobLeases: mockedJournalLeases() });
  expect(await resumed.stop(await located(resumed, f.target), request())).toMatchObject({ resourcesCleared: true });
  expect(stop).toHaveBeenCalledExactlyOnceWith(newProcess, [], expect.any(Number), process.platform === "win32" ? expect.anything() : undefined);
});
