import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { ensureCleanupSchedule } from "../../../src/commands/worker/cleanup-schedule.js";
import type { CleanupTarget, StopObservation } from "../../../src/commands/worker/execution-stop.js";
import { ArchiveRepairRequiredError, type ArchiveProbeResult } from "../../../src/commands/controller/archive-error.js";
import { scanFromList } from "../../helpers/worker-git-scan.js";
import { execFileSync } from "node:child_process";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { frozenToolLaunch } from "../../helpers/tool-launch.js";
import { toolSelectionKey } from "../../../src/platform/tool-executables.js";
import { reconcileDeletedHerdrResource } from "../../../src/commands/worker/resource-disposal.js";
import * as lifecycle from "../../../src/commands/controller/lifecycle-store.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import * as launchObservation from "../../../src/commands/controller/launch-observation.js";
import { createControllerJobLeases } from "../../../src/commands/worker/backends/controller-job-leases.js";
import { writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { LocalTask as WebTask } from "../../../src/commands/worker/backends/web-types.js";
import type { WebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { ControllerIpcOutcomeUnknownError, type requestController } from "../../../src/commands/controller/local-client.js";
import { readWorkerClaim } from "../../../src/api/task-properties.js";
import { access, link, lstat, mkdir, mkdtemp, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TimerOptions } from "node:timers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationError } from "../../../src/api/operation.js";
import { ApiError, createApiClient } from "../../../src/api/client.js";
import { createSharedWorkerHerdr } from "../../../src/commands/worker/herdr/shared.js";
import { resolveHerdrInstancePaths } from "../../../src/commands/worker/herdr/instance.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { isWorkerCancellation } from "../../../src/commands/worker/execution.js";
import { createCleanupDriver } from "../../../src/commands/worker/cleanup.js";
import { HerdrAgentActionError, HerdrRpcError } from "../../../src/commands/worker/herdr.js";
import { HerdrInputBlockedError, LegacyBindingUnavailableError } from "../../../src/commands/worker/herdr/agents.js";
import { createWorkerCoordinator as createCoordinator } from "../../../src/commands/worker/coordinator.js";
import { createMonitoringObserver } from "../../../src/commands/worker/monitoring/observer.js";
import { createWorkerGitManager, WorktreePreconditionError } from "../../../src/commands/worker/worktrees.js";
import { migrateLegacyWorktrees } from "../../../src/commands/worker/worktrees/migration.js";
import { createWorktreeManifestStore } from "../../../src/commands/worker/worktrees/manifest.js";
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
const emptyFormatSources = { listSchedules: () => [], listWebTasks: () => [], listHerdrLifecycles: () => [], listHerdrBindings: () => [], listHerdrRetired: () => [], listHerdrResources: () => [] };
const prepareFormat: NonNullable<Parameters<typeof createWorkerGitManager>[0]["prepareFormat"]> = async (_project, repository, operation) => {
  await migrateLegacyWorktrees({ repositoryPath: repository.root, commonDirectory: repository.commonDirectory, operation, sources: emptyFormatSources });
};
const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const unknownStop = async (target: CleanupTarget): Promise<StopObservation> => ({ kind: "unknown", target, error: new Error("Unobserved test backend"), observedAt: Date.now() });
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
it("preserves native polling values, asynchronous settlement and cancellation", async () => {
  const value = { polling: "value" };
  let settled = false;
  const result = delay(1_000, value).then(returned => { settled = true; return returned; });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(await result).toBe(value);
  for (const cancelBeforeScheduling of [true, false]) {
    const cancellation = new AbortController(); const reason = new Error("Polling cancelled.");
    if (cancelBeforeScheduling) cancellation.abort(reason);
    const failure = delay(1_000, undefined, { signal: cancellation.signal }).catch(error => error as Error & { code: string });
    await Promise.resolve();
    if (!cancelBeforeScheduling) cancellation.abort(reason);
    expect(await failure).toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    expect((await failure as Error).cause).toBe(reason);
  }
  expect(polling.requested).toEqual([1_000, 1_000, 1_000]);
});

const fixture = async (maxConcurrent = 1, registerProject = true) => {
  const base = path.resolve("../../.tmp/minimal-coordinator-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "r-")); directories.push(root);
  const store = openWorkerStore(createMemoryDatabase()); stores.push(store);
  const project: WorkerProject = { projectId: uuid(10), repoUrl: "https://example.test/owner/repo.git", localPath: path.join(root, "repo") }; if (registerProject) store.registerProject(project);
  const candidates = [task(project.projectId, uuid(100)), task(project.projectId, uuid(101))];
  const grants = new Map<string, Task>();
  const worktrees = new Map<string, { owner: ResourceOwner; binding: WorktreeBinding }>();
  const manifests = new Map<string, { owner: ResourceOwner; binding: WorktreeBinding }>();
  const resources = new Map<string, HerdrOwnedWorkspace>();
  const stoppedRuns = new Set<string>();
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
    scanWorktrees: scanFromList, listWorktrees: vi.fn(async (source: WorkerProject, _operation: Operation, _allowMissing = false, includeOtherProjects = false) => [...worktrees.values()].filter(({ owner, binding }) => binding.repositoryPath === source.localPath && (includeOtherProjects || owner.projectId === source.projectId))),
    removeWorktree: vi.fn(async (_project: WorkerProject, owner: ResourceOwner) => { expect(resources.has(owner.claimId)).toBe(false); order.push("remove-worktree"); worktrees.delete(owner.claimId); return { kind: "absent" as const, effectErrors: [] }; }),
  } as unknown as WorkerGitManager;
  const tasks = {
    observeExecutionStop: vi.fn(async (target: CleanupTarget): Promise<StopObservation> => {
      if (target.worktreeId === undefined) return unknownStop(target);
      const execution = { owner: { ...target, worktreeId: target.worktreeId }, backend: "herdr-legacy" as const, runKey: target.claimId };
      if (resources.has(target.claimId)) return { kind: "running", execution, observedAt: clock };
      return stoppedRuns.has(target.claimId) ? { kind: "stopped", execution, observedAt: clock } : { kind: "unknown", target, error: new LegacyBindingUnavailableError("No original legacy Herdr binding exists in this Worker run."), observedAt: clock };
    }),
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
      input.onAgentStarted?.();
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
    stopAndClose: vi.fn(async (owner: ResourceOwner) => { order.push("stop-close"); resources.delete(owner.claimId); stoppedRuns.add(owner.claimId); }),
  };
  const herdr = { tasks, ensureInstance: vi.fn(async () => {}), stopInstance: vi.fn() } as unknown as WorkerHerdrAdapter;
  const grant = (candidate: Task, descriptor: WorkerClaimDescriptor): Task => {
    const result: Task = { ...candidate, status: "in_progress", ready: false, version: candidate.version + 1n, properties: { ...candidate.properties, worker: { ...descriptor, agentControlMode: descriptor.agentControlMode ?? "herdr", userId: uuid(2), state: "active", phase: "preparing", herdr: null, nativeSessionId: null, claimedAt: "2026-10-27T00:00:00Z" } } };
    grants.set(descriptor.claimId, result); return result;
  };
  const remote = {
    serverOrigin: origin, currentUserId: vi.fn(async () => uuid(2)),
    ownInventory: vi.fn(async (projects: readonly { projectId: string }[]) => ({ tasks: [...grants.values()], coveredProjectIds: [...new Set(projects.map(project => project.projectId))], unavailableProjectIds: [] })),
    candidates: vi.fn(async function* (projectId: string, platform, _signal, platformSpecific) { for (const candidate of candidates) if (candidate.projectId === projectId && (candidate.requiredPlatform === null || candidate.requiredPlatform === platform) && (platformSpecific === undefined || (candidate.requiredPlatform !== null) === platformSpecific) && ![...grants.values()].some((value) => value.id === candidate.id)) yield candidate; }),
    claim: vi.fn(async (candidate: Task, descriptor: WorkerClaimDescriptor) => grant(candidate, descriptor)),
    readTask: vi.fn(async (_projectId: string, taskId: string) => { const result = [...grants.values()].find((value) => value.id === taskId); if (result === undefined) throw new Error("missing task"); return result; }),
    update: vi.fn(async (current: Task, update: object) => { const result = { ...current, properties: { ...current.properties, worker: { ...readWorkerClaim(current.properties)!, ...update } } }; grants.set(readWorkerClaim(current.properties)!.claimId, result); return result; }),
  } as unknown as WorkerRemote;
  const options = { store, git, herdr, remote, serverOrigin: origin, workerId, platform: "linux" as const, machine: { id: uuid(3), name: "fixture" }, repositories: [{ project, configuration }], globalConfiguration: configuration, maxConcurrent, preferPlatformSpecificTasks: false, buildPrompt: vi.fn((_assignment: ManagedAssignment) => "managed assignment"), emit: (event: WorkerEvent) => events.push(event), now: () => clock };
  return { stoppedRuns, root, store, project, candidates, grants, grant, resources, worktrees, manifests, git, herdr, tasks, remote, order, events, options, coordinator: createWorkerCoordinator(options), clock: (value: number) => { clock = value; }, bind, blockStartupInput: () => { blockedStartupInput = true; } };
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
  task = store.updateWebExecution(task, { controllerProcess: snapshot.controllerProcess }, 7);
  vi.spyOn(processProof, "inspectProcessProof").mockResolvedValue("stopped");
  vi.spyOn(lifecycle, "readControllerSnapshot").mockReturnValue(snapshot);
  // These cases exercise archive scheduling after stop has been proven; the
  // Windows proof boundary itself is covered by the lifecycle integration tests.
  vi.spyOn(lifecycle, "readProvenWindowsStoppedControllerGeneration").mockReturnValue(snapshot);
  vi.spyOn(launchObservation, "reconcileSubmittedControllerLaunch").mockImplementation(async input => ({ kind: "controller-exited", process: input.spawnProof, snapshot }));
  vi.spyOn(lifecycle, "recordStoppedControllerGeneration").mockResolvedValue(snapshot);
  vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  return { task, ticket, snapshot, jobLeases: createControllerJobLeases("win32"), request: vi.fn<typeof requestController>().mockRejectedValue(new ControllerIpcOutcomeUnknownError("Original controller is stopped.")) };
};

const addOrphan = (f: Awaited<ReturnType<typeof fixture>>, taskId = uuid(900)) => {
  const owner = { projectId: f.project.projectId, taskId, claimId: uuid(901), worktreeId: uuid(902) };
  const binding = { session: "w", workspaceId: "orphan", paneId: "orphan-pane", terminalId: "orphan-terminal" };
  const pane: HerdrOwnedWorkspace["panes"][number] = { binding, cwd: f.bind(owner).worktreePath, kind: "copilot", status: "working", launchPending: false, interactiveReady: true, nativeSession: { source: "herdr", agent: "copilot", sessionId: uuid(903) }, stateChangeSeq: 1, completionSeq: 0 };
  f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
  f.resources.set(owner.claimId, { owner, workspaceId: binding.workspaceId, panes: [pane] });
  return { owner, binding, pane };
};

describe("worker report publication boundaries", () => {
  it("counts a Git-only owner of another Project in a selected repository", async () => {
    const f = await fixture(1);
    const oldOwner = { projectId: uuid(11), taskId: uuid(900), claimId: uuid(901), worktreeId: uuid(902) };
    f.worktrees.set(oldOwner.claimId, { owner: oldOwner, binding: { repositoryPath: f.project.localPath, commonDirectory: path.join(f.project.localPath, ".git"), worktreePath: path.join(f.project.localPath, ".worktrees", "daynight", oldOwner.taskId), branch: `daynight/${oldOwner.taskId}` } });
    await f.coordinator.tick();
    expect(f.remote.claim).not.toHaveBeenCalled();
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
    f.worktrees.delete(oldOwner.claimId);
    await f.coordinator.tick();
    expect(f.remote.claim).toHaveBeenCalledOnce();
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
      claimId: uuid(121), workerId, worktreeId: uuid(122), machine: { id: uuid(4), name: "fixture" }, platform: "linux", agent: "codex",
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
  it("admits a healthy repository while another repository's format preparation fails", async () => {
    const f = await fixture(2);
    const healthy = { ...f.project, projectId: uuid(11), localPath: path.join(f.root, "healthy") };
    f.store.registerProject(healthy);
    f.options.repositories.push({ project: healthy, configuration });
    f.candidates.splice(0, f.candidates.length, task(healthy.projectId, uuid(102)));
    const preparation = vi.fn(async (id: string) => { if (id === f.project.projectId) throw new Error("Unrecognized worktree format"); });
    const scan = vi.fn<WorkerGitManager["scanWorktrees"]>(async (project, operation, allowMissing, includeOtherProjects) => project.projectId === f.project.projectId
      ? { enumerationComplete: false, validated: [], quarantined: [], unknown: [{ error: new Error("The repository worktree format has not been prepared.") }] }
      : scanFromList.call(f.git, project, operation, allowMissing, includeOtherProjects));
    f.git.scanWorktrees = scan;
    const coordinator = createWorkerCoordinator({ ...f.options, prepareProject: preparation });
    try {
      await coordinator.tick();
      await eventually(() => expect(preparation).toHaveBeenCalledTimes(2));
      await eventually(() => expect(f.events).toContainEqual(expect.objectContaining({ kind: "warning", message: expect.stringContaining(f.project.projectId) })));
      await coordinator.tick();
      await eventually(() => expect(f.remote.claim).toHaveBeenCalledOnce());
      expect(vi.mocked(f.remote.claim).mock.calls[0]![0].projectId).toBe(healthy.projectId);
    } finally { await coordinator.shutdown(); }
  });

  it("stops the original pane even while its repository format gate is closed", async () => {
    const f = await fixture();
    const owner = { projectId: f.project.projectId, taskId: uuid(940), claimId: uuid(941), worktreeId: uuid(942) };
    f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex" }));
    const binding = { session: "w", workspaceId: "retained", paneId: "p", terminalId: "t" };
    f.resources.set(owner.claimId, { owner, workspaceId: binding.workspaceId, panes: [{ binding, cwd: f.bind(owner).worktreePath, kind: "codex", status: "idle", launchPending: false, interactiveReady: true, nativeSession: null, stateChangeSeq: 1, completionSeq: 0 }] });
    f.candidates.splice(0);
    f.git.scanWorktrees = vi.fn(async () => ({ enumerationComplete: false, validated: [], quarantined: [], unknown: [{ error: new Error("format not prepared") }] }));
    vi.mocked(f.git.removeWorktree).mockRejectedValue(new Error("format not prepared"));
    const coordinator = createWorkerCoordinator({ ...f.options, prepareProject: async () => { throw new Error("format not prepared"); } });
    try {
      await coordinator.tick();
      await eventually(() => expect(f.tasks.stopAndClose).toHaveBeenCalledOnce());
      expect(f.resources.has(owner.claimId)).toBe(false);
      expect(f.store.getCleanupSchedule(owner)).not.toBeNull();
      expect(f.store.getTask(owner)?.status).not.toBe("done");
    } finally { await coordinator.shutdown(); }
  });

  it("retries metadata retirement without reviving a slot or the same-task barrier", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(951), worktreeId: uuid(952) };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    const config = { ...configuration, agentControlMode: "web" as const };
    let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
    record = webStore.bindWorktree(record, f.bind(owner), 2);
    record = webStore.beginCleanup(record, { kind: "terminal", deadline: 100 }, 2);
    webStore.completeTask(record, 3);
    f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
    vi.mocked(f.git.retireWorktreeManifest).mockRejectedValueOnce(new Error("manifest unlink failed")).mockRejectedValueOnce(new Error("manifest unlink failed"));
    const coordinator = createWorkerCoordinator({ ...f.options, webStore });
    try {
      expect(() => coordinator.assertCanAcquire(owner)).not.toThrow();
      const candidates = f.candidates.splice(0);
      await coordinator.tick();
      expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-error", message: "Worktree metadata retirement remains pending." }));
      expect(f.manifests.has(owner.claimId)).toBe(true);
      expect(f.store.getCleanupSchedule(owner)).toBeNull();
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
      expect(() => coordinator.assertCanAcquire(owner)).not.toThrow();
      f.candidates.push(...candidates);
      await coordinator.tick();
      expect(f.manifests.has(owner.claimId)).toBe(true);
      expect(f.remote.claim).toHaveBeenCalledOnce();
      expect(vi.mocked(f.remote.claim).mock.calls[0]![0].id).toBe(owner.taskId);
      await eventually(async () => { await coordinator.tick(); expect(f.manifests.has(owner.claimId)).toBe(false); });
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("retires settled Web metadata without initializing an unrelated Herdr backend", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(951), worktreeId: uuid(952) };
    const config = { ...configuration, args: [], agentControlMode: "web" as const };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
    record = webStore.bindWorktree(record, f.bind(owner), 2);
    record = webStore.beginCleanup(record, { kind: "terminal", deadline: 100 }, 2); webStore.completeTask(record, 3);
    f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
    const herdr = new Proxy({} as WorkerHerdrAdapter, { get: () => { throw new Error("Herdr initialization failed"); } });
    const coordinator = createWorkerCoordinator({ ...f.options, herdr, repositories: [{ project: f.project, configuration: config }], globalConfiguration: config, webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async task => task), cleanup: vi.fn() } });
    try {
      await coordinator.tick();
      expect(f.manifests.has(owner.claimId)).toBe(false);
      expect(f.remote.claim).toHaveBeenCalledOnce();
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("preserves a Web manifest without its backend record while admitting another Web task", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(951), worktreeId: uuid(952) };
    const config = { ...configuration, args: [], agentControlMode: "web" as const };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
    f.candidates.splice(0, 1);
    const herdr = new Proxy({} as WorkerHerdrAdapter, { get: () => { throw new Error("Herdr initialization failed"); } });
    const coordinator = createWorkerCoordinator({ ...f.options, herdr, repositories: [{ project: f.project, configuration: config }], globalConfiguration: config, webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async task => task), cleanup: vi.fn() } });
    try {
      await coordinator.tick();
      expect(f.manifests.has(owner.claimId)).toBe(true);
      expect(f.git.retireWorktreeManifest).not.toHaveBeenCalled();
      expect(vi.mocked(f.remote.claim).mock.calls.map(([candidate]) => candidate.id)).toEqual([uuid(101)]);
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("does not wait for a successor task gate when retrying old metadata", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(951), worktreeId: uuid(952) };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: { ...configuration, agentControlMode: "web" } }, 1);
    record = webStore.bindWorktree(record, f.bind(owner), 2);
    record = webStore.beginCleanup(record, { kind: "terminal", deadline: 100 }, 2); webStore.completeTask(record, 3);
    f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
    vi.mocked(f.git.retireWorktreeManifest).mockRejectedValueOnce(new Error("manifest unlink failed"));
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const start = f.tasks.start.getMockImplementation()!;
    f.tasks.start.mockImplementation(async (...args) => { entered.resolve(); await release.promise; return start(...args); });
    const coordinator = createWorkerCoordinator({ ...f.options, webStore });
    try {
      await coordinator.tick();
      await entered.promise;
      expect(f.manifests.has(owner.claimId)).toBe(true);
      const round = coordinator.tick();
      expect(await Promise.race([round.then(() => "completed"), new Promise<string>(resolve => setTimeout(() => resolve("blocked"), 1000))])).toBe("completed");
      expect(f.git.retireWorktreeManifest).toHaveBeenCalledOnce();
      expect(f.manifests.has(owner.claimId)).toBe(true);
    } finally { release.resolve(); await coordinator.shutdown(); webStore.close(); }
  });

  it("does not retire a manifest from LocalTask.done without backend settlement evidence", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const owner = { projectId: f.project.projectId, taskId: uuid(970), claimId: uuid(971), worktreeId: uuid(972) };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: { ...configuration, agentControlMode: "web" } }, 1);
    f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
    vi.mocked(f.git.findWorktree).mockResolvedValue(f.bind(owner));
    const coordinator = createWorkerCoordinator({ ...f.options, webStore });
    try {
      await coordinator.tick();
      expect(f.manifests.has(owner.claimId)).toBe(true);
      expect(f.git.retireWorktreeManifest).not.toHaveBeenCalled();
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("retires an archived original manifest without inspecting its successor's reused legacy cwd", async () => {
    const f = await fixture();
    const owner = { projectId: f.project.projectId, taskId: uuid(970), claimId: uuid(971), worktreeId: uuid(972) };
    const successor = { ...owner, claimId: uuid(973), worktreeId: uuid(974) };
    const cwd = path.join(f.project.localPath, ".worktrees", "daynight", owner.taskId);
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex" }));
    f.manifests.set(owner.claimId, { owner, binding: { ...f.bind(owner), worktreePath: cwd } });
    f.worktrees.set(successor.claimId, { owner: successor, binding: { ...f.bind(successor), worktreePath: cwd } });
    const resource = { owner, sessionId: uuid(975), stopped: true, stopEvidence: archiveFixture.runs.map(run => run.stopProof), terminal: true, worktreePath: cwd, sourcePath: path.join(f.root, "source"), sourceBytes: "0", state: "ready", error: null, nextAttemptAt: null, worktreeDeleted: true, disposition: null };
    Object.assign(f.herdr, { lifecycle: { responsibilities: () => [], isStopped: () => true, archive: { resources: () => [resource] }, assertCanAdvance: () => {}, stop: async () => {} } });
    const find = vi.mocked(f.git.findWorktree).getMockImplementation()!;
    vi.mocked(f.git.findWorktree).mockImplementation((project, target, operation) => {
      if (target.claimId === owner.claimId) throw new Error("must not inspect the retired path");
      return find(project, target, operation);
    });
    f.candidates.splice(0);
    const coordinator = createWorkerCoordinator({ ...f.options, hasHerdrJournal: true });
    try {
      await coordinator.tick();
      expect(f.manifests.has(owner.claimId)).toBe(false);
      expect(f.worktrees.has(successor.claimId)).toBe(true);
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
      expect(vi.mocked(f.git.findWorktree).mock.calls.some(([, target]) => target.claimId === owner.claimId)).toBe(false);
    } finally { await coordinator.shutdown(); }
  });

  it("retains a manifest conflicting with the durable original backend cwd", async () => {
    const f = await fixture();
    const owner = { projectId: f.project.projectId, taskId: uuid(970), claimId: uuid(971), worktreeId: uuid(972) };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex" }));
    const original = path.join(f.project.localPath, ".worktrees", "daynight", owner.taskId);
    f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
    const resource = { owner, sessionId: uuid(975), stopped: true, stopEvidence: archiveFixture.runs.map(run => run.stopProof), terminal: true, worktreePath: original, sourcePath: path.join(f.root, "source"), sourceBytes: "0", state: "ready", error: null, nextAttemptAt: null, worktreeDeleted: true, disposition: null };
    Object.assign(f.herdr, { lifecycle: { responsibilities: () => [], isStopped: () => true, archive: { resources: () => [resource] }, assertCanAdvance: () => {}, stop: async () => {} } });
    f.candidates.splice(0);
    const coordinator = createWorkerCoordinator({ ...f.options, hasHerdrJournal: true });
    try {
      await coordinator.tick();
      expect(f.manifests.has(owner.claimId)).toBe(true);
      expect(f.git.retireWorktreeManifest).not.toHaveBeenCalled();
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
      expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-error", message: "Worktree metadata retirement remains pending." }));
    } finally { await coordinator.shutdown(); }
  });

  it("retains and reports metadata when completed Web execution has no original binding", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
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

  it("invalidates an otherwise complete inventory when project preparation observes 404 before claiming another project", async () => {
    const f = await fixture();
    const other = { ...f.project, projectId: uuid(11), localPath: path.join(f.root, "other") };
    f.store.registerProject(other); f.options.repositories.push({ project: other, configuration });
    f.candidates.splice(0, f.candidates.length, task(other.projectId, uuid(102)));
    const publish = vi.fn();
    const missing = new ApiError({ operation: "project.show", projectId: f.project.projectId }, "response", { cause: new Error("missing"), status: 404, serverError: { code: "not_found", message: "missing", requestId: "missing" } });
    const coordinator = createWorkerCoordinator({ ...f.options, onInventory: publish, prepareProject: async id => { if (id === f.project.projectId) throw missing; }, onClaim: () => { expect(publish.mock.lastCall).toEqual([null]); } });
    try {
      await coordinator.tick();
      await eventually(() => expect(publish).toHaveBeenLastCalledWith(null));
      await eventually(async () => { await coordinator.tick(); expect(f.remote.claim).toHaveBeenCalledOnce(); });
      await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    } finally { await coordinator.shutdown(); }
  });

  it("does not report a complete inventory while configuration discovery is incomplete", async () => {
    const f = await fixture(); const publish = vi.fn(); let complete = false;
    const coordinator = createWorkerCoordinator({ ...f.options, onInventory: publish, configurationComplete: () => complete });
    await coordinator.tick();
    expect(publish).toHaveBeenCalledWith(null);
    expect(f.remote.claim).not.toHaveBeenCalled();
    complete = true;
    await coordinator.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
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
      await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    } finally { release(); await tick; await coordinator.shutdown(); }
  });

  it("cancels unavailable project work without treating its claim as ended and still starts a healthy project", async () => {
    const f = await fixture(2);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let operationSignal: AbortSignal | undefined;
    const prepare = vi.mocked(f.git.prepareWorktree).getMockImplementation()!;
    vi.mocked(f.git.prepareWorktree).mockImplementation(async (project, owner, operation) => {
      if (project.projectId === f.project.projectId) { operationSignal = operation.signal; entered(); await held; operation.check(); }
      return prepare(project, owner, operation);
    });
    await f.coordinator.tick();
    await started;
    const a = f.store.listTasks()[0]!;
    const b = { ...f.project, projectId: uuid(11), localPath: path.join(f.root, "other") };
    f.store.registerProject(b); f.options.repositories.push({ project: b, configuration });
    f.coordinator.updateConfiguration(f.options);
    f.candidates.push(task(b.projectId, uuid(102)));
    let releasePoll!: () => void, enteredPoll!: () => void;
    const pollHeld = new Promise<void>(resolve => { releasePoll = resolve; });
    const pollEntered = new Promise<void>(resolve => { enteredPoll = resolve; });
    vi.mocked(f.remote.ownInventory).mockImplementation(async (_projects, _worker, _signal, onUnavailable) => {
      onUnavailable?.(f.project.projectId); enteredPoll(); await pollHeld;
      return { tasks: [...f.grants.values()].filter(item => item.projectId === b.projectId), coveredProjectIds: [b.projectId], unavailableProjectIds: [f.project.projectId] };
    });
    try {
      const tick = f.coordinator.tick();
      await pollEntered;
      expect(operationSignal?.aborted).toBe(true);
      releasePoll(); await tick;
      expect(f.store.getTask(a)?.status).toBe("active");
      expect(f.tasks.stopAndClose).not.toHaveBeenCalled();
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
      expect(f.remote.claim).toHaveBeenCalledTimes(2);
    } finally { releasePoll(); release(); }
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(1));
  });

  it("counts an unproven Git resource without cleaning it, while an unavailable ID alone consumes no slot", async () => {
    const f = await fixture(1);
    const unavailable = { ...f.project, projectId: uuid(11), localPath: path.join(f.root, "unavailable") };
    f.store.registerProject(unavailable); f.options.repositories.push({ project: unavailable, configuration });
    const owner = { projectId: unavailable.projectId, taskId: uuid(910), claimId: uuid(911), worktreeId: uuid(912) };
    f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    vi.mocked(f.remote.ownInventory).mockResolvedValue({ tasks: [], coveredProjectIds: [f.project.projectId], unavailableProjectIds: [unavailable.projectId] });
    await f.coordinator.tick();
    expect(f.remote.claim).not.toHaveBeenCalled();
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
    f.worktrees.delete(owner.claimId);
    await f.coordinator.tick();
    expect(f.remote.claim).toHaveBeenCalledOnce();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
  });

  it("keeps new admissions blocked when another repository's local resources cannot be scanned", async () => {
    const f = await fixture(2);
    const unavailable = { ...f.project, projectId: uuid(11), localPath: path.join(f.root, "unavailable") };
    f.store.registerProject(unavailable); f.options.repositories.push({ project: unavailable, configuration });
    vi.mocked(f.remote.ownInventory).mockResolvedValue({ tasks: [], coveredProjectIds: [f.project.projectId], unavailableProjectIds: [unavailable.projectId] });
    const list = vi.mocked(f.git.listWorktrees).getMockImplementation()!;
    vi.mocked(f.git.listWorktrees).mockImplementation(async (project, operation, allowMissing) => {
      if (project.projectId === unavailable.projectId) throw new Error("local discovery denied");
      return list(project, operation, allowMissing);
    });
    await f.coordinator.tick();
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "warning", message: expect.stringContaining("Could not inspect Git worktrees") }));
    expect(f.remote.claim).not.toHaveBeenCalled();
  });

  it.each(["unselected-absent", "unselected-invalid", "selected-absent"] as const)("checks a retained repository before admitting another Project: %s", async situation => {
    const f = await fixture(2);
    const retained = { ...f.project, projectId: uuid(11), localPath: path.join(f.root, "retained") };
    f.store.registerProject(retained);
    if (situation === "unselected-invalid") await mkdir(retained.localPath);
    const manager = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "temporary") });
    const list = vi.mocked(f.git.listWorktrees).getMockImplementation()!;
    vi.mocked(f.git.listWorktrees).mockImplementation((project, operation, allowMissing, includeOtherProjects) => project.projectId === retained.projectId
      ? manager.listWorktrees(project, operation, allowMissing, includeOtherProjects)
      : list(project, operation, allowMissing, includeOtherProjects));
    const coordinator = createWorkerCoordinator({ ...f.options,
      targetProjectIds: situation === "selected-absent" ? [f.project.projectId, retained.projectId] : [f.project.projectId],
      readyProjectIds: [f.project.projectId],
    });
    try {
      await coordinator.tick();
      if (situation === "unselected-absent") expect(f.remote.claim).toHaveBeenCalledOnce();
      else expect(f.remote.claim).not.toHaveBeenCalled();
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
    } finally { await manager.dispose(); }
  });

  it("invalidates and cancels an active project if its candidate page returns 404", async () => {
    const f = await fixture(2); let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let activeSignal: AbortSignal | undefined;
    const prepare = vi.mocked(f.git.prepareWorktree).getMockImplementation()!;
    vi.mocked(f.git.prepareWorktree).mockImplementation(async (project, owner, operation) => {
      if (project.projectId === f.project.projectId) { activeSignal = operation.signal; entered(); await held; operation.check(); }
      return prepare(project, owner, operation);
    });
    const publish = vi.fn(); const coordinator = createWorkerCoordinator({ ...f.options, onInventory: publish });
    await coordinator.tick(); await started;
    const other = { ...f.project, projectId: uuid(11), localPath: path.join(f.root, "other") };
    f.store.registerProject(other); f.options.repositories.push({ project: other, configuration });
    coordinator.updateConfiguration(f.options);
    const missing = new ApiError({ operation: "task.list-page", projectId: f.project.projectId }, "response", { cause: new Error("missing"), status: 404, serverError: { code: "not_found", message: "missing", requestId: "missing" } });
    vi.mocked(f.remote.candidates).mockImplementation(async function* (projectId) {
      if (projectId === f.project.projectId) throw missing;
      yield task(other.projectId, uuid(102));
    });
    try {
      await coordinator.tick();
      expect(activeSignal?.aborted).toBe(true);
      expect(publish).toHaveBeenLastCalledWith(null);
      expect(f.remote.claim).toHaveBeenCalledTimes(2);
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
    } finally { release(); }
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
  });

  it("persists a new Herdr claim before activating or preparing its execution", async () => {
    const f = await fixture();
    const registerClaim = vi.fn((context: HerdrExecutionContext, userId: string) => {
      expect(f.store.getTask(context)?.status).toBe("pending");
      expect(f.git.prepareWorktree).not.toHaveBeenCalled();
      expect(userId).toBe(uuid(2));
      expect(context).toMatchObject({ agent: "codex", cwd: f.bind(context).worktreePath });
    });
    Object.assign(f.herdr, { lifecycle: { registerClaim, responsibilities: () => [], isStopped: () => false, assertCanAdvance: () => {}, hasPreparedRun: () => false, stop: async () => {} } });
    await f.coordinator.tick();
    expect(registerClaim).toHaveBeenCalledOnce();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    await f.coordinator.shutdown();
  });

  it("keeps a confirmed grant pending when durable claim registration fails", async () => {
    const f = await fixture();
    const registerClaim = vi.fn(() => { throw new Error("Durable registration unavailable"); });
    Object.assign(f.herdr, { lifecycle: { registerClaim, responsibilities: () => [], isStopped: () => false } });
    await f.coordinator.tick();
    expect(registerClaim).toHaveBeenCalledOnce();
    expect(f.store.listUnfinishedTasks()[0]?.status).toBe("pending");
    expect(f.git.prepareWorktree).not.toHaveBeenCalled();
    expect(f.tasks.start).not.toHaveBeenCalled();
  });

  it("does not turn a recovered uncertain grant into fresh launch provenance", async () => {
    const f = await fixture();
    const registerClaim = vi.fn();
    Object.assign(f.herdr, { lifecycle: { registerClaim, responsibilities: () => [], isStopped: () => false, assertCanAdvance: () => { throw new Error("Missing durable provenance"); } } });
    vi.mocked(f.remote.claim).mockImplementationOnce(async (candidate, descriptor) => { f.grant(candidate, descriptor); throw new Error("Response lost"); });
    await f.coordinator.tick();
    f.candidates.splice(0);
    await f.coordinator.tick();
    expect(registerClaim).not.toHaveBeenCalled();
    expect(f.tasks.start).not.toHaveBeenCalled();
    await f.coordinator.shutdown();
  });

  it("does not start Herdr from a default configuration without repositories or task responsibility", async () => {
    const f = await fixture(1, false);
    const coordinator = createWorkerCoordinator({ ...f.options, repositories: [] });
    await coordinator.tick();
    expect(f.remote.ownInventory).toHaveBeenCalledOnce();
    expect(f.herdr.ensureInstance).not.toHaveBeenCalled();
    expect(f.tasks.listResources).not.toHaveBeenCalled();
    expect(f.tasks.start).not.toHaveBeenCalled();
    expect(f.store.listTasks()).toEqual([]);
    expect(await coordinator.shutdown()).toBe(true);
    expect(f.herdr.ensureInstance).not.toHaveBeenCalled();
  });

  it("publishes a complete inventory before native resource discovery can fail", async () => {
    const f = await fixture();
    const reference = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(400) };
    f.grant(f.candidates[0]!, { claimId: reference.claimId, workerId, machine: f.options.machine, platform: "linux", agent: "codex", worktreeId: uuid(401) });
    const onInventory = vi.fn();
    const failure = new Error("native resource observation failed");
    vi.mocked(f.herdr.ensureInstance).mockImplementation(async () => {
      expect(onInventory).toHaveBeenCalledExactlyOnceWith({ observedAt: new Date(1000).toISOString(), claims: [reference] });
      throw failure;
    });
    const coordinator = createWorkerCoordinator({ ...f.options, onInventory });
    await expect(coordinator.tick()).rejects.toBe(failure);
    expect(f.store.getTask(reference)).not.toBeNull();
  });

  it("invalidates an inventory when the complete remote observation fails", async () => {
    const f = await fixture(), onInventory = vi.fn(), failure = new Error("later inventory page failed");
    vi.mocked(f.remote.ownInventory).mockRejectedValue(failure);
    await expect(createWorkerCoordinator({ ...f.options, onInventory }).tick()).rejects.toBe(failure);
    expect(onInventory).toHaveBeenCalledExactlyOnceWith(null);
    expect(f.herdr.ensureInstance).not.toHaveBeenCalled();
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
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
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
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
  });
});

