import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerCoordinator } from "../../../src/commands/worker/coordinator.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { HerdrAgentActionError } from "../../../src/commands/worker/herdr.js";
import { herdrExecutionLabel } from "../../../src/commands/worker/herdr/agents.js";
import { buildHerdrAgentArguments } from "../../../src/commands/worker/herdr/arguments.js";
import { ApiError } from "../../../src/api/client.js";
import type { Task, WorkerClaim } from "../../../src/api/types.js";
import type { HerdrAgentObservation, HerdrExecutionContext, HerdrOwnedWorkspace, HerdrTaskBinding, HerdrWorkspaceEvidence, WorkerHerdrAdapter } from "../../../src/commands/worker/herdr.js";
import type { WorkerGitManager, WorkerEvent } from "../../../src/commands/worker/execution.js";
import type { WorkerRemote } from "../../../src/commands/worker/remote.js";
import type { LocalTask, WorkerProject, FrozenExecutionConfiguration } from "../../../src/commands/worker/types.js";

const uuid = (value: number): string => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const origin = "https://daynight.example";
const workerId = uuid(1);
const configuration: FrozenExecutionConfiguration = { agent: "codex", model: "frozen-model", args: ["--search"], recoveryLimit: 2 };
const roots: string[] = [];
const stores: ReturnType<typeof openWorkerStore>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const remoteTask = (projectId: string, id: string): Task => ({ id, projectId, title: id, description: "fixture", status: "todo", allowAgents: true, requiredPlatform: null, startedAt: null, completedAt: null, version: 1n,
  properties: { worker: null, pullRequests: [] }, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true });
