import { describe, expect, it, vi } from "vitest";
import { parseWorkerDetail, parseWorkerPage } from "../../../src/commands/worker/query-api.js";
import { renderWorkerDetail, renderWorkerList } from "../../../src/commands/worker/query-rendering.js";
import { runWorkerCommand } from "../../../src/commands/worker/index.js";
import { createOperation } from "../../../src/api/operation.js";
import { runWorkerQuery } from "../../../src/commands/worker/query.js";
import type { WorkerQueryDependencies } from "../../../src/commands/worker/query.js";
import { ApiError } from "../../../src/api/client.js";
import { formatError, PublicDiagnosticError } from "../../../src/platform/diagnostics.js";
import { UsageError } from "../../../src/cli/context.js";

const workerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const machine = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Machine 中文" };
const observedAt = "2026-11-04T10:00:00Z";
const summary = { workerId, machine, platform: "macos", lastReportedAt: "2026-11-04T09:59:30Z", taskObservationState: "unavailable", taskObservedAt: null, activeTaskCount: null };
const probe = { state: "error", checkedAt: observedAt, code: "unavailable" };
const telemetry = { machine, platform: "macos", workingDirectory: "/ordinary/directory", sampledAt: observedAt, os: probe, cpu: probe, memory: probe, disk: probe, versions: { daynight: "0.41.0", herdr: { state: "not_running", checkedAt: observedAt }, codex: { state: "not_installed", checkedAt: observedAt }, copilot: probe } };
const detail = { observedAt, worker: { ...summary, telemetry, inventoryObservedAt: null, tasks: [] } };
const page = { observedAt, items: [summary], nextCursor: null };
const context = () => ({ version: "0.0.0", packageDirectory: "unused", homeDirectory: vi.fn(() => { throw new Error("Unexpected home access"); }), workingDirectory: vi.fn(() => { throw new Error("Unexpected cwd access"); }), stdout: vi.fn(), stderr: vi.fn(), stdoutBytes: vi.fn(async () => {}) });

describe("remote worker response validation", () => {
  it("reads current runtime sources and preserves their removal in later reports", () => {
    const runtimeConfiguration = { schemaVersion: 1, native: { agent: "codex", model: { value: "model", source: "local" }, reasoningEffort: { value: null, source: "native" } }, projects: [] };
    const current = { ...detail, worker: { ...detail.worker, telemetry: { ...telemetry, runtimeConfiguration } } };
    expect(parseWorkerDetail(current, workerId)).toEqual(current);
    expect(parseWorkerDetail(detail, workerId).worker.telemetry).not.toHaveProperty("runtimeConfiguration");
    expect(() => parseWorkerDetail({ ...current, worker: { ...current.worker, telemetry: { ...current.worker.telemetry, runtimeConfiguration: null } } }, workerId)).toThrow();
  });
  it("preserves observation timestamps and unknown task inventory without inventing idle capacity", () => {
    expect(parseWorkerPage(page)).toEqual(page);
    expect(parseWorkerDetail(detail, workerId)).toEqual(detail);
  });
  it.each([
    { ...page, observedAt: "today" },
    { ...page, items: [summary, summary] },
    { ...page, items: [{ ...summary, activeTaskCount: 0 }] },
    { ...page, items: [{ ...summary, taskObservedAt: observedAt }] },
    { ...page, items: [{ ...summary, taskObservationState: "observed" }] },
    { ...page, nextCursor: "" },
    { ...page, nextCursor: "bad\ncursor" },
    { ...page, token: "credential" },
  ])("rejects malformed or contradictory pages", (value) => { expect(() => parseWorkerPage(value)).toThrow(); });
  it.each([
    { ...detail, worker: { ...detail.worker, telemetry: { ...telemetry, machine: { ...machine, name: "wrong" } } } },
    { ...detail, worker: { ...detail.worker, inventoryObservedAt: observedAt } },
    { ...detail, worker: { ...detail.worker, taskObservationState: "observed", taskObservedAt: observedAt, inventoryObservedAt: observedAt, activeTaskCount: 1 } },
    { ...detail, worker: { ...detail.worker, telemetry: { ...telemetry, cpu: { state: "ok", checkedAt: observedAt, value: { model: "CPU", logicalProcessors: 4, usagePercent: 101 } } } } },
    { ...detail, worker: { ...detail.worker, telemetry: { ...telemetry, disk: { state: "ok", checkedAt: observedAt, value: { totalBytes: 10, availableBytes: 11 } } } } },
    { ...detail, worker: { ...detail.worker, telemetry: { ...telemetry, serverToken: "credential" } } },
  ])("rejects malformed detail and unrecognized credential-bearing fields", (value) => { expect(() => parseWorkerDetail(value, workerId)).toThrow(); });
  it("rejects a response for another worker", () => { expect(() => parseWorkerDetail(detail, machine.id)).toThrow(); });
});

