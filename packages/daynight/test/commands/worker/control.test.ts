import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../src/api/client.js";
import type { Task, WorkerClaim } from "../../../src/api/types.js";
import { submitWorkerControl } from "../../../src/commands/worker/control.js";
import type { WorkerControlRequest } from "../../../src/commands/worker/control.js";
import type { WorkerEvent } from "../../../src/commands/worker/execution.js";
import type { WorkerRemote } from "../../../src/commands/worker/remote.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { WorkerStore } from "../../../src/commands/worker/store.js";
import type { ExecutionConfiguration } from "../../../src/commands/worker/types.js";

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const origin = "https://daynight.example";
const owner = uuid(1), projectId = uuid(2), taskId = uuid(3), claimId = uuid(4), workerId = uuid(5), worktreeId = uuid(6);
const time = "2026-10-27T00:00:00Z";
const machine = { id: uuid(7), name: "source" };
const configuration: ExecutionConfiguration = { agent: "codex", model: "current-model", args: ["--search"], recoveryLimit: 0 };
const target: Extract<WorkerControlRequest, { kind: "transfer" }>["target"] = { userId: uuid(10), workerId: uuid(11), machine: { id: uuid(12), name: "target" }, platform: "macos", agent: "copilot" };
const root = fileURLToPath(new URL("../../../../../.tmp/worker-control-tests/", import.meta.url));
const resources: { directory: string; store: WorkerStore }[] = [];
const claim: WorkerClaim = { claimId, userId: owner, workerId, worktreeId, machine, platform: "linux", agent: "copilot", state: "active", phase: "executing", herdr: null, nativeSessionId: null, claimedAt: time };
const remoteTask = (worker: WorkerClaim = claim, version = 8n): Task => ({ id: taskId, projectId, title: "Task", description: "", status: worker.state === "active" ? "in_progress" : "todo", version, properties: { worker, pullRequests: [] }, allowAgents: true, requiredPlatform: null, startedAt: worker.state === "active" ? time : null, completedAt: null, createdAt: time, updatedAt: time, ready: worker.state !== "active", dependsOn: [], externalDependsOn: [], blockedBy: [] });
const fixture = (local = true) => {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, "control-"));
  const store = openWorkerStore(path.join(directory, "state.sqlite"));
  resources.push({ directory, store });
  const project = store.registerProject({ projectId, repoUrl: "https://github.com/example/repo.git", localPath: path.join(directory, "repository") });
  const identity = { projectId, taskId, claimId };
  if (local) store.activateTask(store.registerPending({ ...identity, agent: "copilot" }));
  let observed = remoteTask();
  const order: string[] = [];
  const events: WorkerEvent[] = [];
  const coordinator = {
    advanceRetry: vi.fn(async () => { order.push("retry"); store.setSessionId(identity, uuid(40)); }),
    cleanupSource: vi.fn(async (_identity: typeof identity, settings: { deleteWorktree?: boolean }) => { expect(settings.deleteWorktree).toBe(false); order.push("stop-close"); }),
    completeSource: vi.fn(async () => { order.push("delete-done"); expect(observed.properties.worker?.claimId !== claimId || observed.properties.worker.state !== "active").toBe(true); store.completeTask(identity); }),
  };
  const remote: WorkerRemote = {
    serverOrigin: origin, currentUserId: vi.fn(async () => owner), readTask: vi.fn(async () => observed), authorizeControl: vi.fn(async () => {}),
    release: vi.fn(async (_projectId, _taskId, input) => { expect(store.getTask(identity)?.status).toBe("active"); order.push("release"); observed = remoteTask({ ...claim, state: "released" }, input.version + 1n); return observed; }),
    transfer: vi.fn(async (_projectId, _taskId, input) => { expect(store.getTask(identity)?.status).toBe("active"); order.push("transfer"); observed = remoteTask({ ...claim, ...input.target, claimId: input.newClaimId, worktreeId: input.worktreeId, phase: "preparing", herdr: null, nativeSessionId: null }, input.version + 1n); return observed; }),
    resume: vi.fn(async (_projectId, _taskId, input) => { order.push("resume"); observed = remoteTask({ ...claim, ...input, userId: owner, state: "active", phase: "preparing", herdr: null, nativeSessionId: null }, input.version + 1n); return observed; }),
    resolveProject: vi.fn(), ownInventory: vi.fn(), candidates: vi.fn(), claim: vi.fn(), update: vi.fn(),
  };
  const options = { store, remote, serverOrigin: origin, workerId, platform: "linux" as const, machine, repositories: [{ project, configuration }], signal: new AbortController().signal, coordinator, emit: (event: WorkerEvent) => { events.push(event); order.push(event.kind); } };
  const submit = (request: WorkerControlRequest) => submitWorkerControl({ ...options, request });
  return { store, project, identity, remote, options, submit, coordinator, events, order, observe: (task: Task) => { observed = task; }, current: () => store.getTask(identity)! };
};
const release = { kind: "release", taskId, claimId, version: 8n } as const;
const transfer = { kind: "transfer", taskId, claimId, version: 8n, target } as const;
afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, directory } of resources.splice(0)) { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

describe("synchronous worker source management", () => {
  it.each([release, transfer])("stops the source, submits $kind, then deletes only after the grant is confirmed", async (request) => {
    const f = fixture();
    const result = await f.submit(request);
    expect(f.order.filter((entry) => entry !== "management-request")).toEqual(["stop-close", request.kind, "delete-done"]);
    expect(f.coordinator.cleanupSource).toHaveBeenCalledWith(f.identity, { deleteWorktree: false });
    expect(result.task).toMatchObject({ status: "done", claimId, agent: "copilot", sessionId: null });
    const input = request.kind === "release" ? vi.mocked(f.remote.release).mock.calls[0]![2] : vi.mocked(f.remote.transfer).mock.calls[0]![2];
    expect(input).toMatchObject({ claimId, version: 8n, stoppedConfirmed: true });
  });

  it("prints fresh target identities before transfer submission without registering target state", async () => {
    const f = fixture();
    const original = vi.mocked(f.remote.transfer).getMockImplementation()!;
    vi.mocked(f.remote.transfer).mockImplementationOnce(async (...args) => {
      const input = args[2];
      expect(input.newClaimId).not.toBe(claimId); expect(input.worktreeId).not.toBe(worktreeId);
      expect(f.events).toContainEqual(expect.objectContaining({ kind: "management-request", message: expect.stringContaining(input.newClaimId) }));
      expect(f.events[0]!.message).toContain(input.worktreeId);
      expect(f.store.listTasks()).toEqual([f.current()]);
      return original(...args);
    });
    await f.submit(transfer);
    expect(f.store.listTasks()).toHaveLength(1);
    expect(f.remote.authorizeControl).toHaveBeenNthCalledWith(1, projectId, owner, undefined, f.options.signal);
    expect(f.remote.authorizeControl).toHaveBeenNthCalledWith(2, projectId, owner, target.userId, f.options.signal);
  });

  it.each([release, transfer])("checks source permission before any $kind resource changes", async (request) => {
    const f = fixture(); const denied = new Error("Source membership denied");
    vi.mocked(f.remote.authorizeControl).mockRejectedValue(denied);
    await expect(f.submit(request)).rejects.toBe(denied);
    expect(f.coordinator.cleanupSource).not.toHaveBeenCalled(); expect(f.remote.release).not.toHaveBeenCalled(); expect(f.remote.transfer).not.toHaveBeenCalled();
    expect(f.current().status).toBe("active");
  });

  it("checks target membership before stopping transfer source", async () => {
    const f = fixture();
    vi.mocked(f.remote.authorizeControl).mockImplementation(async (_project, _owner, targetUserId) => { if (targetUserId !== undefined) throw new Error("Target is not a member"); });
    await expect(f.submit(transfer)).rejects.toThrow("Target is not a member");
    expect(f.coordinator.cleanupSource).not.toHaveBeenCalled(); expect(f.remote.transfer).not.toHaveBeenCalled();
  });

  it.each([release, transfer])("preserves a stale explicit version before stopping $kind source", async (request) => {
    const f = fixture(); f.observe(remoteTask(claim, 9n));
    await expect(f.submit(request)).rejects.toThrow("explicit task version no longer matches");
    expect(f.coordinator.cleanupSource).not.toHaveBeenCalled(); expect(f.remote.release).not.toHaveBeenCalled(); expect(f.remote.transfer).not.toHaveBeenCalled();
  });

  it("allows an authorized administrator to release another owner's local source", async () => {
    const f = fixture(); vi.mocked(f.remote.currentUserId).mockResolvedValue(uuid(90));
    await f.submit(release);
    expect(f.remote.authorizeControl).toHaveBeenCalledWith(projectId, owner, undefined, f.options.signal);
    expect(f.current().status).toBe("done");
  });

  it.each([release, transfer])("rejects definite $kind refusal without deleting the source or querying again", async (request) => {
    const f = fixture();
    const refusal = new ApiError({ operation: `worker.${request.kind}` }, "response", { cause: new Error("Version conflict"), status: 409, confirmedRefusal: true });
    if (request.kind === "release") vi.mocked(f.remote.release).mockRejectedValueOnce(refusal);
    else vi.mocked(f.remote.transfer).mockRejectedValueOnce(refusal);
    await expect(f.submit(request)).rejects.toBe(refusal);
    expect(f.remote.readTask).toHaveBeenCalledOnce(); expect(f.coordinator.completeSource).not.toHaveBeenCalled();
    expect(f.current().status).toBe("active");
  });

  it.each([release, transfer])("recovers a lost $kind response by one GET without replaying the write", async (request) => {
    const f = fixture();
    if (request.kind === "release") {
      const original = vi.mocked(f.remote.release).getMockImplementation()!;
      vi.mocked(f.remote.release).mockImplementationOnce(async (...args) => { await original(...args); throw new Error("Response lost"); });
    } else {
      const original = vi.mocked(f.remote.transfer).getMockImplementation()!;
      vi.mocked(f.remote.transfer).mockImplementationOnce(async (...args) => { await original(...args); throw new Error("Response lost"); });
    }
    expect((await f.submit(request)).task?.status).toBe("done");
    expect(f.remote.readTask).toHaveBeenCalledTimes(2);
    expect(request.kind === "release" ? f.remote.release : f.remote.transfer).toHaveBeenCalledOnce();
    expect(f.coordinator.completeSource).toHaveBeenCalledOnce();
  });

  it("keeps the original source when an unknown submission cannot be confirmed", async () => {
    const f = fixture(); const lost = new Error("Response lost");
    vi.mocked(f.remote.release).mockRejectedValueOnce(lost);
    await expect(f.submit(release)).rejects.toMatchObject({ cause: lost, message: expect.stringContaining("before restarting worker run") });
    expect(f.remote.release).toHaveBeenCalledOnce(); expect(f.remote.readTask).toHaveBeenCalledTimes(2);
    expect(f.coordinator.completeSource).not.toHaveBeenCalled(); expect(f.current().status).toBe("active");
  });

  it("preserves both original mutation and reconciliation errors", async () => {
    const f = fixture(); const lost = new Error("Response lost"), unavailable = new Error("GET unavailable");
    vi.mocked(f.remote.release).mockRejectedValueOnce(lost);
    vi.mocked(f.remote.readTask).mockResolvedValueOnce(remoteTask()).mockRejectedValueOnce(unavailable);
    await expect(f.submit(release)).rejects.toMatchObject({ errors: [lost, unavailable] });
    expect(f.coordinator.completeSource).not.toHaveBeenCalled(); expect(f.current().status).toBe("active");
  });

  it("does not claim a different transfer won the requested management decision", async () => {
    const f = fixture();
    vi.mocked(f.remote.transfer).mockImplementationOnce(async () => { f.observe(remoteTask({ ...claim, claimId: uuid(99) }, 9n)); throw new Error("Response lost"); });
    await expect(f.submit(transfer)).rejects.toThrow("result is unknown");
    expect(f.coordinator.completeSource).not.toHaveBeenCalled();
  });

  it("retains the source if stopping fails and exposes post-success deletion failure for later run cleanup", async () => {
    const f = fixture(); const stop = new Error("Stop unconfirmed");
    f.coordinator.cleanupSource.mockRejectedValueOnce(stop);
    await expect(f.submit(release)).rejects.toBe(stop);
    expect(f.remote.release).not.toHaveBeenCalled();
    const deletion = new Error("Worktree deletion failed"); f.coordinator.completeSource.mockRejectedValueOnce(deletion);
    await expect(f.submit(release)).rejects.toBe(deletion);
    expect(f.remote.release).toHaveBeenCalledOnce(); expect(f.current().status).toBe("active");
  });

  it.each([{ ...claim, workerId: uuid(91) }, { ...claim, agent: "codex" as const }, { ...claim, claimId: uuid(92) }])("rejects another remote execution before cleanup", async (worker) => {
    const f = fixture(); f.observe(remoteTask(worker));
    await expect(f.submit(release)).rejects.toThrow("exact active execution");
    expect(f.coordinator.cleanupSource).not.toHaveBeenCalled();
  });

  it("attempts one original retry without creating or changing any claim", async () => {
    const f = fixture();
    const result = await f.submit({ kind: "retry", taskId, claimId });
    expect(f.coordinator.advanceRetry).toHaveBeenCalledExactlyOnceWith(f.identity);
    expect(result.task).toMatchObject({ ...f.identity, status: "active", agent: "copilot", sessionId: uuid(40) });
    expect(f.remote.resume).not.toHaveBeenCalled(); expect(f.remote.claim).not.toHaveBeenCalled(); expect(f.coordinator.cleanupSource).not.toHaveBeenCalled();
    expect(f.store.listTasks()).toHaveLength(1);
  });

  it("does not grant a retry to an administrator or a pending local claim", async () => {
    const f = fixture(); vi.mocked(f.remote.currentUserId).mockResolvedValue(uuid(90));
    await expect(f.submit({ kind: "retry", taskId, claimId })).rejects.toThrow("original authenticated execution owner");
    const pending = f.store.registerPending({ projectId, taskId: uuid(70), claimId: uuid(71), agent: "copilot" });
    vi.mocked(f.remote.currentUserId).mockResolvedValue(owner);
    f.observe({ ...remoteTask(), id: pending.taskId, properties: { worker: { ...claim, claimId: pending.claimId }, pullRequests: [] } });
    await expect(f.submit({ kind: "retry", taskId: pending.taskId, claimId: pending.claimId })).rejects.toThrow("pending work is started by worker run");
    expect(f.coordinator.advanceRetry).not.toHaveBeenCalled();
  });

  it("does not submit a cancelled management decision", async () => {
    const f = fixture(); const cancelled = new Error("Cancelled"), controller = new AbortController();
    f.coordinator.cleanupSource.mockImplementationOnce(async () => { controller.abort(cancelled); });
    await expect(submitWorkerControl({ ...f.options, request: release, signal: controller.signal })).rejects.toBe(cancelled);
    expect(f.coordinator.cleanupSource).toHaveBeenCalledOnce(); expect(f.remote.release).not.toHaveBeenCalled();
    await expect(submitWorkerControl({ ...f.options, request: release, signal: AbortSignal.abort(cancelled) })).rejects.toBe(cancelled);
    expect(f.remote.release).not.toHaveBeenCalled(); expect(f.coordinator.completeSource).not.toHaveBeenCalled();
  });
});

describe("worker explicit resume grants", () => {
  it("uses fresh printed identities and current agent settings without inheriting old native history", async () => {
    const f = fixture(); f.store.setSessionId(f.identity, uuid(50)); f.store.completeTask(f.identity);
    f.observe(remoteTask({ ...claim, state: "released", nativeSessionId: uuid(50) }));
    const original = vi.mocked(f.remote.resume).getMockImplementation()!;
    vi.mocked(f.remote.resume).mockImplementationOnce(async (...args) => {
      const input = args[2];
      expect(input.claimId).not.toBe(claimId); expect(input.worktreeId).not.toBe(worktreeId);
      expect(input).toMatchObject({ previousClaimId: claimId, version: 8n, workerId, agent: "codex" });
      expect(f.events[0]!.message).toContain(input.claimId); expect(f.events[0]!.message).toContain(input.worktreeId);
      expect(f.store.listTasks()).toHaveLength(1);
      return original(...args);
    });
    const result = await f.submit({ kind: "resume", taskId, claimId, version: 8n });
    expect(result.task).toMatchObject({ projectId, taskId, status: "pending", agent: "codex", sessionId: null });
    expect(f.current()).toMatchObject({ status: "done", sessionId: uuid(50), agent: "copilot" });
    expect(f.store.listTasks()).toHaveLength(2); expect(f.coordinator.cleanupSource).not.toHaveBeenCalled();
  });

  it("recovers a granted resume after response loss without a second write", async () => {
    const f = fixture(false); f.observe(remoteTask({ ...claim, state: "released" }));
    const original = vi.mocked(f.remote.resume).getMockImplementation()!;
    vi.mocked(f.remote.resume).mockImplementationOnce(async (...args) => { await original(...args); throw new Error("Resume response lost"); });
    const result = await f.submit({ kind: "resume", taskId, claimId, version: 8n });
    expect(result.task?.status).toBe("pending"); expect(f.remote.resume).toHaveBeenCalledOnce(); expect(f.remote.readTask).toHaveBeenCalledTimes(2);
  });

  it("keeps unknown resume unregistered and refuses a grant for another principal", async () => {
    const f = fixture(false); f.observe(remoteTask({ ...claim, state: "released" }));
    const original = vi.mocked(f.remote.resume).getMockImplementation()!;
    vi.mocked(f.remote.resume).mockImplementationOnce(async (...args) => { const granted = await original(...args); const other = { ...granted, properties: { ...granted.properties, worker: { ...granted.properties.worker!, userId: uuid(90) } } }; f.observe(other); return other; });
    await expect(f.submit({ kind: "resume", taskId, claimId, version: 8n })).rejects.toThrow("result is unknown");
    expect(f.store.listTasks()).toEqual([]); expect(f.remote.resume).toHaveBeenCalledOnce();
  });

  it("rejects stale versions and wrong released claims before issuing new grants", async () => {
    const f = fixture(false); f.observe(remoteTask({ ...claim, state: "released" }, 9n));
    await expect(f.submit({ kind: "resume", taskId, claimId, version: 8n })).rejects.toThrow("explicit task version");
    f.observe(remoteTask({ ...claim, state: "released", claimId: uuid(80) }));
    await expect(f.submit({ kind: "resume", taskId, claimId, version: 8n })).rejects.toThrow("exact released previous claim");
    expect(f.remote.resume).not.toHaveBeenCalled();
  });
});
