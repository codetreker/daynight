import path from "node:path";
import { ApiError } from "../../../src/api/client.js";
import { expect, it, vi } from "vitest";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { frozenToolLaunch } from "../../helpers/tool-launch.js";
import { createMonitoringObserver } from "../../../src/commands/worker/monitoring/observer.js";
import { readWorkerClaim } from "../../../src/api/task-properties.js";
import type { ExecutionConfiguration } from "../../../src/commands/worker/types.js";
import type { LocalTask as WebTask } from "../../../src/commands/worker/backends/web-types.js";
import { configuration, createWorkerCoordinator, eventually, fixture, origin, registerWebStore, unknownStop, uuid, workerId, task } from "./coordinator-web-fixtures.js";

it("retires settled Web metadata", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = registerWebStore(openWebExecutionStore(createMemoryDatabase()));
    const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(951), worktreeId: uuid(952) };
    const config = { ...configuration, args: [], agentControlMode: "web" as const };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
    record = webStore.bindWorktree(record, f.bind(owner), 2);
    record = webStore.beginCleanup(record, { kind: "terminal", deadline: 100 }, 2); webStore.completeTask(record, 3);
    f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
    const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: config }], globalConfiguration: config, webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async task => task), cleanup: vi.fn(async task => ({ task, complete: true })) } });
    try {
      await coordinator.tick();
      expect(f.manifests.has(owner.claimId)).toBe(false);
      expect(f.remote.claim).toHaveBeenCalledOnce();
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

it("retains and reports metadata when completed Web execution has no original binding", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = registerWebStore(openWebExecutionStore(createMemoryDatabase()));
    const owner = { projectId: f.project.projectId, taskId: uuid(970), claimId: uuid(971), worktreeId: uuid(972) };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: { ...configuration, agentControlMode: "web" } }, 1);
    record = webStore.beginCleanup(record, { kind: "terminal", deadline: 100 }, 2); webStore.completeTask(record, 3);
    f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
    f.candidates.splice(0);
    const coordinator = createWorkerCoordinator({ ...f.options, webStore });
    try {
      await coordinator.tick();
      expect(f.manifests.has(owner.claimId)).toBe(true);
      expect(f.git.retireWorktreeManifest).not.toHaveBeenCalled();
      expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-error", message: "Worktree metadata retirement remains pending." }));
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

it("waits before registering a new Web execution after awaited configuration preparation", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(); const webStore = registerWebStore(openWebExecutionStore(createMemoryDatabase()));
  const config = { ...configuration, agentControlMode: "web" as const, args: [] };
  let complete = true, preparations = 0;
  const register = vi.spyOn(webStore, "register"), advance = vi.fn(async record => record);
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: config }], globalConfiguration: config,
    configurationComplete: () => complete, webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {},
    freezeConfiguration: async value => { await Promise.resolve(); if (++preparations === 2) complete = false; return value; },
    webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn(async task => ({ task, complete: true })) } });
  try {
    await coordinator.tick();
    await eventually(() => expect(complete).toBe(false));
    expect(register).not.toHaveBeenCalled(); expect(advance).not.toHaveBeenCalled();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it("routes Web claims without Herdr, freezes launch settings, and keeps interaction state out of task summary", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(); const webStore = registerWebStore(openWebExecutionStore(createMemoryDatabase()));
  const webConfiguration = { agent: "codex" as const, agentControlMode: "web" as const, model: "frozen-model", args: [], recoveryLimit: 2 };
  const monitor = createMonitoringObserver();
  let controllerActivity: "waiting_input" | "working" = "waiting_input";
  const advance = vi.fn(async (input: import("../../../src/commands/worker/backends/web-types.js").LocalTask) => {
    let record = webStore.initializeWebExecution(input, 2);
    record = webStore.updateWebExecution(record, { activity: controllerActivity, initialInputState: "confirmed" }, 3);
    return webStore.bindNativeSession(record, { source: "controller", sessionId: uuid(880) }, 4);
  });
  const verifyWebUnregistered = vi.fn(async () => {});
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: webConfiguration }], globalConfiguration: webConfiguration, webStore, monitoring: monitor, verifyWebServer: vi.fn(async () => {}), verifyWebUnregistered, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn(async task => ({ task, complete: true })) } });
  try {
    await coordinator.tick(); await eventually(() => expect(advance).toHaveBeenCalledOnce());
    await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    expect(row).toMatchObject({ agentControlMode: "web", sessionId: uuid(880) });

    expect(vi.mocked(f.remote.update).mock.calls[0]![1]).toEqual({ phase: "executing", nativeSessionId: uuid(880) });
    expect(monitor.capture().activities).toEqual([expect.objectContaining({ kind: "execution", phase: "waiting", status: "waiting", waitReason: "native-input" })]);
    controllerActivity = "working";
    webConfiguration.model = "changed-model";
    Object.assign(webConfiguration, { args: ["--search"] });
    await coordinator.tick(); await eventually(() => expect(advance).toHaveBeenCalledTimes(2));
    await eventually(() => expect(monitor.capture().activities).toEqual([expect.objectContaining({ kind: "execution", phase: "executing", status: "running", waitReason: null })]));
    expect(webStore.getTask(row)?.configuration?.model).toBe("frozen-model");
    expect(verifyWebUnregistered).toHaveBeenCalledOnce();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it("missing Web execution evidence never permits replacing or deleting an existing server Session", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(); const webStore = registerWebStore(openWebExecutionStore(createMemoryDatabase()));
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
  const remote = f.grant(f.candidates[0]!, { claimId: uuid(810), workerId, worktreeId: uuid(811), agent: "codex", agentControlMode: "web", platform: "linux", machine: { id: uuid(3), name: "fixture" } });
  const row = f.store.registerPending({ projectId: remote.projectId, taskId: remote.id, claimId: uuid(810), agent: "codex", agentControlMode: "web" }); f.store.activateTask(row);
  const advance = vi.fn(), cleanup = vi.fn(); const refusal = new Error("Existing Session requires original execution evidence.");
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration }], globalConfiguration: configuration, webStore, webBackend: { observeExecutionStop: unknownStop, advance, cleanup }, verifyWebServer: vi.fn(async () => {}), verifyWebUnregistered: vi.fn(async () => { throw refusal; }) });
  try {
    await coordinator.tick(); await eventually(() => expect(f.events.some(event => event.kind === "execution-error")).toBe(true));
    expect(advance).not.toHaveBeenCalled(); expect(webStore.getTask(row)).toBeNull();
    await expect(coordinator.cleanupSource(row, { deleteWorktree: true })).rejects.toBe(refusal);
    expect(cleanup).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
    expect(f.store.getTask(row)?.status).toBe("active");
    f.grants.clear();
    await coordinator.tick();
    await eventually(() => expect(f.events.some(event => event.kind === "cleanup-error")).toBe(true));
    expect(f.store.getTask(row)?.status).toBe("active");
    expect(await coordinator.shutdown()).toBe(false);
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it.each(["supported", "legacy", "unavailable"])("reconciles paused summaries with %s startup reporting without advancing recovery", async support => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(), webStore = registerWebStore(openWebExecutionStore(createMemoryDatabase()));
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 0 };
  const advance = vi.fn(async (input: WebTask) => {
    webStore.pauseRecovery(input, "No original identity.", 2);
    return webStore.getTask(input)!;
  });
  const observeStartupReport = vi.fn((input: WebTask) => ({ schemaVersion: 1 as const, source: "worker" as const,
    sessionId: uuid(888), claimId: input.claimId, executionGeneration: "1", controllerInstanceId: uuid(889), revision: "1",
    observedAt: "2026-11-05T00:00:00.000Z", startup: { state: "unknown" as const, reasonCode: "native_timeout" as const },
    recovery: { state: "blocked" as const, reasonCode: "native_identity_missing" as const } }));
  let calls = 0;
  vi.mocked(f.remote.update).mockImplementation(async (current, input) => {
    calls++;
    if (calls === 1) {
      f.grants.set(readWorkerClaim(current.properties)!.claimId, { ...current, version: 17n });
      throw new Error("Unconfirmed report response.");
    }
    const { startupReport, ...summary } = input;
    const updated = { ...current, properties: { ...current.properties, ...(startupReport ? { sessionStartup: startupReport } : {}), worker: { ...readWorkerClaim(current.properties)!, ...summary } } };
    f.grants.set(readWorkerClaim(current.properties)!.claimId, updated); return updated;
  });
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration }], globalConfiguration: configuration,
    webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, verifyWebStartupReporting: async () => {
      if (support === "unavailable") throw new Error("Capabilities response unavailable.");
      return support === "supported";
    },
    webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn(async task => ({ task, complete: true })), observeStartupReport } });
  const tick = async () => { await coordinator.tick(); await new Promise<void>(resolve => setImmediate(resolve)); };
  try {
    await tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    await tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledTimes(2));
    expect(vi.mocked(f.remote.update).mock.calls[1]![0].version).toBe(17n);
    if (support === "supported") expect(vi.mocked(f.remote.update).mock.calls[1]![1]).toHaveProperty("startupReport.startup.reasonCode", "native_timeout");
    else expect(vi.mocked(f.remote.update).mock.calls[1]![1]).not.toHaveProperty("startupReport");
    await tick(); await tick();
    expect(advance).toHaveBeenCalledOnce();
    expect(f.remote.update).toHaveBeenCalledTimes(2);
    expect(webStore.getTask(f.store.listTasks()[0]!)?.recovery.count).toBe(0);
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it.each(["claim", "worktree"])("rejects Web retry after original %s loss without authorizing or advancing it", async field => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(), webStore = registerWebStore(openWebExecutionStore(createMemoryDatabase()));
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
  const advance = vi.fn(async (input: import("../../../src/commands/worker/backends/web-types.js").LocalTask) => input);
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration }], globalConfiguration: configuration, webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn(async task => ({ task, complete: true })) } });
  try {
    await coordinator.tick(); await eventually(() => expect(advance).toHaveBeenCalledOnce());
    await new Promise<void>(resolve => setImmediate(resolve));
    const row = f.store.listTasks()[0]!;
    const original = f.grants.get(row.claimId)!;
    f.grants.set(row.claimId, { ...original, properties: { ...original.properties, worker: { ...readWorkerClaim(original.properties)!, ...(field === "claim" ? { claimId: uuid(999) } : { worktreeId: uuid(999) }) } } });
    await expect(coordinator.advanceRetry(row)).rejects.toThrow(/no longer/);
    expect(webStore.getTask(row)?.recovery.retryAuthorized).toBe(false);
    expect(advance).toHaveBeenCalledOnce();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it("keeps an authorized Web retry waiting until a healthy observation after confirmed shutdown", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(), webStore = registerWebStore(openWebExecutionStore(createMemoryDatabase())), monitor = createMonitoringObserver();
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 0, toolLaunch: frozenToolLaunch() };
  let starting = true;
  const advance = vi.fn(async (input: import("../../../src/commands/worker/backends/web-types.js").LocalTask) => {
    let record = webStore.initializeWebExecution(input, 2);
    if (record.recovery.retryAuthorized && record.recovery.pauseReason !== null) {
      const e = record.webExecution!;
      record = webStore.beginWebGeneration(record, { executionGeneration: e.executionGeneration, controllerInstanceId: e.controllerInstanceId, nativeSessionId: uuid(880), nativeStopped: true }, 3);
    }
    record = webStore.updateWebExecution(record, { activity: starting ? "initializing" : "working" }, 4);
    record = webStore.bindNativeSession(record, { source: "controller", sessionId: uuid(880) }, 5);
    if (!starting && record.recovery.retryAuthorized) {
      const e = record.webExecution!;
      record = webStore.completeRecoveryRetry(record, { executionId: e.executionId, claimId: record.claimId, sessionId: e.sessionId!, executionGeneration: e.executionGeneration, controllerInstanceId: e.controllerInstanceId, lifecycle: "ready", nativeSessionId: uuid(880), initialInputState: "confirmed", activity: "working", currentTurnId: null, capabilities: { send: true, steer: true, cancel: true, respond: true }, controllerProcess: null, nativeProcesses: [], nativeStopped: false, stoppedAt: null, error: null }, 6);
    }
    return record;
  });
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration }], globalConfiguration: configuration, webStore, monitoring: monitor, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn(async input => ({ task: input, complete: true })) } });
  try {
    await coordinator.tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    webStore.pauseRecovery(row, "Recovery exhausted.", 6);
    await coordinator.tick();
    await eventually(() => expect(monitor.capture().currentFailures).toContainEqual(expect.objectContaining({ error: expect.objectContaining({ code: "recovery-blocked" }) })));
    const recovery = monitor.capture().currentFailures.find(item => item.error.code === "recovery-blocked")!;
    webStore.beginCleanup(row, { kind: "shutdown", deadline: 9 }, 7);

    await coordinator.advanceRetry(row);
    expect(webStore.getTask(row)?.cleanup).toBeNull();
    expect(webStore.getTask(row)?.recovery).toMatchObject({ count: 1, retryAuthorized: true });
    expect(readWorkerClaim(f.grants.get(row.claimId)!.properties)?.phase).toBe("waiting");
    await coordinator.tick();
    await eventually(() => expect(advance.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(monitor.capture().currentFailures).toContainEqual(expect.objectContaining({ operationId: recovery.operationId }));
    starting = false;
    await coordinator.tick();
    await eventually(() => expect(readWorkerClaim(f.grants.get(row.claimId)!.properties)?.phase).toBe("executing"));
    await eventually(() => expect(monitor.capture().lastRecovery).toMatchObject({ operationId: recovery.operationId }));
    expect(webStore.getTask(row)?.recovery.count).toBe(1);
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it("returns a Web retry's input wait without claiming a completed submission", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(), webStore = registerWebStore(openWebExecutionStore(createMemoryDatabase()));
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 0 };
  const advance = vi.fn(async (input: WebTask) => input);
  const advanceResult = vi.fn(async (input: WebTask) => ({ kind: "waiting_input" as const, reason: "prompt_too_large" as const, task: input }));
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration }], globalConfiguration: configuration, webStore,
    verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, advanceResult, cleanup: vi.fn(async task => ({ task, complete: true })) } });
  try {
    await coordinator.tick(); await eventually(() => expect(advanceResult).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    expect(await coordinator.advanceRetry(row)).toEqual({ kind: "waiting_input", reason: "prompt_too_large" });
    expect(readWorkerClaim(f.grants.get(row.claimId)!.properties)?.phase).toBe("waiting");
    expect(f.store.getTask(row)).toMatchObject({ status: "active", claimId: row.claimId });
    expect(advance).not.toHaveBeenCalled();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it("refuses an explicit Web retry without original execution evidence instead of starting an assignment", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(), webStore = registerWebStore(openWebExecutionStore(createMemoryDatabase()));
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
  const remote = f.grant(f.candidates[0]!, { claimId: uuid(810), workerId, worktreeId: uuid(811), agent: "codex", agentControlMode: "web", platform: "linux", machine: f.options.machine });
  const row = f.store.registerPending({ projectId: remote.projectId, taskId: remote.id, claimId: uuid(810), agent: "codex", agentControlMode: "web" });
  f.store.activateTask(row);
  const advance = vi.fn(async (input: import("../../../src/commands/worker/backends/web-types.js").LocalTask) => input);
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [], globalConfiguration: configuration, webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn(async task => ({ task, complete: true })) } });
  try {
    await expect(coordinator.advanceRetry(row)).rejects.toThrow("original Web execution evidence");
    expect(advance).not.toHaveBeenCalled();
    expect(webStore.getTask(row)).toBeNull();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it.each(["native", "project removed", "project unavailable"] as const)("preserves a granted Web claim's frozen settings after an in-flight %s change", async change => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(); f.candidates.splice(1);
    const webStore = registerWebStore(openWebExecutionStore(createMemoryDatabase()));
    const native: ExecutionConfiguration = { agent: "codex", agentControlMode: "web", model: "claim-model", args: ["--effort", "low"], recoveryLimit: 2 };
    const current = { repositories: [{ project: f.project, configuration: native }], readyProjectIds: [f.project.projectId], targetProjectIds: [f.project.projectId], globalConfiguration: native, maxConcurrent: 1, preferPlatformSpecificTasks: false };
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.remote.claim).mockImplementationOnce(async (candidate, descriptor) => { await waiting; return f.grant(candidate, descriptor); });
    const advance = vi.fn(async (record: WebTask) => record);
    const runner = createWorkerCoordinator({ ...f.options, ...current, webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {},
      webBackend: { observeExecutionStop: unknownStop, advance, cleanup: async record => ({ task: record, complete: true }) } });
    const ticking = runner.tick(); void ticking.catch(() => {});
    try {
      await eventually(() => expect(f.remote.claim).toHaveBeenCalledOnce());
      expect(f.store.listTasks()).toEqual([]); expect(webStore.listUnfinishedTasks()).toEqual([]);
      const changed: ExecutionConfiguration = { ...native, agentControlMode: "web", model: "later-model", args: ["--effort", "high"], recoveryLimit: 7 };
      const next = { ...current, repositories: [{ project: f.project, configuration: changed }], globalConfiguration: changed };
      const gated = change === "project removed" || change === "project unavailable";
      runner.updateConfiguration({ ...next, ...(change === "project removed" ? { repositories: [], targetProjectIds: [] } : change === "project unavailable" ? { repositories: [], readyProjectIds: [] } : {}) });
      release(); await ticking;
      const row = f.store.listTasks()[0]!;
      expect(row).toMatchObject({ agent: "codex", agentControlMode: "web", sessionId: null, status: "pending" });
      expect(webStore.getTask(row)).toBeNull();
      expect(f.store.getNativeConfiguration(row)).toEqual({ agent: "codex", model: "claim-model", args: ["--effort", "low"] });
      if (gated) {
        expect(row.status).toBe("pending"); expect(webStore.getTask(row)).toBeNull(); expect(advance).not.toHaveBeenCalled();
        await runner.tick();
        expect(webStore.getTask(row)).toBeNull(); expect(advance).not.toHaveBeenCalled();
        runner.updateConfiguration(next); await runner.tick();
      } else await runner.tick();
      await eventually(() => expect(advance).toHaveBeenCalledOnce());
      expect(webStore.getTask(row)?.configuration).toEqual({ agent: "codex", agentControlMode: "web", model: "claim-model", args: ["--effort", "low"], recoveryLimit: 7 });
      expect(f.store.getTask(row)).toMatchObject({ claimId: row.claimId, agentControlMode: "web", status: "active" });
      expect(f.remote.claim).toHaveBeenCalledOnce();
    } finally { release(); await ticking; await runner.shutdown(); webStore.close(); }
  });

