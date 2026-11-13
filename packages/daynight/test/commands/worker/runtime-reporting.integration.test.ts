import type { ArchiveProbeResult } from "../../../src/commands/controller/archive-error.js";
import { scanFromList } from "../../helpers/worker-git-scan.js";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { ApiError } from "../../../src/api/client.js";
import { OperationError } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import type { WorkerReport } from "../../../src/api/types.js";
import type { WorkerCloudDesired, WorkerCloudReport, WorkerCloudReportReceipt } from "../../../src/api/worker-configuration.js";
import type { WorkerCoordinatorOptions } from "../../../src/commands/worker/coordinator.js";
import type { WorkerConfigurationManager } from "../../../src/commands/worker/configuration.js";
import type { WorkerConfigurationExchangeEvent } from "../../../src/commands/worker/configuration-exchange.js";
import type { createWorkerReporter } from "../../../src/commands/worker/reporter.js";
import type { WorkerTelemetrySample } from "../../../src/commands/worker/telemetry.js";
import { HerdrCommandCleanupError } from "../../../src/commands/worker/herdr/command.js";
import { LegacyBindingUnavailableError } from "../../../src/commands/worker/herdr/agents.js";
import { runWorker } from "../../../src/commands/worker/runtime.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { tryAcquireWorkerInstanceLock } from "../../../src/commands/worker/instance-lock.js";
import { workerTelemetry, workerTelemetryTime } from "../../fixtures/worker-telemetry.js";

// These Task/configuration fixtures do not own a Bot service or native execution.
vi.mock("../../../src/commands/worker/tool-selection-runtime.js", async () => {
  const fixture = await import("../../helpers/worker-tool-runtime-fixture.js");
  return { createWorkerToolSelectionRuntime: (options: Parameters<typeof fixture.createWorkerToolSelectionFixture>[0]) => ({
    ...fixture.createWorkerToolSelectionFixture(options), prepareWebCandidates: mocks.prepareCandidates,
  }) };
});
vi.mock("../../../src/commands/worker/bots/host.js", () => ({ createWorkerBotHost: (options: { copilotRequired: () => boolean }) => ({
  run: async () => {}, shutdown: async () => {}, collect: async () => undefined, requiresCopilot: mocks.botRequiresCopilot, activeToolSelections: () => [], close: () => {},
  ...mocks.captureBotOptions(options),
}) }));

