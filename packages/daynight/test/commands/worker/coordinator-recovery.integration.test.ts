import { mkdirSync } from "node:fs";
import { scanFromList } from "../../helpers/worker-git-scan.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { TimerOptions } from "node:timers";
import { afterEach, expect, it, vi } from "vitest";
import { readWorkerClaim } from "../../../src/api/task-properties.js";
import type { Task, WorkerClaimDescriptor } from "../../../src/api/types.js";
import type { Operation } from "../../../src/api/operation.js";
import { createWorkerCoordinator as createCoordinator } from "../../../src/commands/worker/coordinator.js";
import { HerdrAgentActionError } from "../../../src/commands/worker/herdr.js";
import { LegacyBindingUnavailableError } from "../../../src/commands/worker/herdr/agents.js";
import type { CleanupTarget, StopObservation } from "../../../src/commands/worker/execution-stop.js";
import type { WorkerEvent, WorkerGitManager } from "../../../src/commands/worker/execution.js";
import type { HerdrAgentObservation, HerdrAgentStartInput, HerdrExecutionContext, HerdrOwnedWorkspace, HerdrPromptGuard, HerdrPromptResult, HerdrTaskBinding, WorkerHerdrAdapter } from "../../../src/commands/worker/herdr.js";
import type { ManagedAssignment } from "../../../src/commands/worker/prompts.js";
import type { WorkerRemote } from "../../../src/commands/worker/remote.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import type { LocalTask as WebTask } from "../../../src/commands/worker/backends/web-types.js";
import { createMonitoringObserver } from "../../../src/commands/worker/monitoring/observer.js";
import type { CleanupRequest } from "../../../src/commands/worker/execution-stop.js";
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
const coordinators: ReturnType<typeof createCoordinator>[] = [];
const createWorkerCoordinator = (options: Parameters<typeof createCoordinator>[0]): ReturnType<typeof createCoordinator> => {
  const coordinator = createCoordinator(options);
  const shutdown = coordinator.shutdown.bind(coordinator);
  let closing: ReturnType<typeof shutdown> | undefined;
  coordinator.shutdown = () => closing ??= shutdown();
  coordinators.push(coordinator);
  return coordinator;
};
const directories: string[] = [];
const stores: ReturnType<typeof openWorkerStore>[] = [];
afterEach(async () => {
  const shutdowns = await Promise.allSettled(coordinators.splice(0).map(coordinator => coordinator.shutdown()));
  const shutdownErrors = shutdowns.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  polling.onSchedule = undefined; polling.requested.length = 0;
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (shutdownErrors.length > 0) throw new AggregateError(shutdownErrors, "Coordinator fixture shutdown failed.");
});
const task = (projectId: string, id: string): Task => ({ type: "task", parentId: null, id, projectId, title: id, description: "task", tags: [], status: "todo", allowAgents: true, assignedTo: null, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null, version: 1n, properties: { pullRequests: [] }, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true });
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 3500, interval: 10 });