it.each(["equivalent", "changed", "changed and restored"] as const)("handles %s updates during capability validation", async mode => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(); f.candidates.splice(1);
    const webStore = registerWebStore(openWebExecutionStore(createMemoryDatabase()));
    const native: ExecutionConfiguration = { ...configuration, agentControlMode: "web", args: [] };
    const current = { repositories: [{ project: f.project, configuration: native }], readyProjectIds: [f.project.projectId], targetProjectIds: [f.project.projectId], globalConfiguration: native, maxConcurrent: 1, preferPlatformSpecificTasks: false };
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const verify = vi.fn(async () => { if (verify.mock.calls.length === 1) await waiting; });
    const runner = createWorkerCoordinator({ ...f.options, ...current, webStore, verifyWebServer: verify, verifyWebUnregistered: async () => {},
      webBackend: { observeExecutionStop: unknownStop, advance: async record => record, cleanup: async record => ({ task: record, complete: true }) } });
    const ticking = runner.tick(); void ticking.catch(() => {});
    try {
      await eventually(() => expect(verify).toHaveBeenCalledOnce());
      const changed = { ...native, agent: "copilot" as const, model: null, args: [] };
      if (mode === "equivalent") runner.updateConfiguration({ ...current, repositories: [{ project: { ...f.project }, configuration: { ...native, args: [...native.args] } }], globalConfiguration: { ...native, args: [...native.args] }, readyProjectIds: [...current.readyProjectIds], targetProjectIds: [...current.targetProjectIds] });
      else {
        runner.updateConfiguration({ ...current, repositories: [{ project: f.project, configuration: changed }], globalConfiguration: changed });
        if (mode === "changed and restored") runner.updateConfiguration(current);
      }
      expect(f.remote.claim).not.toHaveBeenCalled();
      release(); await ticking;
      if (mode === "equivalent") expect(f.remote.claim).toHaveBeenCalledOnce();
      else {
        expect(f.remote.claim).not.toHaveBeenCalled();
        await runner.tick(); expect(f.remote.claim).toHaveBeenCalledOnce();
      }
      expect(vi.mocked(f.remote.claim).mock.calls[0]![0].id).toBe(f.candidates[0]!.id);
      expect(vi.mocked(f.remote.claim).mock.calls[0]![1].agent).toBe(mode === "changed" ? "copilot" : "codex");
    } finally { release(); await ticking; await runner.shutdown(); webStore.close(); }
  });

