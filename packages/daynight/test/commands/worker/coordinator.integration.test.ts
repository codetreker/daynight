import { mkdirSync } from "node:fs";
import type { CleanupTarget, StopObservation } from "../../../src/commands/worker/execution-stop.js";
import { scanFromList } from "../../helpers/worker-git-scan.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import Database from "better-sqlite3";
import { reconcileDeletedHerdrResource } from "../../../src/commands/worker/resource-disposal.js";
import * as lifecycle from "../../../src/commands/controller/lifecycle-store.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import * as launchObservation from "../../../src/commands/controller/launch-observation.js";
import { writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { LocalTask as WebTask } from "../../../src/commands/worker/backends/web-types.js";
import type { WebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { ControllerIpcOutcomeUnknownError, type requestController } from "../../../src/commands/controller/local-client.js";
import { readWorkerClaim } from "../../../src/api/task-properties.js";
import { access, mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { execFileSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TimerOptions } from "node:timers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationError } from "../../../src/api/operation.js";
import { isWorkerCancellation } from "../../../src/commands/worker/execution.js";
import { createCleanupDriver } from "../../../src/commands/worker/cleanup.js";
import { HerdrAgentActionError, HerdrRpcError } from "../../../src/commands/worker/herdr.js";
import { HerdrInputBlockedError } from "../../../src/commands/worker/herdr/agents.js";
import { LegacyBindingUnavailableError } from "../../../src/commands/worker/herdr/agents.js";
import { createWorkerCoordinator as createCoordinator } from "../../../src/commands/worker/coordinator.js";
import { createMonitoringObserver } from "../../../src/commands/worker/monitoring/observer.js";
import { createWorkerGitManager, WorktreePreconditionError } from "../../../src/commands/worker/worktrees.js";
import { migrateLegacyWorktrees } from "../../../src/commands/worker/worktrees/migration.js";
import { createWorktreeManifestStore } from "../../../src/commands/worker/worktrees/manifest.js";
import { startOwnedRepositoryGit } from "../../../src/repository/git-owned.js";
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

// Replace only the selected Git command with a real process that executes Git
// and leaves its inherited output open. All other subprocesses remain native.
const gitProcess = vi.hoisted(() => ({ wrapper: undefined as string | undefined, helper: undefined as string | undefined, child: undefined as ChildProcess | undefined, stopHelper: undefined as ChildProcess | undefined, childClosed: false, stdoutClosed: false, stderrClosed: false, helperClosed: false, helperStdoutClosed: false, diagnostics: [] as Record<string, unknown>[], stdoutBytes: 0, stderrBytes: 0 }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = ((...args: Parameters<typeof actual.spawn>) => {
    if (args[0] === "git" && gitProcess.wrapper !== undefined && Array.isArray(args[1]) && args[1].includes("worktree") && args[1].includes("remove")) {
      gitProcess.diagnostics.push({ stage: "wrapper-spawn-attempt", executable: "node", arguments: "redacted", argumentCount: args[1].length });
      let child: ChildProcess;
      try { child = actual.spawn(process.execPath, [gitProcess.wrapper, ...args[1]], args[2]); }
      catch { gitProcess.diagnostics.push({ stage: "wrapper-spawn-error", code: "unknown" }); throw new Error("Fixture wrapper spawn failed."); }
      gitProcess.child = child;
      child.once("spawn", () => gitProcess.diagnostics.push({ stage: "wrapper-spawn", pid: child.pid ?? "unknown" }));
      child.once("error", error => gitProcess.diagnostics.push({ stage: "wrapper-error", code: ["ENOENT", "EACCES", "EPERM", "EIO", "EMFILE", "ENFILE"].includes((error as NodeJS.ErrnoException).code ?? "") ? (error as NodeJS.ErrnoException).code : "unknown" }));
      child.once("exit", (code, signal) => gitProcess.diagnostics.push({ stage: "wrapper-exit", code, signal }));
      child.once("close", (code, signal) => gitProcess.diagnostics.push({ stage: "wrapper-close", code, signal }));
      child.stdout?.on("data", chunk => { gitProcess.stdoutBytes += Buffer.byteLength(chunk); });
      child.stderr?.on("data", chunk => { gitProcess.stderrBytes += Buffer.byteLength(chunk); });
      child.once("close", () => { gitProcess.childClosed = true; });
      child.stdout?.once("close", () => { gitProcess.stdoutClosed = true; });
      child.stderr?.once("close", () => { gitProcess.stderrClosed = true; });
      return child;
    }
    if (typeof args[0] === "string" && /[\\/]System32[\\/]taskkill\.exe$/i.test(args[0]) && gitProcess.helper !== undefined) {
      gitProcess.diagnostics.push({ stage: "helper-spawn-attempt", executable: "node", arguments: "redacted" });
      let helper: ChildProcess;
      try { helper = actual.spawn(process.execPath, [gitProcess.helper, String((args[1] as string[])[1])], args[2]); }
      catch { gitProcess.diagnostics.push({ stage: "helper-spawn-error", code: "unknown" }); throw new Error("Fixture helper spawn failed."); }
      gitProcess.stopHelper = helper;
      helper.once("spawn", () => gitProcess.diagnostics.push({ stage: "helper-spawn", pid: helper.pid ?? "unknown" }));
      helper.once("error", () => gitProcess.diagnostics.push({ stage: "helper-error", code: "unknown" }));
      helper.once("exit", (code, signal) => gitProcess.diagnostics.push({ stage: "helper-exit", code, signal }));
      helper.once("close", (code, signal) => gitProcess.diagnostics.push({ stage: "helper-close", code, signal }));
      helper.once("close", () => { gitProcess.helperClosed = true; });
      helper.stdout?.once("close", () => { gitProcess.helperStdoutClosed = true; });
      return helper;
    }
    return Reflect.apply(actual.spawn, undefined, args) as ReturnType<typeof actual.spawn>;
  }) as typeof actual.spawn;
  return { ...actual, spawn };
});
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
  polling.onSchedule = undefined; polling.requested.length = 0; gitProcess.wrapper = undefined; gitProcess.helper = undefined; gitProcess.child = undefined; gitProcess.stopHelper = undefined; gitProcess.childClosed = false; gitProcess.stdoutClosed = false; gitProcess.stderrClosed = false; gitProcess.helperClosed = false; gitProcess.helperStdoutClosed = false; gitProcess.diagnostics.length = 0; gitProcess.stdoutBytes = 0; gitProcess.stderrBytes = 0;
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (shutdownErrors.length > 0) throw new AggregateError(shutdownErrors, "Coordinator fixture shutdown failed.");
});
const task = (projectId: string, id: string): Task => ({ type: "task", parentId: null, id, projectId, title: id, description: "task", tags: [], status: "todo", allowAgents: true, assignedTo: null, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null, version: 1n, properties: { pullRequests: [] }, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true });
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 3500, interval: 10 });
const worktreePaths = (cwd: string): string[] => execFileSync("git", ["worktree", "list", "--porcelain", "-z"], { cwd, encoding: "utf8", timeout: 10_000 }).split("\0").filter(field => field.startsWith("worktree ")).map(field => path.normalize(field.slice("worktree ".length)));

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
    scanWorktrees: scanFromList, listWorktrees: vi.fn(async (source: WorkerProject) => [...worktrees.values()].filter(({ owner }) => owner.projectId === source.projectId)),
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
  return { stoppedRuns, root, get store() { return store; }, reopenStore, project, candidates, grants, grant, resources, worktrees, manifests, git, herdr, tasks, remote, order, events, options, coordinator: createWorkerCoordinator(options), clock: (value: number) => { clock = value; }, bind, blockStartupInput: () => { blockedStartupInput = true; } };
};

const waitForOriginalStartup = (f: Awaited<ReturnType<typeof fixture>>) => eventually(() => {
  const original = f.store.listTasks()[0];
  expect(original?.sessionId).toEqual(expect.any(String));
  const granted = f.grants.get(original!.claimId);
  expect(granted).toBeDefined();
  // The local session is persisted before this summary commits to the fixture's remote inventory.
  expect(readWorkerClaim(granted!.properties)).toMatchObject({ claimId: original!.claimId, workerId, phase: "executing", nativeSessionId: original!.sessionId });
});

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
  vi.spyOn(launchObservation, "reconcileSubmittedControllerLaunch").mockImplementation(async input => ({ kind: "controller-exited", process: input.spawnProof, snapshot }));
  vi.spyOn(lifecycle, "recordStoppedControllerGeneration").mockResolvedValue(snapshot);
  vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  return { task, request: vi.fn<typeof requestController>().mockRejectedValue(new ControllerIpcOutcomeUnknownError("Original controller is stopped.")) };
};

