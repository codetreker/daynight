import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationError } from "../../../src/api/operation.js";
import { isWorkerCancellation } from "../../../src/commands/worker/execution.js";
import { createCleanupDriver } from "../../../src/commands/worker/cleanup.js";
import { HerdrAgentActionError, HerdrRpcError } from "../../../src/commands/worker/herdr.js";
import { createWorkerCoordinator } from "../../../src/commands/worker/coordinator.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { WorkerEvent, WorkerGitManager } from "../../../src/commands/worker/execution.js";
import type { HerdrAgentObservation, HerdrAgentStartInput, HerdrExecutionContext, HerdrOwnedWorkspace, HerdrTaskBinding, WorkerHerdrAdapter } from "../../../src/commands/worker/herdr.js";
import type { ManagedAssignment } from "../../../src/commands/worker/prompts.js";
import type { WorkerRemote } from "../../../src/commands/worker/remote.js";
import type { Task, WorkerClaimDescriptor } from "../../../src/api/types.js";
import type { ExecutionConfiguration, ResourceOwner, WorkerProject, WorktreeBinding } from "../../../src/commands/worker/types.js";

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const origin = "https://daynight.example";
const workerId = uuid(1);
const configuration: ExecutionConfiguration = { agent: "codex", model: "current-model", args: ["--search"], recoveryLimit: 2 };
const directories: string[] = [];
const stores: ReturnType<typeof openWorkerStore>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const task = (projectId: string, id: string): Task => ({ id, projectId, title: id, description: "task", status: "todo", allowAgents: true, requiredPlatform: null, startedAt: null, completedAt: null, version: 1n, properties: { worker: null, pullRequests: [] }, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true });
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 3500, interval: 10 });
const fixture = async (maxConcurrent = 1) => {
  const base = path.resolve("../../.tmp/minimal-coordinator-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "r-")); directories.push(root);
  let store = openWorkerStore(path.join(root, "state.sqlite")); stores.push(store);
  const project: WorkerProject = { projectId: uuid(10), repoUrl: "https://example.test/owner/repo.git", localPath: path.join(root, "repo") }; store.registerProject(project);
  const candidates = [task(project.projectId, uuid(100)), task(project.projectId, uuid(101))];
  const grants = new Map<string, Task>();
  const worktrees = new Map<string, { owner: ResourceOwner; binding: WorktreeBinding }>();
  const resources = new Map<string, HerdrOwnedWorkspace>();
  const events: WorkerEvent[] = []; const order: string[] = []; let clock = 1000; let sequence = 0;
  let blockedStartupInput = false;
  const bind = (owner: ResourceOwner): WorktreeBinding => {
    const source = store.getProject(owner)!;
    return { repositoryPath: source.localPath, commonDirectory: path.join(source.localPath, ".git"), worktreePath: path.join(source.localPath, ".worktrees", "daynight", owner.taskId), branch: `daynight/${owner.taskId}` };
  };
  const observe = (context: ResourceOwner, binding: HerdrTaskBinding): HerdrAgentObservation => ({ ...resources.get(context.claimId)!.panes[0]!, name: "managed", binding });
  const git = {
    prepareRepository: vi.fn(), dispose: vi.fn(),
    prepareWorktree: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => { expect(store.getTask(owner)?.status).toBe("active"); order.push("prepare-worktree"); const binding = bind(owner); worktrees.set(owner.claimId, { owner, binding }); return binding; }),
    verifyWorktree: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => { const found = worktrees.get(owner.claimId); if (found === undefined) throw new Error("Original worktree missing"); return found.binding; }),
    findWorktree: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => worktrees.get(owner.claimId)?.binding ?? null),
    listWorktrees: vi.fn(async (source: WorkerProject) => [...worktrees.values()].filter(({ owner }) => owner.projectId === source.projectId)),
    removeWorktree: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => { expect(resources.has(owner.claimId)).toBe(false); order.push("remove-worktree"); worktrees.delete(owner.claimId); }),
  } as unknown as WorkerGitManager;
  const tasks = {
    pendingStops: vi.fn((): { context: ResourceOwner & { cwd: string }; binding: HerdrTaskBinding }[] => []),
    listResources: vi.fn(async () => structuredClone([...resources.values()])),
    prepareWorkspace: vi.fn(async (context: HerdrExecutionContext, _title: string) => {
      sequence++; const binding = { session: "w", workspaceId: `w${sequence}`, paneId: `p${sequence}`, terminalId: `t${sequence}` };
      resources.set(context.claimId, { owner: { projectId: context.projectId, taskId: context.taskId, claimId: context.claimId, worktreeId: context.worktreeId }, workspaceId: binding.workspaceId, panes: [{ binding, cwd: context.cwd, kind: null, status: "idle", launchPending: false, interactiveReady: false, nativeSession: null, stateChangeSeq: 0, completionSeq: 0 }] });
      return binding;
    }),
    syncWorkspaceName: vi.fn(async (_context: HerdrExecutionContext, _binding: HerdrTaskBinding, _title: string) => {}),
    observe: vi.fn(async (context: HerdrExecutionContext, binding: HerdrTaskBinding) => observe(context, binding)),
    start: vi.fn(async (context: HerdrExecutionContext, binding: HerdrTaskBinding, input: HerdrAgentStartInput) => {
      order.push("start"); const pane = resources.get(context.claimId)!.panes[0]!;
      pane.kind = context.agent; pane.status = "idle"; pane.interactiveReady = true; pane.stateChangeSeq = 1;
      pane.nativeSession = { source: "herdr", agent: context.agent, sessionId: input.resumeSessionId ?? uuid(1000 + sequence) };
      if (blockedStartupInput) {
        blockedStartupInput = false; pane.status = "blocked"; pane.nativeSession = null;
        throw new HerdrAgentActionError("trust requires input", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" });
      }
      input.onPromptSubmitted?.({ submission: "submitted", observation: observe(context, binding) });
      pane.status = "working"; pane.stateChangeSeq = 2;
      return observe(context, binding);
    }),
    submitPrompt: vi.fn(async (context: HerdrExecutionContext, binding: HerdrTaskBinding, prompt: string) => {
      order.push("notify"); const pane = resources.get(context.claimId)!.panes[0]!;
      const before = observe(context, binding);
      pane.interactiveReady = true; pane.stateChangeSeq! += 1;
      if (prompt.startsWith("The controller is stopping this execution")) { pane.status = "idle"; pane.completionSeq! += 1; }
      else pane.status = "working";
      return { submission: "submitted" as const, observation: before };
    }),
    stopAndClose: vi.fn(async (owner: ResourceOwner) => { order.push("stop-close"); resources.delete(owner.claimId); }),
  };
  const herdr = { tasks, ensureInstance: vi.fn(async () => {}), stopInstance: vi.fn() } as unknown as WorkerHerdrAdapter;
  const grant = (candidate: Task, descriptor: WorkerClaimDescriptor): Task => {
    const result: Task = { ...candidate, status: "in_progress", ready: false, version: candidate.version + 1n, properties: { ...candidate.properties, worker: { ...descriptor, agentControlMode: descriptor.agentControlMode ?? "herdr", userId: uuid(2), state: "active", phase: "preparing", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } } };
    grants.set(descriptor.claimId, result); return result;
  };
  const remote = {
    serverOrigin: origin, currentUserId: vi.fn(async () => uuid(2)),
    ownInventory: vi.fn(async () => [...grants.values()]),
    candidates: vi.fn(async function* (projectId: string) { for (const candidate of candidates) if (candidate.projectId === projectId && ![...grants.values()].some((value) => value.id === candidate.id)) yield candidate; }),
    claim: vi.fn(async (candidate: Task, descriptor: WorkerClaimDescriptor) => grant(candidate, descriptor)),
    readTask: vi.fn(async (_projectId: string, taskId: string) => { const result = [...grants.values()].find((value) => value.id === taskId); if (result === undefined) throw new Error("missing task"); return result; }),
    update: vi.fn(async (current: Task, update: object) => { const result = { ...current, properties: { ...current.properties, worker: { ...current.properties.worker!, ...update } } }; grants.set(current.properties.worker!.claimId, result); return result; }),
  } as unknown as WorkerRemote;
  const options = { store, git, herdr, remote, serverOrigin: origin, workerId, platform: "linux" as const, machine: { id: uuid(3), name: "fixture" }, repositories: [{ project, configuration }], globalConfiguration: configuration, maxConcurrent, buildPrompt: vi.fn((_assignment: ManagedAssignment) => "worker-managed using-daynight autopilot-managed-task"), emit: (event: WorkerEvent) => events.push(event), now: () => clock };
  const reopenStore = () => {
    stores.splice(stores.indexOf(store), 1); store.close();
    store = openWorkerStore(path.join(root, "state.sqlite")); stores.push(store); options.store = store;
    return store;
  };
  return { root, get store() { return store; }, reopenStore, project, candidates, grants, grant, resources, worktrees, git, herdr, tasks, remote, order, events, options, coordinator: createWorkerCoordinator(options), clock: (value: number) => { clock = value; }, bind, blockStartupInput: () => { blockedStartupInput = true; } };
};