it("clears unattributed renewal state when a complete inventory excludes its claim", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = registerWebStore(openWebExecutionStore(createMemoryDatabase())), monitor = createMonitoringObserver(); f.candidates.splice(0);
    const web = { agent: "codex" as const, agentControlMode: "web" as const, model: "model", args: [], recoveryLimit: 2 };
    type Monitoring = Parameters<import("../../../src/commands/worker/backends/web.js").WebExecutionBackend["setMonitoringObserver"]>[0];
    let hooks: Monitoring | undefined;
    const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: web }], globalConfiguration: web, webStore, monitoring: monitor, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async task => task), cleanup: vi.fn(async task => ({ task, complete: true })), setMonitoringObserver: value => { hooks = value; } } });
    try {
      hooks!.observeFailure?.({ projectId: f.project.projectId, taskId: uuid(30), claimId: uuid(31) }, { kind: "execution", phase: "preparing" }, new Error("private"), "grant-ticket");
      expect(monitor.capture()).toMatchObject({ detailCoverage: "partial", currentFailures: [], lastRecovery: null });
      await coordinator.tick();
      expect(monitor.capture()).toMatchObject({ detailCoverage: "complete", currentFailures: [], lastRecovery: null });
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

it("keeps Web grant failures through healthy IPC and no-op checks until actual renewal", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = registerWebStore(openWebExecutionStore(createMemoryDatabase())), monitor = createMonitoringObserver();
    const web = { agent: "codex" as const, agentControlMode: "web" as const, model: "model", args: [], recoveryLimit: 2 };
    type Monitoring = Parameters<import("../../../src/commands/worker/backends/web.js").WebExecutionBackend["setMonitoringObserver"]>[0];
    let hooks: Monitoring | undefined, attempt = 0;
    const failure = new Error("private grant failure"), operationKey = `grant-refresh/1/${uuid(900)}`;
    const advance = vi.fn(async (record: WebTask) => {
      hooks!.observePhase?.(record, { kind: "execution", phase: "agent-observation" }, false);
      hooks!.observeSuccess?.(record, { kind: "execution", phase: "agent-observation" });
      hooks!.observePhase?.(record, { kind: "execution", phase: "preparing" }, false, undefined, operationKey);
      attempt++;
      if (attempt <= 2) throw failure;
      if (attempt === 4) hooks!.observeSuccess?.(record, { kind: "execution", phase: "preparing" }, operationKey);
      return record;
    });
    const webBackend = { observeExecutionStop: unknownStop, advance, cleanup: vi.fn(async task => ({ task, complete: true })), setMonitoringObserver: (value: Monitoring) => { hooks = value; } };
    const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: web }], globalConfiguration: web, webStore, monitoring: monitor, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend });
    try {
      await coordinator.tick(); await eventually(() => expect(monitor.capture().currentFailures).toHaveLength(1));
      const first = monitor.capture().currentFailures[0]!; expect(first).toMatchObject({ component: "execution", phase: "preparing", occurrencesInRun: 1 });
      await coordinator.tick(); await eventually(() => expect(monitor.capture().currentFailures[0]).toMatchObject({ operationId: first.operationId, occurrencesInRun: 2 }));
      await coordinator.tick(); await eventually(() => expect(advance).toHaveBeenCalledTimes(3));
      expect(monitor.capture().currentFailures).toContainEqual(expect.objectContaining({ operationId: first.operationId, occurrencesInRun: 2, retryState: "none" }));
      expect(monitor.capture().lastRecovery).toBeNull();
      const identity = f.store.listTasks()[0]!;
      hooks!.observeRetry?.(identity, operationKey, true);
      expect(monitor.capture().currentFailures[0]!.retryState).toBe("running");
      hooks!.observeRetry?.(identity, operationKey, false);
      expect(monitor.capture().currentFailures[0]!.retryState).toBe("none");
      await coordinator.tick(); await eventually(() => expect(monitor.capture().lastRecovery).toMatchObject({ operationId: first.operationId }));
      expect(monitor.capture().currentFailures).toEqual([]);
      const row = f.store.listTasks()[0]!;
      hooks!.observeFailure?.(row, { kind: "execution", phase: "preparing" }, failure, operationKey);
      const background = monitor.capture().currentFailures[0]!; expect(background.phase).toBe("preparing");
      hooks!.observeSuccess?.(row, { kind: "execution", phase: "agent-observation" });
      expect(monitor.capture().currentFailures).toContainEqual(expect.objectContaining({ operationId: background.operationId }));
      hooks!.observeSuccess?.(row, { kind: "execution", phase: "preparing" }, operationKey);
      expect(monitor.capture().lastRecovery).toMatchObject({ operationId: background.operationId });
      expect(JSON.stringify(monitor.capture())).not.toContain("private grant failure");
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

it("reports a paused Web recovery without retrying its native execution", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = registerWebStore(openWebExecutionStore(createMemoryDatabase())), monitor = createMonitoringObserver();
    const web = { agent: "codex" as const, agentControlMode: "web" as const, model: "model", args: [], recoveryLimit: 2 };
    const advance = vi.fn(async (record: WebTask) => webStore.pauseRecovery(record, "Original identity missing", 2, "native_identity_missing"));
    const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: web }], globalConfiguration: web, webStore, monitoring: monitor, verifyWebServer: vi.fn(async () => {}), verifyWebUnregistered: vi.fn(async () => {}), webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn(async task => ({ task, complete: true })) } });
    try {
      await coordinator.tick(); await eventually(() => expect(advance).toHaveBeenCalledOnce());
      await eventually(() => expect(monitor.capture().activities).toContainEqual(expect.objectContaining({ kind: "execution", phase: "paused", status: "paused", waitReason: "recovery-blocked" })));
      await coordinator.tick();
      expect(advance).toHaveBeenCalledOnce();
      expect(monitor.capture().activities).toContainEqual(expect.objectContaining({ kind: "execution", phase: "paused", status: "paused", waitReason: "recovery-blocked" }));
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

it("fences an in-flight inventory when another observer invalidates one project", async () => {
    const f = await fixture(2), publish = vi.fn();
    const second = { ...f.project, projectId: uuid(11), localPath: path.join(f.root, "other") };
    f.store.registerProject(second); f.options.repositories.push({ project: second, configuration });
    f.candidates.splice(1, 1, task(second.projectId, uuid(102)));
    let entered!: () => void, release!: () => void;
    const requested = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.remote.ownInventory).mockImplementationOnce(async () => {
      entered(); await held;
      return { tasks: [], coveredProjectIds: [f.project.projectId, second.projectId], unavailableProjectIds: [] };
    });
    const coordinator = createWorkerCoordinator({ ...f.options, onInventory: publish });
    const tick = coordinator.tick();
    try {
      await requested;
      coordinator.invalidateProject(f.project.projectId);
      expect(publish).toHaveBeenLastCalledWith(null);
      release(); await tick;
      expect(publish).toHaveBeenLastCalledWith(null);
      expect(f.remote.claim).toHaveBeenCalledOnce();
      expect(vi.mocked(f.remote.claim).mock.calls[0]![0].projectId).toBe(second.projectId);
      await coordinator.tick();
      expect(vi.mocked(f.remote.claim).mock.calls[1]![0].projectId).toBe(f.project.projectId);
    } finally { release(); await tick; }
  });