const mocks = vi.hoisted(() => ({ coordinator: vi.fn(), herdr: vi.fn(), durable: vi.fn(), git: vi.fn(), prompt: vi.fn(), remote: vi.fn(), telemetry: vi.fn(), webOpen: vi.fn(), webClose: vi.fn(), webBackend: vi.fn(), emit: vi.fn(), completed: vi.fn(), archive: vi.fn(), archiveProbe: vi.fn(), ticket: vi.fn(), delay: vi.fn(), probe: vi.fn(), cachePersist: vi.fn(), exchangeStage: vi.fn(), createdConfiguration: vi.fn(), createdReporter: vi.fn(), prepareCandidates: vi.fn(async (_signal: AbortSignal, _required: boolean) => false), botRequiresCopilot: vi.fn(() => false), captureBotOptions: vi.fn((_options: { copilotRequired: () => boolean }) => ({})) }));
vi.mock("../../../src/commands/worker/configuration.js", async original => {
  const actual = await original<typeof import("../../../src/commands/worker/configuration.js")>();
  return { ...actual, createWorkerConfigurationManager: async (...args: Parameters<typeof actual.createWorkerConfigurationManager>) => {
    const manager = await actual.createWorkerConfigurationManager(...args);
    mocks.createdConfiguration(manager);
    return manager;
  } };
});
vi.mock("../../../src/commands/worker/configuration-exchange.js", async original => {
  const actual = await original<typeof import("../../../src/commands/worker/configuration-exchange.js")>();
  return { ...actual, createWorkerConfigurationExchange: (options: Parameters<typeof actual.createWorkerConfigurationExchange>[0]) => actual.createWorkerConfigurationExchange({
    ...options, onStage: event => { mocks.exchangeStage(event); options.onStage?.(event); },
  }) };
});
vi.mock("../../../src/commands/worker/reporter.js", async original => {
  const actual = await original<typeof import("../../../src/commands/worker/reporter.js")>();
  return { ...actual, createWorkerReporter: (...args: Parameters<typeof actual.createWorkerReporter>) => {
    const reporter = actual.createWorkerReporter(...args);
    mocks.createdReporter(reporter);
    return reporter;
  } };
});
vi.mock("../../../src/platform/files.js", async original => {
  const actual = await original<typeof import("../../../src/platform/files.js")>();
  return { ...actual, replaceFileAtomicallyFromChunks: (...args: Parameters<typeof actual.replaceFileAtomicallyFromChunks>) =>
    mocks.cachePersist.getMockImplementation() ? mocks.cachePersist(...args) : actual.replaceFileAtomicallyFromChunks(...args) };
});
vi.mock("node:timers/promises", async original => {
  const actual = await original<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: (...args: Parameters<typeof actual.setTimeout>) => mocks.delay(...args) };
});
vi.mock("../../../src/commands/controller/archive-upload.js", () => ({ uploadStoppedControllerArchive: mocks.archive, probeStoppedControllerArchive: mocks.archiveProbe }));
vi.mock("../../../src/commands/controller/launch-ticket.js", async original => ({ ...await original<object>(), readLaunchTicket: mocks.ticket }));
vi.mock("../../../src/commands/worker/coordinator.js", () => ({ createWorkerCoordinator: mocks.coordinator }));
vi.mock("../../../src/commands/worker/herdr.js", async original => ({ ...await original<object>(), createWorkerHerdr: mocks.herdr }));
vi.mock("../../../src/commands/worker/herdr/shared.js", () => ({ createSharedWorkerHerdr: mocks.herdr }));
vi.mock("../../../src/commands/worker/herdr/durable.js", async original => {
  const actual = await original<typeof import("../../../src/commands/worker/herdr/durable.js")>();
  return { ...actual, createDurableWorkerHerdr: (...args: Parameters<typeof actual.createDurableWorkerHerdr>) => mocks.durable.getMockImplementation() ? mocks.durable(...args) : actual.createDurableWorkerHerdr(...args) };
});
vi.mock("../../../src/commands/worker/worktrees.js", async original => ({ ...await original<object>(), createWorkerGitManager: mocks.git }));
vi.mock("../../../src/commands/worker/prompts.js", async original => ({ ...await original<object>(), buildWorkerPrompt: mocks.prompt }));
vi.mock("../../../src/commands/worker/remote.js", () => ({ createWorkerRemote: mocks.remote }));
vi.mock("../../../src/commands/worker/telemetry.js", () => ({ createWorkerTelemetryCollector: mocks.telemetry }));
vi.mock("../../../src/commands/worker/herdr/version-probe.js", async original => ({ ...await original<object>(), probeNativeAgentVersion: mocks.probe }));
vi.mock("../../../src/commands/worker/backends/web-store.js", () => ({ openWebExecutionStore: mocks.webOpen }));
vi.mock("../../../src/commands/worker/backends/web.js", async original => ({ ...await original<object>(), createWebExecutionBackend: mocks.webBackend }));
vi.mock("../../../src/commands/worker/backends/web-process.js", () => ({ createWebControllerLauncher: () => ({}) }));
vi.mock("../../../src/commands/worker/backends/grant-renewal.js", () => ({ maintainWorkerControllerGrants: async () => {} }));
vi.mock("../../../src/commands/worker/diagnostics.js", () => ({ createWorkerDiagnostics: async () => ({ emit: mocks.emit, flush: async () => {}, close: async () => {}, filename: "worker.jsonl" }) }));

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const remoteUrl = "https://git.example/team/repo.git";
const roots: string[] = [];
const runs = new Set<{ signal: AbortController; running: Promise<void> }>();
const settlements = new Set<() => void>();
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  settlements.add(() => resolve(undefined as T));
  return { promise, resolve };
};
const eventually = (check: () => void | Promise<void>) => vi.waitFor(check, { timeout: 3500, interval: 10 });
const realNow = performance.now.bind(performance);
// Retry deadlines advance only at explicit test boundaries; vi.waitFor advances fake timers while polling.
const eventuallyWithoutAdvancingTime = async (check: () => void): Promise<void> => {
  const timers = await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises");
  const deadline = realNow() + 3500;
  for (;;) {
    try { check(); return; }
    catch (error) { if (realNow() >= deadline) throw error; }
    await timers.setTimeout(10);
  }
};
const configurationTransitions = () => mocks.emit.mock.calls.filter(([event]) => event.kind === "worker-configuration").map(([event]) => JSON.parse(event.message));
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/runtime-reporting-tests");
  await mkdir(base, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(base, "w-")); roots.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory);
  await mkdir(paths.stateDirectory, { recursive: true });
  await writeFile(paths.configFile, stringify({ serverUrl: "https://daynight.example", serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", workerId: uuid(4), worker: { repositories: [{ remote: remoteUrl, path: path.join(homeDirectory, "repo"), projectId: uuid(1) }], maxConcurrent: 9 } }));
  return { homeDirectory, paths, packageDirectory: path.resolve("package"), version: "9.8.7", workingDirectory: path.join(homeDirectory, "startup"), signal: new AbortController() };
};
const start = (f: Awaited<ReturnType<typeof fixture>>) => {
  const running = runWorker({ ...f, signal: f.signal.signal });
  runs.add({ signal: f.signal, running }); void running.catch(() => {}); return running;
};
let target: WorkerCloudDesired;
let observationRevision: bigint;
let collect: ReturnType<typeof vi.fn<(operation: Operation) => Promise<WorkerTelemetrySample>>>;
let report: ReturnType<typeof vi.fn<(workerId: string, value: WorkerReport, configuration: WorkerCloudReport, operation: Operation) => Promise<WorkerCloudReportReceipt>>>;
let prepare: ReturnType<typeof vi.fn>;
let shutdown: ReturnType<typeof vi.fn>;
let dispose: ReturnType<typeof vi.fn>;
let update: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.botRequiresCopilot.mockReturnValue(false);
  mocks.cachePersist.mockReset();
  mocks.durable.mockReset();
  mocks.archiveProbe.mockReset().mockResolvedValue({ kind: "attempt" });
  mocks.delay.mockImplementation((await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises")).setTimeout);
  mocks.completed.mockReturnValue([]); mocks.webClose.mockImplementation(() => {}); mocks.emit.mockImplementation(() => {});
  mocks.webBackend.mockReturnValue({});
  mocks.webOpen.mockImplementation(() => ({ close: mocks.webClose, listCompletedTasks: mocks.completed }));
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  target = { revision: "1", updatedAt: workerTelemetryTime, value: { maxConcurrent: 1, pollIntervalMs: 60_000, recoveryLimit: 3, preferPlatformSpecificTasks: false, native: { agent: "codex", model: null, args: [] }, projects: [{ projectId: uuid(1), nativeOverrides: {} }] } };
  observationRevision = 0n;
  collect = vi.fn(async () => ({ telemetry: workerTelemetry, issues: [] }));
  report = vi.fn(async (_workerId, _body, configuration) => {
    const observationAccepted = configuration.observation !== null && configuration.observation.baseRevision === String(observationRevision);
    if (observationAccepted) observationRevision++;
    return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: target, observationRevision: String(observationRevision), observationAccepted } };
  });
  prepare = vi.fn(async () => {}); shutdown = vi.fn(async () => true); dispose = vi.fn(async () => {}); update = vi.fn();
  mocks.telemetry.mockReturnValue({ collect }); mocks.probe.mockResolvedValue("0.164.0");
  mocks.remote.mockReturnValue({ currentUserId: vi.fn(async () => uuid(6)), configuration: vi.fn(async () => ({ desired: target, observationRevision: "0", observation: null })), resolveProject: vi.fn(async () => ({ id: uuid(1), repoUrl: remoteUrl })), project: vi.fn(async () => ({ id: uuid(1), repoUrl: remoteUrl })), reportConfiguration: report, report: vi.fn() });
  mocks.git.mockReturnValue(Object.assign({ prepareRepository: prepare, dispose, listWorktrees: vi.fn(async () => []) }, { scanWorktrees: scanFromList }));
  mocks.herdr.mockReturnValue({ stopInstance: vi.fn(async () => ({ stopped: true })), attachment: {} });
  mocks.prompt.mockReturnValue("prompt");
  mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => ({ tick: vi.fn(async () => { if (!options.signal!.aborted) await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), { once: true })); }), archiveYield: () => false, updateConfiguration: update, shutdown }));
});
afterEach(async () => {
  for (const { signal } of runs) signal.abort();
  for (const settle of settlements) settle(); settlements.clear();
  await Promise.allSettled([...runs].map(({ running }) => running)); runs.clear();
  vi.restoreAllMocks(); vi.useRealTimers();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("worker runtime configuration reporting", () => {
  it("keeps reconciliation running when Bot demand cannot be read", async () => {
    const failure = new Error("Bot inventory unavailable");
    mocks.botRequiresCopilot.mockImplementation(() => { throw failure; });
    const f = await fixture();
    const running = start(f);
    await eventually(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "warning", error: failure })));
    await eventually(() => expect(mocks.coordinator).toHaveBeenCalled());
    expect(mocks.prepareCandidates).not.toHaveBeenCalled();
    f.signal.abort(); await running;
  });

  it("shares current effective Copilot demand with preparation and assistant collection", async () => {
    const f = await fixture();
    const running = start(f);
    await eventually(() => expect(mocks.captureBotOptions).toHaveBeenCalledOnce());
    const manager = mocks.createdConfiguration.mock.calls[0]![0] as WorkerConfigurationManager;
    await manager.settle();
    const required = mocks.captureBotOptions.mock.calls[0]![0].copilotRequired;
    await eventually(() => expect(mocks.prepareCandidates).toHaveBeenCalled());
    expect(mocks.prepareCandidates.mock.calls[0]![1]).toBe(false);
    expect(required()).toBe(false);

    target = { ...target, revision: "2", value: { ...target.value, native: { agent: "copilot", model: null, args: [] } } };
    await manager.receive(target, "0"); await manager.settle();
    expect(required()).toBe(true);

    target = { ...target, revision: "3", value: { ...target.value, native: { agent: "codex", model: null, args: [] }, projects: [{ projectId: uuid(1), nativeOverrides: { agent: "copilot" } }] } };
    await manager.receive(target, "0"); await manager.settle();
    expect(manager.current().effective.projects[0]?.native?.agent).toBe("copilot");
    expect(required()).toBe(true);

    target = { ...target, revision: "4", value: { ...target.value, projects: [{ projectId: uuid(1), nativeOverrides: {} }] } };
    await manager.receive(target, "0"); await manager.settle();
    expect(required()).toBe(false);
    mocks.botRequiresCopilot.mockReturnValue(true);
    expect(required()).toBe(true);
    mocks.botRequiresCopilot.mockReturnValue(false);
    expect(required()).toBe(false);
    f.signal.abort(); await running;
  });
  it("classifies a real filesystem failure at the owned project-preparation boundary", async () => {
    const f = await fixture();
    prepare.mockImplementation(async () => { await readFile(f.homeDirectory, "utf8"); });
    const running = start(f);
    await eventually(() => expect(mocks.createdConfiguration).toHaveBeenCalledOnce());
    const manager = mocks.createdConfiguration.mock.calls[0]![0] as WorkerConfigurationManager;
    await eventually(() => expect(manager.current().items).toContainEqual(expect.objectContaining({ key: { kind: "projectPreparation", projectId: uuid(1) }, state: "error", error: expect.objectContaining({ code: "io_error", phase: "prepare" }) })));
    expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ configuration: expect.objectContaining({ phase: "prepare", reason: "io_error", details: expect.objectContaining({ systemCode: "EISDIR" }) }) }));
    expect(manager.current().effective.projects.find(project => project.projectId === uuid(1))?.ready).toBe(false);
    f.signal.abort(); await running;
  });

  it("persists a confirmed receipt when its diagnostic notification throws and retains that original error for shutdown", async () => {
    const f = await fixture(), original = new Error("configuration diagnostic formatter failed", { cause: new Error("original diagnostic cause") });
    target = { ...target, value: { ...target.value, projects: [], agentControlMode: "herdr", toolPaths: { codex: null, copilot: null, herdr: null } } };
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockImplementation(async () => ({ desired: target, observationRevision: String(observationRevision), observation: null }));
    let failed = false;
    mocks.emit.mockImplementation(event => {
      if (!failed && event.configuration?.phase === "report-send" && event.configuration.status === "succeeded") { failed = true; throw original; }
    });
    const running = start(f);
    await eventually(() => expect(mocks.createdConfiguration).toHaveBeenCalledOnce());
    const manager = mocks.createdConfiguration.mock.calls[0]![0] as WorkerConfigurationManager;
    await eventually(() => { expect(failed).toBe(true); expect(observationRevision).toBeGreaterThan(0n); expect(manager.current().observationRevision).toBe(String(observationRevision)); });
    expect(report.mock.calls.map(([, , captured]) => captured.observation?.baseRevision)).toEqual([...new Set(report.mock.calls.map(([, , captured]) => captured.observation?.baseRevision))]);
    f.signal.abort(); await expect(running).rejects.toBe(original);
    const persisted = JSON.parse(await readFile(f.paths.configurationFile, "utf8")) as { authority: { observationRevision: string } };
    expect(persisted.authority.observationRevision).toBe(String(observationRevision));
    expect(original.cause).toBeInstanceOf(Error);
  });

  it.each(["lower", "same-revision"] as const)("reconciles a restarted %s target and cursor from the authenticated service", async scenario => {
    const f = await fixture();
    const cached: WorkerCloudDesired = { ...target, revision: "10", value: { ...target.value, projects: [], maxConcurrent: 8, native: { ...target.value.native, model: "cached-model" } } };
    const { createWorkerConfigurationManager } = await vi.importActual<typeof import("../../../src/commands/worker/configuration.js")>("../../../src/commands/worker/configuration.js");
    await mkdir(f.paths.workerDirectory, { recursive: true });
    const previous = await createWorkerConfigurationManager({ file: f.paths.configurationFile, identity: { serverOrigin: "https://daynight.example", userId: uuid(6), workerId: uuid(4) }, signal: new AbortController().signal, applyNative: async () => {} });
    await previous.receive(cached, "10"); await previous.settle(); await previous.stop();
    target = { ...cached, revision: scenario === "lower" ? "5" : "10", value: { ...cached.value, maxConcurrent: 3, native: { ...cached.value.native, model: "canonical-model" }, agentControlMode: "herdr", toolPaths: { codex: null, copilot: null, herdr: null } } };
    observationRevision = 5n;
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockImplementation(async () => ({ desired: target, observationRevision: "5", observation: null }));
    const running = start(f);
    await eventually(() => expect(report.mock.calls.some(([, , configuration]) => configuration.observation?.desiredRevision === target.revision && configuration.observation.baseRevision === "5")).toBe(true));
    const manager = mocks.createdConfiguration.mock.calls[0]![0] as WorkerConfigurationManager;
    await manager.settle();
    expect(manager.current().desired).toEqual(target);
    expect(manager.current().effective.maxConcurrent).toBe(3);
    expect(manager.current().effective.native?.model).toBe("canonical-model");
    expect(report.mock.calls.every(([, , configuration]) => configuration.observation === null || configuration.observation.items.every(item => BigInt(item.targetRevision) <= BigInt(target.revision)))).toBe(true);
    const reads = remote.configuration.mock.calls.length;
    const reporter = mocks.createdReporter.mock.calls[0]![0] as ReturnType<typeof createWorkerReporter>;
    reporter.trigger();
    await eventually(() => expect(report.mock.calls.length).toBeGreaterThan(1));
    expect(remote.configuration).toHaveBeenCalledTimes(reads);
    f.signal.abort(); await running;
    const persisted = JSON.parse(await readFile(f.paths.configurationFile, "utf8")) as { authority: { desired: WorkerCloudDesired; observationRevision: string } };
    expect(persisted.authority.desired).toEqual(target);
    expect(persisted.authority.observationRevision).toBe(String(observationRevision));
  });

  it("discards telemetry collected across a canonical generation change before sending", async () => {
    const f = await fixture(), collecting = deferred<void>(), release = deferred<void>();
    target = { ...target, value: { ...target.value, projects: [], agentControlMode: "herdr", toolPaths: { codex: null, copilot: null, herdr: null } } };
    collect.mockImplementationOnce(async () => { collecting.resolve(); await release.promise; return { telemetry: workerTelemetry, issues: [] }; });
    const freshTime = "2026-10-29T00:00:30.000Z";
    collect.mockResolvedValue({ telemetry: { ...workerTelemetry, sampledAt: freshTime }, issues: [] });
    const running = start(f);
    await collecting.promise;
    const manager = mocks.createdConfiguration.mock.calls[0]![0] as WorkerConfigurationManager;
    target = { ...target, revision: "5", value: { ...target.value, maxConcurrent: 4 } };
    await manager.receive(target, "0");
    release.resolve();
    const reporter = mocks.createdReporter.mock.calls[0]![0] as ReturnType<typeof createWorkerReporter>;
    reporter.trigger();
    await eventually(() => expect(report).toHaveBeenCalled());
    expect(report.mock.calls.every(([, telemetry, configuration]) => telemetry.sampledAt === freshTime && configuration.observation?.desiredRevision === "5")).toBe(true);
    f.signal.abort(); await running;
  });

  it("reimports a null target from the current local file and adopts the accepted target", async () => {
    const f = await fixture();
    target = { ...target, revision: "8", value: { ...target.value, projects: [], agentControlMode: "herdr", toolPaths: { codex: null, copilot: null, herdr: null } } };
    const remote = mocks.remote(); mocks.remote.mockClear();
    let canonical: WorkerCloudDesired | null = target;
    remote.configuration.mockImplementation(async () => ({ desired: canonical, observationRevision: String(observationRevision), observation: null }));
    report.mockImplementation(async (_workerId, _telemetry, configuration) => {
      if (configuration.bootstrap !== null) canonical = { revision: "1", updatedAt: workerTelemetryTime, value: configuration.bootstrap };
      const observationAccepted = configuration.observation !== null && canonical !== null && configuration.observation.desiredRevision === canonical.revision && configuration.observation.baseRevision === String(observationRevision);
      if (observationAccepted) observationRevision++;
      return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: canonical, observationRevision: String(observationRevision), observationAccepted } };
    });
    const running = start(f);
    await eventually(() => expect(report).toHaveBeenCalled());
    const manager = mocks.createdConfiguration.mock.calls[0]![0] as WorkerConfigurationManager;
    await manager.settle();
    await writeFile(f.paths.configFile, stringify({ serverUrl: "https://daynight.example", serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", workerId: uuid(4), worker: { repositories: [], maxConcurrent: 6, model: "current-file-model", agentControlMode: "web", toolPaths: { codex: null, copilot: null, herdr: null } } }));
    canonical = null; observationRevision = 0n;
    await manager.receive(null, "0");
    expect(mocks.coordinator.mock.calls[0]?.[0].configurationComplete()).toBe(false);
    const reporter = mocks.createdReporter.mock.calls[0]![0] as ReturnType<typeof createWorkerReporter>;
    reporter.trigger();
    await eventually(() => expect(report.mock.calls.some(([, , configuration]) => configuration.bootstrap?.maxConcurrent === 6)).toBe(true));
    const imported = report.mock.calls.find(([, , configuration]) => configuration.bootstrap?.maxConcurrent === 6)![2];
    expect(imported.observation).toBeNull();
    expect(imported.bootstrap).toMatchObject({ maxConcurrent: 6, native: { model: "current-file-model" }, projects: [] });
    await eventually(() => expect(manager.current().desired).toEqual(canonical));
    expect(manager.current().desired?.value.maxConcurrent).toBe(6);
    expect(manager.current().desired?.value.native.model).toBe("current-file-model");
    f.signal.abort(); await running;
  });

  it("adopts a competing service target and drains a shared candidate after its report waiter expires", async () => {
    const f = await fixture();
    const local = { serverUrl: "https://daynight.example", serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", workerId: uuid(4) };
    await writeFile(f.paths.configFile, stringify({ ...local, worker: { repositories: [], maxConcurrent: 9 } }));
    target = { ...target, value: { ...target.value, projects: [], agentControlMode: "herdr", toolPaths: { codex: null, copilot: null, herdr: null } } };
    let canonical: WorkerCloudDesired | null = target;
    const remote = mocks.remote(); mocks.remote.mockClear();
    const order: string[] = [];
    remote.configuration.mockImplementation(async () => { order.push(`GET:${canonical?.revision ?? "null"}`); return { desired: canonical, observationRevision: String(observationRevision), observation: null }; });
    report.mockImplementation(async (_workerId, _telemetry, configuration) => {
      order.push(`POST:${configuration.bootstrap === null ? configuration.observation?.desiredRevision : "bootstrap"}`);
      const observationAccepted = configuration.observation !== null && canonical !== null && configuration.observation.desiredRevision === canonical.revision && configuration.observation.baseRevision === String(observationRevision);
      if (observationAccepted) observationRevision++;
      return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: canonical, observationRevision: String(observationRevision), observationAccepted } };
    });
    const running = start(f);
    await eventually(() => expect(report).toHaveBeenCalled());
    const manager = mocks.createdConfiguration.mock.calls[0]![0] as WorkerConfigurationManager;
    await manager.settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(workerTelemetryTime)); vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    let candidateSignal: AbortSignal | undefined;
    remote.resolveProject.mockImplementation(async (_repository: unknown, signal: AbortSignal) => {
      candidateSignal = signal;
      await new Promise<void>(resolve => signal.aborted ? resolve() : signal.addEventListener("abort", () => { resolve(); }, { once: true }));
      signal.throwIfAborted();
      return { id: uuid(1), repoUrl: remoteUrl };
    });
    await writeFile(f.paths.configFile, stringify({ ...local, worker: { repositories: [{ remote: remoteUrl, path: path.join(f.homeDirectory, "candidate"), projectId: uuid(1) }], maxConcurrent: 7 } }));
    canonical = null; observationRevision = 0n;
    await manager.receive(null, "0");
    const reporter = mocks.createdReporter.mock.calls[0]![0] as ReturnType<typeof createWorkerReporter>;
    reporter.trigger(); await eventuallyWithoutAdvancingTime(() => expect(candidateSignal, JSON.stringify(mocks.emit.mock.calls.map(([event]) => [event.kind, event.message, event.error?.message]))).toBeDefined());
    const posts = report.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    await eventuallyWithoutAdvancingTime(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker_report_failed" })));
    expect(candidateSignal!.aborted).toBe(false); expect(report).toHaveBeenCalledTimes(posts);
    canonical = { ...target, revision: "2", value: { ...target.value, maxConcurrent: 4 } };
    reporter.trigger();
    await vi.advanceTimersByTimeAsync(15_000);
    await eventuallyWithoutAdvancingTime(() => expect(candidateSignal!.aborted).toBe(true));
    await eventuallyWithoutAdvancingTime(() => expect(report.mock.calls.slice(posts).some(([, , configuration]) => configuration.observation?.desiredRevision === "2")).toBe(true));
    expect(report.mock.calls.every(([, , configuration]) => configuration.bootstrap === null)).toBe(true);
    expect(order.indexOf("GET:2")).toBeLessThan(order.indexOf("POST:2"));
    expect(manager.current().desired).toEqual(canonical);
    f.signal.abort(); await running;
  });

  it.each([{ supported: false, change: "upgrade" }, { supported: true, change: "rollback" }])("renegotiates control mode after a server $change", async ({ supported: initialSupport }) => {
    const f = await fixture();
    target = { ...target, value: { ...target.value, projects: [] } };
    const { createWorkerRemote } = await vi.importActual<typeof import("../../../src/commands/worker/remote.js")>("../../../src/commands/worker/remote.js");
    const real = createWorkerRemote({ serverUrl: "https://daynight.example", serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890" });
    let supported = initialSupport;
    let upgradeOnRead = false, upgradeBoundary: number | undefined;
    const exchanges: string[] = [];
    const accepted: WorkerCloudReport[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      const pathname = new URL(String(url)).pathname, headers = new Headers(options!.headers);
      if (pathname.endsWith("/configuration") && upgradeOnRead) { supported = true; upgradeOnRead = false; upgradeBoundary = exchanges.length; }
      const mode = supported && headers.get("Daynight-Worker-Control-Mode") === "1";
      // Stable tool support keeps this fixture's renegotiation specific to control mode.
      const tools = headers.get("Daynight-Worker-Tool-Paths") === "1";
      const desired = { ...target, value: { ...target.value, ...(mode ? { agentControlMode: "web" } : {}), ...(tools ? { toolPaths: { codex: null, copilot: null, herdr: null } } : {}) } };
      const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: {
        "Content-Type": "application/json", "Daynight-User-ID": uuid(6),
        ...(headers.has("Daynight-Worker-Configuration") ? { "Daynight-Worker-Configuration": headers.get("Daynight-Worker-Configuration")! } : {}),
        ...(mode ? { "Daynight-Worker-Control-Mode": "1" } : {}),
        ...(tools ? { "Daynight-Worker-Tool-Paths": "1" } : {}),
      } });
      if (pathname === "/api/v1/me") return response({ id: uuid(6), email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: uuid(7), kind: "personal", name: null } });
      if (pathname.endsWith("/configuration")) {
        exchanges.push(`GET:${mode ? "mode" : "legacy"}`);
        return response({ desired, observationRevision: "0", observation: null });
      }
      if (pathname.endsWith("/report")) {
        const configuration = (JSON.parse(options!.body as string) as { configuration: WorkerCloudReport }).configuration;
        const includesMode = Object.hasOwn(configuration, "controlModeBootstrap");
        if (!supported && includesMode) {
          exchanges.push("POST:mode:rejected");
          return response({ error: { code: "invalid_input", message: "Unknown Worker configuration field.", requestId: "mode-rollback" } }, 400);
        }
        exchanges.push(`POST:${includesMode ? "mode" : "legacy"}:accepted`);
        accepted.push(configuration);
        const selectors = JSON.parse(headers.get("Daynight-Worker-Prompts")!) as { key: { scope: string; projectId?: string } }[];
        const prompts = selectors.map(({ key }) => ({ key, status: "value", value: { scope: key.scope, scopeId: key.scope === "user" ? uuid(6) : key.scope === "worker" ? uuid(4) : key.projectId, revision: "0", text: "", updatedAt: null } }));
        return response({ observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired, observationRevision: "0", observationAccepted: false, prompts } });
      }
      throw new Error(`Unexpected request ${pathname}`);
    });
    mocks.remote.mockReturnValue({ ...real, project: vi.fn(async () => ({ id: uuid(1), repoUrl: remoteUrl })), resolveProject: vi.fn(async () => ({ id: uuid(1), repoUrl: remoteUrl })) });
    const running = start(f);
    await eventually(() => expect(accepted.some(configuration => configuration.observation?.items.some(item => item.key.kind === "native" && item.state === "applied"))).toBe(true));
    const manager = mocks.createdConfiguration.mock.calls[0]![0] as WorkerConfigurationManager;
    const acknowledgement = manager.acknowledge, committed = deferred<void>();
    const observeAcknowledgement = vi.spyOn(manager, "acknowledge").mockImplementation(async (...args) => { const outcome = await acknowledgement(...args); committed.resolve(); return outcome; });
    const reporter = mocks.createdReporter.mock.calls[0]![0] as ReturnType<typeof createWorkerReporter>;
    reporter.trigger(); await committed.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    observeAcknowledgement.mockRestore();
    const before = exchanges.length;
    if (initialSupport) supported = false;
    else upgradeOnRead = true;
    await vi.advanceTimersByTimeAsync(30_000);
    if (initialSupport) {
      await eventually(() => expect(exchanges.slice(before)).toEqual(["POST:mode:rejected"]));
      await eventually(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker_report_failed" })));
      await vi.advanceTimersByTimeAsync(30_000);
      await eventually(() => expect(exchanges.slice(before, before + 3)).toEqual(["POST:mode:rejected", "GET:legacy", "POST:legacy:accepted"]));
      expect(accepted.at(-1)).not.toHaveProperty("controlModeBootstrap");
      expect(accepted.at(-1)!.observation?.items.some(item => item.key.kind === "agentControlMode")).toBe(false);
    } else {
      await eventually(() => { expect(upgradeBoundary).toBeDefined(); expect(exchanges.slice(upgradeBoundary, upgradeBoundary! + 2)).toEqual(["GET:mode", "POST:mode:accepted"]); });
      await eventually(() => expect(update.mock.calls.some(([configuration]) => configuration.globalConfiguration?.agentControlMode === "web")).toBe(true));
      expect(accepted.at(-1)!.controlModeBootstrap).toBe("herdr");
    }
    f.signal.abort(); await running;
  });

  it("shares the real response byte budget between reconciliation GET and report POST", async () => {
    const f = await fixture();
    target = { ...target, value: { ...target.value, projects: [] } };
    const { createWorkerRemote } = await vi.importActual<typeof import("../../../src/commands/worker/remote.js")>("../../../src/commands/worker/remote.js");
    const real = createWorkerRemote({ serverUrl: "https://daynight.example", serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890" });
    const getBody = JSON.stringify({ desired: target, observationRevision: "0", observation: null });
    let posts = 0, getOperation: Operation | undefined, postOperation: Operation | undefined;
    const response = (body: string, version?: string) => new Response(body, { headers: { "Content-Type": "application/json", "Daynight-User-ID": uuid(6), ...(version === undefined ? {} : { "Daynight-Worker-Configuration": version }) } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/api/v1/me") return response(JSON.stringify({ id: uuid(6), email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: uuid(7), kind: "personal", name: null } }));
      if (pathname.endsWith("/configuration")) return response(getBody, "1");
      if (pathname.endsWith("/report")) {
        if (++posts === 1) throw new Error("lost response");
        const selectors = JSON.parse(new Headers(options!.headers).get("Daynight-Worker-Prompts")!) as { key: { scope: string; projectId?: string } }[];
        const prompts = selectors.map(({ key }) => ({ key, status: "value", value: { scope: key.scope, scopeId: key.scope === "user" ? uuid(6) : key.scope === "worker" ? uuid(4) : key.projectId, revision: "0", text: "", updatedAt: null } }));
        return response(JSON.stringify({ observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: target, observationRevision: "0", observationAccepted: false, prompts } }), "2");
      }
      throw new Error(`Unexpected request ${pathname}`);
    });
    mocks.remote.mockReturnValue({ ...real,
      project: vi.fn(async () => ({ id: uuid(1), repoUrl: remoteUrl })),
      resolveProject: vi.fn(async () => ({ id: uuid(1), repoUrl: remoteUrl })),
      configuration: async (workerId: string, signal: AbortSignal, operation?: Operation) => {
        if (operation !== undefined) { getOperation ??= operation; operation.consume(operation.limits.totalBytes - Buffer.byteLength(getBody) - 1); }
        return real.configuration(workerId, signal, operation);
      },
      reportConfiguration: async (...args: Parameters<typeof real.reportConfiguration>) => { if (posts !== 0) postOperation ??= args[3]; return real.reportConfiguration(...args); },
    });
    const running = start(f);
    await eventually(() => expect(posts).toBe(1));
    await eventually(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker_report_failed" })));
    await vi.advanceTimersByTimeAsync(30_000);
    await eventuallyWithoutAdvancingTime(() => expect(posts).toBeGreaterThanOrEqual(2));
    await eventuallyWithoutAdvancingTime(() => expect(mocks.emit.mock.calls.filter(([event]) => event.kind === "worker_report_failed").map(([event]) => [event.message, event.error?.message, event.error?.cause?.message])).toContainEqual([expect.any(String), "http_response_200", "operation_total_limit"]));
    expect(getOperation).toBeDefined(); expect(postOperation).toBe(getOperation);
    expect(getOperation!.limits).toMatchObject({ totalMs: 15_000, requestMs: 10_000, responseBytes: 128 * 1_048_576, totalBytes: 256 * 1_048_576 });
    f.signal.abort(); await running;
  });

  it("bounds a stalled reconciliation GET by the reporter request deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const advanceTime = async (milliseconds: number): Promise<void> => {
      elapsed += milliseconds;
      await vi.advanceTimersByTimeAsync(milliseconds);
    };
    const f = await fixture();
    target = { ...target, value: { ...target.value, projects: [] } };
    const { createWorkerRemote } = await vi.importActual<typeof import("../../../src/commands/worker/remote.js")>("../../../src/commands/worker/remote.js");
    const real = createWorkerRemote({ serverUrl: "https://daynight.example", serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890" });
    const response = (body: unknown, version?: string) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Daynight-User-ID": uuid(6), ...(version === undefined ? {} : { "Daynight-Worker-Configuration": version }) } });
    let posts = 0, reads = 0, requestSignal: AbortSignal | undefined, getOperation: Operation | undefined;
    const requestSignals: AbortSignal[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/api/v1/me") return response({ id: uuid(6), email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: uuid(7), kind: "personal", name: null } });
      if (pathname.endsWith("/configuration")) {
        if (++reads === 1) return response({ desired: target, observationRevision: "0", observation: null }, "1");
        const currentSignal = options!.signal!;
        requestSignals.push(currentSignal);
        requestSignal ??= currentSignal;
        return new Promise<Response>((_resolve, reject) => currentSignal.addEventListener("abort", () => reject(currentSignal.reason), { once: true }));
      }
      if (pathname.endsWith("/report")) { posts++; throw new Error("lost response"); }
      throw new Error(`Unexpected request ${pathname}`);
    });
    mocks.remote.mockReturnValue({ ...real, project: vi.fn(async () => ({ id: uuid(1), repoUrl: remoteUrl })), resolveProject: vi.fn(async () => ({ id: uuid(1), repoUrl: remoteUrl })),
      configuration: async (workerId: string, signal: AbortSignal, operation?: Operation) => { if (operation !== undefined) getOperation ??= operation; return real.configuration(workerId, signal, operation); },
    });
    const running = start(f);
    await eventuallyWithoutAdvancingTime(() => expect(posts).toBe(1));
    await eventuallyWithoutAdvancingTime(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker_report_failed" })));
    await eventuallyWithoutAdvancingTime(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
    const coordinatorOptions = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
    // Startup configuration can trigger reconciliation before the periodic tick.
    // Keep both clocks fixed until the first stalled request is observed.
    coordinatorOptions.onInventory!(null);
    await eventuallyWithoutAdvancingTime(() => expect(requestSignal).toBeDefined());
    const firstRequestSignal = requestSignal!;
    expect(getOperation?.limits).toMatchObject({ totalMs: 15_000, requestMs: 10_000 });
    coordinatorOptions.onClaim!({ projectId: uuid(1), taskId: uuid(2), claimId: uuid(3) });
    await advanceTime(9_999); expect(firstRequestSignal.aborted).toBe(false);
    expect(reads).toBe(2); expect(posts).toBe(1);
    await advanceTime(1); expect(firstRequestSignal.aborted).toBe(true);
    await eventuallyWithoutAdvancingTime(() => expect(reads).toBe(3));
    expect(requestSignals[0]).toBe(firstRequestSignal); expect(requestSignals[1]!.aborted).toBe(false);
    await eventuallyWithoutAdvancingTime(() => expect(mocks.emit.mock.calls.filter(([event]) => event.kind === "worker_report_failed").map(([event]) => [event.message, event.error?.message, event.error?.cause?.message])).toContainEqual([expect.any(String), "http_request", "operation_request_timeout"]));
    expect(posts).toBe(1);
    f.signal.abort(); await running;
  });

  it("shares the total deadline across a completed reconciliation GET and stalled POST", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const f = await fixture();
    target = { ...target, value: { ...target.value, projects: [] } };
    const { createWorkerRemote } = await vi.importActual<typeof import("../../../src/commands/worker/remote.js")>("../../../src/commands/worker/remote.js");
    const real = createWorkerRemote({ serverUrl: "https://daynight.example", serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890" });
    const response = (body: unknown, version?: string) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Daynight-User-ID": uuid(6), ...(version === undefined ? {} : { "Daynight-Worker-Configuration": version }) } });
    const releaseRead = deferred<void>();
    let posts = 0, reads = 0, readStarted = false, reportSignal: AbortSignal | undefined, getOperation: Operation | undefined, postOperation: Operation | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/api/v1/me") return response({ id: uuid(6), email: null, emailVerified: null, name: null, avatarUrl: null, personalTeam: { id: uuid(7), kind: "personal", name: null } });
      if (pathname.endsWith("/configuration")) {
        if (++reads > 1) { readStarted = true; await releaseRead.promise; }
        return response({ desired: target, observationRevision: "0", observation: null }, "1");
      }
      if (pathname.endsWith("/report")) {
        if (++posts === 1) throw new Error("lost response");
        const currentSignal = options!.signal!;
        reportSignal ??= currentSignal;
        return new Promise<Response>((_resolve, reject) => currentSignal.addEventListener("abort", () => reject(currentSignal.reason), { once: true }));
      }
      throw new Error(`Unexpected request ${pathname}`);
    });
    mocks.remote.mockReturnValue({ ...real, project: vi.fn(async () => ({ id: uuid(1), repoUrl: remoteUrl })), resolveProject: vi.fn(async () => ({ id: uuid(1), repoUrl: remoteUrl })),
      configuration: async (workerId: string, signal: AbortSignal, operation?: Operation) => { if (operation !== undefined) getOperation ??= operation; return real.configuration(workerId, signal, operation); },
      reportConfiguration: async (...args: Parameters<typeof real.reportConfiguration>) => { if (posts !== 0) postOperation ??= args[3]; return real.reportConfiguration(...args); },
    });
    const running = start(f);
    await eventuallyWithoutAdvancingTime(() => expect(posts).toBe(1));
    await eventuallyWithoutAdvancingTime(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker_report_failed" })));
    await eventuallyWithoutAdvancingTime(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
    const coordinatorOptions = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
    // Startup may already have requested reconciliation; observe its GET before advancing time.
    coordinatorOptions.onInventory!(null);
    await eventuallyWithoutAdvancingTime(() => expect(readStarted).toBe(true));
    await vi.advanceTimersByTimeAsync(7_000); releaseRead.resolve();
    await eventuallyWithoutAdvancingTime(() => expect(reportSignal).toBeDefined());
    expect(postOperation).toBe(getOperation);
    await vi.advanceTimersByTimeAsync(7_000); expect(reportSignal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000); expect(reportSignal!.aborted).toBe(true);
    expect(reportSignal!.reason).toMatchObject({ kind: "deadline" });
    f.signal.abort(); await running;
  });

  it("hot-loads platform preference into the coordinator in both directions", async () => {
    const f = await fixture(), running = start(f);
    await eventually(() => expect(update.mock.calls.some(([configuration]) => configuration.preferPlatformSpecificTasks === false && configuration.repositories.length === 1)).toBe(true));
    update.mockClear();
    target = { ...target, revision: "2", value: { ...target.value, preferPlatformSpecificTasks: true } };
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(update.mock.calls.some(([configuration]) => configuration.preferPlatformSpecificTasks === true && configuration.repositories.length === 1)).toBe(true));
    update.mockClear();
    target = { ...target, revision: "3", value: { ...target.value, preferPlatformSpecificTasks: false } };
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(update.mock.calls.some(([configuration]) => configuration.preferPlatformSpecificTasks === false && configuration.repositories.length === 1)).toBe(true));
    f.signal.abort(); await running;
  });
  it("rechecks the cloud target after a locally oversized report", async () => {
    const f = await fixture(), remote = mocks.remote(); mocks.remote.mockClear();
    report.mockImplementationOnce(async () => { throw new ApiError({ operation: "worker.reportConfiguration" }, "prepare", { cause: new OperationError("request_limit") }); });
    const running = start(f);
    await eventually(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker_report_failed" })));
    expect(remote.configuration).toHaveBeenCalledOnce();
    target = { ...target, revision: "2", value: { ...target.value, maxConcurrent: 2 } };
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(remote.configuration).toHaveBeenCalledTimes(2));
    await eventually(() => expect(report.mock.calls.at(-1)![2].observation?.desiredRevision).toBe("2"));
    f.signal.abort(); await running;
  });
  it("reports effective local sources separately and restores cloud sources after restart", async () => {
    const f = await fixture();
    const writeConfiguration = (overrides: object) => writeFile(f.paths.configFile, stringify({ serverUrl: "https://daynight.example", serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", workerId: uuid(4), worker: { agentControlMode: "web", ...overrides } }));
    target = { ...target, value: { ...target.value, native: { agent: "codex", model: "cloud-model", args: ["--effort", "medium"] }, projects: [] } };
    await writeConfiguration({ agentModel: "local-model", agentReasoningEffort: "high" });
    const running = start(f);
    await eventually(() => expect(configurationTransitions().some(item => item.key.kind === "native" && item.state === "applied")).toBe(true));
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(report.mock.calls.some(([, body]) => body.runtimeConfiguration?.native?.model.value === "local-model")).toBe(true));
    const localReport = report.mock.calls.find(([, body]) => body.runtimeConfiguration?.native?.model.value === "local-model")!;
    expect(localReport[1].runtimeConfiguration!.native).toEqual({ agent: "codex", model: { value: "local-model", source: "local" }, reasoningEffort: { value: "high", source: "local" } });
    expect(localReport[2].observation!.items.find(item => item.key.kind === "native")!.appliedValue).toEqual(target.value.native);
    f.signal.abort(); await running;
    await writeConfiguration({});
    report.mockClear(); mocks.emit.mockClear();
    const restart = { ...f, signal: new AbortController() };
    const restarted = start(restart);
    await eventually(() => expect(configurationTransitions().some(item => item.key.kind === "native" && item.state === "applied")).toBe(true));
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(report.mock.calls.some(([, body]) => body.runtimeConfiguration?.native?.model.source === "cloud")).toBe(true));
    const restored = report.mock.calls.find(([, body]) => body.runtimeConfiguration?.native?.model.source === "cloud")![1];
    expect(restored.runtimeConfiguration!.native).toEqual({ agent: "codex", model: { value: "cloud-model", source: "cloud" }, reasoningEffort: { value: "medium", source: "cloud" } });
    restart.signal.abort(); await restarted;
  });

  it("normalizes new execution settings and source reports with the applied cloud mode", async () => {
    const f = await fixture();
    await writeFile(f.paths.configFile, stringify({ serverUrl: "https://daynight.example", serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", workerId: uuid(4), worker: { agentControlMode: "herdr", agentReasoningEffort: "high" } }));
    target = { ...target, value: { ...target.value, agentControlMode: "web", native: { agent: "codex", model: "cloud-model", args: ["--effort", "medium"] }, projects: [] } };
    const running = start(f);
    await eventually(() => expect(update.mock.calls.some(([configuration]) => configuration.globalConfiguration?.agentControlMode === "web")).toBe(true));
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(report.mock.calls.some(([, body]) => body.runtimeConfiguration?.native?.reasoningEffort.value === "high")).toBe(true));
    const web = update.mock.calls.find(([configuration]) => configuration.globalConfiguration?.agentControlMode === "web")![0];
    expect(web.globalConfiguration).toMatchObject({ args: ["--effort", "high"] });
    target = { ...target, revision: "2", value: { ...target.value, agentControlMode: "herdr", native: { ...target.value.native, args: [] } } };
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(update.mock.calls.some(([configuration]) => configuration.globalConfiguration?.agentControlMode === "herdr")).toBe(true));
    const herdr = update.mock.calls.find(([configuration]) => configuration.globalConfiguration?.agentControlMode === "herdr")![0];
    expect(herdr.globalConfiguration).toMatchObject({ args: ["-c", "model_reasoning_effort=\"high\""] });
    expect(report.mock.calls.at(-1)![2].controlModeBootstrap).toBe("herdr");
    f.signal.abort(); await running;
  });

  it("keeps the applied Herdr configuration when its native arguments cannot run in Web mode", async () => {
    const f = await fixture();
    target = { ...target, value: { ...target.value, agentControlMode: "herdr", native: { agent: "codex", model: null, args: ["--search"] }, projects: [] } };
    const running = start(f);
    await eventually(() => expect(update.mock.calls.some(([configuration]) => configuration.globalConfiguration?.agentControlMode === "herdr")).toBe(true));
    target = { ...target, revision: "2", value: { ...target.value, agentControlMode: "web" } };
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(configurationTransitions().some(item => item.key.kind === "agentControlMode" && item.state === "error")).toBe(true));
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(report.mock.calls.some(([, , configuration]) => configuration.observation?.items.some(item => item.key.kind === "agentControlMode" && item.state === "error" && item.appliedValue === "herdr"))).toBe(true));
    expect(update.mock.calls.every(([configuration]) => configuration.globalConfiguration === null || configuration.globalConfiguration.agentControlMode === "herdr")).toBe(true);
    expect(update.mock.calls.at(-1)![0].globalConfiguration.args).toEqual(["--search"]);
    f.signal.abort(); await running;
  });

  it.each(["checkpoint", "io-retry", "stale-generation"] as const)("reconciles an imported target after a lost bootstrap receipt before capturing another report (%s)", async scenario => {
    const f = await fixture(), order: string[] = [], secondEntered = deferred<void>(), releaseSecond = deferred<void>(), thirdEntered = deferred<void>(), releaseThird = deferred<void>(), fourthEntered = deferred<void>(), releaseFourth = deferred<void>(), releaseLaterGet = deferred<void>(), releaseCheckpoint = deferred<void>();
    if (scenario === "io-retry") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    target = { ...target, revision: "2", value: { ...target.value, maxConcurrent: 4, native: { ...target.value.native, model: "cloud-after-lost-receipt" } } };
    const remote = mocks.remote(); mocks.remote.mockClear();
    const files = await vi.importActual<typeof import("../../../src/platform/files.js")>("../../../src/platform/files.js");
    let imported = false, remoteRevision = 5, fourthReceipt: WorkerCloudReportReceipt | undefined;
    let checkpoint: { text: string; generation: string; state: "preparing" | "blocked" | "started" | "completed" | "error"; error?: unknown } | undefined;
    const checkpointAttempts: string[] = [];
    const ioFailure = Object.assign(new Error("Fourth ACK checkpoint is temporarily unavailable."), { code: "EBUSY", syscall: "open" });
    mocks.cachePersist.mockImplementation(async (file: string, chunks: Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>, mode?: number) => {
      if (file !== f.paths.configurationFile) return files.replaceFileAtomicallyFromChunks(file, chunks, mode);
      const pieces: string[] = [];
      for await (const piece of chunks) { if (typeof piece !== "string") throw new TypeError("The cache codec must produce string chunks."); pieces.push(piece); }
      const text = pieces.join(""), cache = JSON.parse(text) as { authority: { observationRevision: string; generation: string } };
      if (cache.authority.observationRevision !== "8" || checkpoint?.state === "completed") return files.replaceFileAtomicallyFromChunks(file, [text], mode);
      checkpointAttempts.push(text);
      checkpoint ??= { text, generation: cache.authority.generation, state: "preparing" };
      const attempt = checkpoint;
      if (scenario === "io-retry" && checkpointAttempts.length === 1) { attempt.state = "blocked"; attempt.error = ioFailure; throw ioFailure; }
      attempt.state = "preparing";
      try {
        await files.replaceFileAtomicallyFromChunks(file, (async function* () { yield text; attempt.state = "started"; await releaseCheckpoint.promise; })(), mode);
        attempt.state = "completed";
      } catch (error) { attempt.state = "error"; attempt.error = error; throw error; }
    });
    remote.configuration.mockImplementation(async () => {
      order.push("GET");
      if (!imported) return { desired: null, observationRevision: "0", observation: null };
      if (report.mock.calls.length >= 4) await releaseLaterGet.promise;
      return { desired: target, observationRevision: String(remoteRevision), observation: { baseRevision: String(remoteRevision - 1), desiredRevision: "2", items: [], reportedAt: workerTelemetryTime } };
    });
    report.mockImplementation(async (_workerId, _body, configuration) => {
      order.push("POST");
      if (!imported) {
        imported = true;
        throw new ApiError({ operation: "worker.reportConfiguration" }, "request", { cause: new Error("Bootstrap receipt lost."), outcomeUnconfirmed: true });
      }
      if (report.mock.calls.length === 2) { secondEntered.resolve(); await releaseSecond.promise; }
      if (report.mock.calls.length === 3) { thirdEntered.resolve(); await releaseThird.promise; }
      if (report.mock.calls.length === 4) { fourthEntered.resolve(); await releaseFourth.promise; }
      const observationAccepted = configuration.observation?.baseRevision === String(remoteRevision);
      if (observationAccepted) remoteRevision++;
      const receipt = { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: target, observationRevision: String(remoteRevision), observationAccepted } };
      if (report.mock.calls.length === 4) fourthReceipt = receipt;
      return receipt;
    });
    const running = start(f);
    try {
      await eventually(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker_report_failed" })));
      await vi.advanceTimersByTimeAsync(30_000);
      await secondEntered.promise;
      expect(order).toEqual(["GET", "GET", "POST", "GET", "POST"]);
      expect(report.mock.calls[0]![2].bootstrap!.maxConcurrent).toBe(9);
      expect(report.mock.calls[0]![2].observation).toBeNull();
      expect(report.mock.calls[1]![2].bootstrap).toBeNull();
      expect(report.mock.calls[1]![2].observation).toMatchObject({ baseRevision: "5", desiredRevision: "2" });
      expect(report.mock.calls[1]![2].observation!.items).toEqual(expect.arrayContaining([expect.objectContaining({ key: { kind: "maxConcurrent" }, targetRevision: "2" })]));
      expect(report.mock.calls[1]![2].observation!.items.every(item => item.targetRevision === "2")).toBe(true);
      await eventuallyWithoutAdvancingTime(() => {
        expect(update).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrent: 4, readyProjectIds: [uuid(1)], globalConfiguration: expect.objectContaining({ model: "cloud-after-lost-receipt" }) }));
        expect(configurationTransitions()).toEqual(expect.arrayContaining([
          expect.objectContaining({ key: { kind: "native" }, targetRevision: "2", state: "applied" }),
          expect.objectContaining({ key: { kind: "projectNative", projectId: uuid(1) }, targetRevision: "2", state: "applied" }),
          expect.objectContaining({ key: { kind: "projectPreparation", projectId: uuid(1) }, targetRevision: "2", state: "applied" }),
        ]));
      });
      const options = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
      options.onInventory!(null);
      expect(order).toEqual(["GET", "GET", "POST", "GET", "POST"]);
      releaseSecond.resolve();
      await thirdEntered.promise;
      expect(order).toEqual(["GET", "GET", "POST", "GET", "POST", "GET", "POST"]);
      expect(report.mock.calls[2]![1].taskInventory).toBeNull();
      expect(report.mock.calls[2]![2].observation).toMatchObject({ baseRevision: "6", desiredRevision: "2" });
      expect(report.mock.calls[2]![2].bootstrap).toBeNull();
      options.onInventory!(null);
      expect(order).toEqual(["GET", "GET", "POST", "GET", "POST", "GET", "POST"]);
      releaseThird.resolve();
      await fourthEntered.promise;
      expect(order).toEqual(["GET", "GET", "POST", "GET", "POST", "GET", "POST", "GET", "POST"]);
      expect(report.mock.calls[3]![1].taskInventory).toBeNull();
      expect(report.mock.calls[3]![2].observation).toMatchObject({ baseRevision: "7", desiredRevision: "2" });
      expect(report.mock.calls[3]![2].bootstrap).toBeNull();
      const sends = (mocks.exchangeStage.mock.calls.map(([event]) => event) as WorkerConfigurationExchangeEvent[]).filter(event => event.phase === "report-send" && event.status === "started");
      expect(sends).toHaveLength(4);
      const fourth = sends[3]!;
      const manager = mocks.createdConfiguration.mock.calls[0]![0] as WorkerConfigurationManager;
      expect(fourth.source).toMatchObject({ generation: manager.current().generation, desiredRevision: "2", observationRevision: "7" });
      expect(fourth.report).toMatchObject({ reportId: expect.any(String), generation: fourth.source!.generation, baseRevision: "7" });
      if (scenario === "stale-generation") {
        await manager.receive(target, "7");
        expect(manager.current().generation).not.toBe(fourth.source!.generation);
      }
      releaseFourth.resolve();
      await eventuallyWithoutAdvancingTime(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker_report_recovered" })));
      const stages = () => (mocks.exchangeStage.mock.calls.map(([event]) => event) as WorkerConfigurationExchangeEvent[]).filter(event => event.syncId === fourth.syncId);
      const evidence = () => JSON.stringify({ scenario, order, syncId: fourth.syncId, captured: fourth.source, current: { generation: manager.current().generation, observationRevision: manager.current().observationRevision }, receipt: fourthReceipt?.configuration, stages: stages(), checkpoint: checkpoint === undefined ? null : { generation: checkpoint.generation, state: checkpoint.state, error: String(checkpoint.error ?? "") }, attempts: checkpointAttempts.length });
      if (scenario === "stale-generation") {
        await eventuallyWithoutAdvancingTime(() => expect({ receipt: fourthReceipt?.configuration, stages: stages() }, evidence()).toMatchObject({ receipt: { observationRevision: "8", observationAccepted: true }, stages: expect.arrayContaining([expect.objectContaining({ phase: "receipt-accept", status: "succeeded", remoteOutcome: "success", localOutcome: "ignored", source: fourth.source, report: fourth.report })]) }));
        expect(mocks.emit, evidence()).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker-configuration-stage", configuration: expect.objectContaining({ phase: "receipt-accept", status: "succeeded", syncId: fourth.syncId, reportId: fourth.report!.reportId, remote: "confirmed", local: "ignored", observationAccepted: true, received: { desiredRevision: "2", observationRevision: "8" } }) }));
        const cache = JSON.parse(await readFile(f.paths.configurationFile, "utf8")) as { authority: { generation: string; observationRevision: string } };
        expect(cache.authority).toMatchObject({ generation: manager.current().generation, observationRevision: "7" });
        expect(cache.authority.generation).not.toBe(fourth.source!.generation);
        expect(checkpointAttempts).toEqual([]);
        expect(report).toHaveBeenCalledTimes(4);
        releaseLaterGet.resolve(); f.signal.abort(); await running;
        expect(report.mock.calls.slice(1).every(([, , configuration]) => configuration.bootstrap === null)).toBe(true);
        return;
      }
      if (scenario === "io-retry") {
        await eventuallyWithoutAdvancingTime(() => {
          expect({ receipt: fourthReceipt?.configuration, checkpoint }, evidence()).toMatchObject({ receipt: { observationRevision: "8", observationAccepted: true }, checkpoint: { state: "blocked", error: ioFailure } });
          expect(mocks.emit, evidence()).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker-configuration-storage-blocked", configuration: expect.objectContaining({ phase: "cache-persist", storagePhase: "persist", syncId: fourth.syncId, reportId: fourth.report!.reportId, remote: "confirmed", local: "pending", reason: "io_error", details: expect.objectContaining({ systemCode: "EBUSY" }) }) }));
        });
        expect((JSON.parse(await readFile(f.paths.configurationFile, "utf8")) as { authority: { observationRevision: string } }).authority.observationRevision).toBe("7");
        expect(stages().some(event => event.phase === "receipt-accept" && event.status === "succeeded")).toBe(false);
        await vi.advanceTimersByTimeAsync(5_000);
      }
      await eventuallyWithoutAdvancingTime(() => expect({ receipt: fourthReceipt?.configuration, checkpoint }, evidence()).toMatchObject({ receipt: { observationRevision: "8", observationAccepted: true }, checkpoint: { state: "started" } }));
      expect(stages()).toContainEqual(expect.objectContaining({ phase: "receipt-accept", status: "started", remoteOutcome: "success", localOutcome: "pending", source: fourth.source, report: fourth.report, observationAccepted: true, received: { desiredRevision: "2", observationRevision: "8" } }));
      expect(stages().some(event => event.phase === "receipt-accept" && event.status === "succeeded")).toBe(false);
      expect(manager.current().generation).toBe(fourth.source!.generation);
      expect((JSON.parse(await readFile(f.paths.configurationFile, "utf8")) as { authority: { observationRevision: string } }).authority.observationRevision).toBe("7");
      releaseCheckpoint.resolve();
      await eventuallyWithoutAdvancingTime(() => {
        expect({ checkpoint, stages: stages() }, evidence()).toMatchObject({ checkpoint: { state: "completed" }, stages: expect.arrayContaining([expect.objectContaining({ phase: "receipt-accept", status: "succeeded", remoteOutcome: "success", localOutcome: "persisted", source: fourth.source, report: fourth.report })]) });
      });
      expect(mocks.emit, evidence()).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker-configuration-stage", configuration: expect.objectContaining({ phase: "receipt-accept", status: "succeeded", syncId: fourth.syncId, reportId: fourth.report!.reportId, remote: "confirmed", local: "persisted", observationAccepted: true, received: { desiredRevision: "2", observationRevision: "8" } }) }));
      expect(checkpoint!.generation).not.toBe(fourth.source!.generation);
      expect(manager.current().generation).toBe(checkpoint!.generation);
      expect(checkpointAttempts).toEqual(scenario === "io-retry" ? [checkpoint!.text, checkpoint!.text] : [checkpoint!.text]);
      expect(await readFile(f.paths.configurationFile, "utf8")).toBe(checkpoint!.text);
      await eventually(async () => {
        const cache = JSON.parse(await readFile(f.paths.configurationFile, "utf8"));
        expect(BigInt(cache.authority.observationRevision)).toBeGreaterThanOrEqual(8n);
        expect(cache.authority.observationRevision).toBe("8");
      });
      expect(report).toHaveBeenCalledTimes(4);
      releaseLaterGet.resolve();
      f.signal.abort(); await running;
      expect(report.mock.calls.slice(1).every(([, , configuration]) => configuration.bootstrap === null)).toBe(true);
    } finally {
      releaseSecond.resolve(); releaseThird.resolve(); releaseFourth.resolve(); releaseLaterGet.resolve(); releaseCheckpoint.resolve(); f.signal.abort();
      if (scenario === "io-retry") await vi.advanceTimersByTimeAsync(5_000);
      await Promise.allSettled([running]);
    }
  });

  it("captures a fresh bootstrap after an unknown report is confirmed not to have created the Worker", async () => {
    const f = await fixture(), order: string[] = [], secondEntered = deferred<void>(), releaseSecond = deferred<void>();
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockImplementation(async () => {
      order.push("GET");
      throw new ApiError({ operation: "worker.configuration" }, "response", { cause: new Error("Worker missing."), status: 404, serverError: { code: "not_found", message: "Worker missing.", requestId: "missing-worker" } });
    });
    collect.mockResolvedValueOnce({ telemetry: workerTelemetry, issues: [] });
    collect.mockResolvedValue({ telemetry: { ...workerTelemetry, sampledAt: "2026-10-29T00:00:30.000Z" }, issues: [] });
    let reports = 0, imported: WorkerCloudDesired | undefined;
    report.mockImplementation(async (_workerId, _body, configuration) => {
      order.push("POST"); reports++;
      if (reports === 1) throw new ApiError({ operation: "worker.reportConfiguration" }, "request", { cause: new Error("Report outcome unknown."), outcomeUnconfirmed: true });
      if (reports === 2) { imported = { ...target, value: configuration.bootstrap! }; secondEntered.resolve(); await releaseSecond.promise; }
      return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: imported!, observationRevision: "0", observationAccepted: false } };
    });
    const running = start(f);
    await eventually(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker_report_failed" })));
    expect(report).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    await secondEntered.promise;
    expect(report).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["GET", "GET", "POST", "GET", "POST"]);
    expect(report.mock.calls[0]![1].sampledAt).toBe(workerTelemetryTime);
    expect(report.mock.calls[1]![1].sampledAt).toBe("2026-10-29T00:00:30.000Z");
    for (const [, , configuration] of report.mock.calls) { expect(configuration.bootstrap!.maxConcurrent).toBe(9); expect(configuration.observation).toBeNull(); }
    expect(report.mock.calls[1]![2]).not.toBe(report.mock.calls[0]![2]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(report).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["GET", "GET", "POST", "GET", "POST"]);
    releaseSecond.resolve();
    await eventually(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker_report_recovered" })));
    f.signal.abort(); await running;
  });

  it.each([60_000, 5_000])("backfills completed sessions fairly using the applied cloud polling interval %s", async pollIntervalMs => {
    const f = await fixture();
    target = { ...target, value: { ...target.value, pollIntervalMs } };
    let now = Date.parse(workerTelemetryTime), rounds = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const labels = new Map([[uuid(11), "broken"], [uuid(12), "second"], [uuid(13), "third"]]);
    mocks.completed.mockReturnValue([...labels.keys()].map(executionId => ({ serverOrigin: "https://daynight.example", webExecution: { executionId, launchId: executionId, sessionId: executionId, launchSubmission: "submitted" } })));
    mocks.ticket.mockImplementation(async (_home, launchId) => ({ serverOrigin: "https://daynight.example", executionId: launchId, sessionId: launchId }));
    const attempts: { label: string; at: number; round: number }[] = [];
    mocks.archive.mockImplementation(async ({ ticket }) => { attempts.push({ label: labels.get(ticket.executionId)!, at: now, round: rounds }); if (ticket.executionId === uuid(11)) throw new Error("Original archive source is missing."); return { state: "ready" }; });
    const appliedDelays: number[] = [];
    const nativeTimer = await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises");
    mocks.delay.mockImplementation(async (milliseconds, _value, options) => {
      await nativeTimer.setTimeout(0, undefined, options);
      if (mocks.coordinator.mock.calls.length !== 0) { now += milliseconds; appliedDelays.push(milliseconds); }
    });
    mocks.coordinator.mockImplementation(() => ({ tick: async () => { rounds++; if (appliedDelays.length === 4) f.signal.abort(); }, archiveYield: () => false, updateConfiguration: update, shutdown }));
    await start(f);
    expect(attempts.slice(0, 3).map(attempt => attempt.label)).toEqual(["broken", "second", "third"]);
    const retryTimes = attempts.filter(attempt => attempt.label === "broken").map(attempt => attempt.at);
    if (pollIntervalMs === 60_000) expect(retryTimes.length).toBeGreaterThanOrEqual(2);
    else expect(retryTimes).toHaveLength(1);
    for (let index = 1; index < retryTimes.length; index++) expect(retryTimes[index]! - retryTimes[index - 1]!).toBeGreaterThanOrEqual(60_000);
    for (let round = 1; round <= rounds; round++) expect(attempts.filter(attempt => attempt.round === round).length).toBeLessThanOrEqual(1);
    expect(appliedDelays).toEqual([pollIntervalMs, pollIntervalMs, pollIntervalMs, pollIntervalMs]);
    expect(mocks.emit.mock.calls.filter(([event]) => event.kind === "session-archive-ready")).toHaveLength(2);
    expect(mocks.emit.mock.calls.filter(([event]) => event.kind === "session-archive-retry")).toHaveLength(retryTimes.length);
  });

  it("keeps cloud reports independent of slow repository preparation and blocked reconciliation", async () => {
    const f = await fixture(), prepared = deferred<void>(); prepare.mockImplementation(() => prepared.promise);
    const running = start(f);
    await eventually(() => expect(prepare).toHaveBeenCalledOnce());
    await eventually(() => expect(report).toHaveBeenCalled());
    const before = report.mock.calls.length;
    expect(report.mock.calls[0]![0]).toBe(uuid(4)); expect(report.mock.calls[0]![1].taskInventory).toBeNull();
    expect(mocks.telemetry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ paths: f.paths, homeDirectory: f.homeDirectory, version: "9.8.7", workingDirectory: f.workingDirectory, workerId: uuid(4), serverOrigin: "https://daynight.example" }));
    await vi.advanceTimersByTimeAsync(30_000); await eventually(() => expect(report.mock.calls.length).toBeGreaterThan(before));
    await eventually(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
    const options = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
    const coordinator = mocks.coordinator.mock.results[0]!.value;
    expect(options).toMatchObject({ repositories: [], readyProjectIds: [] });
    await eventually(() => expect(coordinator.tick).toHaveBeenCalledOnce());
    expect(update.mock.calls.every(([view]) => view.repositories.length === 0 && view.readyProjectIds.length === 0)).toBe(true);
    prepared.resolve();
    await eventually(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ readyProjectIds: [uuid(1)] })));
    const inReconciliation = report.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000); await eventually(() => expect(report.mock.calls.length).toBeGreaterThan(inReconciliation));
    expect(coordinator.tick).toHaveBeenCalledOnce(); expect(shutdown).not.toHaveBeenCalled();
    options.onInventory!({ observedAt: workerTelemetryTime, claims: [] });
    await eventually(() => expect(report.mock.calls.at(-1)![1].taskInventory).toEqual({ observedAt: workerTelemetryTime, claims: [] }));
    const claim = { projectId: uuid(1), taskId: uuid(2), claimId: uuid(3) }; options.onClaim!(claim);
    await eventually(() => expect(report.mock.calls.at(-1)![1].taskInventory).toEqual({ observedAt: workerTelemetryTime, claims: [claim] }));
    expect(mocks.herdr).not.toHaveBeenCalled();
    f.signal.abort(); await running;
    const stoppedCount = report.mock.calls.length; await vi.advanceTimersByTimeAsync(60_000); expect(report).toHaveBeenCalledTimes(stoppedCount);
  });

  it("publishes a newer cloud configuration into the same coordinator while its tick is blocked", async () => {
    const f = await fixture(); const running = start(f);
    await eventually(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
    const original = mocks.coordinator.mock.results[0]!.value;
    target = { revision: "2", updatedAt: workerTelemetryTime, value: { ...target.value, maxConcurrent: 3, pollIntervalMs: 1000, recoveryLimit: 8, preferPlatformSpecificTasks: false, native: { agent: "codex", model: "new-model", args: [] } } };
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrent: 3, globalConfiguration: expect.objectContaining({ model: "new-model", recoveryLimit: 8 }) })));
    expect(mocks.coordinator).toHaveBeenCalledOnce(); expect(original.tick).toHaveBeenCalledOnce(); expect(shutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(report.mock.calls.at(-1)![2].observation!.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { kind: "maxConcurrent" }, targetRevision: "2", appliedValue: 3, state: "applied" }),
      expect.objectContaining({ key: { kind: "native" }, targetRevision: "2", appliedValue: { agent: "codex", model: "new-model", args: [] }, state: "applied" }),
    ])));
    f.signal.abort(); await running;
  });

  it("excludes a removed project before stopping it and reports stop failures while heartbeats continue", async () => {
    const f = await fixture(), stopping = deferred<void>();
    const stopProject = vi.fn(async () => { await stopping.promise; throw new Error("private stop output"); });
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => ({
      tick: vi.fn(async () => { if (!options.signal!.aborted) await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), { once: true })); }),
      archiveYield: () => false, updateConfiguration: update, stopProject, shutdown,
    }));
    const running = start(f);
    await eventually(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ readyProjectIds: [uuid(1)] })));
    target = { ...target, revision: "2", value: { ...target.value, projects: [] } };
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(stopProject).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ targetProjectIds: [], readyProjectIds: [] }));
    const before = report.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(report.mock.calls.length).toBeGreaterThan(before));
    stopping.resolve();
    await eventually(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(report.mock.calls.at(-1)![2].observation!.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: { kind: "projectRemoval", projectId: uuid(1) }, targetRevision: "2", state: "error" }),
      ]));
    });
    expect(JSON.stringify(report.mock.calls.at(-1)![2])).not.toContain("private stop output");
    f.signal.abort(); await running;
  });

  it("retains an unprepared local mapping while another project becomes ready", async () => {
    const f = await fixture(), secondRemote = "https://git.example/team/healthy.git";
    target = { ...target, value: { ...target.value, projects: [{ projectId: uuid(1), nativeOverrides: {} }, { projectId: uuid(2), nativeOverrides: {} }] } };
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.project.mockImplementation(async (id: string) => ({ id, repoUrl: id === uuid(1) ? remoteUrl : secondRemote }));
    prepare.mockImplementation(async (binding: { projectId: string }) => { if (binding.projectId === uuid(1)) throw new Error("clone failed"); });
    const running = start(f);
    await eventually(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ readyProjectIds: [uuid(2)] })));
    const options = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
    expect(options.store.getProject({ projectId: uuid(1) })).toMatchObject({ localPath: path.join(f.homeDirectory, "repo") });
    expect(options.store.getProject({ projectId: uuid(2) })).not.toBeNull();
    await eventually(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(report.mock.calls.at(-1)![2].observation!.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: { kind: "projectPreparation", projectId: uuid(1) }, state: "error" }),
        expect.objectContaining({ key: { kind: "projectPreparation", projectId: uuid(2) }, state: "applied" }),
      ]));
    });
    f.signal.abort(); await running;
  });

  it("reserves overlapping paths during slow preparation without blocking an unrelated project", async () => {
    const f = await fixture(), slow = deferred<void>();
    const remotes = [remoteUrl, "https://git.example/team/nested.git", "https://git.example/team/healthy.git"];
    const locations = [path.join(f.homeDirectory, "repo"), path.join(f.homeDirectory, "repo", "nested"), path.join(f.homeDirectory, "healthy")];
    await writeFile(f.paths.configFile, stringify({ serverUrl: "https://daynight.example", serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", workerId: uuid(4), worker: { repositories: remotes.map((remote, index) => ({ projectId: uuid(index + 1), remote, path: locations[index] })) } }));
    await mkdir(f.paths.workerDirectory, { recursive: true });
    const retained = openWorkerStore(f.paths.databaseFile);
    try { retained.registerProject({ projectId: uuid(1), repoUrl: remotes[0]!, localPath: locations[0]! }); }
    finally { retained.close(); }
    target = { ...target, value: { ...target.value, projects: remotes.map((_, index) => ({ projectId: uuid(index + 1), nativeOverrides: {} })) } };
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.project.mockImplementation(async (id: string) => ({ id, repoUrl: remotes[[uuid(1), uuid(2), uuid(3)].indexOf(id)] }));
    prepare.mockImplementation(async (binding: { projectId: string }) => { if (binding.projectId === uuid(1)) await slow.promise; });
    const running = start(f);
    await eventually(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ readyProjectIds: [uuid(3)] })));
    expect(prepare.mock.calls.map(([binding]) => binding.projectId)).toEqual(expect.arrayContaining([uuid(1), uuid(3)]));
    expect(prepare.mock.calls.map(([binding]) => binding.projectId)).not.toContain(uuid(2));
    const options = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
    expect(options.store.getProject({ projectId: uuid(1) })).toMatchObject({ localPath: locations[0] });
    expect(options.store.getProject({ projectId: uuid(2) })).toBeNull();
    slow.resolve();
    await eventually(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ readyProjectIds: [uuid(1), uuid(3)] })));
    f.signal.abort(); await running;
  });

  it("wakes an existing long polling wait when readiness or the applied interval changes", async () => {
    const f = await fixture(), prepared = deferred<void>();
    const longInterval = 60_000;
    target = { ...target, value: { ...target.value, pollIntervalMs: longInterval } };
    prepare.mockImplementation(() => prepared.promise);
    const tick = vi.fn(async () => {});
    mocks.coordinator.mockImplementation(() => ({ tick, archiveYield: () => false, updateConfiguration: update, shutdown }));
    const waitingSignal = (): AbortSignal | undefined => mocks.delay.mock.calls.filter(([milliseconds]) => milliseconds === longInterval).at(-1)?.[2]?.signal;
    const running = start(f);
    await eventually(() => expect(prepare).toHaveBeenCalledOnce());
    await eventually(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(report.mock.calls.at(-1)![2].observation!.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: { kind: "native" }, state: "applied" }),
        expect.objectContaining({ key: { kind: "projectNative", projectId: uuid(1) }, state: "applied" }),
      ]));
      expect(waitingSignal()).toBeDefined(); expect(waitingSignal()!.aborted).toBe(false);
    });
    const preparationWait = waitingSignal()!;
    if (mocks.coordinator.mock.calls.length > 0) expect(mocks.coordinator.mock.calls[0]![0]).toMatchObject({ repositories: [], readyProjectIds: [] });
    prepared.resolve();
    await eventually(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
    await eventually(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ readyProjectIds: [uuid(1)] })));
    expect(preparationWait.aborted).toBe(true);
    await eventually(() => { expect(tick).toHaveBeenCalled(); expect(waitingSignal()).not.toBe(preparationWait); expect(waitingSignal()!.aborted).toBe(false); });
    const previousWait = waitingSignal()!, ticksBeforeAcknowledgment = tick.mock.calls.length, updatesBeforeAcknowledgment = update.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(update.mock.calls.length).toBeGreaterThan(updatesBeforeAcknowledgment));
    expect(previousWait.aborted).toBe(false); expect(tick).toHaveBeenCalledTimes(ticksBeforeAcknowledgment);
    target = { ...target, revision: "2", value: { ...target.value, pollIntervalMs: 1000 } };
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => { expect(previousWait.aborted).toBe(true); expect(tick.mock.calls.length).toBeGreaterThan(ticksBeforeAcknowledgment); expect(mocks.delay.mock.calls.some(([milliseconds]) => milliseconds === 1000)).toBe(true); });
    f.signal.abort(); await running;
  });

  it("keeps heartbeats alive through task backend initialization failure", async () => {
    const f = await fixture();
    const failure = new Error("Task backend state unavailable."); mocks.webOpen.mockImplementation(() => { throw failure; });
    const running = start(f);
    await eventually(() => expect(mocks.webOpen).toHaveBeenCalled());
    await eventually(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ error: failure })));
    const before = report.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(report.mock.calls.length).toBeGreaterThan(before));
    expect(mocks.coordinator).not.toHaveBeenCalled();
    f.signal.abort(); await running;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("reports an unavailable native tuple while independent scalar settings remain applied", async () => {
    const f = await fixture();
    target = { ...target, value: { ...target.value, maxConcurrent: 4, pollIntervalMs: 1000, recoveryLimit: 8 } };
    mocks.probe.mockRejectedValue(new Error("private-native-probe-output"));
    const running = start(f);
    await eventually(() => expect(configurationTransitions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { kind: "maxConcurrent" }, state: "applied" }),
      expect.objectContaining({ key: { kind: "pollIntervalMs" }, state: "applied" }),
      expect.objectContaining({ key: { kind: "recoveryLimit" }, state: "applied" }),
      expect.objectContaining({ key: { kind: "native" }, state: "error" }),
      expect.objectContaining({ key: { kind: "projectNative", projectId: uuid(1) }, state: "error" }),
    ])));
    const before = report.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => {
      expect(report.mock.calls.length).toBeGreaterThan(before);
      expect(report.mock.calls.at(-1)![2].observation!.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: { kind: "maxConcurrent" }, appliedValue: 4, state: "applied" }),
        expect.objectContaining({ key: { kind: "pollIntervalMs" }, appliedValue: 1000, state: "applied" }),
        expect.objectContaining({ key: { kind: "recoveryLimit" }, appliedValue: 8, state: "applied" }),
        expect.objectContaining({ key: { kind: "native" }, appliedValue: null, state: "error", error: expect.any(Object), lastFailure: expect.any(Object) }),
        expect.objectContaining({ key: { kind: "projectNative", projectId: uuid(1) }, appliedValue: null, state: "error", error: expect.any(Object), lastFailure: expect.any(Object) }),
      ]));
    });
    expect(JSON.stringify(report.mock.calls.map(([, , configuration]) => configuration))).not.toContain("private-native-probe-output");
    expect(JSON.stringify(configurationTransitions())).not.toContain("private-native-probe-output");
    await eventually(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
    expect(mocks.coordinator.mock.calls[0]![0]).toMatchObject({ globalConfiguration: null, repositories: [], maxConcurrent: 4 });
    await eventually(() => expect(mocks.coordinator.mock.results[0]!.value.tick).toHaveBeenCalledOnce());
    f.signal.abort(); await running;
  });

  it("applies a recovered native tuple on its scheduled retry through the existing coordinator", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    const f = await fixture();
    target = { ...target, value: { ...target.value, maxConcurrent: 4, recoveryLimit: 8, preferPlatformSpecificTasks: false, native: { ...target.value.native, model: "recovered-model" } } };
    mocks.probe.mockRejectedValue(new Error("private-native-probe-output"));
    const running = start(f);
    await eventuallyWithoutAdvancingTime(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
    await eventuallyWithoutAdvancingTime(() => expect(configurationTransitions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { kind: "native" }, state: "error" }),
      expect.objectContaining({ key: { kind: "projectNative", projectId: uuid(1) }, state: "error" }),
    ])));
    const coordinator = mocks.coordinator.mock.results[0]!.value;
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ globalConfiguration: null, repositories: [], maxConcurrent: 4 }));
    const failedNative = configurationTransitions().filter(event => (event.key.kind === "native" || event.key.kind === "projectNative") && event.state === "error");
    const retryAt = Math.min(...failedNative.map(event => Date.parse(event.error.occurredAt) + 5_000));
    const attempts = mocks.probe.mock.calls.length;
    mocks.probe.mockResolvedValue("0.164.0");
    await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1);
    expect(mocks.probe).toHaveBeenCalledTimes(attempts);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ globalConfiguration: null, repositories: [], maxConcurrent: 4 }));
    await vi.advanceTimersByTimeAsync(1);
    await eventuallyWithoutAdvancingTime(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({
      maxConcurrent: 4,
      globalConfiguration: expect.objectContaining({ agent: "codex", model: "recovered-model", args: [], recoveryLimit: 8 }),
      repositories: [expect.objectContaining({ configuration: expect.objectContaining({ agent: "codex", model: "recovered-model", args: [], recoveryLimit: 8 }) })],
    })));
    expect(mocks.probe).toHaveBeenCalledTimes(attempts + 2);
    expect(mocks.coordinator).toHaveBeenCalledOnce();
    expect(mocks.coordinator.mock.results[0]!.value).toBe(coordinator);
    expect(shutdown).not.toHaveBeenCalled();
    const reportsBeforeRecovery = report.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await eventuallyWithoutAdvancingTime(() => {
      expect(report.mock.calls.length).toBeGreaterThan(reportsBeforeRecovery);
      expect(report.mock.calls.at(-1)![2].observation!.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: { kind: "maxConcurrent" }, appliedValue: 4, state: "applied" }),
        expect.objectContaining({ key: { kind: "recoveryLimit" }, appliedValue: 8, state: "applied" }),
        expect.objectContaining({ key: { kind: "native" }, targetRevision: "1", appliedValue: target.value.native, state: "applied", error: null }),
        expect.objectContaining({ key: { kind: "projectNative", projectId: uuid(1) }, targetRevision: "1", appliedValue: target.value.native, state: "applied", error: null }),
      ]));
    });
    f.signal.abort(); await running;
  });

  it("joins the aborted in-flight configuration report before coordinator and backend teardown", async () => {
    const f = await fixture(), joined = deferred<void>(), cancelled = deferred<void>(), order: string[] = [];
    report.mockImplementation(async (_workerId, _body, _configuration, operation) => {
      operation.signal.addEventListener("abort", () => { order.push("report-aborted"); cancelled.resolve(); }, { once: true });
      await joined.promise; order.push("report-joined"); operation.check();
      return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: target, observationRevision: "0", observationAccepted: false } };
    });
    shutdown.mockImplementation(async () => { order.push("coordinator"); return true; });
    dispose.mockImplementation(async () => { order.push("git"); }); mocks.webClose.mockImplementation(() => { order.push("web-store"); });
    const running = start(f);
    await eventually(() => expect(mocks.coordinator).toHaveBeenCalledOnce()); await eventually(() => expect(report).toHaveBeenCalledOnce());
    f.signal.abort(); await cancelled.promise;
    expect(shutdown).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled(); expect(mocks.webClose).not.toHaveBeenCalled();
    joined.resolve(); await running;
    expect(order).toEqual(["report-aborted", "report-joined", "coordinator", "git", "web-store"]);
  });

  it.each([true, false])("retains the real instance lock through a confirmed report's late checkpoint writer past drain (project native valid: %s)", async projectNativeValid => {
    const f = await fixture(), writing = deferred<void>(), release = deferred<void>(), firstReceipt = deferred<void>(), nextRequest = deferred<WorkerCloudReport>(), releaseReceipt = deferred<void>();
    target = { ...target, value: { ...target.value, agentControlMode: "herdr", toolPaths: { codex: null, copilot: null, herdr: null } } };
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockImplementation(async () => ({ desired: target, observationRevision: String(observationRevision), observation: null }));
    if (!projectNativeValid) target = { ...target, value: { ...target.value, agentControlMode: "web", projects: [{ projectId: uuid(1), nativeOverrides: { args: ["--search"] } }] } };
    const acceptReport = report.getMockImplementation()!;
    report.mockImplementation(async (...args) => {
      if (report.mock.calls.length === 1) {
        const receipt = await acceptReport(...args);
        firstReceipt.resolve();
        return receipt;
      }
      nextRequest.resolve(args[2]);
      await releaseReceipt.promise;
      args[3].check();
      return acceptReport(...args);
    });
    const files = await vi.importActual<typeof import("../../../src/platform/files.js")>("../../../src/platform/files.js");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(workerTelemetryTime));
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    let baseline: string | undefined, receiptRevision: string | undefined, failed = false, finished = false;
    const ioFailure = Object.assign(new Error("Configuration file is busy."), { code: "EBUSY", syscall: "open" });
    mocks.cachePersist.mockImplementation(async (file: string, chunks: Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>, mode?: number) => {
      if (file !== f.paths.configurationFile || baseline === undefined) return files.replaceFileAtomicallyFromChunks(file, chunks, mode);
      const pieces: string[] = [];
      for await (const piece of chunks) { if (typeof piece !== "string") throw new TypeError("The cache codec must produce string chunks."); pieces.push(piece); }
      const text = pieces.join(""), cache = JSON.parse(text) as { authority: { observationRevision: string } };
      if (cache.authority.observationRevision === baseline) return files.replaceFileAtomicallyFromChunks(file, [text], mode);
      receiptRevision = cache.authority.observationRevision;
      if (!failed) { failed = true; throw ioFailure; }
      // The first yielded chunk is written before the iterator holds the real open replacement handle.
      await files.replaceFileAtomicallyFromChunks(file, (async function* () {
        yield text;
        writing.resolve();
        await release.promise;
      })(), mode);
    });
    const running = start(f);
    void running.then(() => { finished = true; }, () => { finished = true; });
    try {
      await eventuallyWithoutAdvancingTime(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
      await eventuallyWithoutAdvancingTime(() => expect(mocks.createdReporter).toHaveBeenCalledOnce());
      const manager = mocks.createdConfiguration.mock.calls[0]![0] as WorkerConfigurationManager;
      const reporter = mocks.createdReporter.mock.calls[0]![0] as ReturnType<typeof createWorkerReporter>;
      await firstReceipt.promise;
      reporter.trigger();
      const captured = await nextRequest.promise;
      await manager.settle();
      if (!projectNativeValid) expect(manager.current().items).toContainEqual(expect.objectContaining({ key: { kind: "projectNative", projectId: uuid(1) }, state: "error" }));
      const committed = JSON.parse(await readFile(f.paths.configurationFile, "utf8")) as { authority: { observationRevision: string } };
      baseline = committed.authority.observationRevision;
      expect(baseline).toBe("1");
      expect(baseline).toBe(String(observationRevision));
      expect(captured.observation?.baseRevision).toBe(baseline);
      const expectedReceipt = String(BigInt(baseline) + 1n);
      releaseReceipt.resolve();
      await eventuallyWithoutAdvancingTime(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker-configuration-storage-blocked" })));
      expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker-configuration-storage-blocked", configuration: expect.objectContaining({
        phase: "cache-persist", storagePhase: "persist", remote: "confirmed", local: "pending", syncId: expect.any(String), reportId: expect.any(String),
        source: expect.objectContaining({ observationRevision: baseline }),
      }) }));
      expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ configuration: expect.objectContaining({
        phase: "receipt-accept", status: "started", remote: "confirmed", local: "pending", observationAccepted: true,
        received: expect.objectContaining({ observationRevision: expectedReceipt }), source: expect.objectContaining({ observationRevision: baseline }),
      }) }));
      expect(mocks.coordinator.mock.calls[0]![0].configurationComplete()).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      await writing.promise;
      expect(receiptRevision).toBe(expectedReceipt);
      expect(String(observationRevision)).toBe(expectedReceipt);
      expect(report).toHaveBeenCalledTimes(2);
      f.signal.abort();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(finished).toBe(false);
      expect(shutdown).not.toHaveBeenCalled();
      const competing = await tryAcquireWorkerInstanceLock(f.paths);
      try { expect(competing).toBeNull(); } finally { await competing?.release(); }
      expect((JSON.parse(await readFile(f.paths.configurationFile, "utf8")) as { authority: { observationRevision: string } }).authority.observationRevision).toBe(baseline);
      release.resolve();
      await running;
      expect(finished).toBe(true);
      expect((JSON.parse(await readFile(f.paths.configurationFile, "utf8")) as { authority: { observationRevision: string } }).authority.observationRevision).toBe(receiptRevision);
      const next = await tryAcquireWorkerInstanceLock(f.paths);
      try { expect(next).not.toBeNull(); } finally { await next?.release(); }
    } finally {
      releaseReceipt.resolve(); release.resolve(); f.signal.abort();
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.allSettled([running]);
    }
  });

  it("preserves reporter cleanup uncertainty as the runtime result while completing resource teardown", async () => {
    const f = await fixture();
    const failure = new HerdrCommandCleanupError([new Error("unjoined process")], new Error("probe failed"));
    collect.mockResolvedValue({ telemetry: workerTelemetry, issues: [{ component: "codex", code: "command_failed", error: failure }] });
    const running = start(f); const rejected = expect(running).rejects.toBe(failure);
    await eventually(() => expect(mocks.coordinator).toHaveBeenCalledOnce()); await eventually(() => expect(report).toHaveBeenCalled());
    f.signal.abort(); await rejected;
    expect(shutdown).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce(); expect(mocks.webClose).toHaveBeenCalledOnce();
  });
});