const addOrphan = (f: Awaited<ReturnType<typeof fixture>>, taskId = uuid(900)) => {
  const owner = { projectId: f.project.projectId, taskId, claimId: uuid(901), worktreeId: uuid(902) };
  const binding = { session: "w", workspaceId: "orphan", paneId: "orphan-pane", terminalId: "orphan-terminal" };
  const pane: HerdrOwnedWorkspace["panes"][number] = { binding, cwd: f.bind(owner).worktreePath, kind: "copilot", status: "working", launchPending: false, interactiveReady: true, nativeSession: { source: "herdr", agent: "copilot", sessionId: uuid(903) }, stateChangeSeq: 1, completionSeq: 0 };
  f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
  f.resources.set(owner.claimId, { owner, workspaceId: binding.workspaceId, panes: [pane] });
  return { owner, binding, pane };
};

describe("minimal worker resource reconciliation", () => {
  it("commits active before startup, saves the native ID and reconnects without replay", async () => {
    const f = await fixture(); await f.coordinator.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    await eventually(() => expect(f.store.listTasks()[0]!.sessionId).not.toBeNull());
    const row = f.store.listTasks()[0]!;
    expect(Object.keys(row).sort()).toEqual(["agent", "agentControlMode", "claimId", "projectId", "sessionId", "status", "taskId"]);
    expect(f.events).toContainEqual({ kind: "info", task: { ...row, sessionId: null }, message: "Starting a new native conversation in the task worktree." });
    expect(f.events.some((event) => event.kind === "warning")).toBe(false);
    await f.coordinator.tick(); await eventually(() => expect(f.tasks.observe).toHaveBeenCalled());
    expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.options.buildPrompt).toHaveBeenCalledOnce();
  });

  it("synchronizes the latest title without changing the running conversation or its assignment", async () => {
    const f = await fixture(); await f.coordinator.tick();
    await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    const workspace = structuredClone(f.resources.get(row.claimId)!);
    const current = f.grants.get(row.claimId)!;
    f.grants.set(row.claimId, { ...current, title: "修复 Herdr 启动 👩‍💻" });
    await f.coordinator.tick();
    await eventually(() => expect(f.tasks.syncWorkspaceName).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: row.claimId, worktreeId: workspace.owner.worktreeId }), workspace.panes[0]!.binding, "修复 Herdr 启动 👩‍💻", expect.anything(),
    ));
    expect(f.resources.get(row.claimId)).toEqual(workspace);
    expect(f.store.getTask(row)).toEqual(row);
    expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.options.buildPrompt).toHaveBeenCalledOnce();
    expect(f.tasks.prepareWorkspace.mock.calls[0]![1]).toBe(current.title);
    expect(f.options.buildPrompt.mock.calls[0]![0]).toMatchObject({ serverOrigin: origin });
    expect(f.options.buildPrompt.mock.calls[0]![0]).not.toHaveProperty("title");
  });

  it("settles a pending workspace stop before synchronizing or recovering its name", async () => {
    const f = await fixture(); await f.coordinator.tick();
    await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    const workspace = f.resources.get(row.claimId)!;
    const pending = [{ context: { ...workspace.owner, cwd: f.bind(workspace.owner).worktreePath }, binding: workspace.panes[0]!.binding }];
    f.tasks.pendingStops.mockImplementation(() => [...pending]);
    f.tasks.stopAndClose.mockImplementation(async () => { pending.splice(0); f.resources.delete(row.claimId); });
    f.tasks.syncWorkspaceName.mockClear();
    await f.coordinator.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(2));
    expect(f.tasks.syncWorkspaceName).not.toHaveBeenCalled();
    expect(f.tasks.stopAndClose).toHaveBeenCalledOnce();
    expect(f.tasks.start.mock.calls[1]![2]).toMatchObject({ resumeSessionId: row.sessionId });
    expect(f.store.getTask(row)).toEqual(row);
  });

  it("keeps naming failures outside the execution recovery budget", async () => {
    const f = await fixture(); await f.coordinator.tick();
    await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    const failure = new HerdrAgentActionError("rename response lost", "workspace.rename", "unknown");
    f.tasks.syncWorkspaceName.mockRejectedValue(failure);
    const observations = f.tasks.observe.mock.calls.length;
    for (let turn = 0; turn < 4; turn++) {
      await f.coordinator.tick();
      await eventually(() => expect(f.tasks.observe).toHaveBeenCalledTimes(observations + turn + 1));
    }
    expect(f.events.filter((event) => event.kind === "workspace-name-error")).toHaveLength(4);
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "workspace-name-error", task: row, error: failure }));
    expect(f.events.some((event) => event.kind === "execution-error")).toBe(false);
    expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.store.getTask(row)).toEqual(row);
  });

  it.each(["transport", "deadline"] as const)("keeps naming discovery %s failures outside a zero execution recovery budget", async (kind) => {
    const f = await fixture();
    const limited = { ...configuration, recoveryLimit: 0 };
    const coordinator = createWorkerCoordinator({ ...f.options, globalConfiguration: limited, repositories: [{ project: f.project, configuration: limited }] });
    await coordinator.tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    const originalWorkspace = structuredClone(f.resources.get(row.claimId)!);
    const failure = kind === "transport"
      ? new HerdrRpcError("Naming discovery connection closed", { method: "session.snapshot", requestId: uuid(951), submission: "unknown" })
      : new OperationError("deadline");
    const resources = structuredClone([...f.resources.values()]);
    // Reconciliation reads two snapshots before the serialized naming discovery.
    f.tasks.listResources.mockResolvedValueOnce(resources).mockResolvedValueOnce(resources).mockRejectedValueOnce(failure);
    const observations = f.tasks.observe.mock.calls.length;
    f.tasks.syncWorkspaceName.mockClear();
    await coordinator.tick();
    await eventually(() => expect(f.tasks.observe).toHaveBeenCalledTimes(observations + 1));
    expect(f.tasks.syncWorkspaceName).not.toHaveBeenCalled();
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "workspace-name-error", task: row, error: failure }));
    await coordinator.tick();
    await eventually(() => expect(f.tasks.observe).toHaveBeenCalledTimes(observations + 2));
    expect(f.tasks.syncWorkspaceName).toHaveBeenCalledOnce();
    expect(f.events.filter((event) => event.kind === "workspace-name-error")).toHaveLength(1);
    expect(f.events.some((event) => event.kind === "execution-error")).toBe(false);
    expect(f.resources.get(row.claimId)).toEqual(originalWorkspace);
    expect(f.store.getTask(row)).toEqual(row); expect(f.tasks.start).toHaveBeenCalledOnce();
  });

  it("propagates cancellation during naming discovery without reporting a cosmetic failure", async () => {
    const f = await fixture(); const controller = new AbortController();
    const coordinator = createWorkerCoordinator({ ...f.options, signal: controller.signal });
    await coordinator.tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    const reason = new Error("Original claim cancelled during name discovery");
    vi.mocked(f.herdr.tasks.listResources).mockImplementationOnce(async (operation) => { controller.abort(reason); operation.check(); return []; });
    const observations = f.tasks.observe.mock.calls.length;
    await expect(coordinator.advanceRetry(row)).rejects.toMatchObject({ kind: "cancelled", cause: reason });
    expect(f.tasks.observe).toHaveBeenCalledTimes(observations);
    expect(f.events.some((event) => event.kind === "workspace-name-error")).toBe(false);
    expect(f.store.getTask(row)).toEqual(row);
  });

  it("keeps malformed naming discovery as a lifecycle failure", async () => {
    const f = await fixture(); await f.coordinator.tick();
    await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const malformed = new TypeError("The Herdr workspace label must be a string.");
    const resources = structuredClone([...f.resources.values()]);
    f.tasks.listResources.mockResolvedValueOnce(resources).mockResolvedValueOnce(resources).mockRejectedValueOnce(malformed);
    const observations = f.tasks.observe.mock.calls.length;
    await f.coordinator.tick();
    await eventually(() => expect(f.events).toContainEqual(expect.objectContaining({ kind: "execution-error", error: malformed })));
    expect(f.tasks.observe).toHaveBeenCalledTimes(observations);
    expect(f.events.some((event) => event.kind === "workspace-name-error")).toBe(false);
  });

  it("continues a healthy agent at zero recovery budget after a post-rename snapshot transport failure", async () => {
    const f = await fixture();
    const limited = { ...configuration, recoveryLimit: 0 };
    const coordinator = createWorkerCoordinator({ ...f.options, globalConfiguration: limited, repositories: [{ project: f.project, configuration: limited }] });
    await coordinator.tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    const originalWorkspace = structuredClone(f.resources.get(row.claimId)!);
    const current = f.grants.get(row.claimId)!;
    f.grants.set(row.claimId, { ...current, title: "Rename already acknowledged" });
    const snapshotFailure = new HerdrRpcError("Connection closed after rename ACK", { method: "session.snapshot", requestId: uuid(950), submission: "unknown" });
    const nameFailure = new HerdrAgentActionError("The renamed workspace could not be observed", "workspace.rename", "unknown", { cause: snapshotFailure });
    f.tasks.syncWorkspaceName.mockRejectedValueOnce(nameFailure);
    const observations = f.tasks.observe.mock.calls.length;
    await coordinator.tick();
    await eventually(() => expect(f.tasks.observe).toHaveBeenCalledTimes(observations + 1));
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "workspace-name-error", task: row, error: nameFailure }));
    expect(nameFailure.cause).toBe(snapshotFailure);
    await coordinator.tick();
    await eventually(() => expect(f.tasks.observe).toHaveBeenCalledTimes(observations + 2));
    expect(f.events.filter((event) => event.kind === "workspace-name-error")).toHaveLength(1);
    expect(f.events.some((event) => event.kind === "execution-error")).toBe(false);
    expect(f.resources.get(row.claimId)).toEqual(originalWorkspace);
    expect(f.store.getTask(row)).toEqual(row); expect(f.tasks.start).toHaveBeenCalledOnce();
  });

  it("synchronizes existing workspaces after execution recovery is exhausted", async () => {
    const f = await fixture();
    const limited = { ...configuration, recoveryLimit: 0 };
    const coordinator = createWorkerCoordinator({ ...f.options, globalConfiguration: limited, repositories: [{ project: f.project, configuration: limited }] });
    await coordinator.tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    const failed = new Error("native observation failed");
    f.tasks.observe.mockRejectedValueOnce(failed);
    await coordinator.tick();
    await eventually(() => expect(f.events).toContainEqual(expect.objectContaining({ kind: "execution-error", error: failed })));
    const observations = f.tasks.observe.mock.calls.length;
    const current = f.grants.get(row.claimId)!;
    f.grants.set(row.claimId, { ...current, title: "Renamed while recovery is exhausted" });
    await coordinator.tick();
    await eventually(() => expect(f.tasks.syncWorkspaceName).toHaveBeenCalledWith(expect.anything(), expect.anything(), "Renamed while recovery is exhausted", expect.anything()));
    expect(f.tasks.observe).toHaveBeenCalledTimes(observations);
    expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.store.getTask(row)).toEqual(row);
  });

  it("keeps ownership mismatches as execution failures rather than cosmetic naming errors", async () => {
    const f = await fixture(); await f.coordinator.tick();
    await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const mismatch = new Error("The task pane or terminal identity has changed.");
    f.tasks.syncWorkspaceName.mockRejectedValueOnce(mismatch);
    const observations = f.tasks.observe.mock.calls.length;
    await f.coordinator.tick();
    await eventually(() => expect(f.events).toContainEqual(expect.objectContaining({ kind: "execution-error", error: mismatch })));
    expect(f.tasks.observe).toHaveBeenCalledTimes(observations);
    expect(f.events.some((event) => event.kind === "workspace-name-error")).toBe(false);
  });

  it("does not clean or launch from a failed inventory", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    vi.mocked(f.remote.ownInventory).mockRejectedValueOnce(new Error("page 2 failed"));
    await expect(f.coordinator.tick()).rejects.toThrow("page 2 failed");
    expect(f.tasks.stopAndClose).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
  });

  it("materializes a positive remote grant before a Herdr failure", async () => {
    const f = await fixture(); f.candidates.splice(0);
    f.grant(task(f.project.projectId, uuid(200)), { claimId: uuid(201), workerId, machine: f.options.machine, platform: "linux", agent: "codex", worktreeId: uuid(202) });
    vi.mocked(f.herdr.ensureInstance).mockRejectedValueOnce(new Error("Herdr offline"));
    await expect(f.coordinator.tick()).rejects.toThrow("Herdr offline");
    expect(f.store.listTasks()).toEqual([{ projectId: f.project.projectId, taskId: uuid(200), claimId: uuid(201), agent: "codex", agentControlMode: "herdr" as const, sessionId: null, status: "pending" }]);
  });

  it("recovers an unknown claim result through inventory without replay", async () => {
    const f = await fixture();
    vi.mocked(f.remote.claim).mockImplementationOnce(async (candidate, descriptor) => { f.grant(candidate, descriptor); throw new Error("response lost"); });
    await f.coordinator.tick(); expect(f.store.listTasks()).toHaveLength(0); expect(f.tasks.start).not.toHaveBeenCalled();
    await f.coordinator.tick(); await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    expect(f.remote.claim).toHaveBeenCalledOnce();
  });

  it("cold-resumes a recorded native session with current configuration", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const old = f.store.listTasks()[0]!; f.resources.clear();
    const current = { ...configuration, model: "updated-model" }; const restarted = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: current }], globalConfiguration: current });
    await restarted.tick(); await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(2));
    expect(f.tasks.start.mock.calls[1]![2]).toMatchObject({ resumeSessionId: old.sessionId, configuration: current });
    expect(f.store.getTask(old)?.sessionId).toBe(old.sessionId);
  });

  it("starts fresh after an interrupted active NULL-session launch", async () => {
    const f = await fixture(); f.candidates.splice(0);
    const granted = f.grant(task(f.project.projectId, uuid(200)), { claimId: uuid(201), workerId, machine: f.options.machine, platform: "linux", agent: "codex", worktreeId: uuid(202) });
    f.store.registerPending({ projectId: granted.projectId, taskId: granted.id, claimId: uuid(201), agent: "codex" });
    const active = f.store.activateTask({ projectId: granted.projectId, taskId: granted.id, claimId: uuid(201) });
    await f.coordinator.tick(); await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    expect(f.tasks.start.mock.calls[0]![2]).not.toHaveProperty("resumeSessionId");
    expect(f.events).toContainEqual({ kind: "info", task: active, message: "Starting a new native conversation in the task worktree." });
    expect(f.events.some((event) => event.kind === "warning")).toBe(false);
  });

  it("cleans an ended claim in stop/close/delete order and retains history", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const old = f.store.listTasks()[0]!; f.grants.clear(); f.candidates.splice(0);
    await f.coordinator.tick(); await eventually(() => expect(f.store.getTask(old)?.status).toBe("done"));
    expect(f.order.slice(-3)).toEqual(["notify", "stop-close", "remove-worktree"]);
    expect(f.store.getTask(old)?.sessionId).toBe(old.sessionId);
  });

  it("holds a newer same-task claim pending until old resources are removed", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const old = f.store.listTasks()[0]!; f.grants.clear(); f.candidates.splice(0);
    const newer = f.grant(task(old.projectId, old.taskId), { claimId: uuid(400), workerId, machine: f.options.machine, platform: "linux", agent: "codex", worktreeId: uuid(401) });
    await f.coordinator.tick(); expect(f.store.getTask({ ...old, claimId: uuid(400) })?.status).toBe("pending");
    await eventually(() => expect(f.store.getTask(old)?.status).toBe("done"));
    await f.coordinator.tick(); await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(2));
    expect(f.store.getTask({ projectId: newer.projectId, taskId: newer.id, claimId: uuid(400) })?.status).toBe("active");
  });

  it("keeps positive grants but treats a resource observation failure as an error", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    f.grants.clear(); vi.mocked(f.herdr.tasks.listResources).mockRejectedValueOnce(new Error("snapshot failed"));
    await expect(f.coordinator.tick()).rejects.toThrow("snapshot failed");
    expect(f.store.listTasks()[0]!.status).toBe("active"); expect(f.git.removeWorktree).not.toHaveBeenCalled();
  });

  it.each(["working", "blocked", "idle"] as const)("directly stops a %s agent on shutdown and preserves its claim for native resume", async (status) => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const old = f.store.listTasks()[0]!; vi.mocked(f.remote.ownInventory).mockRejectedValue(new Error("service offline"));
    f.resources.get(old.claimId)!.panes[0]!.status = status;
    const inventoryReads = vi.mocked(f.remote.ownInventory).mock.calls.length;
    const originalClaim = structuredClone(f.grants.get(old.claimId));
    await expect(f.coordinator.shutdown()).resolves.toBe(true);
    expect(f.store.getTask(old)).toEqual(old); expect(f.worktrees.has(old.claimId)).toBe(true); expect(f.resources.size).toBe(0);
    expect(f.tasks.stopAndClose).toHaveBeenCalledOnce(); expect(f.tasks.submitPrompt).not.toHaveBeenCalled();
    expect(f.git.removeWorktree).not.toHaveBeenCalled(); expect(f.grants.get(old.claimId)).toEqual(originalClaim);
    expect(f.remote.ownInventory).toHaveBeenCalledTimes(inventoryReads);
    vi.mocked(f.remote.ownInventory).mockResolvedValue([...f.grants.values()]);
    await createWorkerCoordinator(f.options).tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(2));
    expect(f.tasks.start.mock.calls[1]![2]).toMatchObject({ resumeSessionId: old.sessionId });
    expect(f.store.getTask(old)).toEqual(old);
  });

  it("interrupts an already waiting terminal cleanup without another prompt or worktree deletion", async () => {
    const f = await fixture(); await f.coordinator.tick();
    await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    f.tasks.submitPrompt.mockImplementation(async (context, binding) => {
      const observation = { ...f.resources.get(context.claimId)!.panes[0]!, name: "managed", binding };
      return { submission: "submitted", observation };
    });
    f.grants.clear(); f.candidates.splice(0);
    await f.coordinator.tick();
    await eventually(() => expect(f.tasks.submitPrompt).toHaveBeenCalledOnce());
    expect(f.tasks.stopAndClose).not.toHaveBeenCalled(); expect(f.store.getTask(row)).toEqual(row);
    let settled = false;
    const shutdown = f.coordinator.shutdown().then((complete) => { settled = true; return complete; });
    try { await eventually(() => expect(settled).toBe(true)); }
    finally { if (!settled) f.clock(601_001); await shutdown; }
    await expect(shutdown).resolves.toBe(true);
    expect(f.tasks.submitPrompt).toHaveBeenCalledOnce(); expect(f.tasks.stopAndClose).toHaveBeenCalledOnce();
    expect(f.git.removeWorktree).not.toHaveBeenCalled(); expect(f.worktrees.has(row.claimId)).toBe(true);
    expect(f.store.getTask(row)).toEqual(row); expect(f.resources.size).toBe(0);
    expect(f.events.some((event) => event.kind === "cleanup-error")).toBe(false);
  });

  it.each(["waiting cleanup", "direct shutdown"])("persists a rowless orphan through %s and a SQLite restart before starting its successor", async (mode) => {
    const f = await fixture(); f.candidates.splice(1);
    const { owner, pane } = addOrphan(f, f.candidates[0]!.id);
    const unproven = { ...owner, taskId: uuid(950), claimId: uuid(951), worktreeId: uuid(952) };
    f.worktrees.set(unproven.claimId, { owner: unproven, binding: f.bind(unproven) });
    // The native reference can identify the provider when Herdr has no current kind.
    pane.kind = null;
    f.tasks.submitPrompt.mockImplementation(async (context, binding) => ({ submission: "submitted", observation: { ...f.resources.get(context.claimId)!.panes[0]!, name: "managed", binding } }));
    if (mode === "waiting cleanup") {
      await f.coordinator.tick();
      await eventually(() => expect(f.tasks.submitPrompt).toHaveBeenCalledOnce());
      expect(f.remote.claim).not.toHaveBeenCalled(); expect(f.tasks.stopAndClose).not.toHaveBeenCalled();
    }
    await expect(f.coordinator.shutdown()).resolves.toBe(true);
    const row = { projectId: owner.projectId, taskId: owner.taskId, claimId: owner.claimId, status: "pending", agent: "copilot", agentControlMode: "herdr" as const, sessionId: uuid(903) };
    expect(f.store.getTask(owner)).toEqual(row);
    expect(f.tasks.submitPrompt).toHaveBeenCalledTimes(mode === "waiting cleanup" ? 1 : 0);
    expect(f.resources.has(owner.claimId)).toBe(false); expect(f.worktrees.has(owner.claimId)).toBe(true);
    expect(f.git.removeWorktree).not.toHaveBeenCalled(); expect(f.store.getTask(unproven)).toBeNull();
    f.reopenStore(); expect(f.store.getTask(owner)).toEqual(row);
    f.grant(task(owner.projectId, owner.taskId), { claimId: uuid(904), workerId, machine: f.options.machine, platform: "linux", agent: "codex", worktreeId: uuid(905) });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const remove = vi.mocked(f.git.removeWorktree).getMockImplementation()!;
    vi.mocked(f.git.removeWorktree).mockImplementationOnce(async (...args) => { await wait; return remove(...args); });
    const restarted = createWorkerCoordinator(f.options);
    try {
      await restarted.tick();
      await eventually(() => expect(f.git.removeWorktree).toHaveBeenCalledOnce());
      expect(f.store.getTask({ ...owner, claimId: uuid(904) })?.status).toBe("pending");
      expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.store.getTask(owner)).toEqual(row);
    } finally { release(); }
    await eventually(() => expect(f.store.getTask(owner)?.status).toBe("done"));
    await restarted.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    const successor = f.store.listTasks().find((local) => local.claimId !== owner.claimId)!;
    expect(successor).toMatchObject({ taskId: owner.taskId, status: "active", agent: "codex" });
    expect(successor.sessionId).not.toBe(row.sessionId);
    expect(f.store.getTask(owner)).toEqual({ ...row, status: "done" });
    expect(vi.mocked(f.git.removeWorktree).mock.calls.map(([, identity]) => identity.claimId)).toEqual([owner.claimId]);
    expect(f.order.indexOf("remove-worktree")).toBeLessThan(f.order.indexOf("start"));
    expect(f.worktrees.has(unproven.claimId)).toBe(true); expect(f.store.getTask(unproven)).toBeNull();
  });

  it("persists a rowless orphan before a pending PID stop can be cancelled and recovers after restart", async () => {
    const f = await fixture(); f.candidates.splice(0);
    const { owner, binding } = addOrphan(f);
    const pending = [{ context: { ...owner, cwd: f.bind(owner).worktreePath }, binding }];
    f.tasks.pendingStops.mockImplementation(() => [...pending]);
    vi.mocked(f.herdr.tasks.stopAndClose).mockImplementationOnce(async (_context, _binding, operation) => {
      expect(f.store.getTask(owner)).toMatchObject({ status: "pending", agent: "copilot", agentControlMode: "herdr" as const, sessionId: uuid(903) });
      f.resources.delete(owner.claimId);
      await new Promise<void>((resolve) => { operation.signal.addEventListener("abort", () => resolve(), { once: true }); });
      operation.check();
    });
    f.tasks.stopAndClose.mockImplementation(async () => { pending.splice(0); });
    await f.coordinator.tick();
    await eventually(() => expect(f.tasks.stopAndClose).toHaveBeenCalledOnce());
    await expect(f.coordinator.shutdown()).resolves.toBe(true);
    expect(pending).toHaveLength(0); expect(f.worktrees.has(owner.claimId)).toBe(true);
    expect(f.tasks.submitPrompt).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
    f.reopenStore();
    expect(f.store.getTask(owner)).toMatchObject({ status: "pending", sessionId: uuid(903) });
    await createWorkerCoordinator(f.options).tick();
    await eventually(() => expect(f.store.getTask(owner)?.status).toBe("done"));
    expect(f.worktrees.has(owner.claimId)).toBe(false);
    expect(f.events.some((event) => event.kind === "cleanup-error")).toBe(false);
  });

  it.each(["workspace", "pending stop", "pending stop without workspace"])("retains a rowless orphan with unknown agent type during cleanup and shutdown: %s", async (kind) => {
    const f = await fixture(); f.candidates.splice(0);
    const { owner, pane, binding } = addOrphan(f);
    pane.kind = null; pane.nativeSession = null; pane.interactiveReady = false;
    const pending = [{ context: { ...owner, cwd: f.bind(owner).worktreePath }, binding }];
    if (kind !== "workspace") f.tasks.pendingStops.mockImplementation(() => [...pending]);
    if (kind === "pending stop without workspace") f.resources.clear();
    await f.coordinator.tick();
    await eventually(() => expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-error", error: expect.objectContaining({ message: expect.stringContaining("without an observed native agent type") }) })));
    await expect(f.coordinator.shutdown()).resolves.toBe(false);
    expect(f.store.getTask(owner)).toBeNull(); expect(f.worktrees.has(owner.claimId)).toBe(true);
    expect(f.resources.has(owner.claimId)).toBe(kind !== "pending stop without workspace");
    expect(f.tasks.stopAndClose).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
    expect(f.tasks.submitPrompt).not.toHaveBeenCalled();
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "shutdown-error", error: expect.objectContaining({ message: expect.stringContaining("without an observed native agent type") }) }));
  });

  it("records orphan ownership pending beside an active successor without retaining a stale native reference", async () => {
    const f = await fixture(); f.candidates.splice(0);
    const { owner, pane } = addOrphan(f);
    pane.kind = null; pane.interactiveReady = false;
    const successor = f.store.registerPending({ ...owner, claimId: uuid(904), agent: "codex", agentControlMode: "herdr" as const, sessionId: uuid(905) });
    f.store.activateTask(successor);
    await expect(f.coordinator.shutdown()).resolves.toBe(true);
    expect(f.store.getTask(owner)).toMatchObject({ status: "pending", agent: "copilot", agentControlMode: "herdr" as const, sessionId: null });
    expect(f.store.getTask(successor)).toEqual({ ...successor, status: "active" });
    expect(f.worktrees.has(owner.claimId)).toBe(true);
  });

  it.each(["workspace", "pending stop"])("reports a failed %s stop and still stops a healthy sibling", async (kind) => {
    const f = await fixture(2); await f.coordinator.tick();
    await eventually(() => expect(f.remote.update).toHaveBeenCalledTimes(2));
    const rows = f.store.listTasks(); const failed = rows[0]!; const healthy = rows[1]!;
    const workspace = f.resources.get(failed.claimId)!;
    if (kind === "pending stop") {
      f.resources.delete(failed.claimId);
      f.tasks.pendingStops.mockReturnValue([{ context: { ...workspace.owner, cwd: f.bind(workspace.owner).worktreePath }, binding: workspace.panes[0]!.binding }]);
    }
    const failure = new Error("native process still alive");
    const stop = f.tasks.stopAndClose.getMockImplementation()!;
    f.tasks.stopAndClose.mockImplementation(async (owner) => {
      if (owner.claimId === failed.claimId) throw failure;
      await stop(owner);
    });
    await expect(f.coordinator.shutdown()).resolves.toBe(false);
    expect(f.resources.has(healthy.claimId)).toBe(false); expect(f.store.listTasks()).toEqual(rows);
    expect(f.worktrees.size).toBe(2); expect(f.git.removeWorktree).not.toHaveBeenCalled();
    expect(f.tasks.submitPrompt).not.toHaveBeenCalled();
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "shutdown-error", task: failed, error: failure }));
  });

  it("reports an unknown project resource without treating it as ended", async () => {
    const f = await fixture(); f.candidates.splice(0);
    f.resources.set(uuid(800), { owner: { projectId: uuid(900), taskId: uuid(901), claimId: uuid(800), worktreeId: uuid(902) }, workspaceId: "unknown", panes: [] });
    await expect(f.coordinator.tick()).rejects.toThrow("Restore the project configuration");
    expect(f.tasks.stopAndClose).not.toHaveBeenCalled();
  });

  it("keeps a definitely unsent first input only in the current process", async () => {
    const f = await fixture();
    f.blockStartupInput();
    await f.coordinator.tick();
    await eventually(() => expect(f.events.some((event) => event.message.includes("first managed input"))).toBe(true));
    const pane = [...f.resources.values()][0]!.panes[0]!; pane.status = "idle";
    await f.coordinator.tick(); await eventually(() => expect(f.tasks.submitPrompt).toHaveBeenCalledOnce());
    expect(f.tasks.start).toHaveBeenCalledOnce();
    await f.coordinator.tick(); expect(f.tasks.submitPrompt).toHaveBeenCalledOnce();
  });

  it("pings after restart without recovering or replaying a lost first-input decision", async () => {
    const f = await fixture();
    f.blockStartupInput();
    await f.coordinator.tick(); await eventually(() => expect(f.events.some((event) => event.message.includes("first managed input"))).toBe(true));
    [...f.resources.values()][0]!.panes[0]!.status = "idle";
    const restarted = createWorkerCoordinator(f.options); await restarted.tick();
    await eventually(() => expect(f.events.some((event) => event.kind === "reconnected")).toBe(true));
    expect(f.tasks.submitPrompt).toHaveBeenCalledOnce();
    expect(f.tasks.submitPrompt.mock.calls[0]![2]).toContain("worker's periodic check");
    expect(f.tasks.submitPrompt.mock.calls[0]![2]).not.toBe(f.options.buildPrompt.mock.results[0]!.value);
    expect(f.tasks.start).toHaveBeenCalledOnce();
  });

  it("resets cleanup timing with a new in-memory driver", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const row = f.store.listTasks()[0]!; const owner = f.worktrees.get(row.claimId)!.owner;
    f.tasks.submitPrompt.mockImplementation(async (context, binding) => ({ submission: "submitted", observation: { ...f.resources.get(context.claimId)!.panes[0]!, name: "managed", binding } }));
    const deps = { store: f.store, git: f.git, herdr: f.herdr, platform: "linux" as const, serverOrigin: origin, workerId, buildPrompt: f.options.buildPrompt, emit: f.options.emit, now: f.options.now };
    const first = createCleanupDriver(deps);
    expect(await first.advance({ task: row, project: f.project, owner }, await f.tasks.listResources(), true)).toBe(false);
    f.clock(602_000);
    const restarted = createCleanupDriver(deps);
    expect(await restarted.advance({ task: row, project: f.project, owner }, await f.tasks.listResources(), true)).toBe(false);
    expect(f.tasks.stopAndClose).not.toHaveBeenCalled();
    f.clock(1_203_000);
    expect(await restarted.advance({ task: row, project: f.project, owner }, await f.tasks.listResources(), true)).toBe(true);
    expect(f.tasks.submitPrompt).toHaveBeenCalledTimes(2);
    expect(f.tasks.stopAndClose).toHaveBeenCalledOnce();
  });

  it("cleans actual resources left behind a historical done row", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const old = f.store.listTasks()[0]!; f.store.completeTask(old); f.grants.clear();
    await f.coordinator.tick();
    expect(f.remote.claim).toHaveBeenCalledOnce();
    await eventually(() => expect(f.resources.size).toBe(0));
    expect(f.store.getTask(old)?.status).toBe("done");
    expect(f.git.removeWorktree).toHaveBeenCalledOnce();
  });


  it("preserves a rowless Git marker without proof that this worker owns it", async () => {
    const f = await fixture(); f.candidates.splice(0);
    const owner = { projectId: f.project.projectId, taskId: uuid(700), claimId: uuid(701), worktreeId: uuid(702) };
    f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    await f.coordinator.tick();
    expect(f.git.removeWorktree).not.toHaveBeenCalled(); expect(f.tasks.stopAndClose).not.toHaveBeenCalled();
    expect(f.events.some((event) => event.message.includes("unproven Git ownership"))).toBe(true);
    await expect(f.coordinator.shutdown()).resolves.toBe(true);
    expect(f.worktrees.has(owner.claimId)).toBe(true);
  });

  it("reports stable unproven ownership warnings once and reports their recurrence", async () => {
    const f = await fixture(); f.candidates.splice(0);
    const owners = [700, 710].map((id) => ({ projectId: f.project.projectId, taskId: uuid(id), claimId: uuid(id + 1), worktreeId: uuid(id + 2) }));
    for (const owner of owners) f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    await f.coordinator.tick(); await f.coordinator.tick(); await f.coordinator.tick();
    expect(f.events.filter((event) => event.kind === "warning")).toHaveLength(2);

    const changed = { ...owners[0]!, worktreeId: uuid(720) };
    f.worktrees.set(changed.claimId, { owner: changed, binding: f.bind(changed) });
    await f.coordinator.tick(); await f.coordinator.tick();
    expect(f.events.filter((event) => event.kind === "warning")).toHaveLength(3);

    const retained = [...f.worktrees]; f.worktrees.clear();
    await f.coordinator.tick();
    for (const [claimId, worktree] of retained) f.worktrees.set(claimId, worktree);
    await f.coordinator.tick(); await f.coordinator.tick();
    expect(f.events.filter((event) => event.kind === "warning")).toHaveLength(5);
    expect(f.git.removeWorktree).not.toHaveBeenCalled(); expect(f.tasks.stopAndClose).not.toHaveBeenCalled();
  });

  it("retains warning history when a later project makes the snapshot incomplete", async () => {
    const f = await fixture(); f.candidates.splice(0);
    const other = { projectId: uuid(800), repoUrl: "https://example.test/other.git", localPath: path.join(f.root, "other") };
    f.store.registerProject(other);
    const owner = { projectId: f.project.projectId, taskId: uuid(700), claimId: uuid(701), worktreeId: uuid(702) };
    const worktree = { owner, binding: f.bind(owner) };
    f.worktrees.set(owner.claimId, worktree);
    await f.coordinator.tick();
    expect(f.events.filter((event) => event.kind === "warning")).toHaveLength(1);

    f.worktrees.clear();
    const list = vi.mocked(f.git.listWorktrees).getMockImplementation()!;
    vi.mocked(f.git.listWorktrees).mockImplementation(async (project, operation) => {
      if (project.projectId === other.projectId) throw new Error("other repository unreadable");
      return list(project, operation);
    });
    await expect(f.coordinator.tick()).rejects.toThrow("other repository unreadable");
    vi.mocked(f.git.listWorktrees).mockImplementation(list);
    f.worktrees.set(owner.claimId, worktree);
    await f.coordinator.tick();
    expect(f.events.filter((event) => event.kind === "warning")).toHaveLength(1);
  });

  it("keeps independent warning histories during project-scoped shutdown observations", async () => {
    const f = await fixture(); f.candidates.splice(0);
    const other = { projectId: uuid(800), repoUrl: "https://example.test/other.git", localPath: path.join(f.root, "other") };
    f.store.registerProject(other);
    for (const [index, project] of [f.project, other].entries()) {
      const owner = { projectId: project.projectId, taskId: uuid(700 + index * 10), claimId: uuid(701 + index * 10), worktreeId: uuid(702 + index * 10) };
      f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    }
    await f.coordinator.tick();
    expect(f.events.filter((event) => event.kind === "warning")).toHaveLength(2);
    await expect(f.coordinator.shutdown()).resolves.toBe(true);
    expect(f.events.filter((event) => event.kind === "warning")).toHaveLength(2);
    expect(f.worktrees.size).toBe(2); expect(f.git.removeWorktree).not.toHaveBeenCalled();
  });

  it("scopes one source cleanup away from an unrelated Git observation failure", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const row = f.store.listTasks()[0]!;
    f.store.registerProject({ projectId: uuid(800), repoUrl: "https://example.test/other.git", localPath: path.join(f.root, "other") });
    const list = vi.mocked(f.git.listWorktrees).getMockImplementation()!;
    vi.mocked(f.git.listWorktrees).mockImplementation(async (project, operation) => { if (project.projectId === uuid(800)) throw new Error("other repository unreadable"); return list(project, operation); });
    await expect(f.coordinator.cleanupSource(row)).resolves.toEqual(f.worktrees.get(row.claimId)!.owner);
    expect(f.resources.has(row.claimId)).toBe(false); expect(f.worktrees.has(row.claimId)).toBe(true);
  });

  it("settles the adapter stop responsibility before deleting an absent workspace", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const row = f.store.listTasks()[0]!; const owner = f.worktrees.get(row.claimId)!.owner;
    f.tasks.submitPrompt.mockImplementation(async (context, binding) => ({ submission: "submitted", observation: { ...f.resources.get(context.claimId)!.panes[0]!, name: "managed", binding } }));
    const driver = createCleanupDriver({ store: f.store, git: f.git, herdr: f.herdr, platform: "linux", serverOrigin: origin, workerId, buildPrompt: f.options.buildPrompt, emit: f.options.emit, now: f.options.now });
    const input = { task: row, project: f.project, owner };
    expect(await driver.advance(input, await f.tasks.listResources(), true)).toBe(false); f.clock(602_000);
    const pending: { context: ResourceOwner & { cwd: string }; binding: HerdrTaskBinding }[] = [];
    f.tasks.pendingStops.mockImplementation(() => [...pending]);
    f.tasks.stopAndClose.mockImplementationOnce(async (context) => {
      pending.push({ context: { ...context, cwd: path.join(f.project.localPath, ".worktrees", "daynight", row.taskId) }, binding: [...f.resources.values()][0]!.panes[0]!.binding });
      f.resources.clear(); throw new Error("process still live");
    });
    await expect(driver.advance(input, await f.tasks.listResources(), true)).rejects.toThrow("process still live");
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
    f.tasks.stopAndClose.mockRejectedValueOnce(new Error("process still live"));
    await expect(driver.advance(input, [], true)).rejects.toThrow("process still live");
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
    f.tasks.stopAndClose.mockImplementationOnce(async () => { pending.splice(0); });
    expect(await driver.advance(input, [], true)).toBe(true);
    expect(f.tasks.stopAndClose).toHaveBeenCalledTimes(3); expect(f.git.removeWorktree).toHaveBeenCalledOnce();
  });


  it("keeps terminal cleanup running across repeated absence reconciliation", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const row = f.store.listTasks()[0]!; f.grants.clear(); f.candidates.splice(0);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const remove = vi.mocked(f.git.removeWorktree).getMockImplementation()!;
    vi.mocked(f.git.removeWorktree).mockImplementation(async (project, owner, operation) => {
      await waiting;
      operation.check();
      await remove(project, owner, operation);
    });
    await f.coordinator.tick(); await eventually(() => expect(f.git.removeWorktree).toHaveBeenCalledOnce());
    await f.coordinator.tick(); await f.coordinator.tick(); await f.coordinator.tick();
    expect(f.store.getTask(row)?.status).toBe("active");
    release(); await eventually(() => expect(f.store.getTask(row)?.status).toBe("done"));
    expect(f.git.removeWorktree).toHaveBeenCalledOnce();
  });

  it("does not authorize private-instance shutdown with unmapped project resources", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const row = f.store.listTasks()[0]!;
    const unhandled = { projectId: uuid(900), taskId: uuid(901), claimId: uuid(902), worktreeId: uuid(903) };
    f.resources.set(unhandled.claimId, { owner: unhandled, workspaceId: "unhandled", panes: [] });
    await expect(f.coordinator.shutdown()).resolves.toBe(false);
    expect(f.resources.has(unhandled.claimId)).toBe(true);
    expect(f.resources.has(row.claimId)).toBe(false);
    expect(f.worktrees.has(row.claimId)).toBe(true);
    expect(f.events.some((event) => event.kind === "shutdown-error" && event.message.includes("unhandled Herdr resources"))).toBe(true);
  });


  it("retries using the exact validated original claim observation", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const row = f.store.listTasks()[0]!; const original = f.grants.get(row.claimId)!; f.resources.clear();
    const replacement: Task = { ...original, properties: { ...original.properties, worker: { ...original.properties.worker!, claimId: uuid(950), workerId: uuid(951), worktreeId: uuid(952) } } };
    vi.mocked(f.remote.readTask).mockResolvedValueOnce(original).mockResolvedValueOnce(replacement);
    await f.coordinator.advanceRetry(row);
    expect(f.remote.readTask).toHaveBeenCalledOnce();
    expect(f.tasks.start.mock.calls.at(-1)![0].claimId).toBe(row.claimId);
    expect(f.tasks.start.mock.calls.at(-1)![0].worktreeId).toBe(original.properties.worker!.worktreeId);
  });

  it.each(["claim", "worker"])("rejects a retry after the original %s identity changes", async (field) => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const row = f.store.listTasks()[0]!; const original = f.grants.get(row.claimId)!;
    const worker = { ...original.properties.worker!, ...(field === "claim" ? { claimId: uuid(950) } : { workerId: uuid(951) }) };
    vi.mocked(f.remote.readTask).mockResolvedValue({ ...original, properties: { ...original.properties, worker } });
    await expect(f.coordinator.advanceRetry(row)).rejects.toThrow("no longer active on this worker");
    expect(f.tasks.start).toHaveBeenCalledOnce();
  });


  it("stops and deletes one source without scanning a corrupt sibling in the same project", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const row = f.store.listTasks()[0]!;
    vi.mocked(f.git.listWorktrees).mockRejectedValue(new Error("unregistered sibling reservation"));
    const owner = await f.coordinator.cleanupSource(row);
    expect(f.resources.has(row.claimId)).toBe(false); expect(f.worktrees.has(row.claimId)).toBe(true);
    await f.coordinator.completeSource(owner);
    expect(f.worktrees.has(row.claimId)).toBe(false); expect(f.store.getTask(row)?.status).toBe("done");
  });

  it("continues a known Herdr claim's terminal cleanup despite a corrupt sibling scan", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const row = f.store.listTasks()[0]!; f.grants.clear(); f.candidates.splice(0);
    vi.mocked(f.git.listWorktrees).mockRejectedValue(new Error("unregistered sibling reservation"));
    await expect(f.coordinator.tick()).rejects.toThrow("unregistered sibling reservation");
    await eventually(() => expect(f.store.getTask(row)?.status).toBe("done"));
    expect(f.resources.has(row.claimId)).toBe(false); expect(f.worktrees.has(row.claimId)).toBe(false);
  });

  it("stops a healthy agent at shutdown when sibling Git discovery fails", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const row = f.store.listTasks()[0]!;
    vi.mocked(f.git.listWorktrees).mockRejectedValue(new Error("unregistered sibling reservation"));
    await expect(f.coordinator.shutdown()).resolves.toBe(false);
    expect(f.resources.has(row.claimId)).toBe(false); expect(f.worktrees.has(row.claimId)).toBe(true);
    expect(f.store.getTask(row)).toEqual(row); expect(f.tasks.submitPrompt).not.toHaveBeenCalled();
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "shutdown-error", error: expect.objectContaining({ message: "unregistered sibling reservation" }) }));
  });

  it("claims one task per repository turn while preserving each ready order", async () => {
    const f = await fixture(3);
    const second: WorkerProject = { projectId: uuid(20), repoUrl: "https://example.test/owner/second.git", localPath: path.join(f.root, "second") };
    f.store.registerProject(second); f.options.repositories.push({ project: second, configuration });
    f.candidates.push(task(second.projectId, uuid(200)), task(second.projectId, uuid(201)));
    await f.coordinator.tick();
    expect(vi.mocked(f.remote.claim).mock.calls.map(([candidate]) => candidate.id)).toEqual([uuid(100), uuid(200), uuid(101)]);
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(3));
  });

  it("round-robins pending work per free slot instead of draining the first project", async () => {
    const f = await fixture(2);
    const second: WorkerProject = { projectId: uuid(20), repoUrl: "https://example.test/owner/second.git", localPath: path.join(f.root, "second") };
    f.store.registerProject(second); f.options.repositories.push({ project: second, configuration }); f.candidates.splice(0);
    for (const [projectId, taskId, claimId] of [[f.project.projectId, uuid(100), uuid(300)], [f.project.projectId, uuid(101), uuid(301)], [second.projectId, uuid(200), uuid(302)]]) {
      f.grant(task(projectId!, taskId!), { claimId: claimId!, workerId, machine: f.options.machine, platform: "linux", agent: "codex", worktreeId: uuid(Number(claimId!.slice(-3)) + 100) });
    }
    await f.coordinator.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(2));
    expect(f.store.listTasks().filter((row) => row.status === "active").map((row) => row.taskId).sort()).toEqual([uuid(100), uuid(200)]);
    expect(f.store.listTasks().find((row) => row.taskId === uuid(101))?.status).toBe("pending");
  });

  it("starts another repository while the first repository's native launch waits", async () => {
    const f = await fixture(2);
    const second: WorkerProject = { projectId: uuid(20), repoUrl: "https://example.test/owner/second.git", localPath: path.join(f.root, "second") };
    f.store.registerProject(second); f.options.repositories.push({ project: second, configuration }); f.candidates.push(task(second.projectId, uuid(200)));
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const start = f.tasks.start.getMockImplementation()!;
    f.tasks.start.mockImplementation(async (context, binding, input) => { if (context.projectId === f.project.projectId) await wait; return start(context, binding, input); });
    await f.coordinator.tick();
    await eventually(() => expect([...f.resources.values()].find((resource) => resource.owner.projectId === second.projectId)?.panes[0]?.nativeSession).toMatchObject({ agent: "codex" }));
    expect(vi.mocked(f.remote.claim).mock.calls.map(([candidate]) => candidate.projectId)).toEqual([f.project.projectId, second.projectId]);
    release(); await eventually(() => expect(f.store.listTasks().every((row) => row.sessionId !== null)).toBe(true));
  });


  it("settles an adapter stop during shutdown even after workspace loss and sibling discovery failure", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const row = f.store.listTasks()[0]!; const owner = f.worktrees.get(row.claimId)!.owner;
    const binding = f.resources.get(row.claimId)!.panes[0]!.binding;
    const pending = [{ context: { ...owner, cwd: f.bind(owner).worktreePath }, binding }];
    f.tasks.pendingStops.mockImplementation(() => [...pending]);
    f.resources.clear();
    f.tasks.stopAndClose.mockImplementation(async () => { pending.splice(0); });
    vi.mocked(f.git.listWorktrees).mockRejectedValue(new Error("unregistered sibling reservation"));
    await expect(f.coordinator.shutdown()).resolves.toBe(false);
    expect(f.tasks.stopAndClose).toHaveBeenCalledOnce(); expect(pending).toHaveLength(0);
    expect(f.worktrees.has(row.claimId)).toBe(true); expect(f.store.getTask(row)?.status).toBe("active");
  });

  it("settles a recorded claim's cached stop before a failing resource read during shutdown", async () => {
    const f = await fixture(); await f.coordinator.tick();
    await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    const workspace = f.resources.get(row.claimId)!;
    const pending = [{ context: { ...workspace.owner, cwd: f.bind(workspace.owner).worktreePath }, binding: workspace.panes[0]!.binding }];
    f.tasks.pendingStops.mockImplementation(() => [...pending]);
    f.tasks.stopAndClose.mockImplementation(async () => { pending.splice(0); f.resources.clear(); });
    f.tasks.listResources.mockRejectedValue(new Error("Herdr resource read failed"));
    await expect(f.coordinator.shutdown()).resolves.toBe(false);
    expect(f.tasks.stopAndClose).toHaveBeenCalledOnce(); expect(pending).toHaveLength(0);
    expect(f.worktrees.has(row.claimId)).toBe(true); expect(f.store.getTask(row)).toEqual(row);
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
  });


  it("cleans a force-withdrawn claim from inventory absence when the remote worker record is cleared", async () => {
    const f = await fixture(); await f.coordinator.tick();
    await eventually(() => expect(f.store.listTasks()[0]?.sessionId).toEqual(expect.any(String)));
    const row = f.store.listTasks()[0]!;
    const original = f.grants.get(row.claimId)!;
    const withdrawn: Task = { ...original, status: "todo", allowAgents: false, startedAt: null, completedAt: null, version: original.version + 1n, properties: { ...original.properties, worker: null } };
    f.grants.clear(); f.candidates.splice(0);
    vi.mocked(f.remote.readTask).mockResolvedValue(withdrawn);
    await f.coordinator.tick();
    await eventually(() => expect(f.store.getTask(row)?.status).toBe("done"));
    expect(f.resources.has(row.claimId)).toBe(false); expect(f.worktrees.has(row.claimId)).toBe(false);
    expect(f.remote.readTask).not.toHaveBeenCalled(); expect(f.tasks.start).toHaveBeenCalledOnce();
    expect(f.store.getTask(row)?.sessionId).toBe(row.sessionId);
  });


  it.each(["readable Git", "corrupt sibling"])("settles a cached stop before completing an absent claim with %s and no remaining workspace", async (discovery) => {
    const f = await fixture(); await f.coordinator.tick();
    await eventually(() => expect(f.store.listTasks()[0]?.sessionId).toEqual(expect.any(String)));
    const row = f.store.listTasks()[0]!;
    const owner = f.worktrees.get(row.claimId)!.owner;
    const binding = f.resources.get(row.claimId)!.panes[0]!.binding;
    const pending = [{ context: { ...owner, cwd: f.bind(owner).worktreePath }, binding }];
    f.tasks.pendingStops.mockImplementation(() => [...pending]);
    f.grants.clear(); f.candidates.splice(0); f.resources.clear(); f.worktrees.clear();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    f.tasks.stopAndClose.mockImplementation(async () => { await wait; pending.splice(0); });
    if (discovery === "corrupt sibling") vi.mocked(f.git.listWorktrees).mockRejectedValue(new Error("unregistered sibling reservation"));
    try {
      if (discovery === "corrupt sibling") await expect(f.coordinator.tick()).rejects.toThrow("unregistered sibling reservation");
      else await f.coordinator.tick();
      expect(f.store.getTask(row)?.status).toBe("active");
      await eventually(() => expect(f.tasks.stopAndClose).toHaveBeenCalledOnce());
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
    } finally { release(); }
    await eventually(() => expect(f.store.getTask(row)?.status).toBe("done"));
    expect(pending).toHaveLength(0); expect(f.git.removeWorktree).toHaveBeenCalledOnce();
  });


  it("reobserves the task when round snapshots contain an obsolete inactive pane", async () => {
    const f = await fixture(); await f.coordinator.tick();
    await eventually(() => expect(f.store.listTasks()[0]?.sessionId).toEqual(expect.any(String)));
    await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    const row = f.store.listTasks()[0]!;
    const pane = f.resources.get(row.claimId)!.panes[0]!;
    pane.kind = null; pane.interactiveReady = false; pane.status = "idle";
    const obsolete = structuredClone([...f.resources.values()]);
    pane.kind = "codex"; pane.interactiveReady = true; pane.status = "working";
    f.tasks.listResources.mockResolvedValueOnce(obsolete).mockResolvedValueOnce(obsolete);
    await f.coordinator.tick();
    await eventually(() => expect(f.tasks.observe).toHaveBeenCalled());
    expect(f.tasks.stopAndClose).not.toHaveBeenCalled(); expect(f.tasks.start).toHaveBeenCalledOnce();
    expect(f.store.getTask(row)?.sessionId).toBe(row.sessionId);
  });


  it("keeps an ended rowless orphan's slot while its closed workspace still has pending native PIDs", async () => {
    const f = await fixture();
    const owner = { projectId: f.project.projectId, taskId: uuid(900), claimId: uuid(901), worktreeId: uuid(902) };
    const binding = { session: "w", workspaceId: "orphan", paneId: "orphan-pane", terminalId: "orphan-terminal" };
    f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    f.resources.set(owner.claimId, { owner, workspaceId: binding.workspaceId, panes: [{ binding, cwd: f.bind(owner).worktreePath, kind: "codex", status: "working", launchPending: false, interactiveReady: true, nativeSession: { source: "herdr", agent: "codex", sessionId: uuid(903) }, stateChangeSeq: 1, completionSeq: 0 }] });
    const pending: { context: ResourceOwner & { cwd: string }; binding: HerdrTaskBinding }[] = [];
    f.tasks.pendingStops.mockImplementation(() => [...pending]);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    f.tasks.stopAndClose.mockImplementationOnce(async () => {
      pending.push({ context: { ...owner, cwd: f.bind(owner).worktreePath }, binding });
      f.resources.delete(owner.claimId); throw new Error("orphan native process still alive");
    });
    f.tasks.stopAndClose.mockImplementation(async () => { await wait; pending.splice(0); });
    try {
      await f.coordinator.tick();
      await eventually(() => expect(f.events.some((event) => event.kind === "cleanup-error")).toBe(true));
      await f.coordinator.tick();
      expect(f.store.getTask(owner)).toEqual({ projectId: owner.projectId, taskId: owner.taskId, claimId: owner.claimId, status: "pending", agent: "codex", agentControlMode: "herdr" as const, sessionId: uuid(903) });
      expect(f.remote.claim).not.toHaveBeenCalled(); expect(f.tasks.start).not.toHaveBeenCalled();
    } finally { release(); await eventually(() => expect(f.worktrees.has(owner.claimId)).toBe(false)); }
    await f.coordinator.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
  });

  it.each(["same project", "another project"])("recovers an already active own task despite corrupt Git discovery in %s", async (scope) => {
    const f = await fixture(); await f.coordinator.tick();
    await eventually(() => expect(f.store.listTasks()[0]?.sessionId).toEqual(expect.any(String)));
    await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    f.resources.clear(); f.candidates.splice(0);
    const corruptProject = scope === "same project" ? f.project : { projectId: uuid(950), repoUrl: "https://example.test/other.git", localPath: path.join(f.root, "other") };
    if (scope === "another project") f.store.registerProject(corruptProject);
    const list = vi.mocked(f.git.listWorktrees).getMockImplementation()!;
    vi.mocked(f.git.listWorktrees).mockImplementation(async (project, operation) => {
      if (project.projectId === corruptProject.projectId) throw new Error("unregistered sibling reservation");
      return list(project, operation);
    });
    await expect(f.coordinator.tick()).rejects.toThrow("unregistered sibling reservation");
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(2));
    expect(f.tasks.start.mock.calls[1]![2]).toMatchObject({ resumeSessionId: row.sessionId });
    expect(f.remote.claim).toHaveBeenCalledOnce(); expect(f.store.getTask(row)?.status).toBe("active");
  });


  it.each(["Herdr", "Git"])("cancels a no-workspace startup immediately after ownership ends even when %s discovery fails", async (discovery) => {
    const f = await fixture();
    let entered!: () => void; let release!: () => void; let preparing: AbortSignal | undefined;
    const enteredPreparation = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const prepare = vi.mocked(f.git.prepareWorktree).getMockImplementation()!;
    vi.mocked(f.git.prepareWorktree).mockImplementation(async (project, owner, operation) => {
      preparing = operation.signal; entered(); await wait; operation.check(); return prepare(project, owner, operation);
    });
    await f.coordinator.tick(); await enteredPreparation;
    const row = f.store.listTasks()[0]!;
    f.grants.clear(); f.candidates.splice(0);
    if (discovery === "Herdr") f.tasks.listResources.mockRejectedValueOnce(new Error("Herdr discovery failed"));
    else vi.mocked(f.git.listWorktrees).mockRejectedValueOnce(new Error("Git discovery failed"));
    let cancelledBeforeRelease = false;
    try {
      await expect(f.coordinator.tick()).rejects.toThrow(`${discovery} discovery failed`);
      cancelledBeforeRelease = preparing!.aborted;
    } finally { release(); }
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect({ cancelledBeforeRelease, workspaces: f.tasks.prepareWorkspace.mock.calls.length, launches: f.tasks.start.mock.calls.length }).toEqual({ cancelledBeforeRelease: true, workspaces: 0, launches: 0 });
    expect(f.store.getTask(row)?.status).toBe("active");
  });

});