const fixture = async (maxConcurrent = 1, registerProject = true) => {
  const base = path.resolve("../../.tmp/minimal-coordinator-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "r-")); directories.push(root);
  let store = openWorkerStore(path.join(root, "state.sqlite")); stores.push(store);
  const project: WorkerProject = { projectId: uuid(10), repoUrl: "https://example.test/owner/repo.git", localPath: path.join(root, "repo") }; if (registerProject) store.registerProject(project);
  const candidates = [task(project.projectId, uuid(100)), task(project.projectId, uuid(101))];
  const grants = new Map<string, Task>();
  const worktrees = new Map<string, { owner: ResourceOwner; binding: WorktreeBinding }>();
  const manifests = new Map<string, { owner: ResourceOwner; binding: WorktreeBinding }>();
  const resources = new Map<string, HerdrOwnedWorkspace>();
  const events: WorkerEvent[] = []; const order: string[] = []; let clock = 1000; let sequence = 0;
  let blockedStartupInput = false;
  const bind = (owner: ResourceOwner): WorktreeBinding => {
    const source = store.getProject(owner)!;
    mkdirSync(source.localPath, { recursive: true });
    return { repositoryPath: source.localPath, commonDirectory: path.join(source.localPath, ".git"), worktreePath: path.join(source.localPath, ".worktrees", "daynight", owner.worktreeId), branch: `daynight/${owner.taskId}` };
  };
  const observe = (context: ResourceOwner, binding: HerdrTaskBinding): HerdrAgentObservation => ({ ...resources.get(context.claimId)!.panes[0]!, name: "managed", binding });
  const git = {
    prepareRepository: vi.fn(), dispose: vi.fn(), removeEmptyReservation: vi.fn(async () => {}),
    prepareWorktree: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => { expect(store.getTask(owner)?.status).toBe("active"); order.push("prepare-worktree"); const binding = bind(owner); await mkdir(binding.worktreePath, { recursive: true }); worktrees.set(owner.claimId, { owner, binding }); manifests.set(owner.claimId, { owner, binding }); return binding; }),
    verifyWorktree: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => { const found = worktrees.get(owner.claimId); if (found === undefined) throw new Error("Original worktree missing"); return found.binding; }),
    resolveWorktreeBinding: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => (worktrees.get(owner.claimId) ?? manifests.get(owner.claimId))?.binding ?? null),
    listWorktreeManifests: vi.fn(async (source: WorkerProject, _operation: Operation, includeOtherProjects = false) => [...new Map([...manifests, ...worktrees]).values()].filter(({ owner }) => owner.projectId === source.projectId || includeOtherProjects && store.getProject(owner)?.localPath === source.localPath)),
    retireWorktreeManifest: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => { manifests.delete(owner.claimId); }),
    removeUnpublishedReservation: vi.fn(async () => {}),
    findWorktree: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => worktrees.get(owner.claimId)?.binding ?? null),
    scanWorktrees: scanFromList, listWorktrees: vi.fn(async (source: WorkerProject) => [...worktrees.values()].filter(({ owner }) => owner.projectId === source.projectId)),
    removeWorktree: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => { expect(resources.has(owner.claimId)).toBe(false); order.push("remove-worktree"); worktrees.delete(owner.claimId); return { kind: "absent" as const, effectErrors: [] }; }),
  } as unknown as WorkerGitManager;
  const tasks = {
    observeExecutionStop: vi.fn(async (target: CleanupTarget): Promise<StopObservation> => ({ kind: "unknown", target, error: new LegacyBindingUnavailableError("No original legacy Herdr binding exists in this Worker run."), observedAt: clock })),
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
  const restore = vi.fn(async (_context: Omit<HerdrExecutionContext, "cwd">, _operation: Operation) => { running = true; return { reconnected: false, version: "0.9.5", protocol: 22 as const, snapshot: {} }; });
  f.herdr.ensureExecution = restore;
  vi.mocked(f.remote.readTask).mockResolvedValue({ ...remoteTask, allowAgents: allowed, properties: { ...remoteTask.properties, paused } });
  try {
    if (paused || !allowed) {
      await expect(f.coordinator.tick()).rejects.toBe(unavailable);
      expect(restore).not.toHaveBeenCalled(); expect(f.tasks.start).not.toHaveBeenCalled();
    } else {
      await f.coordinator.tick();
      await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
      expect(restore).toHaveBeenCalledWith({ ...owner, agent: "codex" }, expect.anything());
      expect(f.tasks.start.mock.calls[0]![0].cwd).toBe(f.bind(owner).worktreePath);
      expect(f.store.getNativeConfiguration(local)?.herdrLaunch).toEqual(tools.herdr);
    }
    expect(f.remote.claim).not.toHaveBeenCalled(); expect(f.store.getTask(local)?.claimId).toBe(owner.claimId);
  } finally { running = true; await f.coordinator.shutdown(); }
});

