import Database from "better-sqlite3";
import { reconcileDeletedHerdrResource } from "../../../src/commands/worker/resource-disposal.js";
import * as lifecycle from "../../../src/commands/controller/lifecycle-store.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import { writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { LocalTask as WebTask } from "../../../src/commands/worker/backends/web-types.js";
import type { WebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import type { requestController } from "../../../src/commands/controller/local-client.js";
import { readWorkerClaim } from "../../../src/api/task-properties.js";
import { access, mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TimerOptions } from "node:timers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationError } from "../../../src/api/operation.js";
import { isWorkerCancellation } from "../../../src/commands/worker/execution.js";
import { createCleanupDriver } from "../../../src/commands/worker/cleanup.js";
import { HerdrAgentActionError, HerdrRpcError } from "../../../src/commands/worker/herdr.js";
import { HerdrInputBlockedError } from "../../../src/commands/worker/herdr/agents.js";
import { createWorkerCoordinator } from "../../../src/commands/worker/coordinator.js";
import { WorktreePreconditionError } from "../../../src/commands/worker/worktrees.js";
import { submitWorkerControl } from "../../../src/commands/worker/control.js";
import { createWorkerReporter } from "../../../src/commands/worker/reporter.js";
import type { WorkerTelemetrySample } from "../../../src/commands/worker/telemetry.js";
import type { Operation } from "../../../src/api/operation.js";
import { workerTelemetry } from "../../fixtures/worker-telemetry.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { WorkerEvent, WorkerGitManager } from "../../../src/commands/worker/execution.js";
import type { HerdrAgentObservation, HerdrAgentStartInput, HerdrExecutionContext, HerdrOwnedWorkspace, HerdrPromptGuard, HerdrPromptResult, HerdrTaskBinding, WorkerHerdrAdapter } from "../../../src/commands/worker/herdr.js";
import type { ManagedAssignment } from "../../../src/commands/worker/prompts.js";
import type { WorkerRemote } from "../../../src/commands/worker/remote.js";
import type { Task, WorkerClaimDescriptor } from "../../../src/api/types.js";
import type { ExecutionConfiguration, ResourceOwner, WorkerProject, WorktreeBinding } from "../../../src/commands/worker/types.js";
import { createOperation } from "../../../src/api/operation.js";
import { createHerdrRecordingArchive } from "../../../src/commands/worker/herdr/recording-archive.js";
import { createHerdrRecordingResources } from "../../../src/commands/worker/herdr/recording-resources.js";
import type { HerdrArchiveApi } from "../../../src/commands/worker/herdr/archive-api.js";
import type { HerdrLifecycleRecord } from "../../../src/commands/worker/herdr/lifecycle-types.js";
import type { HerdrSessionState } from "../../../src/commands/worker/herdr/session-api.js";
import type { SessionV2Message } from "../../../src/session/v2/types.js";
import { parseSessionV2Archive } from "../../../src/session/v2/archive.js";
import archiveFixture from "../../session/fixtures/v2/valid-archive.json" with { type: "json" };

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
const task = (projectId: string, id: string): Task => ({ id, projectId, title: id, description: "task", status: "todo", allowAgents: true, assignedTo: null, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null, version: 1n, properties: { pullRequests: [] }, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true });
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
  const options = { store, git, herdr, remote, serverOrigin: origin, workerId, platform: "linux" as const, machine: { id: uuid(3), name: "fixture" }, repositories: [{ project, configuration }], globalConfiguration: configuration, maxConcurrent, buildPrompt: vi.fn((_assignment: ManagedAssignment) => "worker-managed using-daynight autopilot-managed-task"), emit: (event: WorkerEvent) => events.push(event), now: () => clock };
  const reopenStore = () => {
    stores.splice(stores.indexOf(store), 1); store.close();
    store = openWorkerStore(path.join(root, "state.sqlite")); stores.push(store); options.store = store;
    return store;
  };
  return { root, get store() { return store; }, reopenStore, project, candidates, grants, grant, resources, worktrees, git, herdr, tasks, remote, order, events, options, coordinator: createWorkerCoordinator(options), clock: (value: number) => { clock = value; }, bind, blockStartupInput: () => { blockedStartupInput = true; } };
};