const addOrphan = (f: Awaited<ReturnType<typeof fixture>>, taskId = uuid(900)) => {
  const owner = { projectId: f.project.projectId, taskId, claimId: uuid(901), worktreeId: uuid(902) };
  const binding = { session: "w", workspaceId: "orphan", paneId: "orphan-pane", terminalId: "orphan-terminal" };
  const pane: HerdrOwnedWorkspace["panes"][number] = { binding, cwd: f.bind(owner).worktreePath, kind: "copilot", status: "working", launchPending: false, interactiveReady: true, nativeSession: { source: "herdr", agent: "copilot", sessionId: uuid(903) }, stateChangeSeq: 1, completionSeq: 0 };
  f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
  f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
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
    expect(successor).toMatchObject({ taskId: owner.taskId, status: "active", agent: "codex", sessionId: expect.any(String) });
    expect(f.store.getTask(owner)).toEqual({ ...row, status: "done" });
    expect(vi.mocked(f.git.removeWorktree).mock.calls.map(([, identity]) => identity.claimId)).toEqual([owner.claimId]);
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
    f.tasks.stopAndClose.mockImplementation(async () => { pending.splice(0); f.stoppedRuns.add(owner.claimId); });
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
  it.each(["success", "absent", "successor", "conflict"])('retires legacy release metadata before returning or retries it after restart: %s', async state => {
    const f = await fixture(), owner = { projectId: f.project.projectId, taskId: uuid(700), claimId: uuid(701), worktreeId: uuid(702) };
    await mkdir(f.project.localPath, { recursive: true });
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", timeout: 10_000 });
    git(f.project.localPath, "init", "--initial-branch=main");
    git(f.project.localPath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture");
    git(f.project.localPath, "remote", "add", "origin", f.project.repoUrl);
    let manager = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "temporary"), prepareFormat });
    const op = createOperation();
    let cwd: string;
    try {
      const repo = await manager.prepareRepository(f.project, op);
      createWorktreeManifestStore(repo.commonDirectory).publish({ schemaVersion: 1, ...owner, directoryName: owner.taskId });
      cwd = path.join(f.project.localPath, ".worktrees", "daynight", owner.taskId);
      await mkdir(path.dirname(cwd), { recursive: true });
      git(f.project.localPath, "worktree", "add", "-b", `daynight/${owner.taskId}`, cwd, "HEAD");
    } finally { op.dispose(); }
    const binding = { session: "w", workspaceId: "original", paneId: "p", terminalId: "t" };
    f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", sessionId: uuid(703) }));
    f.resources.set(owner.claimId, { owner, workspaceId: binding.workspaceId, panes: [{ binding, cwd, kind: "codex", status: "working", launchPending: false, interactiveReady: true, nativeSession: { source: "herdr", agent: "codex", sessionId: uuid(703) }, stateChangeSeq: 1, completionSeq: 0 }] });
    const grant = f.grant(task(owner.projectId, owner.taskId), { claimId: owner.claimId, worktreeId: owner.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex" });
    f.candidates.splice(0);
    Object.assign(f.remote, { authorizeControl: vi.fn(async () => {}), release: vi.fn(async () => { f.grants.clear(); return task(owner.projectId, owner.taskId); }) });
    const unlinkFailure = new Error("manifest unlink failed");
    const firstRetire = vi.spyOn(manager, "retireWorktreeManifest");
    if (state !== "success") firstRetire.mockRejectedValueOnce(unlinkFailure);
    let coordinator = createWorkerCoordinator({ ...f.options, git: manager });
    try {
      const release = submitWorkerControl({ ...f.options, coordinator, signal: new AbortController().signal,
        request: { kind: "release", projectId: owner.projectId, taskId: owner.taskId, claimId: owner.claimId, version: grant.version } });
      if (state === "success") await expect(release).resolves.toMatchObject({ task: { status: "done" } });
      else await expect(release).rejects.toMatchObject({ message: "Release was confirmed, but source cleanup remains incomplete.", cause: unlinkFailure });
      expect(f.store.getTask(owner)?.status).toBe("done");
      expect(f.store.getCleanupSchedule(owner)).toBeNull();
      expect(firstRetire).toHaveBeenCalledOnce();
      const readOp = createOperation();
      let originalManifest: Awaited<ReturnType<WorkerGitManager["listWorktreeManifests"]>>;
      try { originalManifest = await manager.listWorktreeManifests(f.project, readOp); } finally { readOp.dispose(); }
      expect(originalManifest).toHaveLength(state === "success" ? 0 : 1);
      if (state === "success") return;
      await coordinator.shutdown(); await manager.dispose(); f.reopenStore(); f.stoppedRuns.clear();
      let successorFile: string | undefined;
      if (state === "successor" || state === "conflict") {
        git(f.project.localPath, "worktree", "add", cwd, `daynight/${owner.taskId}`);
        successorFile = path.join(cwd, "successor.txt"); await writeFile(successorFile, "retain");
        const next = { ...owner, taskId: state === "conflict" ? uuid(706) : owner.taskId, claimId: uuid(704), worktreeId: uuid(705) }, pane = { session: "w", workspaceId: "successor", paneId: "p2", terminalId: "t2" };
        f.resources.set(next.claimId, { owner: next, workspaceId: pane.workspaceId, panes: [{ binding: pane, cwd, kind: "codex", status: "working", launchPending: false, interactiveReady: true, nativeSession: null, stateChangeSeq: 1, completionSeq: 0 }] });
        f.grant(task(next.projectId, next.taskId), { claimId: next.claimId, worktreeId: next.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex" });
        f.store.registerPending({ ...next, agent: "codex" });
      } else f.candidates.push(task(owner.projectId, owner.taskId));
      manager = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "temporary"), prepareFormat });
      const restartOp = createOperation(); try { await manager.prepareRepository(f.project, restartOp); } finally { restartOp.dispose(); }
      const find = vi.spyOn(manager, "findWorktree"), remove = vi.spyOn(manager, "removeWorktree"), retire = vi.spyOn(manager, "retireWorktreeManifest");
      coordinator = createWorkerCoordinator({ ...f.options, git: manager, ...(state === "successor" || state === "conflict" ? { repositories: [], globalConfiguration: null } : {}) });
      await coordinator.tick();
      expect(remove).not.toHaveBeenCalled();
      if (state === "conflict") {
        expect(retire).not.toHaveBeenCalled();
        expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-error", error: expect.objectContaining({ message: "An unrelated Herdr execution occupies the original worktree path." }) }));
        expect(find.mock.calls.some(([, found]) => found.claimId === owner.claimId)).toBe(false);
        await expect(access(successorFile!)).resolves.toBeUndefined();
      } else if (state === "successor") {
        expect(retire).toHaveBeenCalledWith(f.project, owner, expect.anything());
        expect(find.mock.calls.some(([, found]) => found.claimId === owner.claimId)).toBe(false);
        await expect(access(successorFile!)).resolves.toBeUndefined();
      } else {
        expect(retire).toHaveBeenCalledWith(f.project, owner, expect.anything());
        expect(find.mock.calls.some(([, found]) => found.claimId === owner.claimId)).toBe(true);
        expect(f.remote.claim).toHaveBeenCalledOnce();
      }
    } finally { await coordinator.shutdown(); await manager.dispose(); }
  }, 30_000);

  it("restores failed cleanup and its retry time without starting a native session", async () => {
    const f = await fixture(); await f.coordinator.tick();
    await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const owner = [...f.worktrees.values()][0]!.owner;
    f.grants.clear(); f.resources.clear(); f.stoppedRuns.add(owner.claimId); f.candidates.splice(0);
    vi.mocked(f.git.removeWorktree).mockRejectedValue(new Error("EACCES fixture"));
    await f.coordinator.tick();
    await eventually(() => expect(f.events.some(e => e.kind === "cleanup-error")).toBe(true));
    await f.coordinator.shutdown(); f.reopenStore();
    const restarted = createWorkerCoordinator(f.options);
    const calls = vi.mocked(f.git.removeWorktree).mock.calls.length;
    f.clock(1999); await restarted.tick();
    expect(f.git.removeWorktree).toHaveBeenCalledTimes(calls);
    vi.mocked(f.git.removeWorktree).mockImplementation(async () => { f.worktrees.delete(owner.claimId); return { kind: "absent", effectErrors: [] }; });
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
    f.grants.clear(); f.resources.clear(); f.stoppedRuns.add(owner.claimId); f.candidates.splice(0);
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
    const restarted = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: webConfiguration }], globalConfiguration: webConfiguration, webStore, webBackend: { ...backend, advance, advanceResult: async input => ({ kind: "observed", task: await advance(input) }) }, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
    f.candidates.push(task(f.project.projectId, uuid(103)));
    const operation = mode === "reconciliation" ? restarted.tick() : restarted.shutdown();
    try {
      await eventually(() => expect(observationEntered).toBe(true));
      expect(f.herdr.ensureInstance).toHaveBeenCalled();
      expect(f.store.getCleanupSchedule(owner)).toEqual(retained);
      if (mode === "direct shutdown") expect(f.remote.claim).not.toHaveBeenCalled();
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
    const restarted = createWorkerCoordinator({ ...f.options, repositories: [{ project: f.project, configuration: webConfiguration }], globalConfiguration: webConfiguration, webStore, webBackend: { ...backend, advance, advanceResult: async input => ({ kind: "observed", task: await advance(input) }) }, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
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
  const advance = vi.spyOn(backend, "advanceResult");
  const coordinator = createWorkerCoordinator({ ...f.options, repositories: [], globalConfiguration: configuration, webStore, webBackend: backend });
  try {
    await coordinator.tick();
    await eventually(() => {
      expect(f.store.getTask(owner)?.status).toBe("done");
      expect(f.store.getCleanupSchedule(owner)).toBeNull();
    });
    expect(webStore.getTask(owner)).toMatchObject({ status: "done", cleanup: { deadline: expectedDeadline } });
    expect(f.git.removeUnpublishedReservation).toHaveBeenCalledOnce();
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
    expect(launcher.launch).not.toHaveBeenCalled();
    expect(f.tasks.start).not.toHaveBeenCalled();
    expect(f.remote.claim).not.toHaveBeenCalled();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

describe("ordinary claim admission with retained resources", () => {
  it("retains live or unattributed Git resources and preserves a successor during metadata retirement", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), owner = { projectId: f.project.projectId, taskId: uuid(100), claimId: uuid(700), worktreeId: uuid(702) };
    await mkdir(f.project.localPath, { recursive: true });
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", timeout: 10_000 });
    git(f.project.localPath, "init", "--initial-branch=main");
    git(f.project.localPath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture");
    git(f.project.localPath, "remote", "add", "origin", f.project.repoUrl);
    const bare = path.join(f.root, "origin.git");
    git(f.root, "clone", "--bare", f.project.localPath, bare);
    git(f.project.localPath, "config", `url.${bare}.insteadOf`, f.project.repoUrl);
    const manager = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "temporary"), prepareFormat });
    const operation = createOperation();
    let binding: WorktreeBinding;
    try { await manager.prepareRepository(f.project, operation); binding = await manager.prepareWorktree(f.project, owner, operation); }
    finally { operation.dispose(); }
    const webStore = openWebExecutionStore(path.join(f.root, "web.sqlite"));
    const coordinator = createWorkerCoordinator({ ...f.options, git: manager, webStore });
    f.candidates.splice(1);
    try {
      await coordinator.tick();
      expect(f.remote.claim).not.toHaveBeenCalled();
      git(f.project.localPath, "worktree", "remove", "--force", binding.worktreePath);
      await mkdir(binding.worktreePath, { recursive: true });
      const unattributed = path.join(binding.worktreePath, "unattributed.txt");
      await writeFile(unattributed, "retain");
      await coordinator.tick();
      expect(f.remote.claim).not.toHaveBeenCalled();
      await expect(access(unattributed)).resolves.toBeUndefined();
      await rm(binding.worktreePath, { recursive: true });
      const alias = path.join(f.root, "repository-alias");
      await symlink(f.project.localPath, alias, process.platform === "win32" ? "junction" : "dir");
      const aliasedBinding = { ...binding, repositoryPath: alias, worktreePath: path.join(alias, path.relative(f.project.localPath, binding.worktreePath)) };
      let record = webStore.register({ ...owner, project: { ...f.project, localPath: alias }, serverOrigin: origin, workerId, userId: uuid(2), configuration: { ...configuration, agentControlMode: "web" } }, 1);
      record = webStore.bindWorktree(record, aliasedBinding, 2);
      record = webStore.beginCleanup(record, { kind: "terminal", deadline: 100 }, 2);
      webStore.completeTask(record, 3);
      vi.spyOn(manager, "retireWorktreeManifest").mockRejectedValue(new Error("manifest unlink failed"));
      git(f.project.localPath, "worktree", "add", "-b", "successor", binding.worktreePath, "HEAD");
      const successorFile = path.join(binding.worktreePath, "successor.txt");
      await writeFile(successorFile, "successor");
      const manifests = createWorktreeManifestStore(binding.commonDirectory);
      const foreign = { schemaVersion: 1 as const, projectId: uuid(120), taskId: uuid(121), claimId: uuid(122), worktreeId: uuid(123), directoryName: uuid(123) };
      manifests.publish(foreign);
      await coordinator.tick();
      expect(f.remote.claim).not.toHaveBeenCalled();
      manifests.remove(foreign);
      await coordinator.tick();
      expect(f.remote.claim).toHaveBeenCalledOnce();
      expect(vi.mocked(f.remote.claim).mock.calls[0]![0].id).toBe(owner.taskId);
      expect(manifests.read(owner.worktreeId)).not.toBeNull();
      await expect(access(successorFile)).resolves.toBeUndefined();
    } finally { await coordinator.shutdown(); webStore.close(); await manager.dispose(); }
  }, 30_000);

  it("allows an existing successor after observing the old legacy resources absent", async () => {
    const f = await fixture(), old = { projectId: f.project.projectId, taskId: uuid(100), claimId: uuid(700), worktreeId: uuid(702) };
    const successor = { ...old, claimId: uuid(703), worktreeId: uuid(704) };
    const binding = f.bind(old);
    f.manifests.set(old.claimId, { owner: old, binding });
    f.store.completeTask(f.store.registerPending({ ...old, agent: "codex" }));
    f.grant(task(successor.projectId, successor.taskId), { claimId: successor.claimId, worktreeId: successor.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex" });
    f.store.registerPending({ ...successor, agent: "codex" });
    f.candidates.splice(0);
    await f.coordinator.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    expect(f.store.getTask(successor)?.status).toBe("active");
    expect(f.manifests.has(old.claimId)).toBe(false);
  });

  it("retires an absent rowless manifest after observing the current resources", async () => {
    const f = await fixture(), owner = { projectId: f.project.projectId, taskId: uuid(100), claimId: uuid(700), worktreeId: uuid(702) };
    f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
    f.candidates.splice(1);
    await f.coordinator.tick();
    expect(f.manifests.has(owner.claimId)).toBe(false);
    expect(f.git.retireWorktreeManifest).toHaveBeenCalledWith(f.project, owner, expect.anything());
    expect(f.remote.claim).toHaveBeenCalledOnce();
  });

  it("retires a rowless legacy manifest only after real Git and directory absence", async () => {
    const f = await fixture(), owner = { projectId: f.project.projectId, taskId: uuid(100), claimId: uuid(700), worktreeId: uuid(702) };
    await mkdir(f.project.localPath, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: f.project.localPath, stdio: "pipe", timeout: 10_000 });
    git("init", "--initial-branch=main");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture");
    git("remote", "add", "origin", f.project.repoUrl);
    const manager = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "temporary"), prepareFormat });
    const operation = createOperation();
    let cwd: string;
    try {
      const repo = await manager.prepareRepository(f.project, operation);
      createWorktreeManifestStore(repo.commonDirectory).publish({ schemaVersion: 1, ...owner, directoryName: owner.taskId });
      cwd = path.join(f.project.localPath, ".worktrees", "daynight", owner.taskId);
      await mkdir(cwd, { recursive: true });
      await writeFile(path.join(cwd, "unattributed"), "retain");
    } finally { operation.dispose(); }
    f.candidates.splice(1);
    const coordinator = createWorkerCoordinator({ ...f.options, git: manager });
    try {
      await coordinator.tick();
      expect(f.remote.claim).not.toHaveBeenCalled();
      await expect(access(path.join(cwd, "unattributed"))).resolves.toBeUndefined();
      await rm(cwd, { recursive: true });
      await coordinator.tick();
      expect(f.remote.claim).toHaveBeenCalledOnce();
      const read = createOperation();
      try { expect(await manager.listWorktreeManifests(f.project, read)).toEqual([]); } finally { read.dispose(); }
    } finally { await coordinator.shutdown(); await manager.dispose(); }
  }, 30_000);

  it.each(["other native owner", "same native owner", "same native binding", "same never-started candidate", "legacy workspace", "legacy pending stop", "legacy lookup failure", "native lookup failure", "Git lookup failure"] as const)("checks rowless metadata with %s", async variant => {
    const f = await fixture(), owner = { projectId: f.project.projectId, taskId: uuid(100), claimId: uuid(700), worktreeId: uuid(702) };
    f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) }); f.candidates.splice(0);
    const other = { ...owner, taskId: uuid(710), claimId: uuid(711), worktreeId: uuid(712) };
    Object.assign(f.herdr, { lifecycle: {
      responsibilities: () => variant === "same native owner" ? [owner] : [other],
      isStopped: () => false,
      neverStarted: { candidates: () => variant === "same never-started candidate" ? [owner] : [], retired: () => [] },
      migration: {
        listLifecycles: () => [], listRetired: () => [], assertOrigin: () => {},
        listLegacyBindings: async () => {
          if (variant === "legacy lookup failure") throw new Error("legacy observation failed");
          if (variant !== "legacy workspace") return [];
          const binding = { session: "w", workspaceId: "old", paneId: "p", terminalId: "t" };
          return [{ owner, workspaceId: binding.workspaceId, panes: [{ binding, cwd: f.bind(owner).worktreePath, kind: "codex", status: "working", launchPending: false, interactiveReady: true, nativeSession: null, stateChangeSeq: 1, completionSeq: 0 }] }];
        },
        listLegacyPendingStops: () => variant === "legacy pending stop" ? [{ context: { ...owner, cwd: f.bind(owner).worktreePath }, binding: { session: "w", workspaceId: "old", paneId: "p", terminalId: "t" } }] : [],
      },
      worktreePath: (target: ResourceOwner) => {
        if (variant === "native lookup failure") throw new Error("native storage unavailable");
        return target.claimId === other.claimId ? f.bind(other).worktreePath : variant === "same native binding" ? f.bind(owner).worktreePath : null;
      },
    } });
    if (variant === "Git lookup failure") vi.mocked(f.git.findWorktree).mockRejectedValue(new Error("Git inspection failed"));
    const coordinator = createWorkerCoordinator({ ...f.options, hasHerdrJournal: true });
    try {
      await coordinator.tick();
      expect(f.manifests.has(owner.claimId)).toBe(variant !== "other native owner");
      if (variant === "native lookup failure" || variant === "Git lookup failure" || variant === "legacy lookup failure") expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-error", message: "Worktree metadata retirement remains pending." }));
    } finally { await coordinator.shutdown(); }
  });

  it.each(["successor", "different task", "foreign origin"] as const)("checks a durable native %s before touching an old cwd", async variant => {
    const f = await fixture(), owner = { projectId: f.project.projectId, taskId: uuid(100), claimId: uuid(700), worktreeId: uuid(702) };
    const next = { ...owner, taskId: variant === "different task" ? uuid(710) : owner.taskId, claimId: uuid(711), worktreeId: uuid(712) };
    const cwd = path.join(f.project.localPath, ".worktrees", "daynight", owner.taskId);
    f.manifests.set(owner.claimId, { owner, binding: { ...f.bind(owner), worktreePath: cwd } }); f.candidates.splice(0);
    Object.assign(f.herdr, { lifecycle: {
      responsibilities: () => [], isStopped: () => false, worktreePath: () => null,
      migration: {
        listLifecycles: () => [{ owner: next, claimId: next.claimId, cwd }], listRetired: () => [],
        assertOrigin: () => { if (variant === "foreign origin") throw new Error("foreign native owner"); },
        listLegacyBindings: async () => [], listLegacyPendingStops: () => [],
      },
    } });
    const find = vi.mocked(f.git.findWorktree).getMockImplementation()!;
    vi.mocked(f.git.findWorktree).mockImplementation((project, target, operation) => {
      if (target.claimId === owner.claimId) throw new Error("must not inspect successor cwd");
      return find(project, target, operation);
    });
    const coordinator = createWorkerCoordinator({ ...f.options, hasHerdrJournal: true });
    try {
      await coordinator.tick();
      expect(f.manifests.has(owner.claimId)).toBe(variant !== "successor");
      expect(vi.mocked(f.git.findWorktree).mock.calls.some(([, target]) => target.claimId === owner.claimId)).toBe(false);
      if (variant !== "successor") expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-error", message: "Worktree metadata retirement remains pending." }));
    } finally { await coordinator.shutdown(); }
  });

  it("fences an unfinished Web record before the first reconciliation after restart", async () => {
    const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
    const f = await fixture(), webFile = path.join(f.root, "web.sqlite");
    const owner = { projectId: f.project.projectId, taskId: uuid(100), claimId: uuid(700), worktreeId: uuid(702) };
    let webStore = openWebExecutionStore(webFile);
    webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: { ...configuration, agentControlMode: "web" } }, 1);
    webStore.close();
    webStore = openWebExecutionStore(webFile);
    const restarted = createWorkerCoordinator({ ...f.options, webStore });
    try {
      await restarted.tick();
      expect(f.remote.claim).not.toHaveBeenCalled();
      expect(webStore.getTask(owner)?.status).not.toBe("done");
    } finally { await restarted.shutdown(); webStore.close(); }
  });

  it.each(["unfinished local execution", "cleanup schedule"] as const)("fences the original task after restart with an %s", async retained => {
    const f = await fixture(), owner = { projectId: f.project.projectId, taskId: uuid(100), claimId: uuid(700), worktreeId: uuid(702) };
    const local = f.store.registerPending({ ...owner, agent: "codex" });
    if (retained === "unfinished local execution") f.store.activateTask(local);
    else {
      f.store.completeTask(local);
      f.store.saveCleanupSchedule(owner, { deadline: 600_000, failures: 1, nextAttemptAt: 2000, stage: "worktree-removal", lastError: "cleanup pending" });
      f.stoppedRuns.add(owner.claimId);
    }
    f.reopenStore();
    const restarted = createWorkerCoordinator(f.options);
    try {
      await restarted.tick();
      expect([...f.grants.values()].some(value => value.id === owner.taskId)).toBe(false);
      if (retained === "cleanup schedule") {
        expect([...f.grants.values()].map(value => value.id)).toEqual([uuid(101)]);
        expect(f.store.getCleanupSchedule(owner)).not.toBeNull();
      }
    } finally { await restarted.shutdown(); }
  });

  it("keeps an existing granted task pending until its project is selected and ready", async () => {
    const f = await fixture(2), claimId = uuid(700), taskId = uuid(701), worktreeId = uuid(702);
    await mkdir(f.project.localPath, { recursive: true });
    f.grant(task(f.project.projectId, taskId), { claimId, worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex" });
    const resumed = f.store.registerPending({ projectId: f.project.projectId, taskId, claimId, agent: "codex" });
    vi.mocked(f.remote.readTask).mockImplementation(async (_projectId, id) => [...f.grants.values()].find(value => value.id === id)!);
    f.reopenStore();
    const selectedTargets = [f.project.projectId];
    const runner = createWorkerCoordinator({ ...f.options, repositories: [], readyProjectIds: [], targetProjectIds: selectedTargets, globalConfiguration: configuration });
    selectedTargets.length = 0;
    await runner.tick();
    expect(f.store.getTask(resumed)?.status).toBe("pending");
    expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.remote.claim).not.toHaveBeenCalled();
    runner.updateConfiguration({ repositories: [], readyProjectIds: [], targetProjectIds: [], globalConfiguration: null, maxConcurrent: 2, preferPlatformSpecificTasks: false });
    await runner.tick();
    expect(f.store.getTask(resumed)?.status).toBe("pending");
    expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.remote.claim).not.toHaveBeenCalled();
    runner.updateConfiguration({ repositories: [], readyProjectIds: [], targetProjectIds: [], globalConfiguration: configuration, maxConcurrent: 2, preferPlatformSpecificTasks: false });
    await runner.tick();
    expect(f.store.getTask(resumed)?.status).toBe("pending");
    expect(f.tasks.start).not.toHaveBeenCalled();
    runner.updateConfiguration({ repositories: [{ project: f.project, configuration }], readyProjectIds: [f.project.projectId], targetProjectIds: [f.project.projectId], globalConfiguration: configuration, maxConcurrent: 2, preferPlatformSpecificTasks: false });
    f.candidates.splice(0);
    await runner.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    expect(f.store.getTask(resumed)).toMatchObject({ claimId: resumed.claimId, status: "active" });
    expect(f.git.prepareWorktree).toHaveBeenCalledOnce();
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
  const options = () => ({ ...f.options, repositories: [{ project: f.project, configuration }], globalConfiguration: configuration, webStore, verifyWebServer: vi.fn(async () => {}), verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: vi.fn() } });
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
    await coordinator.shutdown();
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
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it("validates and freezes a Web tool before claiming, then retains that choice when current targets fail", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const { resolveToolLaunch } = await import("../../../src/platform/tool-executables.js");
  const f = await fixture(); f.candidates.splice(1);
  const file = path.join(f.root, "selected.mjs"); await writeFile(file, "#!/usr/bin/env node\nconsole.log('fixture');\n", { mode: 0o755 });
  const operation = createOperation();
  let toolLaunch;
  try { toolLaunch = await resolveToolLaunch({ tool: "codex", context: "web", choice: { kind: "path", path: file }, cwd: f.root, environment: {} }, operation); }
  finally { operation.dispose(); }
  const webStore = openWebExecutionStore(path.join(f.root, "web.sqlite"));
  const configuration: ExecutionConfiguration = { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 3 };
  let available = false, selections = 0;
  const freezeConfiguration = async (input: ExecutionConfiguration) => {
    if (input.toolLaunch !== undefined) return input;
    if (!available) throw new Error("Selected tool is unavailable.");
    expect(f.remote.claim).not.toHaveBeenCalled(); selections++;
    return { ...input, toolLaunch, toolObservation: { version: "1.0.0", checkedAt: "2026-11-12T00:00:00Z" } };
  };
  const advance = vi.fn(async (input: WebTask) => webStore.initializeWebExecution(input, 1));
  const coordinator = createWorkerCoordinator({ ...f.options, freezeConfiguration, webStore, repositories: [{ project: f.project, configuration }], globalConfiguration: configuration,
    verifyWebServer: async () => {}, verifyWebUnregistered: async () => {}, webBackend: { observeExecutionStop: unknownStop, advance, cleanup: async task => ({ task, complete: true }) } });
  try {
    await expect(coordinator.tick()).rejects.toThrow("Selected tool is unavailable"); expect(f.remote.claim).not.toHaveBeenCalled();
    available = true; await coordinator.tick(); await eventually(() => expect(advance).toHaveBeenCalled());
    const task = f.store.listTasks()[0]!;
    expect(f.store.getNativeConfiguration(task)?.toolLaunch?.selectionKey).toBe(toolLaunch.selectionKey);
    expect(webStore.getTask(task)?.configuration?.toolObservation?.version).toBe("1.0.0");
    const advances = advance.mock.calls.length; available = false;
    await coordinator.tick(); await eventually(() => expect(advance.mock.calls.length).toBeGreaterThan(advances));
    expect(selections).toBe(1); expect(f.remote.claim).toHaveBeenCalledOnce();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it("releases a stopped execution while its worktree remains held, without admitting the same task", async () => {
  const f = await fixture(), monitoring = createMonitoringObserver({ now: f.options.now });
  const coordinator = createWorkerCoordinator({ ...f.options, monitoring });
  await coordinator.tick();
  await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
  const original = f.store.listTasks()[0]!;
  const nextCandidate = f.candidates.splice(1, 1)[0]!;
  f.grants.clear();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const remove = vi.mocked(f.git.removeWorktree).getMockImplementation()!;
  vi.mocked(f.git.removeWorktree).mockImplementation(async (project, owner, options) => { await held; options.signal?.throwIfAborted(); return remove(project, owner, options); });
  try {
    await coordinator.tick();
    await eventually(() => expect(f.git.removeWorktree).toHaveBeenCalledOnce());
    await eventually(() => expect(monitoring.capture("1").capacity).toMatchObject({ quality: "current", occupied: 0, available: 1 }));
    f.candidates.push(nextCandidate);
    await coordinator.tick();
    await eventually(() => expect([...f.grants.values()].some(value => value.id === uuid(101))).toBe(true));
    expect([...f.grants.values()].some(value => value.id === original.taskId)).toBe(false);
    expect(f.worktrees.has(original.claimId)).toBe(true);
    expect(f.store.getTask(original)?.status).toBe("active");
  } finally { release(); await coordinator.shutdown(); }
});

it("waits for the original startup summary before withdrawing its grant", async () => {
  const f = await fixture();
  f.candidates.splice(1);
  const releaseSummary = Promise.withResolvers<void>();
  let summaryBlocked = false;
  const update = vi.mocked(f.remote.update).getMockImplementation()!;
  vi.mocked(f.remote.update).mockImplementation(async (current, summary, operation) => {
    if (summary.phase === "executing") { summaryBlocked = true; await releaseSummary.promise; }
    return update(current, summary, operation);
  });
  let ready = false;
  let startup: Promise<void> | undefined;
  const failures: unknown[] = [];
  try {
    await f.coordinator.tick();
    await eventually(() => expect(summaryBlocked).toBe(true));
    const original = f.store.listTasks()[0]!;
    expect(original.sessionId).toEqual(expect.any(String));
    expect(readWorkerClaim(f.grants.get(original.claimId)!.properties)).toMatchObject({ phase: "preparing", nativeSessionId: null });
    startup = waitForOriginalStartup(f).then(() => { ready = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(ready).toBe(false);
    expect(f.git.removeWorktree).not.toHaveBeenCalled();
    releaseSummary.resolve();
    await startup;
    expect(ready).toBe(true);
    f.candidates.splice(0); f.grants.clear();
    await vi.waitFor(async () => { await f.coordinator.tick(); expect(f.git.removeWorktree).toHaveBeenCalledOnce(); }, { timeout: 3500, interval: 10 });
    await eventually(() => expect(f.store.getTask(original)?.status).toBe("done"));
    expect(f.grants.has(original.claimId)).toBe(false);
    expect(f.resources.has(original.claimId)).toBe(false);
    expect(f.worktrees.has(original.claimId)).toBe(false);
    expect(f.order.slice(-2)).toEqual(["stop-close", "remove-worktree"]);
  } catch (error) { failures.push(error); }
  finally {
    releaseSummary.resolve();
    const startupSettlement = await Promise.allSettled([startup]);
    const shutdownSettlement = await Promise.allSettled([f.coordinator.shutdown()]);
    for (const result of [...startupSettlement, ...shutdownSettlement]) {
      if (result.status === "rejected" && !failures.includes(result.reason)) failures.push(result.reason);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Startup summary regression or fixture cleanup failed.", { cause: failures[0] });
  }
});

it.each([{ stream: "stdout", mode: "reconcile" }, { stream: "stderr", mode: "shutdown" }, { stream: "child", mode: "shutdown" }, ...(process.platform === "win32" ? [{ stream: "helper", mode: "shutdown" }] : [])])("holds the original task gate through $stream closure and $mode", async ({ stream, mode }) => {
  const f = await fixture(), monitoring = createMonitoringObserver({ now: f.options.now });
  await mkdir(f.project.localPath, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", timeout: 10_000 });
  git(f.project.localPath, "init", "--initial-branch=main");
  git(f.project.localPath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture");
  git(f.project.localPath, "remote", "add", "origin", f.project.repoUrl);
  const bare = path.join(f.root, "origin.git");
  git(f.root, "clone", "--bare", f.project.localPath, bare);
  git(f.project.localPath, "config", `url.${bare}.insteadOf`, f.project.repoUrl);
  const ready = path.join(f.root, "pipe-ready"), rootReady = path.join(f.root, "root-ready"), release = path.join(f.root, "pipe-release");
  const leaf = path.join(f.root, "pipe-holder.mjs"), wrapper = path.join(f.root, "git-wrapper.mjs");
  const receipt = path.join(f.root, "pipe-receipt.jsonl");
  const fixtureModule = pathToFileURL(path.resolve("test/commands/worker/pipe-ready-fixture.mjs")).href;
  await writeFile(leaf, `import { runLeaf } from ${JSON.stringify(fixtureModule)};\nrunLeaf(${JSON.stringify({ ready, release, receipt })});\n`);
  await writeFile(wrapper, `import { runWrapper } from ${JSON.stringify(fixtureModule)};\nrunWrapper(${JSON.stringify({ stream, ready, rootReady, release, leaf, receipt })});\n`);
  if (stream === "child") {
    const helper = path.join(f.root, "stop-helper.mjs"); await writeFile(helper, "process.exit(0);\n");
    gitProcess.helper = helper;
    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => pid === -(gitProcess.child?.pid ?? 0) ? true : kill(pid, signal));
  }
  if (stream === "helper") {
    const helper = path.join(f.root, "stop-helper.mjs");
    const taskkill = path.win32.join(process.env.SystemRoot!, "System32", "taskkill.exe");
    await writeFile(helper, `import { spawn, spawnSync } from 'node:child_process';\nconst stopped = spawnSync(${JSON.stringify(taskkill)}, ['/PID', process.argv[2], '/T', '/F'], { stdio: 'ignore', windowsHide: true });\nif (stopped.status !== 0) process.exit(stopped.status ?? 1);\nconst leaf = spawn(process.execPath, [${JSON.stringify(leaf)}], { detached: true, stdio: ['ignore', 'inherit', 'ignore'], windowsHide: true });\nleaf.unref();\n`);
    gitProcess.helper = helper;
  }
  let pending: import("../../../src/commands/worker/worktrees.js").WorkerGitPending | undefined;
  const joined = Promise.withResolvers<import("../../../src/repository/git-owned.js").GitSettlement>();
  const interrupt = new AbortController();
  let originalSignal: AbortSignal | undefined; let ownedSignal: AbortSignal | undefined; let shutdown: Promise<boolean> | undefined;
  const manager = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "temporary"), prepareFormat,
    startOwnedGit: (cwd, args, op, options) => {
      const remove = args.includes("worktree") && args.includes("remove");
      if (!remove) return startOwnedRepositoryGit(cwd, args, op, options);
      originalSignal = op.signal;
      const ownedOperation = createOperation({ signal: AbortSignal.any([op.signal, interrupt.signal]), limits: op.limits });
      ownedSignal = ownedOperation.signal;
      const command = startOwnedRepositoryGit(cwd, args, ownedOperation, options);
      void command.joined.then(() => ownedOperation.dispose());
      return command;
    },
    reportPending: (event) => { if (event.command === "worktree-remove") pending = event; },
    reportSettled: (event, settlement) => { if (event.command === "worktree-remove") joined.resolve(settlement); },
  });
  const operation = createOperation();
  try { await manager.prepareRepository(f.project, operation); } finally { operation.dispose(); }
  const coordinator = createWorkerCoordinator({ ...f.options, git: manager, monitoring });
  const reportMissingReady = async () => {
    const markerState = async (file: string): Promise<string> => {
      try { await access(file); return "present"; }
      catch (failure) { return (failure as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown"; }
    };
    let records: string = "unknown";
    try { records = await readFile(receipt, "utf8"); } catch { /* No receipt does not prove that the wrapper did not start. */ }
    console.error("pipe-ready fixture diagnostics", JSON.stringify({
      stream, mode, wrapper: gitProcess.diagnostics,
      output: { stdoutBytes: gitProcess.child?.stdout ? gitProcess.stdoutBytes : "unknown", stderrBytes: gitProcess.child?.stderr ? gitProcess.stderrBytes : "unknown" },
      closed: { child: gitProcess.childClosed, stdout: gitProcess.stdoutClosed, stderr: gitProcess.stderrClosed },
      ready: await markerState(ready), rootReady: await markerState(rootReady), receipt: records,
    }));
  };
  try {
    await coordinator.tick();
    await waitForOriginalStartup(f);
    const original = f.store.listTasks()[0]!;
    const owner = f.resources.get(original.claimId)!.owner;
    gitProcess.wrapper = wrapper;
    const candidates = f.candidates.splice(0);
    f.grants.clear();
    await coordinator.tick();
    const started = stream === "helper" ? rootReady : ready;
    await vi.waitFor(async () => { await coordinator.tick(); await expect(access(started)).resolves.toBeUndefined(); }, { timeout: 15_000, interval: 20 });
    if (stream === "child" && process.platform !== "win32") {
      await vi.waitFor(() => { expect(gitProcess.stdoutClosed).toBe(true); expect(gitProcess.stderrClosed).toBe(true); }, { timeout: 12_000, interval: 20 });
    } else if (stream === "stdout" || stream === "stderr") {
      await vi.waitFor(() => {
        expect(gitProcess.child?.exitCode).toBe(0);
        expect(stream === "stdout" ? gitProcess.stderrClosed : gitProcess.stdoutClosed).toBe(true);
      }, { timeout: 12_000, interval: 20 });
      expect(stream === "stdout" ? gitProcess.stdoutClosed : gitProcess.stderrClosed).toBe(false);
      expect(gitProcess.childClosed).toBe(false);
    }
    interrupt.abort(new Error("controlled mutation cancellation"));
    await vi.waitFor(() => expect(pending).toBeDefined(), { timeout: 15_000, interval: 20 });
    expect(pending).toMatchObject({ projectId: f.project.projectId, owner, command: "worktree-remove", error: { code: "repository_git_cleanup_pending" } });
    const contains = (error: unknown, target: unknown): boolean => error === target || error instanceof Error && (contains(error.cause, target) || error instanceof AggregateError && error.errors.some((entry: unknown) => contains(entry, target)));
    expect(contains(pending?.error, ownedSignal!.reason)).toBe(true);
    await vi.waitFor(async () => { await expect(access(ready)).resolves.toBeUndefined(); }, { timeout: 12_000, interval: 20 });
    if (stream === "child") {
      expect(gitProcess.child?.exitCode).toBeNull();
      expect(gitProcess.child?.signalCode).toBeNull();
      expect(gitProcess.childClosed).toBe(false);
      if (process.platform !== "win32") { expect(gitProcess.stdoutClosed).toBe(true); expect(gitProcess.stderrClosed).toBe(true); }
    }
    if (stream === "helper") {
      await vi.waitFor(() => {
        expect(gitProcess.child).toBeDefined();
        expect(gitProcess.child!.exitCode !== null || gitProcess.child!.signalCode !== null).toBe(true);
        expect(gitProcess.childClosed).toBe(true);
        expect(gitProcess.stdoutClosed).toBe(true); expect(gitProcess.stderrClosed).toBe(true);
        expect(gitProcess.stopHelper?.exitCode).toBe(0);
      }, { timeout: 12_000, interval: 20 });
      expect(gitProcess.helperStdoutClosed).toBe(false);
      expect(gitProcess.helperClosed).toBe(false);
    }
    await expect(access(f.bind(owner).worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.store.getTask(original)?.status).toBe("active");
    expect(monitoring.capture("1").capacity).toMatchObject({ occupied: 0, available: 1 });
    f.candidates.push(...candidates);
    await coordinator.tick();
    expect([...f.grants.values()].some(value => value.id === original.taskId)).toBe(false);
    await eventually(() => expect([...f.grants.values()].some(value => value.id === uuid(101))).toBe(true));
    expect(f.store.getTask(original)?.status).toBe("active");
    if (mode === "shutdown") {
      shutdown = coordinator.shutdown(); let stopped = false; void shutdown.then(() => { stopped = true; });
      expect(originalSignal?.aborted).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(stopped).toBe(false);
      expect(f.store.getTask(original)?.status).toBe("active");
      await writeFile(release, "release");
      const settlement = await joined.promise;
      expect(settlement.kind).toBe("local-closed");
      expect(gitProcess.childClosed).toBe(true);
      expect(gitProcess.stdoutClosed).toBe(true); expect(gitProcess.stderrClosed).toBe(true);
      if (stream === "helper") { expect(gitProcess.helperClosed).toBe(true); expect(gitProcess.helperStdoutClosed).toBe(true); }
      await shutdown;
    } else {
      await writeFile(release, "release");
      expect((await joined.promise).kind).toBe("local-closed");
      expect(gitProcess.childClosed).toBe(true);
      expect(gitProcess.stdoutClosed).toBe(true); expect(gitProcess.stderrClosed).toBe(true);
      await eventually(() => expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-effect-error", identity: expect.objectContaining(owner), error: expect.any(AggregateError) })));
      expect(contains(f.events.find(event => event.kind === "cleanup-effect-error")?.error, pending?.error)).toBe(true);
      await eventually(() => expect(f.store.getTask(original)?.status).toBe("done"));
      await eventually(() => expect(f.store.getCleanupSchedule(original)).toBeNull());
    }
  } catch (error) {
    await reportMissingReady();
    throw error;
  } finally {
    interrupt.abort(new Error("fixture cleanup"));
    await writeFile(release, "release");
    gitProcess.wrapper = undefined;
    await (shutdown ?? coordinator.shutdown());
    await manager.dispose();
  }
}, 45_000);

it("reconciles a failed removal after the directory is deleted in the same coordinator", async () => {
  const f = await fixture(2), monitoring = createMonitoringObserver({ now: f.options.now });
  await mkdir(f.project.localPath, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", timeout: 10_000 });
  git(f.project.localPath, "init", "--initial-branch=main");
  git(f.project.localPath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture");
  git(f.project.localPath, "remote", "add", "origin", f.project.repoUrl);
  const bare = path.join(f.root, "origin.git");
  git(f.root, "clone", "--bare", f.project.localPath, bare);
  git(f.project.localPath, "config", `url.${bare}.insteadOf`, f.project.repoUrl);
  const failure = new Error("controlled directory removal failure");
  let fail = true;
  const manager = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "temporary"), prepareFormat,
    removeDirectory: async (...args) => { if (fail) { fail = false; throw failure; } return rm(...args); },
  });
  const operation = createOperation();
  try { await manager.prepareRepository(f.project, operation); } finally { operation.dispose(); }
  const coordinator = createWorkerCoordinator({ ...f.options, git: manager, monitoring });
  const [originalCandidate, healthyCandidate] = f.candidates.splice(0);
  f.candidates.push(originalCandidate!);
  try {
    await coordinator.tick();
    await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
    const original = f.store.listTasks()[0]!;
    const owner = f.resources.get(original.claimId)!.owner;
    const cwd = f.bind(owner).worktreePath;
    await mkdir(path.join(cwd, "content"));
    await writeFile(path.join(cwd, "content", "file"), "data");
    f.candidates.splice(0);
    f.grants.clear();
    await coordinator.tick();
    await eventually(() => expect(f.store.getCleanupSchedule(owner)).toMatchObject({ failures: 1 }));
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-error" }));
    expect(monitoring.capture("1").currentFailures).toEqual(expect.arrayContaining([expect.objectContaining({ scope: expect.objectContaining({ claimId: owner.claimId }) })]));
    expect(f.store.getTask(owner)?.status).toBe("active");
    expect(worktreePaths(f.project.localPath)).toContain(path.normalize(cwd));
    f.candidates.push(healthyCandidate!); await coordinator.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(2));
    await rm(cwd, { recursive: true, force: true });
    expect(worktreePaths(f.project.localPath)).toContain(path.normalize(cwd));
    f.clock(1_000_000);
    await coordinator.tick();
    await eventually(() => expect(f.store.getTask(owner)?.status).toBe("done"));
    await eventually(() => expect(f.store.getCleanupSchedule(owner)).toBeNull());
    expect(monitoring.capture("2").lastRecovery?.scope).toMatchObject({ claimId: owner.claimId });
    await coordinator.tick();
    await eventually(() => expect(createWorktreeManifestStore(path.join(f.project.localPath, ".git")).read(owner.worktreeId)).toBeNull());
    expect(worktreePaths(f.project.localPath)).not.toContain(path.normalize(cwd));
    expect(git(f.project.localPath, "branch", "--list", `daynight/${owner.taskId}`).toString()).toContain(owner.taskId);
    f.candidates.push(originalCandidate!);
    await coordinator.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(3));
    const successor = f.store.listTasks().find(entry => entry.taskId === owner.taskId && entry.claimId !== owner.claimId)!;
    const successorOwner = f.resources.get(successor.claimId)!.owner;
    expect(successor.status).toBe("active");
    expect(successorOwner.worktreeId).not.toBe(owner.worktreeId);
    expect(f.bind(successorOwner).worktreePath).not.toBe(cwd);
    await expect(access(f.bind(successorOwner).worktreePath)).resolves.toBeUndefined();
  } finally { await coordinator.shutdown(); await manager.dispose(); }
}, 30_000);

it("releases legacy capacity on an observed empty resource set after restart while preserving the original task gate", async () => {
  const f = await fixture(), owner = { projectId: f.project.projectId, taskId: uuid(100), claimId: uuid(700), worktreeId: uuid(702) };
  f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", sessionId: uuid(703) }));
  f.store.saveCleanupSchedule(owner, { deadline: 600_000, failures: 0, nextAttemptAt: 0, stage: "worktree-removal", lastError: null });
  f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
  f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
  f.reopenStore();
  f.tasks.observeExecutionStop.mockImplementation(async target => ({ kind: "unknown", target, error: new LegacyBindingUnavailableError("legacy manager restarted"), observedAt: 1000 }));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const remove = vi.mocked(f.git.removeWorktree).getMockImplementation()!;
  vi.mocked(f.git.removeWorktree).mockImplementation(async (...args) => { entered.resolve(); await release.promise; return remove(...args); });
  const monitoring = createMonitoringObserver({ now: f.options.now }), coordinator = createWorkerCoordinator({ ...f.options, monitoring });
  try {
    await coordinator.tick(); await entered.promise;
    expect(monitoring.capture("1").capacity).toMatchObject({ occupied: 0, available: 1 });
    expect(f.store.getTask(owner)?.status).toBe("active");
    expect(f.worktrees.has(owner.claimId)).toBe(true);
    await coordinator.tick();
    expect([...f.grants.values()].map(task => task.id)).toEqual([uuid(101)]);
    expect(f.events.some(event => event.kind === "stop-unknown" && event.identity?.claimId === owner.claimId)).toBe(false);
    release.resolve();
    await eventually(() => expect(f.store.getTask(owner)?.status).toBe("done"));
  } finally { release.resolve(); await coordinator.shutdown(); }
});

it("retains unknown execution capacity and worktree across a SQLite restart", async () => {
  const f = await fixture();
  await f.coordinator.tick();
  await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
  const original = f.store.listTasks()[0]!;
  f.grants.clear();
  f.tasks.observeExecutionStop.mockImplementation(unknownStop);
  await f.coordinator.tick();
  await eventually(() => expect(f.events.some(event => event.kind === "cleanup-error")).toBe(true));
  expect(f.store.getTask(original)?.status).toBe("active");
  expect(f.store.getCleanupSchedule(original)).not.toBeNull();
  expect(f.worktrees.has(original.claimId)).toBe(true);
  f.reopenStore();
  const restarted = createWorkerCoordinator(f.options);
  await restarted.tick();
  expect(f.grants.size).toBe(0);
  expect(f.store.getTask(original)?.status).toBe("active");
  expect(f.worktrees.has(original.claimId)).toBe(true);
  expect(f.tasks.observeExecutionStop).toHaveBeenCalled();
  await restarted.shutdown();
});

it("settles a retained cleanup schedule through explicit control after restart", async () => {
  const f = await fixture();
  await f.coordinator.tick();
  await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
  const owner = [...f.worktrees.values()][0]!.owner;
  f.store.saveCleanupSchedule(owner, { deadline: 1000, failures: 0, nextAttemptAt: 0, stage: "observation", lastError: null });
  await f.coordinator.shutdown();
  f.reopenStore();
  const restarted = createWorkerCoordinator(f.options);
  await restarted.completeSource(owner);
  expect(f.store.getTask(owner)?.status).toBe("done");
  expect(f.store.getCleanupSchedule(owner)).toBeNull();
  await restarted.shutdown();
});

it("settles an explicitly controlled Web claim verified as unregistered", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(), webStore = openWebExecutionStore(path.join(f.root, "web.sqlite"));
  const owner = { projectId: f.project.projectId, taskId: uuid(940), claimId: uuid(941), worktreeId: uuid(942) };
  f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" });
  f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
  f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
  const verifyWebUnregistered = vi.fn(async () => {});
  const coordinator = createWorkerCoordinator({ ...f.options, webStore, webBackend: { advance: vi.fn(), cleanup: vi.fn(), observeExecutionStop: unknownStop }, verifyWebUnregistered });
  try {
    await coordinator.completeSource(owner);
    expect(verifyWebUnregistered).toHaveBeenCalledOnce();
    expect(f.store.getTask(owner)?.status).toBe("done");
    expect(f.store.getCleanupSchedule(owner)).toBeNull();
  } finally { await coordinator.shutdown(); webStore.close(); }
});

it("uses the stopped original when cleanup finishes after the resource snapshot", async () => {
  const f = await fixture(), wake = vi.fn();
  const coordinator = createWorkerCoordinator({ ...f.options, requestReconcile: wake });
  await coordinator.tick();
  await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
  const original = f.store.listTasks()[0]!;
  f.grants.clear();
  const removeEntered = Promise.withResolvers<void>(), finishRemoval = Promise.withResolvers<void>();
  const scanEntered = Promise.withResolvers<void>(), finishScan = Promise.withResolvers<void>();
  const remove = vi.mocked(f.git.removeWorktree).getMockImplementation()!;
  vi.mocked(f.git.removeWorktree).mockImplementation(async (project, owner, operation) => {
    removeEntered.resolve(); await finishRemoval.promise; operation.signal?.throwIfAborted(); return remove(project, owner, operation);
  });
  const scan = f.git.scanWorktrees.bind(f.git);
  let holdScan = false;
  vi.spyOn(f.git, "scanWorktrees").mockImplementation(async (...args) => {
    const result = await scan(...args);
    if (holdScan) { scanEntered.resolve(); await finishScan.promise; }
    return result;
  });
  try {
    await coordinator.tick();
    await removeEntered.promise;
    expect(wake).toHaveBeenCalled();
    const notifications = wake.mock.calls.length;
    holdScan = true;
    const nextRound = coordinator.tick();
    await scanEntered.promise;
    finishRemoval.resolve();
    await eventually(() => expect(f.store.getTask(original)?.status).toBe("done"));
    await eventually(() => {
      const schedule = f.store.getCleanupSchedule(original);
      if (schedule !== null) throw new Error(`Cleanup schedule remains: ${JSON.stringify(schedule)}; events: ${JSON.stringify(f.events, (_key, value) => value instanceof Error ? { message: value.message, stack: value.stack, cause: value.cause } : value)}`);
    });
    finishScan.resolve();
    await nextRound;
    await eventually(() => expect([...f.grants.values()].some(task => task.id === uuid(101))).toBe(true));
    expect(f.store.getCleanupSchedule(original)).toBeNull();
    expect(f.git.removeWorktree).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledTimes(notifications);
  } finally { finishRemoval.resolve(); finishScan.resolve(); await coordinator.shutdown(); }
});

it("does not recreate cleanup from a stale rowless workspace snapshot", async () => {
  const f = await fixture(), owner = { projectId: f.project.projectId, taskId: uuid(800), claimId: uuid(801), worktreeId: uuid(802) };
  f.candidates.splice(0);
  const binding = { session: "w", workspaceId: "old", paneId: "p", terminalId: "t" };
  f.resources.set(owner.claimId, { owner, workspaceId: binding.workspaceId, panes: [{ binding, cwd: f.bind(owner).worktreePath, kind: "codex", status: "idle", launchPending: false, interactiveReady: true, nativeSession: null, stateChangeSeq: 1, completionSeq: 0 }] });
  const staleWorkspace = structuredClone([...f.resources.values()]);
  f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) });
  f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
  const list = f.tasks.listResources.getMockImplementation()!;
  f.tasks.listResources.mockImplementationOnce(async () => { const result = await list(); f.resources.clear(); return result; });
  const removeEntered = Promise.withResolvers<void>(), finishRemoval = Promise.withResolvers<void>();
  const scanEntered = Promise.withResolvers<void>(), finishScan = Promise.withResolvers<void>();
  const remove = vi.mocked(f.git.removeWorktree).getMockImplementation()!;
  vi.mocked(f.git.removeWorktree).mockImplementation(async (project, target, operation) => { removeEntered.resolve(); await finishRemoval.promise; return remove(project, target, operation); });
  const scan = f.git.scanWorktrees.bind(f.git); let holdScan = false;
  vi.spyOn(f.git, "scanWorktrees").mockImplementation(async (...args) => { const result = await scan(...args); if (holdScan) { scanEntered.resolve(); await finishScan.promise; } return result; });
  try {
    await f.coordinator.tick(); await removeEntered.promise;
    expect(f.store.getTask(owner)).toBeNull();
    f.tasks.listResources.mockResolvedValueOnce(staleWorkspace).mockResolvedValueOnce(staleWorkspace);
    holdScan = true; const nextRound = f.coordinator.tick(); await scanEntered.promise;
    finishRemoval.resolve();
    await eventually(() => expect(f.store.getCleanupSchedule(owner)).toBeNull());
    finishScan.resolve(); await nextRound;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.store.getCleanupSchedule(owner)).toBeNull();
    expect(f.git.removeWorktree).toHaveBeenCalledOnce();
    f.resources.set(owner.claimId, staleWorkspace[0]!);
    await f.coordinator.tick();
    await eventually(() => expect(f.tasks.stopAndClose).toHaveBeenCalledOnce());
  } finally { finishRemoval.resolve(); finishScan.resolve(); await f.coordinator.shutdown(); }
});