it("fences a 404 delivered after inventory processing but before its caller resumes", async () => {
    const f = await fixture(2), publish = vi.fn();
    const second = { ...f.project, projectId: uuid(11), localPath: path.join(f.root, "other") };
    f.store.registerProject(second); f.options.repositories.push({ project: second, configuration });
    f.candidates.splice(0, f.candidates.length, task(second.projectId, uuid(102)));
    const original = await f.remote.claim(task(f.project.projectId, uuid(120)), {
      claimId: uuid(121), workerId, worktreeId: uuid(122), machine: { id: uuid(4), name: "fixture" }, platform: "linux", agent: "codex", agentControlMode: "web",
    }, new AbortController().signal);
    vi.mocked(f.remote.claim).mockClear();
    const coordinator = createWorkerCoordinator({ ...f.options, onInventory: publish });
    const register = f.store.registerPending.bind(f.store);
    let injected = false;
    vi.spyOn(f.store, "registerPending").mockImplementation(input => {
      const local = register(input);
      if (input.projectId === f.project.projectId && !injected) {
        injected = true;
        queueMicrotask(() => coordinator.invalidateProject(f.project.projectId));
      }
      return local;
    });
    await coordinator.tick();
    expect(injected).toBe(true);
    expect(publish.mock.calls.every(([value]) => value === null)).toBe(true);
    expect(f.remote.claim).toHaveBeenCalledOnce();
    expect(vi.mocked(f.remote.claim).mock.calls[0]![0].projectId).toBe(second.projectId);
    expect(f.store.getTask({ projectId: original.projectId, taskId: original.id, claimId: uuid(121) })?.status).toBe("pending");
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
  });