describe("worker cancellation classification", () => {
  it("recognizes an aggregate made entirely of the current shutdown cancellations", () => {
    const controller = new AbortController(); const reason = new Error("Worker operation interrupted."); controller.abort(reason);
    const first = new OperationError("cancelled", { cause: reason });
    const second = new Error("Endpoint request stopped", { cause: new OperationError("cancelled", { cause: reason }) });
    expect(isWorkerCancellation(new AggregateError([first, second], "Both endpoints could not be inspected"), controller.signal)).toBe(true);
    expect(isWorkerCancellation(new AggregateError([new AggregateError([first, second], "Concurrent cancellation")], "Shutdown"), controller.signal)).toBe(true);
  });

  it("preserves a real endpoint failure mixed with cancellation", () => {
    const controller = new AbortController(); const reason = new Error("Worker operation interrupted."); controller.abort(reason);
    const cancellation = new OperationError("cancelled", { cause: reason });
    expect(isWorkerCancellation(new AggregateError([cancellation, new Error("Endpoint configuration invalid")], "Endpoints failed", { cause: reason }), controller.signal)).toBe(false);
    expect(isWorkerCancellation(new AggregateError([], "No endpoint observations", { cause: reason }), controller.signal)).toBe(false);
  });

  it("does not suppress another operation's cancellation or errors before shutdown", () => {
    const controller = new AbortController(); const reason = new Error("Worker operation interrupted.");
    const cancellation = new OperationError("cancelled", { cause: reason });
    expect(isWorkerCancellation(new AggregateError([cancellation], "Not shutting down"), controller.signal)).toBe(false);
    controller.abort(reason);
    expect(isWorkerCancellation(new AggregateError([new OperationError("cancelled", { cause: new Error("Another operation") })], "Foreign cancellation"), controller.signal)).toBe(false);
  });
});