it.each([true, false])("restores selected frozen infrastructure before repository readiness without admitting native work (selected=%s)", async selected => {
  const f = await fixture(), candidate = f.candidates[0]!;
  const owner = { projectId: f.project.projectId, taskId: candidate.id, claimId: uuid(975), worktreeId: uuid(976) };
  f.grant(candidate, { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex" });
  const local = f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex" })), tools = recordedHerdrTools();
  const frozen = { ...configuration, toolLaunch: tools.agent, herdrLaunch: tools.herdr };
  f.store.freezeNativeConfiguration(local, frozen); f.store.setSessionId(local, uuid(977));
  f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) }); f.candidates.splice(0);
  let running = false;
  const unavailable = new Error("Original shared daemon has exited.");
  vi.mocked(f.herdr.ensureInstance).mockImplementation(async () => { if (!running) throw unavailable; return { reconnected: true, version: "0.9.5", protocol: 22, snapshot: {} }; });
  const restore = vi.fn(async () => { running = true; return { reconnected: false, version: "0.9.5", protocol: 22 as const, snapshot: {} }; });
  f.herdr.ensureExecution = restore;
  f.coordinator.updateConfiguration({ ...f.options, repositories: [], readyProjectIds: [], targetProjectIds: selected ? [f.project.projectId] : [] });
  try {
    if (!selected) {
      await expect(f.coordinator.tick()).rejects.toBe(unavailable);
      expect(restore).not.toHaveBeenCalled();
    } else {
      await f.coordinator.tick();
      expect(restore).toHaveBeenCalledOnce();
      expect(restore).toHaveBeenCalledWith({ ...owner, agent: "codex" }, expect.anything());
    }
    expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.git.prepareWorktree).not.toHaveBeenCalled(); expect(f.remote.claim).not.toHaveBeenCalled();
    if (selected) {
      f.coordinator.updateConfiguration({ ...f.options, readyProjectIds: [f.project.projectId], targetProjectIds: [f.project.projectId] });
      await f.coordinator.tick();
      await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
      expect(f.tasks.start.mock.calls[0]![2]).toMatchObject({ resumeSessionId: uuid(977), configuration: frozen });
    }
    expect(f.store.getTask(local)?.claimId).toBe(owner.claimId);
  } finally { running = true; await f.coordinator.shutdown(); }
});

it("keeps explicit frozen retry behind an in-progress project stop", async () => {
  const f = await fixture(), candidate = f.candidates[0]!;
  const owner = { projectId: f.project.projectId, taskId: candidate.id, claimId: uuid(970), worktreeId: uuid(971) };
  f.grant(candidate, { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex" });
  const local = f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex" })), tools = recordedHerdrTools();
  const frozen = { ...configuration, toolLaunch: tools.agent, herdrLaunch: tools.herdr };
  f.store.freezeNativeConfiguration(local, frozen);
  const originalConfiguration = f.store.getNativeConfiguration(local);
  f.store.setSessionId(local, uuid(972));
  f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(f.herdr.ensureInstance).mockImplementation(async () => { await held; return { reconnected: true, version: "0.9.5", protocol: 22, snapshot: {} }; });
  const restore = vi.fn(async () => ({ reconnected: false, version: "0.9.5", protocol: 22 as const, snapshot: {} }));
  f.herdr.ensureExecution = restore;
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [], globalConfiguration: frozen });
  const stopping = coordinator.stopProject(f.project.projectId);
  try {
    await eventually(() => expect(f.herdr.ensureInstance).toHaveBeenCalledOnce());
    await coordinator.advanceRetry(owner);
    expect(restore).not.toHaveBeenCalled(); expect(f.tasks.start).not.toHaveBeenCalled();
    expect(f.store.getTask(owner)).toMatchObject({ status: "active", claimId: owner.claimId, sessionId: uuid(972) });
    expect(f.store.getNativeConfiguration(owner)).toEqual(originalConfiguration);
  } finally { release(); await stopping; await coordinator.shutdown(); }
});