it("does not report a complete inventory while configuration discovery is incomplete", async () => {
    const f = await fixture(); const publish = vi.fn(); let complete = false;
    const coordinator = createWorkerCoordinator({ ...f.options, onInventory: publish, configurationComplete: () => complete });
    await coordinator.tick();
    expect(publish).toHaveBeenCalledWith(null);
    expect(f.remote.claim).not.toHaveBeenCalled();
    complete = true;
    await coordinator.tick();
    await eventually(() => expect(f.advance).toHaveBeenCalledOnce());
  });

it("invalidates an inventory if configuration changes and then returns during its read", async () => {
    const f = await fixture(); const publish = vi.fn();
    const coordinator = createWorkerCoordinator({ ...f.options, onInventory: publish });
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const requested = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(f.remote.ownInventory).mockImplementationOnce(async () => {
      entered(); await waiting;
      return { tasks: [], coveredProjectIds: [f.project.projectId], unavailableProjectIds: [] };
    });
    const tick = coordinator.tick();
    try {
      await requested;
      coordinator.updateConfiguration({ ...f.options, maxConcurrent: 2, preferPlatformSpecificTasks: false });
      coordinator.updateConfiguration(f.options);
      release(); await tick;
      expect(publish.mock.calls.every(([value]) => value === null)).toBe(true);
      expect(f.remote.claim).not.toHaveBeenCalled();
      await coordinator.tick();
      await eventually(() => expect(f.advance).toHaveBeenCalledOnce());
    } finally { release(); await tick; await coordinator.shutdown(); }
  });