it("defers archive backfill after each coordinator tick and resumes without repeated deferral logs", async () => {
  const f = await fixture();
  let round = 0;
  const reads: number[] = [], archived: number[] = [], deferredRounds: number[] = [];
  const yielding = [true, true, false, true, true, false];
  const completed = [11, 12].map(id => ({
    projectId: uuid(1), taskId: uuid(id + 10), claimId: uuid(id + 20), serverOrigin: "https://daynight.example",
    webExecution: { executionId: uuid(id), launchId: uuid(id), sessionId: uuid(id), executionGeneration: "1", launchSubmission: "submitted" },
  }));
  mocks.completed.mockImplementation(() => { reads.push(round); return completed; });
  mocks.ticket.mockImplementation(async (_home, launchId) => {
    const task = completed.find(task => task.webExecution.launchId === launchId)!;
    return { serverOrigin: task.serverOrigin, claimId: task.claimId, ...task.webExecution };
  });
  mocks.archive.mockImplementation(async () => { archived.push(round); return { state: "ready" }; });
  mocks.emit.mockImplementation(event => { if (event.kind === "session-archive-deferred") deferredRounds.push(round); });
  mocks.coordinator.mockImplementation(() => ({
    tick: async () => { round++; }, archiveYield: () => yielding[round - 1], updateConfiguration: update, shutdown,
  }));
  const timers = await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises");
  mocks.delay.mockImplementation(async (_milliseconds, _value, options) => {
    if (round >= yielding.length) f.signal.abort();
    await timers.setTimeout(0, undefined, options);
  });
  await start(f);
  expect(reads).toEqual([3, 6]);
  expect(archived).toEqual([3, 6]);
  expect(deferredRounds).toEqual([1, 4]);
  expect(mocks.emit.mock.calls.filter(([event]) => event.kind === "reconciliation-error")).toEqual([]);
});