const deletedArchive = async (f: Awaited<ReturnType<typeof fixture>>, explicit = false) => {
  const doc = parseSessionV2Archive(structuredClone(archiveFixture));
  doc.owner.projectId = f.project.projectId; doc.owner.workerId = workerId;
  for (const run of doc.runs) run.owner = doc.owner;
  const owner = { projectId: doc.owner.projectId, taskId: doc.owner.taskId, claimId: doc.claimId, worktreeId: doc.owner.worktreeId };
  const cwd = f.bind(owner).worktreePath, directory = path.join(f.root, "recordings"), sourcePath = path.join(directory, doc.sessionId);
  await mkdir(sourcePath, { recursive: true }); await mkdir(cwd, { recursive: true });
  await writeFile(path.join(sourcePath, "manifest.json"), JSON.stringify({ schemaVersion: 1, owner: doc.owner, sessionId: doc.sessionId, claimId: doc.claimId }));
  const record = { owner: doc.owner, sessionId: doc.sessionId, claimId: doc.claimId, cwd, preparation: null,
    runs: doc.runs.map(run => ({ run, phase: "stopped_confirmed", stopReason: explicit ? "shutdown" : "terminal" })), segments: doc.segments.map(segment => ({ ...segment, gap: null })) } as HerdrLifecycleRecord;
  const source = { schemaVersion: 1 as const, owner: doc.owner, sessionId: doc.sessionId, claimId: doc.claimId, runs: doc.runs.map((run, i) => ({ executionGeneration: run.executionGeneration, responsibilityId: uuid(1090 + i), recordingEnabled: true, selectedFrameCount: "0", registeredFrameCount: "0", captureError: null, closed: true })), segments: doc.segments, files: [], index: [], gaps: [], journalSha256: "b".repeat(64) };
  const envelope = { protocol: "daynight.session.v2" as const, schemaVersion: 2 as const, projectionVersion: 1 as const, sessionId: doc.sessionId, claimId: doc.claimId, executionGeneration: doc.executionGeneration, agentControlMode: "herdr" as const, contentKind: "terminal_recording" as const };
  const remote: HerdrSessionState = { status: "registered", ...envelope, owner: doc.owner, binding: doc.runs.at(-1)!.binding, connectionEpoch: "1", connected: false, capabilities: { observe: true, control: true, archive: true }, control: null, snapshot: null, ledger: { runs: doc.runs, finalizationId: null }, archive: { state: "pending", sha256: null, byteLength: null, completeness: null, errorCode: null, finalizationId: null }, recording: source.runs.map(run => ({ executionGeneration: run.executionGeneration, responsibility: { responsibilityId: run.responsibilityId, recordingEnabled: true }, evidence: null })) };
  let receipt: Extract<SessionV2Message, { type: "receipt" }> | null = null;
  const api: HerdrArchiveApi = {
    state: async () => structuredClone(remote),
    recording: async (_expected, message) => { const m = message as SessionV2Message; if (m.type === "recording_evidence") remote.recording.find(run => run.executionGeneration === m.executionGeneration)!.evidence = m.payload; return message; },
    finalize: async (_expected, message) => { remote.ledger.finalizationId = message.payload.finalizationId; return { ...envelope, type: "generation_ledger", payload: remote.ledger }; },
    receipt: async () => { if (!receipt) throw new Error("No receipt"); return receipt; },
    upload: async () => { throw new Error("Zero frames must not upload"); },
    unavailable: async (_expected, message) => { receipt = message; remote.archive = { state: "unavailable", sha256: null, byteLength: null, completeness: null, errorCode: message.payload.reason, finalizationId: message.payload.finalizationId }; return message; },
    failed: async (_expected, message) => message,
  };
  const open = () => {
    const journal = createHerdrRecordingArchive({ directory: path.join(f.root, "archives"), api });
    const archive = createHerdrRecordingResources({ directory, archive: journal, list: () => [record], get: () => record, source: () => source, publishStopped: async () => {}, currentUserId: async () => doc.owner.ownerUserId, readTask: async () => ({ ...task(owner.projectId, owner.taskId), status: "done" }) });
    return archive;
  };
  f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex" }));
  f.store.saveCleanupSchedule(owner, { deadline: 10000, failures: 0, nextAttemptAt: 0, stage: "worktree-removal", lastError: null });
  const archive = open(), operation = createOperation();
  try {
    if (explicit) await archive.dispose({ ...owner, sessionId: doc.sessionId, operationId: uuid(1099), action: "delete", confirmed: true }, operation, () => rm(cwd, { recursive: true }));
    else { expect(await archive.advance(owner, operation)).toBe(true); await rm(cwd, { recursive: true }); archive.cleaned(owner); }
  } finally { operation.dispose(); }
  const attach = () => {
    const archive = open();
    Object.assign(f.herdr, { lifecycle: { archive, registerClaim: () => {}, assertCanAdvance: () => {}, responsibilities: () => archive.resources().filter(resource => !resource.worktreeDeleted).map(resource => resource.owner), isStopped: (target: ResourceOwner) => target.claimId === owner.claimId, stop: async () => {} } });
    return archive;
  };
  return { owner, record, attach };
};

