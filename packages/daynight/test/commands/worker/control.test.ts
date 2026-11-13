import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { readWorkerClaim } from "../../../src/api/task-properties.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../src/api/client.js";
import type { Task, WorkerClaim } from "../../../src/api/types.js";
import { submitWorkerControl } from "../../../src/commands/worker/control.js";
import type { WorkerControlRequest } from "../../../src/commands/worker/control.js";
import type { WorkerInputWait } from "../../../src/commands/worker/coordinator.js";
import type { WorkerRemote } from "../../../src/commands/worker/remote.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { WorkerStore } from "../../../src/commands/worker/store.js";
import type { ResourceOwner } from "../../../src/commands/worker/types.js";

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const origin = "https://daynight.example";
const owner = uuid(1), projectId = uuid(2), taskId = uuid(3), claimId = uuid(4), workerId = uuid(5), worktreeId = uuid(6);
const time = "2026-10-27T00:00:00Z";
const machine = { id: uuid(7), name: "source" };
const root = fileURLToPath(new URL("../../../../../.tmp/worker-control-tests/", import.meta.url));
const resources: { directory: string; store: WorkerStore }[] = [];
const claim: WorkerClaim = { claimId, userId: owner, workerId, worktreeId, machine, platform: "linux", agent: "copilot", agentControlMode: "herdr", state: "active", phase: "executing", herdr: null, nativeSessionId: null, claimedAt: time };
const remoteTask = (worker: WorkerClaim = claim, version = 8n): Task => ({ type: "task", parentId: null, id: taskId, projectId, title: "Task", description: "", tags: [], status: worker.state === "active" ? "in_progress" : "todo", version, properties: { worker, pullRequests: [] }, allowAgents: true, assignedTo: null, requiredPlatform: null, startedAt: worker.state === "active" ? time : null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time, ready: worker.state !== "active", dependsOn: [], externalDependsOn: [], blockedBy: [] });
const fixture = (local = true) => {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, "control-"));
  const store = openWorkerStore(createMemoryDatabase());
  resources.push({ directory, store });
  const project = store.registerProject({ projectId, repoUrl: "https://github.com/example/repo.git", localPath: path.join(directory, "repository") });
  const identity = { projectId, taskId, claimId };
  const resourceOwner: ResourceOwner = { ...identity, worktreeId };
  if (local) store.activateTask(store.registerPending({ ...identity, agent: "copilot" }));
  let observed = remoteTask();
  const order: string[] = [];
  const coordinator = {
    advanceRetry: vi.fn(async (): Promise<WorkerInputWait | void> => { order.push("retry"); store.setSessionId(identity, uuid(40)); }),
    cleanupSource: vi.fn(async (_identity: typeof identity, settings: { deleteWorktree?: boolean }) => { expect(settings.deleteWorktree).toBe(false); order.push("stop-close"); return resourceOwner; }),
    completeSource: vi.fn(async (actualOwner: ResourceOwner) => { expect(actualOwner).toBe(resourceOwner); order.push("delete-done"); const worker = readWorkerClaim(observed.properties); expect(worker?.claimId !== claimId || worker.state !== "active").toBe(true); store.completeTask(identity); }),
  };
  const remote: WorkerRemote = {
    serverOrigin: origin, currentUserId: vi.fn(async () => owner), readTask: vi.fn(async () => observed), authorizeControl: vi.fn(async () => {}),
    release: vi.fn(async (_projectId, _taskId, input) => { expect(store.getTask(identity)?.status).toBe("active"); order.push("release"); observed = { ...remoteTask(claim, input.version + 1n), status: "todo", startedAt: null, ready: true, properties: { pullRequests: [] } }; return observed; }),
    report: vi.fn(), readMonitoring: vi.fn(), writeMonitoring: vi.fn(), configuration: vi.fn(), reportConfiguration: vi.fn(), project: vi.fn(), resolveProject: vi.fn(), ownInventory: vi.fn(), candidates: vi.fn(), claim: vi.fn(), update: vi.fn(),
  };
  const options = { store, remote, serverOrigin: origin, workerId, signal: new AbortController().signal, coordinator };
  const submit = (request: WorkerControlRequest) => submitWorkerControl({ ...options, request });
  return { store, project, identity, resourceOwner, remote, options, submit, coordinator, order, observe: (task: Task) => { observed = task; }, current: () => store.getTask(identity)! };
};
const release = { kind: "release", taskId, claimId, version: 8n } as const;
afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, directory } of resources.splice(0)) { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

describe("synchronous worker source management", () => {
  it.each([release])("stops the source, submits $kind, then deletes only after the grant is confirmed", async (request) => {
    const f = fixture();
    const result = await f.submit(request);
    expect(f.order.filter((entry) => entry !== "management-request")).toEqual(["stop-close", request.kind, "delete-done"]);
    expect(f.coordinator.cleanupSource).toHaveBeenCalledWith(f.identity, { deleteWorktree: false });
    expect(f.coordinator.completeSource).toHaveBeenCalledExactlyOnceWith(f.resourceOwner);
    expect(result.task).toMatchObject({ status: "done", claimId, agent: "copilot", sessionId: null });
    const input = vi.mocked(f.remote.release).mock.calls[0]![2];
    expect(input).toMatchObject({ claimId, version: 8n, stoppedConfirmed: true });
  });

  it("does not claim worktree deletion when release retains archive responsibility", async () => {
    const f = fixture();
    f.coordinator.completeSource.mockImplementationOnce(async () => {});
    const result = await f.submit(release);
    expect(result.task?.status).toBe("active");
    expect(result.message).not.toMatch(/resources were removed|worktree.*delet/i);
    expect(result.message).toMatch(/retained|cleanup/i);
  });

  it.each([release])("checks source permission before any $kind resource changes", async (request) => {
    const f = fixture(); const denied = new Error("Source membership denied");
    vi.mocked(f.remote.authorizeControl).mockRejectedValue(denied);
    await expect(f.submit(request)).rejects.toBe(denied);
    expect(f.coordinator.cleanupSource).not.toHaveBeenCalled(); expect(f.remote.release).not.toHaveBeenCalled();
    expect(f.current().status).toBe("active");
  });

  it.each([release])("preserves a stale explicit version before stopping $kind source", async (request) => {
    const f = fixture(); f.observe(remoteTask(claim, 9n));
    await expect(f.submit(request)).rejects.toThrow("explicit task version no longer matches");
    expect(f.coordinator.cleanupSource).not.toHaveBeenCalled(); expect(f.remote.release).not.toHaveBeenCalled();
  });

  it("allows an authorized administrator to release another owner's local source", async () => {
    const f = fixture(); vi.mocked(f.remote.currentUserId).mockResolvedValue(uuid(90));
    await f.submit(release);
    expect(f.remote.authorizeControl).toHaveBeenCalledWith(projectId, owner, f.options.signal);
    expect(f.current().status).toBe("done");
  });

  it.each([release])("rejects definite $kind refusal without deleting the source or querying again", async (request) => {
    const f = fixture();
    const refusal = new ApiError({ operation: `worker.${request.kind}` }, "response", { cause: new Error("Version conflict"), status: 409, confirmedRefusal: true });
    vi.mocked(f.remote.release).mockRejectedValueOnce(refusal);
    await expect(f.submit(request)).rejects.toBe(refusal);
    expect(f.remote.readTask).toHaveBeenCalledOnce(); expect(f.coordinator.completeSource).not.toHaveBeenCalled();
    expect(f.current().status).toBe("active");
  });

  it("preserves an unconfirmed release error without reading again, replaying, or completing the source", async () => {
    const f = fixture();
    const lost = new ApiError({ operation: "worker.release" }, "response", { cause: new Error("Response lost"), outcomeUnconfirmed: true });
    vi.mocked(f.remote.release).mockRejectedValueOnce(lost);
    await expect(f.submit(release)).rejects.toBe(lost);
    expect(lost.outcomeUnconfirmed).toBe(true);
    expect(f.remote.release).toHaveBeenCalledOnce(); expect(f.remote.readTask).toHaveBeenCalledOnce();
    expect(f.coordinator.completeSource).not.toHaveBeenCalled(); expect(f.current().status).toBe("active");
  });

  it("propagates cancellation after dispatch without replay or completion", async () => {
    const f = fixture(); const controller = new AbortController();
    const failure = new ApiError({ operation: "worker.release" }, "request", { cause: new Error("Cancelled"), outcomeUnconfirmed: true });
    vi.mocked(f.remote.release).mockImplementationOnce(async () => { controller.abort(); throw failure; });
    await expect(submitWorkerControl({ ...f.options, request: release, signal: controller.signal })).rejects.toBe(failure);
    expect(f.remote.readTask).toHaveBeenCalledOnce(); expect(f.remote.release).toHaveBeenCalledOnce();
    expect(f.coordinator.completeSource).not.toHaveBeenCalled();
  });

  it("requires a local unfinished source even when a project is specified", async () => {
    const f = fixture(false);
    await expect(f.submit({ ...release, projectId })).rejects.toThrow("original unfinished local execution");
    expect(f.remote.readTask).not.toHaveBeenCalled(); expect(f.remote.release).not.toHaveBeenCalled();
  });

  it("retains the source if stopping fails and exposes post-success deletion failure for later run cleanup", async () => {
    const f = fixture(); const stop = new Error("Stop unconfirmed");
    f.coordinator.cleanupSource.mockRejectedValueOnce(stop);
    await expect(f.submit(release)).rejects.toBe(stop);
    expect(f.remote.release).not.toHaveBeenCalled();
    const deletion = new Error("Worktree deletion failed"); f.coordinator.completeSource.mockRejectedValueOnce(deletion);
    await expect(f.submit(release)).rejects.toMatchObject({ cause: deletion, message: expect.stringContaining("Release was confirmed") });
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
    expect(f.remote.claim).not.toHaveBeenCalled(); expect(f.coordinator.cleanupSource).not.toHaveBeenCalled();
    expect(f.store.listTasks()).toHaveLength(1);
  });

  it.each(["prompt_unknown", "prompt_too_large", "storage_maintenance", "configuration_pending"] as const)("reports %s as unsubmitted input while retaining the original claim", async reason => {
    const f = fixture();
    f.coordinator.advanceRetry.mockResolvedValue({ kind: "waiting_input", reason });
    const result = await f.submit({ kind: "retry", taskId, claimId });
    expect(result.message).toMatch(/not submitted.*waiting/i);
    expect(result.message).not.toContain("attempt completed");
    expect(result.task).toMatchObject({ ...f.identity, status: "active", sessionId: null });
    expect(f.remote.claim).not.toHaveBeenCalled();
    expect(f.remote.release).not.toHaveBeenCalled();
    if (reason === "configuration_pending") expect(result.message).toContain("Worker configuration readiness");
    if (reason === "storage_maintenance") expect(result.message).toContain("Controller storage maintenance");
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
    f.coordinator.cleanupSource.mockImplementationOnce(async () => { controller.abort(cancelled); return f.resourceOwner; });
    await expect(submitWorkerControl({ ...f.options, request: release, signal: controller.signal })).rejects.toBe(cancelled);
    expect(f.coordinator.cleanupSource).toHaveBeenCalledOnce(); expect(f.remote.release).not.toHaveBeenCalled();
    await expect(submitWorkerControl({ ...f.options, request: release, signal: AbortSignal.abort(cancelled) })).rejects.toBe(cancelled);
    expect(f.remote.release).not.toHaveBeenCalled(); expect(f.coordinator.completeSource).not.toHaveBeenCalled();
  });
});