it("routes Web claims without Herdr, freezes launch settings, and keeps interaction state out of task summary", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(); const webStore = openWebExecutionStore(path.join(f.root, "web.sqlite"));
  const webConfiguration = { agent: "codex" as const, agentControlMode: "web" as const, model: "frozen-model", args: [], recoveryLimit: 2 };
  const advance = vi.fn(async (input: import("../../../src/commands/worker/backends/web-types.js").LocalTask) => {
    let record = webStore.initializeWebExecution(input, 2);
    record = webStore.updateWebExecution(record, { activity: "waiting_input", initialInputState: "confirmed" }, 3);
    return webStore.bindNativeSession(record, { source: "controller", sessionId: uuid(880) }, 4);
  });
  const verifyWebUnregistered = vi.fn(async () => {});
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: webConfiguration }], globalConfiguration: webConfiguration, webStore, verifyWebServer: vi.fn(async () => {}), verifyWebUnregistered, webBackend: { advance, cleanup: vi.fn() } });
  try {
    await coordinator.tick(); await eventually(() => expect(advance).toHaveBeenCalledOnce());
    await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    expect(row).toMatchObject({ agentControlMode: "web", sessionId: uuid(880) });
    expect(f.herdr.ensureInstance).not.toHaveBeenCalled(); expect(f.tasks.listResources).not.toHaveBeenCalled();
    expect(vi.mocked(f.remote.update).mock.calls[0]![1]).toEqual({ phase: "executing", nativeSessionId: uuid(880), herdr: null });
    webConfiguration.model = "changed-model";
    Object.assign(webConfiguration, { agentControlMode: "herdr", args: ["--search"] });
    await coordinator.tick(); await eventually(() => expect(advance).toHaveBeenCalledTimes(2));
    expect(webStore.getTask(row)?.configuration?.model).toBe("frozen-model");
    expect(verifyWebUnregistered).toHaveBeenCalledOnce();
  } finally { webStore.close(); }
});