const stoppedWebExecution = async (f: Awaited<ReturnType<typeof fixture>>, store: WebExecutionStore, task: WebTask) => {
  const execution = task.webExecution!;
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: execution.launchId, executionId: execution.executionId, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId, sessionId: execution.sessionId!, executionGeneration: execution.executionGeneration, serverOrigin: task.serverOrigin, projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId, userId: task.userId!, provider: task.configuration!.agent, cwd: f.project.localPath, nativeHome: path.join(f.root, "native"), configuration: task.configuration!, initialOperationId: execution.initialOperationId, initialPrompt: "managed", resumeNativeSessionId: null, credentialFile: path.join(f.root, "grant.json"), ipcEndpoint: path.join(f.root, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  task = store.updateWebExecution(task, { ticketPath: await writeLaunchTicket(f.root, ticket) }, 6);
  const snapshot: lifecycle.ControllerSnapshot = { executionId: execution.executionId, claimId: task.claimId, sessionId: execution.sessionId!, executionGeneration: execution.executionGeneration, controllerInstanceId: execution.controllerInstanceId, lifecycle: "stopped", nativeSessionId: null, initialInputState: "confirmed", activity: "stopped", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, controllerProcess: { pid: 123, parentPid: 1, processGroupId: 123, startedAt: "birth", commandHash: "a".repeat(64) }, nativeProcesses: [], nativeStopped: true, stoppedAt: new Date().toISOString(), error: null };
  vi.spyOn(lifecycle, "readControllerSnapshot").mockReturnValue(snapshot);
  vi.spyOn(lifecycle, "recordStoppedControllerGeneration").mockResolvedValue(snapshot);
  vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  return { task, request: vi.fn<typeof requestController>().mockRejectedValue(new Error("Original controller is stopped.")) };
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
  it.each([false, true])("reconciles persisted deletion after restart and releases one slot (explicit=%s)", async explicit => {
    const f = await fixture(), saved = await deletedArchive(f, explicit);
    expect(saved.attach().resources()[0]!.worktreeDeleted).toBe(true);
    if (explicit) f.store.deleteCleanupSchedule(saved.owner);
    f.reopenStore(); saved.attach();
    const coordinator = createWorkerCoordinator(f.options);
    await coordinator.tick();
    expect(f.store.getCleanupSchedule(saved.owner)).toBeNull();
    expect(f.store.getTask(saved.owner)?.status).toBe("done");
    await eventually(() => expect(f.grants.size).toBe(1));
    expect(f.tasks.stopAndClose).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
    await coordinator.shutdown();
  });

  it("retries persisted deletion after a SQLite failure without completing another claim", async () => {
    const f = await fixture(), saved = await deletedArchive(f, true); f.options.repositories = [];
    const newer = { ...saved.owner, claimId: uuid(1100) };
    f.store.registerPending({ ...newer, agent: "codex" });
    saved.attach();
    const database = new Database(path.join(f.root, "state.sqlite"));
    try { database.exec("CREATE TRIGGER reject_cleanup_delete BEFORE DELETE ON cleanup_schedules BEGIN SELECT RAISE(ABORT, 'SQLite cleanup write unavailable'); END"); }
    finally { database.close(); }
    await createWorkerCoordinator(f.options).tick();
    expect(f.store.getCleanupSchedule(saved.owner)).not.toBeNull();
    expect(f.store.getTask(newer)?.status).toBe("pending");
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-error", error: expect.objectContaining({ message: "SQLite cleanup write unavailable" }) }));
    const recoveredDatabase = new Database(path.join(f.root, "state.sqlite"));
    try { recoveredDatabase.exec("DROP TRIGGER reject_cleanup_delete"); } finally { recoveredDatabase.close(); }
    f.reopenStore(); saved.attach();
    await createWorkerCoordinator(f.options).tick();
    expect(f.store.getCleanupSchedule(saved.owner)).toBeNull();
    expect(f.store.getTask(saved.owner)?.status).toBe("done");
    expect(f.store.getTask(newer)?.status).toBe("pending");
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
  });

  it.each(["worktree", "stop"])("keeps deleted-resource cleanup blocked by conflicting %s evidence", async conflict => {
    const f = await fixture(), saved = await deletedArchive(f, true); f.options.repositories = [];
    if (conflict === "worktree") {
      f.store.deleteCleanupSchedule(saved.owner);
      f.store.saveCleanupSchedule({ ...saved.owner, worktreeId: uuid(1101) }, { deadline: 10000, failures: 0, nextAttemptAt: 0, stage: "worktree-removal", lastError: null });
    } else saved.record.runs[0]!.run.stopProof = null;
    f.reopenStore(); saved.attach();
    await createWorkerCoordinator(f.options).tick();
    expect(f.store.getCleanupSchedule(saved.owner)).not.toBeNull();
    expect(f.store.getTask(saved.owner)?.status).toBe("active");
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
  });

  it.each(["waiting cleanup", "direct shutdown"])("persists a rowless orphan through %s and a SQLite restart before starting its successor", async (mode) => {
    const f = await fixture(2); f.candidates.splice(1);
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
});

describe("terminal cleanup retry scheduling", () => {
  it("restores failed cleanup and its retry time without starting a native session", async () => {
    const f = await fixture(); await f.coordinator.tick();
    await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const owner = [...f.worktrees.values()][0]!.owner;
    f.grants.clear(); f.resources.clear(); f.candidates.splice(0);
    vi.mocked(f.git.removeWorktree).mockRejectedValue(new Error("EACCES fixture"));
    await f.coordinator.tick();
    await eventually(() => expect(f.events.some(e => e.kind === "cleanup-error")).toBe(true));
    await f.coordinator.shutdown(); f.reopenStore();
    const restarted = createWorkerCoordinator(f.options);
    const calls = vi.mocked(f.git.removeWorktree).mock.calls.length;
    f.clock(1999); await restarted.tick();
    expect(f.git.removeWorktree).toHaveBeenCalledTimes(calls);
    vi.mocked(f.git.removeWorktree).mockImplementation(async () => { f.worktrees.delete(owner.claimId); });
    f.clock(2000); await restarted.tick();
    await eventually(() => expect(f.store.getTask(owner)?.status).toBe("done"));
    expect(f.tasks.start).toHaveBeenCalledOnce();
    await restarted.shutdown();
  });

  it.each(["reconciliation", "direct shutdown"])("reopens Herdr to verify completed cleanup responsibility during Web-only %s", async mode => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
    const f = await fixture();
    let daemonRunning = false;
    vi.mocked(f.herdr.ensureInstance).mockImplementation(async () => {
      daemonRunning = true;
      return { reconnected: false, version: "fixture", protocol: 22, snapshot: {} };
    });
    f.tasks.listResources.mockImplementation(async () => {
      if (!daemonRunning) throw new Error("The private Herdr daemon is stopped.");
      return structuredClone([...f.resources.values()]);
    });
    f.candidates.splice(1);
    await f.coordinator.tick();
    await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const owner = [...f.worktrees.values()][0]!.owner;
    f.grants.clear(); f.resources.clear(); f.candidates.splice(0);
    const deleteSchedule = vi.spyOn(f.store, "deleteCleanupSchedule").mockImplementation(() => { throw new Error("Schedule deletion failed after local completion."); });
    await f.coordinator.tick();
    await eventually(() => {
      expect(f.store.getTask(owner)?.status).toBe("done");
      expect(f.events.some(event => event.kind === "cleanup-error")).toBe(true);
    });
    const retained = f.store.getCleanupSchedule(owner);
    expect(retained).toMatchObject({ failures: 1, nextAttemptAt: 2000 });
    expect(f.worktrees.size).toBe(0);
    await expect(f.coordinator.shutdown()).resolves.toBe(true);
    // The runtime stops its private daemon after successful coordinator shutdown.
    daemonRunning = false;
    deleteSchedule.mockRestore();
    f.reopenStore();
    expect(f.store.listUnfinishedTasks()).toEqual([]);
    expect(f.store.getCleanupSchedule(owner)).toEqual(retained);
    f.clock(2000);
    vi.mocked(f.herdr.ensureInstance).mockClear();
    f.tasks.listResources.mockClear();
    vi.mocked(f.git.removeWorktree).mockClear();
    vi.mocked(f.remote.claim).mockClear();
    const releaseObservation = Promise.withResolvers<void>();
    let observationEntered = false, observationCompleted = false;
    f.tasks.listResources.mockImplementation(async () => {
      if (!daemonRunning) throw new Error("The private Herdr daemon is stopped.");
      observationEntered = true;
      await releaseObservation.promise;
      observationCompleted = true;
      return structuredClone([...f.resources.values()]);
    });
    const removeWorktree = vi.mocked(f.git.removeWorktree).getMockImplementation()!;
    vi.mocked(f.git.removeWorktree).mockImplementation(async (...args) => {
      expect(observationCompleted).toBe(true);
      return removeWorktree(...args);
    });
    const webStore = openWebExecutionStore(path.join(f.root, "web.sqlite"));
    const webConfiguration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 0 };
    const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: () => 2000 });
    const advance = vi.fn(async (input: import("../../../src/commands/worker/backends/web-types.js").LocalTask) => webStore.initializeWebExecution(input, 2000));
    const restarted = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: webConfiguration }], globalConfiguration: webConfiguration, webStore, webBackend: { ...backend, advance }, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
    f.candidates.push(task(f.project.projectId, uuid(103)));
    const operation = mode === "reconciliation" ? restarted.tick() : restarted.shutdown();
    try {
      await eventually(() => expect(observationEntered).toBe(true));
      expect(f.herdr.ensureInstance).toHaveBeenCalled();
      expect(f.store.getCleanupSchedule(owner)).toEqual(retained);
      expect(f.remote.claim).not.toHaveBeenCalled();
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
      releaseObservation.resolve();
      if (mode === "direct shutdown") {
        await expect(operation).resolves.toBe(true);
        expect(f.store.getCleanupSchedule(owner)).toEqual(retained);
        expect(f.git.removeWorktree).not.toHaveBeenCalled();
        expect(f.remote.claim).not.toHaveBeenCalled();
      } else {
        await operation;
        await eventually(() => expect(f.store.getCleanupSchedule(owner)).toBeNull());
        await restarted.tick();
        await eventually(() => expect(advance).toHaveBeenCalled());
        expect(f.remote.claim).toHaveBeenCalledOnce();
        expect(vi.mocked(f.remote.claim).mock.calls[0]![1].agentControlMode).toBe("web");
        expect(f.git.removeWorktree).toHaveBeenCalledOnce();
      }
      expect(f.tasks.start).toHaveBeenCalledOnce();
    } finally {
      releaseObservation.resolve();
      await operation;
      await restarted.shutdown();
      webStore.close();
    }
  });

  it.each([
    { status: "done", retry: "deferred" }, { status: "done", retry: "due" },
    { status: "active", retry: "deferred" }, { status: "active", retry: "due" },
  ] as const)("isolates $status Herdr cleanup from healthy Web work when its retry is $retry", async ({ status, retry }) => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
    const f = await fixture(2);
    const old = { projectId: f.project.projectId, taskId: uuid(810), claimId: uuid(811), worktreeId: uuid(812) };
    f.store.registerPending({ ...old, agent: "codex", agentControlMode: "herdr" });
    if (status === "done") f.store.completeTask(old);
    else f.store.activateTask(old);
    const schedule = f.store.saveCleanupSchedule(old, { deadline: 600_000, failures: 1, nextAttemptAt: retry === "deferred" ? 2000 : 1000, stage: "observation", lastError: "The previous cleanup attempt failed." });
    f.reopenStore();
    expect(f.store.getTask(old)?.status).toBe(status);
    expect(f.store.getCleanupSchedule(old)).toEqual(schedule);
    const unavailable = new Error("The retained Herdr backend cannot initialize.");
    vi.mocked(f.herdr.ensureInstance).mockRejectedValue(unavailable);
    f.tasks.listResources.mockRejectedValue(new Error("The private Herdr daemon is unavailable."));
    const webConfiguration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 0 };
    const healthy = { projectId: f.project.projectId, taskId: uuid(820), claimId: uuid(821), worktreeId: uuid(822) };
    const successor = { ...old, claimId: uuid(813), worktreeId: uuid(814) };
    for (const owner of [healthy, successor]) {
      f.grant(task(owner.projectId, owner.taskId), { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex", agentControlMode: "web" });
      f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
    }
    f.store.activateTask(healthy);
    f.candidates.splice(0, f.candidates.length, task(f.project.projectId, uuid(830)));
    const webStore = openWebExecutionStore(path.join(f.root, "web.sqlite"));
    webStore.register({ ...healthy, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: webConfiguration }, 1);
    const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: () => 1000 });
    const advance = vi.fn(async (input: import("../../../src/commands/worker/backends/web-types.js").LocalTask) => webStore.initializeWebExecution(input, 1000));
    const restarted = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: webConfiguration }], globalConfiguration: webConfiguration, webStore, webBackend: { ...backend, advance }, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
    try {
      for (let tick = 1; tick <= 3; tick++) {
        await expect(restarted.tick()).resolves.toBeUndefined();
        await eventually(() => expect(advance).toHaveBeenCalledTimes(tick));
        expect(advance.mock.calls.at(-1)![0].claimId).toBe(healthy.claimId);
        expect(f.store.getTask(successor)?.status).toBe("pending");
        expect(f.remote.claim).not.toHaveBeenCalled();
      }
      if (retry === "due") {
        await eventually(() => expect(f.store.getCleanupSchedule(old)).toMatchObject({ failures: 2, nextAttemptAt: 3000, lastError: unavailable.message }));
        expect(f.herdr.ensureInstance).toHaveBeenCalledOnce();
        expect(f.events.filter(event => event.kind === "cleanup-error")).toHaveLength(1);
      } else {
        expect(f.store.getCleanupSchedule(old)).toEqual(schedule);
        expect(f.herdr.ensureInstance).not.toHaveBeenCalled();
        expect(f.events.some(event => event.kind === "cleanup-error")).toBe(false);
      }
      expect(f.events.some(event => event.kind === "cleanup-capacity-blocked")).toBe(true);
      expect(f.tasks.listResources).not.toHaveBeenCalled();
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
      expect(f.tasks.start).not.toHaveBeenCalled();
      expect(webStore.getTask(healthy)?.recovery.count).toBe(0);
    } finally { await restarted.shutdown(); webStore.close(); }
  });
});

