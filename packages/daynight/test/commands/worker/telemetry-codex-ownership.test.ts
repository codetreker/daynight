import path from "node:path";
import { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import { createWorkerBotHost } from "../../../src/commands/worker/bots/host.js";
import { createAssistantHostCollector } from "../../../src/commands/worker/bots/host-capabilities.js";
import type * as CodexProbeModule from "../../../src/commands/worker/codex-probe-owner.js";
import { createCodexProbeOwner } from "../../../src/commands/worker/codex-probe-owner.js";
import { OwnedCommandCleanupError } from "../../../src/commands/worker/owned-command.js";
import type * as OwnedCommandModule from "../../../src/commands/worker/owned-command.js";
import type { OwnedCommand, OwnedCommandResult } from "../../../src/commands/worker/owned-command.js";
import { createWorkerReporter } from "../../../src/commands/worker/reporter.js";
import { createWorkerTelemetryCollector } from "../../../src/commands/worker/telemetry.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";

const mocks = vi.hoisted(() => ({ ordinary: vi.fn(), assistant: vi.fn(), cpus: vi.fn() }));
const environment = { PATH: "/fixture/bin" };
vi.mock("node:os", () => ({ type: () => "Fixture", release: () => "1", version: () => "1", arch: () => "arm64", cpus: mocks.cpus, totalmem: () => 1024, freemem: () => 256 }));
vi.mock("node:fs/promises", () => ({ realpath: async (value: string) => value, stat: async () => ({ isDirectory: () => true }), access: async () => {}, statfs: async () => ({ blocks: 100n, bavail: 25n, bsize: 4096n }) }));
vi.mock("../../../src/commands/controller/providers/copilot-runtime.js", () => ({ copilotExecutable: () => "/fixture/bundled/copilot" }));
vi.mock("../../../src/commands/worker/owned-command.js", async original => ({ ...await original<object>(), runOwnedCommand: (command: OwnedCommand, operation: Operation) => command.environment.DN_CONFIG_DIR === undefined ? mocks.ordinary(command, operation) : mocks.assistant(command, operation), spawnOwnedProcess: () => { throw new Error("Native spawning is forbidden in this fixture."); } }));

vi.mock("../../../src/commands/worker/diagnostics.js", () => ({ workerSqliteMigrationReporter: () => () => undefined }));
vi.mock("../../../src/commands/worker/bots/local-store.js", () => ({ openLocalBotStores: () => ({ store: { close: () => {} }, executions: { close: () => {} }, close: () => {} }) }));
vi.mock("../../../src/commands/worker/bots/process.js", () => ({ createBotProcess: () => ({ close: async () => {} }) }));
vi.mock("../../../src/commands/worker/bots/delete.js", () => ({ createBotDeletion: () => ({}) }));
vi.mock("../../../src/commands/worker/bots/remote.js", () => ({ createBotRemote: () => ({}) }));
vi.mock("../../../src/commands/worker/bots/session-api.js", () => ({ createBotSessionApi: () => ({}) }));
vi.mock("../../../src/commands/worker/bots/assistant-task-session.js", () => ({ createAssistantTaskSessionTransport: () => ({ send: () => { throw new Error("Notification delivery is outside this telemetry fixture."); }, readOperation: () => { throw new Error("Notification recovery is outside this telemetry fixture."); } }) }));
vi.mock("../../../src/commands/worker/bots/runtime.js", () => ({ createManagedAssistantRuntime: () => ({ closeAdmission: () => {}, snapshot: () => ({}), run: async () => {}, shutdown: async () => {} }) }));

// Only environment capture uses synthetic Windows semantics; all command and OS effects remain mocked.
vi.mock("../../../src/commands/worker/codex-probe-owner.js", async original => {
  const actual = await original<typeof CodexProbeModule>();
  return { ...actual, captureCodexProbeEnvironment: (environment: NodeJS.ProcessEnv) => actual.captureCodexProbeEnvironment(environment, "win32") };
});

let originalEnvironment: NodeJS.ProcessEnv;
const operations: Operation[] = [];
const hosts: ReturnType<typeof createWorkerBotHost>[] = [];
const operation = () => { const result = createOperation({ limits: { totalMs: 15_000 } }); operations.push(result); return result; };
const cwd = path.resolve("fixture-startup");
const output = async (command: OwnedCommand): Promise<OwnedCommandResult> => {
  const executable = path.win32.basename(command.file).replace(/\.exe$/i, "");
  return { stderr: "", stdout: command.args.includes("--version")
    ? executable === "codex" ? "codex-cli 0.1.0" : executable === "claude" ? "2.1.247 (Claude Code)" : "GitHub Copilot CLI 1.0.83"
    : executable === "codex" ? "app-server --stdio" : executable === "claude" ? "--input-format --output-format --include-partial-messages" : "--no-auto-update" };
};
const collector = (overrides: Partial<Parameters<typeof createAssistantHostCollector>[0]> = {}) => createWorkerTelemetryCollector({
  paths: resolveWorkerPaths(path.resolve("fixture-home")), homeDirectory: path.resolve("fixture-home"), version: "1.2.3", workingDirectory: cwd, machine: { id: "fixture", name: "Fixture" }, platform: "linux", workerId: "fixture-worker", serverOrigin: "https://daynight.example",
  assistantHost: createAssistantHostCollector({ workingDirectory: cwd, configuration: { agent: "copilot", model: null, args: [], agentControlMode: "web", recoveryLimit: 3 }, environment,
    resolveExecutable: provider => provider === "codex" ? provider : `/fixture/bundled/${provider}`, runCommand: mocks.assistant, ...overrides }),
});
const finish = async <T>(pending: Promise<T>, ms = 210) => { await vi.advanceTimersByTimeAsync(ms); return pending; };
const calls = (mock: typeof mocks.ordinary, file: string) => mock.mock.calls.filter(([command]) => (command as OwnedCommand).file === file).length;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  originalEnvironment = process.env;
  process.env = { ...environment };
  let tick = 0;
  mocks.cpus.mockImplementation(() => [{ model: "Fixture CPU", times: { idle: ++tick * 80, user: tick * 20 } }]);
  mocks.ordinary.mockImplementation(output); mocks.assistant.mockImplementation(output);
});
afterEach(async () => { operations.splice(0).forEach(value => value.dispose()); await Promise.all(hosts.splice(0).map(host => host.close())); vi.unstubAllEnvs(); process.env = originalEnvironment; vi.restoreAllMocks(); vi.useRealTimers(); });