describe("remote worker observed telemetry", () => {
  const task = { projectId: machine.id, taskId: workerId, claimId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", title: "Task 中文", projectName: "Project", status: "in_progress", phase: "paused", agent: "claude" };
  const ok = (value: unknown) => ({ state: "ok", checkedAt: observedAt, value });
  const host = { protocolVersion: 1, observedAt: "2026-11-04T09:57:00Z", defaultCwd: "/ordinary/directory", defaultProvider: "claude", providers: [
    { provider: "claude", available: true, reason: null, model: null, args: [] },
    { provider: "codex", available: false, reason: "not_found", model: null, args: [] },
    { provider: "copilot", available: false, reason: "unsupported_arguments", model: null, args: [] },
  ] };
  const complete = { observedAt, worker: { ...summary, taskObservationState: "observed", taskObservedAt: observedAt, activeTaskCount: 1, inventoryObservedAt: observedAt, tasks: [task], telemetry: {
    ...telemetry, assistantHost: host, os: ok({ type: "Darwin", release: "25", version: "25.1", arch: "arm64" }), cpu: ok({ model: "CPU", logicalProcessors: 4, usagePercent: 12.5 }), memory: ok({ usedBytes: 40, totalBytes: 100 }), disk: ok({ availableBytes: 60, totalBytes: 100 }), versions: { daynight: "0.41.0", herdr: ok("0.10.0"), codex: ok("1.0.0"), copilot: ok("1.0.0") },
  } } };
  it("preserves successful probes, assistant preflight and authorized task observations", () => {
    const parsed = parseWorkerDetail(complete, workerId);
    expect(parsed).toEqual(complete);
    const output = renderWorkerDetail(parsed);
    expect(output).toContain("CPU: CPU; 4 logical processors; 12.5% used");
    expect(output).toContain("Memory: 40/100 bytes used");
    expect(output).toContain("Disk: 60/100 bytes available");
    expect(output).toContain("Assistant hosting: protocol 1; stale;");
    expect(output).toContain("Assistant claude: available at preflight");
    expect(output).toContain("Phase: paused");
    expect(output).toContain("Agent: claude");
  });
  it("preserves the versioned creation capability and rejects unsupported versions", () => {
    const withHost = (assistantHost: unknown) => ({ ...complete, worker: { ...complete.worker, telemetry: { ...complete.worker.telemetry, assistantHost } } });
    expect(parseWorkerDetail(withHost({ ...host, creationConfigurationVersion: 1 }), workerId).worker.telemetry.assistantHost).toEqual({ ...host, creationConfigurationVersion: 1 });
    for (const creationConfigurationVersion of [null, 0, 2, "1"]) expect(() => parseWorkerDetail(withHost({ ...host, creationConfigurationVersion }), workerId)).toThrow();
  });
  it("marks an assistant report from the future stale", () => {
    const parsed = parseWorkerDetail({ ...complete, worker: { ...complete.worker, telemetry: { ...complete.worker.telemetry, assistantHost: { ...host, observedAt: "2026-11-04T10:00:01Z" } } } }, workerId);
    expect(renderWorkerDetail(parsed)).toContain("Assistant hosting: protocol 1; stale;");
  });
  it.each([
    { ...host, protocolVersion: 2 }, { ...host, defaultCwd: "relative" }, { ...host, providers: [host.providers[0]] },
    { ...host, providers: [host.providers[0], host.providers[0], host.providers[2]] },
    { ...host, providers: [{ ...host.providers[0], reason: "not_found" }, ...host.providers.slice(1)] },
    { ...host, providers: [host.providers[0], host.providers[1], { ...host.providers[2], args: ["--invalid"] }] },
  ])("rejects malformed or contradictory assistant host reports", assistantHost => {
    expect(() => parseWorkerDetail({ ...complete, worker: { ...complete.worker, telemetry: { ...complete.worker.telemetry, assistantHost } } }, workerId)).toThrow();
  });
  it("rejects duplicate task snapshots even when the reported count agrees", () => {
    expect(() => parseWorkerDetail({ ...complete, worker: { ...complete.worker, activeTaskCount: 2, tasks: [task, task] } }, workerId)).toThrow();
  });
});

describe("remote worker rendering", () => {
  it.each([
    ["2026-11-04T10:00:00.001Z", "offline"],
    ["2026-11-04T10:00:00.000Z", "online"],
    ["2026-11-04T09:58:00.001Z", "online"],
    ["2026-11-04T09:58:00.000Z", "offline"],
    ["2026-11-04T09:57:59.999Z", "offline"],
  ])("classifies a report at %s relative to server observation", (lastReportedAt, connection) => {
    const parsed = parseWorkerPage({ ...page, items: [{ ...summary, lastReportedAt }] });
    expect(renderWorkerList(parsed)).toContain(`Connection: ${connection} (at observation)`);
  });
  it("shows online as an observation and unknown inventory as unknown", () => {
    const output = renderWorkerDetail(parseWorkerDetail(detail, workerId));
    expect(output).toContain("Connection: online (at observation)");
    expect(output).toContain("Task inventory: unavailable");
    expect(output).toContain("Active tasks: unknown");
    expect(output).toContain("Assistant hosting: unsupported (not reported)");
    expect(output).toContain("Herdr: not_running");
    expect(output).toContain("Codex: not_installed");
    expect(output).not.toContain("idle");
    expect(output).toContain(`Observed: ${observedAt}`);
  });
  it("uses server observation time for the exact two-minute offline boundary", () => {
    const value = parseWorkerPage({ ...page, items: [{ ...summary, lastReportedAt: "2026-11-04T09:58:00Z", taskObservationState: "stale", taskObservedAt: "2026-11-04T09:57:00Z", activeTaskCount: 0 }] });
    const output = renderWorkerList(value);
    expect(output).toContain("Connection: offline (at observation)");
    expect(output).toContain("Task inventory: stale");
    expect(output).toContain("Active tasks: 0 (stale)");
  });
  it("does not report a future Worker heartbeat as online", () => {
    const parsed = parseWorkerPage({ ...page, items: [{ ...summary, lastReportedAt: "2026-11-04T10:00:01Z" }] });
    expect(renderWorkerList(parsed)).toContain("Connection: offline (at observation)");
  });
  it("escapes server-controlled terminal text", () => {
    const value = parseWorkerPage({ ...page, items: [{ ...summary, machine: { ...machine, name: "Machine\n\u001b[2J" } }] });
    const output = renderWorkerList(value);
    expect(output).toContain("Machine\\n\\u001b[2J");
    expect(output).not.toContain("\u001b");
  });
});

describe("remote worker command dispatch", () => {
  it.each([["list", "--help"], ["show", "--help"]])("renders help without local configuration or runtime: %j", async (...args) => {
    const cli = context();
    await runWorkerCommand(args, cli);
    expect(cli.stdout.mock.calls[0]![0]).toContain(`Usage: daynight worker ${args[0]}`);
    expect(cli.homeDirectory).not.toHaveBeenCalled();
    expect(cli.workingDirectory).not.toHaveBeenCalled();
  });
  it.each([["show", "bad"], ["list", "--project", workerId], ["show"], ["list", "extra"]])("rejects invalid input without local runtime: %j", async (...args) => {
    const cli = context();
    await expect(runWorkerCommand(args, cli)).rejects.toBeInstanceOf(UsageError);
    expect(cli.homeDirectory).not.toHaveBeenCalled();
    expect(cli.workingDirectory).not.toHaveBeenCalled();
  });
  it("prints complete remote list JSON without consulting cwd or interpreting unknown inventory", async () => {
    const cli = context();
    const parsed = parseWorkerPage(page);
    const api = { listWorkers: vi.fn(async () => ({ observedAt: parsed.observedAt, items: parsed.items })), getWorker: vi.fn() };
    const operation = createOperation();
    const deps: WorkerQueryDependencies = { runServerCommand: async (current, action) => {
      const output = await action({ api, operation });
      current.stdout(output);
    } };
    try { await runWorkerQuery({ kind: "list", json: true }, cli, deps); }
    finally { operation.dispose(); }
    expect(JSON.parse(cli.stdout.mock.calls[0]![0])).toEqual({ observedAt, items: [summary] });
    expect(cli.workingDirectory).not.toHaveBeenCalled();
  });
  it.each([false, true])("does not expose local transport causes with json=%s", async json => {
    const cli = context();
    const cause = new ApiError({ operation: "worker.show" }, "request", { cause: new Error("secret-token embedded in transport failure") });
    const deps: WorkerQueryDependencies = { runServerCommand: async () => { throw cause; } };
    const failure = await runWorkerQuery({ kind: "show", workerId, json }, cli, deps).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PublicDiagnosticError);
    expect(formatError(failure)).not.toContain("secret-token");
    if (json) expect(JSON.parse(formatError(failure))).toEqual({ error: { operation: "worker.show", workerId, phase: "request", outcomeUnconfirmed: false } });
    else expect(formatError(failure)).toContain("worker.show failed");
    expect(cli.stdout).not.toHaveBeenCalled();
  });
  it("preserves a remote failure without printing partial success", async () => {
    const cli = context();
    const failure = new Error("Later page failed");
    const operation = createOperation();
    const deps: WorkerQueryDependencies = { runServerCommand: async (current, action) => {
      const output = await action({ api: { listWorkers: async () => { throw failure; }, getWorker: vi.fn() }, operation });
      current.stdout(output);
    } };
    try { await expect(runWorkerQuery({ kind: "list", json: false }, cli, deps)).rejects.toMatchObject({ cause: failure, exitCode: 1 }); }
    finally { operation.dispose(); }
    expect(cli.stdout).not.toHaveBeenCalled();
  });
});