const webOutageFixture = async (platform: "linux" | "windows" = "linux", failure: "ensure" | "list" = "ensure", evidence: "complete" | "missing" | "no-worktree" | "no-execution" = "complete") => {
  const f = await fixture(2), [herdrCandidate, webCandidate] = f.candidates;
  const herdrOwner = { projectId: f.project.projectId, taskId: herdrCandidate!.id, claimId: uuid(960), worktreeId: uuid(961) };
  const herdrRemote = f.grant(herdrCandidate!, { claimId: herdrOwner.claimId, worktreeId: herdrOwner.worktreeId, workerId, machine: f.options.machine, platform, agent: "codex" });
  f.grants.set(herdrOwner.claimId, { ...herdrRemote, properties: { ...herdrRemote.properties, paused: true } });
  const herdrLocal = f.store.activateTask(f.store.registerPending({ ...herdrOwner, agent: "codex" }));
  const tools = recordedHerdrTools();
  f.store.freezeNativeConfiguration(herdrLocal, { ...configuration, toolLaunch: tools.agent, herdrLaunch: tools.herdr });
  f.worktrees.set(herdrOwner.claimId, { owner: herdrOwner, binding: f.bind(herdrOwner) });
  const webConfiguration = { ...configuration, args: [], agentControlMode: "web" as const };
  const webOwner = { projectId: f.project.projectId, taskId: webCandidate!.id, claimId: uuid(962), worktreeId: uuid(963) };
  f.grant(webCandidate!, { claimId: webOwner.claimId, worktreeId: webOwner.worktreeId, workerId, machine: f.options.machine, platform, agent: "codex", agentControlMode: "web" });
  f.store.activateTask(f.store.registerPending({ ...webOwner, agent: "codex", agentControlMode: "web", sessionId: evidence === "missing" ? null : uuid(964) }));
  f.worktrees.set(webOwner.claimId, { owner: webOwner, binding: f.bind(webOwner) });
  const filename = path.join(f.root, "web.sqlite");
  let webStore = openWebExecutionStore(filename);
  let record: WebTask | null = evidence === "missing" ? null : webStore.register({ ...webOwner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: webConfiguration }, 1);
  if (record !== null && evidence !== "no-worktree") record = webStore.bindWorktree(record, f.bind(webOwner), 2);
  if (record !== null && evidence !== "no-execution") record = webStore.initializeWebExecution(record, 3);
  if (record?.webExecution != null) record = webStore.updateWebExecution(record, { sessionId: uuid(964), initialInputState: "confirmed", launchSubmission: "acknowledged", activity: "waiting_input" }, 4);
  if (record?.webExecution != null) record = webStore.bindNativeSession(record, { source: "controller", sessionId: uuid(964) }, 5);
  const original = record?.webExecution;
  webStore.close(); webStore = openWebExecutionStore(filename); f.reopenStore();
  const pendingOwner = { projectId: f.project.projectId, taskId: uuid(965), claimId: uuid(966), worktreeId: uuid(967) };
  f.grant(task(f.project.projectId, pendingOwner.taskId), { claimId: pendingOwner.claimId, worktreeId: pendingOwner.worktreeId, workerId, machine: f.options.machine, platform, agent: "codex", agentControlMode: "web" });
  f.store.registerPending({ ...pendingOwner, agent: "codex", agentControlMode: "web" });
  const unavailable = new Error(`Original Herdr ${failure} is unavailable.`);
  let available = false;
  vi.mocked(f.herdr.ensureInstance).mockImplementation(async () => { if (!available && failure === "ensure") throw unavailable; return { reconnected: true, version: "0.9.5", protocol: 22, snapshot: {} }; });
  vi.mocked(f.tasks.listResources).mockImplementation(async () => { if (!available && failure === "list") throw unavailable; return []; });
  const restore = vi.fn(); f.herdr.ensureExecution = restore;
  const monitor = createMonitoringObserver({ now: f.options.now });
  const controller = new AbortController();
  const promptDemand = vi.fn();
  const advance = vi.fn(async (input: WebTask) => webStore.updateWebExecution(input, { activity: "working" }, 6));
  const cleanup = vi.fn(async (input: WebTask, _request: CleanupRequest) => ({ complete: true, task: input }));
  const coordinator = createWorkerCoordinator({ ...f.options, platform, signal: controller.signal, onPromptDemand: promptDemand, repositories: [{ project: f.project, configuration: webConfiguration }], globalConfiguration: webConfiguration, webStore, webBackend: { advance, cleanup, observeExecutionStop: async (target) => ({ kind: "unknown", target, observedAt: 1000, error: unavailable }) }, monitoring: monitor, verifyWebServer: async () => {} });
  return { f, herdrOwner, webOwner, pendingOwner, tools, webStore, original, monitor, controller, promptDemand, advance, cleanup, coordinator, unavailable, restore, recover: () => { available = true; } };
};

