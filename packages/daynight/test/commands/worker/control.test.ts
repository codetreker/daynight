import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../src/api/client.js";
import type { Task, WorkerClaim } from "../../../src/api/types.js";
import { createWorkerControlDriver, submitWorkerControl } from "../../../src/commands/worker/control.js";
import type { WorkerControlRequest } from "../../../src/commands/worker/control.js";
import type { WorkerRemote } from "../../../src/commands/worker/remote.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { WorkerStore } from "../../../src/commands/worker/store.js";
import type { FrozenExecutionConfiguration, LocalTask, TransferTarget } from "../../../src/commands/worker/types.js";

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const origin = "https://daynight.example";
const owner = uuid(1), projectId = uuid(2), taskId = uuid(3), claimId = uuid(4), workerId = uuid(5), worktreeId = uuid(6);
const time = "2026-10-27T00:00:00Z";
const machine = { id: uuid(7), name: "source" };
const configuration: FrozenExecutionConfiguration = { agent: "codex", model: "current-model", args: ["--search"], recoveryLimit: 0 };
const target: Omit<TransferTarget, "worktreeId"> = { userId: uuid(10), workerId: uuid(11), machine: { id: uuid(12), name: "target" }, platform: "macos", agent: "copilot" };
const root = fileURLToPath(new URL("../../../../../.tmp/worker-control-tests/", import.meta.url));
const resources: { directory: string; store: WorkerStore }[] = [];
const claim: WorkerClaim = { claimId, userId: owner, workerId, worktreeId, machine, platform: "linux", agent: "copilot", state: "active", phase: "executing", herdr: null, nativeSessionId: null, claimedAt: time };
const remoteTask = (worker: WorkerClaim = claim, version = 8n): Task => ({ id: taskId, projectId, title: "Task", description: "", status: worker.state === "active" ? "in_progress" : "todo", version, properties: { worker, pullRequests: [] }, allowAgents: true, requiredPlatform: null, startedAt: worker.state === "active" ? time : null, completedAt: null, createdAt: time, updatedAt: time, ready: worker.state !== "active", dependsOn: [], externalDependsOn: [], blockedBy: [] });
const fixture = (local = true) => {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, "control-"));
  const store = openWorkerStore(path.join(directory, "state.sqlite"));
  resources.push({ directory, store });
  const project = store.registerProject({ serverOrigin: origin, projectId, repoUrl: "https://github.com/example/repo.git", localPath: path.join(directory, "repository") });
  const identity = { serverOrigin: origin, projectId, taskId, claimId, workerId, worktreeId };
  if (local) { store.registerPending(identity, { kind: "new", configuration: { ...configuration, agent: "copilot" } }, 1000, owner); store.activateTask(identity, 1000); }
  let observed = remoteTask();
  const remote: WorkerRemote = {
    serverOrigin: origin, currentUserId: vi.fn(async () => owner), readTask: vi.fn(async () => observed),
    authorizeControl: vi.fn(async () => {}),
    release: vi.fn(async (_projectId, _taskId, input) => { expect(store.getTask(identity)?.control?.submission).toBe("unknown"); observed = remoteTask({ ...claim, state: "released" }, input.version + 1n); return observed; }),
    transfer: vi.fn(async (_projectId, _taskId, input) => { expect(store.getTask(identity)?.control?.submission).toBe("unknown"); observed = remoteTask({ ...claim, ...input.target, claimId: input.newClaimId, worktreeId: input.worktreeId, phase: "preparing", herdr: null, nativeSessionId: null }, input.version + 1n); return observed; }),
    resume: vi.fn(async (_projectId, _taskId, input) => { expect(store.getClaimAttempt(project)).toMatchObject({ claimId: input.claimId, worktreeId: input.worktreeId, expectedVersion: input.version.toString(), configuration }); observed = remoteTask({ ...claim, ...input, userId: owner, state: "active", phase: "preparing", herdr: null, nativeSessionId: null }, input.version + 1n); return observed; }),
    resolveProject: vi.fn(), ownInventory: vi.fn(), candidates: vi.fn(), claim: vi.fn(), update: vi.fn(),
  };
  const options = { store, remote, serverOrigin: origin, workerId, platform: "linux" as const, machine, repositories: [{ project, configuration }], signal: new AbortController().signal, now: () => 1100 };
  const submit = (request: WorkerControlRequest) => submitWorkerControl({ ...options, request });
  const driver = createWorkerControlDriver(options);
  const current = (): LocalTask => store.getTask(identity)!;
  const clean = (): void => {
    store.beginCleanup(identity, { kind: "terminal", deadline: 601100 }, 1100);
    store.recordCleanupInputOutcome(identity, "unavailable", 1100);
    store.recordCleanupResult(identity, "unavailable", null, 1100);
    store.confirmAgentStopped(identity, { agentStopped: true }, 1100);
    store.confirmWorkspaceClosed(identity, { workspaceClosed: true }, 1100);
    store.confirmWorktreeDeleted(identity, { worktreeDeleted: true }, 1100);
  };
  return { store, project, identity, remote, options, submit, driver, current, clean, observe: (task: Task) => { observed = task; }, observed: () => observed };
};
const release = { kind: "release", taskId, claimId, version: 8n } as const;
const transfer = { kind: "transfer", taskId, claimId, version: 8n, target } as const;
afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, directory } of resources.splice(0)) { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

describe("worker source management decisions", () => {
  it.each([release, transfer])("requires source permission before persisting $kind", async (request) => {
    const f = fixture();
    vi.mocked(f.remote.authorizeControl).mockImplementation(async () => { expect(f.current().control).toBeNull(); throw new Error("Source membership denied"); });
    await expect(f.submit(request)).rejects.toThrow("Source membership denied");
    expect(f.current()).toMatchObject({ control: null, cleanup: null, status: "active" });
    expect(f.remote.release).not.toHaveBeenCalled(); expect(f.remote.transfer).not.toHaveBeenCalled();
  });

  it("checks target membership separately before saving a transfer decision", async () => {
    const f = fixture();
    vi.mocked(f.remote.authorizeControl).mockImplementation(async (_projectId, original, targetUserId) => {
      expect(original).toBe(owner); expect(f.current().control).toBeNull();
      if (targetUserId !== undefined) throw new Error("Target is not a member");
    });
    await expect(f.submit(transfer)).rejects.toThrow("Target is not a member");
    expect(f.remote.authorizeControl).toHaveBeenNthCalledWith(1, projectId, owner, undefined, f.options.signal);
    expect(f.remote.authorizeControl).toHaveBeenNthCalledWith(2, projectId, owner, target.userId, f.options.signal);
    expect(f.current().control).toBeNull();
  });

  it("preserves an explicit stale version without substituting a freshly read version", async () => {
    const f = fixture(); f.observe(remoteTask(claim, 9n));
    await expect(f.submit(release)).rejects.toThrow("explicit task version no longer matches");
    expect(f.current().control).toBeNull(); expect(f.remote.release).not.toHaveBeenCalled();
  });

  it.each([release, transfer])("persists $kind before cleanup and never posts an incompletely cleaned source", async (request) => {
    const f = fixture(); const result = await f.submit(request);
    expect(result.task?.control).toMatchObject({ submission: "not-submitted", intent: { kind: request.kind, sourceClaimId: claimId, version: "8" } });
    expect(() => f.store.beginRecovery(f.identity, 1100)).toThrow("control or cleanup intent");
    expect((await f.driver.advance(f.current(), f.options.signal)).cleanup).toBeNull();
    expect(f.remote.release).not.toHaveBeenCalled(); expect(f.remote.transfer).not.toHaveBeenCalled();
    f.store.beginCleanup(f.identity, { kind: "terminal", deadline: 601100 }, 1100);
    f.store.recordCleanupResult(f.identity, "unavailable", null, 1100); f.store.confirmAgentStopped(f.identity, { agentStopped: true }, 1100);
    await f.driver.advance(f.current(), f.options.signal);
    expect(f.remote.release).not.toHaveBeenCalled(); expect(f.remote.transfer).not.toHaveBeenCalled();
  });

  it.each([release, transfer])("marks $kind unknown before POST and recovers its desired lost response without replay", async (request) => {
    const f = fixture(); await f.submit(request); f.clean();
    const mutation = request.kind === "release" ? vi.mocked(f.remote.release) : vi.mocked(f.remote.transfer);
    const original = mutation.getMockImplementation()!;
    mutation.mockImplementationOnce(async (...args) => { await (original as (...values: typeof args) => Promise<Task>)(...args); throw new Error("Response lost"); });
    await expect(f.driver.advance(f.current(), f.options.signal)).rejects.toThrow("Response lost");
    expect(f.current()).toMatchObject({ status: "active", control: { submission: "unknown" }, cleanup: { worktreeDeleted: true } });
    const recovered = await createWorkerControlDriver(f.options).advance(f.current(), f.options.signal);
    expect(recovered).toMatchObject({ status: "done", control: { submission: "confirmed", outcome: "applied", resultVersion: "9" } });
    expect(mutation).toHaveBeenCalledOnce();
    const repeated = await f.submit(request);
    expect(repeated.task?.status).toBe("done"); expect(mutation).toHaveBeenCalledOnce();
  });

  it("keeps an unknown write fenced when a later GET still shows the old claim", async () => {
    const f = fixture(); await f.submit(release); f.clean();
    vi.mocked(f.remote.release).mockRejectedValueOnce(new Error("Request outcome unknown"));
    await expect(f.driver.advance(f.current(), f.options.signal)).rejects.toThrow("Request outcome unknown");
    await f.driver.advance(f.current(), f.options.signal); await f.submit(release); await f.driver.advance(f.current(), f.options.signal);
    expect(f.current().control?.submission).toBe("unknown"); expect(f.current().status).toBe("active");
    expect(f.remote.release).toHaveBeenCalledOnce();
    await expect(f.submit({ ...release, version: 9n })).rejects.toThrow("unknown write cannot be replaced");
  });

  it("joins a second observer that confirms the applied write before the first POST returns", async () => {
    const f = fixture(); await f.submit(release); f.clean();
    let dispatched!: () => void, finish!: () => void;
    const submitted = new Promise<void>((resolve) => { dispatched = resolve; });
    const response = new Promise<void>((resolve) => { finish = resolve; });
    const original = vi.mocked(f.remote.release).getMockImplementation()!;
    vi.mocked(f.remote.release).mockImplementationOnce(async (...args) => { const result = await original(...args); dispatched(); await response; return result; });
    const first = f.driver.advance(f.current(), f.options.signal);
    try {
      await submitted;
      const observed = await createWorkerControlDriver(f.options).advance(f.current(), f.options.signal, { submit: false });
      expect(observed).toMatchObject({ status: "done", control: { outcome: "applied" } });
    } finally { finish(); }
    expect(await first).toMatchObject({ status: "done", control: { outcome: "applied" } });
    expect(f.remote.release).toHaveBeenCalledOnce();
  });

  it("keeps the observing helper read-only for a fully cleaned unsubmitted source", async () => {
    const f = fixture(); await f.submit(transfer); f.clean();
    const task = await f.driver.advance(f.current(), f.options.signal, { submit: false });
    expect(task.control?.submission).toBe("not-submitted");
    expect(f.remote.release).not.toHaveBeenCalled(); expect(f.remote.transfer).not.toHaveBeenCalled();
  });

  it("allows a new explicit version after definite rejection while retaining completed cleanup", async () => {
    const f = fixture(); await f.submit(release); f.clean(); const cleanup = f.current().cleanup;
    vi.mocked(f.remote.release).mockRejectedValueOnce(new ApiError({ operation: "worker.release" }, "response", { cause: new Error("Version conflict"), status: 409, confirmedRefusal: true }));
    await expect(f.driver.advance(f.current(), f.options.signal)).rejects.toMatchObject({ status: 409 });
    expect(f.current().control?.submission).toBe("rejected");
    f.observe(remoteTask(claim, 9n)); await f.submit({ ...release, version: 9n });
    expect(f.current().cleanup).toEqual(cleanup); expect(f.current().control).toMatchObject({ submission: "not-submitted", intent: { version: "9" } });
    await f.driver.advance(f.current(), f.options.signal);
    expect(f.current().status).toBe("done");
    expect(vi.mocked(f.remote.release).mock.calls.map((call) => call[2].version)).toEqual([8n, 9n]);
  });

  it.each([401, 403, undefined])("permits a newly observed same-version decision after definite refusal or pre-dispatch failure (%s)", async (status) => {
    const f = fixture(); await f.submit(release); f.clean(); const cleanup = f.current().cleanup;
    vi.mocked(f.remote.release).mockRejectedValueOnce(new ApiError({ operation: "worker.release" }, status === undefined ? "request" : "response", { cause: new Error("Definite refusal"), ...(status === undefined ? {} : { status, confirmedRefusal: true }) }));
    await expect(f.driver.advance(f.current(), f.options.signal)).rejects.toMatchObject({ outcomeUnconfirmed: false });
    expect(f.current().control?.submission).toBe("rejected");
    await f.submit(release);
    expect(f.current().cleanup).toEqual(cleanup); expect(f.current().control).toMatchObject({ submission: "not-submitted", intent: { version: "8" } });
    await f.driver.advance(f.current(), f.options.signal);
    expect(f.current().status).toBe("done");
    expect(vi.mocked(f.remote.release).mock.calls.map((call) => call[2].version)).toEqual([8n, 8n]);
  });

  it("retains a definite refusal until a new explicit command and lets only one concurrent replacement submit", async () => {
    const f = fixture(); await f.submit(release); f.clean();
    vi.mocked(f.remote.release).mockRejectedValueOnce(new ApiError({ operation: "worker.release" }, "response", { cause: new Error("Forbidden"), status: 403, confirmedRefusal: true }));
    await expect(f.driver.advance(f.current(), f.options.signal)).rejects.toMatchObject({ status: 403 });
    await f.driver.advance(f.current(), f.options.signal); await f.driver.advance(f.current(), f.options.signal);
    expect(f.remote.release).toHaveBeenCalledOnce();
    const decisions = await Promise.allSettled([f.submit(release), f.submit(release)]);
    expect(decisions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const results = await Promise.all([f.driver.advance(f.current(), f.options.signal), createWorkerControlDriver(f.options).advance(f.current(), f.options.signal)]);
    expect(results.some((task) => task.status === "done")).toBe(true);
    expect(f.remote.release).toHaveBeenCalledTimes(2);
    expect(f.current().status).toBe("done");
  });

  it("does not reinterpret a current admin as the original owner when authorizing retry", async () => {
    const f = fixture(); f.store.pauseTask(f.identity, "Recovery paused", 1100);
    vi.mocked(f.remote.currentUserId).mockResolvedValue(uuid(90));
    await expect(f.submit({ kind: "retry", taskId, claimId })).rejects.toThrow("original authenticated execution owner");
    expect(f.current().recovery.retryAuthorized).toBe(false);
  });

  it("deduplicates concurrent retries and refuses a consumed stale decision", async () => {
    const f = fixture(); f.store.pauseTask(f.identity, "Recovery paused", 1100);
    await Promise.all([f.submit({ kind: "retry", taskId, claimId }), f.submit({ kind: "retry", taskId, claimId })]);
    expect(f.current().recovery).toMatchObject({ count: 0, retryAuthorized: true });
    expect(f.store.beginRecovery(f.identity, 1100).recovery).toMatchObject({ count: 1, retryAuthorized: false });
    await expect(f.submit({ kind: "retry", taskId, claimId })).rejects.toThrow("paused active execution");
    expect(f.current().recovery).toMatchObject({ count: 1, retryAuthorized: false });
  });
});

describe("worker explicit resume grants", () => {
  it("starts from a cleaned source history without inheriting its native session or agent type", async () => {
    const f = fixture(); f.clean(); f.store.completeTask(f.identity, 1100);
    f.observe(remoteTask({ ...claim, state: "released", nativeSessionId: uuid(50), herdr: { session: "old-session", workspaceId: "old-workspace", paneId: "old-pane" } }));
    const result = await f.submit({ kind: "resume", taskId, claimId, version: 8n });
    expect(f.current().status).toBe("done");
    expect(result.task).toMatchObject({ status: "pending", configuration, resources: { worktree: null, nativeSession: null, herdr: null } });
    expect(result.task?.claimId).not.toBe(claimId); expect(result.task?.worktreeId).not.toBe(worktreeId);
    expect(f.store.listTasks()).toHaveLength(2);
  });

  it("persists fresh claim and worktree IDs with current agent settings before POST", async () => {
    const f = fixture(false); f.observe(remoteTask({ ...claim, state: "released", nativeSessionId: uuid(50) }));
    const result = await f.submit({ kind: "resume", taskId, claimId, version: 8n });
    const input = vi.mocked(f.remote.resume).mock.calls[0]![2];
    expect(input.claimId).not.toBe(claimId); expect(input.worktreeId).not.toBe(worktreeId); expect(input.agent).toBe("codex");
    expect(input.previousClaimId).toBe(claimId); expect(input.version).toBe(8n);
    expect(result.task).toMatchObject({ status: "pending", configuration, resources: { worktree: null, herdr: null, nativeSession: null } });
    expect(f.store.getClaimAttempt(f.project)).toBeNull();
  });

  it("recovers an unknown granted resume using its frozen IDs and configuration without replay", async () => {
    const f = fixture(false); f.observe(remoteTask({ ...claim, state: "released" }));
    const original = vi.mocked(f.remote.resume).getMockImplementation()!;
    vi.mocked(f.remote.resume).mockImplementationOnce(async (...args) => { await original(...args); throw new Error("Resume response lost"); });
    const request = { kind: "resume", taskId, claimId, version: 8n } as const;
    await expect(f.submit(request)).rejects.toThrow("Resume response lost");
    const attempt = f.store.getClaimAttempt(f.project)!;
    expect(f.store.listTasks()).toEqual([]);
    const recovered = await submitWorkerControl({ ...f.options, repositories: [{ project: f.project, configuration: { ...configuration, model: "later-default" } }], request });
    expect(recovered.task).toMatchObject({ status: "pending", claimId: attempt.claimId, worktreeId: attempt.worktreeId, configuration });
    expect(f.remote.resume).toHaveBeenCalledOnce(); expect(f.store.getClaimAttempt(f.project)).toBeNull();
  });

  it("keeps the original resume attempt when an old task GET cannot prove the outcome", async () => {
    const f = fixture(false); f.observe(remoteTask({ ...claim, state: "released" }));
    vi.mocked(f.remote.resume).mockRejectedValueOnce(new Error("Resume response unknown"));
    const request = { kind: "resume", taskId, claimId, version: 8n } as const;
    await expect(f.submit(request)).rejects.toThrow("Resume response unknown");
    const attempt = f.store.getClaimAttempt(f.project);
    await expect(f.submit(request)).rejects.toThrow("original request will not be replayed");
    await expect(f.submit({ ...request, version: 9n })).rejects.toThrow("cannot be replaced");
    expect(f.store.getClaimAttempt(f.project)).toEqual(attempt); expect(f.remote.resume).toHaveBeenCalledOnce(); expect(f.store.listTasks()).toEqual([]);
  });

  it("clears a definitely rejected resume attempt without allocating pending resources", async () => {
    const f = fixture(false); f.observe(remoteTask({ ...claim, state: "released" }));
    vi.mocked(f.remote.resume).mockRejectedValueOnce(new ApiError({ operation: "worker.resume" }, "response", { cause: new Error("Denied"), status: 403, confirmedRefusal: true }));
    await expect(f.submit({ kind: "resume", taskId, claimId, version: 8n })).rejects.toMatchObject({ status: 403 });
    expect(f.store.getClaimAttempt(f.project)).toBeNull(); expect(f.store.listTasks()).toEqual([]);
  });
});