const fixture = async (maxConcurrent = 1, repoCount = 1) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-coordinator-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "r-")); roots.push(root);
  const store = openWorkerStore(path.join(root, "state.sqlite")); stores.push(store);
  const projects: WorkerProject[] = [];
  for (let index = 0; index < repoCount; index += 1) { const localPath = path.join(root, `repo${index}`); await mkdir(localPath); const project = { serverOrigin: origin, projectId: uuid(10 + index), repoUrl: `https://example.test/org/repo${index}.git`, localPath }; store.registerProject(project); projects.push(project); }
  const candidates = new Map(projects.map((project) => [project.projectId, [remoteTask(project.projectId, uuid(100 + projects.indexOf(project) * 10)), remoteTask(project.projectId, uuid(101 + projects.indexOf(project) * 10))]]));
  const granted = new Map<string, Task>();
  const worktrees = new Map<string, LocalTask["resources"]["worktree"]>();
  const resources = new Map<string, HerdrOwnedWorkspace>();
  const events: WorkerEvent[] = [];
  const order: string[] = [];
  let clock = 1000;
  let resourceSequence = 0;
  let completeCleanup = true;
  const key = (context: Pick<HerdrExecutionContext, "claimId">) => context.claimId;
  const observation = (context: HerdrExecutionContext, binding: HerdrTaskBinding): HerdrAgentObservation => {
    const pane = resources.get(key(context))!.panes.find((pane) => pane.binding.paneId === binding.paneId)!;
    return { binding, kind: pane.kind, name: pane.kind === null ? null : "fixture", status: pane.status, launchPending: pane.launchPending, interactiveReady: pane.interactiveReady, nativeSession: pane.nativeSession, stateChangeSeq: pane.stateChangeSeq, completionSeq: pane.completionSeq };
  };
  const git = {
    prepareRepository: vi.fn(), dispose: vi.fn(),
    prepareWorktree: vi.fn(async (task: LocalTask) => { order.push("worktree"); expect(store.getTask(task)?.status).toBe("active"); const binding = { repositoryPath: task.repositoryPath, commonDirectory: path.join(task.repositoryPath, ".git"), worktreePath: path.join(task.repositoryPath, ".worktrees", "daynight", task.taskId), branch: `daynight/${task.taskId}` }; worktrees.set(task.claimId, binding); return binding; }),
    verifyWorktree: vi.fn(async (task: LocalTask) => task.resources.worktree!),
    findWorktree: vi.fn(async (task: LocalTask) => worktrees.get(task.claimId) ?? null),
    removeWorktree: vi.fn(async (task: LocalTask) => { order.push("delete-worktree"); expect(store.getTask(task)?.cleanup).toMatchObject({ agentStopped: true, workspaceClosed: true }); worktrees.delete(task.claimId); }),
  } as unknown as WorkerGitManager;
  const tasks = {
    listResources: vi.fn(async () => structuredClone([...resources.values()])),
    prepareWorkspace: vi.fn(async (context: HerdrExecutionContext) => {
      order.push("workspace"); const existing = resources.get(key(context));
      if (existing !== undefined) return { binding: existing.panes[0]!.binding, workspaceEvidence: null };
      resourceSequence += 1;
      const binding = { session: "w", workspaceId: `ws${resourceSequence}`, paneId: `p${resourceSequence}`, terminalId: `t${resourceSequence}` };
      const workspaceEvidence: HerdrWorkspaceEvidence = { binding, ownerLabel: herdrExecutionLabel(context), environment: { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" } };
      resources.set(key(context), { owner: { serverOrigin: context.serverOrigin, projectId: context.projectId, taskId: context.taskId, claimId: context.claimId, worktreeId: context.worktreeId }, workspaceId: binding.workspaceId,
        panes: [{ binding, cwd: context.cwd, kind: null, status: "idle", launchPending: false, interactiveReady: false, nativeSession: null, stateChangeSeq: null, completionSeq: null }] });
      return { binding, workspaceEvidence };
    }),
    observe: vi.fn(async (context: HerdrExecutionContext, binding: HerdrTaskBinding) => observation(context, binding)),
    start: vi.fn(async (context: HerdrExecutionContext, binding: HerdrTaskBinding, input: { configuration: FrozenExecutionConfiguration; workspaceEvidence: HerdrWorkspaceEvidence; prompt: string; resumeSessionId?: string }) => {
      order.push("start"); const task = store.getTask(context)!; expect(task.nativeExecution).toMatchObject({ launchSubmission: "unknown", promptSubmission: "unknown" });
      const pane = resources.get(key(context))!.panes[0]!; pane.kind = context.agent; pane.interactiveReady = true; pane.stateChangeSeq = 1; pane.completionSeq = 0; pane.nativeSession = { source: `herdr:${context.agent}`, agent: context.agent, sessionId: input.resumeSessionId ?? uuid(1000 + resourceSequence) };
      return { kind: "started" as const, observation: observation(context, binding), promptSubmission: "submitted" as const, launchEvidence: { binding, ownerLabel: herdrExecutionLabel(context), agent: context.agent, argv: [context.agent, ...buildHerdrAgentArguments(input.configuration, input.resumeSessionId)], referenceBaseline: "empty" as const, workspaceEvidence: input.workspaceEvidence } };
    }),
    captureStop: vi.fn(async (context: HerdrExecutionContext, binding: HerdrTaskBinding) => ({ binding, ownerLabel: herdrExecutionLabel(context), agent: context.agent, nativeSessionId: observation(context, binding).nativeSession?.sessionId ?? null, shellPid: 100, processIds: [101], observedAt: clock })),
    submitPrompt: vi.fn(async (context: HerdrExecutionContext, binding: HerdrTaskBinding) => { order.push("cleanup-input"); expect(store.getTask(context)?.cleanup?.input).toBe("unknown"); const before = observation(context, binding); if (completeCleanup) { const pane = resources.get(key(context))!.panes[0]!; pane.stateChangeSeq! += 2; pane.completionSeq! += 1; } return { submission: "submitted" as const, observation: before }; }),
    confirmEmptyPane: vi.fn(async () => ({ noNativeProcess: true as const })),
    confirmStopped: vi.fn(async () => ({ agentStopped: true as const })),
    confirmMissingWorkspaceStopped: vi.fn(async () => ({ agentStopped: true as const })),
    confirmReplacedStop: vi.fn(async () => ({ agentStopped: true as const })),
    confirmRestoredStop: vi.fn(async (_context: HerdrExecutionContext, _original: HerdrTaskBinding, binding: HerdrTaskBinding) => ({ agentStopped: true as const, binding })),
    forceStop: vi.fn(async (context: HerdrExecutionContext) => { order.push("stop"); expect(store.getTask(context)?.nativeExecution?.stopObservation).not.toBeNull(); return { agentStopped: true as const, originalPaneClosed: true as const }; }),
    closeWorkspace: vi.fn(async (context: HerdrExecutionContext) => { order.push("close-workspace"); resources.delete(key(context)); return { workspaceClosed: true as const }; }),
  };
  const herdr = { tasks, ensureInstance: vi.fn(async () => { order.push("ensure-herdr"); }), stopInstance: vi.fn() } as unknown as WorkerHerdrAdapter;
  const remote = {
    serverOrigin: origin, resolveProject: vi.fn(),
    ownInventory: vi.fn(async () => { order.push("inventory"); return [...granted.values()]; }),
    candidates: vi.fn(async function* (projectId: string) { for (const candidate of candidates.get(projectId)!) if (![...granted.values()].some((task) => task.id === candidate.id)) yield candidate; }),
    claim: vi.fn(async (candidate: Task, descriptor: Omit<WorkerClaim, "state" | "userId" | "phase" | "herdr" | "nativeSessionId" | "claimedAt">) => { order.push(`claim:${candidate.projectId}`); expect(store.getClaimAttempt({ serverOrigin: origin, projectId: candidate.projectId })?.claimId).toBe(descriptor.claimId); expect(store.listTasks()).not.toContainEqual(expect.objectContaining({ claimId: descriptor.claimId })); const task: Task = { ...candidate, version: candidate.version + 1n, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { ...descriptor, userId: uuid(2), state: "active", phase: "preparing", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } } }; granted.set(descriptor.claimId, task); return task; }),
    update: vi.fn(async (task: Task, update: Partial<WorkerClaim>) => { const next = { ...task, version: task.version + 1n, properties: { ...task.properties, worker: { ...task.properties.worker!, ...update } } }; granted.set(task.properties.worker!.claimId, next); return next; }),
  } as unknown as WorkerRemote;
  const options = { store, git, herdr, remote, serverOrigin: origin, workerId, platform: "linux" as const, machine: { id: uuid(3), name: "fixture" }, repositories: projects.map((project) => ({ project, configuration })), maxConcurrent,
    buildPrompt: vi.fn((task: LocalTask) => `worker-managed using-daynight execute-task-in-managed ${task.claimId}`), emit: (event: WorkerEvent) => events.push(event), now: () => clock };
  return { root, store, projects, candidates, granted, resources, worktrees, git, herdr, tasks, remote, options, order, events, coordinator: createWorkerCoordinator(options), setTime: (value: number) => { clock = value; }, setCompleteCleanup: (value: boolean) => { completeCleanup = value; } };
};