it.each([
  { platform: "linux", failure: "ensure" }, { platform: "linux", failure: "list" },
  { platform: "windows", failure: "ensure" }, { platform: "windows", failure: "list" },
] as const)("advances the original Web execution while retained Herdr observation fails (%j)", async ({ platform, failure }) => {
  const { f, herdrOwner, webOwner, pendingOwner, tools, webStore, original, monitor, advance, coordinator, unavailable, restore, recover } = await webOutageFixture(platform, failure);
  try {
    await expect(coordinator.tick()).rejects.toBe(unavailable);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.events.filter(event => event.kind === "execution-error")).toEqual([]);
    await eventually(() => expect(webStore.getTask(webOwner)?.webExecution?.activity).toBe("working"));
    await eventually(() => expect(f.store.getTask(webOwner)?.sessionId).toBe(uuid(964)));
    expect(webStore.getTask(webOwner)?.webExecution).toMatchObject({ executionId: original!.executionId, executionGeneration: original!.executionGeneration, controllerInstanceId: original!.controllerInstanceId, sessionId: original!.sessionId, launchId: original!.launchId });
    expect(f.store.getTask(webOwner)?.claimId).toBe(webOwner.claimId);
    expect(f.store.getNativeConfiguration(herdrOwner)?.herdrLaunch).toEqual(tools.herdr);
    expect(restore).not.toHaveBeenCalled(); expect(f.tasks.start).not.toHaveBeenCalled();
    expect(f.remote.claim).not.toHaveBeenCalled(); expect(f.store.getTask(pendingOwner)?.status).toBe("pending");
    expect(monitor.capture("outage").admission.coverage).toBe("unknown");
    expect(monitor.capture("outage").capacity?.quality).not.toBe("current");
    expect(monitor.capture("outage").currentFailures).toContainEqual(expect.objectContaining({ component: "resources", phase: "resource-observation" }));
    recover();
    await coordinator.tick();
    await eventually(() => expect(advance).toHaveBeenCalledTimes(2));
    expect(monitor.capture("recovered").capacity).toMatchObject({ quality: "current", occupied: 2, available: 0 });
    expect(monitor.capture("recovered").currentFailures.filter(item => item.component === "resources")).toEqual([]);
    expect(f.store.getTask(pendingOwner)?.status).toBe("pending");
  } finally { recover(); await coordinator.shutdown(); webStore.close(); }
});

it.each(["missing", "no-worktree", "no-execution", "paused", "revoked", "cancelled", "old-claim"] as const)("retains Web execution behind its original evidence and permission gates during a Herdr outage: %s", async gate => {
  const { f, webOwner, pendingOwner, webStore, advance, coordinator, unavailable, recover } = await webOutageFixture("linux", "ensure", gate === "missing" || gate === "no-worktree" || gate === "no-execution" ? gate : "complete");
  if (gate === "paused" || gate === "revoked" || gate === "cancelled") {
    const remote = f.grants.get(webOwner.claimId)!;
    f.grants.set(webOwner.claimId, { ...remote, status: gate === "cancelled" ? "cancelled" : remote.status, allowAgents: gate !== "revoked", properties: { ...remote.properties, paused: gate === "paused" } });
  }
  if (gate === "old-claim") Object.assign(f.herdr, { lifecycle: { responsibilities: () => [{ ...webOwner, claimId: uuid(968), worktreeId: uuid(969) }], isStopped: () => true, stop: async () => {} } });
  try {
    await expect(coordinator.tick()).rejects.toBe(unavailable);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(advance).not.toHaveBeenCalled();
    expect(f.remote.claim).not.toHaveBeenCalled();
    expect(f.store.getTask(pendingOwner)?.status).toBe("pending");
  } finally { recover(); await coordinator.shutdown(); webStore.close(); }
});