describe("minimal worker resource reconciliation", () => {
  it("preserves a later active claim and its reused worktree when reconciling old deletion", async () => {
    const f = await fixture(), saved = await deletedArchive(f, true);
    f.store.completeTask(saved.owner);
    const newer = { ...saved.owner, claimId: uuid(1102) };
    f.store.activateTask(f.store.registerPending({ ...newer, agent: "codex" }));
    const directory = f.bind(newer).worktreePath;
    await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, "new-claim.txt"), "new claim");
    expect(reconcileDeletedHerdrResource(f.store, saved.attach().resources()[0]!)).toBe(true);
    expect(f.store.getTask(newer)?.status).toBe("active");
    await expect(access(path.join(directory, "new-claim.txt"))).resolves.toBeUndefined();
    expect(f.store.getCleanupSchedule(saved.owner)).toBeNull();
  });

  it("retains an ended Herdr claim when its durable evidence is missing", async () => {
    const f = await fixture(); f.candidates.splice(0);
    const owner = { projectId: f.project.projectId, taskId: uuid(910), claimId: uuid(911), worktreeId: uuid(912) };
    f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex" }));
    Object.assign(f.herdr, { lifecycle: { responsibilities: () => [], isStopped: () => false } });
    await f.coordinator.tick();
    expect(f.store.getTask(owner)?.status).toBe("active");
    await eventually(() => expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-error" })));
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "stop-unknown" }));
    expect(f.git.removeEmptyReservation).not.toHaveBeenCalled();
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
  });

  it("stops a durable responsibility during shutdown even after all panes disappear", async () => {
    const f = await fixture();
    const owner = { projectId: f.project.projectId, taskId: uuid(920), claimId: uuid(921), worktreeId: uuid(922) };
    f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex" }));
    const stopped: ResourceOwner[] = [];
    Object.assign(f.herdr, { lifecycle: { responsibilities: () => [owner], isStopped: () => stopped.length > 0, stop: async (target: ResourceOwner, reason: string, operation: Operation) => { expect(reason).toBe("shutdown"); expect(operation.limits).toMatchObject({ totalMs: 300_000, requestMs: 300_000 }); stopped.push(target); } } });
    expect(await f.coordinator.shutdown()).toBe(true);
    expect(stopped).toEqual([owner]);
    expect(f.tasks.stopAndClose).not.toHaveBeenCalled();
    expect(f.store.getTask(owner)?.status).toBe("active");
  });

  it("keeps retained journal responsibility visible after losing the primary index and selecting Web", async () => {
    const f = await fixture();
    const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(961), worktreeId: uuid(962) };
    Object.assign(f.herdr, { lifecycle: { responsibilities: () => [owner] } });
    const web = { ...configuration, agentControlMode: "web" as const };
    const coordinator = createWorkerCoordinator({ ...f.options, hasHerdrJournal: true, globalConfiguration: web, repositories: [{ project: f.project, configuration: web }] });
    expect(() => coordinator.assertCanAcquire({ projectId: owner.projectId, taskId: owner.taskId })).toThrow(/archive/);
  });

  it("does not acquire over a retained Git worktree even without durable Herdr ownership", async () => {
    const f = await fixture();
    const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(971), worktreeId: uuid(972) };
    f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    await f.coordinator.tick();
    expect(f.remote.claim).not.toHaveBeenCalled();
    expect(f.worktrees.has(owner.claimId)).toBe(true);
    await f.coordinator.shutdown();
  });

  it("admits a released task after its retained archive and worktree responsibility ends", async () => {
    const f = await fixture(2);
    const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(951), worktreeId: uuid(952) };
    f.candidates[0] = { ...f.candidates[0]!, properties: {} };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex" }));
    f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    let retained = true;
    Object.assign(f.herdr, { lifecycle: { registerClaim: () => {}, responsibilities: () => retained ? [owner] : [], isStopped: () => true, assertCanAdvance: () => {} } });
    await f.coordinator.tick();
    expect(vi.mocked(f.remote.claim).mock.calls.map(([candidate]) => candidate.id)).toEqual([f.candidates[1]!.id]);
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "warning", message: expect.stringMatching(/archive.*worktree|worktree.*archive/i) }));
    expect(f.worktrees.has(owner.claimId)).toBe(true);
    retained = false;
    f.worktrees.delete(owner.claimId);
    await f.coordinator.tick();
    const calls = vi.mocked(f.remote.claim).mock.calls;
    expect(calls.map(([candidate]) => candidate.id)).toEqual([f.candidates[1]!.id, owner.taskId]);
    expect(calls[1]![1].claimId).not.toBe(owner.claimId);
    expect(calls[1]![1].worktreeId).not.toBe(owner.worktreeId);
    await f.coordinator.shutdown();
  });

  it("releases a proven stopped run's slot while preserving its worktree reservation", async () => {
    const f = await fixture();
    const owner = { projectId: f.project.projectId, taskId: uuid(930), claimId: uuid(931), worktreeId: uuid(932) };
    f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex" }));
    f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    Object.assign(f.herdr, { lifecycle: { responsibilities: () => [owner], isStopped: (target: ResourceOwner) => target.claimId === owner.claimId, assertCanAdvance: () => {}, stop: async () => { throw new Error("An already stopped run must not be stopped again"); } } });
    await f.coordinator.tick();
    await eventually(() => expect(f.grants.size).toBe(1));
    expect(f.worktrees.has(owner.claimId)).toBe(true);
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
    expect(f.events.some(event => event.kind === "cleanup-error")).toBe(false);
  });

  it("advances one stopped archive per round and deletes only after its receipt", async () => {
    const f = await fixture();
    f.options.repositories = [];
    const coordinator = createWorkerCoordinator({ ...f.options, hasHerdrJournal: true });
    const owners = [1, 2].map(n => ({ projectId: f.project.projectId, taskId: uuid(970 + n), claimId: uuid(980 + n), worktreeId: uuid(990 + n) }));
    const retained = owners.map((owner, i) => ({ owner, sessionId: uuid(1000 + i), stopped: true, stopEvidence: archiveFixture.runs.map(run => run.stopProof), terminal: true, worktreePath: f.bind(owner).worktreePath, sourcePath: path.join(f.root, `source-${i}`), sourceBytes: "10", state: "pending" as "pending" | "ready", error: null, nextAttemptAt: null, worktreeDeleted: false, disposition: null }));
    for (const owner of owners) { f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex" })); f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) }); }
    let receiptReady = false;
    const archive = { resources: () => retained, advance: vi.fn(async (owner: ResourceOwner) => { if (receiptReady) retained.find(value => value.owner.claimId === owner.claimId)!.state = "ready"; return receiptReady; }), cleaned: (owner: ResourceOwner) => { retained.find(value => value.owner.claimId === owner.claimId)!.worktreeDeleted = true; } };
    Object.assign(f.herdr, { lifecycle: { responsibilities: () => owners.filter(owner => !retained.find(value => value.owner.claimId === owner.claimId)!.worktreeDeleted), isStopped: () => true, archive, registerClaim: () => {}, assertCanAdvance: () => {} } });
    await coordinator.tick();
    await eventually(() => expect(archive.advance).toHaveBeenCalledTimes(1));
    expect(f.worktrees.size).toBe(2);
    receiptReady = true;
    await coordinator.tick();
    await eventually(() => expect(f.worktrees.size).toBe(1));
    expect(archive.advance).toHaveBeenCalledTimes(2);
    await coordinator.tick();
    await eventually(() => expect(f.worktrees.size).toBe(0));
    expect(archive.advance).toHaveBeenCalledTimes(3);
  });

  it("retains archive deletion backoff across coordinator restart without rerunning native cleanup", async () => {
    const f = await fixture(); f.options.repositories = [];
    const owner = { projectId: f.project.projectId, taskId: uuid(975), claimId: uuid(985), worktreeId: uuid(995) };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex" }));
    f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    const retained = { owner, sessionId: uuid(1005), stopped: true, stopEvidence: archiveFixture.runs.map(run => run.stopProof), terminal: true, worktreePath: f.bind(owner).worktreePath, sourcePath: path.join(f.root, "source"), sourceBytes: "10", state: "ready", error: null, nextAttemptAt: null, worktreeDeleted: false, disposition: null };
    const stop = vi.fn(async () => { throw new Error("An archive cannot stop an Agent again"); });
    const archive = { resources: () => [retained], advance: vi.fn(async () => true), cleaned: () => { retained.worktreeDeleted = true; } };
    Object.assign(f.herdr, { lifecycle: { responsibilities: () => retained.worktreeDeleted ? [] : [owner], isStopped: () => true, archive, stop } });
    vi.mocked(f.git.removeWorktree).mockRejectedValueOnce(new Error("Original resource is busy"));
    await f.coordinator.tick();
    await eventually(() => expect(f.store.getCleanupSchedule(owner)?.nextAttemptAt).toBe(6000));
    const recovered = createWorkerCoordinator(f.options);
    f.clock(5999); await recovered.tick();
    expect(archive.advance).toHaveBeenCalledTimes(1); expect(stop).not.toHaveBeenCalled();
    f.clock(6000); await recovered.tick();
    await eventually(() => expect(retained.worktreeDeleted).toBe(true));
    expect(stop).not.toHaveBeenCalled(); expect(archive.advance).toHaveBeenCalledTimes(2);
    expect(f.store.getCleanupSchedule(owner)).toBeNull();
  });

  it("blocks new acquisition by retained resource budgets without restarting stopped claims", async () => {
    const f = await fixture();
    const owner = { projectId: f.project.projectId, taskId: uuid(970), claimId: uuid(980), worktreeId: uuid(990) };
    const record = { owner, sessionId: uuid(1000), stopped: true, stopEvidence: archiveFixture.runs.map(run => run.stopProof), terminal: true, worktreePath: f.bind(owner).worktreePath, sourcePath: path.join(f.root, "source"), sourceBytes: "2147483648", state: "failed", error: "source_corrupt", nextAttemptAt: null, worktreeDeleted: false, disposition: null };
    Object.assign(f.herdr, { lifecycle: { responsibilities: () => [owner], isStopped: () => true, archive: { resources: () => [record], advance: async () => { throw new Error("Failed archives must not retry automatically"); } } } });
    await f.coordinator.tick();
    expect(f.grants.size).toBe(0);
    expect(f.tasks.start).not.toHaveBeenCalled();
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "warning", message: expect.stringMatching(/source budget/) }));
    record.sourceBytes = "0";
    await f.coordinator.tick();
    await eventually(() => expect(f.grants.size).toBe(1));
  });

  it("reserves a stopped run's slot while its active claim is resuming", async () => {
    const f = await fixture();
    const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(941), worktreeId: uuid(942) };
    f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex" }));
    f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    f.grant(f.candidates[0]!, { claimId: owner.claimId, workerId, machine: f.options.machine, platform: "linux", agent: "codex", worktreeId: owner.worktreeId });
    Object.assign(f.herdr, { lifecycle: { responsibilities: () => [owner], isStopped: () => true, assertCanAdvance: () => {}, stop: async () => {} } });
    await f.coordinator.tick();
    expect(f.grants.size).toBe(1);
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
  });
  it("commits active before startup, saves the native ID and reconnects without replay", async () => {
    const f = await fixture(); await f.coordinator.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    await eventually(() => expect(f.store.listTasks()[0]!.sessionId).not.toBeNull());
    const row = f.store.listTasks()[0]!;
    expect(vi.mocked(f.remote.claim).mock.calls[0]![1]).not.toHaveProperty("agentControlMode");
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

  it("waits through native menus beyond the recovery limit and sends once when the same idle turn is released", async () => {
    const f = await fixture(); const limited = { ...configuration, recoveryLimit: 0 };
    const coordinator = createWorkerCoordinator({ ...f.options, globalConfiguration: limited, repositories: [{ project: f.project, configuration: limited }] });
    await coordinator.tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    const pane = f.resources.get(row.claimId)!.panes[0]!; pane.status = "idle";
    const original = f.tasks.submitPrompt.getMockImplementation()!;
    let menuOpen = true;
    f.tasks.submitPrompt.mockImplementation(async (...args) => { if (menuOpen) throw new HerdrInputBlockedError("menu"); return original(...args); });
    for (let attempt = 1; attempt <= 5; attempt++) {
      await coordinator.tick();
      await eventually(() => expect(f.tasks.submitPrompt).toHaveBeenCalledTimes(attempt));
    }
    expect(f.events.filter(event => event.kind === "waiting" && event.message.includes("open menu"))).toHaveLength(1);
    expect(f.events.filter(event => event.kind === "execution-error")).toEqual([]);
    expect(pane).toMatchObject({ status: "idle", stateChangeSeq: 2 });
    menuOpen = false;
    await coordinator.tick(); await eventually(() => expect(f.tasks.submitPrompt).toHaveBeenCalledTimes(6));
    await coordinator.tick();
    expect(f.tasks.submitPrompt).toHaveBeenCalledTimes(6);
    expect(pane.status).toBe("working");
    expect(f.tasks.start).toHaveBeenCalledOnce();
    await coordinator.shutdown();
  });

  it("keeps the original claim and capacity while prompt input is unknown, without spending recovery", async () => {
    const f = await fixture(); const limited = { ...configuration, recoveryLimit: 0 };
    const resource = (scope: "user" | "project" | "worker", scopeId: string) => ({ scope, scopeId, revision: "0", text: "", updatedAt: null });
    let ready = false;
    const demand = vi.fn();
    const coordinator = createWorkerCoordinator({ ...f.options, globalConfiguration: limited, repositories: [{ project: f.project, configuration: limited }], onPromptDemand: demand,
      promptSource: { current: () => ready ? { user: resource("user", uuid(2)), project: resource("project", f.project.projectId), worker: resource("worker", workerId) } : null } });
    await coordinator.tick();
    await eventually(() => expect(f.remote.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ phase: "waiting", herdr: null, nativeSessionId: null }), expect.anything()));
    const original = f.store.listTasks()[0]!;
    for (let attempt = 0; attempt < 4; attempt++) await coordinator.tick();
    expect(f.tasks.start).not.toHaveBeenCalled();
    expect(f.store.listTasks()).toHaveLength(1);
    expect(f.store.getTask(original)).toMatchObject({ claimId: original.claimId, status: "active" });
    expect(f.events.filter(event => event.kind === "execution-error")).toEqual([]);
    expect(demand).toHaveBeenCalledWith([f.project.projectId]);
    expect(await coordinator.advanceRetry(original)).toEqual({ kind: "waiting_input", reason: "prompt_unknown" });
    ready = true;
    await coordinator.tick(); await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    expect(f.store.getTask(original)?.claimId).toBe(original.claimId);
    await coordinator.shutdown();
  });

  it("keeps ordinary visible-read failures in the execution recovery budget", async () => {
    const f = await fixture(); const limited = { ...configuration, recoveryLimit: 0 };
    const coordinator = createWorkerCoordinator({ ...f.options, globalConfiguration: limited, repositories: [{ project: f.project, configuration: limited }] });
    await coordinator.tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    f.resources.get(row.claimId)!.panes[0]!.status = "idle";
    const cause = new HerdrRpcError("visible read failed", { method: "agent.read", requestId: "read", submission: "unknown" });
    const failure = new HerdrAgentActionError("The visible native input could not be read.", "agent.prompt", "not-submitted", { cause, promptSubmission: "not-submitted" });
    f.tasks.submitPrompt.mockRejectedValue(failure);
    await coordinator.tick(); await eventually(() => expect(f.events).toContainEqual(expect.objectContaining({ kind: "execution-error", error: failure })));
    for (let attempt = 0; attempt < 3; attempt++) await coordinator.tick();
    expect(f.tasks.submitPrompt).toHaveBeenCalledOnce();
    await coordinator.shutdown();
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
    await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const old = f.store.listTasks()[0]!;
    f.grants.clear(); f.candidates.splice(0);
    vi.mocked(f.remote.ownInventory).mockRejectedValueOnce(new Error("page 2 failed"));
    await expect(f.coordinator.tick()).rejects.toThrow("page 2 failed");
    expect(f.tasks.stopAndClose).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
    expect(f.store.getTask(old)).toEqual(old);
    expect(f.resources.has(old.claimId)).toBe(true); expect(f.worktrees.has(old.claimId)).toBe(true);
    await f.coordinator.tick();
    await eventually(() => expect(f.store.getTask(old)?.status).toBe("done"));
    expect(f.resources.has(old.claimId)).toBe(false); expect(f.worktrees.has(old.claimId)).toBe(false);
    expect(f.order.slice(-3)).toEqual(["notify", "stop-close", "remove-worktree"]);
  });

  it("does not infer claim absence for a project registered after inventory began", async () => {
    const f = await fixture(); f.candidates.splice(0);
    const onInventory = vi.fn();
    const coordinator = createWorkerCoordinator({ ...f.options, onInventory });
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const requested = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(f.remote.ownInventory).mockImplementationOnce(async projects => {
      expect(projects.map(project => project.projectId)).toEqual([f.project.projectId]);
      entered(); await waiting; return { tasks: [], coveredProjectIds: [f.project.projectId], unavailableProjectIds: [] };
    });
    const tick = coordinator.tick();
    try {
      await requested;
      const project = { projectId: uuid(11), repoUrl: "https://example.test/owner/new.git", localPath: path.join(f.root, "new") };
      f.store.registerProject(project);
      const owner = { projectId: project.projectId, taskId: uuid(210), claimId: uuid(211), worktreeId: uuid(212) };
      const row = f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex" }));
      f.grant(task(project.projectId, owner.taskId), { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex" });
      f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
      const binding = { session: "w", workspaceId: "retained", paneId: "pane", terminalId: "terminal" };
      f.resources.set(owner.claimId, { owner, workspaceId: binding.workspaceId, panes: [{ binding, cwd: f.bind(owner).worktreePath, kind: "codex", status: "working", launchPending: false, interactiveReady: true, nativeSession: { source: "herdr", agent: "codex", sessionId: uuid(213) }, stateChangeSeq: 2, completionSeq: 0 }] });
      release(); await tick;
      expect(f.store.getTask(row)?.status).toBe("active");
      expect(onInventory).toHaveBeenLastCalledWith(null);
      expect(f.tasks.stopAndClose).not.toHaveBeenCalled();
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
      expect(f.resources.has(owner.claimId)).toBe(true);
      expect(f.worktrees.has(owner.claimId)).toBe(true);
      await coordinator.tick();
      expect(vi.mocked(f.remote.ownInventory).mock.calls[1]![0].map(item => item.projectId)).toContain(project.projectId);
      expect(f.store.getTask(row)?.status).toBe("active");
      expect(onInventory).toHaveBeenCalledTimes(2);
      expect(onInventory.mock.calls[1]![0].claims).toEqual([{ projectId: project.projectId, taskId: owner.taskId, claimId: owner.claimId }]);
      expect(f.tasks.stopAndClose).not.toHaveBeenCalled();
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
    } finally { release(); await tick; }
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
    expect(f.git.prepareWorktree).toHaveBeenCalledOnce();
    expect(f.remote.claim).toHaveBeenCalledOnce();
  });

  it("cold-resumes a recorded native session with its frozen native configuration", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const old = f.store.listTasks()[0]!; f.resources.clear();
    const current = { ...configuration, model: "updated-model" }; const restarted = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: current }], globalConfiguration: current });
    await restarted.tick(); await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(2));
    expect(f.tasks.start.mock.calls[1]![2]).toMatchObject({ resumeSessionId: old.sessionId, configuration });
    expect(f.store.getTask(old)?.sessionId).toBe(old.sessionId);
  });

  it("recovers a frozen Herdr claim while the new Web project configuration is unavailable", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const old = f.store.listTasks()[0]!; f.resources.clear();
    const restarted = createWorkerCoordinator({ ...f.options, repositories: [], readyProjectIds: [f.project.projectId], targetProjectIds: [f.project.projectId], globalConfiguration: { ...configuration, agentControlMode: "web", model: "new-model", recoveryLimit: 5 } });
    await restarted.tick(); await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(2));
    expect(f.tasks.start.mock.calls[1]![2]).toMatchObject({ resumeSessionId: old.sessionId, configuration: { ...configuration, agentControlMode: "herdr", recoveryLimit: 5 } });
    expect(f.store.getTask(old)).toMatchObject({ claimId: old.claimId, sessionId: old.sessionId });
  });

  it.each(["authorized", "paused", "revoked", "other-worker", "other-worktree"] as const)("restores only an authorized pending claim's original daemon before capacity admission (%s)", async state => {
    const f = await fixture(0), candidate = f.candidates[0]!; f.candidates.splice(0);
    const descriptor = { claimId: uuid(981), workerId, machine: f.options.machine, platform: "linux" as const, agent: "codex" as const, worktreeId: uuid(982) };
    const granted = f.grant(candidate, descriptor);
    const herdrLaunch = { ...frozenToolLaunch("codex", "herdr"), tool: "herdr" as const }; herdrLaunch.selectionKey = toolSelectionKey(herdrLaunch);
    const frozen = { ...configuration, herdrLaunch };
    const pending = f.store.registerPending({ projectId: granted.projectId, taskId: granted.id, claimId: descriptor.claimId, agent: "codex", nativeConfiguration: frozen });
    vi.mocked(f.herdr.ensureInstance).mockRejectedValue(new Error("The original daemon is stopped."));
    const restore = vi.fn(async (_context: Pick<HerdrExecutionContext, "claimId" | "worktreeId" | "projectId" | "taskId" | "agent">, _operation: Operation) => ({ reconnected: false, version: "0.9.5", protocol: 22 as const, snapshot: {} }));
    f.herdr.ensureExecution = restore;
    let fresh = structuredClone(granted);
    if (state === "paused") fresh = { ...fresh, properties: { ...fresh.properties, paused: true } };
    if (state === "revoked") fresh = { ...fresh, allowAgents: false };
    if (state === "other-worker" || state === "other-worktree") fresh = { ...fresh, properties: { ...fresh.properties, worker: { ...readWorkerClaim(fresh.properties)!, ...(state === "other-worker" ? { workerId: uuid(983) } : { worktreeId: uuid(984) }) } } };
    vi.mocked(f.remote.readTask).mockResolvedValue(fresh);
    if (state === "authorized") await f.coordinator.tick();
    else await expect(f.coordinator.tick()).rejects.toThrow("The original daemon is stopped.");
    expect(restore).toHaveBeenCalledTimes(state === "authorized" ? 1 : 0);
    if (state === "authorized") expect(restore.mock.calls[0]![0]).toEqual({ claimId: descriptor.claimId, worktreeId: descriptor.worktreeId, projectId: granted.projectId, taskId: granted.id, agent: "codex" });
    expect(f.store.getTask(pending)?.status).toBe("pending");
    expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.git.prepareWorktree).not.toHaveBeenCalled(); expect(f.remote.claim).not.toHaveBeenCalled();
  });

  const reservedConfiguration = (): ExecutionConfiguration => {
    const herdrLaunch = { ...frozenToolLaunch("codex", "herdr"), tool: "herdr" as const }; herdrLaunch.selectionKey = toolSelectionKey(herdrLaunch);
    return { ...configuration, agentControlMode: "herdr", herdrLaunch, toolLaunch: frozenToolLaunch("codex", "herdr") };
  };

  it("retains the reserved configuration through an outstanding grant and later capacity change", async () => {
    const f = await fixture(), frozen = reservedConfiguration();
    const runner = createWorkerCoordinator({ ...f.options, freezeConfiguration: async () => frozen, reserveClaimTools: async reservation => { f.store.reserveClaimTools(reservation); } });
    vi.mocked(f.remote.claim).mockImplementationOnce(async (candidate, descriptor) => {
      expect(f.store.listTasks()).toEqual([]);
      expect(f.store.listClaimToolReservations()).toEqual([expect.objectContaining({ taskId: candidate.id, claimId: descriptor.claimId, worktreeId: descriptor.worktreeId, version: candidate.version, nativeConfiguration: expect.objectContaining({ herdrLaunch: frozen.herdrLaunch }) })]);
      runner.updateConfiguration({ ...f.options, maxConcurrent: 0, repositories: [{ project: f.project, configuration: { ...configuration, model: "new-target" } }] });
      return f.grant(candidate, descriptor);
    });
    await runner.tick();
    const local = f.store.listTasks()[0]!;
    expect(local.status).toBe("pending"); expect(f.store.getNativeConfiguration(local)).toMatchObject({ model: configuration.model, herdrLaunch: frozen.herdrLaunch });
    expect(f.store.listClaimToolReservations()).toEqual([]); expect(f.tasks.start).not.toHaveBeenCalled();
  });

  it.each(["inventory", "task-read"] as const)("recovers an unknown grant's original reservation through %s without replaying its request", async discovery => {
    const f = await fixture(), frozen = reservedConfiguration();
    const runner = createWorkerCoordinator({ ...f.options, freezeConfiguration: async () => frozen, reserveClaimTools: async reservation => { f.store.reserveClaimTools(reservation); } });
    vi.mocked(f.remote.claim).mockImplementationOnce(async (candidate, descriptor) => { f.grant(candidate, descriptor); throw new Error("Response lost after commit."); });
    await runner.tick();
    const original = f.store.listClaimToolReservations()[0]!;
    expect(f.store.listTasks()).toEqual([]); expect(original.nativeConfiguration.herdrLaunch).toEqual(frozen.herdrLaunch);
    if (discovery === "task-read") vi.mocked(f.remote.ownInventory).mockResolvedValue({ tasks: [], coveredProjectIds: [f.project.projectId], unavailableProjectIds: [] });
    const restarted = createWorkerCoordinator({ ...f.options, maxConcurrent: 0, repositories: [{ project: f.project, configuration: { ...configuration, model: "replacement" } }] });
    await restarted.tick();
    expect(f.store.listClaimToolReservations()).toEqual([]); expect(f.store.getTask(original)?.status).toBe("pending");
    expect(f.store.getNativeConfiguration(original)).toEqual(original.nativeConfiguration);
    expect(f.remote.claim).toHaveBeenCalledOnce(); expect(f.tasks.start).not.toHaveBeenCalled();
  });

  it.each(["same-version", "read-failed", "newer-version", "conflicting-owner"] as const)("reconciles an absent unknown request only with decisive original-task evidence (%s)", async evidence => {
    const f = await fixture(), frozen = reservedConfiguration(), candidate = f.candidates[0]!; f.candidates.splice(1);
    const runner = createWorkerCoordinator({ ...f.options, freezeConfiguration: async () => frozen, reserveClaimTools: async reservation => { f.store.reserveClaimTools(reservation); } });
    vi.mocked(f.remote.claim).mockRejectedValue(new Error("Unknown request result."));
    await runner.tick();
    const original = f.store.listClaimToolReservations()[0]!; f.candidates.splice(0);
    if (evidence === "read-failed") vi.mocked(f.remote.readTask).mockRejectedValue(new Error("Task read unavailable."));
    else if (evidence === "conflicting-owner") {
      const conflict = f.grant(candidate, { claimId: original.claimId, worktreeId: original.worktreeId, workerId: uuid(999), machine: f.options.machine, platform: "linux", agent: "codex" });
      f.grants.clear(); vi.mocked(f.remote.readTask).mockResolvedValue(conflict);
    } else vi.mocked(f.remote.readTask).mockResolvedValue({ ...candidate, version: candidate.version + (evidence === "newer-version" ? 1n : 0n) });
    await createWorkerCoordinator({ ...f.options, maxConcurrent: 0 }).tick();
    expect(f.store.listClaimToolReservations()).toEqual(evidence === "newer-version" ? [] : [original]);
    expect(f.store.listTasks()).toEqual([]); expect(f.remote.claim).toHaveBeenCalledOnce(); expect(f.tasks.start).not.toHaveBeenCalled();
  });

  it("releases a deleted unknown claim reservation so the shared Herdr selection can switch", async () => {
    const f = await fixture(), operation = createOperation({ limits: { totalMs: 10_000 } }), paths = resolveWorkerPaths(f.root);
    const instancePaths = { ...resolveHerdrInstancePaths({ herdrDirectory: "/state/h", logsDirectory: "/state/logs" }), privateDirectory: paths.herdrDirectory, configurationFile: path.join(paths.herdrDirectory, "config.toml"), sessionDirectory: path.join(paths.herdrDirectory, "sessions") };
    const launch = async (label: string) => {
      const file = path.join(f.root, `herdr-${label}`), body = Buffer.from(`\x7fELF${label}`);
      await writeFile(file, body, { mode: 0o700 });
      const value = { ...reservedConfiguration().herdrLaunch!, entryPath: file, canonicalEntryPath: file, executablePath: file, command: { file, prefixArgs: [] }, artifacts: [{ role: "entry" as const, path: file, realPath: file, size: String(body.length), sha256: createHash("sha256").update(body).digest("hex") }] };
      return { ...value, selectionKey: toolSelectionKey(value) };
    };
    const a = await launch("A"), b = await launch("B"), frozen = { ...reservedConfiguration(), herdrLaunch: a };
    let nextPid = 1000, endpoint = false;
    const processes = new Map<number, { proof: processProof.ProcessProof; running: boolean }>(), transitions: string[] = [];
    const shared = createSharedWorkerHerdr({ paths, homeDirectory: f.root,
      hasResponsibilities: () => f.store.listUnfinishedTasks().some(task => task.agentControlMode === "herdr") || f.store.listClaimToolReservations().some(reservation => reservation.agentControlMode === "herdr"),
      confirmMappingsStopped: async () => true, inspectEndpoints: async () => ({ api: endpoint, client: endpoint }),
      captureProcess: async pid => processes.get(pid)!.proof,
      inspectProcess: async proof => processes.get(proof.pid)?.running ? "running" : "stopped",
      instanceFactory: options => {
        const key = options.herdrLaunch?.selectionKey ?? "legacy"; let pid: number | undefined;
        const ready = () => ({ reconnected: false, protocol: 22 as const, version: "0.9.9", snapshot: {} });
        return { ...f.herdr, paths: instancePaths,
          ensureInstance: async () => { pid = nextPid++; processes.set(pid, { proof: { pid, parentPid: 1, processGroupId: pid, startedAt: `birth-${pid}`, commandHash: "a".repeat(64) }, running: true }); endpoint = true; transitions.push(`start:${key}`); await options.onDaemonSpawn?.(pid); return ready(); },
          connectInstance: async () => ready(),
          stopInstance: async () => { if (pid !== undefined) processes.get(pid)!.running = false; endpoint = false; transitions.push(`stop:${key}`); return { apiClosed: true, clientClosed: true, ownedChildClosed: true }; },
        } as WorkerHerdrAdapter;
      },
    });
    try {
      await expect(shared.prepareSelection(a, operation)).resolves.toMatchObject({ state: "applied" });
      f.candidates.splice(1);
      vi.mocked(f.remote.claim).mockRejectedValue(new ApiError({ operation: "worker.claim" }, "request", { cause: new Error("Response lost before grant was known."), outcomeUnconfirmed: true }));
      const runner = createWorkerCoordinator({ ...f.options, freezeConfiguration: async () => frozen, reserveClaimTools: async reservation => { f.store.reserveClaimTools(reservation); } });
      await runner.tick();
      const original = f.store.listClaimToolReservations()[0]!;
      expect(original.nativeConfiguration.herdrLaunch).toEqual(a); expect(f.store.listTasks()).toEqual([]);
      await expect(shared.prepareSelection(b, operation)).resolves.toEqual({ state: "pending", reason: "active_instance" });
      f.candidates.splice(0);
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: "task_deleted", message: "Task was deleted.", requestId: "deleted-task-read" } }), { status: 410, headers: { "content-type": "application/json" } }));
      vi.mocked(f.remote.readTask).mockImplementation(async (projectId, taskId, signal) => {
        const read = createOperation({ signal });
        try { return await createApiClient({ serverUrl: origin, operation: read, fetch }).getTask(projectId, taskId); }
        finally { read.dispose(); }
      });
      await createWorkerCoordinator({ ...f.options, maxConcurrent: 0 }).tick();
      expect(fetch).toHaveBeenCalledOnce(); expect(String(fetch.mock.calls[0]![0])).toBe(`${origin}/api/v1/projects/${original.projectId}/tasks/${original.taskId}`);
      expect(f.store.listClaimToolReservations()).toEqual([]);
      await expect(shared.prepareSelection(b, operation)).resolves.toMatchObject({ state: "applied" });
      expect(transitions).toEqual([`start:${a.selectionKey}`, `stop:${a.selectionKey}`, `start:${b.selectionKey}`]);
      expect(f.store.listTasks()).toEqual([]); expect(f.remote.claim).toHaveBeenCalledOnce();
      expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.git.prepareWorktree).not.toHaveBeenCalled();
    } finally { operation.dispose(); }
  });

  it.each(["wrong-status", "wrong-code", "wrong-project", "wrong-task", "wrong-operation", "wrong-phase", "unconfirmed", "not-confirmed", "untyped", "incomplete-inventory", "invalidated", "cancelled"] as const)("retains a deleted unknown claim reservation without trusted current evidence (%s)", async evidence => {
    const f = await fixture(), frozen = reservedConfiguration(); f.candidates.splice(1);
    vi.mocked(f.remote.claim).mockRejectedValue(new Error("Unknown ungranted request."));
    await createWorkerCoordinator({ ...f.options, freezeConfiguration: async () => frozen, reserveClaimTools: async reservation => { f.store.reserveClaimTools(reservation); } }).tick();
    const original = f.store.listClaimToolReservations()[0]!; f.candidates.splice(0);
    const cancellation = new AbortController(), runner = createWorkerCoordinator({ ...f.options, maxConcurrent: 0, signal: cancellation.signal });
    const failure = new ApiError({ operation: evidence === "wrong-operation" ? "task.delete" : "task.show", projectId: evidence === "wrong-project" ? uuid(990) : original.projectId, taskId: evidence === "wrong-task" ? uuid(991) : original.taskId }, evidence === "wrong-phase" ? "protocol" : "response", {
      cause: new Error("Deleted task response"), status: evidence === "wrong-status" ? 404 : 410, serverError: { code: evidence === "wrong-code" ? "not_found" : "task_deleted", message: "Deleted task", requestId: "deletion-proof" }, confirmedRefusal: evidence !== "not-confirmed", outcomeUnconfirmed: evidence === "unconfirmed",
    });
    vi.mocked(f.remote.readTask).mockImplementation(async () => {
      if (evidence === "invalidated") runner.invalidateProject(original.projectId);
      if (evidence === "cancelled") cancellation.abort(new Error("Worker cancelled before its read returned."));
      throw evidence === "untyped" ? Object.assign(new Error("Untrusted deletion"), { ...failure }) : failure;
    });
    if (evidence === "incomplete-inventory") vi.mocked(f.remote.ownInventory).mockResolvedValue({ tasks: [], coveredProjectIds: [], unavailableProjectIds: [original.projectId] });
    const result = await runner.tick().then(() => null, error => error);
    if (result !== null) expect(isWorkerCancellation(result, cancellation.signal)).toBe(true);
    expect(f.store.listClaimToolReservations()).toEqual([original]); expect(f.store.listTasks()).toEqual([]);
    expect(f.remote.claim).toHaveBeenCalledOnce(); expect(f.tasks.start).not.toHaveBeenCalled();
    if (evidence === "incomplete-inventory") expect(f.remote.readTask).not.toHaveBeenCalled();
  });

  it("releases a reservation for a confirmed claim refusal", async () => {
    const f = await fixture(), frozen = reservedConfiguration();
    const runner = createWorkerCoordinator({ ...f.options, freezeConfiguration: async () => frozen, reserveClaimTools: async reservation => { f.store.reserveClaimTools(reservation); } });
    vi.mocked(f.remote.claim).mockRejectedValue(new ApiError({ operation: "claimWorkerTask" }, "response", { cause: new Error("Rejected"), status: 409, confirmedRefusal: true }));
    await runner.tick();
    expect(f.store.listClaimToolReservations()).toEqual([]); expect(f.store.listTasks()).toEqual([]); expect(f.tasks.start).not.toHaveBeenCalled();
  });

  it.each(["prepare", "request", "unknown", "confirmed-write"] as const)("preserves the API submission classification for a claim reservation (%s)", async outcome => {
    const f = await fixture(), frozen = reservedConfiguration();
    const runner = createWorkerCoordinator({ ...f.options, freezeConfiguration: async () => frozen, reserveClaimTools: async reservation => { f.store.reserveClaimTools(reservation); } });
    vi.mocked(f.remote.claim).mockRejectedValue(new ApiError({ operation: "claimWorkerTask" }, outcome === "prepare" ? "prepare" : "request", {
      cause: new Error("Request interrupted"), outcomeUnconfirmed: outcome === "unknown", ...(outcome === "confirmed-write" ? { confirmedMutationId: uuid(986) } : {}),
    }));
    await runner.tick();
    expect(f.store.listClaimToolReservations()).toHaveLength(outcome === "unknown" || outcome === "confirmed-write" ? 1 : 0);
    expect(f.store.listTasks()).toEqual([]); expect(f.tasks.start).not.toHaveBeenCalled();
  });

  it("releases an unsubmitted reservation when configuration changes during admission", async () => {
    const f = await fixture(), frozen = reservedConfiguration();
    const runner = createWorkerCoordinator({ ...f.options, freezeConfiguration: async () => frozen, reserveClaimTools: async reservation => {
      f.store.reserveClaimTools(reservation); runner.updateConfiguration({ ...f.options, maxConcurrent: 0 });
    } });
    await runner.tick();
    expect(f.store.listClaimToolReservations()).toEqual([]); expect(f.remote.claim).not.toHaveBeenCalled(); expect(f.tasks.start).not.toHaveBeenCalled();
  });

  it("does not reinterpret an unfrozen historical Herdr claim with Web parameters", async () => {
    const f = await fixture(); const candidate = f.candidates[0]!; f.candidates.splice(0);
    const task = f.grant(candidate, { claimId: uuid(991), workerId, machine: f.options.machine, platform: "linux", agent: "codex", worktreeId: uuid(992) });
    const active = f.store.activateTask(f.store.registerPending({ projectId: task.projectId, taskId: task.id, claimId: uuid(991), agent: "codex" }));
    const current = { ...configuration, agentControlMode: "web" as const };
    const restarted = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: current }], globalConfiguration: current });
    await expect(restarted.advanceRetry(active)).rejects.toThrow("Native configuration is unavailable");
    expect(f.tasks.start).not.toHaveBeenCalled();
  });

  it.each([false, true])("starts fresh after an interrupted NULL-session launch with frozen native settings=%s", async frozen => {
    const f = await fixture(); f.candidates.splice(0);
    const granted = f.grant(task(f.project.projectId, uuid(200)), { claimId: uuid(201), workerId, machine: f.options.machine, platform: "linux", agent: "codex", worktreeId: uuid(202) });
    f.store.registerPending({ projectId: granted.projectId, taskId: granted.id, claimId: uuid(201), agent: "codex" });
    const active = f.store.activateTask({ projectId: granted.projectId, taskId: granted.id, claimId: uuid(201) });
    const owner = { projectId: granted.projectId, taskId: granted.id, claimId: uuid(201), worktreeId: uuid(202) };
    f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    if (frozen) f.store.freezeNativeConfiguration(active, configuration);
    const current = { ...configuration, model: "updated-model" };
    const restarted = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: current }], globalConfiguration: current });
    await restarted.tick(); await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    expect(f.tasks.start.mock.calls[0]![2]).not.toHaveProperty("resumeSessionId");
    expect(f.tasks.start.mock.calls[0]![2].configuration).toEqual({ ...(frozen ? configuration : current), agentControlMode: "herdr" });
    expect(f.store.getNativeConfiguration(active)?.model).toBe(frozen ? configuration.model : current.model);
    expect(f.events).toContainEqual({ kind: "info", task: active, message: "Starting a new native conversation in the task worktree." });
    expect(f.events.some((event) => event.kind === "warning")).toBe(false);
  });

  it.each([false, true])("cleans an ended claim in stop/close/delete order and retains history when paused=%s", async (paused) => {
    const f = await fixture(); f.candidates[0] = { ...f.candidates[0]!, properties: { ...f.candidates[0]!.properties, paused } };
    await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const old = f.store.listTasks()[0]!; f.grants.clear(); f.candidates.splice(0);
    await f.coordinator.tick(); await eventually(() => expect(f.store.getTask(old)?.status).toBe("done"));
    expect(f.order.slice(-3)).toEqual(["notify", "stop-close", "remove-worktree"]);
    expect(f.store.getTask(old)?.sessionId).toBe(old.sessionId);
    expect(polling.requested).toEqual([1_000]);
  });

  it("clips cleanup polling to the actual remaining deadline", async () => {
    const f = await fixture();
    await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const row = f.store.listTasks()[0]!;
    f.grants.clear(); f.candidates.splice(0);
    f.tasks.submitPrompt.mockImplementation(async (context, binding) => {
      f.order.push("notify");
      return { submission: "submitted", observation: { ...f.resources.get(context.claimId)!.panes[0]!, name: "managed", binding } };
    });
    polling.onSchedule = milliseconds => {
      if (milliseconds === 1_000) f.clock(600_863);
      else if (milliseconds === 137) f.clock(601_001);
    };
    await f.coordinator.tick(); await eventually(() => expect(f.store.getTask(row)?.status).toBe("done"));
    expect(polling.requested).toEqual([1_000, 137]);
    expect(f.order.slice(-3)).toEqual(["notify", "stop-close", "remove-worktree"]);
    expect(f.tasks.submitPrompt).toHaveBeenCalledOnce();
  });

  it("holds a newer same-task claim pending until old resources are removed", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const old = f.store.listTasks()[0]!; f.grants.clear(); f.candidates.splice(0);
    const newer = f.grant(task(old.projectId, old.taskId), { claimId: uuid(400), workerId, machine: f.options.machine, platform: "linux", agent: "codex", worktreeId: uuid(401) });
    await f.coordinator.tick(); expect(f.store.getTask({ ...old, claimId: uuid(400) })?.status).toBe("pending");
    await eventually(() => expect(f.store.getTask(old)?.status).toBe("done"));
    await eventually(() => expect(f.store.getCleanupSchedule(old)).toBeNull());
    const newOwner = { projectId: newer.projectId, taskId: newer.id, claimId: uuid(400), worktreeId: uuid(401) };
    f.worktrees.set(newOwner.claimId, { owner: newOwner, binding: f.bind(newOwner) });
    await f.coordinator.tick(); await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(2));
    expect(f.store.getTask({ projectId: newer.projectId, taskId: newer.id, claimId: uuid(400) })?.status).toBe("active");
  });

  it("starts the next project's task only after the previous task releases its sole slot", async () => {
    const f = await fixture(1);
    const second: WorkerProject = { projectId: uuid(20), repoUrl: "https://example.test/owner/second.git", localPath: path.join(f.root, "second") };
    f.store.registerProject(second); f.options.repositories.push({ project: second, configuration });
    f.candidates.splice(1, 1, task(second.projectId, uuid(200)));
    f.coordinator.updateConfiguration(f.options);
    await f.coordinator.tick();
    await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const first = f.store.listTasks()[0]!;
    expect(first.projectId).toBe(f.project.projectId);
    let release!: () => void;
    const stopped = new Promise<void>(resolve => { release = resolve; });
    const stop = f.tasks.stopAndClose.getMockImplementation()!;
    f.tasks.stopAndClose.mockImplementation(async (...args) => { await stopped; return stop(...args); });
    try {
      f.grants.clear(); f.candidates.shift();
      await f.coordinator.tick();
      await eventually(() => expect(f.tasks.stopAndClose).toHaveBeenCalledOnce());
      await f.coordinator.tick();
      expect(f.remote.claim).toHaveBeenCalledOnce();
      expect(f.tasks.start).toHaveBeenCalledOnce();
      expect(f.worktrees.has(first.claimId)).toBe(true);
      release();
      await eventually(() => expect(f.store.getTask(first)?.status).toBe("done"));
      await f.coordinator.tick();
      await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(2));
      expect(vi.mocked(f.remote.claim).mock.calls.map(([candidate]) => candidate.projectId)).toEqual([f.project.projectId, second.projectId]);
      expect(f.order.indexOf("remove-worktree")).toBeLessThan(f.order.lastIndexOf("start"));
      expect(f.worktrees.has(first.claimId)).toBe(false);
    } finally { release(); await f.coordinator.shutdown(); }
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
    vi.mocked(f.remote.ownInventory).mockResolvedValue({ tasks: [...f.grants.values()], coveredProjectIds: f.store.listProjects().map(project => project.projectId), unavailableProjectIds: [] });
    await createWorkerCoordinator(f.options).tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(2));
    expect(f.tasks.start.mock.calls[1]![2]).toMatchObject({ resumeSessionId: old.sessionId });
    expect(f.store.getTask(old)).toEqual(old);
  });

  it.each([null, uuid(900)])("retains the original claim across shutdown and resume when assignedTo becomes %s", async (assignedTo) => {
    const f = await fixture();
    await f.coordinator.tick();
    await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const old = f.store.listTasks()[0]!;
    const original = f.grants.get(old.claimId)!;
    f.grants.set(old.claimId, { ...original, assignedTo });
    await expect(f.coordinator.shutdown()).resolves.toBe(true);
    expect(f.store.getTask(old)).toEqual(old);
    expect(f.worktrees.has(old.claimId)).toBe(true);
    await createWorkerCoordinator(f.options).tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(2));
    expect(f.tasks.start.mock.calls[1]![2]).toMatchObject({ resumeSessionId: old.sessionId });
    expect(f.remote.claim).toHaveBeenCalledOnce();
    expect(f.store.getTask(old)).toEqual(old);
    expect(f.grants.get(old.claimId)?.assignedTo).toBe(assignedTo);
  });

  it("cancels terminal cleanup before a pending reporter join and preserves its resources for shutdown", async () => {
    const f = await fixture(), cancellation = new AbortController();
    const coordinator = createWorkerCoordinator({ ...f.options, signal: cancellation.signal });
    await coordinator.tick();
    await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    f.grants.clear(); f.candidates.splice(0);
    f.tasks.submitPrompt.mockImplementation(async (context, binding) => ({
      submission: "submitted", observation: { ...f.resources.get(context.claimId)!.panes[0]!, name: "managed", binding },
    }));
    await coordinator.tick();
    await eventually(() => expect(f.tasks.submitPrompt).toHaveBeenCalledOnce());
    f.resources.get(row.claimId)!.panes[0]!.status = "idle";
    let releaseObservation!: () => void;
    const observation = new Promise<void>(resolve => { releaseObservation = resolve; });
    let pendingOperation: Operation | undefined;
    vi.mocked(f.herdr.tasks.listResources).mockImplementationOnce(async operation => {
      pendingOperation = operation;
      await observation; operation.check();
      return structuredClone([...f.resources.values()]);
    });
    await eventually(() => expect(pendingOperation).toBeDefined());
    let releaseSample!: (value: WorkerTelemetrySample) => void;
    const sample = new Promise<WorkerTelemetrySample>(resolve => { releaseSample = resolve; });
    const reporter = createWorkerReporter({ signal: cancellation.signal, collect: async () => sample,
      send: vi.fn(), emit: vi.fn(),
    });
    const shutdown = vi.spyOn(coordinator, "shutdown");
    let joined = false;
    const closing = (async () => { await reporter.stop(); joined = true; return coordinator.shutdown(); });
    let close: Promise<boolean> | undefined;
    try {
      cancellation.abort(new Error("Worker interrupted while native telemetry is joining."));
      close = closing();
      expect(pendingOperation!.signal.aborted).toBe(true);
      const observationDisposed = vi.spyOn(pendingOperation!, "dispose");
      releaseObservation();
      await eventually(() => expect(observationDisposed).toHaveBeenCalledOnce());
      await coordinator.tick();
      expect(joined).toBe(false); expect(shutdown).not.toHaveBeenCalled();
      expect(f.tasks.stopAndClose).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
      expect(f.store.getTask(row)).toEqual(row); expect(f.worktrees.has(row.claimId)).toBe(true);
      releaseSample({ telemetry: workerTelemetry, issues: [] });
      await expect(close).resolves.toBe(true);
      expect(f.tasks.stopAndClose).toHaveBeenCalledOnce(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
      expect(f.store.getTask(row)).toEqual(row); expect(f.worktrees.has(row.claimId)).toBe(true);
      expect(f.resources.size).toBe(0); expect(f.events.some(event => event.kind === "cleanup-error")).toBe(false);
    } finally {
      cancellation.abort(); releaseObservation(); releaseSample({ telemetry: workerTelemetry, issues: [] });
      if (close === undefined) close = closing();
      await close;
    }
  });

  it("detaches root cancellation after shutdown and ignores a cancelled coordinator's ticks", async () => {
    const f = await fixture(), cancellation = new AbortController();
    const remove = vi.spyOn(cancellation.signal, "removeEventListener");
    const coordinator = createWorkerCoordinator({ ...f.options, signal: cancellation.signal });
    cancellation.abort();
    await coordinator.tick();
    expect(f.remote.ownInventory).not.toHaveBeenCalled(); expect(f.remote.claim).not.toHaveBeenCalled();
    await expect(coordinator.shutdown()).resolves.toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
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
    const f = await fixture(2); await f.coordinator.tick(); await f.coordinator.tick();
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
    await f.coordinator.tick();
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "warning", message: expect.stringContaining("Restore the project configuration") }));
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

  it("uses fresh pause state despite stale inventory and preserves a zero recovery budget", async () => {
    const f = await fixture();
    const limited = { ...configuration, recoveryLimit: 0 };
    const coordinator = createWorkerCoordinator({ ...f.options, globalConfiguration: limited, repositories: [{ project: f.project, configuration: limited }] });
    await coordinator.tick();
    await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const stale = [...f.grants.values()];
    let current: Task = { ...stale[0]!, properties: { ...stale[0]!.properties, paused: true } };
    vi.mocked(f.remote.ownInventory).mockResolvedValue({ tasks: stale, coveredProjectIds: [f.project.projectId], unavailableProjectIds: [] });
    vi.mocked(f.remote.readTask).mockReset().mockImplementation(async () => current);
    const pane = [...f.resources.values()][0]!.panes[0]!;
    pane.status = "idle"; pane.stateChangeSeq = 3; pane.completionSeq = 1;

    for (let patrol = 1; patrol <= 3; patrol++) {
      await coordinator.tick();
      await eventually(() => expect(vi.mocked(f.remote.readTask).mock.calls.length).toBeGreaterThanOrEqual(patrol));
    }
    expect(f.order.filter((entry) => entry === "notify")).toEqual([]);
    expect(f.events.some((event) => event.kind === "execution-error")).toBe(false);
    expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
    current = { ...current, properties: Object.fromEntries(Object.entries(current.properties).filter(([name]) => name !== "paused")) };
    await eventually(async () => { await coordinator.tick(); expect(f.order.filter((entry) => entry === "notify")).toHaveLength(1); });
    expect(f.tasks.submitPrompt.mock.calls.at(-1)![2]).toContain("worker's periodic check");
    expect(f.tasks.start).toHaveBeenCalledOnce();
  });

  it("preserves the original cleanup deadline and reobserves resources after an interrupted driver", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const row = f.store.listTasks()[0]!; const owner = f.worktrees.get(row.claimId)!.owner;
    f.tasks.submitPrompt.mockImplementation(async (context, binding) => ({ submission: "submitted", observation: { ...f.resources.get(context.claimId)!.panes[0]!, name: "managed", binding } }));
    const deps = { store: f.store, git: f.git, herdr: f.herdr, platform: "linux" as const, serverOrigin: origin, workerId, buildPrompt: f.options.buildPrompt, emit: f.options.emit, now: f.options.now };
    ensureCleanupSchedule(f.store, owner, f.options.now());
    const cancellation = new AbortController();
    polling.onSchedule = () => cancellation.abort(new Error("Worker interrupted while observing cleanup."));
    await expect(createCleanupDriver(deps).advance({ task: row, project: f.project, owner }, { kind: "terminal", deadline: 601_000, immediateStop: false, signal: cancellation.signal, scope: { attempt: { owner, attemptId: "test" }, onExecutionStopped: () => {} } })).rejects.toThrow();
    expect(f.store.getCleanupSchedule(owner)?.deadline).toBe(601_000);
    polling.onSchedule = undefined;
    f.clock(602_000);
    await createCleanupDriver(deps).advance({ task: row, project: f.project, owner }, { kind: "terminal", deadline: 601_000, immediateStop: false, scope: { attempt: { owner, attemptId: "test" }, onExecutionStopped: () => {} } });
    expect(f.tasks.submitPrompt).toHaveBeenCalledOnce();
    expect(f.tasks.stopAndClose).toHaveBeenCalledOnce();
    expect(f.resources.has(owner.claimId)).toBe(false);
    expect(f.worktrees.has(owner.claimId)).toBe(false);
  });

  it("cleans actual resources left behind a historical done row", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const old = f.store.listTasks()[0]!; f.store.completeTask(old); f.grants.clear(); f.candidates.splice(0);
    await f.coordinator.tick();
    expect(f.remote.claim).toHaveBeenCalledOnce();
    await eventually(() => expect(f.resources.size).toBe(0));
    expect(f.store.getTask(old)?.status).toBe("done");
    expect(vi.mocked(f.git.removeWorktree).mock.calls.filter(([, owner]) => owner.claimId === old.claimId)).toHaveLength(1);
  });

  it.each(["pending", "active"] as const)("does not guess an identity-only %s claim's old directory", async status => {
    const f = await fixture();
    const local = f.store.registerPending({ projectId: f.project.projectId, taskId: uuid(700), claimId: uuid(701), agent: "codex" });
    if (status === "active") f.store.activateTask(local);
    const unrelated = path.join(f.project.localPath, ".worktrees", "daynight", local.taskId, "remaining");
    await mkdir(path.dirname(unrelated), { recursive: true }); await writeFile(unrelated, "retain");
    try {
      await f.coordinator.tick();
      await eventually(() => expect(f.store.getTask(local)?.status).toBe("done"));
      expect(f.git.removeEmptyReservation).not.toHaveBeenCalled();
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
      await access(unrelated);
    } finally { await f.coordinator.shutdown(); }
  });

  it("releases an old identity-only claim after observing the same task's recognized replacement worktree", async () => {
    const f = await fixture();
    const old = f.store.registerPending({ projectId: f.project.projectId, taskId: uuid(700), claimId: uuid(701), agent: "codex" });
    f.store.activateTask(old);
    const replacement = { projectId: old.projectId, taskId: old.taskId, claimId: uuid(702), worktreeId: uuid(703) };
    f.grant(task(old.projectId, old.taskId), { claimId: replacement.claimId, worktreeId: replacement.worktreeId, workerId, agent: "codex", machine: f.options.machine, platform: "linux" });
    f.worktrees.set(replacement.claimId, { owner: replacement, binding: f.bind(replacement) });
    await f.coordinator.tick();
    await eventually(() => expect(f.store.getTask(old)?.status).toBe("done"));
    expect(f.worktrees.has(replacement.claimId)).toBe(true);
    expect(f.git.removeEmptyReservation).not.toHaveBeenCalled();
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
    await f.coordinator.tick(); await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    expect(f.tasks.start.mock.calls[0]![0].claimId).toBe(replacement.claimId);
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

  it("tracks warning histories independently when another project cannot be inspected", async () => {
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
    await f.coordinator.tick();
    expect(f.events.some(event => event.message.includes(`Could not inspect Git worktrees for project ${other.projectId}`))).toBe(true);
    vi.mocked(f.git.listWorktrees).mockImplementation(list);
    f.worktrees.set(owner.claimId, worktree);
    await f.coordinator.tick();
    expect(f.events.filter((event) => event.kind === "warning")).toHaveLength(3);
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
    f.store.saveCleanupSchedule(owner, { deadline: 601_000, failures: 0, nextAttemptAt: 1000, stage: "observation", lastError: null });
    f.clock(602_000);
    const pending: { context: ResourceOwner & { cwd: string }; binding: HerdrTaskBinding }[] = [];
    f.tasks.pendingStops.mockImplementation(() => [...pending]);
    f.tasks.stopAndClose.mockImplementationOnce(async (context) => {
      pending.push({ context: { ...context, cwd: path.join(f.project.localPath, ".worktrees", "daynight", row.taskId) }, binding: [...f.resources.values()][0]!.panes[0]!.binding });
      f.resources.clear(); throw new Error("process still live");
    });
    f.tasks.stopAndClose.mockRejectedValueOnce(new Error("process still live"));
    await expect(driver.advance(input, { kind: "terminal", deadline: 601_000, immediateStop: false, scope: { attempt: { owner, attemptId: "test" }, onExecutionStopped: () => {} } })).rejects.toThrow("process still live");
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
    f.tasks.stopAndClose.mockRejectedValueOnce(new Error("process still live"));
    await expect(driver.advance(input, { kind: "terminal", deadline: 601_000, immediateStop: false, scope: { attempt: { owner, attemptId: "test" }, onExecutionStopped: () => {} } })).rejects.toThrow("process still live");
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
    f.tasks.stopAndClose.mockImplementationOnce(async () => { pending.splice(0); });
    await driver.advance(input, { kind: "terminal", deadline: 601_000, immediateStop: false, scope: { attempt: { owner, attemptId: "test" }, onExecutionStopped: () => {} } });
    expect(f.tasks.stopAndClose).toHaveBeenCalledTimes(4); expect(f.git.removeWorktree).toHaveBeenCalledOnce();
  });

  it("keeps terminal cleanup running across repeated absence reconciliation", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const row = f.store.listTasks()[0]!; f.grants.clear(); f.candidates.splice(0);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const remove = vi.mocked(f.git.removeWorktree).getMockImplementation()!;
    vi.mocked(f.git.removeWorktree).mockImplementation(async (project, owner, operation) => {
      await waiting;
      operation.signal?.throwIfAborted();
      return remove(project, owner, operation);
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
    const replacement: Task = { ...original, properties: { ...original.properties, worker: { ...readWorkerClaim(original.properties)!, claimId: uuid(950), workerId: uuid(951), worktreeId: uuid(952) } } };
    vi.mocked(f.remote.readTask).mockResolvedValueOnce(original).mockResolvedValueOnce(replacement);
    await f.coordinator.advanceRetry(row);
    expect(f.remote.readTask).toHaveBeenCalledOnce();
    expect(f.tasks.start.mock.calls.at(-1)![0].claimId).toBe(row.claimId);
    expect(f.tasks.start.mock.calls.at(-1)![0].worktreeId).toBe(readWorkerClaim(original.properties)!.worktreeId);
  });

  it.each(["claim", "worker"])("rejects a retry after the original %s identity changes", async (field) => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const row = f.store.listTasks()[0]!; const original = f.grants.get(row.claimId)!;
    const worker = { ...readWorkerClaim(original.properties)!, ...(field === "claim" ? { claimId: uuid(950) } : { workerId: uuid(951) }) };
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

  it("retains control cleanup responsibility when the original stop is unknown", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const row = f.store.listTasks()[0]!;
    const owner = await f.coordinator.cleanupSource(row);
    f.tasks.observeExecutionStop.mockImplementation(unknownStop);
    await expect(f.coordinator.completeSource(owner)).rejects.toThrow("execution stop is unconfirmed");
    expect(f.store.getTask(row)?.status).toBe("active");
    expect(f.store.getCleanupSchedule(owner)).not.toBeNull();
    expect(f.worktrees.has(owner.claimId)).toBe(true);
  });

  it("continues a known Herdr claim's terminal cleanup despite a corrupt sibling scan", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const row = f.store.listTasks()[0]!; f.grants.clear(); f.candidates.splice(0);
    vi.mocked(f.git.listWorktrees).mockRejectedValue(new Error("unregistered sibling reservation"));
    await f.coordinator.tick();
    await eventually(() => expect(f.store.getTask(row)?.status).toBe("done"));
    expect(f.resources.has(row.claimId)).toBe(false); expect(f.worktrees.has(row.claimId)).toBe(false);
  });

  it("stops a healthy agent at shutdown when sibling Git discovery fails", async () => {
    const f = await fixture(); await f.coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const row = f.store.listTasks()[0]!;
    vi.mocked(f.git.listWorktrees).mockRejectedValue(new Error("unregistered sibling reservation"));
    await expect(f.coordinator.shutdown()).resolves.toBe(true);
    expect(f.resources.has(row.claimId)).toBe(false); expect(f.worktrees.has(row.claimId)).toBe(true);
    expect(f.store.getTask(row)).toEqual(row); expect(f.tasks.submitPrompt).not.toHaveBeenCalled();
    expect(f.events.some(event => event.kind === "shutdown-error")).toBe(false);
  });

  it("leaves spare capacity for later rounds and closes the candidate stream after each grant", async () => {
    const f = await fixture(3);
    const closed = vi.fn();
    const nextCandidate = vi.fn();
    vi.mocked(f.remote.candidates).mockImplementation(async function* () {
      try {
        for (const candidate of f.candidates) {
          if ([...f.grants.values()].some(granted => granted.id === candidate.id)) continue;
          nextCandidate(candidate.id);
          yield candidate;
        }
      } finally { closed(); }
    });
    await f.coordinator.tick();
    expect(f.remote.claim).toHaveBeenCalledOnce();
    expect(nextCandidate).toHaveBeenCalledExactlyOnceWith(uuid(100));
    expect(closed).toHaveBeenCalledOnce();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    expect(f.store.listTasks()).toHaveLength(1);
    await f.coordinator.tick();
    expect(f.remote.claim).toHaveBeenCalledTimes(2);
    expect(nextCandidate.mock.calls).toEqual([[uuid(100)], [uuid(101)]]);
    expect(closed).toHaveBeenCalledTimes(2);
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(2));
  });

  it("skips an exhausted repository before claiming one task from the next repository", async () => {
    const f = await fixture(3);
    const second: WorkerProject = { projectId: uuid(20), repoUrl: "https://example.test/owner/second.git", localPath: path.join(f.root, "second") };
    f.store.registerProject(second); f.options.repositories.push({ project: second, configuration });
    f.coordinator.updateConfiguration(f.options);
    f.candidates.splice(0, f.candidates.length, task(second.projectId, uuid(200)), task(second.projectId, uuid(201)));
    await f.coordinator.tick();
    expect(vi.mocked(f.remote.candidates).mock.calls.map(([projectId]) => projectId)).toEqual([f.project.projectId, second.projectId]);
    expect(f.remote.claim).toHaveBeenCalledOnce();
    expect(vi.mocked(f.remote.claim).mock.calls[0]![0].id).toBe(uuid(200));
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
  });

  it("ends acquisition when an in-flight grant encounters a late same-task responsibility", async () => {
    const f = await fixture(3);
    let lateOwner: ResourceOwner | undefined;
    vi.mocked(f.remote.claim).mockImplementationOnce(async (candidate, descriptor) => {
      // An already-dispatched claim can outlive a local resource observation.
      lateOwner = addOrphan(f, candidate.id).owner;
      f.store.activateTask(f.store.registerPending({ ...lateOwner, agent: "copilot" }));
      return f.grant(candidate, descriptor);
    });
    await f.coordinator.tick();
    expect(f.remote.claim).toHaveBeenCalledOnce();
    const granted = [...f.grants.values()][0]!;
    expect(f.store.getTask({ projectId: granted.projectId, taskId: granted.id, claimId: readWorkerClaim(granted.properties)!.claimId })?.status).toBe("pending");
    expect(f.tasks.start).not.toHaveBeenCalled();
    expect(f.worktrees.has(lateOwner!.claimId)).toBe(true);
    await f.coordinator.shutdown();
  });

  it("claims one new task per round across repositories while preserving rotation and ready order", async () => {
    const f = await fixture(3);
    const second: WorkerProject = { projectId: uuid(20), repoUrl: "https://example.test/owner/second.git", localPath: path.join(f.root, "second") };
    f.store.registerProject(second); f.options.repositories.push({ project: second, configuration });
    f.coordinator.updateConfiguration(f.options);
    f.candidates.push(task(second.projectId, uuid(200)), task(second.projectId, uuid(201)));
    const expected = [uuid(100), uuid(200), uuid(101)];
    for (let round = 0; round < expected.length; round++) {
      await f.coordinator.tick();
      expect(vi.mocked(f.remote.claim).mock.calls.map(([candidate]) => candidate.id)).toEqual(expected.slice(0, round + 1));
      await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(round + 1));
    }
    await f.coordinator.tick();
    expect(f.remote.claim).toHaveBeenCalledTimes(3);
  });

  it.each(["linux", "macos", "windows"] as const)("prioritizes %s tasks across projects, then falls back while preserving rotation", async platform => {
    const f = await fixture(5);
    const second: WorkerProject = { projectId: uuid(20), repoUrl: "https://example.test/owner/second.git", localPath: path.join(f.root, "second") };
    f.store.registerProject(second); f.options.repositories.push({ project: second, configuration });
    const specific = (projectId: string, id: number): Task => ({ ...task(projectId, uuid(id)), requiredPlatform: platform });
    f.candidates.splice(0, f.candidates.length,
      task(f.project.projectId, uuid(100)), specific(f.project.projectId, 101), specific(f.project.projectId, 102),
      task(second.projectId, uuid(200)), specific(second.projectId, 201));
    const coordinator = createWorkerCoordinator({ ...f.options, platform, preferPlatformSpecificTasks: true });
    const expected = [101, 201, 102, 100, 200].map(uuid);
    for (let round = 0; round < expected.length; round++) {
      await coordinator.tick();
      expect(vi.mocked(f.remote.claim).mock.calls.map(([candidate]) => candidate.id)).toEqual(expected.slice(0, round + 1));
      await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(round + 1));
    }
    expect(vi.mocked(f.remote.candidates).mock.calls.some(([, , , platformSpecific]) => platformSpecific === false)).toBe(true);
  });

  it.each([false, true])("keeps platform preference local to each Worker when enabled=%s", async preferPlatformSpecificTasks => {
    const f = await fixture();
    f.candidates[1] = { ...f.candidates[1]!, requiredPlatform: "linux" };
    f.coordinator.updateConfiguration({ ...f.options, preferPlatformSpecificTasks });
    await f.coordinator.tick();
    expect(vi.mocked(f.remote.claim).mock.calls.map(([candidate]) => candidate.id)).toEqual([uuid(preferPlatformSpecificTasks ? 101 : 100)]);
    const query = vi.mocked(f.remote.candidates).mock.calls[0]!;
    expect(query[3]).toBe(preferPlatformSpecificTasks ? true : undefined);
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
  });

  it("round-robins unrestricted work while a preferred task retains its stopped worktree", async () => {
    const f = await fixture(4);
    const second: WorkerProject = { projectId: uuid(20), repoUrl: "https://example.test/owner/second.git", localPath: path.join(f.root, "second") };
    f.store.registerProject(second); f.options.repositories.push({ project: second, configuration });
    const blocked = { ...task(f.project.projectId, uuid(102)), requiredPlatform: "linux" as const };
    f.candidates.splice(0, f.candidates.length, blocked,
      task(f.project.projectId, uuid(100)), task(f.project.projectId, uuid(101)),
      task(second.projectId, uuid(200)), task(second.projectId, uuid(201)), task(second.projectId, uuid(202)), task(second.projectId, uuid(203)));
    const owner: ResourceOwner = { projectId: blocked.projectId, taskId: blocked.id, claimId: uuid(951), worktreeId: uuid(952) };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex" }));
    f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    Object.assign(f.herdr, { lifecycle: { registerClaim: () => {}, responsibilities: () => [owner], isStopped: (target: ResourceOwner) => target.claimId === owner.claimId, assertCanAdvance: () => {} } });
    f.coordinator.updateConfiguration({ ...f.options, preferPlatformSpecificTasks: true });
    const expected = [100, 200, 101, 201].map(uuid);
    for (let round = 0; round < expected.length; round++) {
      await f.coordinator.tick();
      expect(f.remote.claim).toHaveBeenCalledTimes(round + 1);
      expect(f.worktrees.has(owner.claimId)).toBe(true);
      await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(round + 1));
    }
    expect(vi.mocked(f.remote.claim).mock.calls.map(([candidate]) => candidate.id)).toEqual(expected);
  });

  it("preserves unrestricted rotation across intermittent successful preferred claims", async () => {
    const f = await fixture(6);
    const second: WorkerProject = { projectId: uuid(20), repoUrl: "https://example.test/owner/second.git", localPath: path.join(f.root, "second") };
    f.store.registerProject(second); f.options.repositories.push({ project: second, configuration });
    f.candidates.push(task(second.projectId, uuid(200)), task(second.projectId, uuid(201)), task(second.projectId, uuid(202)));
    f.coordinator.updateConfiguration({ ...f.options, preferPlatformSpecificTasks: true });
    const expected: string[] = [];
    for (const [offset, ordinary] of [100, 200, 101].entries()) {
      const preferred = { ...task(f.project.projectId, uuid(300 + offset)), requiredPlatform: "linux" as const };
      f.candidates.push(preferred);
      await f.coordinator.tick(); expected.push(preferred.id);
      expect(f.remote.claim).toHaveBeenCalledTimes(expected.length);
      await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(expected.length));
      await f.coordinator.tick(); expected.push(uuid(ordinary));
      expect(f.remote.claim).toHaveBeenCalledTimes(expected.length);
      await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(expected.length));
    }
    expect(vi.mocked(f.remote.claim).mock.calls.map(([candidate]) => candidate.id)).toEqual(expected);
  });

  it("closes tier streams and discards a candidate when preference changes during its query", async () => {
    const f = await fixture();
    f.coordinator.updateConfiguration({ ...f.options, preferPlatformSpecificTasks: true });
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const querying = vi.fn(), closed = vi.fn();
    vi.mocked(f.remote.candidates).mockImplementationOnce(async function* (_projectId, _platform, _signal, platformSpecific) {
      expect(platformSpecific).toBe(true);
      try {
        querying(); await barrier;
        yield { ...f.candidates[1]!, requiredPlatform: "linux" };
      } finally { closed(); }
    });
    const round = f.coordinator.tick();
    await eventually(() => expect(querying).toHaveBeenCalledOnce());
    f.coordinator.updateConfiguration(f.options);
    release(); await round;
    expect(closed).toHaveBeenCalledOnce();
    expect(f.remote.claim).not.toHaveBeenCalled();
    await f.coordinator.tick();
    expect(vi.mocked(f.remote.claim).mock.calls.map(([candidate]) => candidate.id)).toEqual([uuid(100)]);
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
  });

  it("round-robins pending work per free slot instead of draining the first project", async () => {
    const f = await fixture(2);
    const second: WorkerProject = { projectId: uuid(20), repoUrl: "https://example.test/owner/second.git", localPath: path.join(f.root, "second") };
    f.store.registerProject(second); f.options.repositories.push({ project: second, configuration }); f.candidates.splice(0);
    f.coordinator.updateConfiguration(f.options);
    for (const [projectId, taskId, claimId] of [[f.project.projectId, uuid(100), uuid(300)], [f.project.projectId, uuid(101), uuid(301)], [second.projectId, uuid(200), uuid(302)]]) {
      const owner = { projectId: projectId!, taskId: taskId!, claimId: claimId!, worktreeId: uuid(Number(claimId!.slice(-3)) + 100) };
      f.grant(task(projectId!, taskId!), { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex" });
    }
    Object.assign(f.herdr, { lifecycle: { responsibilities: () => [], isStopped: () => false, hasStarted: () => false, assertCanAdvance: () => {}, stop: async () => {} } });
    await f.coordinator.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(2));
    expect(f.store.listTasks().filter((row) => row.status === "active").map((row) => row.taskId).sort()).toEqual([uuid(100), uuid(200)]);
    expect(f.store.listTasks().find((row) => row.taskId === uuid(101))?.status).toBe("pending");
  });

  it("starts another repository while the first repository's native launch waits", async () => {
    const f = await fixture(2);
    const second: WorkerProject = { projectId: uuid(20), repoUrl: "https://example.test/owner/second.git", localPath: path.join(f.root, "second") };
    f.store.registerProject(second); f.options.repositories.push({ project: second, configuration }); f.candidates.push(task(second.projectId, uuid(200)));
    f.coordinator.updateConfiguration(f.options);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const start = f.tasks.start.getMockImplementation()!;
    f.tasks.start.mockImplementation(async (context, binding, input) => { if (context.projectId === f.project.projectId) await wait; return start(context, binding, input); });
    await f.coordinator.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    expect(f.remote.claim).toHaveBeenCalledOnce();
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
    f.tasks.stopAndClose.mockImplementation(async () => { pending.splice(0); f.stoppedRuns.add(owner.claimId); });
    vi.mocked(f.git.listWorktrees).mockRejectedValue(new Error("unregistered sibling reservation"));
    await expect(f.coordinator.shutdown()).resolves.toBe(true);
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
    const withdrawn: Task = { ...original, status: "todo", allowAgents: false, startedAt: null, completedAt: null, cancelledAt: null, version: original.version + 1n, properties: Object.fromEntries(Object.entries(original.properties).filter(([name]) => name !== "worker")) };
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
    f.tasks.stopAndClose.mockImplementation(async () => { await wait; pending.splice(0); f.stoppedRuns.add(owner.claimId); });
    if (discovery === "corrupt sibling") vi.mocked(f.git.listWorktrees).mockRejectedValue(new Error("unregistered sibling reservation"));
    try {
      await f.coordinator.tick();
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
    f.tasks.stopAndClose.mockImplementation(async () => { await wait; pending.splice(0); f.stoppedRuns.add(owner.claimId); });
    try {
      await f.coordinator.tick();
      await eventually(() => expect(pending).toHaveLength(1));
      expect(f.resources.has(owner.claimId)).toBe(false);
      await f.coordinator.tick();
      expect(f.store.getTask(owner)).toEqual({ projectId: owner.projectId, taskId: owner.taskId, claimId: owner.claimId, status: "pending", agent: "codex", agentControlMode: "herdr" as const, sessionId: uuid(903) });
      expect(f.remote.claim).not.toHaveBeenCalled(); expect(f.tasks.start).not.toHaveBeenCalled();
    } finally { release(); f.clock(2000); await f.coordinator.tick(); await eventually(() => expect(f.worktrees.has(owner.claimId)).toBe(false)); }
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
    await f.coordinator.tick();
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
      if (discovery === "Herdr") await expect(f.coordinator.tick()).rejects.toThrow("Herdr discovery failed");
      else await f.coordinator.tick();
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
    expect(isWorkerCancellation(new AggregateError([first, second], "Shutdown", { cause: reason }), controller.signal)).toBe(true);
  });

  it("preserves a real endpoint failure mixed with cancellation", () => {
    const controller = new AbortController(); const reason = new Error("Worker operation interrupted."); controller.abort(reason);
    const cancellation = new OperationError("cancelled", { cause: reason });
    expect(isWorkerCancellation(new AggregateError([cancellation, new Error("Endpoint configuration invalid")], "Endpoints failed", { cause: reason }), controller.signal)).toBe(false);
    expect(isWorkerCancellation(new AggregateError([], "No endpoint observations", { cause: reason }), controller.signal)).toBe(false);
    expect(isWorkerCancellation(new AggregateError([cancellation], "Cleanup and cancellation", { cause: new Error("Cleanup failed") }), controller.signal)).toBe(false);
  });

  it("does not suppress another operation's cancellation or errors before shutdown", () => {
    const controller = new AbortController(); const reason = new Error("Worker operation interrupted.");
    const cancellation = new OperationError("cancelled", { cause: reason });
    expect(isWorkerCancellation(new AggregateError([cancellation], "Not shutting down"), controller.signal)).toBe(false);
    controller.abort(reason);
    expect(isWorkerCancellation(new AggregateError([new OperationError("cancelled", { cause: new Error("Another operation") })], "Foreign cancellation"), controller.signal)).toBe(false);
  });
});