it("rechecks archive deferral before starting a scheduled maintenance round", async () => {
  const f = await fixture();
  const polls: { gate: ReturnType<typeof deferred<void>>; signal: AbortSignal }[] = [];
  const decisionChanged = deferred<void>();
  let yielding = false, changeQueued = false;
  mocks.completed.mockReturnValue([{ projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), serverOrigin: "https://daynight.example", webExecution: { executionId: uuid(11), launchId: uuid(11), sessionId: uuid(11), executionGeneration: "1", launchSubmission: "submitted" } }]);
  mocks.ticket.mockResolvedValue({ serverOrigin: "https://daynight.example", executionId: uuid(11), sessionId: uuid(11), claimId: uuid(3), executionGeneration: "1" });
  mocks.archive.mockResolvedValue({ state: "ready" });
  mocks.delay.mockImplementation(async (_ms, _value, { signal }: { signal: AbortSignal }) => {
    const gate = deferred<void>(); polls.push({ gate, signal });
    await Promise.race([gate.promise, new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]);
    signal.throwIfAborted();
  });
  mocks.coordinator.mockImplementation(() => ({
    tick: async () => {}, updateConfiguration: update, shutdown,
    archiveYield: () => {
      if (!changeQueued) {
        changeQueued = true;
        queueMicrotask(() => { yielding = true; decisionChanged.resolve(); });
      }
      return yielding;
    },
  }));
  const running = start(f);
  await decisionChanged.promise;
  await eventually(() => expect(polls.some(poll => !poll.signal.aborted)).toBe(true));
  expect(mocks.completed).not.toHaveBeenCalled();
  expect(mocks.archive).not.toHaveBeenCalled();
  expect(mocks.emit.mock.calls.filter(([event]) => event.kind === "session-archive-deferred")).toHaveLength(1);
  yielding = false;
  polls.findLast(poll => !poll.signal.aborted)!.gate.resolve();
  await eventually(() => expect(mocks.emit.mock.calls.filter(([event]) => event.kind === "session-archive-ready")).toHaveLength(1));
  expect(mocks.archive).toHaveBeenCalledOnce();
  f.signal.abort(); await running;
});