it("invalidates an inventory when the complete remote observation fails", async () => {
    const f = await fixture(), onInventory = vi.fn(), failure = new Error("later inventory page failed");
    vi.mocked(f.remote.ownInventory).mockRejectedValue(failure);
    await expect(createWorkerCoordinator({ ...f.options, onInventory }).tick()).rejects.toBe(failure);
    expect(onInventory).toHaveBeenCalledExactlyOnceWith(null);

  });

it("publishes a confirmed grant after durable registration and before resource preparation", async () => {
    const f = await fixture();
    const order: string[] = [];
    const onInventory = vi.fn(() => { order.push("inventory"); });
    const onClaim = vi.fn((reference: { projectId: string; taskId: string; claimId: string }) => {
      expect(f.store.getTask(reference)).toMatchObject({ ...reference, status: "pending" });
      expect(f.git.prepareWorktree).not.toHaveBeenCalled();
      order.push("claim");
    });
    const coordinator = createWorkerCoordinator({ ...f.options, onInventory, onClaim });
    await coordinator.tick();
    expect(onInventory).toHaveBeenCalledExactlyOnceWith({ observedAt: new Date(1000).toISOString(), claims: [] });
    expect(onClaim).toHaveBeenCalledOnce(); expect(order).toEqual(["inventory", "claim"]);
    await eventually(() => expect(f.advance).toHaveBeenCalledOnce());
    await coordinator.shutdown();
  });