it.each(["native parameter change", "Web to Herdr change"] as const)("retains the confirmed claim configuration across blocked storage and %s", async change => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(); const webStore = openWebExecutionStore(createMemoryDatabase());
  const original: ExecutionConfiguration = { ...configuration, agentControlMode: change === "Web to Herdr change" ? "web" : "herdr", model: "claimed-model", args: change === "Web to Herdr change" ? [] : ["--search"] };
  const changed: ExecutionConfiguration = { ...original, agentControlMode: "herdr", model: "new-default-model", args: [] };
  let complete = true, releaseClaim!: () => void;
  const claimPending = new Promise<void>(resolve => { releaseClaim = resolve; });
  const claim = vi.mocked(f.remote.claim).getMockImplementation()!;
  vi.mocked(f.remote.claim).mockImplementation(async (...args) => { await claimPending; return claim(...args); });
  const advance = vi.fn(async (input: WebTask) => {
    const record = webStore.initializeWebExecution(input, 2);
    return webStore.bindNativeSession(record, { source: "controller", sessionId: uuid(880) }, 3);
  });
  const register = vi.spyOn(webStore, "register");
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: original }], globalConfiguration: original,
    configurationComplete: () => complete, webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {},
    webBackend: { observeExecutionStop: unknownStop, advance, cleanup: async task => ({ task, complete: true }) } });
  const acquiring = coordinator.tick(); void acquiring.catch(() => {});
  try {
    await eventually(() => expect(f.remote.claim).toHaveBeenCalledOnce());
    complete = false;
    coordinator.updateConfiguration({ ...f.options, repositories: [{ project: f.project, configuration: changed }], globalConfiguration: changed });
    releaseClaim(); await acquiring;
    const local = f.store.listTasks()[0]!;
    expect(local).toMatchObject({ taskId: f.candidates[0]!.id, agentControlMode: original.agentControlMode, status: "pending" });
    expect([...f.grants.values()]).toHaveLength(1);
    await coordinator.tick();
    expect(f.tasks.start).not.toHaveBeenCalled(); expect(advance).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
    expect(f.remote.claim).toHaveBeenCalledOnce();
    complete = true;
    await coordinator.tick();
    if (change === "Web to Herdr change") {
      await eventually(() => expect(advance).toHaveBeenCalledOnce());
      expect(advance.mock.calls[0]![0].configuration).toMatchObject(original);
      expect(f.tasks.start).not.toHaveBeenCalled();
      expect(webStore.getTask(local)).toMatchObject({ claimId: local.claimId, configuration: original });
    } else {
      await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
      expect(vi.mocked(f.tasks.start).mock.calls[0]![2].configuration).toMatchObject(original);
      expect(advance).not.toHaveBeenCalled();
    }
    expect(f.store.getNativeConfiguration(local)).toMatchObject({ agent: original.agent, model: original.model, args: original.args });
    expect(f.store.listTasks()).toHaveLength(1);
    expect(f.store.getTask(local)!.claimId).toBe(local.claimId);
    expect(f.remote.claim).toHaveBeenCalledOnce();
  } finally { releaseClaim(); await acquiring; await coordinator.shutdown(); webStore.close(); }
});