it("keeps settlement evidence until an in-flight Herdr observation is processed after metadata retirement", async () => {
  const f = await fixture();
  await f.coordinator.tick();
  await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
  const owner = [...f.worktrees.values()][0]!.owner, workspace = structuredClone([...f.resources.values()]);
  f.grants.clear(); f.candidates.splice(0);
  const removeEntered = Promise.withResolvers<void>(), finishRemoval = Promise.withResolvers<void>();
  const observationEntered = Promise.withResolvers<void>(), finishObservation = Promise.withResolvers<void>();
  const remove = vi.mocked(f.git.removeWorktree).getMockImplementation()!;
  vi.mocked(f.git.removeWorktree).mockImplementation(async (project, target, operation) => { removeEntered.resolve(); await finishRemoval.promise; return remove(project, target, operation); });
  try {
    await f.coordinator.tick(); await removeEntered.promise;
    f.tasks.listResources.mockImplementationOnce(async () => { observationEntered.resolve(); await finishObservation.promise; return workspace; });
    const nextRound = f.coordinator.tick(); await observationEntered.promise;
    finishRemoval.resolve();
    await eventually(() => expect(f.store.getCleanupSchedule(owner)).toBeNull());
    expect(f.manifests.has(owner.claimId)).toBe(true);
    finishObservation.resolve(); await nextRound;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.git.retireWorktreeManifest).toHaveBeenCalledWith(f.project, owner, expect.anything());
    expect(f.manifests.has(owner.claimId)).toBe(false);
    expect(f.store.getCleanupSchedule(owner)).toBeNull();
    expect(f.git.removeWorktree).toHaveBeenCalledOnce();
  } finally { finishRemoval.resolve(); finishObservation.resolve(); await f.coordinator.shutdown(); }
});

