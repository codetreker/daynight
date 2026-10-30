import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import { hasHerdrCommandCleanupFailure, HerdrCommandCleanupError, HerdrCommandError } from "../../../src/commands/worker/herdr/command.js";
import { createWorkerTelemetryCollector } from "../../../src/commands/worker/telemetry.js";
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
const collector = () => createWorkerTelemetryCollector({ paths: resolveWorkerPaths(path.resolve("fixture-home")), homeDirectory: path.resolve("fixture-home"), version: "1.2.3", workingDirectory: cwd, machine: { id: "host-1", name: "Fixture" }, platform: "linux" });
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
  it("samples a real CPU interval and reports the startup filesystem with exact available bytes", async () => {
    const pending = collector().collect(operation());
    await vi.advanceTimersByTimeAsync(199);
    expect(mocks.cpus).toHaveBeenCalledTimes(1);
    const sample = await finish(pending, 2);
    expect(sample.issues).toEqual([]);
    expect(sample.telemetry.cpu).toMatchObject({ state: "ok", value: { model: "Real CPU", logicalProcessors: 2, usagePercent: 20 } });
    expect(sample.telemetry.memory).toMatchObject({ state: "ok", value: { usedBytes: 768, totalBytes: 1024 } });
    expect(sample.telemetry.disk).toMatchObject({ state: "ok", value: { availableBytes: 102400, totalBytes: 409600 } });
    expect(mocks.statfs).toHaveBeenCalledWith(cwd, { bigint: true });
    expect(sample.telemetry.versions).toMatchObject({ daynight: "1.2.3", codex: { state: "ok", value: "0.1.0" }, herdr: { state: "ok", value: "0.9.5" } });
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
});