it("waits before freezing a new native configuration after awaited preparation", async () => {
  const f = await fixture(); const candidate = f.candidates[0]!; f.candidates.splice(0);
  const granted = f.grant(candidate, { claimId: uuid(991), workerId, machine: f.options.machine, platform: "linux", agent: "codex", worktreeId: uuid(992) });
  const active = f.store.activateTask(f.store.registerPending({ projectId: granted.projectId, taskId: granted.id, claimId: uuid(991), agent: "codex" }));
  let complete = true;
  const freeze = vi.spyOn(f.store, "freezeNativeConfiguration");
  const coordinator = createWorkerCoordinator({ ...f.options, configurationComplete: () => complete,
    freezeConfiguration: async value => { await Promise.resolve(); complete = false; return value; } });
  expect(await coordinator.advanceRetry(active)).toEqual({ kind: "waiting_input", reason: "configuration_pending" });
  expect(freeze).not.toHaveBeenCalled(); expect(f.tasks.start).not.toHaveBeenCalled();
});

it("waits before registering a new Web execution after awaited configuration preparation", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(); const webStore = openWebExecutionStore(createMemoryDatabase());
  const config = { ...configuration, agentControlMode: "web" as const, args: [] };
  let complete = true, preparations = 0;
  const register = vi.spyOn(webStore, "register"), advance = vi.fn(async record => record);
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: config }], globalConfiguration: config,
    configurationComplete: () => complete, webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {},
    freezeConfiguration: async value => { await Promise.resolve(); if (++preparations === 2) complete = false; return value; },
    webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn() } });
  try {
    await coordinator.tick();
    await eventually(() => expect(complete).toBe(false));
    expect(register).not.toHaveBeenCalled(); expect(advance).not.toHaveBeenCalled();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it("keeps a proven live legacy conversation input and stop operable while new admission is blocked", async () => {
  const f = await fixture(); f.blockStartupInput();
  await f.coordinator.tick(); await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
  const active = f.store.listTasks()[0]!, pane = f.resources.get(active.claimId)!.panes[0]!;
  expect(active.sessionId).toBeNull();
  pane.status = "idle"; pane.interactiveReady = true;
  const restarted = createWorkerCoordinator({ ...f.options, configurationComplete: () => false });
  await restarted.advanceRetry(active);
  expect(f.tasks.start).toHaveBeenCalledOnce();
  expect(f.tasks.submitPrompt).toHaveBeenCalled();
  await restarted.shutdown();
  expect(f.tasks.stopAndClose).toHaveBeenCalled();
});

it("routes Web claims without Herdr, freezes launch settings, and keeps interaction state out of task summary", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(); const webStore = openWebExecutionStore(createMemoryDatabase());
  const webConfiguration = { agent: "codex" as const, agentControlMode: "web" as const, model: "frozen-model", args: [], recoveryLimit: 2 };
  const monitor = createMonitoringObserver();
  let controllerActivity: "waiting_input" | "working" = "waiting_input";
  const advance = vi.fn(async (input: import("../../../src/commands/worker/backends/web-types.js").LocalTask) => {
    let record = webStore.initializeWebExecution(input, 2);
    record = webStore.updateWebExecution(record, { activity: controllerActivity, initialInputState: "confirmed" }, 3);
    return webStore.bindNativeSession(record, { source: "controller", sessionId: uuid(880) }, 4);
  });
  const verifyWebUnregistered = vi.fn(async () => {});
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: webConfiguration }], globalConfiguration: webConfiguration, webStore, monitoring: monitor, verifyWebServer: vi.fn(async () => {}), verifyWebUnregistered, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn() } });
  try {
    await coordinator.tick(); await eventually(() => expect(advance).toHaveBeenCalledOnce());
    await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const row = f.store.listTasks()[0]!;
    expect(row).toMatchObject({ agentControlMode: "web", sessionId: uuid(880) });
    expect(f.herdr.ensureInstance).not.toHaveBeenCalled(); expect(f.tasks.listResources).not.toHaveBeenCalled();
    expect(vi.mocked(f.remote.update).mock.calls[0]![1]).toEqual({ phase: "executing", nativeSessionId: uuid(880), herdr: null });
    expect(monitor.capture("1").activities).toEqual([expect.objectContaining({ kind: "execution", phase: "waiting", status: "waiting", waitReason: "native-input" })]);
    controllerActivity = "working";
    webConfiguration.model = "changed-model";
    Object.assign(webConfiguration, { agentControlMode: "herdr", args: ["--search"] });
    await coordinator.tick(); await eventually(() => expect(advance).toHaveBeenCalledTimes(2));
    await eventually(() => expect(monitor.capture("2").activities).toEqual([expect.objectContaining({ kind: "execution", phase: "executing", status: "running", waitReason: null })]));
    expect(webStore.getTask(row)?.configuration?.model).toBe("frozen-model");
    expect(verifyWebUnregistered).toHaveBeenCalledOnce();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it("missing Web execution evidence never permits replacing or deleting an existing server Session", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(); const webStore = openWebExecutionStore(createMemoryDatabase());
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

it.each(["archive", "worktree removal"])("releases a deleted Web task's slot while %s remains pending", async stage => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
  const f = await fixture(1), webStore = openWebExecutionStore(createMemoryDatabase());
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
  const remote = f.grant(f.candidates[0]!, { claimId: uuid(810), workerId, worktreeId: uuid(811), agent: "codex", agentControlMode: "web", platform: "linux", machine: f.options.machine });
  const owner = { projectId: remote.projectId, taskId: remote.id, claimId: uuid(810), worktreeId: uuid(811) };
  f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
  f.store.activateTask(owner);
  let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration }, 1);
  record = webStore.bindWorktree(record, await f.git.prepareWorktree(f.project, owner, {} as Operation), 2);
  record = webStore.initializeWebExecution(record, 3);
  record = webStore.updateWebExecution(record, { sessionId: uuid(812), initialPrompt: "managed", launchSubmission: "acknowledged" }, 4);
  const stopped = await stoppedWebExecution(f, webStore, record);
  record = webStore.beginCleanup(stopped.task, { kind: "terminal", deadline: 100 }, 7);

  // Deleted tasks disappear from the remote inventory, while local cleanup remains durable.
  f.grants.clear(); f.candidates.shift();
  let cleanupAvailable = false;
  const allowRemoval = Promise.withResolvers<void>();
  const archive = async () => { if (stage === "archive" && !cleanupAvailable) throw new Error("archive unavailable"); f.order.push("archive-ready"); };
  const removeWorktree = vi.mocked(f.git.removeWorktree).getMockImplementation()!;
  vi.mocked(f.git.removeWorktree).mockImplementation(async (...args) => {
    if (stage === "worktree removal" && !cleanupAvailable) throw new Error("worktree deletion denied");
    await allowRemoval.promise;
    return removeWorktree(...args);
  });
  const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: () => 1000, archive, jobLeases: stopped.jobLeases, request: stopped.request });
  const advance = async (input: import("../../../src/commands/worker/backends/web-types.js").LocalTask) => webStore.initializeWebExecution(input, 1000);
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration }], globalConfiguration: configuration, webStore, webBackend: { ...backend, advance }, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
  try {
    await coordinator.tick();
    await eventually(() => expect(f.events.some(event => event.kind === "cleanup-error")).toBe(true));
    expect(f.store.getTask(owner)?.status).toBe("active");
    expect(f.worktrees.has(owner.claimId)).toBe(true);
    await coordinator.tick();
    await eventually(() => expect(f.remote.claim).toHaveBeenCalledOnce());
    cleanupAvailable = true;
    f.clock(2000);
    allowRemoval.resolve();
    await coordinator.tick();
    await eventually(() => expect(f.store.getTask(owner)?.status).toBe("done"));
    expect(webStore.getTask(owner)?.status).toBe("done");
    expect(f.order.slice(-2)).toEqual(["archive-ready", "remove-worktree"]);
    // The done row is visible before the cleanup job's final responsibility is released.
    await vi.waitFor(async () => {
      await coordinator.tick();
      expect(f.store.listUnfinishedTasks().some(task => task.taskId === f.candidates[0]!.id && task.status === "active")).toBe(true);
    }, { timeout: 3500, interval: 10 });
    expect(f.remote.claim).toHaveBeenCalledOnce();
    expect(f.herdr.ensureInstance).not.toHaveBeenCalled();
    expect(f.events.filter(event => event.kind === "cleanup-error")).toHaveLength(1);
    // A completed record still reconciles the original claim against physical resources.
    f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    await coordinator.completeSource(owner);
    expect(f.worktrees.has(owner.claimId)).toBe(true);
    await coordinator.completeSource(owner);
    await coordinator.shutdown();
  } finally { allowRemoval.resolve(); await coordinator.shutdown(); webStore.close(); }
});

