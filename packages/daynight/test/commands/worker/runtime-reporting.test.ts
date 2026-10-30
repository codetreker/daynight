import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import type { Operation } from "../../../src/api/operation.js";
import type { WorkerReport, WorkerReportReceipt } from "../../../src/api/types.js";
import type { WorkerCoordinatorOptions } from "../../../src/commands/worker/coordinator.js";
import type { WorkerTelemetrySample } from "../../../src/commands/worker/telemetry.js";
import { HerdrCommandCleanupError } from "../../../src/commands/worker/herdr/command.js";
import { runWorker } from "../../../src/commands/worker/runtime.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { workerTelemetry, workerTelemetryTime } from "../../fixtures/worker-telemetry.js";

const mocks = vi.hoisted(() => ({ coordinator: vi.fn(), herdr: vi.fn(), git: vi.fn(), prompt: vi.fn(), remote: vi.fn(), telemetry: vi.fn(), webClose: vi.fn(), emit: vi.fn() }));
vi.mock("../../../src/commands/worker/coordinator.js", () => ({ createWorkerCoordinator: mocks.coordinator }));
vi.mock("../../../src/commands/worker/herdr.js", () => ({ createWorkerHerdr: mocks.herdr }));
vi.mock("../../../src/commands/worker/worktrees.js", () => ({ createWorkerGitManager: mocks.git }));
vi.mock("../../../src/commands/worker/prompts.js", () => ({ createWorkerPromptBuilder: mocks.prompt }));
vi.mock("../../../src/commands/worker/remote.js", () => ({ createWorkerRemote: mocks.remote }));
vi.mock("../../../src/commands/worker/telemetry.js", () => ({ createWorkerTelemetryCollector: mocks.telemetry }));
vi.mock("../../../src/commands/worker/backends/web-store.js", () => ({ openWebExecutionStore: () => ({ close: mocks.webClose }) }));
vi.mock("../../../src/commands/worker/backends/web.js", () => ({ createWebExecutionBackend: () => ({}) }));
vi.mock("../../../src/commands/worker/backends/web-process.js", () => ({ createWebControllerLauncher: () => ({}) }));
vi.mock("../../../src/commands/worker/backends/grant-renewal.js", () => ({ maintainWorkerControllerGrants: async () => {} }));
vi.mock("../../../src/commands/worker/diagnostics.js", () => ({ createWorkerDiagnostics: async () => ({ emit: mocks.emit, flush: async () => {}, filename: "worker.jsonl" }) }));

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const roots: string[] = [];
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 3500, interval: 10 });
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/runtime-reporting-tests");
  await mkdir(base, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(base, "w-")); roots.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory);
  await mkdir(paths.stateDirectory, { recursive: true });
  await writeFile(paths.configFile, stringify({ serverUrl: "https://daynight.example", serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", workerId: uuid(4), worker: { repositories: [{ remote: "https://git.example/team/repo.git", path: path.join(homeDirectory, "repo"), projectId: uuid(1), agentControlMode: "web" }], maxConcurrent: 1 } }));
  return { homeDirectory, paths, packageDirectory: path.resolve("package"), version: "9.8.7", workingDirectory: path.join(homeDirectory, "startup"), signal: new AbortController() };
};
let collect: ReturnType<typeof vi.fn<(operation: Operation) => Promise<WorkerTelemetrySample>>>;
let report: ReturnType<typeof vi.fn<(workerId: string, value: WorkerReport, operation: Operation) => Promise<WorkerReportReceipt>>>;
let prepare: ReturnType<typeof vi.fn>;
let shutdown: ReturnType<typeof vi.fn>;
let dispose: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.webClose.mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  collect = vi.fn(async () => ({ telemetry: workerTelemetry, issues: [] }));
  report = vi.fn(async () => ({ observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime }));
  prepare = vi.fn(async () => {}); shutdown = vi.fn(async () => true); dispose = vi.fn(async () => {});
  mocks.telemetry.mockReturnValue({ collect });
  mocks.remote.mockReturnValue({ currentUserId: vi.fn(async () => uuid(6)), resolveProject: vi.fn(async () => ({ id: uuid(1) })), report });
  mocks.git.mockReturnValue({ prepareRepository: prepare, dispose });
  mocks.prompt.mockResolvedValue(() => "prompt");
  mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => ({ tick: vi.fn(async () => { if (!options.signal!.aborted) await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), { once: true })); }), shutdown }));
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("worker runtime reporting integration", () => {
  it("reports independently through repository preparation and long Web reconciliation with wired inventory hooks", async () => {
    const f = await fixture(), prepared = deferred<void>();
    prepare.mockImplementation(() => prepared.promise);
    const running = runWorker({ ...f, signal: f.signal.signal });
    await eventually(() => expect(prepare).toHaveBeenCalledOnce());
    await eventually(() => expect(report).toHaveBeenCalledOnce());
    expect(report.mock.calls[0]![0]).toBe(uuid(4));
    expect(report.mock.calls[0]![1].taskInventory).toBeNull();
    expect(mocks.telemetry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ paths: f.paths, homeDirectory: f.homeDirectory, version: "9.8.7", workingDirectory: f.workingDirectory }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(report).toHaveBeenCalledTimes(2);
    expect(mocks.coordinator).not.toHaveBeenCalled();
    prepared.resolve();
    await eventually(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
    const options = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(report).toHaveBeenCalledTimes(3);
    options.onInventory!({ observedAt: workerTelemetryTime, claims: [] });
    await eventually(() => expect(report).toHaveBeenCalledTimes(4));
    expect(report.mock.calls[3]![1].taskInventory).toEqual({ observedAt: workerTelemetryTime, claims: [] });
    const claim = { projectId: uuid(1), taskId: uuid(2), claimId: uuid(3) };
    options.onClaim!(claim);
    await eventually(() => expect(report).toHaveBeenCalledTimes(5));
    expect(report.mock.calls[4]![1].taskInventory).toEqual({ observedAt: workerTelemetryTime, claims: [claim] });
    expect(mocks.herdr).not.toHaveBeenCalled();
    f.signal.abort(); await running;
    await vi.advanceTimersByTimeAsync(60_000); expect(report).toHaveBeenCalledTimes(5);
  });

  it("joins the aborted in-flight report before coordinator and backend teardown", async () => {
    const f = await fixture(), joined = deferred<void>(), cancelled = deferred<void>(), order: string[] = [];
    report.mockImplementation(async (_workerId, _body, operation) => {
      operation.signal.addEventListener("abort", () => { order.push("report-aborted"); cancelled.resolve(); }, { once: true });
      await joined.promise; order.push("report-joined"); operation.check();
      return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime };
    });
    shutdown.mockImplementation(async () => { order.push("coordinator"); return true; });
    dispose.mockImplementation(async () => { order.push("git"); });
    mocks.webClose.mockImplementation(() => { order.push("web-store"); });
    const running = runWorker({ ...f, signal: f.signal.signal });
    await eventually(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
    expect(report).toHaveBeenCalledOnce();
    f.signal.abort(); await cancelled.promise;
    expect(shutdown).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled(); expect(mocks.webClose).not.toHaveBeenCalled();
    joined.resolve(); await running;
    expect(order).toEqual(["report-aborted", "report-joined", "coordinator", "git", "web-store"]);
  });

  it("preserves reporter cleanup uncertainty as the runtime result while completing resource teardown", async () => {
    const f = await fixture();
    const failure = new HerdrCommandCleanupError([new Error("unjoined process")], new Error("probe failed"));
    collect.mockResolvedValue({ telemetry: workerTelemetry, issues: [{ component: "codex", code: "command_failed", error: failure }] });
    const running = runWorker({ ...f, signal: f.signal.signal });
    const rejected = expect(running).rejects.toBe(failure);
    await eventually(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
    await eventually(() => expect(report).toHaveBeenCalledOnce());
    f.signal.abort(); await rejected;
    expect(shutdown).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce(); expect(mocks.webClose).toHaveBeenCalledOnce();
  });
});
