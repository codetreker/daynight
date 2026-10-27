import path from "node:path";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import * as filesystem from "../../../src/platform/filesystem.js";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerCoordinator } from "../../../src/commands/worker/coordinator.js";
import { submitWorkerControl } from "../../../src/commands/worker/control.js";
import { isWorkerCancellation } from "../../../src/commands/worker/execution.js";
import { createOperation, OperationError } from "../../../src/api/operation.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { HerdrAgentActionError } from "../../../src/commands/worker/herdr.js";
import { herdrExecutionLabel } from "../../../src/commands/worker/herdr/agents.js";
import { buildHerdrAgentArguments } from "../../../src/commands/worker/herdr/arguments.js";
import { ApiError } from "../../../src/api/client.js";
import type { Task, WorkerClaim } from "../../../src/api/types.js";
import type { HerdrAgentObservation, HerdrExecutionContext, HerdrLaunchEvidence, HerdrOwnedWorkspace, HerdrStopObservation, HerdrTaskBinding, HerdrWorkspaceEvidence, WorkerHerdrAdapter } from "../../../src/commands/worker/herdr.js";
import type { WorkerGitManager, WorkerEvent } from "../../../src/commands/worker/execution.js";
import type { WorkerRemote } from "../../../src/commands/worker/remote.js";
import type { LocalTask, ProjectIdentity, WorkerProject, FrozenExecutionConfiguration } from "../../../src/commands/worker/types.js";

const uuid = (value: number): string => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const origin = "https://daynight.example";
const workerId = uuid(1);
const configuration: FrozenExecutionConfiguration = { agent: "codex", model: "frozen-model", args: ["--search"], recoveryLimit: 2 };
const roots: string[] = [];
const stores: ReturnType<typeof openWorkerStore>[] = [];
afterEach(async () => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
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
    removeWorktree: vi.fn(async (task: LocalTask) => { order.push("delete-worktree"); expect(store.getTask(task)?.cleanup).toMatchObject({ agentStopped: true, workspaceClosed: true }); const owned = worktrees.get(task.claimId); if (owned !== undefined && owned !== null) await rm(owned.worktreePath, { recursive: true, force: true }); worktrees.delete(task.claimId); }),
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
    captureStop: vi.fn(async (context: HerdrExecutionContext, binding: HerdrTaskBinding): Promise<HerdrStopObservation> => ({ binding, ownerLabel: herdrExecutionLabel(context), agent: context.agent, nativeSessionId: observation(context, binding).nativeSession?.sessionId ?? null, shellPid: 100, processIds: [101], nativeProcessIds: [101], observedAt: clock })),
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
    serverOrigin: origin, currentUserId: vi.fn(async () => uuid(2)), resolveProject: vi.fn(),
    readTask: vi.fn(async (_projectId: string, taskId: string) => {
      const task = [...granted.values()].find((task) => task.id === taskId);
      if (task === undefined) throw new Error("Task not found in control fixture.");
      return task;
    }),
    authorizeControl: vi.fn(async () => {}),
    release: vi.fn(async (projectId: string, taskId: string, input: { claimId: string; version: bigint }) => {
      order.push("release");
      const source = store.listTasks().find((task) => task.claimId === input.claimId)!;
      expect(source.cleanup).toMatchObject({ agentStopped: true, workspaceClosed: true, worktreeDeleted: true });
      expect(source.control?.submission).toBe("unknown");
      const prior = granted.get(input.claimId)!;
      const next: Task = { ...prior, version: prior.version + 1n, status: "todo", ready: true, startedAt: null, completedAt: null, properties: { ...prior.properties, worker: { ...prior.properties.worker!, state: "released" } } };
      granted.delete(input.claimId);
      return next;
    }),
    ownInventory: vi.fn(async () => { order.push("inventory"); return [...granted.values()]; }),
    candidates: vi.fn(async function* (projectId: string) { for (const candidate of candidates.get(projectId)!) if (![...granted.values()].some((task) => task.id === candidate.id)) yield candidate; }),
    claim: vi.fn(async (candidate: Task, descriptor: Omit<WorkerClaim, "state" | "userId" | "phase" | "herdr" | "nativeSessionId" | "claimedAt">) => { order.push(`claim:${candidate.projectId}`); expect(store.getClaimAttempt({ serverOrigin: origin, projectId: candidate.projectId })?.claimId).toBe(descriptor.claimId); expect(store.listTasks()).not.toContainEqual(expect.objectContaining({ claimId: descriptor.claimId })); const task: Task = { ...candidate, version: candidate.version + 1n, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { ...descriptor, userId: uuid(2), state: "active", phase: "preparing", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } } }; granted.set(descriptor.claimId, task); return task; }),
    update: vi.fn(async (task: Task, update: Partial<WorkerClaim>) => { const next = { ...task, version: task.version + 1n, properties: { ...task.properties, worker: { ...task.properties.worker!, ...update } } }; granted.set(task.properties.worker!.claimId, next); return next; }),
  } as unknown as WorkerRemote;
  const options = { store, git, herdr, remote, serverOrigin: origin, workerId, platform: "linux" as const, machine: { id: uuid(3), name: "fixture" }, repositories: projects.map((project) => ({ project, configuration })), maxConcurrent,
    buildPrompt: vi.fn((task: LocalTask) => `worker-managed using-daynight execute-task-in-managed ${task.claimId}`), emit: (event: WorkerEvent) => events.push(event), now: () => clock };
  return { root, store, projects, candidates, granted, resources, worktrees, git, herdr, tasks, remote, options, order, events, coordinator: createWorkerCoordinator(options), setTime: (value: number) => { clock = value; }, setCompleteCleanup: (value: boolean) => { completeCleanup = value; } };
};