it.each(["supported", "legacy", "unavailable"])("reconciles paused summaries with %s startup reporting without advancing recovery", async support => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
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
    webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn(), observeStartupReport } });
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
  const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
  const advance = vi.fn(async (input: import("../../../src/commands/worker/backends/web-types.js").LocalTask) => input);
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration }], globalConfiguration: configuration, webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn() } });
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
  const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase()), monitor = createMonitoringObserver();
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
    await eventually(() => expect(monitor.capture("1").currentFailures).toContainEqual(expect.objectContaining({ error: expect.objectContaining({ code: "recovery-blocked" }) })));
    const recovery = monitor.capture("1").currentFailures.find(item => item.error.code === "recovery-blocked")!;
    webStore.beginCleanup(row, { kind: "shutdown", deadline: 9 }, 7);

    await coordinator.advanceRetry(row);
    expect(webStore.getTask(row)?.cleanup).toBeNull();
    expect(webStore.getTask(row)?.recovery).toMatchObject({ count: 1, retryAuthorized: true });
    expect(readWorkerClaim(f.grants.get(row.claimId)!.properties)?.phase).toBe("waiting");
    await coordinator.tick();
    await eventually(() => expect(advance.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(monitor.capture("2").currentFailures).toContainEqual(expect.objectContaining({ operationId: recovery.operationId }));
    starting = false;
    await coordinator.tick();
    await eventually(() => expect(readWorkerClaim(f.grants.get(row.claimId)!.properties)?.phase).toBe("executing"));
    await eventually(() => expect(monitor.capture("3").lastRecovery).toMatchObject({ operationId: recovery.operationId }));
    expect(webStore.getTask(row)?.recovery.count).toBe(1);
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it("returns a Web retry's input wait without claiming a completed submission", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 0 };
  const advance = vi.fn(async (input: WebTask) => input);
  const advanceResult = vi.fn(async (input: WebTask) => ({ kind: "waiting_input" as const, reason: "prompt_too_large" as const, task: input }));
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration }], globalConfiguration: configuration, webStore,
    verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, advanceResult, cleanup: vi.fn() } });
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
  const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
  const remote = f.grant(f.candidates[0]!, { claimId: uuid(810), workerId, worktreeId: uuid(811), agent: "codex", agentControlMode: "web", platform: "linux", machine: f.options.machine });
  const row = f.store.registerPending({ projectId: remote.projectId, taskId: remote.id, claimId: uuid(810), agent: "codex", agentControlMode: "web" });
  f.store.activateTask(row);
  const advance = vi.fn(async (input: import("../../../src/commands/worker/backends/web-types.js").LocalTask) => input);
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [], globalConfiguration: configuration, webStore, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn() } });
  try {
    await expect(coordinator.advanceRetry(row)).rejects.toThrow("original Web execution evidence");
    expect(advance).not.toHaveBeenCalled();
    expect(webStore.getTask(row)).toBeNull();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

describe("terminal cleanup retry scheduling", () => {
  it("yields archive backfill while capacity is full and responds to the current capacity limit", async () => {
    const f = await fixture();
    try {
      expect(f.coordinator.archiveYield()).toBe(false);
      await f.coordinator.tick();
      await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
      expect(f.coordinator.archiveYield()).toBe(true);
      f.coordinator.updateConfiguration({ ...f.options, maxConcurrent: 2 });
      expect(f.coordinator.archiveYield()).toBe(false);
    } finally { await f.coordinator.shutdown(); }
  });

  it("yields archive backfill for pending cleanup even when capacity is available", async () => {
    const f = await fixture(3);
    f.candidates.splice(1);
    let release!: () => void;
    const removal = new Promise<void>(resolve => { release = resolve; });
    try {
      await f.coordinator.tick();
      await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
      const owner = [...f.worktrees.values()][0]!.owner;
      f.grants.clear(); f.resources.clear(); f.stoppedRuns.add(owner.claimId); f.candidates.splice(0);
      vi.mocked(f.git.removeWorktree).mockImplementation(async () => { await removal; f.worktrees.delete(owner.claimId); return { kind: "absent", effectErrors: [] }; });
      await f.coordinator.tick();
      await eventually(() => expect(f.git.removeWorktree).toHaveBeenCalledOnce());
      expect(f.coordinator.archiveYield()).toBe(true);
      release();
      await eventually(() => expect(f.store.getTask(owner)?.status).toBe("done"));
      await f.coordinator.tick();
      expect(f.coordinator.archiveYield()).toBe(false);
    } finally { release(); await f.coordinator.shutdown(); }
  });

  it.each([
    { kind: "busy lower jitter", status: 429, code: "resource_busy", nested: false, stage: "archive", initialFailures: 0, failures: 0, random: 0, wait: 5000, busy: true },
    { kind: "busy upper jitter", status: 429, code: "resource_busy", nested: false, stage: "archive", initialFailures: 0, failures: 0, random: 0.999999, wait: 7000, busy: true },
    { kind: "nested busy", status: 429, code: "resource_busy", nested: true, stage: "archive", initialFailures: 0, failures: 0, random: 0.5, wait: 6000, busy: true },
    { kind: "busy after restart", status: 429, code: "resource_busy", nested: false, stage: "archive", initialFailures: 5, failures: 5, random: 0.5, wait: 6000, busy: true },
    { kind: "different 429", status: 429, code: "rate_limit", nested: false, stage: "archive", initialFailures: 2, failures: 3, random: 0.5, wait: 4000, busy: false },
    { kind: "different status", status: 503, code: "resource_busy", nested: false, stage: "archive", initialFailures: 3, failures: 4, random: 0.5, wait: 8000, busy: false },
    { kind: "busy outside archive", status: 429, code: "resource_busy", nested: false, stage: "worktree-removal", initialFailures: 0, failures: 1, random: 0.5, wait: 1000, busy: false },
  ] as const)("retains archive ownership and schedules $kind without inflating busy failures", async ({ kind, status, code, nested, stage, initialFailures, failures, random, wait, busy }) => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
    const f = await fixture(2), webStore = openWebExecutionStore(createMemoryDatabase());
    const config = { ...configuration, args: [], agentControlMode: "web" as const };
    const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(910), worktreeId: uuid(911) };
    f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }); f.store.activateTask(owner);
    let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
    record = webStore.bindWorktree(record, await f.git.prepareWorktree(f.project, owner, {} as Operation), 2);
    record = webStore.initializeWebExecution(record, 3);
    record = webStore.updateWebExecution(record, { sessionId: uuid(912), initialPrompt: "managed", launchSubmission: "acknowledged" }, 4);
    const stopped = await stoppedWebExecution(f, webStore, record);
    webStore.beginCleanup(stopped.task, { kind: "terminal", deadline: 100 }, 7);
    f.store.saveCleanupSchedule(owner, { deadline: 100, failures: initialFailures, nextAttemptAt: 1000, stage: "archive", lastError: initialFailures === 0 ? null : "Previous failure." });
    f.candidates.splice(0);
    const failure = Object.assign(new Error("Archive request failed."), { status, code });
    const archive = vi.fn<() => Promise<void>>(async () => { throw nested ? new Error("Archive operation failed.", { cause: failure }) : failure; });
    if (stage === "worktree-removal") { archive.mockResolvedValue(undefined); vi.mocked(f.git.removeWorktree).mockRejectedValue(failure); }
    const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: f.options.now, archive, jobLeases: stopped.jobLeases, request: stopped.request });
    const monitor = createMonitoringObserver({ now: f.options.now });
    const create = () => createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: config }], globalConfiguration: config, webStore, webBackend: backend, monitoring: monitor, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
    let coordinator = create();
    vi.spyOn(Math, "random").mockReturnValue(random);
    try {
      await coordinator.tick();
      await eventually(() => expect(f.events.filter(event => event.kind === "cleanup-error")).toHaveLength(1));
      expect(f.store.getCleanupSchedule(owner)).toMatchObject({ stage, failures, nextAttemptAt: 1000 + wait });
      expect(f.store.getTask(owner)?.status).toBe("active");
      expect(f.worktrees.has(owner.claimId)).toBe(true);
      expect(coordinator.archiveYield()).toBe(true);
      expect(monitor.capture("1").currentFailures).toContainEqual(expect.objectContaining({ phase: stage, retryState: "scheduled", nextAttemptAt: new Date(1000 + wait).toISOString(), ...(busy ? { error: expect.objectContaining({ code: "rate-limited" }) } : {}) }));
      if (busy) expect(f.events.find(event => event.kind === "cleanup-error")?.message).toContain("archive busy, short retry");
      if (kind === "busy after restart") { await coordinator.shutdown(); coordinator = create(); expect(coordinator.archiveYield()).toBe(true); }
      f.clock(999 + wait); await coordinator.tick();
      expect(archive).toHaveBeenCalledOnce();
      archive.mockResolvedValue(undefined);
      if (stage === "worktree-removal") vi.mocked(f.git.removeWorktree).mockImplementation(async () => { f.worktrees.delete(owner.claimId); return { kind: "absent", effectErrors: [] }; });
      f.clock(1000 + wait); await coordinator.tick();
      await eventually(() => expect(f.store.getTask(owner)?.status).toBe("done"));
      expect(archive).toHaveBeenCalledTimes(2);
      await eventually(() => expect(f.store.getCleanupSchedule(owner)).toBeNull());
      expect(f.worktrees.has(owner.claimId)).toBe(false);
      await coordinator.tick();
      expect(coordinator.archiveYield()).toBe(false);
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("retries durable stop only on its claim schedule while retaining archive ownership", async () => {
    const f = await fixture(); f.candidates.splice(0);
    const owner = { projectId: f.project.projectId, taskId: uuid(981), claimId: uuid(982), worktreeId: uuid(983) };
    f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex" }));
    f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    let stopped = false;
    const stop = vi.fn<(...args: unknown[]) => Promise<void>>(async () => { throw new Error("Original stop remains unknown."); });
    Object.assign(f.herdr, { lifecycle: {
      responsibilities: () => [owner], isStopped: () => stopped, stop,
      observeExecutionStop: async (target: CleanupTarget): Promise<StopObservation> => stopped ? { kind: "stopped", execution: { owner, backend: "herdr-native", runKey: "fixture" }, observedAt: 1000 } : unknownStop(target),
      cleanup: async (_owner: ResourceOwner, _prompt: string, operation: Operation, scope: import("../../../src/commands/worker/execution-stop.js").TerminalCleanupContext) => {
        await stop(owner, "terminal", operation);
        scope.onExecutionStopped({ attempt: scope.attempt, observation: { kind: "stopped", execution: { owner, backend: "herdr-native", runKey: "fixture" }, observedAt: 1000 } });
        return true;
      },
    } });
    const web = { ...configuration, agentControlMode: "web" as const };
    const coordinator = createWorkerCoordinator({ ...f.options, hasHerdrJournal: true, globalConfiguration: web, repositories: [{ project: f.project, configuration: web }] });
    await coordinator.tick();
    await eventually(() => expect(f.store.getCleanupSchedule(owner)?.failures).toBe(1));
    expect(f.store.getCleanupSchedule(owner)?.stage).toBe("agent-stop");
    vi.mocked(f.herdr.ensureInstance).mockClear(); f.tasks.listResources.mockClear();
    f.clock(1999); await coordinator.tick();
    expect(stop).toHaveBeenCalledOnce();
    expect(f.herdr.ensureInstance).not.toHaveBeenCalled();
    expect(f.tasks.listResources).not.toHaveBeenCalled();
    stop.mockImplementation(async () => { stopped = true; });
    f.clock(2000); await coordinator.tick();
    await eventually(() => expect(f.store.getTask(owner)?.status).toBe("done"));
    expect(stop).toHaveBeenCalledTimes(2);
    expect(f.store.getCleanupSchedule(owner)).toBeNull();
    expect(f.worktrees.has(owner.claimId)).toBe(true);
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
    expect(() => coordinator.assertCanAcquire(owner)).toThrow(/archive/);
    await coordinator.shutdown();
  });

  it("backs off each failed claim, caps retries, and converges after the cause is removed", async () => {
    const f = await fixture(); await f.coordinator.tick();
    await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const owner = [...f.worktrees.values()][0]!.owner;
    f.grants.clear(); f.resources.clear(); f.stoppedRuns.add(owner.claimId); f.candidates.splice(0);
    vi.mocked(f.git.removeWorktree).mockRejectedValue(new Error("EACCES fixture"));
    await f.coordinator.tick();
    await eventually(() => expect(f.events.filter(e => e.kind === "cleanup-error")).toHaveLength(1));
    expect(f.git.removeWorktree).toHaveBeenCalledOnce();
    let clock = 1000;
    for (const wait of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      const count = vi.mocked(f.git.removeWorktree).mock.calls.length;
      clock += wait;
      f.clock(clock - 1); await f.coordinator.tick(); await f.coordinator.tick();
      expect(f.git.removeWorktree).toHaveBeenCalledTimes(count);
      f.clock(clock); await f.coordinator.tick();
      await eventually(() => expect(f.git.removeWorktree).toHaveBeenCalledTimes(count + 1));
      await eventually(() => expect(f.events.filter(e => e.kind === "cleanup-error")).toHaveLength(count + 1));
    }
    expect(f.store.getTask(owner)?.status).toBe("active");
    expect(f.events.filter(e => e.kind === "cleanup-error").at(-1)?.message).toContain("worktree-removal");
    expect(f.events.filter(e => e.kind === "cleanup-capacity-blocked")).toHaveLength(0);
    vi.mocked(f.git.removeWorktree).mockImplementation(async () => { f.worktrees.delete(owner.claimId); return { kind: "absent", effectErrors: [] }; });
    f.clock(clock + 60000); await f.coordinator.tick();
    await eventually(() => expect(f.store.getTask(owner)?.status).toBe("done"));
    expect(f.worktrees.size).toBe(0);
    await f.coordinator.shutdown();
  });

  it("lets healthy cleanup and new work advance while one claim retries, then stops without retrying deletion", async () => {
    const f = await fixture(3); await f.coordinator.tick(); await f.coordinator.tick();
    await eventually(() => expect(f.store.listTasks().filter(t => t.sessionId !== null)).toHaveLength(2));
    const owners = [...f.worktrees.values()].map(item => item.owner);
    const broken = owners[0]!; const healthy = owners[1]!;
    f.grants.clear(); f.resources.clear(); for (const owner of owners) f.stoppedRuns.add(owner.claimId); f.candidates.splice(0);
    vi.mocked(f.git.removeWorktree).mockImplementation(async (_project, owner) => {
      if (owner.claimId === broken.claimId) throw new Error("EACCES fixture");
      f.worktrees.delete(owner.claimId);
      return { kind: "absent", effectErrors: [] };
    });
    await f.coordinator.tick();
    await eventually(() => expect(f.store.getTask(healthy)?.status).toBe("done"));
    await eventually(() => expect(f.events.some(e => e.kind === "cleanup-error")).toBe(true));
    f.candidates.push(task(f.project.projectId, uuid(103)));
    await f.coordinator.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(3));
    expect(f.events.some(e => e.kind === "cleanup-capacity-blocked")).toBe(false);
    const calls = vi.mocked(f.git.removeWorktree).mock.calls.length;
    await expect(f.coordinator.shutdown()).resolves.toBe(true);
    expect(f.git.removeWorktree).toHaveBeenCalledTimes(calls);
    expect(f.store.getTask(broken)?.status).toBe("active");
  });

  it("isolates conflicting cleanup ownership from healthy active work", async () => {
    const f = await fixture(2); await f.coordinator.tick(); await f.coordinator.tick();
    await eventually(() => expect(f.store.listTasks().filter(t => t.sessionId !== null)).toHaveLength(2));
    const [broken, healthy] = [...f.worktrees.values()].map(item => item.owner);
    f.grants.delete(broken!.claimId); f.resources.delete(broken!.claimId); f.candidates.splice(0);
    vi.mocked(f.git.removeWorktree).mockRejectedValue(new Error("EACCES fixture"));
    await f.coordinator.tick();
    await eventually(() => expect(f.events.some(e => e.kind === "cleanup-error")).toBe(true));
    const conflicting = { ...broken!, worktreeId: uuid(9998) };
    f.worktrees.set(broken!.claimId, { owner: conflicting, binding: f.bind(conflicting) });
    f.clock(2000);
    const pane = f.resources.get(healthy!.claimId)!.panes[0]!;
    pane.status = "idle"; pane.stateChangeSeq = 3;
    await expect(f.coordinator.tick()).resolves.toBeUndefined();
    await eventually(() => expect(f.tasks.submitPrompt).toHaveBeenCalled());
    expect(f.tasks.submitPrompt.mock.calls.at(-1)![0].claimId).toBe(healthy!.claimId);
    expect(f.store.getTask(broken!)?.status).toBe("active");
    await f.coordinator.shutdown();
  });

  it("retains backoff and reaches shutdown when retry persistence fails", async () => {
    const f = await fixture(); await f.coordinator.tick();
    await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const owner = [...f.worktrees.values()][0]!.owner;
    f.grants.clear(); f.resources.clear(); f.candidates.splice(0);
    const save = f.store.saveCleanupSchedule.bind(f.store);
    vi.spyOn(f.store, "saveCleanupSchedule").mockImplementation((owner, state) => {
      if (state.failures > 0) throw new Error("SQLITE_IOERR fixture");
      return save(owner, state);
    });
    vi.mocked(f.git.removeWorktree).mockRejectedValue(new Error("EACCES fixture"));
    await f.coordinator.tick();
    await eventually(() => expect(f.events.some(e => e.kind === "cleanup-error")).toBe(true));
    const error = f.events.find(e => e.kind === "cleanup-error")!.error as AggregateError;
    expect(error.errors).toEqual(expect.arrayContaining([expect.objectContaining({ message: "SQLITE_IOERR fixture" })]));
    f.clock(1999); await f.coordinator.tick();
    expect(f.git.removeWorktree).toHaveBeenCalledOnce();
    await expect(f.coordinator.shutdown()).resolves.toBe(true);
    expect(f.store.getTask(owner)?.status).toBe("active");
  });
});

it("observes completed Web resources when shutdown follows an interrupted schedule removal", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
  const f = await fixture(); const webStore = openWebExecutionStore(createMemoryDatabase());
  const owner = { projectId: f.project.projectId, taskId: uuid(810), claimId: uuid(811), worktreeId: uuid(812) };
  const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 0 };
  f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
  let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration }, 1);
  record = webStore.beginCleanup(record, { kind: "terminal", deadline: 100 }, 2);

  webStore.completeTask(record, 6); f.store.completeTask(owner);
  f.store.saveCleanupSchedule(owner, { deadline: 100, failures: 0, nextAttemptAt: 1, stage: "observation", lastError: null });
  const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: () => 1000 });
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [], globalConfiguration: configuration, webStore, webBackend: backend });
  try {
    await expect(coordinator.shutdown()).resolves.toBe(true);
    expect(f.events.some(e => e.kind === "shutdown-error")).toBe(false);
    expect(f.store.getCleanupSchedule(owner)).not.toBeNull();
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

describe("cloud project removal", () => {
  it("defers an unqueried mapping's Git ownership until its claim inventory is covered", async () => {
    const f = await fixture();
    const next: WorkerProject = { projectId: uuid(11), repoUrl: "https://example.test/next.git", localPath: path.join(f.root, "next") };
    const owner = { projectId: next.projectId, taskId: uuid(900), claimId: uuid(901), worktreeId: uuid(902) };
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.remote.ownInventory).mockImplementationOnce(async projects => {
      expect(projects.map(project => project.projectId)).toEqual([f.project.projectId]);
      await pending;
      return { tasks: [], coveredProjectIds: [f.project.projectId], unavailableProjectIds: [] };
    });
    const tick = f.coordinator.tick();
    try {
      await eventually(() => expect(f.remote.ownInventory).toHaveBeenCalledOnce());
      f.store.registerProject(next);
      f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
      f.grant(task(next.projectId, owner.taskId), { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex" });
      f.coordinator.updateConfiguration({ repositories: [{ project: f.project, configuration }, { project: next, configuration }], readyProjectIds: [f.project.projectId, next.projectId], targetProjectIds: [f.project.projectId, next.projectId], globalConfiguration: configuration, maxConcurrent: 1, preferPlatformSpecificTasks: false });
      release(); await tick;
      expect(f.events.some(event => event.kind === "warning" && event.message.includes("unproven Git ownership"))).toBe(false);
      expect(f.remote.claim).not.toHaveBeenCalled();
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
      expect(f.store.getTask(owner)).toBeNull();
      await f.coordinator.tick();
      await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
      expect(f.tasks.start.mock.calls[0]![0]).toMatchObject(owner);
      expect(f.remote.claim).not.toHaveBeenCalled();
    } finally { release(); await tick; await f.coordinator.shutdown(); }
  });

  it("defers admission if a project is registered after resource discovery starts", async () => {
    const f = await fixture();
    const next: WorkerProject = { projectId: uuid(11), repoUrl: "https://example.test/next.git", localPath: path.join(f.root, "next") };
    const owner = { projectId: next.projectId, taskId: uuid(900), claimId: uuid(901), worktreeId: uuid(902) };
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const list = vi.mocked(f.git.listWorktrees).getMockImplementation()!;
    vi.mocked(f.git.listWorktrees).mockImplementationOnce(async (project, operation) => { await pending; return list(project, operation); });
    const tick = f.coordinator.tick();
    try {
      await eventually(() => expect(f.git.listWorktrees).toHaveBeenCalledOnce());
      f.store.registerProject(next);
      f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
      f.grant(task(next.projectId, owner.taskId), { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex" });
      f.coordinator.updateConfiguration({ repositories: [{ project: f.project, configuration }, { project: next, configuration }], readyProjectIds: [f.project.projectId, next.projectId], targetProjectIds: [f.project.projectId, next.projectId], globalConfiguration: configuration, maxConcurrent: 1, preferPlatformSpecificTasks: false });
      release(); await tick;
      expect(f.remote.claim).not.toHaveBeenCalled();
      expect(f.tasks.start).not.toHaveBeenCalled();
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
      await f.coordinator.tick();
      await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
      expect(f.tasks.start.mock.calls[0]![0]).toMatchObject(owner);
      expect(f.remote.claim).not.toHaveBeenCalled();
    } finally { release(); await tick; await f.coordinator.shutdown(); }
  });

  it("keeps an in-flight grant pending if a project appears before the grant returns", async () => {
    const f = await fixture();
    const next: WorkerProject = { projectId: uuid(11), repoUrl: "https://example.test/next.git", localPath: path.join(f.root, "next") };
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.remote.claim).mockImplementationOnce(async (candidate, descriptor) => { await pending; return f.grant(candidate, descriptor); });
    const tick = f.coordinator.tick();
    try {
      await eventually(() => expect(f.remote.claim).toHaveBeenCalledOnce());
      f.store.registerProject(next);
      release(); await tick;
      expect(f.store.listUnfinishedTasks()[0]?.status).toBe("pending");
      expect(f.tasks.start).not.toHaveBeenCalled();
      await f.coordinator.tick();
      await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    } finally { release(); await tick; await f.coordinator.shutdown(); }
  });

  it("waits for unreadable repository resource discovery before healthy project admission", async () => {
    const f = await fixture();
    const broken: WorkerProject = { projectId: uuid(11), repoUrl: "https://example.test/broken.git", localPath: path.join(f.root, "broken") };
    f.store.registerProject(broken);
    const list = vi.mocked(f.git.listWorktrees).getMockImplementation()!;
    vi.mocked(f.git.listWorktrees).mockImplementation(async (project, operation) => {
      if (project.projectId === broken.projectId) throw new Error("cannot inspect repository");
      return list(project, operation);
    });
    await f.coordinator.tick();
    expect(f.remote.claim).not.toHaveBeenCalled();
    expect(f.events.some(event => event.message.includes(`Could not inspect Git worktrees for project ${broken.projectId}`))).toBe(true);
    vi.mocked(f.git.listWorktrees).mockImplementation(list);
    await f.coordinator.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    expect(f.remote.claim).toHaveBeenCalledOnce();
    await f.coordinator.shutdown();
  });

  it("retains completed historical claims and waits for repository discovery", async () => {
    const f = await fixture();
    const broken: WorkerProject = { projectId: uuid(11), repoUrl: "https://example.test/broken.git", localPath: path.join(f.root, "broken") };
    f.store.registerProject(broken);
    const historical = { projectId: broken.projectId, taskId: uuid(900), claimId: uuid(901) };
    f.store.registerPending({ ...historical, agent: "codex" });
    f.store.completeTask(historical);
    const list = vi.mocked(f.git.listWorktrees).getMockImplementation()!;
    vi.mocked(f.git.listWorktrees).mockImplementation(async (project, operation) => {
      if (project.projectId === broken.projectId) throw new Error("cannot inspect repository");
      return list(project, operation);
    });
    await f.coordinator.tick();
    expect(f.remote.claim).not.toHaveBeenCalled();
    vi.mocked(f.git.listWorktrees).mockImplementation(list);
    await f.coordinator.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    expect(f.remote.claim).toHaveBeenCalledOnce();
    expect(f.store.getTask(historical)?.status).toBe("done");
    await f.coordinator.shutdown();
  });

  it("retains a previously observed completed claim's pending cleanup through a later Git failure", async () => {
    const f = await fixture();
    const broken: WorkerProject = { projectId: uuid(11), repoUrl: "https://example.test/broken.git", localPath: path.join(f.root, "broken") };
    f.store.registerProject(broken);
    const owner = { projectId: broken.projectId, taskId: uuid(900), claimId: uuid(901), worktreeId: uuid(902) };
    f.store.registerPending({ ...owner, agent: "codex" });
    f.store.completeTask(owner);
    f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const candidates = f.candidates.splice(0);
    vi.mocked(f.git.removeWorktree).mockImplementation(async (_project, current) => { await pending; f.worktrees.delete(current.claimId); return { kind: "absent", effectErrors: [] }; });
    const list = vi.mocked(f.git.listWorktrees).getMockImplementation()!;
    try {
      await f.coordinator.tick();
      await eventually(() => expect(f.git.removeWorktree).toHaveBeenCalledOnce());
      f.candidates.push(...candidates);
      vi.mocked(f.git.listWorktrees).mockImplementation(async (project, operation) => {
        if (project.projectId === broken.projectId) throw new Error("cannot inspect repository");
        return list(project, operation);
      });
      await f.coordinator.tick();
      expect(f.remote.claim).not.toHaveBeenCalled();
      expect(f.worktrees.has(owner.claimId)).toBe(true);
      release(); f.stoppedRuns.add(owner.claimId);
      await eventually(() => expect(f.worktrees.has(owner.claimId)).toBe(false));
      await f.coordinator.tick(); expect(f.remote.claim).not.toHaveBeenCalled();
      vi.mocked(f.git.listWorktrees).mockImplementation(list);
      await eventually(async () => { await f.coordinator.tick(); expect(f.remote.claim).toHaveBeenCalledOnce(); });
    } finally { release(); await f.coordinator.shutdown(); }
  });

  it("retains capacity for a recorded Git-only owner while its repository cannot be inspected", async () => {
    const f = await fixture();
    const broken: WorkerProject = { projectId: uuid(11), repoUrl: "https://example.test/broken.git", localPath: path.join(f.root, "broken") };
    f.store.registerProject(broken);
    const owner = { projectId: broken.projectId, taskId: uuid(900), claimId: uuid(901), worktreeId: uuid(902) };
    f.grant(task(broken.projectId, owner.taskId), { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex" });
    f.store.registerPending({ ...owner, agent: "codex" });
    f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    const list = vi.mocked(f.git.listWorktrees).getMockImplementation()!;
    vi.mocked(f.git.listWorktrees).mockImplementation(async (project, operation) => {
      if (project.projectId === broken.projectId) throw new Error("cannot inspect repository");
      return list(project, operation);
    });
    await f.coordinator.tick();
    expect(f.remote.claim).not.toHaveBeenCalled();
    expect(f.store.getTask(owner)?.status).toBe("pending");
    expect(f.worktrees.has(owner.claimId)).toBe(true);
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
    vi.mocked(f.git.listWorktrees).mockImplementation(list);
    f.worktrees.delete(owner.claimId);
    await f.coordinator.tick();
    await eventually(() => expect(f.remote.claim).toHaveBeenCalledOnce());
    await f.coordinator.shutdown();
  });

  it("retains capacity while stop is unconfirmed and releases it after direct stop without deleting the original claim or worktree", async () => {
    const f = await fixture();
    await f.coordinator.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    const row = f.store.listUnfinishedTasks()[0]!;
    const claim = f.grants.get(row.claimId)!;
    const second: WorkerProject = { projectId: uuid(11), repoUrl: "https://example.test/other/repo.git", localPath: path.join(f.root, "other") };
    f.store.registerProject(second);
    f.candidates.push(task(second.projectId, uuid(102)));
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    f.tasks.stopAndClose.mockImplementationOnce(async owner => { await pending; f.resources.delete(owner.claimId); });
    f.coordinator.updateConfiguration({ repositories: [{ project: second, configuration }], readyProjectIds: [second.projectId], targetProjectIds: [second.projectId], globalConfiguration: configuration, maxConcurrent: 1, preferPlatformSpecificTasks: false });
    const stopping = f.coordinator.stopProject(f.project.projectId);
    try {
      await eventually(() => expect(f.tasks.stopAndClose).toHaveBeenCalledOnce());
      await f.coordinator.tick();
      expect(f.remote.claim).toHaveBeenCalledOnce();
      expect(f.store.getTask(row)).toEqual(row);
      expect(f.worktrees.has(row.claimId)).toBe(true);
      release(); await stopping;
      await f.coordinator.tick();
      await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(2));
      expect(f.grants.get(row.claimId)).toEqual(claim);
      expect(f.store.getTask(row)).toEqual(row);
      expect(f.worktrees.has(row.claimId)).toBe(true);
      expect(f.git.removeWorktree).not.toHaveBeenCalled();
      await f.coordinator.tick();
      expect(f.tasks.start).toHaveBeenCalledTimes(2);
    } finally { release(); await stopping; await f.coordinator.shutdown(); }
  });

  it("does not release capacity on a failed stop and retries without deleting the worktree", async () => {
    const f = await fixture();
    await f.coordinator.tick(); await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    const row = f.store.listUnfinishedTasks()[0]!;
    f.coordinator.updateConfiguration({ repositories: [], readyProjectIds: [], targetProjectIds: [], globalConfiguration: configuration, maxConcurrent: 1, preferPlatformSpecificTasks: false });
    f.tasks.stopAndClose.mockRejectedValueOnce(new Error("stop failed"));
    await expect(f.coordinator.stopProject(f.project.projectId)).rejects.toThrow("Project execution stop was not confirmed");
    expect(f.resources.has(row.claimId)).toBe(true);
    expect(f.worktrees.has(row.claimId)).toBe(true);
    await f.coordinator.stopProject(f.project.projectId);
    expect(f.resources.has(row.claimId)).toBe(false);
    expect(f.worktrees.has(row.claimId)).toBe(true);
    expect(f.store.getTask(row)).toEqual(row);
    await f.coordinator.shutdown();
  });
});

describe("Web acquisition configuration changes", () => {
  it("does not reinterpret an unfrozen Web claim with current Herdr parameters", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase());
    const granted = f.grant(f.candidates[0]!, { claimId: uuid(991), worktreeId: uuid(992), workerId, machine: f.options.machine, platform: "linux", agent: "codex", agentControlMode: "web" });
    f.candidates.splice(0);
    const row = f.store.activateTask(f.store.registerPending({ projectId: granted.projectId, taskId: granted.id, claimId: uuid(991), agent: "codex", agentControlMode: "web" }));
    const current: ExecutionConfiguration = { ...configuration, agentControlMode: "herdr", args: [] };
    const advance = vi.fn(async (record: WebTask) => record);
    const runner = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: current }], globalConfiguration: current, webStore,
      verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: async record => ({ task: record, complete: true }) } });
    try {
      await runner.tick();
      expect(f.store.getNativeConfiguration(row)).toBeNull(); expect(webStore.getTask(row)).toBeNull();
      expect(f.store.getTask(row)).toEqual(row); expect(advance).not.toHaveBeenCalled(); expect(f.tasks.start).not.toHaveBeenCalled();
    } finally { await runner.shutdown(); webStore.close(); }
  });

  it.each(["mode", "native", "project removed", "project unavailable"] as const)("preserves a granted Web claim's frozen settings after an in-flight %s change", async change => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(); f.candidates.splice(1);
    const webStore = openWebExecutionStore(createMemoryDatabase());
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
      const changed: ExecutionConfiguration = { ...native, agentControlMode: change === "mode" ? "herdr" : "web", model: "later-model", args: ["--effort", "high"], recoveryLimit: 7 };
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
      expect(f.remote.claim).toHaveBeenCalledOnce(); expect(f.tasks.start).not.toHaveBeenCalled();
    } finally { release(); await ticking; await runner.shutdown(); webStore.close(); }
  });

  it.each(["equivalent", "changed", "changed and restored"] as const)("handles %s updates during capability validation", async mode => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(); f.candidates.splice(1);
    const webStore = openWebExecutionStore(createMemoryDatabase());
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
});