it("missing Web execution evidence never permits replacing or deleting an existing server Session", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(); const webStore = openWebExecutionStore(path.join(f.root, "web.sqlite"));
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
  const remote = f.grant(f.candidates[0]!, { claimId: uuid(810), workerId, worktreeId: uuid(811), agent: "codex", agentControlMode: "web", platform: "linux", machine: { id: uuid(3), name: "fixture" } });
  const row = f.store.registerPending({ projectId: remote.projectId, taskId: remote.id, claimId: uuid(810), agent: "codex", agentControlMode: "web" }); f.store.activateTask(row);
  const advance = vi.fn(), cleanup = vi.fn(); const refusal = new Error("Existing Session requires original execution evidence.");
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [], globalConfiguration: configuration, webStore, webBackend: { advance, cleanup }, verifyWebServer: vi.fn(async () => {}), verifyWebUnregistered: vi.fn(async () => { throw refusal; }) });
  try {
    await coordinator.tick(); await eventually(() => expect(f.events.some(event => event.kind === "execution-error")).toBe(true));
    expect(advance).not.toHaveBeenCalled(); expect(webStore.getTask(row)).toBeNull();
    await expect(coordinator.cleanupSource(row, { deleteWorktree: true })).rejects.toBe(refusal);
    expect(cleanup).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
    expect(f.store.getTask(row)?.status).toBe("active");
    f.grants.clear();
    await expect(coordinator.tick()).rejects.toThrow("resource evidence");
    expect(f.store.getTask(row)?.status).toBe("active");
    expect(await coordinator.shutdown()).toBe(false);
  } finally { webStore.close(); }
});