it("continues polling during one historical upload and joins its finalizer before stopping", async () => {
  const f = await fixture();
  const entered = deferred<void>(), cancelled = deferred<void>(), releaseFinalizer = deferred<void>();
  const polls: { gate: ReturnType<typeof deferred<void>>; signal: AbortSignal }[] = [];
  const order: string[] = [];
  let ticks = 0, yielding = false;
  let options!: WorkerCoordinatorOptions;
  let storeClose!: ReturnType<typeof vi.spyOn>;
  mocks.completed.mockReturnValue([{ projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), serverOrigin: "https://daynight.example", webExecution: { executionId: uuid(11), launchId: uuid(11), sessionId: uuid(11), executionGeneration: "1", launchSubmission: "submitted" } }]);
  mocks.ticket.mockResolvedValue({ serverOrigin: "https://daynight.example", executionId: uuid(11), sessionId: uuid(11), claimId: uuid(3), executionGeneration: "1" });
  mocks.archive.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
    entered.resolve();
    try {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => { order.push("upload-aborted"); cancelled.resolve(); resolve(); }, { once: true }));
      signal.throwIfAborted();
    } finally {
      await releaseFinalizer.promise;
      order.push("upload-finalized");
    }
  });
  mocks.delay.mockImplementation(async (_ms, _value, { signal }: { signal: AbortSignal }) => {
    const poll = deferred<void>(); polls.push({ gate: poll, signal });
    await Promise.race([poll.promise, new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]);
    signal.throwIfAborted();
  });
  mocks.coordinator.mockImplementation((value: WorkerCoordinatorOptions) => {
    options = value;
    storeClose = vi.spyOn(options.store, "close");
    return { tick: async () => { ticks++; }, archiveYield: () => yielding, updateConfiguration: update, shutdown: async () => { order.push("coordinator-stopped"); return true; } };
  });
  mocks.webClose.mockImplementation(() => { order.push("web-store-closed"); });
  const running = start(f);
  await entered.promise;
  yielding = true;
  for (let i = 0; i < 2; i++) {
    await eventually(() => expect(polls.some(poll => !poll.signal.aborted)).toBe(true));
    const poll = polls.findLast(poll => !poll.signal.aborted)!;
    const before = ticks;
    poll.gate.resolve();
    await eventually(() => expect(ticks).toBeGreaterThan(before));
    await eventually(() => expect(polls.some(next => next !== poll && !next.signal.aborted)).toBe(true));
  }
  expect(ticks).toBeGreaterThanOrEqual(3);
  expect(mocks.archive).toHaveBeenCalledOnce();
  expect(mocks.archiveProbe).toHaveBeenCalledOnce();
  expect(order).not.toContain("upload-aborted");
  expect(mocks.emit.mock.calls.filter(([event]) => event.kind === "session-archive-deferred")).toHaveLength(1);
  f.signal.abort();
  await cancelled.promise;
  await eventually(() => expect(order).toContain("coordinator-stopped"));
  expect(options.monitoring!.capture("1").lifecycle).toBe("stopping");
  expect(mocks.webClose).not.toHaveBeenCalled();
  expect(storeClose).not.toHaveBeenCalled();
  releaseFinalizer.resolve();
  await running;
  expect(order.indexOf("upload-finalized")).toBeLessThan(order.indexOf("web-store-closed"));
  expect(storeClose).toHaveBeenCalledOnce();
  expect(options.monitoring!.capture("1").lifecycle).toBe("stopped");
  expect(mocks.emit.mock.calls.some(([event]) => event.kind === "session-archive-retry")).toBe(false);
});