describe("applied cloud runtime configuration", () => {
  it("keeps a frozen claim available when the current project tuple is unavailable", async () => {
    const f = await fixture();
    await f.coordinator.tick(); await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const original = f.store.listUnfinishedTasks()[0]!;
    await f.coordinator.advanceRetry(original);
    const observed = f.tasks.observe.mock.calls.length;
    f.coordinator.updateConfiguration({ repositories: [], readyProjectIds: [f.project.projectId], globalConfiguration: { ...configuration, model: "unrelated-global-model" }, maxConcurrent: 2, preferPlatformSpecificTasks: false });
    await f.coordinator.tick();
    await eventually(() => expect(f.tasks.observe.mock.calls.length).toBeGreaterThan(observed));
    expect(f.tasks.start).toHaveBeenCalledOnce();
    expect(f.remote.claim).toHaveBeenCalledOnce();
    expect(f.tasks.stopAndClose).not.toHaveBeenCalled();
    await expect(f.coordinator.advanceRetry(original)).resolves.toBeUndefined();
    expect(f.tasks.start.mock.calls[0]![2].configuration).toMatchObject(configuration);
    await f.coordinator.shutdown();
  });

  it("changes future capacity and native parameters without restarting a healthy process", async () => {
    const f = await fixture(1);
    await f.coordinator.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    const first = f.tasks.start.mock.calls[0]![2];
    const native = { ...configuration, model: "updated-model", args: ["--search"] };
    f.coordinator.updateConfiguration({ repositories: [{ project: f.project, configuration: native }], globalConfiguration: native, maxConcurrent: 2, preferPlatformSpecificTasks: false });
    native.model = "mutated-after-publication";
    native.args.push("--no-alt-screen");
    await f.coordinator.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(2));
    expect(f.tasks.start.mock.calls[1]![2].configuration).toMatchObject({ model: "updated-model", args: ["--search"] });
    expect(first.configuration.model).toBe("current-model");
    expect(f.tasks.stopAndClose).not.toHaveBeenCalled();
    f.candidates.push(task(f.project.projectId, uuid(102)));
    f.coordinator.updateConfiguration({ repositories: [{ project: f.project, configuration }], globalConfiguration: configuration, maxConcurrent: 1, preferPlatformSpecificTasks: false });
    await f.coordinator.tick();
    expect(f.remote.claim).toHaveBeenCalledTimes(2);
    expect(f.tasks.start).toHaveBeenCalledTimes(2);
    expect(f.tasks.stopAndClose).not.toHaveBeenCalled();
    await f.coordinator.shutdown();
  });

  it("uses a changed recovery limit on the next serialized advancement", async () => {
    const f = await fixture();
    await f.coordinator.tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const failed = new Error("native observation failed");
    f.tasks.observe.mockRejectedValueOnce(failed);
    await f.coordinator.tick();
    await eventually(() => expect(f.events).toContainEqual(expect.objectContaining({ kind: "execution-error", error: failed })));
    const observations = f.tasks.observe.mock.calls.length;
    const exhausted = { ...configuration, recoveryLimit: 0 };
    f.coordinator.updateConfiguration({ repositories: [{ project: f.project, configuration: exhausted }], globalConfiguration: exhausted, maxConcurrent: 1, preferPlatformSpecificTasks: false });
    await f.coordinator.tick();
    expect(f.tasks.observe).toHaveBeenCalledTimes(observations);
    const resumed = { ...configuration, recoveryLimit: 5 };
    f.coordinator.updateConfiguration({ repositories: [{ project: f.project, configuration: resumed }], globalConfiguration: resumed, maxConcurrent: 1, preferPlatformSpecificTasks: false });
    await f.coordinator.tick();
    await eventually(() => expect(f.tasks.observe).toHaveBeenCalledTimes(observations + 1));
    expect(f.tasks.start).toHaveBeenCalledOnce();
    await f.coordinator.shutdown();
  });

  it("retains an in-flight grant as pending when its project is removed from the cloud target", async () => {
    const f = await fixture();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.remote.claim).mockImplementationOnce(async (candidate, descriptor) => { await pending; return f.grant(candidate, descriptor); });
    const ticking = f.coordinator.tick();
    try {
      await eventually(() => expect(f.remote.claim).toHaveBeenCalledOnce());
      f.coordinator.updateConfiguration({ repositories: [], readyProjectIds: [], targetProjectIds: [], globalConfiguration: configuration, maxConcurrent: 1, preferPlatformSpecificTasks: false });
      release(); await ticking;
      expect(f.store.listUnfinishedTasks()).toEqual([expect.objectContaining({ projectId: f.project.projectId, status: "pending" })]);
      expect(f.grants.size).toBe(1);
      expect(f.store.listUnfinishedTasks()[0]!.claimId).toBe([...f.grants.keys()][0]);
      expect(f.git.prepareWorktree).not.toHaveBeenCalled();
      expect(f.tasks.start).not.toHaveBeenCalled();
    } finally { release(); await ticking; await f.coordinator.shutdown(); }
  });

  it("retains an in-flight grant as pending when its selected project becomes unready", async () => {
    const f = await fixture();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.remote.claim).mockImplementationOnce(async (candidate, descriptor) => { await pending; return f.grant(candidate, descriptor); });
    const ticking = f.coordinator.tick();
    await eventually(() => expect(f.remote.claim).toHaveBeenCalledOnce());
    f.coordinator.updateConfiguration({ repositories: [], readyProjectIds: [], targetProjectIds: [f.project.projectId], globalConfiguration: configuration, maxConcurrent: 1, preferPlatformSpecificTasks: false });
    release(); await ticking;
    expect(f.store.listUnfinishedTasks()).toHaveLength(1);
    expect(f.store.listUnfinishedTasks()[0]!.status).toBe("pending");
    expect(f.tasks.start).not.toHaveBeenCalled();
    await f.coordinator.tick();
    expect(f.tasks.start).not.toHaveBeenCalled();
    expect(f.store.listUnfinishedTasks()[0]!.status).toBe("pending");
    expect(f.store.getProject(f.project)).toEqual(f.project);
    expect(f.grants.size).toBe(1);
    await f.coordinator.shutdown();
  });
});

