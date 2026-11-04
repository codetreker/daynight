import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import { herdrRunDirectory } from "../../../src/commands/worker/herdr/durable.js";
import { resolveHerdrInstancePaths } from "../../../src/commands/worker/herdr/instance.js";
import { openHerdrLifecycleStore } from "../../../src/commands/worker/herdr/lifecycle-store.js";
import type { HerdrLifecycleRecord, MacProcessIdentity } from "../../../src/commands/worker/herdr/lifecycle-types.js";
import { createHerdrRuntimeVersionObserver, HerdrVersionUnavailableError } from "../../../src/commands/worker/herdr/runtime-version.js";
import { createWorkerTelemetryCollector } from "../../../src/commands/worker/telemetry.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), observe: vi.fn(), peer: vi.fn(), native: vi.fn(), version: vi.fn(), execution: vi.fn(), stat: vi.fn() }));
vi.mock("node:fs/promises", async original => ({ ...await original<object>(), stat: (...args: unknown[]) => mocks.stat(...args) }));
vi.mock("../../../src/commands/worker/herdr/rpc.js", async original => ({ ...await original<object>(), createHerdrRpcClient: (endpoint: string) => ({ request: (method: string, params: unknown, operation: Operation) => mocks.rpc(endpoint, method, params, operation) }) }));
vi.mock("../../../src/commands/worker/herdr/native-macos.js", () => ({ createMacProcessControl: mocks.native }));
vi.mock("../../../src/commands/worker/herdr/version-probe.js", async original => ({ ...await original<object>(), probeNativeAgentVersion: mocks.version }));
vi.mock("../../../src/commands/worker/herdr.js", async original => ({ ...await original<object>(), createWorkerHerdr: mocks.execution }));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = { projectId: uuid(1), taskId: uuid(2), workerId: uuid(3), worktreeId: uuid(4), ownerUserId: uuid(5), serverOrigin: "https://daynight.example", provider: "codex" as const };
const roots: string[] = [], operations: Operation[] = [];
const operation = (totalMs = 5_000, signal?: AbortSignal) => {
  const result = createOperation({ limits: { totalMs }, ...(signal === undefined ? {} : { signal }) }); operations.push(result); return result;
};
const daemon = (pid: number): MacProcessIdentity => ({ role: "daemon", pid, birthToken: `1700000000:${pid}`, bootId: "fixture-boot", auditToken: [501, 501, 20, 501, 20, pid, 100000, pid + 100], ppid: 1, pgid: pid, sid: pid });
const fixture = () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/herdr-runtime-version"); mkdirSync(base, { recursive: true });
  const home = mkdtempSync(path.join(base, "run-")); roots.push(home);
  // Only RPC is mocked; short synthetic endpoints exercise the production socket path builder.
  const paths = { ...resolveWorkerPaths(home), herdrDirectory: "/herdr", logsDirectory: "/herdr/logs" };
  mkdirSync(paths.workerDirectory, { recursive: true });
  const journal = path.join(paths.workerDirectory, "herdr-executions.sqlite");
  const options = { paths, platform: "macos" as const, workerId: owner.workerId, serverOrigin: owner.serverOrigin };
  const add = (n = 1, change?: (record: HerdrLifecycleRecord) => void, withIdentity = true) => {
    const store = openHerdrLifecycleStore(journal, { onMigration: () => {} });
    try {
      let record = store.create({ owner: { ...owner, taskId: uuid(100 + n) }, claimId: uuid(200 + n), cwd: home });
      record = store.update(record, draft => {
        draft.initialPrompt = "private assignment content";
        draft.runs.push({ run: { executionGeneration: "1", owner: draft.owner, binding: { instanceId: uuid(300 + n), sessionId: "w", workspaceId: "workspace", paneId: "pane", terminalId: "terminal", nativeSessionId: null }, startedAt: "2026-11-04T00:00:00.000Z", stoppedAt: null, stopProof: null, segmentIds: [] }, phase: "prepared", instanceDirectory: herdrRunDirectory(paths.herdrDirectory, uuid(300 + n)), daemon: withIdentity ? daemon(100 + n) : null, processes: [], stopOperationId: null, stopReason: null, error: null, admission: null });
      });
      if (change) record = store.update(record, change);
      return record;
    } finally { store.close(); }
  };
  const collect = () => createWorkerTelemetryCollector({ ...options, homeDirectory: home, version: "0.40.0", workingDirectory: home, machine: { id: "fixture", name: "Fixture" } });
  return { home, paths, journal, options, add, collect, observer: () => createHerdrRuntimeVersionObserver(options) };
};
const endpoint = (record: HerdrLifecycleRecord) => resolveHerdrInstancePaths({ herdrDirectory: record.runs[0]!.instanceDirectory, logsDirectory: "/herdr/logs" }).apiEndpoint;
const absent = () => new Error("RPC connection failed", { cause: Object.assign(new Error("absent"), { code: "ENOENT" }) });

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.stat.mockImplementation((await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).stat);
  mocks.version.mockResolvedValue("1.0.0");
  mocks.observe.mockResolvedValue("same");
  mocks.native.mockReturnValue({ observe: mocks.observe, peer: mocks.peer });
  mocks.rpc.mockRejectedValue(absent());
  mocks.execution.mockImplementation(() => { throw new Error("Telemetry must not initialize execution resources."); });
});
afterEach(() => {
  operations.splice(0).forEach(op => op.dispose());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  vi.useRealTimers();
});