it("reports an inventory failure against worker archive maintenance and recovers on a later poll", async () => {
  const f = await fixture(), failure = new Error("completed inventory unavailable");
  const polls: { gate: ReturnType<typeof deferred<void>>; signal: AbortSignal }[] = [];
  let options!: WorkerCoordinatorOptions;
  mocks.completed.mockImplementation(() => { throw failure; });
  mocks.delay.mockImplementation(async (_ms, _value, { signal }: { signal: AbortSignal }) => {
    const gate = deferred<void>(); polls.push({ gate, signal });
    await Promise.race([gate.promise, new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]);
    signal.throwIfAborted();
  });
  mocks.coordinator.mockImplementation((value: WorkerCoordinatorOptions) => {
    options = value;
    return { tick: async () => {}, archiveYield: () => false, updateConfiguration: update, shutdown };
  });
  const running = start(f);
  await eventually(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "session-archive-retry", error: failure })));
  const current = options.monitoring!.capture("1").currentFailures;
  expect(current).toContainEqual(expect.objectContaining({ component: "archive", phase: "archive-backfill", scope: { kind: "worker" } }));
  mocks.completed.mockReturnValue([]);
  await eventually(() => expect(polls.some(poll => !poll.signal.aborted)).toBe(true));
  polls.findLast(poll => !poll.signal.aborted)!.gate.resolve();
  await eventually(() => expect(options.monitoring!.capture("1").currentFailures.some(item => item.phase === "archive-backfill")).toBe(false));
  f.signal.abort(); await running;
});