const gatedFirstInput = (f: Awaited<ReturnType<typeof fixture>>) => {
  let ready = false; let launches = 0; let inputs = 0; let evidence: HerdrLaunchEvidence | null = null;
  vi.mocked(f.herdr.tasks.start).mockImplementation(async (context, binding, input) => {
    const pane = f.resources.get(context.claimId)!.panes[0]!;
    if (input.initialPromptNotSubmitted !== true) {
      launches += 1; pane.kind = context.agent; pane.interactiveReady = true; pane.stateChangeSeq = 1; pane.completionSeq = 0; pane.nativeSession = null;
      evidence = { binding, ownerLabel: herdrExecutionLabel(context), agent: context.agent, argv: [context.agent, ...buildHerdrAgentArguments(input.configuration, input.resumeSessionId)], referenceBaseline: "empty", workspaceEvidence: input.workspaceEvidence! };
    } else {
      expect(input.launchEvidence).toEqual(evidence); expect(input.configuration).toEqual(f.store.getTask(context)!.configuration);
    }
    if (!ready) throw new HerdrAgentActionError("The native folder-trust screen requires intervention before input.", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted", launchEvidence: evidence! });
    inputs += 1; pane.nativeSession = { source: `herdr:${context.agent}`, agent: context.agent, sessionId: uuid(1200) };
    return { kind: "started", observation: { ...pane, binding, kind: context.agent, name: "fixture" }, promptSubmission: "submitted", launchEvidence: evidence };
  });
  return { acceptTrust: () => { ready = true; }, nativeLaunches: () => launches, managedInputs: () => inputs };
};
const retryOriginal = async (f: Awaited<ReturnType<typeof fixture>>, task: LocalTask) => submitWorkerControl({ store: f.store, remote: f.remote, serverOrigin: origin, workerId, platform: "linux", machine: f.options.machine, repositories: f.options.repositories, request: { kind: "retry", taskId: task.taskId, projectId: task.projectId, claimId: task.claimId }, signal: new AbortController().signal, now: f.options.now });

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
    await f.coordinator.tick(); expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.store.getTask(task)?.recovery.pauseReason).toContain("native session ID is missing");
    expect(f.events.some((event) => event.error instanceof Error && event.error.message === "native response lost")).toBe(true);
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

  it("preserves an orphan with unknown authenticated ownership instead of inferring its scope from an empty inventory", async () => {
    const f = await fixture(); f.candidates.set(f.projects[0]!.projectId, []);
    const owner = { serverOrigin: origin, projectId: f.projects[0]!.projectId, taskId: uuid(880), claimId: uuid(881), worktreeId: uuid(882) };
    const binding = { session: "w", workspaceId: "orphan-workspace", paneId: "orphan-pane", terminalId: "orphan-terminal" };
    const worktreePath = path.join(f.projects[0]!.localPath, ".worktrees", "daynight", owner.taskId);
    f.worktrees.set(owner.claimId, { repositoryPath: f.projects[0]!.localPath, commonDirectory: path.join(f.projects[0]!.localPath, ".git"), worktreePath, branch: `daynight/${owner.taskId}` });
    f.resources.set(owner.claimId, { owner, workspaceId: binding.workspaceId, panes: [{ binding, cwd: worktreePath, kind: "codex", status: "idle", launchPending: false, interactiveReady: true, nativeSession: { agent: "codex", source: "herdr:codex", sessionId: uuid(883) }, stateChangeSeq: 10, completionSeq: 2 }] });
    await f.coordinator.tick();
    expect(f.store.getTask(owner)).toMatchObject({ status: "active", userId: null, configuration: null, cleanup: null });
    expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.tasks.captureStop).not.toHaveBeenCalled(); expect(f.tasks.forceStop).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled(); expect(f.resources.has(owner.claimId)).toBe(true);
  });

  it("finishes an already terminal execution locally when shutdown completes its remaining cleanup", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!; f.store.beginCleanup(task, { kind: "terminal", deadline: 601000, claimEnded: true }, 1000);
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
    await retryOriginal(f, f.store.getTask(task)!); await controller.advanceRetry(task); expect(f.tasks.start).toHaveBeenCalledTimes(3); expect(f.store.getTask(task)?.nativeExecution?.promptSubmission).toBe("submitted"); expect(f.store.getTask(task)?.resources.nativeSession?.sessionId).toBe(originalId);
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
    const herdrBinding = { session: "w", workspaceId: "original-workspace", paneId: "original-pane", terminalId: "original-terminal" };
    f.resources.set(identity.claimId, { owner: { serverOrigin: origin, projectId: project.projectId, taskId: candidate.id, claimId: identity.claimId, worktreeId: identity.worktreeId }, workspaceId: herdrBinding.workspaceId, panes: [{ binding: herdrBinding, cwd: binding.worktreePath, kind: "codex", status: "idle", launchPending: false, interactiveReady: true, nativeSession: { agent: "codex", source: "herdr:codex", sessionId: uuid(912) }, stateChangeSeq: 1, completionSeq: 0 }] });
    await f.coordinator.tick();
    expect(f.git.findWorktree).toHaveBeenCalledOnce(); expect(f.git.prepareWorktree).not.toHaveBeenCalled(); expect(f.tasks.prepareWorkspace).not.toHaveBeenCalled(); expect(f.tasks.start).not.toHaveBeenCalled();
    const actual = f.store.getTask(identity)!;
    expect(actual).toMatchObject({ status: "active", configuration, recovery: { pauseReason: present ? null : expect.stringMatching(/provenance/) } });
    expect(actual.nativeExecution).toEqual(present ? expect.objectContaining({ launchSubmission: "unknown" }) : null);
    expect(actual.resources.worktree).toEqual(present ? binding : null);
    expect(actual.resources.nativeSession).toEqual(present ? { source: "herdr", sessionId: uuid(912) } : null);
  });

  it("resumes the original native conversation after interrupted shutdown closes its original workspace", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!;
    f.store.beginCleanup(task, { kind: "shutdown", deadline: 601000 }, 1000);
    await createWorkerCoordinator(f.options).tick();
    const resumed = f.store.getTask(task)!;
    expect(resumed).toMatchObject({ status: "active", cleanup: null, recovery: { pauseReason: null }, configuration, resources: { worktree: task.resources.worktree, nativeSession: task.resources.nativeSession } });
    expect(f.tasks.start).toHaveBeenCalledTimes(2); expect(f.tasks.start.mock.calls[1]![2].resumeSessionId).toBe(task.resources.nativeSession!.sessionId);
    expect(resumed.resources.herdr?.workspaceId).not.toBe(task.resources.herdr?.workspaceId); expect(f.events.some((event) => event.kind === "paused")).toBe(false);
  });

  it.each(["pending", "active"] as const)("retires a schema three %s transfer without replaying it or completing a still-owned claim", async (status) => {
    const f = await fixture();
    let source: LocalTask;
    if (status === "active") {
      await f.coordinator.tick(); source = f.store.listTasks()[0]!;
      f.store.beginCleanup(source, { kind: "terminal", deadline: 1500 }, 1000);
    } else {
      const candidate = f.candidates.get(f.projects[0]!.projectId)![0]!;
      const descriptor = { claimId: uuid(700), worktreeId: uuid(701), workerId, machine: f.options.machine, platform: "linux" as const, agent: "codex" as const };
      source = f.store.registerPending({ ...f.projects[0]!, taskId: candidate.id, ...descriptor }, { kind: "new", configuration }, 1000, uuid(2));
      f.granted.set(source.claimId, { ...candidate, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { ...descriptor, userId: uuid(2), state: "active", phase: "preparing", herdr: null, nativeSessionId: null, claimedAt: candidate.createdAt } } });
    }
    f.candidates.set(f.projects[0]!.projectId, []);
    const sql = new Database(path.join(f.root, "state.sqlite"));
    try {
      const control = { intent: { kind: "transfer", sourceClaimId: source.claimId, version: "8", targetClaimId: uuid(702), target: { userId: uuid(703), workerId: uuid(704), machine: f.options.machine, platform: "linux", agent: "codex", worktreeId: uuid(705) } }, requestedAt: 1000, submission: status === "active" ? "unknown" : "not-submitted", submittedAt: status === "active" ? 1100 : null, outcome: null, resultVersion: null, error: null };
      sql.prepare("UPDATE tasks SET control = ?, cleanup = json_remove(cleanup, '$.claimEnded') WHERE claim_id = ?").run(JSON.stringify(control), source.claimId);
      sql.pragma("user_version = 3");
    } finally { sql.close(); }
    const migrated = openWorkerStore(path.join(f.root, "state.sqlite")); migrated.close();
    f.setTime(1500);
    const restarted = createWorkerCoordinator(f.options);
    await restarted.advanceCommittedCleanups();
    expect(f.store.getTask(source)).toMatchObject({ status, control: null, cleanup: { claimEnded: false, deadline: status === "active" ? 1500 : 601000, agentStopped: true, workspaceClosed: true, worktreeDeleted: true } });
    vi.mocked(f.remote.ownInventory).mockRejectedValueOnce(new Error("service unavailable"));
    await expect(restarted.tick()).rejects.toThrow("service unavailable");
    await restarted.advanceCommittedCleanups(); await restarted.tick();
    expect(f.store.getTask(source)).toMatchObject({ status, cleanup: { claimEnded: false } });
    expect(f.tasks.start).toHaveBeenCalledTimes(status === "active" ? 1 : 0); expect(f.remote.release).not.toHaveBeenCalled();
    f.granted.clear(); await restarted.tick();
    expect(f.store.getTask(source)).toMatchObject({ status: "done", cleanup: { claimEnded: true } });
  });

  it.each(["before-cleanup", "after-cleanup"] as const)("rebinds a recovered pending source's owned resources after retiring transfer with withdrawal %s", async (withdrawal) => {
    const f = await fixture(); await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    await mkdir(original.resources.worktree!.worktreePath, { recursive: true });
    f.candidates.set(f.projects[0]!.projectId, []);
    const sql = new Database(path.join(f.root, "state.sqlite"));
    try {
      const control = { intent: { kind: "transfer", sourceClaimId: original.claimId, version: "8", targetClaimId: uuid(702), target: { userId: uuid(703), workerId: uuid(704), machine: f.options.machine, platform: "linux", agent: "codex", worktreeId: uuid(705) } }, requestedAt: 1000, submission: "not-submitted", submittedAt: null, outcome: null, resultVersion: null, error: null };
      sql.prepare("UPDATE tasks SET status = 'pending', configuration = NULL, resources = ?, native_execution = NULL, cleanup = NULL, control = ? WHERE claim_id = ?").run(JSON.stringify({ worktree: null, herdr: null, nativeSession: null }), JSON.stringify(control), original.claimId);
      sql.pragma("user_version = 3");
    } finally { sql.close(); }
    const migrated = openWorkerStore(path.join(f.root, "state.sqlite")); migrated.close();
    expect(f.store.getTask(original)).toMatchObject({ status: "pending", resources: { worktree: null, herdr: null, nativeSession: null }, nativeExecution: null, control: null, cleanup: { claimEnded: false, deadline: 601000 } });
    if (withdrawal === "before-cleanup") f.granted.clear();
    const restarted = createWorkerCoordinator(f.options);
    await restarted.tick();
    expect(f.store.getTask(original)).toMatchObject({ status: withdrawal === "before-cleanup" ? "done" : "active", resources: original.resources, cleanup: { error: null, claimEnded: withdrawal === "before-cleanup", deadline: 601000, agentStopped: true, workspaceClosed: true, worktreeDeleted: true } });
    expect(f.granted.has(original.claimId)).toBe(withdrawal === "after-cleanup"); expect(f.resources.has(original.claimId)).toBe(false); expect(existsSync(original.resources.worktree!.worktreePath)).toBe(false);
    expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.remote.release).not.toHaveBeenCalled();
    f.granted.clear(); await createWorkerCoordinator(f.options).tick();
    expect(f.store.getTask(original)).toMatchObject({ status: "done", cleanup: { claimEnded: true, deadline: 601000 } });
    expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.git.removeWorktree).toHaveBeenCalledOnce(); expect(f.remote.release).not.toHaveBeenCalled();
  });

  it("retains cleaned responsibility until original ownership ends and persists that proof for offline completion", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!;
    f.store.beginCleanup(task, { kind: "terminal", deadline: 601000 }, 1000);
    await f.coordinator.advanceCommittedCleanups();
    expect(f.store.getTask(task)).toMatchObject({ status: "active", control: null, cleanup: { claimEnded: false, agentStopped: true, workspaceClosed: true, worktreeDeleted: true } });
    expect(() => f.store.completeTask(task, 1100)).toThrow("claim must be confirmed ended");
    const restarted = createWorkerCoordinator(f.options);
    await restarted.tick();
    expect(f.store.getTask(task)).toMatchObject({ status: "active", cleanup: { claimEnded: false } });
    expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.remote.release).not.toHaveBeenCalled();
    f.granted.clear(); f.candidates.set(f.projects[0]!.projectId, []);
    await restarted.tick();
    expect(f.store.getTask(task)).toMatchObject({ status: "done", cleanup: { claimEnded: true } });
  });

  it("advances committed terminal cleanup at its deadline while a later own-inventory request is still in flight", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!;
    f.setCompleteCleanup(false); f.granted.clear(); f.candidates.set(f.projects[0]!.projectId, []); await f.coordinator.tick();
    const deadline = f.store.getTask(task)!.cleanup!.deadline;
    expect(f.store.getTask(task)).toMatchObject({ status: "active", cleanup: { kind: "terminal", input: "submitted", result: null } });
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<readonly Task[]>((resolve) => { release = () => resolve([]); });
    vi.mocked(f.remote.ownInventory).mockImplementationOnce(async () => { entered(); return blocked; });
    const pendingTick = f.coordinator.tick(); await started;
    try {
      f.setTime(deadline); await f.coordinator.advanceCommittedCleanups();
      expect(f.store.getTask(task)).toMatchObject({ status: "done", cleanup: { deadline, result: "timed-out", agentStopped: true, workspaceClosed: true, worktreeDeleted: true } });
      expect(f.tasks.forceStop).toHaveBeenCalledOnce(); expect(f.tasks.submitPrompt).toHaveBeenCalledOnce(); expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.remote.ownInventory).toHaveBeenCalledTimes(3);
    } finally { release(); await pendingTick; }
  });

  it("continues a persisted cleanup deadline after restart while remote inventory is unavailable", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!;
    f.setCompleteCleanup(false); f.granted.clear(); f.candidates.set(f.projects[0]!.projectId, []); await f.coordinator.tick(); const deadline = f.store.getTask(task)!.cleanup!.deadline;
    const restarted = createWorkerCoordinator(f.options); vi.mocked(f.remote.ownInventory).mockRejectedValueOnce(new Error("service unavailable"));
    await expect(restarted.tick()).rejects.toThrow("service unavailable"); f.setTime(deadline); await restarted.advanceCommittedCleanups();
    expect(f.store.getTask(task)).toMatchObject({ status: "done", cleanup: { deadline, result: "timed-out" } }); expect(f.tasks.submitPrompt).toHaveBeenCalledOnce(); expect(f.tasks.start).toHaveBeenCalledOnce();
  });

  it("does not infer new cleanup decisions from an unavailable remote inventory", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!; const before = f.store.getTask(task);
    vi.mocked(f.remote.ownInventory).mockRejectedValueOnce(new Error("inventory unavailable")); await expect(f.coordinator.tick()).rejects.toThrow("inventory unavailable");
    await f.coordinator.advanceCommittedCleanups();
    expect(f.store.getTask(task)).toEqual(before); expect(f.tasks.submitPrompt).not.toHaveBeenCalled(); expect(f.tasks.forceStop).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled(); expect(f.remote.ownInventory).toHaveBeenCalledTimes(2);
  });

  it("completes explicit source cleanup offline while retaining pending remote management responsibility", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!;
    f.store.recordControlIntent(task, { kind: "release", sourceClaimId: task.claimId, version: f.granted.get(task.claimId)!.version.toString() }, 1000);
    const inventoryCalls = vi.mocked(f.remote.ownInventory).mock.calls.length;
    vi.mocked(f.remote.readTask).mockRejectedValue(new Error("service unavailable"));
    await f.coordinator.advanceCommittedCleanups();
    expect(f.store.getTask(task)).toMatchObject({ status: "active", control: { submission: "not-submitted" }, cleanup: { kind: "terminal", agentStopped: true, workspaceClosed: true, worktreeDeleted: true } });
    expect(f.remote.ownInventory).toHaveBeenCalledTimes(inventoryCalls); expect(f.tasks.start).toHaveBeenCalledOnce();
    await f.coordinator.advanceCommittedCleanups(); expect(f.tasks.submitPrompt).toHaveBeenCalledOnce(); expect(f.git.removeWorktree).toHaveBeenCalledOnce();
  });

  it("advances one claim deadline while another claim's cleanup input is still awaiting its response", async () => {
    const f = await fixture(2); await f.coordinator.tick(); const [first, second] = f.store.listTasks() as [LocalTask, LocalTask];
    f.setCompleteCleanup(false);
    f.store.beginCleanup(first, { kind: "terminal", deadline: 1500, claimEnded: true }, 1000); f.store.beginCleanup(second, { kind: "terminal", deadline: 601000, claimEnded: true }, 1000);
    let rejectInput!: (error: Error) => void; let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const input = new Promise<Awaited<ReturnType<typeof f.tasks.submitPrompt>>>((_resolve, reject) => { rejectInput = reject; });
    f.tasks.submitPrompt.mockImplementationOnce(async () => { entered(); return input; });
    const heldSecond = f.coordinator.advanceCommittedCleanups(second); await started;
    let queuedFinished = false;
    const queuedSecond = f.coordinator.advanceCommittedCleanups(second).then(() => { queuedFinished = true; });
    try {
      f.setTime(1500); await f.coordinator.advanceCommittedCleanups(first);
      expect(f.store.getTask(first)).toMatchObject({ status: "done", cleanup: { deadline: 1500, result: "timed-out", agentStopped: true, workspaceClosed: true, worktreeDeleted: true } });
      expect(f.store.getTask(second)).toMatchObject({ status: "active", cleanup: { deadline: 601000, input: "unknown", result: null, agentStopped: false } });
      expect(f.tasks.forceStop).toHaveBeenCalledOnce(); expect(f.tasks.forceStop.mock.calls[0]![0].claimId).toBe(first.claimId); expect(f.tasks.submitPrompt).toHaveBeenCalledOnce(); expect(queuedFinished).toBe(false);
    } finally {
      rejectInput(new HerdrAgentActionError("cleanup input response lost", "agent.prompt", "unknown", { promptSubmission: "unknown" }));
      await Promise.all([heldSecond, queuedSecond]);
    }
    expect(queuedFinished).toBe(true); expect(f.store.getTask(second)).toMatchObject({ status: "active", cleanup: { deadline: 601000, input: "unknown", agentStopped: false } }); expect(f.tasks.submitPrompt).toHaveBeenCalledOnce();
    f.setTime(601000); await f.coordinator.advanceCommittedCleanups(second);
    expect(f.store.getTask(second)).toMatchObject({ status: "done", cleanup: { deadline: 601000, result: "timed-out" } }); expect(f.tasks.submitPrompt).toHaveBeenCalledOnce(); expect(f.tasks.start).toHaveBeenCalledTimes(2);
  });

  it("stops old and unrelated active agents while preserving an unstarted pending successor", async () => {
    const f = await fixture(2); await f.coordinator.tick(); const [old, unrelated] = f.store.listTasks() as [LocalTask, LocalTask];
    const successor = { serverOrigin: old.serverOrigin, projectId: old.projectId, taskId: old.taskId, claimId: uuid(950), workerId, worktreeId: uuid(951) };
    const pending = f.store.registerPending(successor, { kind: "new", configuration }, 1000);
    expect(await f.coordinator.shutdown()).toBe(true);
    expect(f.store.getTask(successor)).toEqual(pending);
    for (const task of [old, unrelated]) expect(f.store.getTask(task)).toMatchObject({ status: "active", cleanup: { kind: "shutdown", agentStopped: true, workspaceClosed: true, worktreeDeleted: false }, resources: { nativeSession: task.resources.nativeSession, worktree: task.resources.worktree } });
    expect(f.tasks.forceStop).toHaveBeenCalledTimes(2); expect(f.tasks.start).toHaveBeenCalledTimes(2); expect(f.git.removeWorktree).not.toHaveBeenCalled(); expect(f.resources.size).toBe(0);
  });

  it("isolates a cleanup initialization failure while still stopping unrelated active agents", async () => {
    const f = await fixture(2); await f.coordinator.tick(); const [failed, unrelated] = f.store.listTasks() as [LocalTask, LocalTask];
    const begin = f.store.beginCleanup;
    vi.spyOn(f.store, "beginCleanup").mockImplementation((identity, input, now) => {
      if (identity.claimId === failed.claimId) throw new Error("controlled cleanup initialization failure");
      return begin(identity, input, now);
    });
    expect(await f.coordinator.shutdown()).toBe(false);
    expect(f.store.getTask(failed)?.cleanup).toBeNull(); expect(f.resources.has(failed.claimId)).toBe(true);
    expect(f.store.getTask(unrelated)).toMatchObject({ cleanup: { kind: "shutdown", agentStopped: true, workspaceClosed: true } });
    expect(f.tasks.forceStop).toHaveBeenCalledOnce(); expect(f.tasks.forceStop.mock.calls[0]![0].claimId).toBe(unrelated.claimId); expect(f.git.removeWorktree).not.toHaveBeenCalled();
    expect(f.events.some((event) => event.task?.claimId === failed.claimId && event.error instanceof Error && event.error.message === "controlled cleanup initialization failure")).toBe(true);
  });

  it("stops known agents but retains the instance when unrelated private resources cannot be attributed", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!;
    const owner = { serverOrigin: origin, projectId: task.projectId, taskId: uuid(960), claimId: uuid(961), worktreeId: uuid(962) };
    const binding = { session: "w", workspaceId: "unattributed-workspace", paneId: "unattributed-pane", terminalId: "unattributed-terminal" };
    f.resources.set(owner.claimId, { owner, workspaceId: binding.workspaceId, panes: [{ binding, cwd: task.resources.worktree!.worktreePath, kind: "codex", status: "idle", launchPending: false, interactiveReady: true, nativeSession: { agent: "codex", source: "herdr:codex", sessionId: uuid(963) }, stateChangeSeq: 1, completionSeq: 0 }] });
    expect(await f.coordinator.shutdown()).toBe(false);
    expect(f.store.getTask(task)).toMatchObject({ cleanup: { kind: "shutdown", agentStopped: true, workspaceClosed: true } });
    expect(f.tasks.forceStop).toHaveBeenCalledOnce(); expect(f.tasks.forceStop.mock.calls[0]![0].claimId).toBe(task.claimId); expect(f.resources.has(owner.claimId)).toBe(true);
  });

  it("completes an absent unstarted pending claim without promoting it or touching the old active claim's path", async () => {
    const f = await fixture(); await f.coordinator.tick(); const old = f.store.listTasks()[0]!;
    const successor = { serverOrigin: old.serverOrigin, projectId: old.projectId, taskId: old.taskId, claimId: uuid(970), workerId, worktreeId: uuid(971) };
    f.store.registerPending(successor, { kind: "new", configuration }, 1000); f.store.bindUserScope(successor, uuid(2), 1000);
    f.setCompleteCleanup(false); f.granted.clear(); f.candidates.set(old.projectId, []);
    await f.coordinator.tick();
    expect(f.store.getTask(successor)).toMatchObject({ status: "done", resources: { worktree: null, herdr: null, nativeSession: null }, cleanup: { kind: "terminal", agentStopped: true, workspaceClosed: true, worktreeDeleted: true } });
    expect(f.store.getTask(old)).toMatchObject({ status: "active", cleanup: { kind: "terminal", agentStopped: false }, resources: { worktree: old.resources.worktree, nativeSession: old.resources.nativeSession } });
    expect(f.git.findWorktree).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled(); expect(f.tasks.forceStop).not.toHaveBeenCalled(); expect(f.tasks.start).toHaveBeenCalledOnce();
  });

  it("preserves user A's stopped claim under user B's empty inventory and resumes it with a fresh credential for A", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!;
    expect(task.userId).toBe(uuid(2)); expect(await f.coordinator.shutdown()).toBe(true);
    const foreignRemote = { ...f.remote, currentUserId: vi.fn(async () => uuid(990)), ownInventory: vi.fn(async () => []) };
    await createWorkerCoordinator({ ...f.options, remote: foreignRemote, repositories: [] }).tick();
    expect(f.store.getTask(task)).toMatchObject({ status: "active", userId: uuid(2), cleanup: { kind: "shutdown", worktreeDeleted: false }, resources: { nativeSession: task.resources.nativeSession, worktree: task.resources.worktree } });
    expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.git.removeWorktree).not.toHaveBeenCalled(); expect(f.granted.get(task.claimId)?.properties.worker?.state).toBe("active");
    const freshCredentialForA = { ...f.remote, currentUserId: vi.fn(async () => uuid(2)) };
    await createWorkerCoordinator({ ...f.options, remote: freshCredentialForA }).tick();
    expect(f.store.getTask(task)).toMatchObject({ userId: uuid(2), cleanup: null, configuration, recovery: { pauseReason: null }, resources: { nativeSession: task.resources.nativeSession, worktree: task.resources.worktree } });
    expect(f.tasks.start).toHaveBeenCalledTimes(2); expect(f.tasks.start.mock.calls[1]![2].resumeSessionId).toBe(task.resources.nativeSession!.sessionId);
  });

  it("does not infer an unbound pending claim's owner from its absence in the current user's inventory", async () => {
    const f = await fixture(); f.candidates.set(f.projects[0]!.projectId, []);
    const identity = { serverOrigin: origin, projectId: f.projects[0]!.projectId, taskId: uuid(991), claimId: uuid(992), workerId, worktreeId: uuid(993) };
    f.store.registerPending(identity, { kind: "new", configuration }, 1000);
    await f.coordinator.tick();
    expect(f.store.getTask(identity)).toMatchObject({ status: "pending", userId: null, cleanup: null, resources: { worktree: null, herdr: null, nativeSession: null } });
    expect(f.git.findWorktree).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled(); expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.events.some((event) => event.kind === "scope-paused")).toBe(true);
  });

  it("learns an unknown owner only from the exact current own claim before continuing its original resources", async () => {
    const f = await fixture(); const project = f.projects[0]!; const candidate = f.candidates.get(project.projectId)![0]!;
    const identity = { serverOrigin: origin, projectId: project.projectId, taskId: candidate.id, claimId: uuid(994), workerId, worktreeId: uuid(995) };
    f.store.registerPending(identity, { kind: "recovered", configuration }, 1000); f.store.activateTask(identity, 1000);
    const worktree = { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: path.join(project.localPath, ".worktrees", "daynight", candidate.id), branch: `daynight/${candidate.id}` };
    f.store.bindWorktree(identity, worktree, 1000); f.worktrees.set(identity.claimId, worktree);
    const binding = { session: "w", workspaceId: "scope-owned-workspace", paneId: "scope-owned-pane", terminalId: "scope-owned-terminal" };
    f.resources.set(identity.claimId, { owner: { serverOrigin: origin, projectId: project.projectId, taskId: candidate.id, claimId: identity.claimId, worktreeId: identity.worktreeId }, workspaceId: binding.workspaceId, panes: [{ binding, cwd: worktree.worktreePath, kind: "codex", status: "idle", launchPending: false, interactiveReady: true, nativeSession: { source: "herdr:codex", agent: "codex", sessionId: uuid(996) }, stateChangeSeq: 1, completionSeq: 0 }] });
    f.granted.set(identity.claimId, { ...candidate, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { claimId: identity.claimId, workerId, worktreeId: identity.worktreeId, userId: uuid(2), machine: f.options.machine, platform: "linux", agent: "codex", phase: "executing", state: "active", herdr: { session: binding.session, workspaceId: binding.workspaceId, paneId: binding.paneId }, nativeSessionId: uuid(996), claimedAt: "2026-10-27T00:00:00Z" } } });
    await f.coordinator.tick(); expect(f.store.getTask(identity)).toMatchObject({ userId: uuid(2), resources: { worktree, nativeSession: { sessionId: uuid(996) } } });
    expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.tasks.submitPrompt).not.toHaveBeenCalled(); expect(f.git.prepareWorktree).not.toHaveBeenCalled();
  });

  it("does not retroactively authorize an unscoped terminal cleanup from a matching claim", async () => {
    const f = await fixture(); const project = f.projects[0]!; const candidate = f.candidates.get(project.projectId)![0]!;
    const identity = { serverOrigin: origin, projectId: project.projectId, taskId: candidate.id, claimId: uuid(997), workerId, worktreeId: uuid(998) };
    f.store.registerPending(identity, { kind: "recovered", configuration }, 1000); f.store.activateTask(identity, 1000); f.store.beginCleanup(identity, { kind: "terminal", deadline: 601000, claimEnded: true }, 1000);
    f.granted.set(identity.claimId, { ...candidate, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { claimId: identity.claimId, workerId, worktreeId: identity.worktreeId, userId: uuid(2), machine: f.options.machine, platform: "linux", agent: "codex", phase: "executing", state: "active", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } } });
    await f.coordinator.tick(); await f.coordinator.advanceCommittedCleanups(identity); await f.coordinator.cleanupTask(identity, "shutdown");
    expect(f.store.getTask(identity)).toMatchObject({ status: "active", userId: null, cleanup: { kind: "terminal", agentStopped: false, worktreeDeleted: false } });
    expect(f.tasks.forceStop).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled(); expect(f.git.findWorktree).not.toHaveBeenCalled();
  });

  it("advances already scoped terminal cleanup even when current-user verification is unavailable", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!;
    f.setCompleteCleanup(false); f.granted.clear(); f.candidates.set(task.projectId, []); await f.coordinator.tick(); const deadline = f.store.getTask(task)!.cleanup!.deadline;
    vi.mocked(f.remote.currentUserId).mockRejectedValue(new Error("identity endpoint unavailable")); const priorLists = vi.mocked(f.remote.ownInventory).mock.calls.length;
    const restarted = createWorkerCoordinator(f.options); await expect(restarted.tick()).rejects.toThrow("identity endpoint unavailable"); expect(f.remote.ownInventory).toHaveBeenCalledTimes(priorLists);
    f.setTime(deadline); await restarted.advanceCommittedCleanups(task);
    expect(f.store.getTask(task)).toMatchObject({ status: "done", userId: uuid(2), cleanup: { result: "timed-out", worktreeDeleted: true } }); expect(f.tasks.submitPrompt).toHaveBeenCalledOnce();
  });

  it("never confirms user A's management result from user B's empty claim inventory", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!;
    f.store.recordControlIntent(task, { kind: "release", sourceClaimId: task.claimId, version: f.granted.get(task.claimId)!.version.toString() }, 1000);
    const foreignRemote = { ...f.remote, currentUserId: vi.fn(async () => uuid(999)), ownInventory: vi.fn(async () => []), authorizeControl: vi.fn(async () => { throw new Error("Current user is not the original owner or an administrator."); }) };
    await createWorkerCoordinator({ ...f.options, remote: foreignRemote, repositories: [] }).tick();
    expect(f.store.getTask(task)).toMatchObject({ status: "active", userId: uuid(2), control: { submission: "not-submitted", outcome: null }, cleanup: { kind: "terminal", agentStopped: true, workspaceClosed: true, worktreeDeleted: true } });
    expect(f.granted.get(task.claimId)?.properties.worker?.state).toBe("active"); expect(f.remote.claim).toHaveBeenCalledOnce();
  });

  it("does not learn an unknown owner from a claim with a different original worktree identity", async () => {
    const f = await fixture(); const project = f.projects[0]!; const candidate = f.candidates.get(project.projectId)![0]!;
    const identity = { serverOrigin: origin, projectId: project.projectId, taskId: candidate.id, claimId: uuid(1010), workerId, worktreeId: uuid(1011) };
    f.store.registerPending(identity, { kind: "recovered", configuration }, 1000); f.store.activateTask(identity, 1000);
    f.granted.set(identity.claimId, { ...candidate, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { claimId: identity.claimId, workerId, worktreeId: uuid(1012), userId: uuid(2), machine: f.options.machine, platform: "linux", agent: "codex", phase: "executing", state: "active", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } } });
    await f.coordinator.tick(); expect(f.store.getTask(identity)).toMatchObject({ userId: null, worktreeId: identity.worktreeId, cleanup: null });
    expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.git.prepareWorktree).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
  });

  it("does not make new origin-A decisions from origin B's empty inventory but stops A on local shutdown", async () => {
    const f = await fixture(); await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    const otherOrigin = "https://other-daynight.example";
    const otherRemote = { ...f.remote, serverOrigin: otherOrigin, currentUserId: vi.fn(async () => uuid(2)), ownInventory: vi.fn(async () => []) };
    const changedOrigin = createWorkerCoordinator({ ...f.options, serverOrigin: otherOrigin, remote: otherRemote, repositories: [] });
    await changedOrigin.tick();
    expect(otherRemote.ownInventory).toHaveBeenCalledWith([], workerId, expect.any(AbortSignal)); expect(f.remote.ownInventory).toHaveBeenCalledOnce();
    expect(f.store.getTask(original)).toEqual(original); expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.tasks.forceStop).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
    expect(await changedOrigin.shutdown()).toBe(true);
    expect(f.store.getTask(original)).toMatchObject({ serverOrigin: origin, claimId: original.claimId, worktreeId: original.worktreeId, status: "active", userId: uuid(2), cleanup: { kind: "shutdown", deadline: 601000, agentStopped: true, workspaceClosed: true, worktreeDeleted: false }, resources: { worktree: original.resources.worktree, nativeSession: original.resources.nativeSession } });
    expect(f.tasks.forceStop).toHaveBeenCalledOnce(); expect(f.tasks.forceStop.mock.calls[0]![0].serverOrigin).toBe(origin); expect(f.git.removeWorktree).not.toHaveBeenCalled(); expect(f.tasks.start).toHaveBeenCalledOnce();
    expect(f.remote.ownInventory).toHaveBeenCalledOnce(); expect(otherRemote.ownInventory).toHaveBeenCalledOnce(); expect(f.granted.get(original.claimId)?.properties.worker?.state).toBe("active");
  });

  it("continues an already committed origin-A deadline locally after configuration switches to origin B", async () => {
    const f = await fixture(); await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    f.setCompleteCleanup(false); f.granted.clear(); f.candidates.set(original.projectId, []); await f.coordinator.tick(); const deadline = f.store.getTask(original)!.cleanup!.deadline;
    const otherOrigin = "https://other-daynight.example";
    const otherRemote = { ...f.remote, serverOrigin: otherOrigin, currentUserId: vi.fn(async () => { throw new Error("origin B identity offline"); }), ownInventory: vi.fn(async () => { throw new Error("origin B inventory offline"); }) };
    const changedOrigin = createWorkerCoordinator({ ...f.options, serverOrigin: otherOrigin, remote: otherRemote, repositories: [] });
    f.setTime(deadline); await changedOrigin.advanceCommittedCleanups(original);
    expect(f.store.getTask(original)).toMatchObject({ status: "done", serverOrigin: origin, claimId: original.claimId, worktreeId: original.worktreeId, userId: uuid(2), cleanup: { kind: "terminal", deadline, result: "timed-out", agentStopped: true, workspaceClosed: true, worktreeDeleted: true } });
    expect(otherRemote.currentUserId).not.toHaveBeenCalled(); expect(otherRemote.ownInventory).not.toHaveBeenCalled(); expect(f.remote.ownInventory).toHaveBeenCalledTimes(2); expect(f.tasks.submitPrompt).toHaveBeenCalledOnce(); expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.tasks.forceStop.mock.calls[0]![0].serverOrigin).toBe(origin);
  });

  it("keeps unknown-user terminal responsibility blocked across an origin change", async () => {
    const f = await fixture(); const original = { serverOrigin: origin, projectId: f.projects[0]!.projectId, taskId: uuid(1020), claimId: uuid(1021), workerId, worktreeId: uuid(1022) };
    f.store.registerPending(original, { kind: "recovered", configuration }, 1000); f.store.activateTask(original, 1000); f.store.beginCleanup(original, { kind: "terminal", deadline: 1500, claimEnded: true }, 1000);
    const otherOrigin = "https://other-daynight.example"; const otherRemote = { ...f.remote, serverOrigin: otherOrigin, currentUserId: vi.fn(async () => uuid(2)), ownInventory: vi.fn(async () => []) };
    const changedOrigin = createWorkerCoordinator({ ...f.options, serverOrigin: otherOrigin, remote: otherRemote, repositories: [] });
    f.setTime(1500); await changedOrigin.advanceCommittedCleanups(original);
    expect(f.events.some((event) => event.kind === "scope-paused" && event.task?.claimId === original.claimId)).toBe(true);
    expect(await changedOrigin.shutdown()).toBe(false);
    expect(f.store.getTask(original)).toMatchObject({ status: "active", serverOrigin: origin, userId: null, cleanup: { kind: "terminal", deadline: 1500, agentStopped: false, worktreeDeleted: false } });
    expect(f.tasks.forceStop).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled(); expect(otherRemote.currentUserId).not.toHaveBeenCalled(); expect(otherRemote.ownInventory).not.toHaveBeenCalled();
  });

  it.each(["discovered", "claimed"] as const)("freezes a fresh origin-B %s claim and waits for the same task's origin-A predecessor", async (entry) => {
    const f = await fixture(); await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    f.setCompleteCleanup(false); f.granted.clear(); f.candidates.set(original.projectId, []); await f.coordinator.tick();
    await mkdir(original.resources.worktree!.worktreePath, { recursive: true });
    const otherOrigin = "https://other-daynight.example";
    const project = { ...f.projects[0]!, serverOrigin: otherOrigin, projectId: uuid(1030) }; f.store.registerProject(project);
    const frozen = { ...configuration, model: "model-for-origin-B" };
    const candidate = remoteTask(project.projectId, original.taskId);
    const grant = (claimId: string, worktreeId: string): Task => ({ ...candidate, status: "in_progress", ready: false, version: 2n, properties: { ...candidate.properties, worker: { claimId, worktreeId, workerId, userId: uuid(2), machine: f.options.machine, platform: "linux", agent: "codex", phase: "preparing", state: "active", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } } });
    let actual = entry === "discovered" ? grant(uuid(1031), uuid(1032)) : undefined;
    const otherRemote: WorkerRemote = { ...f.remote, serverOrigin: otherOrigin, currentUserId: vi.fn(async () => uuid(2)), ownInventory: vi.fn(async (projects: readonly ProjectIdentity[]) => { expect(projects.every((item) => item.serverOrigin === otherOrigin)).toBe(true); return actual === undefined ? [] : [actual]; }),
      candidates: vi.fn(async function* () { if (actual === undefined) yield candidate; }),
      claim: vi.fn(async (_candidate, descriptor) => { actual = grant(descriptor.claimId, descriptor.worktreeId); return actual; }) };
    const changedOrigin = createWorkerCoordinator({ ...f.options, serverOrigin: otherOrigin, remote: otherRemote, repositories: [{ project, configuration: frozen }], maxConcurrent: 2 });
    const beforeALists = vi.mocked(f.remote.ownInventory).mock.calls.length;
    await changedOrigin.tick(); const incomingIdentity = { serverOrigin: otherOrigin, projectId: project.projectId, taskId: original.taskId, claimId: actual!.properties.worker!.claimId };
    if (entry === "claimed") expect(f.store.getTask(incomingIdentity)).toMatchObject({ status: "pending", configuration: frozen, resources: { worktree: null, herdr: null, nativeSession: null } });
    else { expect(f.store.getTask(incomingIdentity)).toBeNull(); expect(f.git.findWorktree).not.toHaveBeenCalled(); }
    expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.git.prepareWorktree).toHaveBeenCalledOnce(); expect(f.store.getTask(original)).toMatchObject({ status: "active", cleanup: { kind: "terminal", agentStopped: false } });
    f.setCompleteCleanup(true); f.setTime(f.store.getTask(original)!.cleanup!.deadline); await changedOrigin.advanceCommittedCleanups(original);
    expect(f.store.getTask(original)?.status).toBe("done");
    await changedOrigin.tick(); const started = f.store.getTask(incomingIdentity)!;
    expect(started).toMatchObject({ status: "active", configuration: frozen, nativeExecution: { promptSubmission: "submitted" } });
    expect(started.resources.nativeSession?.sessionId).not.toBe(original.resources.nativeSession!.sessionId); expect(f.tasks.start).toHaveBeenCalledTimes(2);
    expect(f.tasks.start.mock.calls[1]![0]).toMatchObject({ serverOrigin: otherOrigin, projectId: project.projectId, taskId: original.taskId, claimId: incomingIdentity.claimId, worktreeId: started.worktreeId }); expect(f.tasks.start.mock.calls[1]![2].resumeSessionId).toBeUndefined();
    expect(f.remote.ownInventory).toHaveBeenCalledTimes(beforeALists);
  });

  it("attributes the local predecessor by full scope when independent origins use the same claim UUID", async () => {
    const f = await fixture(); await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    f.setCompleteCleanup(false); f.granted.clear(); f.candidates.set(original.projectId, []); await f.coordinator.tick();
    await mkdir(original.resources.worktree!.worktreePath, { recursive: true });
    const otherOrigin = "https://other-daynight.example"; const project = { ...f.projects[0]!, serverOrigin: otherOrigin, projectId: uuid(1040) }; f.store.registerProject(project);
    const candidate = remoteTask(project.projectId, original.taskId);
    const actual: Task = { ...candidate, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { claimId: original.claimId, worktreeId: uuid(1041), workerId, userId: uuid(2), machine: f.options.machine, platform: "linux", agent: "codex", phase: "preparing", state: "active", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } } };
    const frozen = { ...configuration, model: "independent-origin-model" };
    const otherRemote = { ...f.remote, serverOrigin: otherOrigin, currentUserId: vi.fn(async () => uuid(2)), ownInventory: vi.fn(async () => [actual]), candidates: vi.fn(async function* () {}) };
    const changedOrigin = createWorkerCoordinator({ ...f.options, serverOrigin: otherOrigin, remote: otherRemote, repositories: [{ project, configuration: frozen }], maxConcurrent: 2 });
    await changedOrigin.tick(); const incomingIdentity = { ...original, serverOrigin: otherOrigin, projectId: project.projectId };
    expect(f.store.getTask(incomingIdentity)).toBeNull(); expect(f.git.findWorktree).not.toHaveBeenCalled();
    expect(f.events.some((event) => event.kind === "handoff-waiting" && event.task?.serverOrigin === origin && event.task.projectId === original.projectId && event.task.claimId === original.claimId)).toBe(true);
    expect(f.store.getTask(original)).toMatchObject({ status: "active", serverOrigin: origin, resources: original.resources }); expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.git.prepareWorktree).toHaveBeenCalledOnce();
    f.setTime(f.store.getTask(original)!.cleanup!.deadline); await changedOrigin.advanceCommittedCleanups(original); await changedOrigin.tick();
    expect(f.store.getTask(incomingIdentity)).toMatchObject({ status: "active", claimId: original.claimId, worktreeId: uuid(1041), configuration: frozen }); expect(f.tasks.start).toHaveBeenCalledTimes(2); expect(f.tasks.start.mock.calls[1]![2].resumeSessionId).toBeUndefined();
  });

  it.each(["ancestor-alias", "pointerless-leaf", "missing-leaf"] as const)("defers new claim classification while its predecessor removal is unsettled (%s)", async (condition) => {
    const f = await fixture(); await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    f.setCompleteCleanup(false); f.granted.clear(); f.candidates.set(original.projectId, []); await f.coordinator.tick();
    await mkdir(original.resources.worktree!.worktreePath, { recursive: true });
    let localPath = f.projects[0]!.localPath;
    if (condition === "ancestor-alias") {
      const alias = path.join(f.root, "alias-parent"); await symlink(f.root, alias, process.platform === "win32" ? "junction" : "dir"); localPath = path.join(alias, path.basename(localPath));
    } else {
      f.store.recordCleanupResult(original, "completed", null, 1000); f.store.confirmAgentStopped(original, { agentStopped: true }, 1000); f.store.confirmWorkspaceClosed(original, { workspaceClosed: true }, 1000); f.resources.delete(original.claimId);
      if (condition === "missing-leaf") await rm(original.resources.worktree!.worktreePath, { recursive: true });
      else { await writeFile(path.join(original.resources.worktree!.worktreePath, ".git"), "gitdir: fixture-admin\n"); await rm(path.join(original.resources.worktree!.worktreePath, ".git")); }
    }
    const otherOrigin = "https://other-daynight.example"; const project = { ...f.projects[0]!, serverOrigin: otherOrigin, projectId: uuid(1050), localPath }; f.store.registerProject(project);
    const candidate = remoteTask(project.projectId, original.taskId);
    const actual: Task = { ...candidate, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { claimId: uuid(1051), worktreeId: uuid(1052), workerId, userId: uuid(2), machine: f.options.machine, platform: "linux", agent: "codex", phase: "preparing", state: "active", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } } };
    const frozen = { ...configuration, model: "fresh-origin-B-config" };
    const otherRemote = { ...f.remote, serverOrigin: otherOrigin, currentUserId: vi.fn(async () => uuid(2)), ownInventory: vi.fn(async () => [actual]), candidates: vi.fn(async function* () {}) };
    const changedOrigin = createWorkerCoordinator({ ...f.options, serverOrigin: otherOrigin, remote: otherRemote, repositories: [{ project, configuration: frozen }], maxConcurrent: 2 });
    const incomingIdentity = { serverOrigin: otherOrigin, projectId: project.projectId, taskId: original.taskId, claimId: uuid(1051) };
    await changedOrigin.tick(); expect(f.store.getTask(incomingIdentity)).toBeNull(); expect(f.git.findWorktree).not.toHaveBeenCalled(); expect(f.tasks.start).toHaveBeenCalledOnce();
    f.store.recordCleanupResult(original, "completed", null, 1000); f.store.confirmAgentStopped(original, { agentStopped: true }, 1000); f.store.confirmWorkspaceClosed(original, { workspaceClosed: true }, 1000); f.resources.delete(original.claimId);
    await rm(original.resources.worktree!.worktreePath, { recursive: true, force: true }); f.worktrees.delete(original.claimId); f.store.confirmWorktreeDeleted(original, { worktreeDeleted: true }, 1000); f.store.completeTask(original, 1000);
    await changedOrigin.tick(); expect(f.store.getTask(incomingIdentity)).toMatchObject({ status: "active", configuration: frozen }); expect(f.tasks.start).toHaveBeenCalledTimes(2); expect(f.tasks.start.mock.calls[1]![2].resumeSessionId).toBeUndefined();
  });

  it("does not persist a fault pause when normal shutdown cancels read-only original-worktree verification", async () => {
    const f = await fixture(); await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    const cancellation = new AbortController(); const reason = new Error("normal worker shutdown");
    vi.mocked(f.git.verifyWorktree).mockImplementationOnce(async (task, operation) => { cancellation.abort(reason); operation.check(); return task.resources.worktree!; });
    const interrupted = createWorkerCoordinator({ ...f.options, signal: cancellation.signal });
    await expect(interrupted.tick()).rejects.toBeInstanceOf(OperationError);
    expect(f.store.getTask(original)).toMatchObject({ recovery: { count: 0, pauseReason: null }, configuration, resources: { nativeSession: original.resources.nativeSession, worktree: original.resources.worktree } });
    expect(await interrupted.shutdown()).toBe(true);
    expect(f.store.getTask(original)?.recovery.pauseReason).toBeNull();
    await createWorkerCoordinator(f.options).tick();
    expect(f.store.getTask(original)).toMatchObject({ cleanup: null, recovery: { count: 0, pauseReason: null }, configuration, resources: { nativeSession: original.resources.nativeSession, worktree: original.resources.worktree } });
    expect(f.tasks.start).toHaveBeenCalledTimes(2); expect(f.tasks.start.mock.calls[1]![2].resumeSessionId).toBe(original.resources.nativeSession!.sessionId); expect(f.events.some((event) => event.kind === "paused")).toBe(false);
  });

  it("preserves a real existing pause when read-only verification is cancelled for normal shutdown", async () => {
    const f = await fixture(); await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    f.store.pauseTask(original, "Provider permission requires intervention.", 1000);
    const cancellation = new AbortController(); const reason = new Error("normal worker shutdown");
    vi.mocked(f.git.verifyWorktree).mockImplementationOnce(async (task, operation) => { cancellation.abort(reason); operation.check(); return task.resources.worktree!; });
    const interrupted = createWorkerCoordinator({ ...f.options, signal: cancellation.signal });
    await expect(interrupted.tick()).rejects.toBeInstanceOf(OperationError); expect(await interrupted.shutdown()).toBe(true);
    await createWorkerCoordinator(f.options).tick();
    expect(f.store.getTask(original)).toMatchObject({ recovery: { count: 0, pauseReason: "Provider permission requires intervention." }, resources: { nativeSession: original.resources.nativeSession, worktree: original.resources.worktree } });
    expect(f.tasks.start).toHaveBeenCalledOnce();
  });

  it("preserves journaled unknown native submission through cancellation and shutdown without replaying it", async () => {
    const f = await fixture(); const cancellation = new AbortController(); const reason = new Error("normal worker shutdown");
    f.tasks.start.mockImplementationOnce(async (context) => {
      const pane = f.resources.get(context.claimId)!.panes[0]!; pane.kind = "codex"; pane.interactiveReady = true; pane.stateChangeSeq = 1; pane.completionSeq = 0;
      cancellation.abort(reason);
      throw new HerdrAgentActionError("Native submission outcome is unknown.", "agent.start", "unknown", { cause: new OperationError("cancelled", { cause: reason }), promptSubmission: "unknown" });
    });
    const interrupted = createWorkerCoordinator({ ...f.options, signal: cancellation.signal });
    await expect(interrupted.tick()).rejects.toBeInstanceOf(HerdrAgentActionError);
    const original = f.store.listTasks()[0]!;
    expect(original).toMatchObject({ recovery: { count: 0, pauseReason: null }, nativeExecution: { launchSubmission: "unknown", promptSubmission: "unknown" } });
    f.tasks.submitPrompt.mockRejectedValueOnce(new HerdrAgentActionError("The original session is not ready for cleanup input.", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" }));
    expect(await interrupted.shutdown()).toBe(true);
    await createWorkerCoordinator(f.options).tick();
    expect(f.store.getTask(original)).toMatchObject({ status: "active", nativeExecution: { launchSubmission: "unknown", promptSubmission: "unknown" }, resources: { nativeSession: null }, recovery: { pauseReason: expect.stringContaining("native session ID is missing") } });
    expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.tasks.prepareWorkspace).toHaveBeenCalledOnce(); expect(f.git.prepareWorktree).toHaveBeenCalledOnce();
  });

  it("records an unrelated execution failure even when normal cancellation happens at the same time", async () => {
    const f = await fixture(); await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    const cancellation = new AbortController(); const reason = new Error("normal worker shutdown"); const failure = new Error("The repository identity changed.");
    vi.mocked(f.git.verifyWorktree).mockImplementationOnce(async () => { cancellation.abort(reason); throw failure; });
    await createWorkerCoordinator({ ...f.options, signal: cancellation.signal }).tick();
    expect(f.store.getTask(original)?.recovery.pauseReason).toBe(failure.message); expect(f.events.some((event) => event.kind === "paused" && event.error === failure)).toBe(true);
  });

  it("recognizes only cancellation errors causally linked to the aborted worker signal", () => {
    const cancellation = new AbortController(); const reason = new Error("normal worker shutdown"); const unrelated = new Error("Other request was cancelled.");
    expect(isWorkerCancellation(reason, cancellation.signal)).toBe(false); cancellation.abort(reason);
    expect(isWorkerCancellation(reason, cancellation.signal)).toBe(true);
    expect(isWorkerCancellation(new Error("wrapped", { cause: new OperationError("cancelled", { cause: reason }) }), cancellation.signal)).toBe(true);
    expect(isWorkerCancellation(new OperationError("cancelled", { cause: unrelated }), cancellation.signal)).toBe(false);
    expect(isWorkerCancellation(new Error("Independent failure."), cancellation.signal)).toBe(false);
  });

  it.each(["foreign-present", "permission-denied"] as const)("does not treat a predecessor attribution failure as an empty path when %s", async (condition) => {
    const f = await fixture(); await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    await mkdir(original.resources.worktree!.worktreePath, { recursive: true });
    const failure = condition === "permission-denied" ? Object.assign(new Error("Permission denied while inspecting the original worktree."), { code: "EACCES" }) : new Error("The task worktree ownership marker or repository identity does not match this claim.");
    vi.mocked(f.git.findWorktree).mockRejectedValueOnce(failure);
    const otherOrigin = "https://other-daynight.example"; const project = { ...f.projects[0]!, serverOrigin: otherOrigin, projectId: uuid(1060) }; f.store.registerProject(project);
    const candidate = remoteTask(project.projectId, original.taskId);
    const actual: Task = { ...candidate, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { claimId: uuid(1061), worktreeId: uuid(1062), workerId, userId: uuid(2), machine: f.options.machine, platform: "linux", agent: "codex", phase: "preparing", state: "active", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } } };
    const otherRemote = { ...f.remote, serverOrigin: otherOrigin, currentUserId: vi.fn(async () => uuid(2)), ownInventory: vi.fn(async () => [actual]), candidates: vi.fn(async function* () {}) };
    const changedOrigin = createWorkerCoordinator({ ...f.options, serverOrigin: otherOrigin, remote: otherRemote, repositories: [{ project, configuration }], maxConcurrent: 2 });
    const identity = { serverOrigin: otherOrigin, projectId: project.projectId, taskId: original.taskId, claimId: uuid(1061) };
    if (condition === "permission-denied") {
      await expect(changedOrigin.tick()).rejects.toBe(failure); expect(f.store.getTask(identity)).toBeNull();
    } else {
      await changedOrigin.tick(); expect(f.store.getTask(identity)).toMatchObject({ configuration: null, resources: { worktree: null, herdr: null, nativeSession: null } });
    }
    expect(f.git.prepareWorktree).toHaveBeenCalledOnce(); expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
  });

  it("preserves a Git cleanup failure aggregated with normal cancellation as a real execution fault", async () => {
    const f = await fixture(); await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    const cancellation = new AbortController(); const reason = new Error("normal worker shutdown");
    const cancelledOperation = new OperationError("cancelled", { cause: reason });
    const terminationFailure = new Error("Git process termination is unconfirmed.");
    const failure = new AggregateError([terminationFailure], "Git failed and its process termination is unconfirmed.", { cause: cancelledOperation });
    vi.mocked(f.git.verifyWorktree).mockImplementationOnce(async () => { cancellation.abort(reason); throw failure; });
    await createWorkerCoordinator({ ...f.options, signal: cancellation.signal }).tick();
    expect(isWorkerCancellation(failure, cancellation.signal)).toBe(false);
    expect(f.store.getTask(original)?.recovery.pauseReason).toBe(failure.message);
    const diagnostic = f.events.find((event) => event.kind === "paused" && event.error === failure);
    expect(diagnostic?.error).toBe(failure); expect(failure.errors).toEqual([terminationFailure]); expect(failure.cause).toBe(cancelledOperation); expect(f.tasks.start).toHaveBeenCalledOnce();
  });

  it("never classifies independent aggregate cleanup failures as benign solely from their cancellation cause", () => {
    const cancellation = new AbortController(); const reason = new Error("normal worker shutdown"); cancellation.abort(reason);
    const cancelledOperation = new OperationError("cancelled", { cause: reason });
    const cleanupFailure = new Error("Git process termination is unconfirmed.");
    const mixed = new AggregateError([cleanupFailure], "Git termination failed.", { cause: cancelledOperation });
    const nested = new AggregateError([cancelledOperation, mixed], "Cleanup had mixed outcomes.", { cause: cancelledOperation });
    expect(isWorkerCancellation(mixed, cancellation.signal)).toBe(false); expect(isWorkerCancellation(nested, cancellation.signal)).toBe(false);
    expect(isWorkerCancellation(new Error("Wrapped cleanup failure.", { cause: nested }), cancellation.signal)).toBe(false);
    const pure = new AggregateError([cancelledOperation, new Error("Cancellation wrapper.", { cause: cancelledOperation })], "All operations were cancelled.", { cause: cancelledOperation });
    expect(isWorkerCancellation(pure, cancellation.signal)).toBe(true);
    expect(isWorkerCancellation(new AggregateError([cancelledOperation], "No link to the current worker abort."), cancellation.signal)).toBe(false);
  });

  it("does not materialize a fresh claim with missing configuration when cancellation interrupts predecessor inspection", async () => {
    const f = await fixture(); await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    await mkdir(original.resources.worktree!.worktreePath, { recursive: true });
    const before = f.store.getTask(original)!;
    const otherOrigin = "https://other-daynight.example"; const project = { ...f.projects[0]!, serverOrigin: otherOrigin, projectId: uuid(1070) }; f.store.registerProject(project);
    const candidate = remoteTask(project.projectId, original.taskId);
    const actual: Task = { ...candidate, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { claimId: uuid(1071), worktreeId: uuid(1072), workerId, userId: uuid(2), machine: f.options.machine, platform: "linux", agent: "codex", phase: "preparing", state: "active", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } } };
    const otherRemote = { ...f.remote, serverOrigin: otherOrigin, currentUserId: vi.fn(async () => uuid(2)), ownInventory: vi.fn(async () => [actual]), candidates: vi.fn(async function* () {}) };
    const frozen = { ...configuration, model: "fresh-handoff-config" };
    const cancellation = new AbortController(); const reason = new Error("normal worker shutdown");
    vi.mocked(f.git.findWorktree).mockImplementationOnce(async (task, operation) => { cancellation.abort(reason); operation.check(); return task.resources.worktree; });
    const changed = { ...f.options, serverOrigin: otherOrigin, remote: otherRemote, repositories: [{ project, configuration: frozen }], maxConcurrent: 2 };
    const incomingIdentity = { serverOrigin: otherOrigin, projectId: project.projectId, taskId: original.taskId, claimId: uuid(1071) };
    await expect(createWorkerCoordinator({ ...changed, signal: cancellation.signal }).tick()).rejects.toBeInstanceOf(OperationError);
    expect(f.store.getTask(incomingIdentity)).toBeNull(); expect(f.store.getTask(original)).toEqual(before); expect(f.tasks.start).toHaveBeenCalledOnce();
    const restarted = createWorkerCoordinator(changed); await restarted.tick();
    expect(f.store.getTask(incomingIdentity)).toMatchObject({ status: "pending", configuration: frozen, resources: { worktree: null, herdr: null, nativeSession: null } });
    f.store.beginCleanup(original, { kind: "terminal", deadline: 601000, claimEnded: true }, 1000); f.setTime(601000); await restarted.advanceCommittedCleanups(original); await restarted.tick();
    expect(f.store.getTask(incomingIdentity)).toMatchObject({ status: "active", configuration: frozen, nativeExecution: { promptSubmission: "submitted" } });
    expect(f.tasks.start).toHaveBeenCalledTimes(2); expect(f.tasks.start.mock.calls[1]![2].resumeSessionId).toBeUndefined(); expect(f.store.getTask(incomingIdentity)?.resources.nativeSession?.sessionId).not.toBe(original.resources.nativeSession!.sessionId);
  });

  it.each(["absent", "foreign-replacement"] as const)("revalidates a path whose predecessor completes before unfinished-row enumeration (%s)", async (pathState) => {
    const f = await fixture(); await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    f.setCompleteCleanup(false); f.granted.clear(); f.candidates.set(original.projectId, []); await f.coordinator.tick();
    f.store.recordCleanupResult(original, "completed", null, 1000); f.store.confirmAgentStopped(original, { agentStopped: true }, 1000); f.store.confirmWorkspaceClosed(original, { workspaceClosed: true }, 1000); f.resources.delete(original.claimId);
    const fixedPath = original.resources.worktree!.worktreePath; await mkdir(fixedPath, { recursive: true });
    const otherOrigin = "https://other-daynight.example"; const project = { ...f.projects[0]!, serverOrigin: otherOrigin, projectId: uuid(1080) }; f.store.registerProject(project);
    const candidate = remoteTask(project.projectId, original.taskId);
    const actual: Task = { ...candidate, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { claimId: uuid(1081), worktreeId: uuid(1082), workerId, userId: uuid(2), machine: f.options.machine, platform: "linux", agent: "codex", phase: "preparing", state: "active", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } } };
    const frozen = { ...configuration, model: "configuration-after-predecessor-completion" };
    const otherRemote = { ...f.remote, serverOrigin: otherOrigin, currentUserId: vi.fn(async () => uuid(2)), ownInventory: vi.fn(async () => [actual]), candidates: vi.fn(async function* () {}) };
    const resolve = filesystem.resolvePhysicalDirectory; let completedDuringObservation = false;
    vi.spyOn(filesystem, "resolvePhysicalDirectory").mockImplementationOnce(async (...args) => {
      const physical = await resolve(...args);
      rmSync(fixedPath, { recursive: true }); f.worktrees.delete(original.claimId);
      f.store.confirmWorktreeDeleted(original, { worktreeDeleted: true }, 1000); f.store.completeTask(original, 1000);
      if (pathState === "foreign-replacement") mkdirSync(fixedPath, { recursive: true });
      completedDuringObservation = true;
      return physical;
    });
    const changedOrigin = createWorkerCoordinator({ ...f.options, serverOrigin: otherOrigin, remote: otherRemote, repositories: [{ project, configuration: frozen }], maxConcurrent: 2 });
    const incomingIdentity = { serverOrigin: otherOrigin, projectId: project.projectId, taskId: original.taskId, claimId: uuid(1081) };
    await changedOrigin.tick(); expect(completedDuringObservation).toBe(true); expect(f.store.getTask(original)?.status).toBe("done");
    expect(f.store.getTask(incomingIdentity)).toBeNull(); expect(f.git.findWorktree).not.toHaveBeenCalled();
    await changedOrigin.tick(); const incoming = f.store.getTask(incomingIdentity)!;
    if (pathState === "absent") {
      expect(incoming.configuration).toEqual(frozen); expect(incoming.status).toBe("active"); expect(incoming.recovery.pauseReason).toBeNull();
      expect(f.events.some((event) => event.kind === "pending-recovered" && event.task?.claimId === incoming.claimId && event.task.status === "pending" && event.task.configuration?.model === frozen.model)).toBe(true);
      expect(f.tasks.start).toHaveBeenCalledTimes(2); expect(f.tasks.start.mock.calls[1]![2].resumeSessionId).toBeUndefined();
    } else {
      expect(incoming).toMatchObject({ configuration: null, resources: { worktree: null, herdr: null, nativeSession: null } }); expect(f.tasks.start).toHaveBeenCalledOnce();
    }
  });

  it.each(["predecessor", "unmarked", "successor"] as const)("recovers a new claim after worktree creation before SQLite binding (%s ownership)", async (owner) => {
    const f = await fixture(); const project = f.projects[0]!; const candidate = f.candidates.get(project.projectId)![0]!;
    const originalIdentity = { serverOrigin: origin, projectId: project.projectId, taskId: candidate.id, claimId: uuid(1090), workerId, worktreeId: uuid(1091) };
    f.store.registerPending(originalIdentity, { kind: "new", configuration }, 1000); f.store.bindUserScope(originalIdentity, uuid(2), 1000); const original = f.store.activateTask(originalIdentity, 1000);
    const operation = createOperation();
    let binding: NonNullable<LocalTask["resources"]["worktree"]>;
    try { binding = await f.git.prepareWorktree(original, operation); } finally { operation.dispose(); }
    await mkdir(binding.worktreePath, { recursive: true });
    expect(f.store.getTask(original)?.resources.worktree).toBeNull();
    vi.mocked(f.git.findWorktree).mockImplementation(async (task) => {
      expect(task).toMatchObject({ serverOrigin: origin, projectId: project.projectId, taskId: original.taskId, claimId: original.claimId, worktreeId: original.worktreeId });
      if (owner === "unmarked") throw new Error("An existing task worktree path has no matching ownership registration; it was retained.");
      if (owner === "successor") throw new Error("The task worktree ownership marker or repository identity does not match this claim.");
      return binding;
    });
    const successorId = uuid(1092); const actual: Task = { ...candidate, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { claimId: successorId, worktreeId: original.worktreeId, workerId, userId: uuid(2), machine: f.options.machine, platform: "linux", agent: "codex", phase: "preparing", state: "active", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } } };
    f.granted.set(successorId, actual); f.candidates.set(project.projectId, []);
    const frozen = { ...configuration, model: "new-claim-after-unbound-worktree" };
    await createWorkerCoordinator({ ...f.options, repositories: [{ project, configuration: frozen }] }).tick();
    const successor = f.store.getTask({ ...originalIdentity, claimId: successorId })!;
    if (owner === "predecessor") {
      expect(successor.configuration).toEqual(frozen); expect(successor.status).toBe("active"); expect(successor.recovery.pauseReason).toBeNull();
      expect(f.store.getTask(original)).toMatchObject({ status: "done", cleanup: { kind: "terminal", worktreeDeleted: true } });
      expect(vi.mocked(f.git.findWorktree).mock.calls[0]?.[0]).toMatchObject({ ...originalIdentity, resources: { worktree: null, herdr: null, nativeSession: null } });
      expect(f.events.some((event) => event.kind === "pending-recovered" && event.task?.claimId === successorId && event.task.configuration?.model === frozen.model)).toBe(true);
      expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.tasks.start.mock.calls[0]![0]).toMatchObject({ claimId: successorId, worktreeId: original.worktreeId }); expect(f.tasks.start.mock.calls[0]![2].resumeSessionId).toBeUndefined();
    } else {
      expect(successor).toMatchObject({ configuration: null, resources: { worktree: null, herdr: null, nativeSession: null } }); expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
    }
  });

  it.each(["ongoing-removal", "settled-during-final-check", "incoming-native-history", "incoming-herdr-resource"] as const)("materializes only across a stable predecessor removal boundary (%s)", async (phase) => {
    const f = await fixture(); await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    const fixedPath = original.resources.worktree!.worktreePath; await mkdir(fixedPath, { recursive: true }); await writeFile(path.join(fixedPath, ".git"), "gitdir: fixture-admin\n");
    const otherOrigin = "https://other-daynight.example"; const project = { ...f.projects[0]!, serverOrigin: otherOrigin, projectId: uuid(1100) }; f.store.registerProject(project);
    const candidate = remoteTask(project.projectId, original.taskId); const successorId = uuid(1101);
    const actual: Task = { ...candidate, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { claimId: successorId, worktreeId: uuid(1102), workerId, userId: uuid(2), machine: f.options.machine, platform: "linux", agent: "codex", phase: "preparing", state: "active", herdr: phase === "incoming-native-history" ? { session: "w", workspaceId: "existing-successor", paneId: "existing-successor-pane" } : null, nativeSessionId: phase === "incoming-native-history" ? uuid(1103) : null, claimedAt: "2026-10-27T00:00:00Z" } } };
    const incomingIdentity = { serverOrigin: otherOrigin, projectId: project.projectId, taskId: original.taskId, claimId: successorId };
    if (phase === "incoming-herdr-resource") {
      const binding = { session: "w", workspaceId: "existing-current-workspace", paneId: "existing-current-pane", terminalId: "existing-current-terminal" };
      f.resources.set(successorId, { owner: { ...incomingIdentity, worktreeId: uuid(1102) }, workspaceId: binding.workspaceId, panes: [{ binding, cwd: fixedPath, kind: "codex", status: "working", launchPending: false, interactiveReady: true, nativeSession: { source: "herdr:codex", agent: "codex", sessionId: uuid(1104) }, stateChangeSeq: 1, completionSeq: 0 }] });
    }
    const frozen = { ...configuration, model: "configuration-after-stable-removal" };
    const otherRemote = { ...f.remote, serverOrigin: otherOrigin, currentUserId: vi.fn(async () => uuid(2)), ownInventory: vi.fn(async () => [actual]), candidates: vi.fn(async function* () {}) };
    const beginRemoval = () => {
      f.store.beginCleanup(original, { kind: "terminal", deadline: 601000, claimEnded: true }, 1000); f.store.recordCleanupResult(original, "completed", null, 1000); f.store.confirmAgentStopped(original, { agentStopped: true }, 1000); f.store.confirmWorkspaceClosed(original, { workspaceClosed: true }, 1000); f.resources.delete(original.claimId);
      rmSync(path.join(fixedPath, ".git"));
    };
    const finishRemoval = () => {
      rmSync(fixedPath, { recursive: true }); f.worktrees.delete(original.claimId); f.store.confirmWorktreeDeleted(original, { worktreeDeleted: true }, 1000); f.store.completeTask(original, 1000);
    };
    const missingPointer = new Error("The original worktree Git pointer is missing; the present directory cannot be attributed safely and was retained.");
    let inspectAfterPointerRemoval = false; let completionBeforeMaterialization: boolean | undefined;
    if (phase === "settled-during-final-check") {
      vi.mocked(f.git.findWorktree).mockImplementationOnce(async () => { beginRemoval(); inspectAfterPointerRemoval = true; throw missingPointer; });
      const lstat = fsPromises.lstat; let positiveInspections = 0;
      vi.spyOn(fsPromises, "lstat").mockImplementation(async (...args) => {
        const observed = await lstat(...args);
        if (inspectAfterPointerRemoval && args[0] === fixedPath && ++positiveInspections === 2) {
          expect(existsSync(fixedPath)).toBe(true); completionBeforeMaterialization = f.store.getTask(incomingIdentity) === null; finishRemoval();
        }
        return observed;
      });
      syncBuiltinESMExports();
    } else {
      beginRemoval(); vi.mocked(f.git.findWorktree).mockRejectedValueOnce(missingPointer);
    }
    const changedOrigin = createWorkerCoordinator({ ...f.options, serverOrigin: otherOrigin, remote: otherRemote, repositories: [{ project, configuration: frozen }], maxConcurrent: 2 });
    await changedOrigin.tick();
    if (phase === "incoming-native-history" || phase === "incoming-herdr-resource") {
      expect(f.store.getTask(incomingIdentity)).toMatchObject({ status: "active", configuration: null, recovery: { pauseReason: expect.stringContaining("configuration") } }); expect(f.tasks.start).toHaveBeenCalledOnce(); return;
    }
    if (phase === "settled-during-final-check") { expect(completionBeforeMaterialization).toBe(true); expect(f.store.getTask(original)).toMatchObject({ status: "done", cleanup: { worktreeDeleted: true } }); expect(existsSync(fixedPath)).toBe(false); }
    else { expect(existsSync(fixedPath)).toBe(true); expect(existsSync(path.join(fixedPath, ".git"))).toBe(false); }
    expect(f.store.getTask(incomingIdentity)).toBeNull(); expect(f.tasks.start).toHaveBeenCalledOnce();
    if (phase === "ongoing-removal") finishRemoval();
    await changedOrigin.tick();
    expect(f.store.getTask(incomingIdentity)).toMatchObject({ status: "active", configuration: frozen, nativeExecution: { promptSubmission: "submitted" } }); expect(f.tasks.start).toHaveBeenCalledTimes(2); expect(f.tasks.start.mock.calls[1]![2].resumeSessionId).toBeUndefined();
  });

  it.each(["observed", "crash-after-observation", "never-observed"] as const)("retains an observed grant durably before predecessor removal can hide it (%s)", async (observation) => {
    const observed = observation !== "never-observed";
    const f = await fixture(); await f.coordinator.tick(); const predecessor = f.store.listTasks()[0]!;
    f.setCompleteCleanup(false); f.granted.clear(); f.candidates.set(predecessor.projectId, []); await f.coordinator.tick(); await mkdir(predecessor.resources.worktree!.worktreePath, { recursive: true });
    const otherOrigin = "https://other-daynight.example"; const project = { ...f.projects[0]!, serverOrigin: otherOrigin, projectId: uuid(1120) }; f.store.registerProject(project);
    const first = remoteTask(project.projectId, predecessor.taskId); const next = remoteTask(project.projectId, uuid(1121));
    const claimedConfiguration = { ...configuration, model: "configuration-saved-with-original-claim" };
    const restartConfiguration = { ...configuration, model: "configuration-after-restart" };
    let actual: Task | undefined; let mode: "first" | "none" | "next" = "first";
    const otherRemote: WorkerRemote = { ...f.remote, serverOrigin: otherOrigin, currentUserId: vi.fn(async () => uuid(2)), ownInventory: vi.fn(async () => actual === undefined ? [] : [actual]),
      candidates: vi.fn(async function* () { if (mode === "first" && actual === undefined) yield first; if (mode === "next" && actual?.id !== next.id) yield next; }),
      claim: vi.fn(async (candidate, descriptor) => {
        const granted: Task = { ...candidate, version: candidate.version + 1n, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { ...descriptor, userId: uuid(2), phase: "preparing", state: "active", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } } };
        actual = granted;
        if (candidate.id === first.id) throw new ApiError({ operation: "claim" }, "request", { cause: new Error("Successful claim response was lost."), outcomeUnconfirmed: true });
        return granted;
      }) };
    const changed = { ...f.options, serverOrigin: otherOrigin, remote: otherRemote, repositories: [{ project, configuration: claimedConfiguration }], maxConcurrent: 2 };
    const controller = createWorkerCoordinator(changed); await controller.tick();
    const attempt = f.store.getClaimAttempt(project)!; const identity = { serverOrigin: otherOrigin, projectId: project.projectId, taskId: first.id, claimId: attempt.claimId };
    expect(attempt.configuration).toEqual(claimedConfiguration); expect(f.store.getTask(identity)).toBeNull();
    const committedOwners: (string | null)[] = []; const register = f.store.registerPending; const interrupted = new Error("Process stopped immediately after pending commit.");
    vi.spyOn(f.store, "registerPending").mockImplementation((claim, registration, now, verifiedUserId) => {
      const task = register(claim, registration, now, verifiedUserId);
      if (claim.claimId === attempt.claimId) { committedOwners.push(task.userId); if (observation === "crash-after-observation") throw interrupted; }
      return task;
    });
    if (observation === "crash-after-observation") await expect(controller.tick()).rejects.toBe(interrupted);
    else if (observed) await controller.tick();
    const afterObservation = f.store.getTask(identity); const fenceAfterObservation = f.store.getClaimAttempt(project);
    actual = undefined; mode = "none"; await controller.tick();
    f.setTime(f.store.getTask(predecessor)!.cleanup!.deadline); await controller.advanceCommittedCleanups(predecessor);
    mode = "next"; const restarted = createWorkerCoordinator({ ...changed, repositories: [{ project, configuration: restartConfiguration }] }); await restarted.tick();
    expect(f.store.getTask(predecessor)?.status).toBe("done");
    if (observed) {
      expect({ attempt: f.store.getClaimAttempt(project), unfinished: f.store.listUnfinishedTasks().map(({ taskId, status }) => ({ taskId, status })) }).toEqual({ attempt: null, unfinished: [{ taskId: next.id, status: "active" }] });
      expect(committedOwners).toEqual([uuid(2)]);
      expect(afterObservation).toMatchObject({ status: "pending", userId: uuid(2), configuration: claimedConfiguration, nativeExecution: { launchSubmission: "never-submitted" }, resources: { worktree: null, herdr: null, nativeSession: null } }); expect(fenceAfterObservation).toBeNull();
      expect(f.store.getTask(identity)).toMatchObject({ status: "done", configuration: claimedConfiguration, resources: { worktree: null, herdr: null, nativeSession: null } });
      expect(f.store.listUnfinishedTasks()).toEqual([expect.objectContaining({ taskId: next.id, configuration: restartConfiguration, status: "active" })]); expect(otherRemote.claim).toHaveBeenCalledTimes(2);
    } else {
      expect(f.store.getClaimAttempt(project)).toEqual(attempt); expect(f.store.listUnfinishedTasks()).toEqual([]); expect(otherRemote.claim).toHaveBeenCalledOnce();
    }
    expect(vi.mocked(otherRemote.claim).mock.calls.filter(([candidate]) => candidate.id === first.id)).toHaveLength(1);
  });

  it("retains the saved attempt configuration without fresh-launch provenance when a positive grant already has execution traces", async () => {
    const f = await fixture(); const project = f.projects[0]!; const candidate = f.candidates.get(project.projectId)![0]!;
    const attempt = { taskId: candidate.id, claimId: uuid(1130), worktreeId: uuid(1131), workerId, userId: uuid(2), expectedVersion: candidate.version.toString(), configuration: { ...configuration, model: "saved-attempt-configuration" } }; f.store.beginClaimAttempt(project, attempt);
    const actual: Task = { ...candidate, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { claimId: attempt.claimId, worktreeId: attempt.worktreeId, workerId, userId: uuid(2), machine: f.options.machine, platform: "linux", agent: "codex", phase: "executing", state: "active", herdr: { session: "w", workspaceId: "previous-execution", paneId: "previous-pane" }, nativeSessionId: uuid(1132), claimedAt: "2026-10-27T00:00:00Z" } } };
    f.granted.set(attempt.claimId, actual); await f.coordinator.tick();
    const stored = f.store.getTask({ serverOrigin: origin, projectId: project.projectId, taskId: candidate.id, claimId: attempt.claimId })!;
    expect(f.store.getClaimAttempt(project)).toBeNull(); expect(stored).toMatchObject({ configuration: attempt.configuration, nativeExecution: null, resources: { worktree: null, herdr: null, nativeSession: null } });
    expect(f.git.prepareWorktree).not.toHaveBeenCalled(); expect(f.tasks.prepareWorkspace).not.toHaveBeenCalled(); expect(f.tasks.start).not.toHaveBeenCalled();
  });

  it("acknowledges an observed attempt before the existing orphan-row return without replacing native facts", async () => {
    const f = await fixture(); const project = f.projects[0]!; const candidate = f.candidates.get(project.projectId)![0]!;
    const attempt = { taskId: candidate.id, claimId: uuid(1140), worktreeId: uuid(1141), workerId, userId: uuid(2), expectedVersion: candidate.version.toString(), configuration: { ...configuration, model: "original-orphan-configuration" } }; f.store.beginClaimAttempt(project, attempt);
    const identity = { serverOrigin: origin, projectId: project.projectId, taskId: candidate.id, claimId: attempt.claimId, workerId, worktreeId: attempt.worktreeId };
    f.store.registerPending(identity, { kind: "recovered", configuration: null }, 1000, null); f.store.activatePausedRecovery(identity, "Original history requires intervention.", 1000);
    const worktree = { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: path.join(project.localPath, ".worktrees", "daynight", candidate.id), branch: `daynight/${candidate.id}` }; f.store.bindWorktree(identity, worktree, 1000);
    const binding = { session: "w", workspaceId: "orphan-original", paneId: "orphan-pane", terminalId: "orphan-terminal" }; f.store.bindHerdrExecution(identity, binding, null, 1000); f.store.bindNativeSession(identity, { source: "herdr", sessionId: uuid(1142) }, 1000);
    const original = f.store.getTask(identity)!; const register = f.store.registerPending; let acknowledged: LocalTask | undefined;
    vi.spyOn(f.store, "registerPending").mockImplementation((claim, registration, now, verifiedUserId) => { const task = register(claim, registration, now, verifiedUserId); if (claim.claimId === attempt.claimId) acknowledged = task; return task; });
    const actual: Task = { ...candidate, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { claimId: attempt.claimId, worktreeId: attempt.worktreeId, workerId, userId: uuid(2), machine: f.options.machine, platform: "linux", agent: "codex", phase: "executing", state: "active", herdr: { session: binding.session, workspaceId: binding.workspaceId, paneId: binding.paneId }, nativeSessionId: uuid(1142), claimedAt: "2026-10-27T00:00:00Z" } } };
    f.granted.set(attempt.claimId, actual); await f.coordinator.tick();
    expect(f.store.getClaimAttempt(project)).toBeNull(); expect(acknowledged).toMatchObject({ userId: uuid(2), configuration: attempt.configuration, status: original.status, nativeExecution: original.nativeExecution, resources: original.resources, recovery: original.recovery });
    expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.git.prepareWorktree).not.toHaveBeenCalled(); expect(f.store.getTask(identity)?.recovery.pauseReason).toBe(original.recovery.pauseReason);
  });

  it("counts recovered known-configuration execution responsibility before applying a lowered fresh-task limit", async () => {
    const f = await fixture(); await f.coordinator.tick(); const running = f.store.listTasks()[0]!; const project = f.projects[0]!; const candidate = remoteTask(project.projectId, uuid(1150));
    const attempt = { taskId: candidate.id, claimId: uuid(1151), worktreeId: uuid(1152), workerId, userId: uuid(2), expectedVersion: candidate.version.toString(), configuration }; f.store.beginClaimAttempt(project, attempt);
    const actual: Task = { ...candidate, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { claimId: attempt.claimId, worktreeId: attempt.worktreeId, workerId, userId: uuid(2), machine: f.options.machine, platform: "linux", agent: "codex", phase: "executing", state: "active", herdr: { session: "w", workspaceId: "existing-unavailable", paneId: "existing-pane" }, nativeSessionId: uuid(1153), claimedAt: "2026-10-27T00:00:00Z" } } };
    f.granted.set(attempt.claimId, actual); await f.coordinator.tick();
    expect(f.store.listUnfinishedTasks().filter(({ status }) => status === "active")).toHaveLength(2); expect(f.store.getTask({ ...running, taskId: candidate.id, claimId: attempt.claimId })).toMatchObject({ configuration, nativeExecution: null, recovery: { pauseReason: expect.stringContaining("native session ID is missing") } });
    expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.git.prepareWorktree).toHaveBeenCalledOnce(); expect(f.store.getClaimAttempt(project)).toBeNull();
  });

  it("does not acknowledge an observed claim that differs from the original frozen agent", async () => {
    const f = await fixture(); const project = f.projects[0]!; const candidate = f.candidates.get(project.projectId)![0]!;
    const attempt = { taskId: candidate.id, claimId: uuid(1160), worktreeId: uuid(1161), workerId, userId: uuid(2), expectedVersion: candidate.version.toString(), configuration }; f.store.beginClaimAttempt(project, attempt);
    f.granted.set(attempt.claimId, { ...candidate, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { claimId: attempt.claimId, worktreeId: attempt.worktreeId, workerId, userId: uuid(2), machine: f.options.machine, platform: "linux", agent: "copilot", phase: "preparing", state: "active", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } } });
    await expect(f.coordinator.tick()).rejects.toThrow("does not match the original claim request and frozen agent"); expect(f.store.getClaimAttempt(project)).toEqual(attempt); expect(f.store.listTasks()).toEqual([]); expect(f.tasks.start).not.toHaveBeenCalled();
  });

  it.each([{ stage: "ensure", observed: true }, { stage: "snapshot", observed: true }, { stage: "ensure", observed: false }, { stage: "snapshot", observed: false }] as const)("persists authenticated grant acknowledgement before Herdr $stage failure (observed: $observed)", async ({ stage, observed }) => {
    const f = await fixture(); const project = f.projects[0]!; const [first, next] = f.candidates.get(project.projectId)!;
    const claim = vi.mocked(f.remote.claim).getMockImplementation()!;
    vi.mocked(f.remote.claim).mockImplementationOnce(async (...args) => { await claim(...args); throw new ApiError({ operation: "claim" }, "request", { cause: new Error("Successful claim reply was lost."), outcomeUnconfirmed: true }); });
    await f.coordinator.tick(); const attempt = f.store.getClaimAttempt(project)!;
    const identity = { serverOrigin: origin, projectId: project.projectId, taskId: first!.id, claimId: attempt.claimId };
    if (!observed) f.granted.clear();
    const failure = new Error(`Herdr ${stage} unavailable.`);
    if (stage === "ensure") vi.mocked(f.herdr.ensureInstance).mockRejectedValueOnce(failure); else f.tasks.listResources.mockRejectedValueOnce(failure);
    await expect(f.coordinator.tick()).rejects.toBe(failure);
    const afterFailure = f.store.getTask(identity); const attemptAfterFailure = f.store.getClaimAttempt(project);
    expect(f.git.prepareWorktree).not.toHaveBeenCalled(); expect(f.tasks.prepareWorkspace).not.toHaveBeenCalled(); expect(f.tasks.start).not.toHaveBeenCalled();
    f.granted.clear(); f.candidates.set(project.projectId, [next!]); const restartedConfiguration = { ...configuration, model: "after-Herdr-recovery" };
    await createWorkerCoordinator({ ...f.options, repositories: [{ project, configuration: restartedConfiguration }] }).tick();
    if (observed) {
      expect({ attempt: f.store.getClaimAttempt(project), unfinished: f.store.listUnfinishedTasks().map(({ taskId }) => taskId) }).toEqual({ attempt: null, unfinished: [next!.id] });
      expect(afterFailure).toMatchObject({ status: "pending", userId: uuid(2), configuration: attempt.configuration, nativeExecution: { launchSubmission: "never-submitted", workspaceSubmission: "not-submitted" }, resources: { worktree: null, herdr: null, nativeSession: null } }); expect(attemptAfterFailure).toBeNull();
      expect(f.store.getTask(identity)).toMatchObject({ status: "done", configuration: attempt.configuration }); expect(f.remote.claim).toHaveBeenCalledTimes(2);
    } else {
      expect(afterFailure).toBeNull(); expect(attemptAfterFailure).toEqual(attempt); expect(f.store.getClaimAttempt(project)).toEqual(attempt); expect(f.store.listUnfinishedTasks()).toEqual([]); expect(f.remote.claim).toHaveBeenCalledOnce();
    }
    expect(vi.mocked(f.remote.claim).mock.calls.filter(([candidate]) => candidate.id === first!.id)).toHaveLength(1);
  });

  it.each(["live-original", "missing-original", "inactive-unknown"] as const)("invalidates request-only fresh proof when a later successful snapshot reveals an existing workspace (%s)", async (mode) => {
    const f = await fixture(); const project = f.projects[0]!; const claim = vi.mocked(f.remote.claim).getMockImplementation()!;
    vi.mocked(f.remote.claim).mockImplementationOnce(async (...args) => { await claim(...args); throw new ApiError({ operation: "claim" }, "request", { cause: new Error("Successful claim reply was lost."), outcomeUnconfirmed: true }); });
    await f.coordinator.tick(); const attempt = f.store.getClaimAttempt(project)!; const identity = { serverOrigin: origin, projectId: project.projectId, taskId: attempt.taskId, claimId: attempt.claimId };
    f.tasks.listResources.mockRejectedValueOnce(new Error("Snapshot unavailable.")); await expect(f.coordinator.tick()).rejects.toThrow("Snapshot unavailable");
    expect(f.store.getTask(identity)).toMatchObject({ status: "pending", nativeExecution: { launchSubmission: "never-submitted", workspaceSubmission: "not-submitted" } });
    const binding = { session: "w", workspaceId: "previous-hidden-workspace", paneId: "previous-hidden-pane", terminalId: "previous-hidden-terminal" };
    const worktreePath = path.join(project.localPath, ".worktrees", "daynight", attempt.taskId);
    if (mode !== "missing-original") f.worktrees.set(attempt.claimId, { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath, branch: `daynight/${attempt.taskId}` });
    f.resources.set(attempt.claimId, { owner: { ...identity, worktreeId: attempt.worktreeId }, workspaceId: binding.workspaceId, panes: [{ binding, cwd: worktreePath, kind: mode === "inactive-unknown" ? null : "codex", status: mode === "inactive-unknown" ? "idle" : "working", launchPending: false, interactiveReady: mode !== "inactive-unknown", nativeSession: mode === "inactive-unknown" ? null : { source: "herdr:codex", agent: "codex", sessionId: uuid(1170) }, stateChangeSeq: 1, completionSeq: 0 }] });
    if (mode === "inactive-unknown") f.tasks.captureStop.mockRejectedValue(new Error("The original native process identities are unavailable."));
    await f.coordinator.tick();
    const observed = f.store.getTask(identity)!; expect(observed.status).toBe("active"); expect(observed.nativeExecution?.launchSubmission).toBe("unknown"); expect(f.git.prepareWorktree).not.toHaveBeenCalled(); expect(f.tasks.prepareWorkspace).not.toHaveBeenCalled(); expect(f.tasks.start).not.toHaveBeenCalled();
    if (mode === "live-original") {
      expect(f.git.findWorktree).toHaveBeenCalledOnce(); expect(observed.resources.nativeSession?.sessionId).toBe(uuid(1170)); expect(observed.nativeExecution?.stopObservation).not.toBeNull();
    } else {
      expect(observed.recovery.pauseReason).not.toBeNull(); f.granted.clear(); f.candidates.set(project.projectId, []); await f.coordinator.tick();
      expect(f.tasks.confirmEmptyPane).not.toHaveBeenCalled(); expect(f.tasks.closeWorkspace).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
      f.resources.delete(attempt.claimId); await createWorkerCoordinator(f.options).tick();
      expect(f.store.getTask(identity)).toMatchObject({ status: "active", cleanup: { kind: "terminal", agentStopped: false, worktreeDeleted: false } }); expect(f.store.getTask(identity)?.nativeExecution?.launchSubmission).toBe("unknown"); expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
    }
  });

  it("acknowledges a runtime-reported grant with unknown native provenance before Herdr readiness fails", async () => {
    const f = await fixture(); const project = f.projects[0]!; const candidate = f.candidates.get(project.projectId)![0]!;
    const attempt = { taskId: candidate.id, claimId: uuid(1180), worktreeId: uuid(1181), workerId, userId: uuid(2), expectedVersion: candidate.version.toString(), configuration }; f.store.beginClaimAttempt(project, attempt);
    f.granted.set(attempt.claimId, { ...candidate, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { claimId: attempt.claimId, worktreeId: attempt.worktreeId, workerId, userId: uuid(2), machine: f.options.machine, platform: "linux", agent: "codex", phase: "executing", state: "active", herdr: { session: "w", workspaceId: "reported-workspace", paneId: "reported-pane" }, nativeSessionId: uuid(1182), claimedAt: "2026-10-27T00:00:00Z" } } });
    vi.mocked(f.herdr.ensureInstance).mockRejectedValueOnce(new Error("Herdr unavailable.")); await expect(f.coordinator.tick()).rejects.toThrow("Herdr unavailable");
    expect(f.store.getClaimAttempt(project)).toBeNull(); expect(f.store.getTask({ serverOrigin: origin, projectId: project.projectId, taskId: candidate.id, claimId: attempt.claimId })).toMatchObject({ userId: uuid(2), configuration, nativeExecution: null, resources: { worktree: null, herdr: null, nativeSession: null } }); expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.git.prepareWorktree).not.toHaveBeenCalled();
  });

  it.each([false, true])("observes a pending row before using never-launched proof during independent shutdown (original native attributable: %s)", async (attributable) => {
    const f = await fixture(); const project = f.projects[0]!; const identity = { serverOrigin: origin, projectId: project.projectId, taskId: uuid(1190), claimId: uuid(1191), worktreeId: uuid(1192), workerId };
    f.store.registerPending(identity, { kind: "new", configuration }, 1000, uuid(2));
    const binding = { session: "w", workspaceId: "hidden-at-shutdown", paneId: "hidden-pane", terminalId: "hidden-terminal" }; const worktreePath = path.join(project.localPath, ".worktrees", "daynight", identity.taskId);
    if (attributable) f.worktrees.set(identity.claimId, { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath, branch: `daynight/${identity.taskId}` });
    f.resources.set(identity.claimId, { owner: { serverOrigin: origin, projectId: identity.projectId, taskId: identity.taskId, claimId: identity.claimId, worktreeId: identity.worktreeId }, workspaceId: binding.workspaceId, panes: [{ binding, cwd: worktreePath, kind: attributable ? "codex" : null, status: "idle", launchPending: false, interactiveReady: attributable, nativeSession: attributable ? { source: "herdr:codex", agent: "codex", sessionId: uuid(1193) } : null, stateChangeSeq: attributable ? 1 : null, completionSeq: attributable ? 0 : null }] });
    expect(await f.coordinator.shutdown()).toBe(attributable); expect(f.store.getTask(identity)).toMatchObject({ status: "active", nativeExecution: { launchSubmission: "unknown" }, cleanup: { kind: "shutdown", agentStopped: attributable, workspaceClosed: attributable, worktreeDeleted: false } });
    if (attributable) { expect(f.tasks.forceStop).toHaveBeenCalledOnce(); expect(f.tasks.closeWorkspace).toHaveBeenCalledOnce(); expect(f.store.getTask(identity)?.resources.nativeSession?.sessionId).toBe(uuid(1193)); }
    else { expect(f.tasks.forceStop).not.toHaveBeenCalled(); expect(f.tasks.closeWorkspace).not.toHaveBeenCalled(); }
    expect(f.tasks.confirmEmptyPane).not.toHaveBeenCalled(); expect(f.git.prepareWorktree).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled(); expect(f.tasks.start).not.toHaveBeenCalled();
  });

  it("persists source management before recovery and releases only after the complete original cleanup", async () => {
    const f = await fixture(2); await f.coordinator.tick();
    const [source, sibling] = f.store.listTasks();
    const remote = f.granted.get(source!.claimId)!;
    f.store.recordControlIntent(source!, { kind: "release", sourceClaimId: source!.claimId, version: remote.version.toString() }, 1100);
    f.candidates.set(f.projects[0]!.projectId, []);
    await f.coordinator.advanceCommittedCleanups(source!);
    expect(f.store.getTask(source!)?.status).toBe("done");
    expect(f.order.indexOf("release")).toBeGreaterThan(f.order.indexOf("delete-worktree"));
    expect(f.store.getTask(sibling!)?.cleanup).toBeNull();
    expect(f.tasks.start).toHaveBeenCalledTimes(2);
    expect(f.herdr.stopInstance).not.toHaveBeenCalled();
  });

  it("cleans a controlled unstarted pending successor without touching the old active task path", async () => {
    const f = await fixture(); await f.coordinator.tick();
    const source = f.store.listTasks()[0]!;
    const successor = { ...source, claimId: uuid(940), worktreeId: uuid(941) };
    f.store.registerPending(successor, { kind: "new", configuration }, 1100, uuid(2));
    f.store.recordControlIntent(successor, { kind: "release", sourceClaimId: successor.claimId, version: "8" }, 1101);
    const prior = f.granted.get(source.claimId)!;
    f.granted.delete(source.claimId);
    f.granted.set(successor.claimId, { ...prior, version: 8n, properties: { ...prior.properties, worker: { ...prior.properties.worker!, claimId: successor.claimId, worktreeId: successor.worktreeId, phase: "preparing", herdr: null, nativeSessionId: null } } });
    vi.mocked(f.git.findWorktree).mockClear(); vi.mocked(f.git.removeWorktree).mockClear();
    await f.coordinator.advanceCommittedCleanups(successor);
    expect(f.store.getTask(successor)?.status).toBe("done");
    expect(f.store.getTask(source)?.status).toBe("active");
    expect(f.git.findWorktree).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
    expect(f.tasks.forceStop).not.toHaveBeenCalled(); expect(f.tasks.start).toHaveBeenCalledOnce();
  });

  it("freezes an explicitly granted new agent without inheriting another native kind's model or arguments", async () => {
    const f = await fixture();
    const candidate = f.candidates.get(f.projects[0]!.projectId)![0]!;
    const claimId = uuid(950);
    f.granted.set(claimId, { ...candidate, version: 5n, status: "in_progress", ready: false, properties: { ...candidate.properties, worker: { claimId, state: "active", userId: uuid(2), workerId, machine: { id: uuid(3), name: "fixture" }, platform: "linux", agent: "copilot", worktreeId: uuid(951), phase: "preparing", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } } });
    f.candidates.set(f.projects[0]!.projectId, []);
    await f.coordinator.tick();
    const task = f.store.listTasks()[0]!;
    expect(task.configuration).toEqual({ agent: "copilot", model: null, args: [], recoveryLimit: configuration.recoveryLimit });
    expect(f.tasks.start).toHaveBeenCalledOnce();
    expect(f.tasks.start.mock.calls[0]![0].agent).toBe("copilot");
    expect(task.resources.nativeSession?.sessionId).toBe(uuid(1001));
  });

  it("blocks later native launch when a control intent arrives while worktree preparation is in flight", async () => {
    const f = await fixture();
    const prepare = vi.mocked(f.git.prepareWorktree).getMockImplementation()!;
    vi.mocked(f.git.prepareWorktree).mockImplementationOnce(async (...args) => {
      const binding = await prepare(...args);
      const task = f.store.listTasks()[0]!;
      f.store.recordControlIntent(task, { kind: "release", sourceClaimId: task.claimId, version: f.granted.get(task.claimId)!.version.toString() }, 1100);
      return binding;
    });
    await f.coordinator.tick();
    expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.tasks.prepareWorkspace).not.toHaveBeenCalled();
    expect(f.store.listTasks()[0]?.control?.intent.kind).toBe("release");
    await f.coordinator.advanceCommittedCleanups(f.store.listTasks()[0]!);
    expect(f.store.listTasks()[0]?.status).toBe("done");
  });

  it("completes a saved control from original-user full inventory absence without a targeted task request", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!;
    f.store.recordControlIntent(task, { kind: "release", sourceClaimId: task.claimId, version: f.granted.get(task.claimId)!.version.toString() }, 1100);
    f.granted.clear(); f.candidates.set(task.projectId, []);
    vi.mocked(f.remote.readTask).mockRejectedValue(new Error("Task GET unavailable"));
    await f.coordinator.tick();
    expect(f.store.getTask(task)).toMatchObject({ status: "done", control: { submission: "confirmed", outcome: "ownership-ended" }, cleanup: { worktreeDeleted: true } });
    expect(f.remote.readTask).not.toHaveBeenCalled(); expect(f.remote.release).not.toHaveBeenCalled();
  });

  it("confirms shutdown native stop while a saved control still needs unavailable remote resolution", async () => {
    const f = await fixture(); await f.coordinator.tick(); const task = f.store.listTasks()[0]!;
    f.store.recordControlIntent(task, { kind: "release", sourceClaimId: task.claimId, version: f.granted.get(task.claimId)!.version.toString() }, 1100);
    vi.mocked(f.remote.readTask).mockRejectedValue(new Error("Task GET unavailable"));
    expect(await f.coordinator.shutdown()).toBe(true);
    expect(f.store.getTask(task)).toMatchObject({ status: "active", control: { submission: "not-submitted" }, cleanup: { agentStopped: true, workspaceClosed: true, worktreeDeleted: true } });
    expect(f.remote.readTask).not.toHaveBeenCalled(); expect(f.remote.release).not.toHaveBeenCalled();
  });

  it("continues the original acknowledged known-unsent native launch after public retry without a native ID or second start", async () => {
    const f = await fixture(); const gate = gatedFirstInput(f); await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    expect(original).toMatchObject({ status: "active", userId: uuid(2), nativeExecution: { launchSubmission: "acknowledged", promptSubmission: "not-submitted", stopObservation: { shellPid: 100, nativeProcessIds: [101] } }, resources: { nativeSession: null }, recovery: { count: 0, retryAuthorized: false, pauseReason: expect.stringContaining("folder-trust") } });
    await f.coordinator.tick(); expect(gate.nativeLaunches()).toBe(1); expect(gate.managedInputs()).toBe(0);
    gate.acceptTrust(); await retryOriginal(f, original); await f.coordinator.advanceRetry(original);
    const completedInput = f.store.getTask(original)!;
    expect(completedInput).toMatchObject({ claimId: original.claimId, worktreeId: original.worktreeId, configuration, nativeExecution: { launchSubmission: "acknowledged", promptSubmission: "submitted", launchEvidence: original.nativeExecution!.launchEvidence, stopObservation: original.nativeExecution!.stopObservation }, resources: { herdr: original.resources.herdr, worktree: original.resources.worktree, nativeSession: { sessionId: uuid(1200) } }, recovery: { count: 1, retryAuthorized: false, pauseReason: null } });
    expect(gate.nativeLaunches()).toBe(1); expect(gate.managedInputs()).toBe(1); expect(f.tasks.prepareWorkspace).toHaveBeenCalledOnce(); expect(f.git.prepareWorktree).toHaveBeenCalledOnce();
    await expect(retryOriginal(f, original)).rejects.toThrow("paused active execution"); await f.coordinator.tick(); expect(gate.nativeLaunches()).toBe(1); expect(gate.managedInputs()).toBe(1); expect(f.store.getTask(original)?.recovery.count).toBe(1);
  });

  it("keeps original native key PIDs while allowing ordinary child-process changes before first input", async () => {
    const f = await fixture(); let childrenChanged = false;
    f.tasks.captureStop.mockImplementation(async (context, binding) => ({ binding, ownerLabel: herdrExecutionLabel(context), agent: context.agent, nativeSessionId: null, shellPid: 100, processIds: childrenChanged ? [101, 103] : [101, 102], nativeProcessIds: [101], observedAt: 1000 }));
    const gate = gatedFirstInput(f); await f.coordinator.tick(); const original = f.store.listTasks()[0]!; childrenChanged = true; gate.acceptTrust(); await retryOriginal(f, original); await f.coordinator.advanceRetry(original);
    expect(gate.nativeLaunches()).toBe(1); expect(gate.managedInputs()).toBe(1); expect(f.store.getTask(original)?.nativeExecution?.stopObservation).toMatchObject({ processIds: [101, 102], nativeProcessIds: [101] });
  });

  it.each(["native-replaced", "terminal-replaced", "native-missing", "receipt-mismatch", "legacy-unknown-key"] as const)("fences known-unsent first input when original launch evidence is not current (%s)", async (failure) => {
    const f = await fixture(); const gate = gatedFirstInput(f);
    if (failure === "native-replaced") f.tasks.captureStop.mockImplementation(async (context, binding) => ({ binding, ownerLabel: herdrExecutionLabel(context), agent: context.agent, nativeSessionId: null, shellPid: 100, processIds: [101, 102], nativeProcessIds: [101], observedAt: 1000 }));
    if (failure === "legacy-unknown-key") f.tasks.captureStop.mockImplementation(async (context, binding) => ({ binding, ownerLabel: herdrExecutionLabel(context), agent: context.agent, nativeSessionId: null, shellPid: 100, processIds: [101], nativeProcessIds: null, observedAt: 1000 }));
    await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    if (failure === "native-replaced") f.tasks.captureStop.mockImplementation(async (context, binding) => ({ binding, ownerLabel: herdrExecutionLabel(context), agent: context.agent, nativeSessionId: null, shellPid: 100, processIds: [201, 102], nativeProcessIds: [201], observedAt: 1001 }));
    if (failure === "terminal-replaced") f.resources.get(original.claimId)!.panes[0]!.binding.terminalId = "replacement-terminal";
    if (failure === "native-missing") f.resources.delete(original.claimId);
    if (failure === "receipt-mismatch") {
      const database = new Database(path.join(f.root, "state.sqlite"));
      try { database.prepare("UPDATE tasks SET native_execution = ? WHERE claim_id = ?").run(JSON.stringify({ ...original.nativeExecution!, launchEvidence: { ...original.nativeExecution!.launchEvidence!, argv: ["codex", "--no-daemon", "--model", "different-model", "--search"] } }), original.claimId); } finally { database.close(); }
    }
    gate.acceptTrust(); await retryOriginal(f, original); await f.coordinator.advanceRetry(original);
    expect(gate.nativeLaunches()).toBe(1); expect(gate.managedInputs()).toBe(0); expect(f.tasks.prepareWorkspace).toHaveBeenCalledOnce(); expect(f.git.prepareWorktree).toHaveBeenCalledOnce(); expect(f.store.getTask(original)?.resources.nativeSession).toBeNull();
    expect(f.store.getTask(original)).toMatchObject({ configuration, nativeExecution: { promptSubmission: "not-submitted" }, recovery: { count: 0, pauseReason: expect.any(String) } });
  });

  it("preserves acknowledged unsent facts and original error causes when native process observation fails", async () => {
    const f = await fixture(); gatedFirstInput(f); const failure = new Error("Original process information is unavailable."); f.tasks.captureStop.mockRejectedValueOnce(failure);
    await f.coordinator.tick(); const task = f.store.listTasks()[0]!;
    expect(task).toMatchObject({ nativeExecution: { launchSubmission: "acknowledged", promptSubmission: "not-submitted", stopObservation: null }, recovery: { count: 0, pauseReason: expect.stringContaining("process observation failed") } });
    const error = f.events.find((event) => event.kind === "paused")!.error;
    expect(error).toBeInstanceOf(AggregateError); expect((error as AggregateError).errors).toContain(failure); expect((error as Error).cause).toBeInstanceOf(HerdrAgentActionError);
  });

  it.each(["submitted", "unknown"] as const)("does not reinterpret %s first input without native history as known-unsent recovery", async (submission) => {
    const f = await fixture(); const gate = gatedFirstInput(f); await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    f.store.recordNativeStartOutcome(original, { promptSubmission: submission }, 1000); f.resources.delete(original.claimId); gate.acceptTrust(); await retryOriginal(f, original); await f.coordinator.advanceRetry(original);
    expect(f.store.getTask(original)).toMatchObject({ nativeExecution: { promptSubmission: submission }, resources: { nativeSession: null }, recovery: { pauseReason: expect.stringContaining("native session ID is missing") } }); expect(gate.nativeLaunches()).toBe(1); expect(gate.managedInputs()).toBe(0); expect(f.git.prepareWorktree).toHaveBeenCalledOnce();
  });

  it.each(["release", "shutdown"] as const)("does not use cleanup input to accept a blocked startup screen during %s", async (kind) => {
    const f = await fixture(); const gate = gatedFirstInput(f); await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    f.tasks.submitPrompt.mockRejectedValue(new HerdrAgentActionError("The folder-trust screen blocks automatic cleanup input.", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" }));
    if (kind === "release") {
      const version = f.granted.get(original.claimId)!.version;
      await submitWorkerControl({ store: f.store, remote: f.remote, serverOrigin: origin, workerId, platform: "linux", machine: f.options.machine, repositories: f.options.repositories, request: { kind: "release", taskId: original.taskId, projectId: original.projectId, claimId: original.claimId, version }, signal: new AbortController().signal, now: f.options.now });
      await f.coordinator.advanceCommittedCleanups(original); expect(f.store.getTask(original)?.status).toBe("done"); expect(f.remote.release).toHaveBeenCalledOnce(); expect(f.git.removeWorktree).toHaveBeenCalledOnce();
    } else {
      expect(await f.coordinator.shutdown()).toBe(true); expect(f.store.getTask(original)).toMatchObject({ status: "active", resources: { worktree: original.resources.worktree, nativeSession: null } }); expect(f.git.removeWorktree).not.toHaveBeenCalled();
    }
    expect(f.store.getTask(original)?.cleanup).toMatchObject({ deadline: 601000, result: "failed", input: "rejected", agentStopped: true, workspaceClosed: true, worktreeDeleted: kind === "release" });
    expect(gate.nativeLaunches()).toBe(1); expect(gate.managedInputs()).toBe(0); expect(f.tasks.submitPrompt).toHaveBeenCalledOnce(); expect(f.tasks.forceStop).toHaveBeenCalledOnce(); expect(f.tasks.closeWorkspace).toHaveBeenCalledOnce();
  });

  it("persists a legacy waiting result as known-unsent before public retry on the same native launch", async () => {
    const f = await fixture(); const gate = gatedFirstInput(f); const launch = vi.mocked(f.herdr.tasks.start).getMockImplementation()!;
    vi.mocked(f.herdr.tasks.start).mockImplementationOnce(async (...args) => {
      try { return await launch(...args); }
      catch (error) {
        expect(error).toBeInstanceOf(HerdrAgentActionError);
        const [context, binding] = args; const pane = f.resources.get(context.claimId)!.panes[0]!; pane.status = "blocked";
        return { kind: "waiting", observation: { ...pane, binding, name: "fixture" }, promptSubmission: "not-submitted", launchEvidence: (error as HerdrAgentActionError).launchEvidence };
      }
    });
    await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    expect(original).toMatchObject({ nativeExecution: { launchSubmission: "acknowledged", promptSubmission: "not-submitted", stopObservation: { nativeProcessIds: [101] } }, recovery: { count: 0, pauseReason: expect.stringContaining("waiting before its first managed input") } });
    const originalStop = original.nativeExecution!.stopObservation;
    f.resources.get(original.claimId)!.panes[0]!.status = "idle"; gate.acceptTrust(); await f.coordinator.tick(); expect(gate.managedInputs()).toBe(0);
    await retryOriginal(f, original); await f.coordinator.advanceRetry(original);
    expect(gate.nativeLaunches()).toBe(1); expect(gate.managedInputs()).toBe(1); expect(f.store.getTask(original)).toMatchObject({ recovery: { count: 1, retryAuthorized: false, pauseReason: null }, nativeExecution: { promptSubmission: "submitted", stopObservation: originalStop } });
  });

  it.each(["control", "terminal", "shutdown"] as const)("keeps committed %s intent ahead of a ready known-unsent first input with retry permission", async (intent) => {
    const f = await fixture(); const gate = gatedFirstInput(f); await f.coordinator.tick(); const original = f.store.listTasks()[0]!; gate.acceptTrust(); await retryOriginal(f, original);
    if (intent === "control") f.store.recordControlIntent(original, { kind: "release", sourceClaimId: original.claimId, version: f.granted.get(original.claimId)!.version.toString() }, 1000);
    else f.store.beginCleanup(original, { kind: intent, deadline: 601000, ...(intent === "terminal" ? { claimEnded: true as const } : {}) }, 1000);
    f.tasks.submitPrompt.mockRejectedValue(new HerdrAgentActionError("The original cleanup input remains unavailable.", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" }));
    await f.coordinator.advanceRetry(original);
    expect(gate.nativeLaunches()).toBe(1); expect(gate.managedInputs()).toBe(0); expect(f.store.getTask(original)?.recovery.count).toBe(0);
    if (intent === "shutdown") expect(f.store.getTask(original)).toMatchObject({ status: "active", resources: { worktree: original.resources.worktree, nativeSession: null }, recovery: { pauseReason: expect.stringContaining("no longer has its original worktree and terminal binding") } });
    else expect(f.store.getTask(original)?.status).toBe("done");
    expect(f.tasks.forceStop).toHaveBeenCalledOnce(); expect(f.tasks.start).toHaveBeenCalledOnce();
  });

  it("rechecks committed source intent before journaling known-unsent input after process observation", async () => {
    const f = await fixture(); const gate = gatedFirstInput(f); await f.coordinator.tick(); const original = f.store.listTasks()[0]!; gate.acceptTrust(); await retryOriginal(f, original);
    const capture = f.tasks.captureStop.getMockImplementation()!;
    f.tasks.captureStop.mockImplementationOnce(async (...args) => {
      f.store.recordControlIntent(original, { kind: "release", sourceClaimId: original.claimId, version: f.granted.get(original.claimId)!.version.toString() }, 1000);
      return capture(...args);
    });
    await f.coordinator.advanceRetry(original);
    expect(f.store.getTask(original)).toMatchObject({ control: { intent: { kind: "release" } }, nativeExecution: { promptSubmission: "not-submitted" } }); expect(gate.nativeLaunches()).toBe(1); expect(gate.managedInputs()).toBe(0);
  });

  it.each(["user", "claim", "origin"] as const)("keeps public retry authority ahead of known-unsent continuation when %s changes", async (authority) => {
    const f = await fixture(); const gate = gatedFirstInput(f); await f.coordinator.tick(); const original = f.store.listTasks()[0]!; gate.acceptTrust();
    if (authority === "user") vi.mocked(f.remote.currentUserId).mockResolvedValue(uuid(1220));
    if (authority === "claim") { const task = f.granted.get(original.claimId)!; f.granted.set(original.claimId, { ...task, properties: { ...task.properties, worker: { ...task.properties.worker!, claimId: uuid(1221) } } }); }
    if (authority === "origin") {
      await expect(submitWorkerControl({ store: f.store, remote: f.remote, serverOrigin: "https://different-daynight.example", workerId, platform: "linux", machine: f.options.machine, repositories: [], request: { kind: "retry", taskId: original.taskId, projectId: original.projectId, claimId: original.claimId }, signal: new AbortController().signal, now: f.options.now })).rejects.toThrow("different configured service origin");
    } else await expect(retryOriginal(f, original)).rejects.toThrow(authority === "user" ? "original authenticated execution owner" : "no longer the exact active execution");
    expect(f.store.getTask(original)).toMatchObject({ userId: original.userId, claimId: original.claimId, worktreeId: original.worktreeId, configuration, nativeExecution: { promptSubmission: "not-submitted" }, recovery: { count: 0, retryAuthorized: false } }); expect(gate.nativeLaunches()).toBe(1); expect(gate.managedInputs()).toBe(0);
  });

  it.each(["release", "shutdown"] as const)("stops the original launch after its first official native ID appears during %s", async (kind) => {
    const f = await fixture(); const gate = gatedFirstInput(f); await f.coordinator.tick(); const original = f.store.listTasks()[0]!;
    const originalProcessProof = original.nativeExecution!.stopObservation!; expect(originalProcessProof.nativeSessionId).toBeNull(); expect(originalProcessProof.nativeProcessIds).toEqual([101]);
    gate.acceptTrust(); await retryOriginal(f, original); await f.coordinator.advanceRetry(original);
    expect(f.store.getTask(original)).toMatchObject({ resources: { nativeSession: { sessionId: uuid(1200) } }, nativeExecution: { stopObservation: originalProcessProof }, recovery: { count: 1 } });
    if (kind === "release") {
      await submitWorkerControl({ store: f.store, remote: f.remote, serverOrigin: origin, workerId, platform: "linux", machine: f.options.machine, repositories: f.options.repositories, request: { kind: "release", taskId: original.taskId, projectId: original.projectId, claimId: original.claimId, version: f.granted.get(original.claimId)!.version }, signal: new AbortController().signal, now: f.options.now });
      await f.coordinator.advanceCommittedCleanups(original); expect(f.store.getTask(original)?.status).toBe("done"); expect(f.git.removeWorktree).toHaveBeenCalledOnce();
    } else {
      expect(await f.coordinator.shutdown()).toBe(true); expect(f.store.getTask(original)).toMatchObject({ status: "active", resources: { worktree: original.resources.worktree, nativeSession: { sessionId: uuid(1200) } } }); expect(f.git.removeWorktree).not.toHaveBeenCalled();
    }
    expect(f.store.getTask(original)).toMatchObject({ nativeExecution: { stopObservation: originalProcessProof }, resources: { nativeSession: { sessionId: uuid(1200) } }, cleanup: { deadline: 601000, agentStopped: true, workspaceClosed: true, worktreeDeleted: kind === "release" } }); expect(vi.mocked(f.herdr.tasks.forceStop).mock.calls[0]![2]).toEqual(originalProcessProof); expect(f.tasks.closeWorkspace).toHaveBeenCalledOnce(); expect(gate.nativeLaunches()).toBe(1); expect(gate.managedInputs()).toBe(1);
  });

});
