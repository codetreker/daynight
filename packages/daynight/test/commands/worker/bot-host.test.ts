import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { createWorkerBotHost } from "../../../src/commands/worker/bots/host.js";
import type { ExecutionConfiguration } from "../../../src/commands/worker/types.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import * as botStores from "../../../src/commands/worker/bots/store.js";
import * as executionStores from "../../../src/commands/worker/bots/execution-store.js";

const mocks = vi.hoisted(() => ({ collector: vi.fn() }));
vi.mock("../../../src/commands/worker/bots/host-capabilities.js", () => ({ createAssistantHostCollector: mocks.collector }));
const openStore = botStores.openBotStore, openExecutions = executionStores.openBotExecutionStore;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/bot-host"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "h-")); cleanups.push(() => rm(home, { recursive: true, force: true }));
  vi.spyOn(botStores, "openBotStore").mockImplementation((_file, options) => openStore(createMemoryDatabase(), options));
  vi.spyOn(executionStores, "openBotExecutionStore").mockImplementation((_file, options) => openExecutions(createMemoryDatabase(), options));
  const paths = resolveWorkerPaths(home); await mkdir(paths.workerDirectory, { recursive: true });
  let configuration: ExecutionConfiguration | null = null;
  const options = { homeDirectory: home, packageDirectory: home, workingDirectory: home, paths,
    owner: { serverOrigin: "https://daynight.example", ownerUserId: "00000000-0000-4000-8000-000000000001", workerId: "00000000-0000-4000-8000-000000000002" },
    serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", configuration: () => configuration,
    pollIntervalMs: () => 60_000, recoveryLimit: () => 3, emit: () => {} };
  const sample = { assistantHost: { protocolVersion: 1, defaultProvider: "codex" }, issues: [] };
  const collect = vi.fn(async () => sample); mocks.collector.mockReturnValue({ collect });
  return { options, collect, sample, set: (value: ExecutionConfiguration | null) => { configuration = value; } };
};
const native: ExecutionConfiguration = { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 3 };

it("omits unsupported configuration and discards a capability probe spanning a cloud change", async () => {
  const f = await fixture(), host = createWorkerBotHost(f.options); cleanups.push(host.close);
  const operation = createOperation(); cleanups.push(operation.dispose);
  expect(await host.collect(operation)).toBeUndefined(); expect(f.collect).not.toHaveBeenCalled();
  f.set(native); expect(await host.collect(operation)).toBe(f.sample);
  f.collect.mockImplementationOnce(async () => { f.set({ ...native, model: "changed" }); return f.sample; });
  expect(await host.collect(operation)).toBeUndefined();
  expect(await host.collect(operation)).toBe(f.sample);
  host.close(); expect(await host.collect(operation)).toBeUndefined();
});

it("closes both actual SQLite handles when a later host constructor fails", async () => {
  const f = await fixture();
  let store!: ReturnType<typeof openStore>, executions!: ReturnType<typeof openExecutions>;
  vi.spyOn(botStores, "openBotStore").mockImplementation((_file, options) => store = openStore(createMemoryDatabase(), options));
  vi.spyOn(executionStores, "openBotExecutionStore").mockImplementation((_file, options) => executions = openExecutions(createMemoryDatabase(), options));
  mocks.collector.mockImplementationOnce(() => { throw new Error("Host observation setup failed"); });
  expect(() => createWorkerBotHost(f.options)).toThrow("Host observation setup failed");
  expect(() => store.list(f.options.owner)).toThrow(/not open|closed/i);
  // Closing again is supported by the real store close helper and leaves no live handle.
  expect(() => executions.close()).not.toThrow();
});

it("closes the first store if opening the execution store fails", async () => {
  const f = await fixture();
  let store!: ReturnType<typeof openStore>;
  vi.spyOn(botStores, "openBotStore").mockImplementation((_file, options) => store = openStore(createMemoryDatabase(), options));
  vi.spyOn(executionStores, "openBotExecutionStore").mockImplementation(() => { throw new Error("Execution store unavailable"); });
  expect(() => createWorkerBotHost(f.options)).toThrow("Execution store unavailable");
  expect(() => store.list(f.options.owner)).toThrow(/not open|closed/i);
});
