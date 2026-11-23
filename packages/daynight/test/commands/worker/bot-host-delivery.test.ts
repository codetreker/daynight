import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { createWorkerBotHost } from "../../../src/commands/worker/bots/host.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import * as botStores from "../../../src/commands/worker/bots/store.js";
import * as executionStores from "../../../src/commands/worker/bots/execution-store.js";
import * as botProcesses from "../../../src/commands/worker/bots/process.js";
import * as reconciliation from "../../../src/commands/worker/bots/reconciliation.js";
import * as managedRuntime from "../../../src/commands/worker/bots/runtime.js";
import * as assistantRuntime from "../../../src/commands/worker/bots/assistant-tasks.js";
import * as localStores from "../../../src/commands/worker/bots/local-store.js";
import { writeControllerCredential } from "../../../src/commands/worker/backends/session-api.js";
import { fixture as processFixture, cleanupBotProcesses } from "./bot-process.fixtures.js";
import type { AssistantTaskRuntimeOptions } from "../../../src/commands/worker/bots/assistant-tasks.js";
import { bot, id } from "./bot-store.fixtures.js";

const mocks = vi.hoisted(() => ({ collector: vi.fn() }));
vi.mock("../../../src/commands/worker/bots/host-capabilities.js", () => ({ createAssistantHostCollector: mocks.collector }));
const openStore = botStores.openBotStore, openExecutions = executionStores.openBotExecutionStore;
const createReconciliation = reconciliation.createBotReconciliation;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

const fixture = async () => {
  const root = path.resolve(import.meta.dirname, "../../../../../.tmp/bot-host-delivery"); await mkdir(root, { recursive: true });
  const home = await mkdtemp(path.join(root, "case-")); cleanups.push(() => rm(home, { recursive: true, force: true }));
  const paths = resolveWorkerPaths(home); await mkdir(paths.workerDirectory, { recursive: true });
  const source = openStore(paths.databaseFile, { onMigration: () => {} }); source.close();
  let store!: ReturnType<typeof openStore>, options!: AssistantTaskRuntimeOptions, ready = false;
  vi.spyOn(botStores, "openBotStore").mockImplementation((_file, configuration) => store = openStore(createMemoryDatabase(), configuration));
  vi.spyOn(executionStores, "openBotExecutionStore").mockImplementation((_file, configuration) => openExecutions(createMemoryDatabase(), configuration));
  const readReady = vi.fn(() => ready), observe = vi.fn<ReturnType<typeof botProcesses.createBotProcess>["observe"]>();
  vi.spyOn(reconciliation, "createBotReconciliation").mockReturnValue({ ready: readReady, ownsHosting: () => true } as never);
  vi.spyOn(botProcesses, "createBotProcess").mockReturnValue({ observe, close: async () => {} } as never);
  vi.spyOn(assistantRuntime, "createAssistantTaskRuntime").mockImplementation(input => { options = input; return { registerApplication: () => {} } as never; });
  vi.spyOn(managedRuntime, "createManagedAssistantRuntime").mockReturnValue({ run: async () => {}, closeAdmission: () => {}, shutdown: async () => {} } as never);
  mocks.collector.mockReturnValue({ close: async () => {} });
  const owner = { serverOrigin: "https://daynight.example", ownerUserId: id(1), workerId: id(2) };
  const host = createWorkerBotHost({ homeDirectory: home, packageDirectory: home, workingDirectory: home, paths, owner,
    serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", configuration: () => null, canAdmitNewExecution: () => true,
    pollIntervalMs: () => 60_000, recoveryLimit: () => 3, emit: () => {} });
  cleanups.push(host.close);
  store.observe(owner, bot(), 1); store.prepare(owner, id(3), { homeDirectory: home, recoveryLimit: 3 });
  const intent = store.get(owner, id(3))!.intent!;
  const definition = bot();
  if (definition.deletion !== null) throw new Error("Expected a live Bot definition");
  const record = store.observe(owner, { ...definition, version: "2", sessionId: id(4), testExecutionId: intent.executionId }, 2);
  const snapshot = { startup: { state: "ready" }, lifecycle: "ready", nativeStopped: false, error: null } as Awaited<ReturnType<ReturnType<typeof botProcesses.createBotProcess>["observe"]>>;
  observe.mockResolvedValue(snapshot);
  return { options, record, observe, readReady, snapshot, setReady: (value: boolean) => { ready = value; } };
};

it("retains a Bot's minute candidate while health waits for its in-flight hosting revalidation", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), finishObservation = Promise.withResolvers<typeof f.snapshot>();
  f.observe.mockImplementationOnce(async () => { entered.resolve(); return finishObservation.promise; });
  expect(f.options.bots().map(record => record.botId)).toEqual([f.record.botId]);
  expect(f.readReady).not.toHaveBeenCalled();
  const health = f.options.healthy(f.record, new AbortController().signal); await entered.promise;
  expect(f.readReady).not.toHaveBeenCalled();
  f.setReady(true); finishObservation.resolve(f.snapshot);
  await expect(health).resolves.toBe(true);
  expect(f.readReady).toHaveBeenCalledExactlyOnceWith(f.record);
});