describe("worker foreground coordinator", () => {
  it("commits claim/pending/active before resources, reconnects without replay, and cleans only after inventory exit", async () => {
    const f = await fixture();
    await f.coordinator.tick();
    const task = f.store.listTasks()[0]!;
    expect(task.status).toBe("active"); expect(task.configuration).toEqual(configuration); expect(f.store.getClaimAttempt(f.projects[0]!)).toBeNull();
    expect(f.order.slice(0, 5)).toEqual(["inventory", "ensure-herdr", `claim:${f.projects[0]!.projectId}`, "worktree", "workspace"]);
    expect(f.tasks.start).toHaveBeenCalledOnce(); expect(task.nativeExecution?.promptSubmission).toBe("submitted"); expect(task.nativeExecution?.stopObservation).not.toBeNull();
    await f.coordinator.tick(); expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.options.buildPrompt).toHaveBeenCalledOnce();
    f.granted.clear(); f.candidates.set(f.projects[0]!.projectId, []);
    await f.coordinator.tick();
    expect(f.store.getTask(task)?.status).toBe("done"); expect(f.order.slice(-4)).toEqual(["cleanup-input", "stop", "close-workspace", "delete-worktree"]);
    expect(f.herdr.stopInstance).not.toHaveBeenCalled();
  });

  it("fails closed on incomplete inventory before touching Herdr or any resource", async () => {
    const f = await fixture(); await f.coordinator.tick();
    const before = f.store.listTasks(); vi.mocked(f.remote.ownInventory).mockRejectedValueOnce(new Error("second inventory page failed"));
    await expect(f.coordinator.tick()).rejects.toThrow("second inventory page");
    expect(f.store.listTasks()).toEqual(before); expect(f.tasks.forceStop).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
    expect(f.herdr.ensureInstance).toHaveBeenCalledTimes(1);
  });

  it("rotates repositories and counts paused active executions when a lower limit is loaded", async () => {
    const f = await fixture(3, 2); await f.coordinator.tick();
    expect(f.order.filter((event) => event.startsWith("claim:"))).toEqual([`claim:${f.projects[0]!.projectId}`, `claim:${f.projects[1]!.projectId}`, `claim:${f.projects[0]!.projectId}`]);
    const task = f.store.listTasks()[0]!; f.store.pauseTask(task, "manual input", 1100);
    const lower = createWorkerCoordinator({ ...f.options, maxConcurrent: 1 }); await lower.tick();
    expect(f.tasks.start).toHaveBeenCalledTimes(3); expect(f.tasks.forceStop).not.toHaveBeenCalled(); expect(f.store.listUnfinishedTasks().filter((task) => task.status === "active")).toHaveLength(3);
  });

  it("durably fences an unknown claim across restart and recovers its original frozen configuration from inventory", async () => {
    const f = await fixture();
    const originalClaim = vi.mocked(f.remote.claim).getMockImplementation()!;
    vi.mocked(f.remote.claim).mockImplementationOnce(async (...args) => { await originalClaim(...args); throw new Error("claim response lost"); });
    await f.coordinator.tick(); expect(f.store.listTasks()).toEqual([]); const attempt = f.store.getClaimAttempt(f.projects[0]!)!; expect(attempt.configuration).toEqual(configuration);
    const restarted = createWorkerCoordinator({ ...f.options, repositories: f.options.repositories.map((repository) => ({ ...repository, configuration: { ...configuration, model: "new-default" } })) });
    await restarted.tick(); expect(f.remote.claim).toHaveBeenCalledTimes(1); expect(f.store.listTasks()[0]?.configuration?.model).toBe("frozen-model"); expect(f.store.getClaimAttempt(f.projects[0]!)).toBeNull();
  });

  it("does not clear an unresolved claim attempt when complete inventory is empty", async () => {
    const f = await fixture(); vi.mocked(f.remote.claim).mockRejectedValueOnce(new Error("in-flight unknown"));
    await f.coordinator.tick(); const original = f.store.getClaimAttempt(f.projects[0]!);
    await createWorkerCoordinator(f.options).tick(); expect(f.remote.claim).toHaveBeenCalledOnce(); expect(f.store.getClaimAttempt(f.projects[0]!)).toEqual(original); expect(f.tasks.start).not.toHaveBeenCalled();
  });

  it("retains unknown startup input on reconnect without sending another prompt", async () => {
    const f = await fixture(); const originalStart = f.tasks.start.getMockImplementation()!;
    f.tasks.start.mockImplementationOnce(async (...args) => { await originalStart(...args); throw new HerdrAgentActionError("prompt response lost", "agent.prompt", "unknown", { promptSubmission: "unknown" }); });
    await f.coordinator.tick(); const task = f.store.listTasks()[0]!; expect(task.nativeExecution?.promptSubmission).toBe("unknown"); expect(task.recovery.pauseReason).toContain("prompt response lost");
    await f.coordinator.tick(); expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.tasks.submitPrompt).not.toHaveBeenCalled();
  });

  it("preserves the original cleanup deadline and unknown input through restart", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!;
    f.candidates.set(f.projects[0]!.projectId, []); f.granted.clear();
    f.tasks.submitPrompt.mockRejectedValueOnce(new HerdrAgentActionError("cleanup response lost", "agent.prompt", "unknown", { promptSubmission: "unknown" }));
    await f.coordinator.tick(); const cleanup = f.store.getTask(task)!.cleanup!; expect(cleanup.input).toBe("unknown"); expect(cleanup.deadline).toBe(601000); expect(f.git.removeWorktree).not.toHaveBeenCalled();
    f.setTime(2000); await createWorkerCoordinator(f.options).tick(); expect(f.store.getTask(task)!.cleanup!.deadline).toBe(601000); expect(f.tasks.submitPrompt).toHaveBeenCalledOnce();
    f.setTime(601000); await createWorkerCoordinator(f.options).tick(); expect(f.store.getTask(task)?.status).toBe("done"); expect(f.store.getTask(task)?.cleanup?.result).toBe("timed-out");
  });

  it("preserves unfinished claims/worktrees/history on independent parallel shutdown", async () => {
    const f = await fixture(2, 2); await f.coordinator.tick(); const tasks = f.store.listTasks();
    expect(await f.coordinator.shutdown()).toBe(true);
    for (const task of tasks) expect(f.store.getTask(task)).toMatchObject({ status: "active", cleanup: { kind: "shutdown", agentStopped: true, workspaceClosed: true, worktreeDeleted: false }, resources: { nativeSession: task.resources.nativeSession, worktree: task.resources.worktree } });
    expect(f.git.removeWorktree).not.toHaveBeenCalled(); expect(f.granted.size).toBe(2); expect(f.herdr.stopInstance).not.toHaveBeenCalled();
  });

  it("does not mark terminal cleanup done or free capacity when original stop fails", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!; f.granted.clear(); f.tasks.forceStop.mockRejectedValueOnce(new Error("stop not confirmed"));
    await f.coordinator.tick(); expect(f.store.getTask(task)?.status).toBe("active"); expect(f.store.getTask(task)?.cleanup?.error).toContain("stop not confirmed"); expect(f.git.removeWorktree).not.toHaveBeenCalled(); expect(f.remote.claim).toHaveBeenCalledOnce();
    await f.coordinator.tick(); expect(f.store.getTask(task)?.status).toBe("done"); expect(f.tasks.submitPrompt).toHaveBeenCalledOnce();
  });

  it("serializes source control with ordinary actions for the same task across claims", async () => {
    const f = await fixture(); const identity = { serverOrigin: origin, projectId: f.projects[0]!.projectId, taskId: uuid(100), claimId: uuid(999) }; const sequence: string[] = [];
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = f.coordinator.serializeTask(identity, async () => { sequence.push("first-start"); await gate; sequence.push("first-end"); });
    const second = f.coordinator.serializeTask(identity, async () => { sequence.push("second"); });
    await Promise.resolve(); expect(sequence).toEqual(["first-start"]); release(); await Promise.all([first, second]); expect(sequence).toEqual(["first-start", "first-end", "second"]);
  });
  it("counts recovered executions with missing original configuration as active paused responsibility", async () => {
    const f = await fixture(1); const candidate = f.candidates.get(f.projects[0]!.projectId)![0]!;
    const task: Task = { ...candidate, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { claimId: uuid(800), workerId, worktreeId: uuid(801), userId: uuid(2), machine: f.options.machine, platform: "linux", agent: "codex", phase: "executing", herdr: { session: "w", workspaceId: "lost", paneId: "lost" }, nativeSessionId: uuid(802), state: "active", claimedAt: "2026-10-27T00:00:00Z" } } };
    f.granted.set(uuid(800), task); await f.coordinator.tick();
    expect(f.store.listTasks()[0]).toMatchObject({ status: "active", configuration: null, recovery: { pauseReason: expect.stringContaining("configuration") } });
    expect(f.remote.claim).not.toHaveBeenCalled(); expect(f.tasks.start).not.toHaveBeenCalled();
  });

  it("rejects a continuing claim whose original worktree or actual platform has changed", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!;
    const remote = f.granted.get(task.claimId)!; f.granted.set(task.claimId, { ...remote, properties: { ...remote.properties, worker: { ...remote.properties.worker!, platform: "windows" } } });
    await f.coordinator.tick(); expect(f.store.getTask(task)?.recovery.pauseReason).toContain("actual platform"); expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.tasks.submitPrompt).not.toHaveBeenCalled();
  });

  it("resumes original native history and frozen arguments after an observed inactive native process", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!; const pane = f.resources.get(task.claimId)!.panes[0]!;
    pane.kind = null; pane.interactiveReady = false;
    await f.coordinator.tick(); const current = f.store.getTask(task)!;
    expect(current.resources.nativeSession).toEqual(task.resources.nativeSession); expect(current.configuration).toEqual(configuration); expect(current.recovery.count).toBe(1);
    expect(f.tasks.start).toHaveBeenCalledTimes(2); expect(f.tasks.start.mock.calls[1]![2].resumeSessionId).toBe(task.resources.nativeSession!.sessionId);
    expect(f.tasks.confirmStopped).toHaveBeenCalledOnce(); expect(current.resources.herdr?.workspaceId).not.toBe(task.resources.herdr?.workspaceId);
  });

  it("recovers a disappeared original workspace only with immutable original process evidence", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!; f.resources.delete(task.claimId);
    await f.coordinator.tick(); expect(f.tasks.confirmMissingWorkspaceStopped).toHaveBeenCalledOnce(); expect(f.tasks.start).toHaveBeenCalledTimes(2); expect(f.store.getTask(task)?.resources.nativeSession).toEqual(task.resources.nativeSession);
  });

  it("confirms original process absence before replacing a terminal changed by cold restore", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!; const pane = f.resources.get(task.claimId)!.panes[0]!;
    pane.binding = { ...pane.binding, terminalId: "restored-terminal" }; pane.kind = null; pane.interactiveReady = false;
    await f.coordinator.tick(); expect(f.tasks.confirmRestoredStop).toHaveBeenCalledOnce(); expect(f.tasks.start).toHaveBeenCalledTimes(2); expect(f.store.getTask(task)?.resources.nativeSession).toEqual(task.resources.nativeSession);
  });

  it("observes a lost workspace-close acknowledgment before safely continuing recovery", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!; const pane = f.resources.get(task.claimId)!.panes[0]!; pane.kind = null; pane.interactiveReady = false;
    const close = f.tasks.closeWorkspace.getMockImplementation()!;
    f.tasks.closeWorkspace.mockImplementationOnce(async (...args) => { await close(...args); throw new HerdrAgentActionError("close acknowledgment lost", "workspace.close", "unknown"); });
    await f.coordinator.tick(); expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.store.getTask(task)?.recovery.pauseReason).toBeNull();
    await f.coordinator.tick(); expect(f.tasks.confirmMissingWorkspaceStopped).toHaveBeenCalledOnce(); expect(f.tasks.start).toHaveBeenCalledTimes(2);
  });

  it("observes a lost replacement-create receipt without launching in the unverified workspace", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!; const pane = f.resources.get(task.claimId)!.panes[0]!; pane.kind = null; pane.interactiveReady = false;
    const prepare = f.tasks.prepareWorkspace.getMockImplementation()!;
    f.tasks.prepareWorkspace.mockImplementationOnce(async (...args) => { await prepare(...args); throw new HerdrAgentActionError("replacement create receipt lost", "workspace.create", "unknown"); });
    await f.coordinator.tick(); expect(f.tasks.start).toHaveBeenCalledOnce();
    await f.coordinator.tick(); expect(f.tasks.confirmReplacedStop).toHaveBeenCalledOnce(); expect(f.tasks.start).toHaveBeenCalledTimes(2);
  });

  it("does not retry native launch automatically when its original history identity is missing", async () => {
    const f = await fixture(); f.tasks.start.mockRejectedValueOnce(new HerdrAgentActionError("native response lost", "agent.start", "unknown", { promptSubmission: "unknown" }));
    await f.coordinator.tick(); const task = f.store.listTasks()[0]!; expect(task.nativeExecution?.launchSubmission).toBe("unknown");
    await f.coordinator.tick(); expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.store.getTask(task)?.recovery.pauseReason).toContain("native response lost");
  });

  it("keeps never-submitted launch proof after definite local preflight failure and permits explicit retry", async () => {
    const f = await fixture(); f.tasks.start.mockRejectedValueOnce(new HerdrAgentActionError("official integration missing", "agent.start", "not-submitted", { promptSubmission: "not-submitted" }));
    await f.coordinator.tick(); const task = f.store.listTasks()[0]!; expect(task.nativeExecution?.launchSubmission).toBe("never-submitted");
    f.store.authorizeRecoveryRetry(task, 1100); await f.coordinator.tick(); expect(f.tasks.start).toHaveBeenCalledTimes(2); expect(f.store.getTask(task)?.nativeExecution?.promptSubmission).toBe("submitted");
  });

  it("clears a proven pre-dispatch claim attempt and permits a later fresh claim decision", async () => {
    const f = await fixture(); vi.mocked(f.remote.claim).mockRejectedValueOnce(new ApiError({ operation: "claim" }, "prepare", { cause: new Error("cancelled before fetch") }));
    await f.coordinator.tick(); expect(f.store.listTasks()).toHaveLength(1); expect(f.remote.claim).toHaveBeenCalledTimes(2); expect(f.store.getClaimAttempt(f.projects[0]!)).toBeNull();
  });

  it("fences an uncertain summary PATCH until the authoritative inventory proves its outcome", async () => {
    const f = await fixture(); vi.mocked(f.remote.update).mockRejectedValueOnce(new ApiError({ operation: "update" }, "request", { cause: new Error("summary reply lost"), outcomeUnconfirmed: true }));
    await f.coordinator.tick(); const task = f.store.listTasks()[0]!; expect(task.nativeExecution?.summary?.submission).toBe("unknown");
    await createWorkerCoordinator(f.options).tick(); expect(f.remote.update).toHaveBeenCalledOnce();
    const original = f.granted.get(task.claimId)!; const summary = task.nativeExecution!.summary!;
    f.granted.set(task.claimId, { ...original, version: original.version + 1n, properties: { ...original.properties, worker: { ...original.properties.worker!, herdr: summary.herdr, nativeSessionId: summary.nativeSessionId, phase: summary.phase } } });
    await createWorkerCoordinator(f.options).tick(); expect(f.remote.update).toHaveBeenCalledOnce(); expect(f.store.getTask(task)?.nativeExecution?.summary?.submission).toBe("confirmed");
  });

  it("reconsiders a summary after proven pre-dispatch failure without retaining an unknown fence", async () => {
    const f = await fixture(); vi.mocked(f.remote.update).mockRejectedValueOnce(new ApiError({ operation: "update" }, "prepare", { cause: new Error("not dispatched") }));
    await f.coordinator.tick(); const task = f.store.listTasks()[0]!; expect(task.nativeExecution?.summary).toBeNull();
    await createWorkerCoordinator(f.options).tick(); expect(f.remote.update).toHaveBeenCalledTimes(2); expect(f.store.getTask(task)?.nativeExecution?.summary?.submission).toBe("confirmed");
  });

  it("keeps local cleanup active after worktree deletion fails and retries only cleanup", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!; f.granted.clear(); f.candidates.set(f.projects[0]!.projectId, []);
    vi.mocked(f.git.removeWorktree).mockRejectedValueOnce(new Error("worktree permission denied"));
    await f.coordinator.tick(); expect(f.store.getTask(task)).toMatchObject({ status: "active", cleanup: { agentStopped: true, workspaceClosed: true, worktreeDeleted: false } });
    await createWorkerCoordinator(f.options).tick(); expect(f.store.getTask(task)?.status).toBe("done"); expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.tasks.submitPrompt).toHaveBeenCalledOnce();
  });

  it("stops early when original native process exit is proven without claiming temporary cleanup success", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!; f.granted.clear(); f.candidates.set(f.projects[0]!.projectId, []); f.setCompleteCleanup(false);
    const pane = f.resources.get(task.claimId)!.panes[0]!; pane.kind = null; pane.interactiveReady = false;
    await f.coordinator.tick(); expect(f.store.getTask(task)?.status).toBe("done"); expect(f.store.getTask(task)?.cleanup?.result).toBe("unavailable"); expect(f.tasks.confirmStopped).toHaveBeenCalledOnce(); expect(f.tasks.forceStop).not.toHaveBeenCalled();
  });

  it("refuses whole-instance shutdown when private resources have no unfinished local execution", async () => {
    const f = await fixture(); f.resources.set(uuid(900), { owner: { serverOrigin: origin, projectId: f.projects[0]!.projectId, taskId: uuid(901), claimId: uuid(900), worktreeId: uuid(902) }, workspaceId: "orphan", panes: [] });
    expect(await f.coordinator.shutdown()).toBe(false); expect(f.herdr.stopInstance).not.toHaveBeenCalled(); expect(f.events.at(-1)?.message).toContain("without an unfinished local execution");
  });

  it("persists unknown initial workspace creation and never repeats it from an absent snapshot", async () => {
    const f = await fixture(); f.tasks.prepareWorkspace.mockRejectedValueOnce(new HerdrAgentActionError("create response lost", "workspace.create", "unknown"));
    await f.coordinator.tick(); const task = f.store.listTasks()[0]!; expect(task.nativeExecution?.workspaceSubmission).toBe("unknown");
    await createWorkerCoordinator(f.options).tick(); await createWorkerCoordinator(f.options).tick(); expect(f.tasks.prepareWorkspace).toHaveBeenCalledOnce(); expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.store.getTask(task)?.recovery.count).toBe(0);
    f.granted.clear(); f.candidates.set(f.projects[0]!.projectId, []); await createWorkerCoordinator(f.options).tick();
    expect(f.store.getTask(task)).toMatchObject({ status: "active", cleanup: { agentStopped: false, workspaceClosed: false } }); expect(f.git.removeWorktree).not.toHaveBeenCalled();
  });

  it("adopts an eventually observed unknown workspace and verifies a new environment before native launch", async () => {
    const f = await fixture(); const prepare = f.tasks.prepareWorkspace.getMockImplementation()!;
    f.tasks.prepareWorkspace.mockRejectedValueOnce(new HerdrAgentActionError("create response delayed", "workspace.create", "unknown"));
    await f.coordinator.tick(); const task = f.store.listTasks()[0]!;
    await prepare({ serverOrigin: task.serverOrigin, projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, worktreeId: task.worktreeId, agent: "codex", cwd: task.resources.worktree!.worktreePath });
    await createWorkerCoordinator(f.options).tick(); expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.tasks.confirmEmptyPane).toHaveBeenCalledOnce(); expect(f.store.getTask(task)?.nativeExecution?.workspaceSubmission).toBe("acknowledged");
  });

  it("waits for a missing unknown replacement without consuming recovery budget on polling", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!; const pane = f.resources.get(task.claimId)!.panes[0]!; pane.kind = null; pane.interactiveReady = false;
    f.tasks.prepareWorkspace.mockRejectedValueOnce(new HerdrAgentActionError("replacement request unknown", "workspace.create", "unknown"));
    await f.coordinator.tick(); const count = f.store.getTask(task)!.recovery.count;
    await createWorkerCoordinator(f.options).tick(); await createWorkerCoordinator(f.options).tick();
    expect(f.store.getTask(task)?.recovery.count).toBe(count); expect(f.tasks.prepareWorkspace).toHaveBeenCalledTimes(2); expect(f.tasks.start).toHaveBeenCalledOnce();
  });

  it("freezes a new claim while its fixed task path is still attributed to the old claim", async () => {
    const f = await fixture(2); await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    // Keep the scenario at one task so the second global slot is available to the new claim.
    for (const other of f.store.listTasks().slice(1)) f.granted.delete(other.claimId);
    const oldRemote = f.granted.get(original.claimId)!;
    const newer: Task = { ...oldRemote, version: oldRemote.version + 1n, properties: { ...oldRemote.properties, worker: { ...oldRemote.properties.worker!, claimId: uuid(850), worktreeId: uuid(851), phase: "preparing", herdr: null, nativeSessionId: null } } };
    f.granted.delete(original.claimId); f.granted.set(uuid(850), newer); f.candidates.set(f.projects[0]!.projectId, []);
    await mkdir(original.resources.worktree!.worktreePath, { recursive: true });
    f.tasks.forceStop.mockRejectedValueOnce(new Error("old native still stopping"));
    await f.coordinator.tick();
    const incoming = f.store.getTask({ ...original, claimId: uuid(850) })!;
    expect(incoming).toMatchObject({ status: "pending", configuration }); expect(f.store.getTask(original)?.status).toBe("active");
    expect(f.tasks.start).toHaveBeenCalledTimes(2);
  });

  it("cleans an attributable native orphan from the complete own inventory without guessing frozen configuration", async () => {
    const f = await fixture(); f.candidates.set(f.projects[0]!.projectId, []);
    const owner = { serverOrigin: origin, projectId: f.projects[0]!.projectId, taskId: uuid(880), claimId: uuid(881), worktreeId: uuid(882) };
    const binding = { session: "w", workspaceId: "orphan-workspace", paneId: "orphan-pane", terminalId: "orphan-terminal" };
    const worktreePath = path.join(f.projects[0]!.localPath, ".worktrees", "daynight", owner.taskId);
    f.worktrees.set(owner.claimId, { repositoryPath: f.projects[0]!.localPath, commonDirectory: path.join(f.projects[0]!.localPath, ".git"), worktreePath, branch: `daynight/${owner.taskId}` });
    f.resources.set(owner.claimId, { owner, workspaceId: binding.workspaceId, panes: [{ binding, cwd: worktreePath, kind: "codex", status: "idle", launchPending: false, interactiveReady: true, nativeSession: { agent: "codex", source: "herdr:codex", sessionId: uuid(883) }, stateChangeSeq: 10, completionSeq: 2 }] });
    await f.coordinator.tick();
    expect(f.store.getTask(owner)).toMatchObject({ status: "done", configuration: null, cleanup: { kind: "terminal", agentStopped: true, workspaceClosed: true, worktreeDeleted: true }, resources: { nativeSession: { sessionId: uuid(883) } } });
    expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.tasks.captureStop).toHaveBeenCalledOnce(); expect(f.tasks.forceStop).toHaveBeenCalledOnce();
  });

  it("finishes an already terminal execution locally when shutdown completes its remaining cleanup", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!; f.store.beginCleanup(task, { kind: "terminal", deadline: 601000 }, 1000);
    expect(await f.coordinator.shutdown()).toBe(true); expect(f.store.getTask(task)?.status).toBe("done"); expect(f.git.removeWorktree).toHaveBeenCalledOnce();
  });

  it.each(["codex", "copilot"] as const)("preserves the exact %s resume invocation when deferred managed input becomes ready", async (agent) => {
    const f = await fixture();
    const frozen: FrozenExecutionConfiguration = { ...configuration, agent, args: agent === "codex" ? ["--search"] : ["--allow-all"] };
    const controller = createWorkerCoordinator({ ...f.options, repositories: f.options.repositories.map((repository) => ({ ...repository, configuration: frozen })) });
    await controller.tick(); const task = f.store.listTasks()[0]!; const originalId = task.resources.nativeSession!.sessionId;
    const pane = f.resources.get(task.claimId)!.panes[0]!; pane.kind = null; pane.interactiveReady = false;
    const nativeStart = f.tasks.start.getMockImplementation()!;
    vi.mocked(f.herdr.tasks.start).mockImplementationOnce(async (context, binding, input) => {
      const outcome = await nativeStart(context, binding, { ...input, configuration: frozen, workspaceEvidence: input.workspaceEvidence! });
      f.resources.get(task.claimId)!.panes[0]!.status = "blocked";
      return { ...outcome, kind: "waiting", promptSubmission: "not-submitted", observation: { ...outcome.observation, status: "blocked" } };
    });
    await controller.tick(); expect(f.store.getTask(task)?.nativeExecution?.promptSubmission).toBe("not-submitted");
    f.resources.get(task.claimId)!.panes[0]!.status = "idle";
    vi.mocked(f.herdr.tasks.start).mockImplementationOnce(async (context, binding, input) => {
      expect(input.initialPromptNotSubmitted).toBe(true); expect(input.resumeSessionId).toBe(originalId);
      expect(input.launchEvidence?.argv).toEqual([agent, ...buildHerdrAgentArguments(frozen, originalId)]);
      const current = f.resources.get(task.claimId)!.panes[0]!;
      return { kind: "started", observation: { ...current, binding, kind: agent, name: "fixture" }, promptSubmission: "submitted", launchEvidence: input.launchEvidence! };
    });
    await controller.tick(); expect(f.tasks.start).toHaveBeenCalledTimes(3); expect(f.store.getTask(task)?.nativeExecution?.promptSubmission).toBe("submitted"); expect(f.store.getTask(task)?.resources.nativeSession?.sessionId).toBe(originalId);
  });

  it.each(["terminal", "shutdown"] as const)("cleans an observed replacement after its create receipt was lost during %s", async (kind) => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!; const pane = f.resources.get(task.claimId)!.panes[0]!; pane.kind = null; pane.interactiveReady = false;
    const prepare = f.tasks.prepareWorkspace.getMockImplementation()!;
    f.tasks.prepareWorkspace.mockImplementationOnce(async (...args) => { await prepare(...args); throw new HerdrAgentActionError("replacement receipt lost", "workspace.create", "unknown"); });
    await f.coordinator.tick(); expect(f.store.getTask(task)?.nativeExecution?.workspaceSubmission).toBe("unknown"); expect(f.tasks.start).toHaveBeenCalledOnce();
    if (kind === "terminal") {
      f.granted.clear(); f.candidates.set(f.projects[0]!.projectId, []); await f.coordinator.tick();
      expect(f.store.getTask(task)?.status).toBe("done"); expect(f.git.removeWorktree).toHaveBeenCalledOnce();
    } else {
      expect(await f.coordinator.shutdown()).toBe(true); expect(f.store.getTask(task)).toMatchObject({ status: "active", cleanup: { kind: "shutdown", agentStopped: true, workspaceClosed: true, worktreeDeleted: false } }); expect(f.git.removeWorktree).not.toHaveBeenCalled();
    }
    expect(f.tasks.confirmReplacedStop).toHaveBeenCalledOnce(); expect(f.tasks.confirmRestoredStop).not.toHaveBeenCalled(); expect(f.tasks.start).toHaveBeenCalledOnce();
  });

  it("continues deletion after an observed replacement was closed but worktree deletion failed", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!; const pane = f.resources.get(task.claimId)!.panes[0]!; pane.kind = null; pane.interactiveReady = false;
    const prepare = f.tasks.prepareWorkspace.getMockImplementation()!; f.tasks.prepareWorkspace.mockImplementationOnce(async (...args) => { await prepare(...args); throw new HerdrAgentActionError("replacement receipt lost", "workspace.create", "unknown"); });
    await f.coordinator.tick(); f.granted.clear(); f.candidates.set(f.projects[0]!.projectId, []); vi.mocked(f.git.removeWorktree).mockRejectedValueOnce(new Error("delete failed"));
    await f.coordinator.tick(); expect(f.store.getTask(task)).toMatchObject({ status: "active", cleanup: { workspaceClosed: true, worktreeDeleted: false } });
    await createWorkerCoordinator(f.options).tick(); expect(f.store.getTask(task)?.status).toBe("done"); expect(f.tasks.confirmReplacedStop).toHaveBeenCalledOnce();
  });

  it.each(["terminal", "shutdown"] as const)("reconciles a physically closed replacement after both create and %s close acknowledgements were lost", async (kind) => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!; const pane = f.resources.get(task.claimId)!.panes[0]!;
    pane.kind = null; pane.interactiveReady = false;
    const prepare = f.tasks.prepareWorkspace.getMockImplementation()!;
    f.tasks.prepareWorkspace.mockImplementationOnce(async (...args) => { await prepare(...args); throw new HerdrAgentActionError("replacement create acknowledgement lost", "workspace.create", "unknown"); });
    await f.coordinator.tick(); expect(f.store.getTask(task)?.nativeExecution?.workspaceSubmission).toBe("unknown");
    const close = f.tasks.closeWorkspace.getMockImplementation()!;
    f.tasks.closeWorkspace.mockImplementationOnce(async (...args) => { await close(...args); throw new HerdrAgentActionError("replacement close acknowledgement lost", "workspace.close", "unknown"); });
    if (kind === "terminal") {
      f.granted.clear(); f.candidates.set(f.projects[0]!.projectId, []); await f.coordinator.tick();
    } else expect(await f.coordinator.shutdown()).toBe(false);
    const interrupted = f.store.getTask(task)!;
    expect(interrupted).toMatchObject({ status: "active", nativeExecution: { workspaceSubmission: "unknown" }, cleanup: { kind, agentStopped: true, workspaceClosed: false, worktreeDeleted: false, error: expect.stringContaining("close acknowledgement lost") } });
    expect(f.resources.has(task.claimId)).toBe(false); expect(f.tasks.confirmReplacedStop).toHaveBeenCalledOnce();
    const restarted = createWorkerCoordinator(f.options);
    if (kind === "terminal") {
      await restarted.tick(); expect(f.store.getTask(task)).toMatchObject({ status: "done", cleanup: { workspaceClosed: true, worktreeDeleted: true } }); expect(f.git.removeWorktree).toHaveBeenCalledOnce();
    } else {
      expect(await restarted.shutdown()).toBe(true); expect(f.store.getTask(task)).toMatchObject({ status: "active", cleanup: { kind: "shutdown", workspaceClosed: true, worktreeDeleted: false }, resources: { worktree: task.resources.worktree, nativeSession: task.resources.nativeSession } }); expect(f.git.removeWorktree).not.toHaveBeenCalled();
    }
    expect(f.store.getTask(task)?.cleanup?.deadline).toBe(interrupted.cleanup!.deadline); expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.tasks.prepareWorkspace).toHaveBeenCalledTimes(2); expect(f.tasks.confirmReplacedStop).toHaveBeenCalledOnce();
  });

  it.each([false, true])("only inspects the original worktree when native provenance is unknown (owned worktree present: %s)", async (present) => {
    const f = await fixture(); const project = f.projects[0]!; const candidate = f.candidates.get(project.projectId)![0]!;
    const identity = { serverOrigin: origin, projectId: project.projectId, taskId: candidate.id, claimId: uuid(910), workerId, worktreeId: uuid(911) };
    f.store.registerPending(identity, { kind: "recovered", configuration }, 1000); f.store.activateTask(identity, 1000);
    f.granted.set(identity.claimId, { ...candidate, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { claimId: identity.claimId, workerId, worktreeId: identity.worktreeId, userId: uuid(2), machine: f.options.machine, platform: "linux", agent: configuration.agent, phase: "executing", state: "active", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } } });
    const binding = { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: path.join(project.localPath, ".worktrees", "daynight", candidate.id), branch: `daynight/${candidate.id}` };
    if (present) f.worktrees.set(identity.claimId, binding);
    await f.coordinator.tick();
    expect(f.git.findWorktree).toHaveBeenCalledOnce(); expect(f.git.prepareWorktree).not.toHaveBeenCalled(); expect(f.tasks.prepareWorkspace).not.toHaveBeenCalled(); expect(f.tasks.start).not.toHaveBeenCalled();
    const actual = f.store.getTask(identity)!;
    expect(actual).toMatchObject({ status: "active", configuration, nativeExecution: null, recovery: { pauseReason: expect.stringMatching(/provenance/) } });
    expect(actual.resources.worktree).toEqual(present ? binding : null);
  });

});