describe("read-only durable Herdr runtime versions", () => {
  it("reports the real per-run ping through telemetry and never queries the abandoned shared daemon", async () => {
    const f = fixture(), record = f.add(), original = readFileSync(f.journal), entries = readdirSync(f.paths.workerDirectory);
    mocks.peer.mockResolvedValue(record.runs[0]!.daemon);
    mocks.rpc.mockImplementation(async address => ({ type: "pong", version: address === endpoint(record) ? "0.9.5" : "0.1.0" }));
    const sample = await f.collect().collect(operation());
    expect(sample.telemetry.versions.herdr).toMatchObject({ state: "ok", value: "0.9.5" });
    expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual([endpoint(record)]);
    expect(mocks.rpc).toHaveBeenCalledWith(endpoint(record), "ping", {}, expect.anything());
    expect(mocks.peer).toHaveBeenCalledTimes(2);
    expect(mocks.execution).not.toHaveBeenCalled();
    expect(readFileSync(f.journal)).toEqual(original);
    // SQLite may create WAL coordination files even for a read-only connection.
    expect(readdirSync(f.paths.workerDirectory).filter(name => !name.endsWith("-shm") && !name.endsWith("-wal"))).toEqual(entries);
    expect(JSON.stringify(sample.telemetry)).not.toContain("private assignment content");
    expect(JSON.stringify(sample.telemetry)).not.toContain(record.claimId);
    expect(JSON.stringify(sample.telemetry)).not.toContain(record.runs[0]!.instanceDirectory);
  });

  it("keeps optional assistant observations alongside the owned durable daemon version", async () => {
    const f = fixture(), record = f.add(), original = readFileSync(f.journal);
    mocks.peer.mockResolvedValue(record.runs[0]!.daemon);
    mocks.rpc.mockResolvedValue({ type: "pong", version: "0.9.5" });
    const assistantHost = { protocolVersion: 1 as const, observedAt: "2026-11-04T00:00:00Z", defaultCwd: f.home, defaultProvider: "codex" as const,
      providers: (["codex", "claude", "copilot"] as const).map(provider => ({ provider, available: false, reason: "unavailable" as const, model: null, args: [] })) };
    const assistant = { collect: vi.fn(async (parent: Operation) => { parent.check(); return { assistantHost, issues: [] }; }) };
    const parent = operation();
    const sample = await createWorkerTelemetryCollector({ ...f.options, homeDirectory: f.home, version: "0.41.0", workingDirectory: f.home,
      machine: { id: "fixture", name: "Fixture" }, assistantHost: assistant }).collect(parent);
    expect(sample.telemetry.versions.herdr).toMatchObject({ state: "ok", value: "0.9.5" });
    expect(sample.telemetry.assistantHost).toEqual(assistantHost);
    expect(assistant.collect).toHaveBeenCalledExactlyOnceWith(parent);
    expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual([endpoint(record)]);
    expect(readFileSync(f.journal)).toEqual(original);
    expect(mocks.execution).not.toHaveBeenCalled();
  });

  it("reports no live run without consulting a retained shared daemon", async () => {
    const f = fixture(), store = openHerdrLifecycleStore(f.journal, { onMigration: () => {} }); store.close();
    mocks.rpc.mockResolvedValue({ type: "pong", version: "0.1.0" });
    const sample = await f.collect().collect(operation());
    expect(sample.telemetry.versions.herdr.state).toBe("not_running");
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
  });

  it.each(["0.9.5", "0.9.6"])("requires all live versions to agree when another run reports %s", async version => {
    const f = fixture(), first = f.add(1), second = f.add(2);
    mocks.peer.mockImplementation(async address => address === endpoint(first) ? first.runs[0]!.daemon : second.runs[0]!.daemon);
    mocks.rpc.mockImplementation(async address => ({ type: "pong", version: address === endpoint(first) ? "0.9.5" : version }));
    const sample = await f.collect().collect(operation());
    expect(sample.telemetry.versions.herdr).toMatchObject(version === "0.9.5" ? { state: "ok", value: version } : { state: "error", code: "unavailable" });
    expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual([endpoint(first), endpoint(second)]);
  });

  it("ignores an exited original daemon", async () => {
    const f = fixture(); f.add(); mocks.observe.mockResolvedValue("exited");
    expect(await f.observer().observe(operation())).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.peer).not.toHaveBeenCalled();
  });

  it("ignores confirmed stops and other service or Worker owners", async () => {
    const f = fixture();
    const stopped = f.add(1, draft => { const run = draft.runs[0]!; run.phase = "stop_intent"; run.stopOperationId = uuid(500); run.stopReason = "terminal"; run.processes = [{ ...daemon(102), role: "shell" }, { ...daemon(103), role: "agent" }]; });
    const store = openHerdrLifecycleStore(f.journal, { onMigration: () => {} });
    try { store.update(stopped, draft => {
      const local = draft.runs[0]!; local.phase = "stopped_confirmed"; local.run.stoppedAt = "2026-11-04T00:01:00.000Z";
      local.run.stopProof = { recordId: local.stopOperationId!, executionGeneration: "1", binding: local.run.binding, bootId: local.daemon!.bootId, stoppedAt: local.run.stoppedAt, method: "instances_exited", terminalStopped: true, processes: local.processes.map(({ role, pid, birthToken, bootId }) => ({ role: role as "shell" | "agent", pid, birthToken, bootId })) };
    }); } finally { store.close(); }
    f.add(2);
    expect(await createHerdrRuntimeVersionObserver({ ...f.options, workerId: uuid(999) }).observe(operation())).toBeNull();
    expect(await createHerdrRuntimeVersionObserver({ ...f.options, serverOrigin: "https://other.example" }).observe(operation())).toBeNull();
    mocks.observe.mockResolvedValue("exited");
    expect(await f.observer().observe(operation())).toBeNull();
    expect(mocks.observe).toHaveBeenCalledTimes(1); expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("observes a still-live stop_unknown run without changing its control state", async () => {
    const f = fixture(), record = f.add(1, draft => { draft.runs[0]!.phase = "stop_unknown"; });
    const bytes = readFileSync(f.journal);
    mocks.peer.mockResolvedValue(record.runs[0]!.daemon); mocks.rpc.mockResolvedValue({ type: "pong", version: "0.9.5" });
    expect(await f.observer().observe(operation())).toBe("0.9.5"); expect(readFileSync(f.journal)).toEqual(bytes);
  });

  it.each(["unknown", "changed", "missing-identity", "missing-socket", "replaced-peer", "changed-after-ping"])("reports unavailable for %s instead of trusting an unrelated version", async mode => {
    const f = fixture(), record = f.add(1, undefined, mode !== "missing-identity");
    const original = record.runs[0]!.daemon;
    mocks.observe.mockResolvedValue(mode === "unknown" || mode === "changed" ? mode : "same");
    mocks.peer.mockResolvedValue(mode === "replaced-peer" ? daemon(999) : original);
    if (mode === "changed-after-ping") mocks.peer.mockResolvedValueOnce(original).mockResolvedValueOnce(daemon(999));
    if (mode !== "missing-socket") mocks.rpc.mockResolvedValue({ type: "pong", version: "0.9.5" });
    const sample = await f.collect().collect(operation());
    expect(sample.telemetry.versions.herdr).toMatchObject({ state: "error", code: "unavailable" });
    expect(sample.issues.find(issue => issue.component === "herdr")?.error).toBeInstanceOf(HerdrVersionUnavailableError);
  });

  it("observes captured preparation daemons and refuses an unconfirmed launch with no identity", async () => {
    const f = fixture(), store = openHerdrLifecycleStore(f.journal, { onMigration: () => {} });
    let record: HerdrLifecycleRecord;
    try {
      record = store.create({ owner, claimId: uuid(6), cwd: f.home });
      record = store.update(record, draft => { draft.preparation = { instanceId: uuid(7), instanceDirectory: herdrRunDirectory(f.paths.herdrDirectory, uuid(7)), phase: "prepared", daemon: null }; });
      expect(await f.observer().observe(operation())).toBeNull();
      record = store.update(record, draft => { draft.preparation!.phase = "launch_requested"; });
      await expect(f.observer().observe(operation())).rejects.toBeInstanceOf(HerdrVersionUnavailableError);
      store.update(record, draft => { draft.preparation!.daemon = daemon(101); });
      mocks.peer.mockResolvedValue(daemon(101)); mocks.rpc.mockResolvedValue({ type: "pong", version: "0.9.5" });
      expect(await f.observer().observe(operation())).toBe("0.9.5");
    } finally { store.close(); }
  });

  it("preserves journal filesystem errors without falling back to the shared endpoint", async () => {
    const f = fixture(); mocks.stat.mockRejectedValue(Object.assign(new Error("private journal details"), { code: "EACCES" }));
    const sample = await f.collect().collect(operation());
    expect(sample.telemetry.versions.herdr).toMatchObject({ state: "error", code: "permission_denied" });
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
    expect(JSON.stringify(sample.telemetry)).not.toContain("private journal details");
  });

  it.each(["malformed-journal", "old-journal", "invalid-pong", "peer-failure"])("keeps %s as a field error without repairing or disclosing private evidence", async mode => {
    const f = fixture(), record = f.add();
    mocks.peer.mockResolvedValue(record.runs[0]!.daemon); mocks.rpc.mockResolvedValue({ type: "wrong", version: "secret-output" });
    if (mode === "malformed-journal") writeFileSync(f.journal, "private invalid database");
    if (mode === "old-journal") { const db = new Database(f.journal); db.pragma("user_version = 0"); db.close(); }
    if (mode === "peer-failure") mocks.peer.mockRejectedValue(Object.assign(new Error("private identity details"), { code: "EACCES" }));
    const bytes = readFileSync(f.journal), sample = await f.collect().collect(operation());
    expect(sample.telemetry.versions.herdr).toMatchObject({ state: "error", code: mode === "peer-failure" ? "permission_denied" : "io_error" });
    expect(JSON.stringify(sample.telemetry)).not.toMatch(/private invalid database|private identity details|secret-output/);
    expect(readFileSync(f.journal)).toEqual(bytes); expect(mocks.execution).not.toHaveBeenCalled();
  });

  it.each(["linux", "windows", "macos"] as const)("preserves the shared read-only probe on %s without a durable journal", async platform => {
    const f = fixture(); mocks.rpc.mockResolvedValue({ type: "pong", version: "0.9.4" });
    expect(await createHerdrRuntimeVersionObserver({ ...f.options, platform }).observe(operation())).toBe("0.9.4");
    expect(mocks.rpc.mock.calls[0]![0]).toBe(resolveHerdrInstancePaths(f.paths).apiEndpoint);
    expect(readdirSync(f.paths.workerDirectory)).toEqual([]); expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.execution).not.toHaveBeenCalled();
    mocks.rpc.mockRejectedValue(absent());
    expect(await createHerdrRuntimeVersionObserver({ ...f.options, platform }).observe(operation())).toBeNull();
  });

  it("bounds an unresolved native observation by collection deadline and starts no later RPC", async () => {
    vi.useFakeTimers(); const f = fixture(); f.add();
    let resolve!: (state: string) => void; mocks.observe.mockReturnValue(new Promise<string>(yes => { resolve = yes; }));
    const pending = f.collect().collect(operation(10_000));
    await vi.advanceTimersByTimeAsync(5_010);
    expect((await pending).telemetry.versions.herdr).toMatchObject({ state: "error", code: "timeout" });
    resolve("same"); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.peer).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("propagates root cancellation and stops subsequent observation steps", async () => {
    const f = fixture(); f.add(); const controller = new AbortController();
    let resolve!: (state: string) => void; mocks.observe.mockReturnValue(new Promise<string>(yes => { resolve = yes; }));
    const op = operation(5_000, controller.signal), pending = f.collect().collect(op);
    await vi.waitFor(() => expect(mocks.observe).toHaveBeenCalledOnce()); controller.abort();
    await expect(pending).rejects.toBe(op.signal.reason);
    resolve("same"); await Promise.resolve();
    expect(mocks.peer).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.execution).not.toHaveBeenCalled();
  });
});