it("keeps membership but refuses new actions after an unverified hosting observation", async () => {
  const f = await fixture();
  expect(f.options.bots().map(record => record.botId)).toEqual([f.record.botId]);
  await expect(f.options.healthy(f.record, new AbortController().signal)).resolves.toBe(false);
  expect(f.observe).toHaveBeenCalledOnce(); expect(f.readReady).toHaveBeenCalledExactlyOnceWith(f.record);
});

it.each(["startup", "stopped", "error"] as const)("does not let a current grant conceal Controller %s failure", async failure => {
  const f = await fixture(); f.setReady(true);
  f.observe.mockResolvedValue({ ...f.snapshot, ...(failure === "startup" ? { startup: { state: "failed" } } : failure === "stopped" ? { nativeStopped: true } : { error: "Original Controller failed" }) } as typeof f.snapshot);
  await expect(f.options.healthy(f.record, new AbortController().signal)).resolves.toBe(false);
});

it("waits through the real process queue and recovery ready transition before the minute scan", async () => {
  cleanups.push(cleanupBotProcesses);
  const f = processFixture(), signal = new AbortController().signal;
  // Launch and IPC are controlled; the process queue, recovery gate and Host
  // assembly execute their production implementations over real local stores.
  await f.process.advance(f.current(), signal);
  const record = f.current(), intent = record.intent!, ticket = f.getTicket();
  const receipt = { operationId: id(71), workerId: f.owner.workerId, executionGeneration: intent.executionGeneration,
    controllerInstanceId: intent.controllerInstanceId, grantExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    kind: "grant", sessionId: intent.sessionId, testExecutionId: intent.executionId, controllerId: intent.registration.controllerId };
  const result = { receipt, current: true };
  const state = { pending: null, registration: result, current: result, recoveryIdentity: id(72),
    currentOperation: { kind: "grant", workerId: f.owner.workerId, body: { operationId: receipt.operationId, controllerToken: "controlled-token" }, result } };
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let blocking = false;
  const query = vi.fn(async () => { if (blocking) { entered.resolve(); await release.promise; } return result; });
  const recovery = createReconciliation({ owner: f.owner, canSubmit: () => true,
    store: { ensureIdentity: () => state, read: () => state } as never, api: { operation: query } as never });
  await recovery.grant(record, {} as never, signal);
  expect(recovery.ready(record)).toBe(true);
  f.grant.mockImplementation(async input => ({ ...await recovery.grant(input, {} as never, signal), testExecutionId: intent.executionId }));
  await writeControllerCredential(ticket.credentialFile, { ...await f.grant(record), expiresAt: new Date(Date.now() + 1000).toISOString() });
  const manager = f.createProcess();
  let options!: AssistantTaskRuntimeOptions;
  vi.spyOn(localStores, "openLocalBotStores").mockReturnValue({ store: f.store, executions: f.executions,
    isDedicated: () => true, assertLocked: () => {}, scan: () => ({ errors: [] }) } as never);
  vi.spyOn(reconciliation, "createBotReconciliation").mockReturnValue(recovery);
  vi.spyOn(botProcesses, "createBotProcess").mockReturnValue(manager);
  vi.spyOn(assistantRuntime, "createAssistantTaskRuntime").mockImplementation(input => { options = input; return { registerApplication: () => {} } as never; });
  vi.spyOn(managedRuntime, "createManagedAssistantRuntime").mockReturnValue({ run: async () => {}, closeAdmission: () => {}, shutdown: async () => {} } as never);
  mocks.collector.mockReturnValue({ close: async () => {} });
  const paths = resolveWorkerPaths(f.home);
  const host = createWorkerBotHost({ homeDirectory: f.home, packageDirectory: f.home, workingDirectory: f.home, paths, owner: f.owner,
    serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", configuration: () => null, canAdmitNewExecution: () => true,
    pollIntervalMs: () => 60_000, recoveryLimit: () => 3, emit: () => {} });
  cleanups.push(host.close);
  blocking = true;
  const refresh = manager.refreshGrant(record, signal);
  await entered.promise;
  expect(recovery.ready(record)).toBe(false); expect(state.pending).toBeNull();
  const candidates = options.bots();
  expect(candidates.map(bot => bot.botId)).toEqual([record.botId]);
  const observations = f.observe.mock.calls.length;
  let healthSettled = false;
  const health = options.healthy(candidates[0]!, signal).then(value => { healthSettled = true; return value; });
  await Promise.resolve();
  expect(f.observe).toHaveBeenCalledTimes(observations); expect(healthSettled).toBe(false);
  release.resolve(); await refresh;
  await expect(health).resolves.toBe(true);
  expect(recovery.ready(record)).toBe(true); expect(query).toHaveBeenCalledTimes(3);
  expect(f.observe).toHaveBeenCalledTimes(observations + 1);
  expect(f.launch).toHaveBeenCalledOnce();
});