describe("worker monitoring of coordinator jobs", () => {
  it("reports the selected project worktree when preparation fails before creating it", async () => {
    const f = await fixture(), monitor = createMonitoringObserver();
    const cause = new Error("private error text");
    vi.mocked(f.git.prepareWorktree).mockRejectedValueOnce(cause);
    const coordinator = createWorkerCoordinator({ ...f.options, monitoring: monitor });
    try {
      await coordinator.tick();
      await eventually(() => expect(monitor.capture("1").currentFailures).toHaveLength(1));
      const failure = monitor.capture("1").currentFailures[0]!;
      const claim = [...f.grants.values()][0]!;
      expect(failure).toMatchObject({ phase: "worktree-preparation", worktree: { kind: "project-relative", path: `.worktrees/daynight/${readWorkerClaim(claim.properties)!.worktreeId}` } });
      expect(JSON.stringify(failure)).not.toContain(f.project.localPath);
      expect(JSON.stringify(failure)).not.toContain("private error text");
    } finally { await coordinator.shutdown(); }
  });
  it("retains a cold workspace stop failure until that stop is confirmed", async () => {
    const f = await fixture(), monitor = createMonitoringObserver();
    const owner = { projectId: f.project.projectId, taskId: uuid(100), claimId: uuid(901), worktreeId: uuid(902) };
    f.grant(f.candidates[0]!, { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, agent: "codex", platform: "linux", machine: { id: uuid(3), name: "fixture" } });
    f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex" }));
    const binding = { session: "w", workspaceId: "old", paneId: "old-pane", terminalId: "old-terminal" };
    f.resources.set(owner.claimId, { owner, workspaceId: binding.workspaceId, panes: [{ binding, cwd: f.bind(owner).worktreePath, kind: null, status: "idle", launchPending: false, interactiveReady: false, nativeSession: null, stateChangeSeq: 0, completionSeq: 0 }] });
    f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    f.tasks.stopAndClose.mockRejectedValueOnce(new Error("old workspace retained")).mockRejectedValueOnce(new Error("old workspace retained"));
    const coordinator = createWorkerCoordinator({ ...f.options, monitoring: monitor });
    try {
      await coordinator.tick(); await eventually(() => expect(monitor.capture("1").currentFailures).toHaveLength(1));
      const failure = monitor.capture("1").currentFailures[0]!;
      expect(failure).toMatchObject({ component: "execution", phase: "observation", occurrencesInRun: 1 });
      await coordinator.tick(); await eventually(() => expect(f.tasks.stopAndClose).toHaveBeenCalledTimes(2));
      await eventually(() => expect(monitor.capture("2").currentFailures).toContainEqual(expect.objectContaining({ operationId: failure.operationId, occurrencesInRun: 2 })));
      expect(monitor.capture("2").lastRecovery).toBeNull();
      await coordinator.tick();
      await eventually(() => expect(monitor.capture("3").lastRecovery).toMatchObject({ operationId: failure.operationId }));
      expect(monitor.capture("3").currentFailures).not.toContainEqual(expect.objectContaining({ operationId: failure.operationId }));
    } finally { await coordinator.shutdown(); }
  });

  it("keeps inventory failure scoped to its project and recovers only after that project is covered", async () => {
    const f = await fixture(), monitor = createMonitoringObserver();
    const coordinator = createWorkerCoordinator({ ...f.options, monitoring: monitor });
    const failure = new Error("private inventory failure");
    vi.mocked(f.remote.ownInventory).mockImplementationOnce(async (_projects, _worker, _signal, _onUnavailable, onFailure) => { onFailure?.(f.project.projectId, failure); throw failure; });
    try {
      await expect(coordinator.tick()).rejects.toBe(failure);
      const failed = monitor.capture("1");
      expect(failed.currentFailures).toHaveLength(1);
      expect(failed.currentFailures[0]).toMatchObject({ component: "inventory", phase: "inventory", scope: { kind: "project", projectId: f.project.projectId } });
      expect(JSON.stringify(failed)).not.toContain("private inventory failure");
      f.candidates.splice(0); await coordinator.tick();
      expect(monitor.capture("2").currentFailures).toHaveLength(0);
      expect(monitor.capture("2").lastRecovery).toMatchObject({ operationId: failed.currentFailures[0]!.operationId });
    } finally { await coordinator.shutdown(); }
  });

  it.each(["unexpected", "handled"] as const)("keeps %s workspace naming failure until that naming operation succeeds", async mode => {
    const f = await fixture(), monitor = createMonitoringObserver();
    const coordinator = createWorkerCoordinator({ ...f.options, monitoring: monitor });
    try {
      await coordinator.tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
      const failure = mode === "handled" ? new HerdrAgentActionError("private name error", "workspace.rename", "unknown") : new Error("private name error");
      f.tasks.syncWorkspaceName.mockRejectedValueOnce(failure);
      await coordinator.tick();
      await eventually(() => expect(monitor.capture("1").currentFailures).toHaveLength(1));
      const failed = monitor.capture("1").currentFailures[0]!;
      expect(failed).toMatchObject({ component: "execution", phase: "observation" });
      expect(JSON.stringify(monitor.capture("1"))).not.toContain("private name error");
      if (mode === "handled") await eventually(() => expect(f.tasks.observe).toHaveBeenCalled());
      expect(monitor.capture("2").currentFailures).toContainEqual(expect.objectContaining({ operationId: failed.operationId }));
      await coordinator.tick();
      await eventually(() => expect(monitor.capture("3").lastRecovery).toMatchObject({ operationId: failed.operationId }));
      expect(monitor.capture("3").currentFailures).not.toContainEqual(expect.objectContaining({ operationId: failed.operationId }));
    } finally { await coordinator.shutdown(); }
  });

  it("uses the original lifecycle cwd for first naming failure and recovery limit after restart", async () => {
    const f = await fixture(), monitor = createMonitoringObserver();
    await f.coordinator.tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
    const owner = [...f.worktrees.values()][0]!.owner;
    const cwd = f.bind(owner).worktreePath;
    const worktreePath = vi.fn(() => cwd);
    Object.assign(f.herdr, { lifecycle: { responsibilities: () => [owner], isStopped: () => false, worktreePath, stop: vi.fn(async () => {}) } });
    const limited = { ...configuration, recoveryLimit: 0 };
    const restarted = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: limited }], globalConfiguration: limited, monitoring: monitor });
    try {
      f.tasks.syncWorkspaceName.mockRejectedValueOnce(new Error("private naming failure"));
      await restarted.tick();
      await eventually(() => expect(monitor.capture("1").currentFailures).toHaveLength(1));
      expect(monitor.capture("1").currentFailures[0]).toMatchObject({ phase: "observation", worktree: { kind: "project-relative", path: `.worktrees/daynight/${owner.worktreeId}` } });
      expect(worktreePath).toHaveBeenCalledWith(owner);
      await restarted.tick();
      await eventually(() => expect(monitor.capture("2").currentFailures).toContainEqual(expect.objectContaining({ error: expect.objectContaining({ code: "recovery-limit" }), worktree: { kind: "project-relative", path: `.worktrees/daynight/${owner.worktreeId}` } })));
    } finally { await restarted.shutdown(); await f.coordinator.shutdown(); }
  });

  it("uses the original lifecycle cwd for an execution failure before selecting a worktree", async () => {
    const f = await fixture(), monitor = createMonitoringObserver();
    const owner = { projectId: f.project.projectId, taskId: uuid(100), claimId: uuid(901), worktreeId: uuid(902) };
    f.grant(f.candidates[0]!, { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, agent: "codex", platform: "linux", machine: { id: uuid(3), name: "fixture" } });
    f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex" }));
    const cwd = path.join(f.root, "retained-worktree"), worktreePath = vi.fn(() => cwd);
    Object.assign(f.herdr, { lifecycle: { responsibilities: () => [owner], isStopped: () => false, worktreePath, stop: vi.fn(async () => {}) } });
    vi.spyOn(f.store, "freezeNativeConfiguration").mockImplementation(() => { throw new Error("private configuration failure"); });
    const coordinator = createWorkerCoordinator({ ...f.options, monitoring: monitor });
    try {
      await coordinator.tick();
      await eventually(() => expect(monitor.capture("1").currentFailures).toHaveLength(1));
      expect(monitor.capture("1").currentFailures[0]).toMatchObject({ phase: "observation", worktree: { kind: "project-relative", path: "../retained-worktree" } });
      expect(worktreePath).toHaveBeenCalledWith(owner);
      expect(f.git.prepareWorktree).not.toHaveBeenCalled();
    } finally { await coordinator.shutdown(); }
  });

  it("retains an execution failure after a handled naming failure in the same job", async () => {
    const f = await fixture(), monitor = createMonitoringObserver();
    const coordinator = createWorkerCoordinator({ ...f.options, monitoring: monitor });
    try {
      await coordinator.tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
      f.tasks.syncWorkspaceName.mockRejectedValueOnce(new HerdrAgentActionError("rename failed", "workspace.rename", "unknown"));
      f.tasks.observe.mockRejectedValueOnce(new Error("observation failed"));
      await coordinator.tick();
      await eventually(() => expect(monitor.capture("1").currentFailures).toHaveLength(2));
      expect(monitor.capture("1").currentFailures.map(item => item.phase).sort()).toEqual(["agent-observation", "observation"]);
    } finally { await coordinator.shutdown(); }
  });

  it("keeps project stop waiting until the original execution is confirmed stopped", async () => {
    const f = await fixture(), monitor = createMonitoringObserver();
    const coordinator = createWorkerCoordinator({ ...f.options, monitoring: monitor });
    try {
      await coordinator.tick(); await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
      const owner = [...f.worktrees.values()][0]!.owner;
      coordinator.updateConfiguration({ repositories: [], readyProjectIds: [], targetProjectIds: [], globalConfiguration: configuration, maxConcurrent: 1, preferPlatformSpecificTasks: false });
      f.tasks.stopAndClose.mockRejectedValueOnce(new Error("unconfirmed stop"));
      await expect(coordinator.stopProject(f.project.projectId)).rejects.toThrow("Project execution stop was not confirmed");
      expect(monitor.capture("1").activities).toContainEqual(expect.objectContaining({ kind: "execution", status: "waiting", waitReason: "resource-stop", scope: expect.objectContaining({ claimId: owner.claimId }) }));
      await coordinator.stopProject(f.project.projectId);
      expect(monitor.capture("2").activities.some(activity => activity.kind === "execution" && activity.scope.kind === "claim" && activity.scope.claimId === owner.claimId)).toBe(false);
      expect(f.store.getTask(owner)?.status).toBe("active");
    } finally { await coordinator.shutdown(); }
  });

  it("records candidate search failures only in their actual project and recovers after complete search", async () => {
    const f = await fixture(), monitor = createMonitoringObserver();
    const coordinator = createWorkerCoordinator({ ...f.options, monitoring: monitor });
    const failure = new Error("secret project path");
    vi.mocked(f.remote.candidates).mockImplementationOnce(async function* () { throw failure; });
    try {
      await expect(coordinator.tick()).rejects.toBe(failure);
      const failed = monitor.capture("1");
      expect(failed.currentFailures).toHaveLength(1);
      expect(failed.currentFailures[0]).toMatchObject({ component: "scheduler", phase: "claim-search", scope: { kind: "project", projectId: f.project.projectId } });
      expect(JSON.stringify(failed)).not.toContain("secret project path");
      f.candidates.splice(0); await coordinator.tick();
      expect(monitor.capture("2").currentFailures).toHaveLength(0);
      expect(monitor.capture("2").lastRecovery).toMatchObject({ operationId: failed.currentFailures[0]!.operationId });
    } finally { await coordinator.shutdown(); }
  });

  it("reports an exhausted Herdr recovery limit once until the failed operation recovers", async () => {
    const f = await fixture(), monitor = createMonitoringObserver(), limited = { ...configuration, recoveryLimit: 0 };
    const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: limited }], globalConfiguration: limited, monitoring: monitor });
    try {
      await coordinator.tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
      const failure = new Error("native observation failed");
      f.tasks.observe.mockRejectedValueOnce(failure);
      await coordinator.tick(); await eventually(() => expect(f.events).toContainEqual(expect.objectContaining({ kind: "execution-error", error: failure })));
      await coordinator.tick();
      await eventually(() => expect(monitor.capture("1").currentFailures).toContainEqual(expect.objectContaining({ error: expect.objectContaining({ code: "recovery-limit" }), retryState: "manual", occurrencesInRun: 1 })));
      expect(monitor.capture("1").activities).toContainEqual(expect.objectContaining({ kind: "execution", status: "paused", waitReason: "recovery-blocked" }));
      await coordinator.tick(); await coordinator.tick();
      expect(monitor.capture("2").currentFailures.filter(item => item.error.code === "recovery-limit")).toMatchObject([{ occurrencesInRun: 1 }]);
      const resumed = { ...configuration, recoveryLimit: 5 };
      coordinator.updateConfiguration({ repositories: [{ project: f.project, configuration: resumed }], globalConfiguration: resumed, maxConcurrent: 1, preferPlatformSpecificTasks: false });
      await coordinator.tick();
      await eventually(() => expect(monitor.capture("3").currentFailures).toHaveLength(0));
    } finally { await coordinator.shutdown(); }
  });

  it("resolves a naming-related recovery limit only after a permitted retry observes the same boundary", async () => {
    const f = await fixture(), monitor = createMonitoringObserver(), limited = { ...configuration, recoveryLimit: 0 };
    const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: limited }], globalConfiguration: limited, monitoring: monitor });
    try {
      await coordinator.tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
      f.tasks.syncWorkspaceName.mockRejectedValueOnce(new Error("naming failed"));
      await coordinator.tick(); await eventually(() => expect(monitor.capture("1").currentFailures).toHaveLength(1));
      await coordinator.tick();
      await eventually(() => expect(monitor.capture("2").currentFailures).toContainEqual(expect.objectContaining({ error: expect.objectContaining({ code: "recovery-limit" }), retryState: "manual" })));
      await eventually(() => expect(monitor.capture("2").currentFailures).toHaveLength(1));
      expect(monitor.capture("2").currentFailures[0]!.error.code).toBe("recovery-limit");
      const resumed = { ...configuration, recoveryLimit: 5 };
      coordinator.updateConfiguration({ repositories: [{ project: f.project, configuration: resumed }], globalConfiguration: resumed, maxConcurrent: 1, preferPlatformSpecificTasks: false });
      await coordinator.tick(); await eventually(() => expect(monitor.capture("3").currentFailures).toHaveLength(0));
      expect(monitor.capture("3").lastRecovery?.component).toBe("execution");
    } finally { await coordinator.shutdown(); }
  });

  it("does not resolve a naming-related limit while another execution boundary remains failed", async () => {
    const f = await fixture(), monitor = createMonitoringObserver(), limited = { ...configuration, recoveryLimit: 1 };
    const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: limited }], globalConfiguration: limited, monitoring: monitor });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      await coordinator.tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
      const observe = f.tasks.observe.getMockImplementation()!;
      f.tasks.observe.mockRejectedValueOnce(new Error("observation failed"));
      await coordinator.tick(); await eventually(() => expect(monitor.capture("1").currentFailures).toHaveLength(1));
      f.tasks.syncWorkspaceName.mockRejectedValueOnce(new Error("naming failed"));
      await coordinator.tick(); await eventually(() => expect(monitor.capture("2").currentFailures).toHaveLength(2));
      await coordinator.tick(); await eventually(() => expect(monitor.capture("3").currentFailures).toContainEqual(expect.objectContaining({ error: expect.objectContaining({ code: "recovery-limit" }) })));
      const resumed = { ...configuration, recoveryLimit: 5 };
      coordinator.updateConfiguration({ repositories: [{ project: f.project, configuration: resumed }], globalConfiguration: resumed, maxConcurrent: 1, preferPlatformSpecificTasks: false });
      f.tasks.observe.mockImplementationOnce(async (...args) => { await gate; return observe(...args); });
      await coordinator.tick(); await eventually(() => expect(f.tasks.observe).toHaveBeenCalledTimes(2));
      const pending = monitor.capture("4");
      expect(pending.currentFailures).toContainEqual(expect.objectContaining({ phase: "agent-observation" }));
      expect(pending.currentFailures).toContainEqual(expect.objectContaining({ error: expect.objectContaining({ code: "recovery-limit" }) }));
      release(); await eventually(() => expect(monitor.capture("5").currentFailures).toHaveLength(0));
    } finally { release(); await coordinator.shutdown(); }
  });

  it("reports an archive removal retry until the original deletion is confirmed", async () => {
    const f = await fixture(), monitor = createMonitoringObserver(); f.options.repositories = [];
    const owner = { projectId: f.project.projectId, taskId: uuid(975), claimId: uuid(985), worktreeId: uuid(995) };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex" }));
    f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    const retained = { owner, sessionId: uuid(1005), stopped: true, stopEvidence: archiveFixture.runs.map(run => run.stopProof), terminal: true, worktreePath: f.bind(owner).worktreePath, sourcePath: path.join(f.root, "source"), sourceBytes: "10", state: "ready", error: null, nextAttemptAt: null, worktreeDeleted: false, disposition: null };
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let attempts = 0;
    const archive = { resources: () => [retained], advance: vi.fn(async () => { if (++attempts > 1) await gate; return true; }), cleaned: () => { retained.worktreeDeleted = true; } };
    Object.assign(f.herdr, { lifecycle: { responsibilities: () => retained.worktreeDeleted ? [] : [owner], isStopped: () => true, archive, stop: vi.fn() } });
    const coordinator = createWorkerCoordinator({ ...f.options, hasHerdrJournal: true, monitoring: monitor });
    try {
      vi.mocked(f.git.removeWorktree).mockRejectedValueOnce(new Error("secret /private/recording"));
      await coordinator.tick();
      await eventually(() => expect(monitor.capture("1").currentFailures).toHaveLength(1));
      const failed = monitor.capture("1"), failure = failed.currentFailures[0]!;
      expect(failure).toMatchObject({ component: "cleanup", phase: "worktree-removal", retryState: "scheduled", nextAttemptAt: new Date(6000).toISOString(), worktree: { kind: "project-relative", path: `.worktrees/daynight/${owner.worktreeId}` } });
      expect(failed.activities).toContainEqual(expect.objectContaining({ operationId: failure.operationId, kind: "cleanup", phase: "worktree-removal", status: "waiting", waitReason: "retry-backoff" }));
      expect(JSON.stringify(failed)).not.toContain("secret /private/recording");
      f.clock(5999); await coordinator.tick(); expect(archive.advance).toHaveBeenCalledOnce();
      f.clock(6000); await coordinator.tick();
      await eventually(() => expect(archive.advance).toHaveBeenCalledTimes(2));
      expect(monitor.capture("2").currentFailures[0]).toEqual({ ...failure, retryState: "running", nextAttemptAt: null });
      release();
      await eventually(() => expect(monitor.capture("2").lastRecovery).toMatchObject({ operationId: failure.operationId }));
      expect(monitor.capture("2").currentFailures).toHaveLength(0);
      expect(monitor.capture("2").activities).toHaveLength(0);
    } finally { release(); await coordinator.shutdown(); }
  });

  it("uses the existing retained resource without adding archive enumeration for monitoring", async () => {
    const run = async (enabled: boolean) => {
      const f = await fixture(), monitor = createMonitoringObserver(); f.options.repositories = [];
      const owner = { projectId: f.project.projectId, taskId: uuid(976), claimId: uuid(986), worktreeId: uuid(996) };
      f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex" }));
      f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
      const retained = { owner, sessionId: uuid(1006), stopped: true, stopEvidence: archiveFixture.runs.map(run => run.stopProof), terminal: true, worktreePath: f.bind(owner).worktreePath, sourcePath: path.join(f.root, "source"), sourceBytes: "10", state: "failed", error: "private source error", nextAttemptAt: null, worktreeDeleted: false, disposition: null };
      const resources = vi.fn(() => [retained]);
      const archive = { resources, advance: vi.fn(), cleaned: vi.fn() };
      Object.assign(f.herdr, { lifecycle: { responsibilities: () => [owner], isStopped: () => true, archive, stop: vi.fn() } });
      const coordinator = createWorkerCoordinator({ ...f.options, hasHerdrJournal: true, ...(enabled ? { monitoring: monitor } : {}) });
      try {
        await coordinator.tick();
        if (enabled) expect(monitor.capture("1").currentFailures).toContainEqual(expect.objectContaining({ phase: "archive", worktree: { kind: "project-relative", path: `.worktrees/daynight/${owner.worktreeId}` } }));
        return resources.mock.calls.length;
      } finally { await coordinator.shutdown(); }
    };
    const withoutMonitoring = await run(false);
    expect(await run(true)).toBe(withoutMonitoring);
  });

  it("observes archive backoff without counting the same retained error on every tick", async () => {
    const f = await fixture(), monitor = createMonitoringObserver(); f.options.repositories = [];
    const owner = { projectId: f.project.projectId, taskId: uuid(976), claimId: uuid(986), worktreeId: uuid(996) };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex" })); f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    const retained = { owner, sessionId: uuid(1006), stopped: true, stopEvidence: archiveFixture.runs.map(run => run.stopProof), terminal: true, worktreePath: f.bind(owner).worktreePath, sourcePath: path.join(f.root, "source"), sourceBytes: "10", state: "pending", error: null as string | null, nextAttemptAt: null as number | null, worktreeDeleted: false, disposition: null };
    const archive = { resources: () => [retained], advance: vi.fn(async () => { if (retained.error === null) { retained.error = "private path"; retained.nextAttemptAt = 6000; return false; } retained.error = null; retained.nextAttemptAt = null; retained.state = "ready"; return true; }), cleaned: () => { retained.worktreeDeleted = true; } };
    Object.assign(f.herdr, { lifecycle: { responsibilities: () => retained.worktreeDeleted ? [] : [owner], isStopped: () => true, archive, stop: vi.fn() } });
    const coordinator = createWorkerCoordinator({ ...f.options, hasHerdrJournal: true, monitoring: monitor });
    try {
      await coordinator.tick(); await eventually(() => expect(archive.advance).toHaveBeenCalledOnce());
      f.clock(2000); await coordinator.tick();
      const failed = monitor.capture("1"), failure = failed.currentFailures[0]!;
      expect(failure).toMatchObject({ component: "cleanup", phase: "archive", retryState: "scheduled", nextAttemptAt: new Date(6000).toISOString(), occurrencesInRun: 1, worktree: { kind: "project-relative", path: `.worktrees/daynight/${owner.worktreeId}` } });
      expect(JSON.stringify(failed)).not.toContain("private path");
      f.clock(3000); await coordinator.tick(); expect(monitor.capture("2").currentFailures[0]!.occurrencesInRun).toBe(1);
      f.clock(6000); await coordinator.tick(); await eventually(() => expect(monitor.capture("3").lastRecovery).toMatchObject({ operationId: failure.operationId }));
    } finally { await coordinator.shutdown(); }
  });

  it("reports and recovers failed readback of an already deleted archive", async () => {
    const f = await fixture(), monitor = createMonitoringObserver(); f.options.repositories = [];
    const owner = { projectId: f.project.projectId, taskId: uuid(977), claimId: uuid(987), worktreeId: uuid(997) };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex" }));
    const retained = { owner, sessionId: uuid(1007), stopped: true, stopEvidence: archiveFixture.runs.map(run => run.stopProof), terminal: true, worktreePath: path.join(f.root, "wrong", "path"), sourcePath: path.join(f.root, "source"), sourceBytes: "10", state: "ready", error: null, nextAttemptAt: null, worktreeDeleted: true, disposition: null };
    const archive = { resources: () => [retained], advance: vi.fn(), cleaned: vi.fn() };
    Object.assign(f.herdr, { lifecycle: { responsibilities: () => [], isStopped: () => true, archive, stop: vi.fn() } });
    const coordinator = createWorkerCoordinator({ ...f.options, hasHerdrJournal: true, monitoring: monitor });
    try {
      await coordinator.tick(); const failure = monitor.capture("1").currentFailures[0]!;
      expect(failure).toMatchObject({ component: "cleanup", phase: "worktree-removal", worktree: { kind: "project-relative", path: "../wrong/path" } });
      retained.worktreePath = f.bind(owner).worktreePath;
      await coordinator.tick();
      expect(monitor.capture("2").lastRecovery).toMatchObject({ operationId: failure.operationId });
      expect(monitor.capture("2").activities).toHaveLength(0);
    } finally { await coordinator.shutdown(); }
  });

  it("reports a retained original worktree that blocks the only candidate", async () => {
    const f = await fixture(2), monitor = createMonitoringObserver(); f.candidates.splice(1);
    const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(988), worktreeId: uuid(998) };
    f.store.completeTask(f.store.registerPending({ ...owner, agent: "codex" })); f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
    Object.assign(f.herdr, { lifecycle: { responsibilities: () => [owner], isStopped: () => true, assertCanAdvance: () => {}, stop: vi.fn() } });
    const coordinator = createWorkerCoordinator({ ...f.options, monitoring: monitor });
    try {
      await coordinator.tick();
      expect(monitor.capture("1").admission).toMatchObject({ coverage: "complete", reasons: [{ code: "retained-resource-conflict", scope: { kind: "project", projectId: f.project.projectId } }] });
      expect(f.grants.size).toBe(0);
    } finally { await coordinator.shutdown(); }
  });

  it("keeps independent execution and cleanup activities while cleanup is blocked", async () => {
    const f = await fixture(2), monitor = createMonitoringObserver();
    const coordinator = createWorkerCoordinator({ ...f.options, monitoring: monitor });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      await coordinator.tick(); await coordinator.tick();
      await eventually(() => expect(f.store.listTasks().filter(row => row.sessionId !== null)).toHaveLength(2));
      const [ending, active] = [...f.worktrees.values()].map(item => item.owner);
      f.grants.delete(ending!.claimId); f.resources.delete(ending!.claimId); f.stoppedRuns.add(ending!.claimId); f.candidates.splice(0);
      vi.mocked(f.git.removeWorktree).mockImplementation(async (_project, owner) => { await gate; f.worktrees.delete(owner.claimId); return { kind: "absent", effectErrors: [] }; });
      await coordinator.tick();
      await eventually(() => expect(f.git.removeWorktree).toHaveBeenCalledOnce());
      const activities = monitor.capture("1").activities;
      expect(activities).toContainEqual(expect.objectContaining({ kind: "cleanup", status: "running", scope: expect.objectContaining({ claimId: ending!.claimId }) }));
      expect(activities).toContainEqual(expect.objectContaining({ kind: "execution", scope: expect.objectContaining({ claimId: active!.claimId }) }));
      expect(new Set(activities.map(activity => activity.operationId)).size).toBe(activities.length);
      release(); await eventually(() => expect(f.store.getTask(ending!)?.status).toBe("done"));
      await coordinator.tick();
      expect(monitor.capture("2").activities.some(activity => activity.kind === "cleanup" && activity.scope.kind === "claim" && activity.scope.claimId === ending!.claimId)).toBe(false);
    } finally { release(); await coordinator.shutdown(); }
  });

  it("retains cleanup failure and retry activity until the same operation recovers", async () => {
    const f = await fixture(), monitor = createMonitoringObserver();
    const coordinator = createWorkerCoordinator({ ...f.options, monitoring: monitor });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      await coordinator.tick(); await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
      const owner = [...f.worktrees.values()][0]!.owner;
      f.grants.clear(); f.resources.clear(); f.stoppedRuns.add(owner.claimId); f.candidates.splice(0);
      vi.mocked(f.git.removeWorktree).mockRejectedValue(new Error("secret prompt /private/path"));
      await coordinator.tick(); await eventually(() => expect(f.events.some(event => event.kind === "cleanup-error")).toBe(true));
      const failed = monitor.capture("1");
      const error = failed.currentFailures.find(value => value.component === "cleanup")!;
      expect(error).toMatchObject({ phase: "worktree-removal", scope: { kind: "claim", projectId: owner.projectId, taskId: owner.taskId, claimId: owner.claimId }, retryState: "scheduled", nextAttemptAt: new Date(2000).toISOString(), occurrencesInRun: 1, worktree: { kind: "project-relative", path: `.worktrees/daynight/${owner.worktreeId}` } });
      expect(JSON.stringify(failed)).not.toContain("secret prompt");
      expect(failed.activities).toContainEqual(expect.objectContaining({ kind: "cleanup", phase: "worktree-removal", scope: error.scope, status: "waiting", waitReason: "retry-backoff", nextAttemptAt: new Date(2000).toISOString() }));
      f.clock(1999); await coordinator.tick(); expect(f.git.removeWorktree).toHaveBeenCalledOnce();
      vi.mocked(f.git.removeWorktree).mockImplementation(async (_project, identity) => { await gate; f.worktrees.delete(identity.claimId); return { kind: "absent", effectErrors: [] }; });
      f.clock(2000); await coordinator.tick(); await eventually(() => expect(f.git.removeWorktree).toHaveBeenCalledTimes(2));
      expect(monitor.capture("2").currentFailures[0]).toEqual({ ...error, retryState: "running", nextAttemptAt: null });
      release(); await eventually(() => expect(f.store.getTask(owner)?.status).toBe("done"));
      await eventually(() => expect(monitor.capture("2").lastRecovery).toMatchObject({ operationId: error.operationId }));
      const recovered = monitor.capture("2");
      expect(recovered.currentFailures).not.toContainEqual(expect.objectContaining({ operationId: error.operationId }));
      expect(recovered.lastRecovery).toMatchObject({ operationId: error.operationId, component: "cleanup", scope: error.scope, explanation: "The operation recovered." });
    } finally { release(); await coordinator.shutdown(); }
  });

  it("retains separate unattributed Web renewal failures until the original claim is verified", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase()), monitor = createMonitoringObserver({ now: () => 1000 });
    const web = { agent: "codex" as const, agentControlMode: "web" as const, model: "model", args: [], recoveryLimit: 2 };
    const remote = f.grant(f.candidates[0]!, { claimId: uuid(810), workerId, worktreeId: uuid(811), agent: "codex", agentControlMode: "web", platform: "linux", machine: f.options.machine });
    const owner = { projectId: remote.projectId, taskId: remote.id, claimId: uuid(810), worktreeId: uuid(811) };
    f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    const record = webStore.initializeWebExecution(webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: web }, 1), 2);
    type GrantObserver = NonNullable<Parameters<ReturnType<typeof import("../../../src/commands/worker/backends/web-process.js").createWebControllerLauncher>["setGrantObserver"]>[0]>;
    let grantObserver: GrantObserver | undefined;
    const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn(), setGrantObserver: (value: GrantObserver | undefined) => { grantObserver = value; } };
    const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: () => 1000, onUnattributed: (identity, operation, value) => monitor.setUnattributed(`web-renewal/${identity.projectId}/${identity.taskId}/${identity.claimId}/${operation}`, value) });
    const failure = new Error("private ticket path");
    grantObserver!.ticketFailed(record, failure);
    expect(monitor.capture("1")).toMatchObject({ detailCoverage: "partial", currentFailures: [], lastRecovery: null });
    grantObserver!.ticketVerified(record);
    expect(monitor.capture("2")).toMatchObject({ detailCoverage: "complete", currentFailures: [], lastRecovery: null });
    grantObserver!.ticketFailed(record, failure); grantObserver!.failed(record, failure, true);
    grantObserver!.ticketVerified(record);
    expect(monitor.capture("2").detailCoverage).toBe("partial");
    grantObserver!.ticketFailed(record, failure); grantObserver!.ticketFailed(record, failure);
    grantObserver!.started(record);
    let coordinatorHooks: Parameters<typeof backend.setMonitoringObserver>[0] | undefined;
    const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: web }], globalConfiguration: web, webStore, monitoring: monitor, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async task => task), cleanup: vi.fn(), setMonitoringObserver: value => { coordinatorHooks = value; backend.setMonitoringObserver(value); } } });
    try {
      expect(monitor.capture("3")).toMatchObject({ detailCoverage: "partial", currentFailures: [] });
      await coordinator.tick();
      const verified = monitor.capture("4");
      expect(verified.detailCoverage).toBe("complete"); expect(verified.currentFailures).toHaveLength(2);
      expect(verified.currentFailures.map(value => value.occurrencesInRun).sort()).toEqual([1, 2]);
      const retrying = verified.currentFailures.find(value => value.occurrencesInRun === 1)!;
      expect(retrying.retryState).toBe("running");
      grantObserver!.settled(record);
      expect(monitor.capture("4").currentFailures.find(value => value.operationId === retrying.operationId)?.retryState).toBe("none");
      expect(verified.currentFailures.every(value => value.scope.kind === "claim" && value.scope.claimId === owner.claimId)).toBe(true);
      const ticket = verified.currentFailures.find(value => value.occurrencesInRun === 2)!;
      grantObserver!.ticketVerified(record);
      expect(monitor.capture("5").lastRecovery).toMatchObject({ operationId: ticket.operationId });
      expect(monitor.capture("5").currentFailures).toHaveLength(1);
      expect(JSON.stringify(monitor.capture("5"))).not.toContain("private ticket path");
      backend.setMonitoringObserver({});
      grantObserver!.ticketFailed(record, failure);
      expect(monitor.capture("6").detailCoverage).toBe("partial");
      backend.setMonitoringObserver(coordinatorHooks!);
      expect(monitor.capture("7").detailCoverage).toBe("complete");
      expect(monitor.capture("7").currentFailures).toHaveLength(2);
      const lastRecovery = monitor.capture("7").lastRecovery;
      const successor = { ...record, webExecution: { ...record.webExecution!, executionGeneration: "2", launchId: uuid(999) } };
      grantObserver!.ticketVerified(successor);
      expect(monitor.capture("8").currentFailures).toEqual([]);
      expect(monitor.capture("8").lastRecovery).toEqual(lastRecovery);
      grantObserver!.failed(record, failure, true);
      expect(monitor.capture("9").currentFailures).toEqual([]);
      grantObserver!.failed(successor, failure, true);
      const newFailure = monitor.capture("10").currentFailures[0]!;
      grantObserver!.refreshed(record);
      expect(monitor.capture("11").currentFailures).toContainEqual(expect.objectContaining({ operationId: newFailure.operationId }));
      grantObserver!.refreshed(successor);
      expect(monitor.capture("12").lastRecovery).toMatchObject({ operationId: newFailure.operationId });
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("preserves a real in-flight renewal across claim confirmation and cancellation", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
    const { createWebControllerLauncher } = await import("../../../src/commands/worker/backends/web-process.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase()), monitor = createMonitoringObserver({ now: () => 1000 });
    const web = { agent: "codex" as const, agentControlMode: "web" as const, model: "model", args: [], recoveryLimit: 2, toolLaunch: frozenToolLaunch() };
    const remote = f.grant(f.candidates[0]!, { claimId: uuid(810), workerId, worktreeId: uuid(811), agent: "codex", agentControlMode: "web", platform: "linux", machine: f.options.machine });
    const owner = { projectId: remote.projectId, taskId: remote.id, claimId: uuid(810), worktreeId: uuid(811) };
    f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
    let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: web }, 1);
    record = webStore.bindWorktree(record, await f.git.prepareWorktree(f.project, owner, {} as Operation), 2);
    record = webStore.initializeWebExecution(record, 3);
    const grant = vi.fn().mockResolvedValueOnce({ token: "initial", expiresAt: new Date(91_000).toISOString() });
    const sessionApi = { register: vi.fn(async () => ({ sessionId: uuid(812) })), grant, verifySupport: vi.fn(), verifyUnregistered: vi.fn() } as unknown as import("../../../src/commands/worker/backends/session-api.js").WorkerSessionApi;
    const launcher = createWebControllerLauncher({ homeDirectory: f.root, packageDirectory: f.root, store: webStore, sessionApi, now: () => 1000 });
    const ticket = await launcher.prepare(record, "managed", new AbortController().signal);
    record = webStore.updateWebExecution(record, { launchSubmission: "acknowledged" }, 4);
    const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: () => 1000, onUnattributed: (identity, operation, value) => monitor.setUnattributed(`web-renewal/${identity.projectId}/${identity.taskId}/${identity.claimId}/${operation}`, value) });
    const failure = new Error("grant unavailable"); grant.mockRejectedValueOnce(failure);
    await expect(launcher.refreshGrant(record, ticket, new AbortController().signal)).rejects.toBe(failure);
    expect(monitor.capture("1")).toMatchObject({ detailCoverage: "partial", currentFailures: [] });
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), cancellation = new AbortController();
    grant.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return { token: "late", expiresAt: new Date(901_000).toISOString() }; });
    const retry = launcher.refreshGrant(record, ticket, cancellation.signal); void retry.catch(() => {});
    await entered.promise;
    const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: web }], globalConfiguration: web, webStore, monitoring: monitor, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async task => task), cleanup: vi.fn(async task => ({ task, complete: true })), setMonitoringObserver: backend.setMonitoringObserver } });
    try {
      await coordinator.tick();
      const observed = monitor.capture("2").currentFailures[0]!;
      expect(observed).toMatchObject({ phase: "preparing", retryState: "running", occurrencesInRun: 1 });
      cancellation.abort(new Error("cancelled")); gate.resolve(); await expect(retry).rejects.toThrow("cancelled");
      expect(monitor.capture("3").currentFailures[0]).toMatchObject({ operationId: observed.operationId, retryState: "none" });
      expect(monitor.capture("3").lastRecovery).toBeNull();
      grant.mockResolvedValueOnce({ token: "renewed", expiresAt: new Date(901_000).toISOString() });
      await launcher.refreshGrant(record, ticket, new AbortController().signal);
      expect(monitor.capture("4").lastRecovery).toMatchObject({ operationId: observed.operationId });
    } finally { gate.resolve(); cancellation.abort(); await Promise.allSettled([retry]); await coordinator.shutdown(); webStore.close(); }
  });

  it.each(["inventory", "project"] as const)("clears pre-coordinator unknown Web identity on %s loss", async loss => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase()), monitor = createMonitoringObserver(); f.candidates.splice(0);
    const web = { agent: "codex" as const, agentControlMode: "web" as const, model: "model", args: [], recoveryLimit: 2 };
    const owner = { projectId: f.project.projectId, taskId: uuid(30), claimId: uuid(31), worktreeId: uuid(32) };
    const record = webStore.initializeWebExecution(webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: web }, 1), 2);
    type GrantObserver = NonNullable<Parameters<ReturnType<typeof import("../../../src/commands/worker/backends/web-process.js").createWebControllerLauncher>["setGrantObserver"]>[0]>;
    let grantObserver: GrantObserver | undefined;
    const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn(), setGrantObserver: (value: GrantObserver | undefined) => { grantObserver = value; } };
    const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: () => 1000, onUnattributed: (identity, operation, value) => monitor.setUnattributed(`web-renewal/${identity.projectId}/${identity.taskId}/${identity.claimId}/${operation}`, value) });
    grantObserver!.identityUnknown(record);
    expect(monitor.capture("1")).toMatchObject({ detailCoverage: "partial", currentFailures: [], lastRecovery: null });
    const coordinator = createWorkerCoordinator({ ...f.options, monitoring: monitor, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async task => task), cleanup: vi.fn(), setMonitoringObserver: backend.setMonitoringObserver } });
    try {
      expect(monitor.capture("2").detailCoverage).toBe("partial");
      if (loss === "inventory") await coordinator.tick(); else coordinator.invalidateProject(f.project.projectId);
      expect(monitor.capture("3")).toMatchObject({ detailCoverage: "complete", currentFailures: [], lastRecovery: null });
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("clears unattributed renewal state when a complete inventory excludes its claim", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase()), monitor = createMonitoringObserver(); f.candidates.splice(0);
    const web = { agent: "codex" as const, agentControlMode: "web" as const, model: "model", args: [], recoveryLimit: 2 };
    type Monitoring = Parameters<import("../../../src/commands/worker/backends/web.js").WebExecutionBackend["setMonitoringObserver"]>[0];
    let hooks: Monitoring | undefined;
    const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: web }], globalConfiguration: web, webStore, monitoring: monitor, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance: vi.fn(async task => task), cleanup: vi.fn(), setMonitoringObserver: value => { hooks = value; } } });
    try {
      hooks!.observeFailure?.({ projectId: f.project.projectId, taskId: uuid(30), claimId: uuid(31) }, { kind: "execution", phase: "preparing" }, new Error("private"), "grant-ticket");
      expect(monitor.capture("1")).toMatchObject({ detailCoverage: "partial", currentFailures: [], lastRecovery: null });
      await coordinator.tick();
      expect(monitor.capture("2")).toMatchObject({ detailCoverage: "complete", currentFailures: [], lastRecovery: null });
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("keeps Web grant failures through healthy IPC and no-op checks until actual renewal", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase()), monitor = createMonitoringObserver();
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
    const webBackend = { observeExecutionStop: unknownStop, advance, cleanup: vi.fn(), setMonitoringObserver: (value: Monitoring) => { hooks = value; } };
    const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: web }], globalConfiguration: web, webStore, monitoring: monitor, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend });
    try {
      await coordinator.tick(); await eventually(() => expect(monitor.capture("1").currentFailures).toHaveLength(1));
      const first = monitor.capture("1").currentFailures[0]!; expect(first).toMatchObject({ component: "execution", phase: "preparing", occurrencesInRun: 1 });
      await coordinator.tick(); await eventually(() => expect(monitor.capture("2").currentFailures[0]).toMatchObject({ operationId: first.operationId, occurrencesInRun: 2 }));
      await coordinator.tick(); await eventually(() => expect(advance).toHaveBeenCalledTimes(3));
      expect(monitor.capture("3").currentFailures).toContainEqual(expect.objectContaining({ operationId: first.operationId, occurrencesInRun: 2, retryState: "none" }));
      expect(monitor.capture("3").lastRecovery).toBeNull();
      const identity = f.store.listTasks()[0]!;
      hooks!.observeRetry?.(identity, operationKey, true);
      expect(monitor.capture("3").currentFailures[0]!.retryState).toBe("running");
      hooks!.observeRetry?.(identity, operationKey, false);
      expect(monitor.capture("3").currentFailures[0]!.retryState).toBe("none");
      await coordinator.tick(); await eventually(() => expect(monitor.capture("4").lastRecovery).toMatchObject({ operationId: first.operationId }));
      expect(monitor.capture("4").currentFailures).toEqual([]);
      const row = f.store.listTasks()[0]!;
      hooks!.observeFailure?.(row, { kind: "execution", phase: "preparing" }, failure, operationKey);
      const background = monitor.capture("5").currentFailures[0]!; expect(background.phase).toBe("preparing");
      hooks!.observeSuccess?.(row, { kind: "execution", phase: "agent-observation" });
      expect(monitor.capture("6").currentFailures).toContainEqual(expect.objectContaining({ operationId: background.operationId }));
      hooks!.observeSuccess?.(row, { kind: "execution", phase: "preparing" }, operationKey);
      expect(monitor.capture("7").lastRecovery).toMatchObject({ operationId: background.operationId });
      expect(JSON.stringify(monitor.capture("7"))).not.toContain("private grant failure");
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("reports a paused Web recovery without retrying its native execution", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webStore = openWebExecutionStore(createMemoryDatabase()), monitor = createMonitoringObserver();
    const web = { agent: "codex" as const, agentControlMode: "web" as const, model: "model", args: [], recoveryLimit: 2 };
    const advance = vi.fn(async (record: WebTask) => webStore.pauseRecovery(record, "Original identity missing", 2, "native_identity_missing"));
    const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: web }], globalConfiguration: web, webStore, monitoring: monitor, verifyWebServer: vi.fn(async () => {}), verifyWebUnregistered: vi.fn(async () => {}), webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn() } });
    try {
      await coordinator.tick(); await eventually(() => expect(advance).toHaveBeenCalledOnce());
      await eventually(() => expect(monitor.capture("1").activities).toContainEqual(expect.objectContaining({ kind: "execution", phase: "paused", status: "paused", waitReason: "recovery-blocked" })));
      await coordinator.tick();
      expect(advance).toHaveBeenCalledOnce();
      expect(monitor.capture("2").activities).toContainEqual(expect.objectContaining({ kind: "execution", phase: "paused", status: "paused", waitReason: "recovery-blocked" }));
    } finally { await coordinator.shutdown(); webStore.close(); }
  });

  it("does not report failed prompt submission as recovered when only agent observation succeeds", async () => {
    const f = await fixture(), monitor = createMonitoringObserver();
    const coordinator = createWorkerCoordinator({ ...f.options, monitoring: monitor });
    try {
      await coordinator.tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
      const row = f.store.listTasks()[0]!, pane = f.resources.get(row.claimId)!.panes[0]!;
      pane.status = "idle";
      const failure = new HerdrAgentActionError("input failed", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" });
      const submit = f.tasks.submitPrompt.getMockImplementation()!;
      f.tasks.submitPrompt.mockRejectedValue(failure);
      await coordinator.tick(); await eventually(() => expect(f.events).toContainEqual(expect.objectContaining({ kind: "execution-error", error: failure })));
      const failed = monitor.capture("1").currentFailures.find(item => item.component === "execution")!;
      expect(failed.phase).toBe("input-submission");
      pane.status = "working";
      const current = f.grants.get(row.claimId)!;
      f.grants.set(row.claimId, { ...current, properties: { ...current.properties, worker: { ...readWorkerClaim(current.properties)!, phase: "waiting" } } });
      const updates = vi.mocked(f.remote.update).mock.calls.length;
      await coordinator.tick(); await eventually(() => expect(vi.mocked(f.remote.update).mock.calls.length).toBeGreaterThan(updates));
      expect(monitor.capture("2").currentFailures).toContainEqual(expect.objectContaining({ operationId: failed.operationId }));
      expect(monitor.capture("2").lastRecovery).toBeNull();
      pane.status = "idle";
      f.tasks.submitPrompt.mockImplementation(submit);
      await coordinator.tick();
      await eventually(() => expect(monitor.capture("3").lastRecovery).toMatchObject({ operationId: failed.operationId, component: "execution" }));
      expect(monitor.capture("3").currentFailures).not.toContainEqual(expect.objectContaining({ operationId: failed.operationId }));
    } finally { await coordinator.shutdown(); }
  });

  it("retains independent execution failures until their own boundaries succeed", async () => {
    const f = await fixture(), monitor = createMonitoringObserver();
    const coordinator = createWorkerCoordinator({ ...f.options, monitoring: monitor });
    try {
      await coordinator.tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
      const row = f.store.listTasks()[0]!, pane = f.resources.get(row.claimId)!.panes[0]!;
      pane.status = "idle";
      const submit = f.tasks.submitPrompt.getMockImplementation()!;
      f.tasks.submitPrompt.mockRejectedValueOnce(new HerdrAgentActionError("input failed", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" }));
      await coordinator.tick(); await eventually(() => expect(monitor.capture("1").currentFailures).toHaveLength(1));
      const inputFailure = monitor.capture("1").currentFailures[0]!;
      expect(inputFailure.phase).toBe("input-submission");
      f.tasks.observe.mockRejectedValueOnce(new Error("observation failed"));
      await coordinator.tick(); await eventually(() => expect(monitor.capture("2").currentFailures).toHaveLength(2));
      const failures = monitor.capture("2").currentFailures;
      const observationFailure = failures.find(item => item.phase === "agent-observation")!;
      expect(observationFailure.operationId).not.toBe(inputFailure.operationId);
      expect(failures).toContainEqual(expect.objectContaining({ operationId: inputFailure.operationId, phase: "input-submission", occurrencesInRun: 1 }));
      pane.status = "working";
      await coordinator.tick(); await eventually(() => expect(monitor.capture("3").currentFailures).toHaveLength(1));
      expect(monitor.capture("3").currentFailures[0]).toMatchObject({ operationId: inputFailure.operationId, phase: "input-submission" });
      expect(monitor.capture("3").lastRecovery).toMatchObject({ operationId: observationFailure.operationId });
      pane.status = "idle"; f.tasks.submitPrompt.mockImplementation(submit);
      await coordinator.tick(); await eventually(() => expect(monitor.capture("4").currentFailures).toHaveLength(0));
      expect(monitor.capture("4").lastRecovery).toMatchObject({ operationId: inputFailure.operationId });
    } finally { await coordinator.shutdown(); }
  });

  it.each(["claim", "project"] as const)("discards all unresolved execution failures on %s loss", async loss => {
    const f = await fixture(), monitor = createMonitoringObserver();
    const coordinator = createWorkerCoordinator({ ...f.options, monitoring: monitor });
    try {
      await coordinator.tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
      const row = f.store.listTasks()[0]!, pane = f.resources.get(row.claimId)!.panes[0]!; pane.status = "idle";
      f.tasks.submitPrompt.mockRejectedValueOnce(new HerdrAgentActionError("input failed", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" }));
      await coordinator.tick(); await eventually(() => expect(monitor.capture("1").currentFailures).toHaveLength(1));
      f.tasks.observe.mockRejectedValueOnce(new Error("observation failed"));
      await coordinator.tick(); await eventually(() => expect(monitor.capture("2").currentFailures).toHaveLength(2));
      if (loss === "project") coordinator.invalidateProject(f.project.projectId);
      else { f.grants.clear(); f.candidates.splice(0); await coordinator.tick(); }
      expect(monitor.capture("3").currentFailures.filter(item => item.component === "execution")).toHaveLength(0);
    } finally { await coordinator.shutdown(); }
  });

  it("keeps independent cleanup failures until each stage is confirmed", async () => {
    const f = await fixture(), monitor = createMonitoringObserver();
    const coordinator = createWorkerCoordinator({ ...f.options, monitoring: monitor });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let releaseStop!: () => void; const stopGate = new Promise<void>(resolve => { releaseStop = resolve; });
    try {
      await coordinator.tick(); await eventually(() => expect(f.remote.update).toHaveBeenCalledOnce());
      const owner = [...f.worktrees.values()][0]!.owner, resource = structuredClone(f.resources.get(owner.claimId)!);
      resource.panes[0]!.status = "idle"; f.resources.set(owner.claimId, resource);
      f.grants.clear(); f.candidates.splice(0);
      vi.mocked(f.git.removeWorktree).mockRejectedValueOnce(new Error("worktree deletion failed"));
      await coordinator.tick(); await eventually(() => expect(monitor.capture("1").currentFailures).toHaveLength(1));
      const removal = monitor.capture("1").currentFailures[0]!; expect(removal.phase).toBe("worktree-removal");
      f.resources.set(owner.claimId, structuredClone(resource));
      f.tasks.stopAndClose.mockRejectedValueOnce(new Error("stop failed"));
      f.clock(2000); await coordinator.tick(); await eventually(() => expect(monitor.capture("2").currentFailures).toHaveLength(2));
      const stop = monitor.capture("2").currentFailures.find(item => item.phase === "agent-stop")!;
      expect(stop.operationId).not.toBe(removal.operationId);
      expect(monitor.capture("2").currentFailures).toContainEqual(expect.objectContaining({ operationId: removal.operationId, occurrencesInRun: 1 }));
      const stopOriginal = f.tasks.stopAndClose.getMockImplementation()!;
      f.tasks.stopAndClose.mockImplementationOnce(async (...args) => { await stopGate; return stopOriginal(...args); });
      vi.mocked(f.git.removeWorktree).mockImplementation(async (_project, current) => { await gate; f.worktrees.delete(current.claimId); return { kind: "absent", effectErrors: [] }; });
      f.clock(4000); await coordinator.tick();
      await eventually(() => expect(f.tasks.stopAndClose).toHaveBeenCalledTimes(3));
      expect(monitor.capture("3").currentFailures).toContainEqual(expect.objectContaining({ operationId: stop.operationId, retryState: "running" }));
      expect(monitor.capture("3").currentFailures).toContainEqual(expect.objectContaining({ operationId: removal.operationId, retryState: "scheduled" }));
      releaseStop();
      await eventually(() => expect(f.git.removeWorktree).toHaveBeenCalledTimes(2));
      expect(monitor.capture("3").currentFailures).toContainEqual(expect.objectContaining({ operationId: removal.operationId, retryState: "running" }));
      expect(monitor.capture("3").currentFailures).not.toContainEqual(expect.objectContaining({ operationId: stop.operationId }));
      expect(monitor.capture("3").lastRecovery).toMatchObject({ operationId: stop.operationId });
      release(); await eventually(() => expect(monitor.capture("4").currentFailures).toHaveLength(0));
      expect(monitor.capture("4").lastRecovery).toMatchObject({ operationId: removal.operationId });
    } finally { releaseStop(); release(); await coordinator.shutdown(); }
  });
});


describe("real Git resource isolation", () => {
  it.each(["matching", "conflicting", "wrong-cwd", "pending-only", "pending-only-wrong-cwd", "capacity-full"])("reconciles closed-workspace pending-stop evidence: %s", async proof => {
    const f = await fixture(proof === "capacity-full" ? 1 : 2);
    await mkdir(f.project.localPath);
    const run = (args: string[]) => execFileSync("git", args, { cwd: f.project.localPath, encoding: "utf8", timeout: 10000, stdio: "pipe" });
    run(["init", "--initial-branch=main"]); run(["-c", "user.name=Fixture", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "seed"]);
    run(["remote", "add", "origin", f.project.repoUrl]);
    const owner = { projectId: f.project.projectId, taskId: uuid(900), claimId: uuid(901), worktreeId: uuid(902) };
    for (const id of [owner.taskId, ...f.candidates.map(item => item.id)]) run(["branch", `daynight/${id}`]);
    const git = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "git-temp"), prepareFormat }), op = createOperation();
    try {
      await git.prepareRepository(f.project, op);
      const binding = await git.prepareWorktree(f.project, owner, op);
      execFileSync("git", ["checkout", "-b", "changed-branch"], { cwd: binding.worktreePath, timeout: 10000, stdio: "pipe" });
      const stop = { context: { ...owner, worktreeId: proof === "conflicting" ? uuid(903) : owner.worktreeId,
        cwd: proof.endsWith("wrong-cwd") ? f.project.localPath : binding.worktreePath },
        binding: { session: "w", workspaceId: "closed", paneId: "p", terminalId: "t" } };
      let stops: typeof stop[] = [stop];
      f.tasks.pendingStops.mockImplementation(() => [...stops]);
      if (proof.startsWith("pending-only")) {
        // A stop becomes pending between the reconciliation observation and
        // the capacity snapshot. No claim, workspace or cleanup row proves it.
        stops = [];
        f.tasks.listResources.mockImplementationOnce(async () => []);
        f.tasks.listResources.mockImplementation(async () => { stops = [stop]; return structuredClone([...f.resources.values()]); });
      } else {
        f.store.registerPending({ ...owner, agent: "codex" });
        f.grant(task(owner.projectId, owner.taskId), { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, agent: "codex", machine: f.options.machine, platform: "linux" });
      }
      const monitor = createMonitoringObserver({ runId: uuid(999), now: () => 1000 });
      let admission: ReturnType<typeof monitor.capture> | undefined;
      const claim = vi.mocked(f.remote.claim).getMockImplementation()!;
      vi.mocked(f.remote.claim).mockImplementation(async (...args) => { admission = monitor.capture("admission"); return claim(...args); });
      const coordinator = createWorkerCoordinator({ ...f.options, git, monitoring: monitor });
      try {
        expect(f.resources.size).toBe(0);
        await coordinator.tick();
        if (proof === "conflicting" || proof.endsWith("wrong-cwd")) {
          expect(f.remote.claim).not.toHaveBeenCalled();
          expect(f.tasks.start).not.toHaveBeenCalled();
          expect(monitor.capture("1").capacity?.quality).not.toBe("current");
          expect(monitor.capture("1").currentFailures).toEqual(expect.arrayContaining([expect.objectContaining({ component: "resources", scope: { kind: "project", projectId: owner.projectId } })]));
        } else {
          if (proof === "capacity-full") expect(f.remote.claim).not.toHaveBeenCalled();
          else {
            expect(f.remote.claim).toHaveBeenCalledOnce();
            await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
            expect(f.tasks.start.mock.calls[0]![0].taskId).not.toBe(owner.taskId);
          }
          const observation = admission ?? monitor.capture("1");
          expect(observation.capacity).toMatchObject({ quality: "current", occupied: 1, available: proof === "capacity-full" ? 0 : 1 });
          expect(observation.reservations.filter(item => item.scope.kind === "claim" && item.scope.claimId === owner.claimId)).toEqual([
            expect.objectContaining({ roles: expect.arrayContaining(["pending-stop", "resource-owner", "unresolved"]) }),
          ]);
        }
        expect(f.store.listCleanupSchedules()).toEqual([]);
        if (proof.startsWith("pending-only")) expect(f.store.getTask(owner)).toBeNull();
        else expect(f.store.getTask(owner)?.status).toBe("pending");
        expect(f.tasks.stopAndClose).not.toHaveBeenCalled();
        await access(binding.worktreePath);
        expect(f.tasks.pendingStops()).toEqual([stop]);
      } finally { await coordinator.shutdown(); }
    } finally { op.dispose(); await git.dispose(); }
  }, 20000);

  it.each(["current", "claim-unconfirmed", "missing-worktree-id", "conflict", "capacity-full", "stopped", "unselected", "manual-alias", "manual-case", "manual-hardlink", "manual-raw", "manual-missing-case", "pointer-forward", "pointer-common", "pointer-reverse"])("admits only with independently bounded ownership: %s", async proof => {
    const f = await fixture(["capacity-full", "stopped", "unselected"].includes(proof) ? 1 : 2);
    const run = (args: string[]) => execFileSync("git", args, { cwd: f.project.localPath, encoding: "utf8", timeout: 10000, stdio: "pipe" });
    await mkdir(f.project.localPath);
    run(["init", "--initial-branch=main"]); run(["-c", "user.name=Fixture", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "seed"]);
    run(["remote", "add", "origin", f.project.repoUrl]);
    const owner = { projectId: f.project.projectId, taskId: uuid(900), claimId: uuid(901), worktreeId: uuid(902) };
    for (const id of [owner.taskId, ...f.candidates.map(item => item.id)]) run(["branch", `daynight/${id}`]);
    const git = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "git-temp"), prepareFormat });
    const op = createOperation();
    try {
      await git.prepareRepository(f.project, op);
      const binding = await git.prepareWorktree(f.project, owner, op);
      execFileSync("git", ["checkout", "-b", "changed-branch"], { cwd: binding.worktreePath, timeout: 10000, stdio: "pipe" });
      let separateManualTarget = false;
      if (proof.startsWith("manual-")) {
        const manual = path.join(f.root, "manual"), alias = path.join(f.root, "alias");
        run(["worktree", "add", "--detach", manual, "HEAD"]);
        const admin = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: manual, encoding: "utf8", timeout: 10000 }).trim();
        let target = path.join(alias, ".worktrees", "daynight", owner.worktreeId, ".git");
        if (proof === "manual-alias") await symlink(f.project.localPath, alias, process.platform === "win32" ? "junction" : "dir");
        else if (proof === "manual-raw") {
          const extra = path.join(path.dirname(binding.worktreePath), "extra");
          await mkdir(extra); await symlink(extra, alias, process.platform === "win32" ? "junction" : "dir");
          target = `${alias}/../${owner.worktreeId}/.git`;
        } else if (proof === "manual-missing-case") {
          await rm(binding.worktreePath, { recursive: true });
          target = path.join(binding.worktreePath, ".GIT");
        } else {
          const original = path.join(binding.worktreePath, ".git");
          target = proof === "manual-case" ? path.join(binding.worktreePath, ".GIT") : path.join(f.root, "linked.git");
          if (proof === "manual-hardlink") await link(original, target);
          const entry = await lstat(target, { bigint: true }).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
          separateManualTarget = entry === null;
          if (entry !== null) {
            const originalEntry = await lstat(original, { bigint: true });
            expect([entry.dev, entry.ino]).toEqual([originalEntry.dev, originalEntry.ino]);
          }
        }
        await writeFile(path.join(admin, "gitdir"), `${target}\n`);
      }
      if (proof.startsWith("pointer-")) {
        const foreign = path.join(f.root, "foreign"), alias = path.join(f.project.localPath, "alias");
        const admin = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: binding.worktreePath, encoding: "utf8", timeout: 10000 }).trim();
        run(["clone", "--no-hardlinks", f.project.localPath, foreign]);
        execFileSync("git", ["worktree", "add", "--detach", path.join(foreign, ".worktrees", "daynight", owner.taskId), "HEAD"], { cwd: foreign, timeout: 10000, stdio: "pipe" });
        const extra = path.join(foreign, "extra");
        await mkdir(extra); await symlink(extra, alias, process.platform === "win32" ? "junction" : "dir");
        const suffix = proof === "pointer-common" ? ".git" : proof === "pointer-forward" ? `.worktrees/daynight/${owner.taskId}/.git` : `.git/worktrees/${path.basename(admin)}`;
        const metadata = proof === "pointer-common" ? path.join(admin, "commondir") : proof === "pointer-forward" ? path.join(admin, "gitdir") : path.join(binding.worktreePath, ".git");
        if (proof === "pointer-reverse") await rm(metadata);
        await writeFile(metadata, `${proof === "pointer-reverse" ? "gitdir: " : ""}${alias}/../${suffix}\n`);
      }
      f.store.registerPending({ ...owner, agent: "codex" });
      if (["current", "claim-unconfirmed", "conflict", "capacity-full"].includes(proof) || proof.startsWith("manual-") || proof.startsWith("pointer-")) f.grant(task(owner.projectId, owner.taskId), { claimId: owner.claimId, worktreeId: proof === "conflict" ? uuid(903) : owner.worktreeId, workerId, agent: "codex", machine: f.options.machine, platform: "linux" });
      if (proof === "stopped" || proof === "unselected") {
        f.store.completeTask(owner);
        Object.assign(f.herdr, { lifecycle: { responsibilities: () => [owner], isStopped: () => true, registerClaim: () => {}, assertCanAdvance: () => {}, stop: async () => {} } });
      }
      if (proof === "claim-unconfirmed") vi.spyOn(f.remote, "claim").mockRejectedValue(new Error("Grant not confirmed"));
      const monitor = createMonitoringObserver({ runId: uuid(999), now: () => 1000 });
      const coordinator = createWorkerCoordinator({ ...f.options, git, monitoring: monitor, ...(proof === "unselected" ? { readyProjectIds: [] } : {}) });
      try {
        await coordinator.tick();
        if (proof === "current" || separateManualTarget) {
          expect(f.remote.claim).toHaveBeenCalledOnce();
          expect(f.store.getTask(owner)?.status).toBe("pending");
          await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
          expect(f.tasks.start.mock.calls[0]![0].taskId).not.toBe(owner.taskId);
          expect(monitor.capture("1").currentFailures).toEqual(expect.arrayContaining([expect.objectContaining({ component: "resources", scope: { kind: "claim", projectId: owner.projectId, taskId: owner.taskId, claimId: owner.claimId } })]));
        } else if (proof === "claim-unconfirmed") {
          expect(f.remote.claim).toHaveBeenCalledOnce();
          expect(monitor.capture("1").admission.reasons).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "retained-resource-conflict", scope: expect.objectContaining({ kind: "claim", claimId: owner.claimId }) }),
            expect.objectContaining({ code: "claim-unconfirmed" }),
          ]));
        } else expect(f.remote.claim).not.toHaveBeenCalled();
        if (proof.startsWith("manual-") && !separateManualTarget || proof.startsWith("pointer-")) {
          expect(f.tasks.start).not.toHaveBeenCalled();
          expect(f.store.getTask(owner)?.status).toBe("pending");
          expect(monitor.capture("1").capacity?.quality).not.toBe("current");
          if (proof === "manual-missing-case") await expect(lstat(binding.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
          else await access(binding.worktreePath);
        }
        if (["capacity-full", "stopped", "unselected"].includes(proof)) expect(monitor.capture("1").capacity).toMatchObject({ quality: "current", occupied: 1, available: 0 });
        if (proof === "stopped" || proof === "unselected") {
          expect(f.store.getTask(owner)?.status).toBe("done");
          execFileSync("git", ["checkout", binding.branch], { cwd: binding.worktreePath, timeout: 10000, stdio: "pipe" });
          await coordinator.tick();
          expect(monitor.capture("2").capacity).toMatchObject({ occupied: 0 });
          expect(monitor.capture("2").currentFailures.filter(failure => failure.component === "resources")).toEqual([]);
        }
      } finally { await coordinator.shutdown(); }
    } finally { op.dispose(); await git.dispose(); }
  }, 20000);

  it("deduplicates durable owners, blocks a successor task, and retains failures until revalidation", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const { readFile } = await import("node:fs/promises");
    const f = await fixture(2);
    await mkdir(f.project.localPath);
    const run = (args: string[]) => execFileSync("git", args, { cwd: f.project.localPath, encoding: "utf8", timeout: 10000, stdio: "pipe" });
    run(["init", "--initial-branch=main"]); run(["-c", "user.name=Fixture", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "seed"]);
    run(["remote", "add", "origin", f.project.repoUrl]);
    const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(901), worktreeId: uuid(902) };
    run(["branch", `daynight/${owner.taskId}`]);
    const git = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "git-temp"), prepareFormat });
    const op = createOperation();
    let monitor = createMonitoringObserver({ runId: uuid(999), now: () => 1000 });
    let coordinator: ReturnType<typeof createWorkerCoordinator> | undefined;
    try {
      await git.prepareRepository(f.project, op);
      const binding = await git.prepareWorktree(f.project, owner, op);
      execFileSync("git", ["checkout", "-b", "changed-branch"], { cwd: binding.worktreePath, timeout: 10000, stdio: "pipe" });
      f.store.registerPending({ ...owner, agent: "codex" }); f.store.completeTask(owner);
      // Independent, durable sources describe one reservation, even after stop.
      f.store.saveCleanupSchedule(owner, { deadline: 100000, failures: 0, nextAttemptAt: 90000, stage: "worktree-removal", lastError: null });
      Object.assign(f.herdr, { lifecycle: { responsibilities: () => [owner], isStopped: () => true, registerClaim: () => {}, assertCanAdvance: () => {}, stop: async () => {} } });
      const webStore = openWebExecutionStore(createMemoryDatabase());
      webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration }, 1);
      const options = { ...f.options, git, webStore, monitoring: monitor };
      // Only the retained task is ready: a fresh claim must not bypass its slot.
      f.candidates.splice(1);
      try {
        coordinator = createWorkerCoordinator(options);
        await coordinator.tick();
        expect(f.remote.claim).not.toHaveBeenCalled(); expect(f.tasks.start).not.toHaveBeenCalled();
        expect(monitor.capture("1").capacity).toMatchObject({ quality: "current", occupied: 1, available: 1 });
        expect(monitor.capture("1").admission.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: "retained-resource-conflict", scope: expect.objectContaining({ kind: "claim", claimId: owner.claimId }) })]));
        await coordinator.shutdown();
        monitor = createMonitoringObserver({ runId: uuid(998), now: () => 1000 });
        coordinator = createWorkerCoordinator({ ...options, monitoring: monitor });
        await coordinator.tick();
        expect(monitor.capture("2").capacity).toMatchObject({ quality: "current", occupied: 1 });
        const manifest = path.join(f.project.localPath, ".git", "daynight", "worktrees", `${owner.worktreeId}.json`);
        const original = await readFile(manifest, "utf8");
        await writeFile(manifest, "{");
        await coordinator.tick();
        expect(monitor.capture("3").capacity?.quality).not.toBe("current");
        expect(monitor.capture("3").currentFailures.some(failure => failure.scope.kind === "claim" && failure.scope.claimId === owner.claimId)).toBe(true);
        expect(f.remote.claim).not.toHaveBeenCalled();
        await writeFile(manifest, original);
        execFileSync("git", ["checkout", binding.branch], { cwd: binding.worktreePath, timeout: 10000, stdio: "pipe" });
        await coordinator.tick();
        expect(monitor.capture("4").currentFailures.filter(failure => failure.component === "resources")).toEqual([]);
        expect(monitor.capture("4").capacity).toMatchObject({ quality: "current", occupied: 0 });
      } finally { await coordinator?.shutdown(); webStore.close(); }
    } finally { op.dispose(); await git.dispose(); }
  }, 20000);


  it.each(["mapping", "web-record", "herdr-record", "herdr-path-accessor"])("fences matching UUIDs whose %s points to another physical repository", async proof => {
    const { readFile, rename } = await import("node:fs/promises");
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(2), other = { ...f.project, projectId: uuid(11), localPath: path.join(f.root, "other") };
    const run = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10000, stdio: "pipe" }).trim();
    for (const project of [f.project, other]) {
      await mkdir(project.localPath); run(project.localPath, ["init", "--initial-branch=main"]);
      run(project.localPath, ["-c", "user.name=Fixture", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "seed"]);
      run(project.localPath, ["remote", "add", "origin", project.repoUrl]);
    }
    const owner = { projectId: other.projectId, taskId: uuid(900), claimId: uuid(901), worktreeId: uuid(902) };
    run(other.localPath, ["branch", `daynight/${owner.taskId}`]);
    const git = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "git-temp"), prepareFormat }), op = createOperation();
    const webStore = openWebExecutionStore(createMemoryDatabase());
    try {
      await git.prepareRepository(other, op);
      await git.prepareRepository(f.project, op);
      const binding = await git.prepareWorktree(other, owner, op);
      const admin = run(binding.worktreePath, ["rev-parse", "--absolute-git-dir"]);
      const movedAdmin = path.join(f.project.localPath, ".git", "worktrees", path.basename(admin));
      const movedLeaf = path.join(f.project.localPath, ".worktrees", "daynight", owner.worktreeId);
      await mkdir(path.dirname(movedAdmin), { recursive: true }); await mkdir(path.dirname(movedLeaf), { recursive: true });
      await rename(admin, movedAdmin); await rename(binding.worktreePath, movedLeaf);
      await writeFile(path.join(movedAdmin, "gitdir"), `${movedLeaf}/.git\n`);
      // Git creates hidden .git files on Windows; opening an existing one with
      // 'w' fails. Recreate only this fixture pointer, preserving the leaf directory.
      const movedPointer = path.join(movedLeaf, ".git");
      await rm(movedPointer);
      await writeFile(movedPointer, `gitdir: ${movedAdmin}\n`);
      // A structurally valid registration and manifest do not override the
      // original backend/project's independent repository binding.
      createWorktreeManifestStore(path.join(f.project.localPath, ".git")).publish({ schemaVersion: 1, ...owner, directoryName: owner.worktreeId });
      f.store.registerProject(proof === "mapping" ? other : { ...other, localPath: f.project.localPath });
      f.store.registerPending({ ...owner, agent: "codex" });
      f.grant(task(owner.projectId, owner.taskId), { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, agent: "codex", machine: f.options.machine, platform: "linux" });
      if (proof === "web-record") webStore.register({ ...owner, project: other, serverOrigin: origin, workerId, userId: uuid(2), configuration }, 1);
      if (proof.startsWith("herdr-")) Object.assign(f.herdr, { lifecycle: {
        responsibilities: () => [owner],
        ...(proof === "herdr-path-accessor" ? { worktreePath: () => binding.worktreePath } : { archive: { resources: () => [{
          owner, worktreePath: binding.worktreePath, sessionId: uuid(950), stopped: true, stopEvidence: [], terminal: true,
          sourcePath: path.join(f.root, "archive"), sourceBytes: "0", state: "pending", error: null,
          nextAttemptAt: 90000, worktreeDeleted: false, disposition: null,
        }] } }),
        isStopped: () => true, registerClaim: () => {}, assertCanAdvance: () => {}, stop: async () => {},
      } });
      const monitor = createMonitoringObserver({ runId: uuid(999), now: () => 1000 });
      const coordinator = createWorkerCoordinator({ ...f.options, git, webStore, monitoring: monitor });
      try {
        expect((await git.scanWorktrees(f.project, op, false, true)).validated.map(item => item.owner)).toEqual([owner]);
        await coordinator.tick();
        expect(f.remote.claim).not.toHaveBeenCalled();
        expect(f.tasks.start).not.toHaveBeenCalled();
        expect(monitor.capture("1").capacity?.quality).not.toBe("current");
        expect(await readFile(path.join(movedLeaf, ".git"), "utf8")).toContain(movedAdmin);
      } finally { await coordinator.shutdown(); }
    } finally { webStore.close(); op.dispose(); await git.dispose(); }
  }, 20000);

});

