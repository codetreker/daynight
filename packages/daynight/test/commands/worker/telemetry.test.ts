import { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import { hasHerdrCommandCleanupFailure, HerdrCommandCleanupError, HerdrCommandError, runHerdrCommand } from "../../../src/commands/worker/herdr/command.js";
import { createAssistantHostCollector } from "../../../src/commands/worker/bots/host-capabilities.js";
import { createWorkerTelemetryCollector } from "../../../src/commands/worker/telemetry.js";
import { createWorkerReporter } from "../../../src/commands/worker/reporter.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import path from "node:path";

const mocks = vi.hoisted(() => ({ cpus: vi.fn(), totalmem: vi.fn(), freemem: vi.fn(), statfs: vi.fn(), stat: vi.fn(), access: vi.fn(), version: vi.fn(), herdr: vi.fn() }));
vi.mock("node:os", async (original) => ({ ...await original<object>(), cpus: mocks.cpus, totalmem: mocks.totalmem, freemem: mocks.freemem }));
vi.mock("node:fs/promises", async (original) => ({ ...await original<object>(), statfs: mocks.statfs, stat: mocks.stat, access: mocks.access }));
vi.mock("../../../src/commands/worker/herdr/version-probe.js", async (original) => ({ ...await original<object>(), probeNativeAgentVersion: mocks.version }));
vi.mock("../../../src/commands/worker/herdr/instance.js", async (original) => ({ ...await original<object>(), createHerdrVersionObserver: () => ({ observe: mocks.herdr }) }));

const operations: Operation[] = [];
const operation = (): Operation => { const result = createOperation({ limits: { totalMs: 15_000 } }); operations.push(result); return result; };
const cwd = path.resolve("startup-volume");
const collector = (toolPaths?: Parameters<typeof createWorkerTelemetryCollector>[0]["toolPaths"]) => createWorkerTelemetryCollector({ ...(toolPaths === undefined ? {} : { toolPaths }), paths: resolveWorkerPaths(path.resolve("fixture-home")), homeDirectory: path.resolve("fixture-home"), version: "1.2.3", workingDirectory: cwd, machine: { id: "host-1", name: "Fixture" }, platform: "linux", workerId: "fixture-worker", serverOrigin: "https://daynight.example" });
const finish = async <T>(pending: Promise<T>, milliseconds = 210): Promise<T> => { await vi.advanceTimersByTimeAsync(milliseconds); return pending; };

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  let tick = 0;
  mocks.cpus.mockImplementation(() => { tick += 1; return [0, 1].map(() => ({ model: "Real CPU", speed: 1000, times: { user: tick * 20, nice: 0, sys: 0, idle: tick * 80, irq: 0 } })); });
  mocks.totalmem.mockReturnValue(1024); mocks.freemem.mockReturnValue(256);
  mocks.statfs.mockResolvedValue({ blocks: 100n, bavail: 25n, bsize: 4096n });
  mocks.stat.mockResolvedValue({ isDirectory: () => true });
  mocks.access.mockRejectedValue(Object.assign(new Error("absent"), { code: "ENOENT" }));
  mocks.version.mockImplementation(async ({ agent }: { agent: string }) => agent === "codex" ? "0.1.0" : "1.0.0");
  mocks.herdr.mockResolvedValue("0.9.5");
});
afterEach(() => { operations.splice(0).forEach((value) => value.dispose()); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Worker telemetry", () => {
  it("keeps unused Copilot out of repeated telemetry and reporter failure cycles", async () => {
    mocks.access.mockResolvedValue(undefined);
    let required = false;
    const resolveExecutable = vi.fn((provider: string) => {
      if (provider === "copilot") throw Object.assign(new Error("unavailable"), { code: "EACCES" });
      return provider;
    });
    const runCommand = vi.fn(async (command: import("../../../src/commands/worker/herdr/command.js").HerdrCommand) => ({ stderr: "", stdout: command.args.includes("--version")
      ? command.file === "codex" ? "codex-cli 0.1.0" : "2.1.247 (Claude Code)"
      : command.file === "codex" ? "app-server --stdio" : "--input-format --output-format --include-partial-messages" }));
    const assistantHost = createAssistantHostCollector({ workingDirectory: process.cwd(), environment: {},
      configuration: { agent: "codex", agentControlMode: "web", args: [], model: null, recoveryLimit: 3 },
      copilotRequired: () => required, resolveExecutable, runCommand });
    const instance = createWorkerTelemetryCollector({ paths: resolveWorkerPaths(path.resolve("fixture-home")), homeDirectory: path.resolve("fixture-home"), version: "1.2.3", workingDirectory: process.cwd(), machine: { id: "host-1", name: "Fixture" }, platform: "linux", workerId: "fixture-worker", serverOrigin: "https://daynight.example", assistantHost,
      toolPaths: { context: "web", snapshot: () => ({ schemaVersion: 1, observedAt: new Date().toISOString(), entries: [] }) } });
    const emit = vi.fn(), send = vi.fn(async (_report: import("../../../src/api/types.js").WorkerReport) => ({ observedAt: new Date().toISOString(), lastReportedAt: new Date().toISOString() }));
    const reporter = createWorkerReporter({ signal: new AbortController().signal, collect: instance.collect, send, emit });
    const next = async () => { reporter.trigger(); await vi.advanceTimersByTimeAsync(210); };
    const copilotEvents = () => emit.mock.calls.map(([event]) => event).filter(event => event.message.includes("assistantHost_copilot"));
    try {
      await vi.advanceTimersByTimeAsync(210);
      await next(); await next();
      expect(send).toHaveBeenCalledTimes(3);
      for (const [report] of send.mock.calls) {
        expect(report.assistantHost?.providers).toHaveLength(3);
        expect(report.assistantHost?.providers[2]).toEqual({ provider: "copilot", available: false, reason: "unavailable", model: null, args: [] });
        expect(report.versions.copilot).toMatchObject({ state: "error", code: "unavailable" });
      }
      expect(copilotEvents()).toEqual([]);
      expect(resolveExecutable.mock.calls.some(([provider]) => provider === "copilot")).toBe(false);
      expect(runCommand.mock.calls.some(([command]) => command.file === "copilot")).toBe(false);
      expect(mocks.version).not.toHaveBeenCalled();
      required = true;
      await next();
      expect(copilotEvents().map(event => event.kind)).toEqual(["worker_report_failed"]);
      required = false;
      await next(); await next(); await next();
      expect(copilotEvents().map(event => event.kind)).toEqual(["worker_report_failed", "worker_report_recovered"]);
      expect(resolveExecutable.mock.calls.filter(([provider]) => provider === "copilot")).toHaveLength(1);
      expect(runCommand.mock.calls.some(([command]) => command.file === "copilot")).toBe(false);
    } finally { await reporter.stop(); await assistantHost.close(); }
  });

  it("reports only explicitly supplied tool facts without deriving paths from legacy versions", async () => {
    expect((await finish(collector().collect(operation()))).telemetry).not.toHaveProperty("toolPaths");
    const facts = { schemaVersion: 1 as const, observedAt: "2026-11-04T00:00:00Z", entries: [] };
    const snapshot = vi.fn(() => facts);
    expect((await finish(collector({ context: "web", snapshot }).collect(operation()))).telemetry.toolPaths).toEqual(facts);
    expect(snapshot).toHaveBeenCalledOnce();
    mocks.version.mockClear(); mocks.herdr.mockClear();
    const sample = await finish(collector({ context: "web", snapshot }).collect(operation()));
    expect(sample.telemetry.versions.codex).toMatchObject({ state: "error", code: "unavailable" });
    expect(mocks.version).not.toHaveBeenCalled();
    expect(mocks.herdr).toHaveBeenCalledOnce();
  });
  it("projects legacy versions from the selected context's actual recipe only", async () => {
    const time = "2026-11-04T00:00:00Z";
    const actual = (version: string) => ({ selection: { kind: "auto" as const }, selectionKey: "a".repeat(64), entryPath: "/tool/copilot", executablePath: "/tool/copilot", interpreterPath: null, source: "bundled" as const, version, checkedAt: time });
    const observation = (context: "web" | "herdr", version: string) => ({ tool: "copilot" as const, context, configurationSource: "local" as const, targetRevision: null, target: { kind: "auto" as const }, state: "applied" as const, reason: null, actual: actual(version), candidate: null, activeSelectionCount: 0, activeSelectionsComplete: true, activeObservationError: null, activeSelections: [], error: null });
    const snapshot = () => ({ schemaVersion: 1 as const, observedAt: time, entries: [observation("web", "web-version"), observation("herdr", "herdr-version")] });
    let context: "web" | "herdr" = "web";
    const instance = collector({ context: () => context, snapshot });
    const sample = await finish(instance.collect(operation()));
    expect(sample.telemetry.versions.copilot).toEqual({ state: "ok", checkedAt: time, value: "web-version" });
    context = "herdr";
    expect((await finish(instance.collect(operation()))).telemetry.versions.copilot).toEqual({ state: "ok", checkedAt: time, value: "herdr-version" });
    expect(mocks.version).not.toHaveBeenCalled();
    expect(mocks.herdr).toHaveBeenCalledTimes(2);
  });

  it("keeps Herdr legacy versions tied to running instances when a new selection is ready", async () => {
    const time = "2026-11-04T00:00:00Z";
    const actual = { selection: { kind: "auto" as const }, selectionKey: "a".repeat(64), entryPath: "/tool/herdr", executablePath: "/tool/herdr", interpreterPath: null, source: "path" as const, version: "new-cli-selection", checkedAt: time };
    const snapshot = () => ({ schemaVersion: 1 as const, observedAt: time, entries: [{ tool: "herdr" as const, context: "herdr" as const, configurationSource: "local" as const, targetRevision: null, target: { kind: "auto" as const }, state: "applied" as const, reason: null, actual, candidate: null, activeSelectionCount: 0, activeSelectionsComplete: true, activeObservationError: null, activeSelections: [], error: null }] });
    const instance = collector({ context: "herdr", snapshot });
    mocks.herdr.mockResolvedValue(null);
    expect((await finish(instance.collect(operation()))).telemetry.versions.herdr).toMatchObject({ state: "not_running" });
    mocks.herdr.mockResolvedValue("running-instance");
    expect((await finish(instance.collect(operation()))).telemetry.versions.herdr).toMatchObject({ state: "ok", value: "running-instance" });
    expect(mocks.version).not.toHaveBeenCalled();
  });

  it("retains ordinary telemetry if the runtime tool inventory cannot be read", async () => {
    const sample = await finish(collector({ context: "web", snapshot: () => { throw new Error("private-tool-secret"); } }).collect(operation()));
    expect(sample.telemetry.cpu.state).toBe("ok");
    expect(sample.telemetry).not.toHaveProperty("toolPaths");
    expect(sample.issues).toMatchObject([{ component: "toolPaths", code: "unavailable" }]);
    expect(JSON.stringify(sample.telemetry)).not.toContain("private-tool-secret");
  });

  it("samples a real CPU interval and reports the startup filesystem with exact available bytes", async () => {
    const pending = collector().collect(operation());
    await vi.advanceTimersByTimeAsync(199);
    expect(mocks.cpus).toHaveBeenCalledTimes(1);
    const sample = await finish(pending, 2);
    expect(sample.issues).toEqual([]);
    expect(sample.telemetry).not.toHaveProperty("assistantHost");
    expect(sample.telemetry.cpu).toMatchObject({ state: "ok", value: { model: "Real CPU", logicalProcessors: 2, usagePercent: 20 } });
    expect(sample.telemetry.memory).toMatchObject({ state: "ok", value: { usedBytes: 768, totalBytes: 1024 } });
    expect(sample.telemetry.disk).toMatchObject({ state: "ok", value: { availableBytes: 102400, totalBytes: 409600 } });
    expect(mocks.statfs).toHaveBeenCalledWith(cwd, { bigint: true });
    expect(sample.telemetry.versions).toMatchObject({ daynight: "1.2.3", codex: { state: "ok", value: "0.1.0" }, herdr: { state: "ok", value: "0.9.5" } });
  });

  it("includes explicitly supplied assistant observations and preserves cleanup failures privately", async () => {
    const failure = new HerdrCommandCleanupError([new Error("private-token")], undefined);
    const assistantHost = { protocolVersion: 1 as const, observedAt: "2026-11-04T00:00:00Z", defaultCwd: cwd, defaultProvider: "copilot" as const, providers: ["codex", "claude", "copilot"].map(provider => ({ provider: provider as "codex" | "claude" | "copilot", available: false, reason: "unavailable" as const, model: null, args: [] })) };
    const instance = createWorkerTelemetryCollector({ paths: resolveWorkerPaths(path.resolve("fixture-home")), homeDirectory: path.resolve("fixture-home"), version: "1.2.3", workingDirectory: cwd, machine: { id: "host-1", name: "Fixture" }, platform: "linux", workerId: "fixture-worker", serverOrigin: "https://daynight.example", assistantHost: { collect: async () => ({ assistantHost, issues: [{ provider: "copilot" as const, reason: "unavailable" as const, error: failure }] }) } });
    const sample = await finish(instance.collect(operation()));
    expect(sample.telemetry.assistantHost).toEqual(assistantHost);
    expect(sample.issues).toEqual([{ component: "assistantHost_copilot", code: "unavailable", error: failure }]);
    expect(JSON.stringify(sample.telemetry)).not.toContain("private-token");
  });

  it("keeps a bounded assistant timeout report when the resource sampling deadline has elapsed", async () => {
    const assistantHost = { protocolVersion: 1 as const, observedAt: "2026-11-04T00:00:00Z", defaultCwd: cwd, defaultProvider: "copilot" as const, providers: ["codex", "claude", "copilot"].map(provider => ({ provider: provider as "codex" | "claude" | "copilot", available: false, reason: "timeout" as const, model: null, args: [] })) };
    const instance = createWorkerTelemetryCollector({ paths: resolveWorkerPaths(path.resolve("fixture-home")), homeDirectory: path.resolve("fixture-home"), version: "1.2.3", workingDirectory: cwd, machine: { id: "host-1", name: "Fixture" }, platform: "linux", workerId: "fixture-worker", serverOrigin: "https://daynight.example", assistantHost: { collect: async parent => {
      await new Promise(resolve => setTimeout(resolve, 5_001)); parent.check(); return { assistantHost, issues: [] };
    } } });
    const pending = instance.collect(operation());
    const observed = pending.then(sample => sample, error => error);
    const sample = await finish(observed, 5_010);
    expect(sample).toHaveProperty("telemetry.assistantHost", assistantHost);
  });

  it("exposes invalid and unsafe resource values independently without fabricated zero measurements", async () => {
    mocks.cpus.mockReturnValue([]); mocks.freemem.mockReturnValue(2048);
    mocks.statfs.mockResolvedValue({ blocks: BigInt(Number.MAX_SAFE_INTEGER), bavail: 1n, bsize: 4096n });
    const sample = await collector().collect(operation());
    expect(sample.telemetry.cpu).toMatchObject({ state: "error", code: "invalid_sample" });
    expect(sample.telemetry.memory).toMatchObject({ state: "error", code: "invalid_sample" });
    expect(sample.telemetry.disk).toMatchObject({ state: "error", code: "out_of_range" });
    expect(sample.telemetry.os.state).toBe("ok");
    expect(sample.issues.map(({ component }) => component).sort()).toEqual(["cpu", "disk", "memory"]);
  });

  it("rejects CPU counters that do not advance", async () => {
    const fixed = [{ model: "CPU", times: { user: 0, nice: 0, sys: 0, idle: 20, irq: 0 } }]; mocks.cpus.mockReturnValue(fixed);
    const sample = await finish(collector().collect(operation()));
    expect(sample.telemetry.cpu).toMatchObject({ state: "error", code: "invalid_sample" });
  });

  it("retains one unresolved statfs request across collection deadlines", async () => {
    let resolveDisk!: (value: { blocks: bigint; bavail: bigint; bsize: bigint }) => void;
    mocks.statfs.mockReturnValue(new Promise((resolve) => { resolveDisk = resolve; }));
    const instance = collector();
    const first = await finish(instance.collect(operation()), 5_010);
    expect(first.telemetry.disk).toMatchObject({ state: "error", code: "timeout" });
    const second = await finish(instance.collect(operation()));
    expect(mocks.statfs).toHaveBeenCalledTimes(1);
    expect(second.telemetry.disk).toMatchObject({ state: "error", code: "timeout" });
    resolveDisk({ blocks: 100n, bavail: 25n, bsize: 4096n });
    await vi.advanceTimersByTimeAsync(0);
    mocks.statfs.mockResolvedValue({ blocks: 100n, bavail: 25n, bsize: 4096n });
    expect((await finish(instance.collect(operation()))).telemetry.disk.state).toBe("ok");
    expect(mocks.statfs).toHaveBeenCalledTimes(2);
  });

  it("caches native versions for at most 60 seconds and replaces a former success with its new error", async () => {
    let monotonic = 0; vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const instance = collector();
    const first = await finish(instance.collect(operation()));
    monotonic = 59_999;
    await finish(instance.collect(operation())); expect(mocks.version).toHaveBeenCalledTimes(2);
    mocks.version.mockRejectedValue(new Error("native config must remain private"));
    monotonic = 60_001;
    const updated = await finish(instance.collect(operation()));
    expect(mocks.version).toHaveBeenCalledTimes(4);
    expect(updated.telemetry.versions.codex).toMatchObject({ state: "error" });
    expect(updated.telemetry.versions.codex.checkedAt).not.toBe(first.telemetry.versions.codex.checkedAt);
    expect(JSON.stringify(updated.telemetry)).not.toContain("native config");
    expect(mocks.herdr).toHaveBeenCalledTimes(3);
  });

  it("distinguishes confirmed executable absence from an invalid native working directory", async () => {
    const failure = new HerdrCommandError("Cannot execute", null, null, "", { cause: Object.assign(new Error("sensitive-command"), { code: "ENOENT" }) });
    mocks.version.mockRejectedValue(failure);
    const missing = await finish(collector().collect(operation()));
    expect(missing.telemetry.versions.codex.state).toBe("not_installed");
    mocks.stat.mockRejectedValue(Object.assign(new Error("missing cwd"), { code: "ENOENT" }));
    const invalidCwd = await finish(collector().collect(operation()));
    expect(invalidCwd.telemetry.versions.codex).toMatchObject({ state: "error", code: "not_found" });
  });

  it("keeps uncertain command cleanup visible and does not start a replacement probe", async () => {
    let monotonic = 0; vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const failure = new HerdrCommandCleanupError([new Error("owned process remains")], undefined);
    mocks.version.mockRejectedValue(failure); const instance = collector();
    const first = await finish(instance.collect(operation()));
    monotonic = 120_000;
    const second = await finish(instance.collect(operation()));
    expect(mocks.version).toHaveBeenCalledTimes(2);
    expect(first.telemetry.versions.codex.state).toBe("error");
    expect(second.telemetry.versions.codex).toMatchObject({ state: "error", code: "unavailable" });
    expect(second.issues.find(({ component }) => component === "codex")?.error).toBe(failure);
  });

  it("propagates runtime cancellation and keeps an absent private daemon separate from errors", async () => {
    mocks.herdr.mockResolvedValue(null);
    const sample = await finish(collector().collect(operation()));
    expect(sample.telemetry.versions.herdr).toMatchObject({ state: "not_running" });
    const controller = new AbortController(); const op = createOperation({ signal: controller.signal }); operations.push(op);
    const pending = collector().collect(op);
    controller.abort();
    await expect(pending).rejects.toBe(op.signal.reason);
  });

  it("preserves unconfirmed native cleanup when runtime cancellation interrupts collection", async () => {
    const cleanup = new HerdrCommandCleanupError([new Error("owned process remains")], undefined);
    mocks.version.mockRejectedValue(cleanup);
    const controller = new AbortController(); const op = createOperation({ signal: controller.signal }); operations.push(op);
    const pending = collector().collect(op); controller.abort();
    const failure: unknown = await pending.catch((error: unknown) => error);
    expect(hasHerdrCommandCleanupFailure(failure)).toBe(true);
    expect(failure).toMatchObject({ cause: op.signal.reason });
  });

  it.each(["rejection", "synchronous throw"])("joins ordinary probes and preserves cleanup after assistant %s", async mode => {
    const cleanup = new HerdrCommandCleanupError([new Error("owned process remains")], undefined);
    const laterCleanup = new HerdrCommandCleanupError([new Error("another owned process remains")], undefined);
    const assistantFailure = new Error("assistant failed");
    const completions = new Map<string, (error?: unknown) => void>();
    mocks.version.mockImplementation(({ agent }: { agent: string }) => new Promise((resolve, reject) => {
      completions.set(agent, error => error === undefined ? resolve("1.0.0") : reject(error));
    }));
    const instance = createWorkerTelemetryCollector({ paths: resolveWorkerPaths(path.resolve("fixture-home")), homeDirectory: path.resolve("fixture-home"), version: "1.2.3", workingDirectory: cwd, machine: { id: "host-1", name: "Fixture" }, platform: "linux", workerId: "fixture-worker", serverOrigin: "https://daynight.example", assistantHost: { collect: () => {
      if (mode === "synchronous throw") throw assistantFailure;
      return Promise.reject(assistantFailure);
    } } });
    let finished = false;
    const observed = instance.collect(operation()).then(value => { finished = true; return value; }, error => { finished = true; return error; });
    await vi.advanceTimersByTimeAsync(210);
    const finishedBeforeCleanup = finished;
    completions.get("codex")!(cleanup);
    await vi.advanceTimersByTimeAsync(0);
    const finishedBeforeLastProbe = finished;
    completions.get("copilot")!(laterCleanup);
    const failure: unknown = await observed;
    expect(finishedBeforeCleanup).toBe(false);
    expect(finishedBeforeLastProbe).toBe(false);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toContain(assistantFailure);
    expect((failure as AggregateError).errors).toContain(cleanup);
    expect((failure as AggregateError).errors).toContain(laterCleanup);
  });

  it("keeps reporter stop pending until ordinary cleanup finishes after assistant cancellation", async () => {
    const cleanup = new HerdrCommandCleanupError([new Error("owned process remains")], undefined);
    const completions: ((error?: unknown) => void)[] = [];
    mocks.version.mockImplementation(() => new Promise((resolve, reject) => {
      completions.push(error => error === undefined ? resolve("1.0.0") : reject(error));
    }));
    const instance = createWorkerTelemetryCollector({ paths: resolveWorkerPaths(path.resolve("fixture-home")), homeDirectory: path.resolve("fixture-home"), version: "1.2.3", workingDirectory: cwd, machine: { id: "host-1", name: "Fixture" }, platform: "linux", workerId: "fixture-worker", serverOrigin: "https://daynight.example", assistantHost: { collect: parent => new Promise((_, reject) => {
      const abort = () => reject(parent.signal.reason);
      parent.signal.addEventListener("abort", abort, { once: true });
      if (parent.signal.aborted) abort();
    }) } });
    let sent = 0;
    const reporter = createWorkerReporter({ signal: new AbortController().signal, collect: parent => instance.collect(parent), emit: () => {}, send: async () => { sent++; return { observedAt: "2026-11-04T00:00:00Z", lastReportedAt: "2026-11-04T00:00:00Z" }; } });
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const observed = reporter.stop().then(() => { stopped = true; return undefined; }, error => { stopped = true; return error; });
    await vi.advanceTimersByTimeAsync(0);
    const stoppedBeforeCleanup = stopped;
    completions[0]!(cleanup);
    await vi.advanceTimersByTimeAsync(0);
    const stoppedBeforeLastProbe = stopped;
    completions[1]!();
    const failure: unknown = await observed;
    expect(stoppedBeforeCleanup).toBe(false);
    expect(stoppedBeforeLastProbe).toBe(false);
    expect(hasHerdrCommandCleanupFailure(failure)).toBe(true);
    expect(sent).toBe(0);
  });
});