it("retains a non-cancellation failure from the upload finalizer during shutdown", async () => {
  const f = await fixture(), entered = deferred<void>(), failure = new Error("upload finalizer failed");
  mocks.completed.mockReturnValue([{ projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), serverOrigin: "https://daynight.example", webExecution: { executionId: uuid(11), launchId: uuid(11), sessionId: uuid(11), executionGeneration: "1", launchSubmission: "submitted" } }]);
  mocks.ticket.mockResolvedValue({ serverOrigin: "https://daynight.example", executionId: uuid(11), sessionId: uuid(11), claimId: uuid(3), executionGeneration: "1" });
  mocks.archive.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
    entered.resolve();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    throw failure;
  });
  mocks.coordinator.mockImplementation(() => ({ tick: async () => {}, archiveYield: () => false, updateConfiguration: update, shutdown }));
  const running = start(f), rejected = expect(running).rejects.toBe(failure);
  await entered.promise;
  f.signal.abort(); await rejected;
  expect(mocks.webClose).toHaveBeenCalledOnce();
  expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "session-archive-retry", error: failure }));
});

it("reports historical Web archive failures against the original frozen checkout", async () => {
  const f = await fixture();
  const originalRoot = path.join(f.homeDirectory, "original-checkout");
  const originalWorktree = path.join(f.homeDirectory, "retained-worktree");
  mocks.completed.mockReturnValue([{ projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), serverOrigin: "https://daynight.example", repositoryPath: originalRoot, resources: { worktree: { repositoryPath: originalRoot, worktreePath: originalWorktree } }, webExecution: { executionId: uuid(11), launchId: uuid(11), sessionId: uuid(11), executionGeneration: "1", launchSubmission: "submitted" } }]);
  mocks.ticket.mockResolvedValue({ serverOrigin: "https://daynight.example", executionId: uuid(11), sessionId: uuid(11), claimId: uuid(3), executionGeneration: "1" });
  mocks.archiveProbe.mockResolvedValue({ kind: "blocked", code: "archive_incomplete" });
  mocks.coordinator.mockImplementation(() => ({ tick: async () => {}, archiveYield: () => false, updateConfiguration: update, shutdown }));
  const running = start(f);
  try {
    await eventually(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "session-archive-retry" })));
    const options = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
    await eventually(() => expect(options.store.getProject({ projectId: uuid(1) })?.localPath).toBe(path.join(f.homeDirectory, "repo")));
    const failure = options.monitoring!.capture("1").currentFailures.find(item => item.phase === "archive-backfill")!;
    expect(failure.worktree).toEqual({ kind: "project-relative", path: "../retained-worktree" });
    expect(JSON.stringify(failure)).not.toContain(f.homeDirectory);
  } finally { f.signal.abort(); await running; }
});

it.each(["blocked", "probe-error", "receipt", "cancelled", "persistence-error"] as const)("backfill performs only low-frequency archive condition probes: %s", async outcome => {
  const f = await fixture();
  target = { ...target, value: { ...target.value, pollIntervalMs: 60_000 } };
  let now = Date.parse(workerTelemetryTime), completedProbes = 0;
  const startTime = now;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  mocks.completed.mockReturnValue([{ projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), serverOrigin: "https://daynight.example", webExecution: { executionId: uuid(11), launchId: uuid(11), sessionId: uuid(11), executionGeneration: "1", launchSubmission: "submitted" } }]);
  mocks.ticket.mockImplementation(async (_home, launchId) => ({ serverOrigin: "https://daynight.example", executionId: launchId, sessionId: launchId, claimId: uuid(3), executionGeneration: "1" }));
  const probes: number[] = [];
  mocks.archiveProbe.mockImplementation(async (): Promise<ArchiveProbeResult> => {
    probes.push(now - startTime);
    if (outcome === "cancelled") { f.signal.abort(); f.signal.signal.throwIfAborted(); }
    if (probes.length > 1 && outcome === "probe-error") throw new Error("metadata unavailable");
    return probes.length > 1 && outcome === "receipt" ? { kind: "attempt" } : { kind: "blocked", code: "archive_incomplete" };
  });
  mocks.archive.mockResolvedValue({ state: "ready" });
  mocks.emit.mockImplementation((event: { kind: string; message: string }) => {
    if ((event.kind !== "session-archive-retry" && event.kind !== "session-archive-ready") || !event.message.startsWith(`Completed session ${uuid(11)}`)) return;
    if (event.kind === "session-archive-retry") {
      completedProbes++;
      if (completedProbes === 3) f.signal.abort();
    } else if (outcome === "receipt") f.signal.abort();
  });
  const timers = await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises");
  // Configuration commits can wake reconciliation without advancing a poll interval.
  mocks.delay.mockImplementation(async (milliseconds, _value, options) => {
    await timers.setTimeout(0, undefined, options);
    if (completedProbes !== 0 && completedProbes === probes.length) now += milliseconds;
  });
  mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => {
    if (outcome === "persistence-error") vi.spyOn(options.store, "saveArchiveBackfillSchedule").mockImplementation(() => { throw new Error("schedule storage unavailable"); });
    return { tick: async () => {}, archiveYield: () => false, updateConfiguration: update, shutdown };
  });
  await start(f);
  if (outcome === "cancelled") {
    expect(probes).toEqual([0]); expect(mocks.archive).not.toHaveBeenCalled();
    expect(mocks.emit.mock.calls.some(([event]) => event.kind === "session-archive-retry")).toBe(false);
  } else {
    expect(probes.slice(0, 2)).toEqual([0, 900000]);
    if (outcome === "receipt") expect(mocks.archive).toHaveBeenCalledOnce();
    else { expect(probes).toEqual([0, 900000, 1800000]); expect(mocks.archive).not.toHaveBeenCalled(); }
    if (outcome === "persistence-error") {
      const retries = mocks.emit.mock.calls.filter(([event]) => event.kind === "session-archive-retry").map(([event]) => event);
      expect(retries).toHaveLength(3);
      expect(retries.every(event => event.error instanceof AggregateError && event.error.message.includes("not persisted"))).toBe(true);
      expect(mocks.emit.mock.calls.some(([event]) => event.kind === "session-archive-ready")).toBe(false);
    }
  }
});


it("retains backfill blocker and probe deadline across runtime restart without cleanup ownership", async () => {
  const f = await fixture();
  let now = Date.parse(workerTelemetryTime);
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const identity = { projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), serverOrigin: "https://daynight.example", executionId: uuid(11), executionGeneration: "1", launchId: uuid(11) };
  mocks.completed.mockReturnValue([{ ...identity, webExecution: { ...identity, sessionId: uuid(11), launchSubmission: "submitted" } }]);
  mocks.ticket.mockResolvedValue({ ...identity, sessionId: uuid(11) });
  mocks.archiveProbe.mockResolvedValue({ kind: "blocked", code: "archive_incomplete" });
  const timers = await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises");
  mocks.delay.mockImplementation(async (_ms, _value, options) => { await timers.setTimeout(1, undefined, options); });
  let stop = f.signal, rounds = 0;
  mocks.coordinator.mockImplementation(() => ({ tick: async () => { if (++rounds === 3) stop.abort(); }, archiveYield: () => false, updateConfiguration: update, shutdown }));
  await start(f);
  expect(mocks.archiveProbe).toHaveBeenCalledOnce();
  const readState = () => {
    const db = openWorkerStore(f.paths.databaseFile);
    try { expect(db.listCleanupSchedules()).toEqual([]); return db.getArchiveBackfillSchedule(identity); }
    finally { db.close(); }
  };
  expect(readState()).toMatchObject({ archiveRepairCode: "archive_incomplete", nextAttemptAt: now + 900_000 });
  const restart = async () => { rounds = 0; stop = new AbortController(); await start({ ...f, signal: stop }); };
  now += 60_000;
  await restart();
  expect(mocks.archiveProbe).toHaveBeenCalledOnce();
  expect(mocks.archive).not.toHaveBeenCalled();
  now += 840_000;
  mocks.archiveProbe.mockRejectedValue(new Error("metadata unavailable"));
  await restart();
  expect(mocks.archiveProbe).toHaveBeenCalledTimes(2);
  expect(readState()).toMatchObject({ archiveRepairCode: "archive_incomplete", nextAttemptAt: now + 900_000 });
  expect(mocks.archive).not.toHaveBeenCalled();
  now += 900_000;
  mocks.archiveProbe.mockResolvedValue({ kind: "attempt" });
  mocks.archive.mockRejectedValue(new Error("receipt mismatch"));
  await restart();
  expect(readState()).toMatchObject({ archiveRepairCode: "archive_incomplete", nextAttemptAt: now + 900_000 });
  expect(mocks.emit.mock.calls.some(([event]) => event.kind === "session-archive-ready")).toBe(false);
  now += 900_000;
  mocks.archive.mockResolvedValue({ state: "ready" });
  await restart();
  expect(readState()).toBeNull();
  expect(mocks.archive).toHaveBeenCalledTimes(2);
});