it.each(["ensure", "list"] as const)("does not schedule independent Web work after cancellation races a Herdr %s failure", async failure => {
  const { f, webStore, controller, promptDemand, advance, coordinator, recover } = await webOutageFixture("linux", failure);
  const cancelled = new Error("Cancelled during Herdr connection.");
  const original = new Error("The original Herdr observation also failed.");
  let demandsBeforeAbort = 0;
  const fail = async () => { demandsBeforeAbort = promptDemand.mock.calls.length; controller.abort(cancelled); throw original; };
  if (failure === "ensure") vi.mocked(f.herdr.ensureInstance).mockImplementation(fail);
  else vi.mocked(f.tasks.listResources).mockImplementation(fail);
  try {
    await expect(coordinator.tick()).rejects.toBe(original);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(advance).not.toHaveBeenCalled();
    expect(promptDemand).toHaveBeenCalledTimes(demandsBeforeAbort + 1);
    expect(f.remote.claim).not.toHaveBeenCalled();
  } finally { recover(); await coordinator.shutdown(); webStore.close(); }
});

it.each(["retry", "cleanup", "complete"] as const)("routes original Web %s without accessing a retained Herdr backend", async action => {
  const { f, webOwner, webStore, original, advance, cleanup, coordinator, recover } = await webOutageFixture();
  cleanup.mockImplementation(async (input, request) => {
    if (request.kind !== "terminal") return { complete: true, task: input };
    const cleaning = webStore.beginCleanup(input, { kind: "terminal", deadline: request.deadline }, f.options.now());
    request.scope.onExecutionStopped({ attempt: request.scope.attempt, observation: { kind: "stopped", execution: { owner: webOwner, backend: "web", runKey: original!.executionId }, observedAt: 8 } });
    return { complete: true, task: webStore.completeTask(cleaning, 9) };
  });
  try {
    if (action === "retry") {
      await expect(coordinator.advanceRetry(webOwner)).resolves.toBeUndefined();
      expect(webStore.getTask(webOwner)?.webExecution).toMatchObject({ activity: "working", sessionId: original!.sessionId, executionGeneration: original!.executionGeneration });
      expect(advance).toHaveBeenCalledOnce();
    } else {
      if (action === "cleanup") await expect(coordinator.cleanupSource(webOwner, { deleteWorktree: true })).resolves.toEqual(webOwner);
      else await expect(coordinator.completeSource(webOwner)).resolves.toBeUndefined();
      expect(webStore.getTask(webOwner)?.status).toBe("done");
      expect(f.store.getTask(webOwner)?.status).toBe("done");
      expect(f.store.getCleanupSchedule(webOwner)).toBeNull();
    }
    expect(f.herdr.ensureInstance).not.toHaveBeenCalled();
    expect(f.tasks.listResources).not.toHaveBeenCalled();
    expect(f.remote.claim).not.toHaveBeenCalled();
  } finally { recover(); await coordinator.shutdown(); webStore.close(); }
});

it.each(["cleanup", "complete"] as const)("retains the original Web reservation without execution stop proof during %s", async action => {
  const { f, webOwner, webStore, cleanup, coordinator, recover } = await webOutageFixture();
  cleanup.mockImplementation(async (input, request) => {
    if (request.kind !== "terminal") return { complete: true, task: input };
    const cleaning = webStore.beginCleanup(input, { kind: "terminal", deadline: request.deadline }, f.options.now());
    return { complete: true, task: webStore.completeTask(cleaning, 1001) };
  });
  try {
    const operation = action === "cleanup" ? coordinator.cleanupSource(webOwner, { deleteWorktree: true }) : coordinator.completeSource(webOwner);
    await expect(operation).rejects.toThrow("The original execution stop remains unknown; its reservation is retained.");
    expect(f.store.getTask(webOwner)?.status).toBe("active");
    expect(f.store.getCleanupSchedule(webOwner)).not.toBeNull();
    expect(f.herdr.ensureInstance).not.toHaveBeenCalled();
  } finally { recover(); await coordinator.shutdown(); webStore.close(); }
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
  await mkdir(f.bind(owner).worktreePath, { recursive: true });
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