describe("native version cleanup recovery", () => {
  beforeEach(() => { vi.spyOn(performance, "now").mockImplementation(() => Date.now()); });

  const timedOutProbe = async (terminationFailure = false) => {
    const child = new ChildProcess();
    if (terminationFailure) Object.defineProperty(child, "pid", { get: () => { throw new Error("Cannot terminate the owned process"); } });
    const parent = createOperation({ limits: { totalMs: 100, requestMs: 20 } });
    try {
      const result = runHerdrCommand({ file: "codex", args: ["--version"], environment: {} }, parent, () => child, { cleanupWithinDeadline: true }).catch((error: unknown) => error);
      const failure = await finish(result, 110);
      expect(failure).toBeInstanceOf(HerdrCommandCleanupError);
      return { child, failure };
    } finally { parent.dispose(); }
  };

  it("blocks replacements across expired caches and retries immediately after the original close", async () => {
    const original = await timedOutProbe();
    let attempts = 0;
    mocks.version.mockImplementation(async ({ agent }: { agent: string }) => {
      if (agent === "codex" && ++attempts === 1) throw original.failure;
      return "2.0.0";
    });
    const instance = collector();
    const first = await finish(instance.collect(operation()));
    expect(first.telemetry.versions.codex.state).toBe("error");
    const closeListeners = original.child.listenerCount("close");
    for (const elapsed of [1, 60_001, 120_001]) {
      await vi.advanceTimersByTimeAsync(elapsed);
      const blocked = await finish(instance.collect(operation()));
      expect(blocked.telemetry.versions.codex).toMatchObject({ state: "error", code: "unavailable" });
    }
    original.child.emit("exit", 0, null);
    new ChildProcess().emit("close", 0, null);
    await finish(instance.collect(operation()));
    expect(attempts).toBe(1);
    expect(original.child.listenerCount("close")).toBe(closeListeners);
    original.child.emit("close", 0, null);
    const sampledAt = new Date().toISOString();
    const recovered = await finish(instance.collect(operation()));
    expect(recovered.telemetry.versions.codex).toEqual({ state: "ok", value: "2.0.0", checkedAt: sampledAt });
    expect(recovered.telemetry.sampledAt).toBe(sampledAt);
    expect(recovered.telemetry.versions.codex.checkedAt).not.toBe(first.telemetry.versions.codex.checkedAt);
    expect(recovered.issues.find(issue => issue.component === "codex")).toBeUndefined();
    expect(attempts).toBe(2);
    await finish(instance.collect(operation()));
    expect(attempts).toBe(2);
  });

  it("invalidates a recent unavailable cache only for its confirmed provider and round", async () => {
    const codex = await timedOutProbe(); const copilot = await timedOutProbe(); const nextCodex = await timedOutProbe();
    const attempts = { codex: 0, copilot: 0 };
    mocks.version.mockImplementation(async ({ agent }: { agent: "codex" | "copilot" }) => {
      const count = ++attempts[agent];
      if (agent === "codex" && count <= 2) throw count === 1 ? codex.failure : nextCodex.failure;
      if (agent === "copilot" && count === 1) throw copilot.failure;
      return "2.0.0";
    });
    const instance = collector();
    await finish(instance.collect(operation()));
    codex.child.emit("close", 0, null);
    let sample = await finish(instance.collect(operation()));
    expect(sample.telemetry.versions.codex.state).toBe("error");
    expect(sample.telemetry.versions.copilot.state).toBe("error");
    expect(attempts).toEqual({ codex: 2, copilot: 1 });
    codex.child.emit("close", 0, null);
    await finish(instance.collect(operation()));
    expect(attempts).toEqual({ codex: 2, copilot: 1 });
    copilot.child.emit("close", 0, null);
    sample = await finish(instance.collect(operation()));
    expect(sample.telemetry.versions.copilot).toMatchObject({ state: "ok", value: "2.0.0" });
    expect(sample.telemetry.versions.codex).toMatchObject({ state: "error", code: "unavailable" });
    nextCodex.child.emit("close", 0, null);
    sample = await finish(instance.collect(operation()));
    expect(sample.telemetry.versions.codex).toMatchObject({ state: "ok", value: "2.0.0" });
    expect(attempts).toEqual({ codex: 3, copilot: 2 });
  });

  it("does not discard a nested unconfirmed cleanup when another aggregate member closes", async () => {
    const first = await timedOutProbe(); const second = await timedOutProbe();
    const failure = new AggregateError([first.failure], "Combined probes", { cause: new Error("Second probe", { cause: second.failure }) });
    let attempts = 0;
    mocks.version.mockImplementation(async ({ agent }: { agent: string }) => {
      if (agent === "codex" && ++attempts === 1) throw failure;
      return "2.0.0";
    });
    const instance = collector();
    await finish(instance.collect(operation()));
    first.child.emit("close", 0, null);
    const blocked = await finish(instance.collect(operation()));
    expect(blocked.telemetry.versions.codex).toMatchObject({ state: "error", code: "unavailable" });
    expect(blocked.issues.find(issue => issue.component === "codex")?.error).toBe(failure);
    expect(attempts).toBe(1);
    second.child.emit("close", 0, null);
    expect((await finish(instance.collect(operation()))).telemetry.versions.codex.state).toBe("ok");
    expect(attempts).toBe(2);
  });

  it.each(["termination failure", "legacy cleanup"])("keeps %s unavailable after a close and cache expiry", async mode => {
    const original = await timedOutProbe(mode === "termination failure");
    const failure = mode === "legacy cleanup" ? new HerdrCommandCleanupError([new Error("No original confirmation handle")], undefined) : original.failure;
    let attempts = 0;
    mocks.version.mockImplementation(async ({ agent }: { agent: string }) => {
      if (agent === "codex") { attempts++; throw failure; }
      return "2.0.0";
    });
    const instance = collector();
    await finish(instance.collect(operation()));
    original.child.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(120_001);
    const blocked = await finish(instance.collect(operation()));
    expect(blocked.telemetry.versions.codex).toMatchObject({ state: "error", code: "unavailable" });
    expect(blocked.issues.find(issue => issue.component === "codex")?.error).toBe(failure);
    expect(attempts).toBe(1);
  });

  it("confirms assistant and version probes independently and reports the retry's current failure", async () => {
    const host = await timedOutProbe(); const version = await timedOutProbe();
    const currentFailure = new HerdrCommandError("Retry failed", 2, null, "private diagnostic");
    let hostAttempts = 0; let versionAttempts = 0;
    mocks.access.mockResolvedValue(undefined);
    const assistantHost = createAssistantHostCollector({ workingDirectory: process.cwd(), environment: {},
      configuration: { agent: "codex", agentControlMode: "web", args: [], model: null, recoveryLimit: 3 },
      resolveExecutable: provider => provider,
      runCommand: async command => {
        if (command.file === "codex" && ++hostAttempts === 1) throw host.failure;
        return { stderr: "", stdout: command.args.includes("--version")
          ? command.file === "codex" ? "codex-cli 0.1.0" : command.file === "claude" ? "2.1.247 (Claude Code)" : "GitHub Copilot CLI 1.0.83"
          : command.file === "codex" ? "app-server --stdio" : command.file === "claude" ? "--input-format --output-format --include-partial-messages" : "--no-auto-update" };
      },
    });
    mocks.version.mockImplementation(async ({ agent }: { agent: string }) => {
      if (agent === "codex") { versionAttempts++; throw versionAttempts === 1 ? version.failure : currentFailure; }
      return "2.0.0";
    });
    const instance = createWorkerTelemetryCollector({ paths: resolveWorkerPaths(path.resolve("fixture-home")), homeDirectory: path.resolve("fixture-home"), version: "1.2.3", workingDirectory: cwd, machine: { id: "host-1", name: "Fixture" }, platform: "linux", workerId: "fixture-worker", serverOrigin: "https://daynight.example", assistantHost });
    await finish(instance.collect(operation()));
    host.child.emit("close", 0, null);
    let sample = await finish(instance.collect(operation()));
    expect(sample.telemetry.assistantHost?.providers[0]!.available).toBe(true);
    expect(sample.telemetry.versions.codex).toMatchObject({ state: "error", code: "unavailable" });
    expect(hostAttempts).toBe(3); expect(versionAttempts).toBe(1);
    version.child.emit("close", 0, null);
    const checkedAt = new Date().toISOString();
    sample = await finish(instance.collect(operation()));
    expect(sample.telemetry.versions.codex).toEqual({ state: "error", code: "command_failed", checkedAt });
    expect(sample.issues.find(issue => issue.component === "codex")?.error).toBe(currentFailure);
    expect(versionAttempts).toBe(2);
    const cancellation = new AbortController(); const parent = createOperation({ signal: cancellation.signal });
    cancellation.abort();
    try { await expect(instance.collect(parent)).rejects.toBe(parent.signal.reason); }
    finally { parent.dispose(); }
    expect(versionAttempts).toBe(2); expect(hostAttempts).toBe(5);
  });
});