it.each([
  { state: "unexpired schedule", restartedAt: 1000, existingDeadline: null, expectedDeadline: 600_001 },
  { state: "expired schedule", restartedAt: 600_002, existingDeadline: null, expectedDeadline: 600_002 },
  { state: "initialized Web cleanup", restartedAt: 1000, existingDeadline: 500, expectedDeadline: 500 },
])("restores the original Web cleanup budget from an $state after reopening both stores", async ({ restartedAt, existingDeadline, expectedDeadline }) => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
  const { ensureCleanupSchedule } = await import("../../../src/commands/worker/cleanup-schedule.js");
  const f = await fixture(), webFile = path.join(f.root, "web.sqlite");
  let webStore = openWebExecutionStore(webFile);
  const owner = { projectId: f.project.projectId, taskId: uuid(810), claimId: uuid(811), worktreeId: uuid(812) };
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 0 };
  f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
  webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration }, 1);
  const schedule = ensureCleanupSchedule(f.store, owner, 1);
  if (existingDeadline !== null) webStore.beginCleanup(owner, { kind: "terminal", deadline: existingDeadline }, 2);
  // A crash may follow the schedule commit before the separate Web cleanup commit.
  webStore.close();
  f.reopenStore();
  webStore = openWebExecutionStore(webFile);
  expect(f.store.getCleanupSchedule(owner)).toEqual(schedule);
  expect(webStore.getTask(owner)?.cleanup?.deadline ?? null).toBe(existingDeadline);
  f.clock(restartedAt);
  f.candidates.splice(0);
  const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() };
  const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: () => restartedAt });
  const advance = vi.spyOn(backend, "advance");
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [], globalConfiguration: configuration, webStore, webBackend: backend });
  try {
    await coordinator.tick();
    await eventually(() => {
      expect(f.store.getTask(owner)?.status).toBe("done");
      expect(f.store.getCleanupSchedule(owner)).toBeNull();
    });
    expect(webStore.getTask(owner)).toMatchObject({ status: "done", cleanup: { deadline: expectedDeadline } });
    expect(f.git.removeWorktree).toHaveBeenCalledOnce();
    expect(advance).not.toHaveBeenCalled();
    expect(launcher.launch).not.toHaveBeenCalled();
    expect(f.tasks.start).not.toHaveBeenCalled();
    expect(f.remote.claim).not.toHaveBeenCalled();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

describe("explicit resume with cloud project selection", () => {
  it("keeps an explicitly resumed retained project pending until it is selected and ready", async () => {
    const f = await fixture(2), previousClaim = uuid(700), taskId = uuid(701);
    const released: Task = { ...task(f.project.projectId, taskId), version: 8n, properties: { worker: {
      claimId: previousClaim, worktreeId: uuid(702), userId: uuid(2), workerId, machine: f.options.machine,
      platform: "linux", agent: "codex", agentControlMode: "herdr", state: "released", phase: "preparing",
      herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z",
    } } };
    vi.mocked(f.remote.readTask).mockResolvedValue(released);
    Object.assign(f.remote, {
      authorizeControl: vi.fn(async () => {}),
      resume: vi.fn(async (_projectId: string, _taskId: string, input: WorkerClaimDescriptor & { version: bigint; previousClaimId: string }) => {
        expect(input.previousClaimId).toBe(previousClaim); expect(input.version).toBe(8n);
        const { version: _version, previousClaimId: _previousClaim, ...descriptor } = input;
        return f.grant(released, descriptor);
      }),
    });
    const result = await submitWorkerControl({ ...f.options, signal: new AbortController().signal, coordinator: f.coordinator,
      request: { kind: "resume", projectId: f.project.projectId, taskId, claimId: previousClaim, version: 8n } });
    expect(result.message).toContain("worker run will start");
    expect(result.task).toMatchObject({ projectId: f.project.projectId, taskId, status: "pending" });
    const resumed = result.task!;
    vi.mocked(f.remote.readTask).mockImplementation(async (_projectId, id) => [...f.grants.values()].find(value => value.id === id)!);
    f.reopenStore();
    const selectedTargets = [f.project.projectId];
    const runner = createWorkerCoordinator({ ...f.options, repositories: [], readyProjectIds: [], targetProjectIds: selectedTargets, globalConfiguration: configuration });
    selectedTargets.length = 0;
    await runner.tick();
    expect(f.store.getTask(resumed)?.status).toBe("pending");
    expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.remote.claim).not.toHaveBeenCalled();
    runner.updateConfiguration({ repositories: [], readyProjectIds: [], targetProjectIds: [], globalConfiguration: null, maxConcurrent: 2 });
    await runner.tick();
    expect(f.store.getTask(resumed)?.status).toBe("pending");
    expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.remote.claim).not.toHaveBeenCalled();
    runner.updateConfiguration({ repositories: [], readyProjectIds: [], targetProjectIds: [], globalConfiguration: configuration, maxConcurrent: 2 });
    await runner.tick();
    expect(f.store.getTask(resumed)?.status).toBe("pending");
    expect(f.tasks.start).not.toHaveBeenCalled();
    runner.updateConfiguration({ repositories: [{ project: f.project, configuration }], readyProjectIds: [f.project.projectId], targetProjectIds: [f.project.projectId], globalConfiguration: configuration, maxConcurrent: 2 });
    f.candidates.splice(0);
    await runner.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    expect(f.store.getTask(resumed)).toMatchObject({ claimId: resumed.claimId, status: "active" });
    expect(f.tasks.start.mock.calls[0]![0]).toMatchObject({ projectId: f.project.projectId, taskId, claimId: resumed.claimId });
    expect(f.remote.claim).not.toHaveBeenCalled();
    await runner.shutdown();
  });
});

