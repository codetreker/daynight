import { scanFromList } from "../../helpers/worker-git-scan.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { TimerOptions } from "node:timers";
import { afterEach, expect, it, vi } from "vitest";
import { readWorkerClaim } from "../../../src/api/task-properties.js";
import type { Task, WorkerClaimDescriptor } from "../../../src/api/types.js";
import type { Operation } from "../../../src/api/operation.js";
import { createWorkerCoordinator } from "../../../src/commands/worker/coordinator.js";
import { HerdrAgentActionError } from "../../../src/commands/worker/herdr.js";
import type { WorkerEvent, WorkerGitManager } from "../../../src/commands/worker/execution.js";
import type { HerdrAgentObservation, HerdrAgentStartInput, HerdrExecutionContext, HerdrOwnedWorkspace, HerdrPromptGuard, HerdrPromptResult, HerdrTaskBinding, WorkerHerdrAdapter } from "../../../src/commands/worker/herdr.js";
import type { ManagedAssignment } from "../../../src/commands/worker/prompts.js";
import type { WorkerRemote } from "../../../src/commands/worker/remote.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { ExecutionConfiguration, ResourceOwner, WorkerProject, WorktreeBinding } from "../../../src/commands/worker/types.js";
import { recordedHerdrTools } from "./herdr-tool-snapshot.fixtures.js";

const polling = vi.hoisted(() => ({ requested: [] as number[], onSchedule: undefined as ((milliseconds: number) => void) | undefined }));
vi.mock("node:timers/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: <T>(milliseconds: number, value?: T, options?: TimerOptions) => {
    polling.requested.push(milliseconds);
    polling.onSchedule?.(milliseconds);
    return actual.setTimeout(milliseconds === 1_000 ? 1 : milliseconds, value, options);
  } };
});
const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const origin = "https://daynight.example";
const workerId = uuid(1);
const configuration: ExecutionConfiguration = { agent: "codex", model: "current-model", args: ["--search"], recoveryLimit: 2 };
const directories: string[] = [];
const stores: ReturnType<typeof openWorkerStore>[] = [];
afterEach(async () => {
  polling.onSchedule = undefined; polling.requested.length = 0;
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const task = (projectId: string, id: string): Task => ({ type: "task", parentId: null, id, projectId, title: id, description: "task", status: "todo", allowAgents: true, assignedTo: null, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null, version: 1n, properties: { pullRequests: [] }, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true });
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 3500, interval: 10 });

const fixture = async (maxConcurrent = 1, registerProject = true) => {
  const base = path.resolve("../../.tmp/minimal-coordinator-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "r-")); directories.push(root);
  let store = openWorkerStore(path.join(root, "state.sqlite")); stores.push(store);
  const project: WorkerProject = { projectId: uuid(10), repoUrl: "https://example.test/owner/repo.git", localPath: path.join(root, "repo") }; if (registerProject) store.registerProject(project);
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
    prepareRepository: vi.fn(), dispose: vi.fn(), removeEmptyReservation: vi.fn(async () => {}),
    prepareWorktree: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => { expect(store.getTask(owner)?.status).toBe("active"); order.push("prepare-worktree"); const binding = bind(owner); worktrees.set(owner.claimId, { owner, binding }); return binding; }),
    verifyWorktree: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => { const found = worktrees.get(owner.claimId); if (found === undefined) throw new Error("Original worktree missing"); return found.binding; }),
    findWorktree: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => worktrees.get(owner.claimId)?.binding ?? null),
    scanWorktrees: scanFromList, listWorktrees: vi.fn(async (source: WorkerProject) => [...worktrees.values()].filter(({ owner }) => owner.projectId === source.projectId)),
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
    submitPrompt: vi.fn(async (context: HerdrExecutionContext, binding: HerdrTaskBinding, prompt: string, operation: Operation, beforeSubmit?: HerdrPromptGuard): Promise<HerdrPromptResult> => {
      const pane = resources.get(context.claimId)!.panes[0]!;
      const before = observe(context, binding);
      if (beforeSubmit !== undefined && !await beforeSubmit(operation)) return { submission: "skipped", observation: before };
      order.push("notify");
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
    ownInventory: vi.fn(async (projects: readonly { projectId: string }[]) => ({ tasks: [...grants.values()], coveredProjectIds: [...new Set(projects.map(project => project.projectId))], unavailableProjectIds: [] })),
    candidates: vi.fn(async function* (projectId: string) { for (const candidate of candidates) if (candidate.projectId === projectId && ![...grants.values()].some((value) => value.id === candidate.id)) yield candidate; }),
    claim: vi.fn(async (candidate: Task, descriptor: WorkerClaimDescriptor) => grant(candidate, descriptor)),
    readTask: vi.fn(async (_projectId: string, taskId: string) => { const result = [...grants.values()].find((value) => value.id === taskId); if (result === undefined) throw new Error("missing task"); return result; }),
    update: vi.fn(async (current: Task, update: object) => { const result = { ...current, properties: { ...current.properties, worker: { ...readWorkerClaim(current.properties)!, ...update } } }; grants.set(readWorkerClaim(current.properties)!.claimId, result); return result; }),
  } as unknown as WorkerRemote;
  const options = { store, git, herdr, remote, serverOrigin: origin, workerId, platform: "linux" as const, machine: { id: uuid(3), name: "fixture" }, repositories: [{ project, configuration }], globalConfiguration: configuration, maxConcurrent, preferPlatformSpecificTasks: false, buildPrompt: vi.fn((_assignment: ManagedAssignment) => "managed assignment"), emit: (event: WorkerEvent) => events.push(event), now: () => clock };
  const reopenStore = () => {
    stores.splice(stores.indexOf(store), 1); store.close();
    store = openWorkerStore(path.join(root, "state.sqlite")); stores.push(store); options.store = store;
    return store;
  };
  return { root, get store() { return store; }, reopenStore, project, candidates, grants, grant, resources, worktrees, git, herdr, tasks, remote, order, events, options, coordinator: createWorkerCoordinator(options), clock: (value: number) => { clock = value; }, bind, blockStartupInput: () => { blockedStartupInput = true; } };
};