it.each((["archive_incomplete", "projection_gap"] as const).flatMap(code =>
  (["complete", "receipt", "blocked", "unconfirmed", "regressed", "clear-failed"] as const).map(outcome => ({ code, outcome })),
))("updates backfill scheduling only after confirmed completeness: $code/$outcome", async ({ code, outcome }) => {
  const f = await fixture();
  let now = Date.parse(workerTelemetryTime), rounds = 0;
  const startTime = now;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const identity = { projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), serverOrigin: "https://daynight.example", executionId: uuid(11), executionGeneration: "1", launchId: uuid(11) };
  await mkdir(path.dirname(f.paths.databaseFile), { recursive: true });
  const db = openWorkerStore(f.paths.databaseFile);
  try { db.saveArchiveBackfillSchedule(identity, { archiveRepairCode: code, nextAttemptAt: now }); } finally { db.close(); }
  mocks.completed.mockReturnValue([{ ...identity, webExecution: { ...identity, sessionId: uuid(11), launchSubmission: "submitted" } }]);
  mocks.ticket.mockResolvedValue({ ...identity, sessionId: uuid(11) });
  mocks.archiveProbe.mockImplementation(async (): Promise<ArchiveProbeResult> => {
    if (outcome === "unconfirmed") throw new Error("metadata unavailable");
    if (outcome === "blocked") return { kind: "blocked", code };
    return { kind: outcome === "receipt" ? "attempt" : "complete" };
  });
  let store!: WorkerCoordinatorOptions["store"];
  const attempts: number[] = [];
  const admissions: ReturnType<typeof store.getArchiveBackfillSchedule>[] = [];
  mocks.archive.mockImplementation(async () => {
    attempts.push(now - startTime); admissions.push(store.getArchiveBackfillSchedule(identity));
    if (outcome === "regressed") {
      const { ArchiveRepairRequiredError } = await import("../../../src/commands/controller/archive-error.js");
      throw new ArchiveRepairRequiredError(code);
    }
    if (attempts.length < 3) throw new Error("Session archive request failed (503).");
    return { state: "ready" };
  });
  const timers = await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises");
  mocks.delay.mockImplementation(async (milliseconds, _value, options) => { await timers.setTimeout(0, undefined, options); if (mocks.coordinator.mock.calls.length) now += milliseconds; });
  mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => {
    store = options.store;
    if (outcome === "clear-failed") vi.spyOn(store, "deleteArchiveBackfillSchedule").mockImplementationOnce(() => { throw new Error("schedule unavailable"); });
    return { tick: async () => { if (++rounds > 4) f.signal.abort(); }, archiveYield: () => false, updateConfiguration: update, shutdown };
  });
  await start(f);
  const read = openWorkerStore(f.paths.databaseFile);
  try {
    expect(read.listCleanupSchedules()).toEqual([]);
    if (outcome === "complete") {
      expect(attempts).toEqual([0, 60_000, 120_000]);
      expect(admissions).toEqual([null, null, null]);
      expect(read.getArchiveBackfillSchedule(identity)).toBeNull();
      expect(mocks.emit.mock.calls.filter(([event]) => event.kind === "session-archive-ready")).toHaveLength(1);
      expect(mocks.emit.mock.calls.filter(([event]) => event.kind === "session-archive-retry").every(([event]) => !event.message.includes("requires repair"))).toBe(true);
    } else {
      expect(read.getArchiveBackfillSchedule(identity)).toMatchObject({ archiveRepairCode: code, nextAttemptAt: startTime + 900_000 });
      expect(attempts).toEqual(outcome === "receipt" || outcome === "regressed" ? [0] : []);
      expect(mocks.archiveProbe).toHaveBeenCalledOnce();
      expect(mocks.emit.mock.calls.some(([event]) => event.kind === "session-archive-ready")).toBe(false);
    }
  } finally { read.close(); }
});

it("runs the next round on a stop wake while historical and current cleanup remain pending", async () => {
  const f = await fixture();
  const entered = deferred<void>(), cleanup = deferred<void>();
  let ticks = 0;
  let options!: WorkerCoordinatorOptions;
  const polls: AbortSignal[] = [];
  mocks.completed.mockReturnValue([{ projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), serverOrigin: "https://daynight.example", webExecution: { executionId: uuid(11), launchId: uuid(11), sessionId: uuid(11), executionGeneration: "1", launchSubmission: "submitted" } }]);
  mocks.ticket.mockResolvedValue({ serverOrigin: "https://daynight.example", executionId: uuid(11), sessionId: uuid(11), claimId: uuid(3), executionGeneration: "1" });
  mocks.archive.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
    entered.resolve();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    signal.throwIfAborted();
  });
  mocks.delay.mockImplementation(async (_ms, _value, { signal }: { signal: AbortSignal }) => {
    polls.push(signal);
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    signal.throwIfAborted();
  });
  mocks.coordinator.mockImplementation((value: WorkerCoordinatorOptions) => {
    options = value;
    return { tick: async () => { ticks++; if (ticks === 1) void cleanup.promise; }, archiveYield: () => false, updateConfiguration: update, shutdown: async () => { await cleanup.promise; return true; } };
  });
  const running = start(f);
  await entered.promise;
  await eventually(() => expect(polls.some(signal => !signal.aborted)).toBe(true));
  const before = ticks;
  options.requestReconcile!();
  await eventually(() => expect(ticks).toBeGreaterThan(before));
  expect(mocks.archive).toHaveBeenCalledOnce();
  f.signal.abort();
  cleanup.resolve();
  await running;
});

it("admits another task through the real coordinator after a stop wake with both cleanups pending", async () => {
  const f = await fixture(), timers = await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises");
  const { createWorkerCoordinator } = await vi.importActual<typeof import("../../../src/commands/worker/coordinator.js")>("../../../src/commands/worker/coordinator.js");
  const stopEntered = deferred<void>(), stopRelease = deferred<void>(), archiveEntered = deferred<void>(), removeEntered = deferred<void>(), removeRelease = deferred<void>(), promptsReceived = deferred<void>();
  const owner = { projectId: uuid(1), taskId: uuid(20), claimId: uuid(21), worktreeId: uuid(22) };
  const repo = path.join(f.homeDirectory, "repo"), binding = { repositoryPath: repo, commonDirectory: path.join(repo, ".git"), worktreePath: path.join(repo, ".worktrees", "daynight", owner.worktreeId), branch: `daynight/${owner.taskId}` };
  const oldBinding = { session: "w", workspaceId: "old-workspace", paneId: "old-pane", terminalId: "old-terminal" };
  await mkdir(repo, { recursive: true }); await mkdir(f.paths.workerDirectory, { recursive: true });
  const seed = openWorkerStore(f.paths.databaseFile);
  seed.registerProject({ projectId: owner.projectId, repoUrl: remoteUrl, localPath: repo });
  seed.close();
  const resources = new Map<string, any>();
  const worktrees = new Map<string, any>();
  const grants = new Map<string, any>(); const trace: string[] = []; let stopped = false, originalEnded = false;
  const task = (id: string) => ({ type: "task", parentId: null, id, projectId: owner.projectId, title: id, description: "task", tags: [], status: "todo", allowAgents: true, assignedTo: null, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null, version: 1n, properties: { pullRequests: [] }, createdAt: workerTelemetryTime, updatedAt: workerTelemetryTime, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true });
  const candidates = [task(owner.taskId), task(uuid(30))];
  const started = vi.fn(async (context: any, nativeBinding: any) => ({ ...resources.get(context.claimId).panes[0], binding: nativeBinding, name: null }));
  const tasks = {
    pendingStops: () => [], listResources: async () => [...resources.values()],
    observeExecutionStop: async (target: any) => ({ ...(stopped && target.claimId === owner.claimId ? { kind: "stopped", execution: { owner, backend: "herdr-legacy", runKey: "original" } } : { kind: "unknown", target, error: target.claimId === owner.claimId ? new Error("not stopped") : new LegacyBindingUnavailableError("No original legacy binding") }), observedAt: Date.now() }),
    submitPrompt: async (context: any, nativeBinding: any) => ({ submission: "submitted", observation: { ...resources.get(context.claimId).panes[0], binding: nativeBinding, name: null } }),
    stopAndClose: async (context: any) => { if (context.claimId === owner.claimId) { stopEntered.resolve(); await stopRelease.promise; stopped = true; } resources.delete(context.claimId); },
    prepareWorkspace: async (context: any) => { trace.push("workspace"); const nativeBinding = { session: "w", workspaceId: "new-workspace", paneId: "new-pane", terminalId: "new-terminal" }; resources.set(context.claimId, { owner: context, workspaceId: nativeBinding.workspaceId, panes: [{ binding: nativeBinding, cwd: context.cwd, kind: "codex", status: "working", launchPending: false, interactiveReady: true, nativeSession: { source: "herdr", agent: "codex", sessionId: uuid(33) }, stateChangeSeq: 1, completionSeq: 0 }] }); return nativeBinding; },
    start: started, syncWorkspaceName: async () => {},
  };
  const herdr = { tasks, ensureInstance: async () => {}, stopInstance: async () => ({ stopped: true }), attachment: {} };
  mocks.herdr.mockReturnValue(herdr);
  mocks.durable.mockReturnValue(herdr);
  mocks.git.mockReturnValue({ prepareRepository: prepare, dispose, scanWorktrees: scanFromList, listWorktrees: async () => [...worktrees.values()], listWorktreeManifests: async () => [...worktrees.values()], resolveWorktreeBinding: async (_project: any, target: any) => worktrees.get(target.claimId)?.binding ?? null, retireWorktreeManifest: async () => {}, removeUnpublishedReservation: async () => {}, findWorktree: async (_project: any, target: any) => worktrees.get(target.claimId)?.binding ?? null,
    prepareWorktree: async (_project: any, target: any) => { trace.push("worktree"); const next = { ...binding, worktreePath: path.join(repo, ".worktrees", "daynight", target.worktreeId), branch: `daynight/${target.taskId}` }; await mkdir(next.worktreePath, { recursive: true }); worktrees.set(target.claimId, { owner: target, binding: next }); return next; },
    removeWorktree: async (_project: any, target: any) => { if (target.claimId === owner.claimId) { removeEntered.resolve(); await removeRelease.promise; } worktrees.delete(target.claimId); return { kind: "absent" as const, effectErrors: [] }; },
  });
  mocks.webOpen.mockReturnValue({ close: mocks.webClose, listUnfinishedTasks: () => [], getTask: () => null, listCompletedTasks: mocks.completed });
  mocks.completed.mockReturnValue([{ projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), serverOrigin: "https://daynight.example", webExecution: { executionId: uuid(11), launchId: uuid(11), sessionId: uuid(11), executionGeneration: "1", launchSubmission: "submitted" } }]);
  mocks.ticket.mockResolvedValue({ serverOrigin: "https://daynight.example", executionId: uuid(11), sessionId: uuid(11), claimId: uuid(3), executionGeneration: "1" });
  mocks.archive.mockImplementation(async ({ signal }: { signal: AbortSignal }) => { archiveEntered.resolve(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); signal.throwIfAborted(); });
  const polls: { signal: AbortSignal; release: () => void; settled: boolean }[] = [];
  mocks.delay.mockImplementation(async (ms: number, value: unknown, options?: { signal?: AbortSignal }) => {
    if (ms !== 60_000) return timers.setTimeout(ms === 1_000 ? 1 : ms, value, options);
    const signal = options!.signal!; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const poll = { signal, release, settled: false }; polls.push(poll);
    try { await Promise.race([gate, new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]); signal.throwIfAborted(); }
    finally { poll.settled = true; }
  });
  const remote = mocks.remote();
  Object.assign(remote, { ownInventory: async (projects: readonly { projectId: string }[]) => ({ tasks: [...grants.values()], coveredProjectIds: projects.map(project => project.projectId), unavailableProjectIds: [] }),
    candidates: async function* () { if (originalEnded) for (const candidate of candidates) if (![...grants.values()].some(value => value.id === candidate.id)) yield candidate; },
    claim: async (candidate: any, descriptor: any) => { const granted = { ...candidate, status: "in_progress", ready: false, version: 2n, properties: { worker: { ...descriptor, agentControlMode: descriptor.agentControlMode ?? "herdr", userId: uuid(6), state: "active", phase: "preparing", herdr: null, nativeSessionId: null, claimedAt: workerTelemetryTime } } }; grants.set(descriptor.claimId, granted); return granted; },
    readTask: async (_project: string, id: string) => [...grants.values()].find(value => value.id === id),
    update: async (current: any, patch: any) => { const next = { ...current, properties: { ...current.properties, worker: { ...current.properties.worker, ...patch } } }; grants.set(next.properties.worker.claimId, next); return next; },
    reportConfiguration: async (...args: any[]) => { const receipt = await report(args[0], args[1], args[2], args[3]); const selectors = args[4] ?? []; if (selectors.some(({ key }: any) => key.scope === "project")) promptsReceived.resolve(); return { ...receipt, prompts: { ok: true, results: selectors.map(({ key }: any) => ({ key, status: "value", value: { scope: key.scope, scopeId: key.scope === "user" ? uuid(6) : key.scope === "worker" ? uuid(4) : key.projectId, revision: "0", text: "", updatedAt: null } })) } }; },
  });
  let actualOptions!: WorkerCoordinatorOptions;
  mocks.coordinator.mockImplementation(value => { actualOptions = value; return createWorkerCoordinator(value); });
  const bounded = async <T>(stage: string, value: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([value, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${stage}.`)), 8_000); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const running = start(f);
  try {
    await bounded("historical archive", archiveEntered.promise);
    await eventually(() => expect(polls.some(poll => !poll.settled && !poll.signal.aborted)).toBe(true));
    const initialPoll = polls.findLast(poll => !poll.settled && !poll.signal.aborted)!;
    actualOptions.store.activateTask(actualOptions.store.registerPending({ ...owner, agent: "codex" }));
    resources.set(owner.claimId, { owner, workspaceId: oldBinding.workspaceId, panes: [{ binding: oldBinding, cwd: binding.worktreePath, kind: "codex", status: "idle", launchPending: false, interactiveReady: true, nativeSession: { source: "herdr", agent: "codex", sessionId: uuid(23) }, stateChangeSeq: 1, completionSeq: 1 }] });
    worktrees.set(owner.claimId, { owner, binding }); originalEnded = true;
    initialPoll.release();
    await Promise.all([bounded("original stop", stopEntered.promise), bounded("prompt receipt", promptsReceived.promise)]);
    await eventually(() => expect(actualOptions.promptSource?.current(owner.projectId)).not.toBeNull());
    await eventually(() => expect(polls.some(poll => poll !== initialPoll && !poll.settled && !poll.signal.aborted)).toBe(true));
    stopRelease.resolve();
    await bounded("original worktree removal", removeEntered.promise);
    await eventually(() => { if (started.mock.calls.length !== 1) throw new Error(JSON.stringify({ trace, tasks: actualOptions.store.listTasks(), prompt: actualOptions.promptSource?.current(owner.projectId), monitoring: actualOptions.monitoring?.capture("1"), grants: [...grants.values()].map(value => value.id) })); });
    expect([...grants.values()].map(value => value.id)).toEqual([uuid(30)]);
    expect(worktrees.has(owner.claimId)).toBe(true);
    expect(mocks.archive).toHaveBeenCalledOnce();
  } finally { stopRelease.resolve(); removeRelease.resolve(); f.signal.abort(); await running; }
}, 20_000);

it("retains Web stop observation causes and claim identity through runtime diagnostics", async () => {
  const f = await fixture();
  const running = start(f);
  try {
    await eventually(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
    const backendOptions = mocks.webBackend.mock.calls[0]![0] as { emit: (event: { kind: string; message: string; task: { projectId: string; taskId: string; claimId: string; worktreeId: string }; component: string; phase: string; attemptId: string; runKey: string; error: unknown }) => void };
    const owner = { projectId: uuid(1), taskId: uuid(60), claimId: uuid(61), worktreeId: uuid(62) };
    const cause = new Error("original process failure"), error = new Error("observation failed", { cause });
    const metadata = { component: "cleanup", phase: "agent-stop", attemptId: uuid(63), runKey: "original run" };
    backendOptions.emit({ kind: "execution-stop-observation-error", message: "unknown", task: owner, ...metadata, error });
    expect(mocks.emit).toHaveBeenCalledWith({ kind: "execution-stop-observation-error", message: "unknown", identity: owner, ...metadata, error });
    const coordinatorOptions = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
    await eventually(() => expect(coordinatorOptions.store.getProject({ projectId: owner.projectId })?.localPath).toBe(path.join(f.homeDirectory, "repo")));
    const task = coordinatorOptions.store.registerPending({ ...owner, agent: "codex" });
    backendOptions.emit({ kind: "execution-stop-observation-error", message: "unknown", task: owner, ...metadata, error });
    expect(mocks.emit).toHaveBeenCalledWith({ kind: "execution-stop-observation-error", message: "unknown", task, identity: owner, ...metadata, error });
  } finally { f.signal.abort(); await running; }
});