it("keeps a workspace first observed after cleanup while an earlier request is in flight", async () => {
  const f = await fixture(), owner = { projectId: f.project.projectId, taskId: uuid(800), claimId: uuid(801), worktreeId: uuid(802) };
  f.candidates.splice(0);
  const binding = { session: "w", workspaceId: "old", paneId: "p", terminalId: "t" };
  f.resources.set(owner.claimId, { owner, workspaceId: binding.workspaceId, panes: [{ binding, cwd: f.bind(owner).worktreePath, kind: "codex", status: "idle", launchPending: false, interactiveReady: true, nativeSession: null, stateChangeSeq: 1, completionSeq: 0 }] });
  const workspace = structuredClone([...f.resources.values()]);
  f.worktrees.set(owner.claimId, { owner, binding: f.bind(owner) }); f.manifests.set(owner.claimId, { owner, binding: f.bind(owner) });
  const list = f.tasks.listResources.getMockImplementation()!;
  f.tasks.listResources.mockImplementationOnce(async () => { const result = await list(); f.resources.clear(); return result; });
  const removeEntered = Promise.withResolvers<void>(), finishRemoval = Promise.withResolvers<void>();
  const observationEntered = Promise.withResolvers<void>(), finishObservation = Promise.withResolvers<void>();
  const remove = vi.mocked(f.git.removeWorktree).getMockImplementation()!;
  vi.mocked(f.git.removeWorktree).mockImplementation(async (project, target, operation) => { removeEntered.resolve(); await finishRemoval.promise; return remove(project, target, operation); });
  try {
    await f.coordinator.tick(); await removeEntered.promise;
    f.tasks.listResources.mockResolvedValueOnce(workspace).mockImplementationOnce(async () => { observationEntered.resolve(); await finishObservation.promise; return list(); });
    const nextRound = f.coordinator.tick(); await observationEntered.promise;
    finishRemoval.resolve(); await eventually(() => expect(f.store.getCleanupSchedule(owner)).toBeNull());
    f.resources.set(owner.claimId, workspace[0]!); finishObservation.resolve(); await nextRound;
    await eventually(() => expect(f.tasks.stopAndClose).toHaveBeenCalledOnce());
  } finally { finishRemoval.resolve(); finishObservation.resolve(); await f.coordinator.shutdown(); }
});