it("keeps an uncertain claim out of confirmed grant publication", async () => {
    const f = await fixture(), onClaim = vi.fn();
    vi.mocked(f.remote.claim).mockRejectedValue(new Error("request outcome unknown"));
    const coordinator = createWorkerCoordinator({ ...f.options, onClaim });
    await coordinator.tick();
    expect(onClaim).not.toHaveBeenCalled(); expect(f.store.listTasks()).toEqual([]);
    await coordinator.shutdown();
  });

it("invalidates an inventory when a claim returns 404 without classifying the whole project as unavailable", async () => {
    const f = await fixture(), onInventory = vi.fn(), onClaim = vi.fn();
    const missing = new ApiError({ operation: "worker.claim", projectId: f.project.projectId, taskId: f.candidates[0]!.id }, "response", { cause: new Error("missing"), status: 404, serverError: { code: "not_found", message: "missing", requestId: "missing" } });
    vi.mocked(f.remote.claim).mockRejectedValueOnce(missing);
    const coordinator = createWorkerCoordinator({ ...f.options, onInventory, onClaim });
    await coordinator.tick();
    expect(onInventory.mock.calls.map(([value]) => value)).toEqual([{ observedAt: new Date(1000).toISOString(), claims: [] }, null]);
    expect(onClaim).not.toHaveBeenCalled();
    await coordinator.tick();
    await eventually(() => expect(f.advance).toHaveBeenCalledOnce());
  });