it("keeps ordinary Web failures separate from native recovery and retries after restart", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture();
  let webStore = openWebExecutionStore(path.join(f.root, "web.sqlite"));
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 3 };
  const advance = vi.fn(async (input: import("../../../src/commands/worker/backends/web-types.js").LocalTask) => {
    webStore.bindNativeSession(input, { source: "controller", sessionId: uuid(880) }, 2);
    throw new WorktreePreconditionError("branch_mismatch", "The task worktree no longer uses its original task branch.");
  });
  const update = vi.mocked(f.remote.update).getMockImplementation()!;
  vi.mocked(f.remote.update).mockImplementationOnce(async current => {
    f.grants.set(readWorkerClaim(current.properties)!.claimId, { ...current, version: 17n });
    throw new Error("Summary response lost.");
  }).mockImplementation(update);
  const options = () => ({ ...f.options, repositories: [{ project: f.project, configuration }], globalConfiguration: configuration, webStore, verifyWebServer: vi.fn(async () => {}), verifyWebUnregistered: async () => {}, webBackend: { advance, cleanup: vi.fn() } });
  let coordinator = createWorkerCoordinator(options());
  const tick = async () => { await coordinator.tick(); await new Promise<void>(resolve => setImmediate(resolve)); };
  try {
    await tick(); await eventually(() => expect(advance).toHaveBeenCalledTimes(1));
    await tick(); await eventually(() => expect(advance).toHaveBeenCalledTimes(2));
    await tick(); await eventually(() => expect(advance).toHaveBeenCalledTimes(3));
    await tick(); await eventually(() => expect(advance).toHaveBeenCalledTimes(4));
    await eventually(() => expect(f.remote.update).toHaveBeenCalled());
    const row = f.store.listTasks()[0]!;
    const paused = webStore.getTask(row)!;
    expect(paused.recovery.pauseReason).toBeNull();
    expect(paused.recovery.count).toBe(0);
    expect(paused.recovery.retryAuthorized).toBe(false);
    await tick();
    await eventually(() => expect(f.remote.update).toHaveBeenCalledTimes(2));
    expect(vi.mocked(f.remote.update).mock.calls[1]![0].version).toBe(17n);
    expect(vi.mocked(f.remote.update).mock.calls[1]![1]).toEqual({ phase: "waiting", nativeSessionId: uuid(880), herdr: null });
    webStore.close(); webStore = openWebExecutionStore(path.join(f.root, "web.sqlite"));
    coordinator = createWorkerCoordinator(options());
    await tick(); await tick();
    expect(advance.mock.calls.length).toBeGreaterThan(4);
    expect(f.remote.update).toHaveBeenCalledTimes(2);
    expect(webStore.getTask(row)?.recovery).toEqual(paused.recovery);
    expect(f.store.getTask(row)).toMatchObject({ status: "active", sessionId: uuid(880) });
    expect(readWorkerClaim(f.grants.get(row.claimId)!.properties)).toMatchObject({ claimId: row.claimId, state: "active", phase: "waiting" });
    expect(f.remote.claim).toHaveBeenCalledOnce();
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
  } finally { await new Promise<void>(resolve => setImmediate(resolve)); webStore.close(); }
});