describe("composed Codex probe ownership", () => {
  it("blocks assistant version/help after ordinary cleanup uncertainty and preserves the original error", async () => {
    const failure = new OwnedCommandCleanupError([new Error("private cleanup detail")], undefined);
    mocks.ordinary.mockImplementation(async command => { if (command.file === "codex") throw failure; return output(command); });
    const instance = collector();
    const first = await finish(instance.collect(operation())); const second = await finish(instance.collect(operation()));
    expect(calls(mocks.ordinary, "codex")).toBe(1); expect(calls(mocks.assistant, "codex")).toBe(0);
    expect(first.telemetry.assistantHost?.providers[0]).toMatchObject({ available: false, reason: "unavailable" });
    expect(second.issues.filter(issue => issue.component.includes("codex")).every(issue => issue.error === failure)).toBe(true);
    expect(second.telemetry.assistantHost?.providers.slice(1).every(provider => provider.available)).toBe(true);
    expect(second.telemetry.versions.copilot.state).toBe("ok"); expect(JSON.stringify(second.telemetry)).not.toContain("private cleanup detail");
  });
  it.each(["--version", "--help"])("blocks ordinary probes after assistant %s cleanup, before and after cache expiry", async phase => {
    let monotonic = 0; vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const failure = new OwnedCommandCleanupError([new Error("owned fixture cleanup")], undefined);
    mocks.assistant.mockImplementation(async command => { if (command.file === "codex" && command.args.includes(phase)) throw failure; return output(command); });
    const instance = collector(); await finish(instance.collect(operation())); const cached = await finish(instance.collect(operation()));
    monotonic = 60_001; const expired = await finish(instance.collect(operation()));
    expect(calls(mocks.ordinary, "codex")).toBe(1); expect(calls(mocks.assistant, "codex")).toBe(phase === "--version" ? 1 : 2);
    expect(cached.telemetry.versions.codex.state).toBe("error"); expect(expired.telemetry.versions.codex).toMatchObject({ state: "error", code: "unavailable" });
    expect(expired.issues.filter(issue => issue.component.includes("codex")).every(issue => issue.error === failure)).toBe(true);
    expect(calls(mocks.ordinary, "copilot")).toBe(2); expect(expired.telemetry.assistantHost?.providers.slice(1).every(provider => provider.available)).toBe(true);
  });
  it.each([{ environment: { PATH: "/fixture/other-bin" } }, { workingDirectory: path.resolve("fixture-other-startup") }, { resolveExecutable: (provider: string) => `/fixture/separate/${provider}` }])("keeps nonmatching Codex invocation independent: %j", async overrides => {
    const failure = new OwnedCommandCleanupError([new Error("owned fixture cleanup")], undefined);
    mocks.ordinary.mockImplementation(async command => { if (command.file === "codex") throw failure; return output(command); });
    const sample = await finish(collector(overrides).collect(operation()));
    expect(sample.telemetry.assistantHost?.providers.every(provider => provider.available)).toBe(true); expect(mocks.assistant).toHaveBeenCalledTimes(6);
  });
  it("joins an owned command before reporter stop returns and never starts its queued assistant replacement", async () => {
    const failure = new OwnedCommandCleanupError([new Error("owned fixture cleanup")], undefined);
    let rejectCodex!: (error: unknown) => void;
    mocks.ordinary.mockImplementation(command => command.file === "codex" ? new Promise((_, reject) => { rejectCodex = reject; }) : output(command));
    const instance = collector(); const send = vi.fn();
    const reporter = createWorkerReporter({ signal: new AbortController().signal, collect: parent => instance.collect(parent), send, emit: () => {} });
    await vi.advanceTimersByTimeAsync(210); expect(calls(mocks.assistant, "codex")).toBe(0);
    let stopped = false;
    const pending = reporter.stop().then(() => { stopped = true; return undefined; }, error => { stopped = true; return error; });
    await vi.advanceTimersByTimeAsync(0); expect(stopped).toBe(false); rejectCodex(failure);
    const result = await pending;
    expect(result).toBeInstanceOf(AggregateError); expect((result as AggregateError).errors).toContain(failure);
    expect(calls(mocks.assistant, "codex")).toBe(0); expect(send).not.toHaveBeenCalled();
  });
  it.each(["ordinary", "assistant"])("retains the exact %s cleanup error at reporter stop after a partial report", async origin => {
    const failure = new OwnedCommandCleanupError([new Error("owned fixture cleanup")], undefined);
    const runner = origin === "ordinary" ? mocks.ordinary : mocks.assistant;
    runner.mockImplementation(async command => { if (command.file === "codex") throw failure; return output(command); });
    const instance = collector();
    const send = vi.fn(async () => ({ observedAt: "2026-11-04T00:00:00Z", lastReportedAt: "2026-11-04T00:00:00Z" }));
    const reporter = createWorkerReporter({ signal: new AbortController().signal, collect: parent => instance.collect(parent), send, emit: () => {} });
    await vi.advanceTimersByTimeAsync(210);
    expect(send).toHaveBeenCalledOnce();
    await expect(reporter.stop()).rejects.toBe(failure);
  });
  it("omits inherited agent session markers from native version probes", async () => {
    const markers = ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_TOOL_CALL_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];
    for (const marker of markers) vi.stubEnv(marker, "session-marker");
    await finish(collector().collect(operation()));
    for (const [command] of mocks.ordinary.mock.calls) {
      for (const marker of markers) expect(command.environment).not.toHaveProperty(marker);
    }
    for (const marker of markers) expect(process.env[marker]).toBe("session-marker");
  });
  it("forwards the Node-selected captured search keys only to bare Codex launch commands", async () => {
    const ordinary = { Path: "C:\\ignored", PATH: "C:\\selected", Pathext: ".EXE;.JS", PATHEXT: ".EXE", FIXTURE: "ordinary" };
    const assistant = { PATH: "C:\\selected", Path: "C:\\other", PATHEXT: ".EXE", Pathext: ".JS", FIXTURE: "assistant" };
    for (const [key, value] of Object.entries(ordinary)) vi.stubEnv(key, value);
    await finish(collector({ environment: assistant }).collect(operation()));
    const expected = { PATH: "C:\\selected", PATHEXT: ".EXE" };
    const ordinaryCodex = mocks.ordinary.mock.calls.find(([command]) => command.file === "codex")![0].environment;
    expect(ordinaryCodex).toMatchObject({ ...expected, FIXTURE: "ordinary" });
    expect(ordinaryCodex).not.toHaveProperty("Path");
    expect(ordinaryCodex).not.toHaveProperty("Pathext");
    expect(calls(mocks.assistant, "codex")).toBe(2);
    for (const [command] of mocks.assistant.mock.calls.filter(([command]) => command.file === "codex")) expect(command.environment).toEqual({ ...expected, FIXTURE: "assistant" });
    expect(mocks.ordinary.mock.calls.find(([command]) => command.file === "copilot")![0].environment).toMatchObject(ordinary);
    for (const [command] of mocks.assistant.mock.calls.filter(([command]) => command.file !== "codex")) expect(command.environment).toEqual(assistant);
    expect(ordinary.Path).toBe("C:\\ignored"); expect(assistant.Path).toBe("C:\\other");
    mocks.assistant.mockClear();
    await finish(collector({ environment: assistant, resolveExecutable: provider => `/fixture/separate/${provider}` }).collect(operation()));
    expect(mocks.assistant.mock.calls.find(([command]) => command.file.endsWith("codex"))![0].environment).toEqual(assistant);
  });
  it.each(["ordinary", "assistant"])("shares mixed-case Windows search inputs after %s cleanup failure", async origin => {
    let monotonic = 0; vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const failure = new OwnedCommandCleanupError([new Error("owned fixture cleanup")], undefined);
    for (const [key, value] of Object.entries({ Path: "C:\\ignored", PATH: "C:\\selected", Pathext: ".JS", PATHEXT: ".EXE" })) vi.stubEnv(key, value);
    const runner = origin === "ordinary" ? mocks.ordinary : mocks.assistant;
    runner.mockImplementation(async command => { if (command.file === "codex") throw failure; return output(command); });
    const instance = collector({ environment: { PATH: "C:\\selected", Path: "C:\\other", PATHEXT: ".EXE", Pathext: ".JS" } });
    await finish(instance.collect(operation())); monotonic = 60_001;
    const second = await finish(instance.collect(operation()));
    expect(calls(mocks.ordinary, "codex")).toBe(1);
    expect(calls(mocks.assistant, "codex")).toBe(origin === "ordinary" ? 0 : 1);
    expect(second.issues.filter(issue => issue.component.includes("codex")).every(issue => issue.error === failure)).toBe(true);
    expect(second.telemetry.assistantHost?.providers.slice(1).every(provider => provider.available)).toBe(true);
  });
  it("serializes matching chains, retries ordinary errors, and checks cancellation before starting a queued probe", async () => {
    const owner = createCodexProbeOwner(environment, cwd); const invocation = { file: "codex", environment, workingDirectory: cwd };
    let rejectFirst!: (error: unknown) => void; const firstError = new Error("ordinary failure");
    const first = owner.observe(invocation, operation(), () => new Promise((_, reject) => { rejectFirst = reject; })).catch(error => error);
    const cancellation = new AbortController(); const cancelled = createOperation({ signal: cancellation.signal }); operations.push(cancelled);
    const next = vi.fn(async () => "unexpected"); const second = owner.observe(invocation, cancelled, next).catch(error => error);
    await vi.advanceTimersByTimeAsync(0); expect(next).not.toHaveBeenCalled(); cancellation.abort(); rejectFirst(firstError);
    expect(await first).toBe(firstError); expect(await second).toBe(cancelled.signal.reason); expect(next).not.toHaveBeenCalled();
    expect(await owner.observe(invocation, operation(), async () => "retry")).toBe("retry");
  });
});