it.each(["backend conflict", "recheck failure", "web enumeration failure"] as const)("handles a %s after Web cleanup before another project can claim", async variant => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const f = await fixture(3), webStore = openWebExecutionStore(createMemoryDatabase());
  const owner = { projectId: f.project.projectId, taskId: uuid(800), claimId: uuid(801), worktreeId: uuid(802) };
  const config = { ...configuration, args: [], agentControlMode: "web" as const }, worktree = f.bind(owner);
  const healthy: WorkerProject = { projectId: uuid(11), repoUrl: "https://example.test/healthy.git", localPath: path.join(f.root, "healthy") };
  f.store.registerProject(healthy); await mkdir(healthy.localPath, { recursive: true });
  f.options.repositories.push({ project: healthy, configuration: config });
  f.candidates.splice(0);
  f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
  const healthyOwner = { projectId: healthy.projectId, taskId: uuid(851), claimId: uuid(852), worktreeId: uuid(853) };
  if (variant !== "backend conflict") {
    f.grant(task(healthy.projectId, healthyOwner.taskId), { claimId: healthyOwner.claimId, worktreeId: healthyOwner.worktreeId, workerId, machine: f.options.machine, platform: "linux", agent: "codex", agentControlMode: "web" });
    f.store.activateTask(f.store.registerPending({ ...healthyOwner, agent: "codex", agentControlMode: "web" }));
    webStore.register({ ...healthyOwner, project: healthy, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
  }
  let record = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: config }, 1);
  record = webStore.bindWorktree(record, worktree, 2);
  record = webStore.beginCleanup(record, { kind: "terminal", deadline: 100 }, 3);
  f.worktrees.set(owner.claimId, { owner, binding: worktree }); f.manifests.set(owner.claimId, { owner, binding: worktree });
  const cleanupEntered = Promise.withResolvers<void>(), finishCleanup = Promise.withResolvers<void>();
  const scanEntered = Promise.withResolvers<void>(), finishScan = Promise.withResolvers<void>();
  const scan = f.git.scanWorktrees.bind(f.git); let holdScan = false;
  vi.spyOn(f.git, "scanWorktrees").mockImplementation(async (...args) => { const result = await scan(...args); if (holdScan) { scanEntered.resolve(); await finishScan.promise; } return result; });
  const cleanup = vi.fn(async (task: typeof record, request: import("../../../src/commands/worker/execution-stop.js").CleanupRequest) => {
    if (request.kind !== "terminal") throw new Error("unexpected shutdown");
    request.scope.onExecutionStopped({ attempt: request.scope.attempt, observation: { kind: "not-started", owner, observedAt: 1000 } });
    cleanupEntered.resolve(); await finishCleanup.promise; f.worktrees.delete(owner.claimId);
    return { task, complete: true };
  });
  const advance = vi.fn(async (value: typeof record) => value);
  const coordinator = createWorkerCoordinator({ ...f.options, webStore, webBackend: { observeExecutionStop: async () => ({ kind: "not-started", owner, observedAt: 1000 }), advance, cleanup }, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
  try {
    await coordinator.tick(); await cleanupEntered.promise;
    if (variant !== "backend conflict") await eventually(() => expect(advance).toHaveBeenCalled());
    f.candidates.push(task(healthy.projectId, uuid(850)));
    holdScan = true; const nextRound = coordinator.tick(); await scanEntered.promise;
    finishCleanup.resolve(); await eventually(() => expect(f.store.getCleanupSchedule(owner)).toBeNull());
    const pane = { session: "w", workspaceId: "conflict", paneId: "p", terminalId: "t" };
    if (variant === "backend conflict") f.resources.set(owner.claimId, { owner, workspaceId: pane.workspaceId, panes: [{ binding: pane, cwd: worktree.worktreePath, kind: "codex", status: "working", launchPending: false, interactiveReady: true, nativeSession: null, stateChangeSeq: 1, completionSeq: 0 }] });
    else if (variant === "recheck failure") f.tasks.listResources.mockRejectedValueOnce(new Error("recheck unavailable"));
    else vi.spyOn(webStore, "listUnfinishedTasks").mockImplementationOnce(() => { throw new Error("web enumeration unavailable"); });
    finishScan.resolve();
    await nextRound;
    expect(f.resources.has(owner.claimId)).toBe(variant === "backend conflict");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-error", identity: expect.objectContaining(owner), error: expect.objectContaining({ message: variant === "backend conflict" ? "The original claim has conflicting backend responsibilities." : variant === "recheck failure" ? "recheck unavailable" : "web enumeration unavailable" }) }));
    expect([...f.grants.values()].map(value => value.id)).toEqual(variant === "backend conflict" ? [uuid(850)] : [uuid(851)]);
    if (variant !== "backend conflict") {
      expect(f.store.getTask(healthyOwner)?.status).toBe("active");
      await eventually(() => expect(advance.mock.calls.length).toBeGreaterThanOrEqual(2));
    }
  } finally { finishCleanup.resolve(); finishScan.resolve(); await coordinator.shutdown(); webStore.close(); }
});

it("does not yield archive maintenance for a stopped reservation left in a stale snapshot", async () => {
  const f = await fixture(), monitoring = createMonitoringObserver({ now: f.options.now });
  const coordinator = createWorkerCoordinator({ ...f.options, monitoring });
  await coordinator.tick();
  await eventually(() => expect(f.store.listTasks()[0]?.sessionId).not.toBeNull());
  const original = f.store.listTasks()[0]!;
  f.grants.clear(); f.candidates.splice(0);
  const removeEntered = Promise.withResolvers<void>(), finishRemoval = Promise.withResolvers<void>();
  const observerEntered = Promise.withResolvers<void>(), finishObservation = Promise.withResolvers<void>();
  const remove = vi.mocked(f.git.removeWorktree).getMockImplementation()!;
  vi.mocked(f.git.removeWorktree).mockImplementation(async (project, owner, operation) => {
    removeEntered.resolve(); await finishRemoval.promise; operation.signal?.throwIfAborted(); return remove(project, owner, operation);
  });
  const observe = f.tasks.observeExecutionStop.getMockImplementation()!;
  let holdObservation = false;
  f.tasks.observeExecutionStop.mockImplementation(async target => {
    const result = await observe(target);
    if (holdObservation) { observerEntered.resolve(); await finishObservation.promise; }
    return result;
  });
  try {
    await coordinator.tick(); await removeEntered.promise;
    expect(coordinator.archiveYield()).toBe(true);
    holdObservation = true;
    const nextRound = coordinator.tick();
    await observerEntered.promise;
    finishRemoval.resolve();
    await eventually(() => expect(f.store.getCleanupSchedule(original)).toBeNull());
    finishObservation.resolve(); await nextRound;
    expect(monitoring.capture("1").reservations).toContainEqual(expect.objectContaining({ occupied: false, scope: expect.objectContaining({ claimId: original.claimId }) }));
    expect(coordinator.archiveYield()).toBe(false);
  } finally { finishRemoval.resolve(); finishObservation.resolve(); await coordinator.shutdown(); }
});

it("reconciles a failed Web removal after manual deletion in the same coordinator", async () => {
  const { openWebExecutionStore } = await import("../../../src/commands/worker/backends/web-store.js");
  const { createWebExecutionBackend } = await import("../../../src/commands/worker/backends/web.js");
  const f = await fixture(2), monitoring = createMonitoringObserver({ now: f.options.now });
  await mkdir(f.project.localPath, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", timeout: 10_000 });
  git(f.project.localPath, "init", "--initial-branch=main");
  git(f.project.localPath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture");
  git(f.project.localPath, "remote", "add", "origin", f.project.repoUrl);
  const bare = path.join(f.root, "origin.git");
  git(f.root, "clone", "--bare", f.project.localPath, bare);
  git(f.project.localPath, "config", `url.${bare}.insteadOf`, f.project.repoUrl);
  const failure = new Error("controlled Web directory removal failure"); let fail = true;
  const manager = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "temporary"), prepareFormat,
    removeDirectory: async (...args) => { if (fail) { fail = false; throw failure; } return rm(...args); },
  });
  const operation = createOperation();
  const owner = { projectId: f.project.projectId, taskId: uuid(100), claimId: uuid(700), worktreeId: uuid(702) };
  let binding: WorktreeBinding;
  try { await manager.prepareRepository(f.project, operation); binding = await manager.prepareWorktree(f.project, owner, operation); } finally { operation.dispose(); }
  await mkdir(path.join(binding.worktreePath, "content"));
  await writeFile(path.join(binding.worktreePath, "content", "file"), "data");
  const webStore = openWebExecutionStore(createMemoryDatabase());
  const webConfig = { ...configuration, args: [], agentControlMode: "web" as const };
  f.store.activateTask(f.store.registerPending({ ...owner, agent: "codex", agentControlMode: "web" }));
  let row = webStore.register({ ...owner, project: f.project, serverOrigin: origin, workerId, userId: uuid(2), configuration: webConfig }, 1);
  row = webStore.bindWorktree(row, binding, 2);
  row = webStore.initializeWebExecution(row, 3);
  row = webStore.updateWebExecution(row, { sessionId: uuid(703), initialPrompt: "managed", launchSubmission: "acknowledged" }, 4);
  const stopped = await stoppedWebExecution(f, webStore, row);
  webStore.beginCleanup(stopped.task, { kind: "terminal", deadline: 100 }, 8);
  let archiveReady = false;
  const archive = vi.fn(async (task: WebTask) => { expect(task.webExecution?.sessionId).toBe(uuid(703)); if (!archiveReady) throw new Error("controlled archive receipt unavailable"); });
  // This integration owns cleanup and scheduling, with the original controller stop controlled at its backend boundary.
  const jobLeases = { enabled: false, retain: async () => undefined, get: async () => undefined, release: async () => {}, close: async () => {} };
  const backendOptions = { homeDirectory: f.root, store: webStore, git: manager, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "linux" as const, buildPrompt: () => "managed", emit: () => {}, now: f.options.now, request: stopped.request, archive, jobLeases };
  const backend = createWebExecutionBackend(backendOptions);
  const [originalCandidate, healthyCandidate] = f.candidates.splice(0); f.grants.clear();
  const coordinator = createWorkerCoordinator({ ...f.options, git: manager, webStore, webBackend: backend, monitoring, verifyWebServer: async () => {}, verifyWebUnregistered: async () => {} });
  try {
    await coordinator.tick();
    await eventually(() => expect(f.store.getCleanupSchedule(owner)).toMatchObject({ failures: 1, stage: "archive" }));
    expect(archive).toHaveBeenCalledOnce();
    expect(worktreePaths(f.project.localPath)).toContain(path.normalize(binding.worktreePath));
    archiveReady = true; f.clock(10_000); await coordinator.tick();
    await eventually(() => expect(f.store.getCleanupSchedule(owner)).toMatchObject({ failures: 2, stage: "worktree-removal" }));
    expect(archive).toHaveBeenCalledTimes(2);
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "cleanup-error" }));
    expect(monitoring.capture("1").currentFailures).toEqual(expect.arrayContaining([expect.objectContaining({ scope: expect.objectContaining({ claimId: owner.claimId }) })]));
    expect(webStore.getTask(owner)?.status).toBe("active");
    expect(worktreePaths(f.project.localPath)).toContain(path.normalize(binding.worktreePath));
    f.candidates.push(healthyCandidate!); await coordinator.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledOnce());
    await rm(binding.worktreePath, { recursive: true, force: true });
    expect(worktreePaths(f.project.localPath)).toContain(path.normalize(binding.worktreePath));
    f.clock(1_000_000); await coordinator.tick();
    await eventually(() => expect(webStore.getTask(owner)?.status).toBe("done"));
    await eventually(() => expect(f.store.getTask(owner)?.status).toBe("done"));
    await eventually(() => expect(f.store.getCleanupSchedule(owner)).toBeNull());
    expect(archive).toHaveBeenCalledTimes(3);
    expect(monitoring.capture("2").lastRecovery?.scope).toMatchObject({ claimId: owner.claimId });
    await coordinator.tick();
    await eventually(() => expect(createWorktreeManifestStore(path.join(f.project.localPath, ".git")).read(owner.worktreeId)).toBeNull());
    expect(worktreePaths(f.project.localPath)).not.toContain(path.normalize(binding.worktreePath));
    f.candidates.push(originalCandidate!);
    await coordinator.tick();
    await eventually(() => expect(f.tasks.start).toHaveBeenCalledTimes(2));
    const successor = f.store.listTasks().find(entry => entry.taskId === owner.taskId && entry.claimId !== owner.claimId)!;
    const successorOwner = f.resources.get(successor.claimId)!.owner;
    expect(successor.status).toBe("active");
    expect(successorOwner.worktreeId).not.toBe(owner.worktreeId);
    expect(f.bind(successorOwner).worktreePath).not.toBe(binding.worktreePath);
    await expect(access(f.bind(successorOwner).worktreePath)).resolves.toBeUndefined();
  } finally { await coordinator.shutdown(); await manager.dispose(); webStore.close(); }
}, 30_000);