it.each([{ paused: false, allowed: true }, { paused: true, allowed: true }, { paused: false, allowed: false }])("rechecks the original claim before restoring a closed shared instance (%j)", async ({ paused, allowed }) => {
  const f = await fixture(), candidate = f.candidates[0]!;
  const owner = { projectId: candidate.projectId, taskId: candidate.id, claimId: uuid(950), worktreeId: uuid(951) };
  const remoteTask = f.grant(candidate, { claimId: owner.claimId, workerId, machine: f.options.machine, platform: "linux", agent: "codex", worktreeId: owner.worktreeId });
  const local = f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex" })), tools = recordedHerdrTools();
  f.store.freezeNativeConfiguration(local, { ...configuration, toolLaunch: tools.agent, herdrLaunch: tools.herdr });
  f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) }); f.candidates.splice(0);
  let running = false;
  const unavailable = new Error("Original shared daemon has exited.");
  vi.mocked(f.herdr.ensureInstance).mockImplementation(async () => { if (!running) throw unavailable; return { reconnected: true, version: "0.9.5", protocol: 22, snapshot: {} }; });
  const restore = vi.fn(async (_context: HerdrExecutionContext, _operation: Operation) => { running = true; return { reconnected: false, version: "0.9.5", protocol: 22 as const, snapshot: {} }; });
  f.herdr.ensureExecution = restore;
  vi.mocked(f.remote.readTask).mockResolvedValue({ ...remoteTask, allowAgents: allowed, properties: { ...remoteTask.properties, paused } });
  try {
    if (paused || !allowed) {
      await expect(f.coordinator.tick()).rejects.toBe(unavailable);
      expect(restore).not.toHaveBeenCalled(); expect(f.tasks.start).not.toHaveBeenCalled();
    } else {
      await f.coordinator.tick();
      await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
      expect(restore).toHaveBeenCalledWith({ ...owner, agent: "codex", cwd: f.bind(owner).worktreePath }, expect.anything());
      expect(f.store.getNativeConfiguration(local)?.herdrLaunch).toEqual(tools.herdr);
    }
    expect(f.remote.claim).not.toHaveBeenCalled(); expect(f.store.getTask(local)?.claimId).toBe(owner.claimId);
  } finally { running = true; await f.coordinator.shutdown(); }
});


it("rebuilds an active server claim from empty SQLite with both projects inventoried and no new claim", async () => {
  const f = await fixture();
  const second: WorkerProject = { projectId: uuid(11), repoUrl: "https://example.test/owner/second.git", localPath: path.join(f.root, "second") };
  f.store.registerProject(second);
  f.options.repositories.push({ project: second, configuration });
  const candidate = f.candidates[0]!;
  const owner = { projectId: candidate.projectId, taskId: candidate.id, claimId: uuid(901), worktreeId: uuid(902) };
  f.grant(candidate, { claimId: owner.claimId, workerId, machine: f.options.machine, platform: "linux", agent: "codex", worktreeId: owner.worktreeId });
  f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
  f.candidates.splice(0);
  expect(f.store.listTasks()).toEqual([]);
  try {
    await f.coordinator.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    await eventually(() => expect(f.store.getTask(owner)?.sessionId).not.toBeNull());
    expect(f.store.getTask(owner)).toMatchObject({ projectId: owner.projectId, taskId: owner.taskId, claimId: owner.claimId, status: "active", agent: "codex" });
    expect(f.remote.claim).not.toHaveBeenCalled();
    expect(f.tasks.start.mock.calls[0]![2]).toMatchObject({ configuration });
    expect(f.tasks.start.mock.calls[0]![2]).not.toHaveProperty("resumeSessionId");
    expect(f.remote.ownInventory).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ projectId: f.project.projectId }), expect.objectContaining({ projectId: second.projectId })]), workerId, expect.anything(), expect.any(Function), expect.any(Function));
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
  } finally { await f.coordinator.shutdown(); }
}, 15_000);