// Keep the production host and both collectors in the closure; only stores, remotes and command effects are replaced.
describe("production Bot host Codex ownership", () => {
  const instance = () => {
    const searchEnvironment = { ...environment, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    vi.stubEnv("PATH", searchEnvironment.PATH);
    vi.stubEnv("PATHEXT", searchEnvironment.PATHEXT);
    const paths = resolveWorkerPaths(path.resolve("fixture-home"));
    const host = createWorkerBotHost({ homeDirectory: path.resolve("fixture-home"), packageDirectory: path.resolve("fixture-package"), workingDirectory: cwd, paths,
      owner: { serverOrigin: "https://daynight.example", ownerUserId: "00000000-0000-4000-8000-000000000001", workerId: "00000000-0000-4000-8000-000000000002" }, serverToken: "fixture-placeholder", emit: () => {},
      configuration: () => ({ agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 3 }), canAdmitNewExecution: () => true, pollIntervalMs: () => 1000, recoveryLimit: () => 3 });
    hosts.push(host);
    return createWorkerTelemetryCollector({ paths, homeDirectory: path.resolve("fixture-home"), version: "1.2.3", workingDirectory: cwd,
      machine: { id: "fixture", name: "Fixture" }, platform: "linux", workerId: "00000000-0000-4000-8000-000000000002", serverOrigin: "https://daynight.example", assistantHost: host });
  };
  const originalCleanup = async (terminationFailure = false) => {
    const actual = await vi.importActual<typeof OwnedCommandModule>("../../../src/commands/worker/owned-command.js");
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const child = new ChildProcess();
    if (terminationFailure) Object.defineProperty(child, "pid", { get: () => { throw new Error("Fixture termination failed"); } });
    const op = createOperation({ limits: { totalMs: 100, requestMs: 20 } });
    try {
      const pending = actual.runOwnedCommand({ file: "codex", args: ["--version"], environment: {} }, op, () => child, { cleanupWithinDeadline: true }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(110);
      const failure = await pending;
      expect(failure).toBeInstanceOf(OwnedCommandCleanupError);
      expect(actual.hasUnconfirmedOwnedCommandCleanup(failure)).toBe(true);
      return { child, failure, unconfirmed: actual.hasUnconfirmedOwnedCommandCleanup };
    } finally { op.dispose(); }
  };

  it.each(["ordinary", "assistant version", "assistant help"])("blocks matching chains after %s uncertainty and releases only after original close", async origin => {
    const original = await originalCleanup();
    const runner = origin === "ordinary" ? mocks.ordinary : mocks.assistant;
    let failed = false;
    runner.mockImplementation(async (command: OwnedCommand) => {
      if (command.file === "codex" && !failed && (origin !== "assistant help" || command.args.includes("--help"))) { failed = true; throw original.failure; }
      return output(command);
    });
    const telemetry = instance();
    await finish(telemetry.collect(operation()));
    const blocked = await finish(telemetry.collect(operation()));
    expect(blocked.telemetry.versions.codex).toMatchObject({ state: "error", code: "unavailable" });
    expect(blocked.telemetry.assistantHost?.providers[0]).toMatchObject({ available: false, reason: "unavailable" });
    expect(blocked.issues.filter(issue => issue.component.includes("codex")).every(issue => issue.error === original.failure)).toBe(true);
    const ordinaryCalls = calls(mocks.ordinary, "codex"), assistantCalls = calls(mocks.assistant, "codex");
    original.child.emit("exit", 0, null);
    await finish(telemetry.collect(operation()));
    expect(calls(mocks.ordinary, "codex")).toBe(ordinaryCalls); expect(calls(mocks.assistant, "codex")).toBe(assistantCalls);
    original.child.emit("close", 0, null);
    expect(original.unconfirmed(original.failure)).toBe(false);
    const recovered = await finish(telemetry.collect(operation()));
    expect(recovered.telemetry.versions.codex).toMatchObject({ state: "ok", value: "0.1.0" });
    expect(recovered.telemetry.assistantHost?.providers[0]!.available).toBe(true);
    expect(calls(mocks.ordinary, "codex")).toBe(ordinaryCalls + 1); expect(calls(mocks.assistant, "codex")).toBe(assistantCalls + 2);
  });

  it("invalidates ordinary success when assistant cleanup confirms before the next collection", async () => {
    const original = await originalCleanup(); let failed = false;
    mocks.assistant.mockImplementation(async (command: OwnedCommand) => {
      if (command.file === "codex" && !failed) { failed = true; throw original.failure; }
      return output(command);
    });
    const telemetry = instance(); const first = await finish(telemetry.collect(operation()));
    expect(first.telemetry.versions.codex.state).toBe("ok");
    original.child.emit("close", 0, null);
    const recovered = await finish(telemetry.collect(operation()));
    expect(calls(mocks.ordinary, "codex")).toBe(2);
    expect(recovered.telemetry.versions.codex.checkedAt).not.toBe(first.telemetry.versions.codex.checkedAt);
    expect(recovered.telemetry.assistantHost?.providers[0]!.available).toBe(true);
  });

  it("retains matching termination failure after close while unrelated providers continue", async () => {
    const original = await originalCleanup(true);
    mocks.ordinary.mockImplementation(async (command: OwnedCommand) => { if (command.file === "codex") throw original.failure; return output(command); });
    const telemetry = instance(); await finish(telemetry.collect(operation())); original.child.emit("close", 0, null);
    const blocked = await finish(telemetry.collect(operation()));
    expect(original.unconfirmed(original.failure)).toBe(true);
    expect(calls(mocks.ordinary, "codex")).toBe(1); expect(calls(mocks.assistant, "codex")).toBe(0);
    expect(blocked.telemetry.assistantHost?.providers.slice(1).every(provider => provider.available)).toBe(true);
  });
});