it.each(["blocked", "probe-error", "storage-failure", "cancelled", "receipt-mismatch", "removal-error", "repaired"] as const)("retains archive repair responsibility across coordinator restart: %s", async outcome => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
  const f = await fixture(1), webStore = openWebExecutionStore(createMemoryDatabase());
  const config = { ...configuration, args: [], agentControlMode: "web" as const };
  const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(910), worktreeId: uuid(911) };
  f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }); f.store.activateTask(owner);
  let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
  record = webStore.bindWorktree(record, await f.git.prepareWorktree(f.project, owner, {} as Operation), 2);
  record = webStore.initializeWebExecution(record, 3);
  record = webStore.updateWebExecution(record, { sessionId: uuid(912), initialPrompt: "managed", launchSubmission: "acknowledged" }, 4);
  const stopped = await stoppedWebExecution(f, webStore, record);
  webStore.beginCleanup(stopped.task, { kind: "terminal", deadline: 100 }, 7);
  f.candidates.splice(0);
  const archive = vi.fn<() => Promise<void>>(async () => { throw new ArchiveRepairRequiredError("archive_incomplete"); });
  const probeArchive = vi.fn(async (_task: WebTask, _path: string, signal: AbortSignal): Promise<ArchiveProbeResult> => {
    if (outcome === "cancelled") return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    if (outcome === "probe-error") throw new Error("probe unavailable");
    return outcome === "blocked" || outcome === "storage-failure" ? { kind: "blocked", code: "archive_incomplete" } : { kind: "attempt" };
  });
  const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: f.options.now, archive, probeArchive, jobLeases: stopped.jobLeases, request: stopped.request });
  const cleanup = vi.spyOn(backend, "cleanup");
  let monitor = createMonitoringObserver({ now: f.options.now });
  const create = () => createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: config }], globalConfiguration: config, webStore, webBackend: backend, monitoring: monitor, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
  let coordinator = create();
  try {
    await coordinator.tick();
    await eventually(() => expect(f.store.getCleanupSchedule(owner)).toMatchObject({ stage: "archive", failures: 1, archiveRepairCode: "archive_incomplete", nextAttemptAt: 901000 }));
    expect(archive).toHaveBeenCalledOnce();
    await coordinator.shutdown(); cleanup.mockClear();
    monitor = createMonitoringObserver({ now: f.options.now }); coordinator = create();
    f.clock(900999);
    await coordinator.tick(); await coordinator.tick();
    expect(probeArchive).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled();
    expect(monitor.capture("1").currentFailures).toEqual(expect.arrayContaining([expect.objectContaining({ phase: "archive", error: expect.objectContaining({ code: "recovery-blocked" }), retryState: "scheduled" })]));
    if (outcome === "repaired" || outcome === "removal-error") archive.mockImplementation(async () => {});
    if (outcome === "removal-error") vi.mocked(f.git.removeWorktree).mockRejectedValue(new Error("Removal denied."));
    if (outcome === "receipt-mismatch") archive.mockImplementation(async () => { throw new Error("Server archive differs from the confirmed receipt."); });
    if (outcome === "storage-failure") vi.spyOn(f.store, "saveCleanupSchedule").mockImplementationOnce(() => { throw new Error("schedule unavailable"); });
    f.clock(901000); await coordinator.tick();
    await eventually(() => expect(probeArchive).toHaveBeenCalledOnce());
    if (outcome === "cancelled") {
      await coordinator.shutdown();
      expect(f.store.getCleanupSchedule(owner)).toMatchObject({ archiveRepairCode: "archive_incomplete", failures: 1, nextAttemptAt: 901000 });
      expect(f.events.filter(event => event.kind === "cleanup-error")).toHaveLength(1);
      expect(archive).toHaveBeenCalledOnce(); expect(f.worktrees.has(owner.claimId)).toBe(true);
    } else if (outcome === "repaired") {
      await eventually(() => expect(f.store.getCleanupSchedule(owner)).toBeNull());
      expect(f.store.getTask(owner)?.status).toBe("done"); expect(f.worktrees.has(owner.claimId)).toBe(false);
    } else {
      await eventually(() => expect(f.events.filter(event => event.kind === "cleanup-error")).toHaveLength(2));
      if (outcome === "storage-failure") {
        expect(f.store.getCleanupSchedule(owner)).toMatchObject({ failures: 1, nextAttemptAt: 901000 });
        expect(f.events.filter(event => event.kind === "cleanup-error").at(-1)?.error).toBeInstanceOf(AggregateError);
        f.clock(1800999); await coordinator.tick(); expect(probeArchive).toHaveBeenCalledOnce();
      } else if (outcome === "removal-error") {
        expect(f.store.getCleanupSchedule(owner)).toMatchObject({ stage: "worktree-removal", failures: 2, nextAttemptAt: 903000 });
        expect(f.store.getCleanupSchedule(owner)?.archiveRepairCode).toBeUndefined();
      } else expect(f.store.getCleanupSchedule(owner)).toMatchObject({ archiveRepairCode: "archive_incomplete", failures: outcome === "receipt-mismatch" ? 2 : 1, nextAttemptAt: 1801000 });
      expect(f.store.getTask(owner)?.status).toBe("active"); expect(f.worktrees.has(owner.claimId)).toBe(true);
      expect(f.remote.claim).not.toHaveBeenCalled();
      expect(monitor.capture("2").capacity).toMatchObject({ occupied: 0, available: 1 });
      if (outcome !== "removal-error") expect(monitor.capture("3").lastRecovery?.component).not.toBe("cleanup");
      else expect(monitor.capture("3").currentFailures).toEqual(expect.arrayContaining([expect.objectContaining({ phase: "worktree-removal" })]));
      if (outcome !== "receipt-mismatch" && outcome !== "removal-error") { expect(cleanup).not.toHaveBeenCalled(); expect(archive).toHaveBeenCalledOnce(); }
    }
  } finally { await coordinator.shutdown(); webStore.close(); }
});


it.each(["current", "legacy", "mismatch"] as const)("reconciles an original receipt while a persisted archive blocker remains: %s", async variant => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
  const { probeStoppedControllerArchive, uploadStoppedControllerArchive } = await import("../../../src/commands/controller/archive-upload.js");
  const { controllerExecutionDirectory } = await import("../../../src/commands/controller/launch-ticket.js");
  const { default: Database } = await import("better-sqlite3");
  const f = await fixture(1), webStore = openWebExecutionStore(createMemoryDatabase());
  const config = { ...configuration, args: [], agentControlMode: "web" as const };
  const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(920), worktreeId: uuid(921) };
  f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }); f.store.activateTask(owner);
  let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
  record = webStore.bindWorktree(record, await f.git.prepareWorktree(f.project, owner, {} as Operation), 2);
  record = webStore.initializeWebExecution(record, 3);
  record = webStore.updateWebExecution(record, { sessionId: uuid(922), initialPrompt: "managed", launchSubmission: "acknowledged" }, 4);
  const stopped = await stoppedWebExecution(f, webStore, record);
  webStore.beginCleanup(stopped.task, { kind: "terminal", deadline: 100 }, 7); f.candidates.splice(0);
  const journalPath = path.join(controllerExecutionDirectory(f.root, stopped.ticket.executionId), "journal.sqlite");
  await mkdir(path.dirname(journalPath), { recursive: true });
  const journal = lifecycle.openControllerLifecycleStore(journalPath, stopped.ticket);
  journal.markProjectionGap("Native history could not be preserved."); journal.drainProjectionGap();
  const { executionId: _executionId, claimId: _claimId, sessionId: _sessionId, executionGeneration: _generation, controllerInstanceId: _instance, ...snapshot } = stopped.snapshot;
  journal.patchSnapshot(snapshot); journal.close();
  const receipt = { state: "ready", sha256: "1".repeat(64), byteLength: "72", errorCode: null, ...(variant === "legacy" ? {} : { schemaVersion: 3, completeness: "complete" }) };
  const remote = variant === "legacy" ? { ...receipt, schemaVersion: 3, completeness: "complete", sha256: "2".repeat(64), byteLength: "96", migration: { migrationId: uuid(923), sourceSha256: receipt.sha256, sourceByteLength: receipt.byteLength } } : { ...receipt, sha256: variant === "mismatch" ? "3".repeat(64) : receipt.sha256 };
  await writeFile(`${journalPath}.archive-receipt-1.json`, JSON.stringify(receipt));
  await rm(`${journalPath}.pending-content`, { recursive: true });
  f.store.saveCleanupSchedule(owner, { deadline: 100, failures: 4, nextAttemptAt: 1000, stage: "archive", lastError: "retained", archiveRepairCode: "archive_incomplete" });
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ archive: remote }));
  const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: f.options.now,
    probeArchive: (_task, actual, signal) => probeStoppedControllerArchive({ journalPath: actual, ticket: stopped.ticket, signal }),
    archive: async (_task, actual, signal) => { await uploadStoppedControllerArchive({ journalPath: actual, ticket: stopped.ticket, signal, serverToken: "fixture", request }); }, jobLeases: stopped.jobLeases, request: stopped.request });
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: config }], globalConfiguration: config, webStore, webBackend: backend, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
  try {
    await coordinator.tick();
    if (variant === "mismatch") {
      await eventually(() => expect(f.store.getCleanupSchedule(owner)?.failures).toBe(5));
      expect(f.store.getCleanupSchedule(owner)).toMatchObject({ archiveRepairCode: "archive_incomplete", nextAttemptAt: 901000 });
      expect(f.worktrees.has(owner.claimId)).toBe(true); expect(f.store.getTask(owner)?.status).toBe("active");
      expect(f.remote.claim).not.toHaveBeenCalled();
    } else await eventually(() => expect(f.store.getCleanupSchedule(owner)).toBeNull());
    expect(request.mock.calls.map(([,init]) => init?.method)).toEqual(["GET"]);
    const inspect = new Database(journalPath, { readonly: true });
    try { expect(inspect.prepare("SELECT archive_incomplete FROM execution").get()).toEqual({ archive_incomplete: 1 }); } finally { inspect.close(); }
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it.each((["archive_incomplete", "projection_gap"] as const).flatMap(code =>
  (["complete", "receipt", "blocked", "unconfirmed", "regressed", "clear-failed"] as const).map(outcome => ({ code, outcome })),
))("updates cleanup scheduling only after confirmed completeness: $code/$outcome", async ({ code, outcome }) => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
  const f = await fixture(1), webStore = openWebExecutionStore(createMemoryDatabase());
  const config = { ...configuration, args: [], agentControlMode: "web" as const };
  const owner = { projectId: f.project.projectId, taskId: f.candidates[0]!.id, claimId: uuid(910), worktreeId: uuid(911) };
  f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }); f.store.activateTask(owner);
  let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
  record = webStore.bindWorktree(record, await f.git.prepareWorktree(f.project, owner, {} as Operation), 2);
  record = webStore.initializeWebExecution(record, 3);
  record = webStore.updateWebExecution(record, { sessionId: uuid(912), initialPrompt: "managed", launchSubmission: "acknowledged" }, 4);
  const stopped = await stoppedWebExecution(f, webStore, record);
  webStore.beginCleanup(stopped.task, { kind: "terminal", deadline: 100 }, 7);
  f.candidates.splice(0);
  const archive = vi.fn<() => Promise<void>>(async () => { throw new ArchiveRepairRequiredError(code); });
  const probeArchive = vi.fn(async (): Promise<ArchiveProbeResult> => {
    if (outcome === "unconfirmed") throw new Error("metadata unavailable");
    if (outcome === "blocked") return { kind: "blocked", code };
    return { kind: outcome === "receipt" ? "attempt" : "complete" };
  });
  const backend = createWebExecutionBackend({ homeDirectory: f.root, store: webStore, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux", buildPrompt: () => "managed", emit: () => {}, now: f.options.now, archive, probeArchive, jobLeases: stopped.jobLeases, request: stopped.request });
  const monitor = createMonitoringObserver({ now: f.options.now });
  const create = () => createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: config }], globalConfiguration: config, webStore, webBackend: backend, monitoring: monitor, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
  let coordinator = create();
  try {
    await coordinator.tick();
    await eventually(() => expect(f.store.getCleanupSchedule(owner)).toMatchObject({ failures: 1, archiveRepairCode: code, nextAttemptAt: 901000 }));
    await coordinator.shutdown(); coordinator = create();
    const admissions: ReturnType<typeof f.store.getCleanupSchedule>[] = [];
    archive.mockImplementation(async () => {
      admissions.push(f.store.getCleanupSchedule(owner));
      if (outcome === "regressed") throw new ArchiveRepairRequiredError(code);
      throw new Error("Session archive request failed (503).");
    });
    if (outcome === "clear-failed") vi.spyOn(f.store, "saveCleanupSchedule").mockImplementationOnce(() => { throw new Error("schedule unavailable"); });
    f.clock(901000); await coordinator.tick();
    await eventually(() => expect(f.events.filter(event => event.kind === "cleanup-error")).toHaveLength(2));
    const schedule = f.store.getCleanupSchedule(owner);
    expect(schedule).not.toBeNull();
    expect(f.store.getTask(owner)?.status).toBe("active");
    expect(f.worktrees.has(owner.claimId)).toBe(true);
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
    expect(f.remote.claim).not.toHaveBeenCalled();
    expect(monitor.capture("1").capacity).toMatchObject({ occupied: 0, available: 1 });
    if (outcome === "complete") {
      expect(schedule).toMatchObject({ stage: "archive", failures: 2, nextAttemptAt: 903000 });
      expect(schedule?.archiveRepairCode).toBeUndefined();
      expect(admissions).toHaveLength(1);
      expect(admissions[0]).toMatchObject({ worktreeId: owner.worktreeId, failures: 1 });
      expect(admissions[0]?.archiveRepairCode).toBeUndefined();
      f.clock(902999); await coordinator.tick(); expect(archive).toHaveBeenCalledTimes(2);
      f.clock(903000); await coordinator.tick();
      await eventually(() => expect(f.store.getCleanupSchedule(owner)).toMatchObject({ failures: 3, nextAttemptAt: 907000 }));
      expect(probeArchive).toHaveBeenCalledOnce();
      await coordinator.shutdown(); coordinator = create();
      archive.mockResolvedValue(undefined);
      f.clock(907000); await coordinator.tick();
      await eventually(() => expect(f.store.getCleanupSchedule(owner)).toBeNull());
      expect(f.store.getTask(owner)?.status).toBe("done");
      expect(f.worktrees.has(owner.claimId)).toBe(false);
      expect(probeArchive).toHaveBeenCalledOnce();
    } else {
      expect(schedule).toMatchObject({ archiveRepairCode: code, nextAttemptAt: 1801000 });
      expect(archive).toHaveBeenCalledTimes(outcome === "receipt" || outcome === "regressed" ? 2 : 1);
      f.clock(903000); await coordinator.tick(); expect(probeArchive).toHaveBeenCalledOnce();
    }
  } finally { await coordinator.shutdown(); webStore.close(); }
});
