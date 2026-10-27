import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionDriver } from "../../../src/commands/worker/execution.js";
import type { WorkerGitManager } from "../../../src/commands/worker/execution.js";
import { herdrExecutionLabel } from "../../../src/commands/worker/herdr/agents.js";
import { buildHerdrAgentArguments } from "../../../src/commands/worker/herdr/arguments.js";
import type { HerdrAgentObservation, HerdrExecutionContext, HerdrOwnedWorkspace, HerdrTaskBinding, HerdrWorkspaceEvidence, WorkerHerdrAdapter } from "../../../src/commands/worker/herdr.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { WorkerStore } from "../../../src/commands/worker/store.js";
import type { FrozenExecutionConfiguration } from "../../../src/commands/worker/types.js";

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const claim = { serverOrigin: "https://daynight.example", projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), workerId: uuid(4), worktreeId: uuid(5) };
const configuration: FrozenExecutionConfiguration = { agent: "codex", model: "frozen-model", args: ["--search"], recoveryLimit: 2 };
const stores = new Set<WorkerStore>();
const roots: string[] = [];
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const fixture = (nativeSessionId: string | null) => {
  const parent = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-shutdown-history-tests");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "r-")); roots.push(root);
  const file = path.join(root, "state.sqlite");
  let store = openWorkerStore(file); stores.add(store);
  const repositoryPath = path.join(root, "repo");
  store.registerProject({ serverOrigin: claim.serverOrigin, projectId: claim.projectId, repoUrl: "https://example.test/org/repo.git", localPath: repositoryPath });
  store.registerPending(claim, { kind: "new", configuration }, 10); store.activateTask(claim, 20);
  const worktree = { repositoryPath, commonDirectory: path.join(repositoryPath, ".git"), worktreePath: path.join(repositoryPath, ".worktrees", "daynight", claim.taskId), branch: `daynight/${claim.taskId}` };
  store.bindWorktree(claim, worktree, 21);
  const resources: HerdrOwnedWorkspace[] = [];
  let sequence = 0;
  const context: HerdrExecutionContext = { ...claim, cwd: worktree.worktreePath, agent: "codex" };
  const prepare = () => {
    sequence += 1;
    const binding: HerdrTaskBinding = { session: "w", workspaceId: `ws${sequence}`, paneId: `p${sequence}`, terminalId: `t${sequence}` };
    const workspaceEvidence: HerdrWorkspaceEvidence = { binding, ownerLabel: herdrExecutionLabel(context), environment: { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" } };
    resources.push({ owner: { serverOrigin: claim.serverOrigin, projectId: claim.projectId, taskId: claim.taskId, claimId: claim.claimId, worktreeId: claim.worktreeId }, workspaceId: binding.workspaceId,
      panes: [{ binding, cwd: context.cwd, kind: null, status: "idle", launchPending: false, interactiveReady: false, nativeSession: null, stateChangeSeq: null, completionSeq: null }] });
    return { binding, workspaceEvidence };
  };
  const initial = prepare(); store.bindHerdrExecution(claim, initial.binding, initial.workspaceEvidence, 22);
  const observation = (binding: HerdrTaskBinding): HerdrAgentObservation => {
    const pane = resources.flatMap((resource) => resource.panes).find((candidate) => candidate.binding.paneId === binding.paneId)!;
    return { ...pane, name: pane.kind === null ? null : "fixture" };
  };
  const tasks = {
    prepareWorkspace: vi.fn(async () => prepare()),
    observe: vi.fn(async (_context: HerdrExecutionContext, binding: HerdrTaskBinding) => observation(binding)),
    start: vi.fn(async (execution: HerdrExecutionContext, binding: HerdrTaskBinding, input: { configuration: FrozenExecutionConfiguration; workspaceEvidence?: HerdrWorkspaceEvidence | null; resumeSessionId?: string }) => {
      const pane = resources.flatMap((resource) => resource.panes).find((candidate) => candidate.binding.paneId === binding.paneId)!;
      const sessionId = input.resumeSessionId === undefined ? nativeSessionId : input.resumeSessionId;
      pane.kind = execution.agent; pane.status = "blocked"; pane.interactiveReady = true;
      pane.nativeSession = sessionId === null ? null : { source: "herdr:codex", agent: "codex", sessionId };
      return { kind: "waiting" as const, observation: observation(binding), promptSubmission: "submitted" as const,
        launchEvidence: { binding, ownerLabel: herdrExecutionLabel(execution), agent: execution.agent, argv: [execution.agent, ...buildHerdrAgentArguments(input.configuration, input.resumeSessionId)], referenceBaseline: "empty" as const, workspaceEvidence: input.workspaceEvidence! } };
    }),
    captureStop: vi.fn(async (_context: HerdrExecutionContext, binding: HerdrTaskBinding) => ({ binding, ownerLabel: herdrExecutionLabel(context), agent: "codex" as const, nativeSessionId: observation(binding).nativeSession?.sessionId ?? null, shellPid: 100, processIds: [101], nativeProcessIds: [101], observedAt: 1000 })),
    confirmMissingWorkspaceStopped: vi.fn(async () => ({ agentStopped: true as const })),
    closeWorkspace: vi.fn(async () => ({ workspaceClosed: true as const })),
  };
  const git = { prepareWorktree: vi.fn(async () => worktree), findWorktree: vi.fn(async () => worktree), verifyWorktree: vi.fn(async () => worktree) };
  const buildPrompt = vi.fn(() => "worker-managed using-daynight execute-task-in-managed");
  const driver = () => createExecutionDriver({ store, git: git as unknown as WorkerGitManager, herdr: { tasks } as unknown as WorkerHerdrAdapter, platform: "linux", buildPrompt, emit: vi.fn(), now: () => 1000 });
  const shutdown = () => {
    store.beginCleanup(claim, { kind: "shutdown", deadline: 601000 }, 1000);
    store.recordCleanupInputOutcome(claim, "unavailable", 1001);
    store.recordCleanupResult(claim, "unavailable", null, 1002);
    store.confirmAgentStopped(claim, { agentStopped: true }, 1003);
    store.confirmWorkspaceClosed(claim, { workspaceClosed: true }, 1004);
    resources.splice(0);
    store.close(); stores.delete(store); store = openWorkerStore(file); stores.add(store);
    return store.resumeAfterShutdown(claim, 1100);
  };
  return { get store() { return store; }, resources, tasks, git, driver, shutdown, buildPrompt };
};

describe("shutdown preserves original native history", () => {
  it("never creates replacement resources or a new conversation after submitted/blocked startup without its original native ID", async () => {
    const f = fixture(null);
    const started = await f.driver().advance(f.store.getTask(claim)!, f.resources);
    expect(started).toMatchObject({ resources: { nativeSession: null }, nativeExecution: { launchSubmission: "acknowledged", promptSubmission: "submitted" } });
    expect(f.resources[0]!.panes[0]!.status).toBe("blocked");
    const original = started.nativeExecution;
    const restarted = f.shutdown(); vi.clearAllMocks();
    expect(restarted.nativeExecution).toEqual(original);
    await expect(f.driver().advance(restarted, f.resources)).rejects.toThrow("original native session ID is missing");
    f.store.authorizeRecoveryRetry(claim, 1200);
    await expect(f.driver().advance(f.store.getTask(claim)!, f.resources)).rejects.toThrow("original native session ID is missing");
    expect(f.git.prepareWorktree).not.toHaveBeenCalled(); expect(f.git.verifyWorktree).not.toHaveBeenCalled();
    expect(f.tasks.prepareWorkspace).not.toHaveBeenCalled(); expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.buildPrompt).not.toHaveBeenCalled();
    expect(f.store.getTask(claim)?.nativeExecution).toEqual(original);
  });

  it("reconnects a still-live original agent while waiting for its native ID without replaying input", async () => {
    const f = fixture(null); await f.driver().advance(f.store.getTask(claim)!, f.resources); vi.clearAllMocks();
    const observed = await f.driver().advance(f.store.getTask(claim)!, f.resources);
    expect(observed.resources.nativeSession).toBeNull(); expect(observed.nativeExecution?.promptSubmission).toBe("submitted");
    expect(f.tasks.observe).toHaveBeenCalledOnce(); expect(f.tasks.start).not.toHaveBeenCalled(); expect(f.tasks.prepareWorkspace).not.toHaveBeenCalled();
  });

  it("starts new Herdr resources with the exact known original native ID", async () => {
    const nativeId = uuid(90); const f = fixture(nativeId);
    await f.driver().advance(f.store.getTask(claim)!, f.resources);
    const restarted = f.shutdown(); vi.clearAllMocks();
    await f.driver().advance(restarted, f.resources);
    expect(f.tasks.prepareWorkspace).toHaveBeenCalledOnce(); expect(f.tasks.start).toHaveBeenCalledOnce();
    expect(f.tasks.start.mock.calls[0]![2].resumeSessionId).toBe(nativeId);
    expect(f.store.getTask(claim)?.resources.nativeSession?.sessionId).toBe(nativeId);
  });

  it("allows explicit retry only after the exact missing original history identity has been recovered", async () => {
    const nativeId = uuid(91); const f = fixture(null);
    await f.driver().advance(f.store.getTask(claim)!, f.resources); f.shutdown();
    f.store.bindNativeSession(claim, { source: "native-history", sessionId: nativeId }, 1200);
    f.store.authorizeRecoveryRetry(claim, 1201); vi.clearAllMocks();
    await f.driver().advance(f.store.getTask(claim)!, f.resources);
    expect(f.tasks.confirmMissingWorkspaceStopped).toHaveBeenCalledOnce();
    expect(f.tasks.start).toHaveBeenCalledOnce(); expect(f.tasks.start.mock.calls[0]![2].resumeSessionId).toBe(nativeId);
    expect(f.store.getTask(claim)).toMatchObject({ claimId: claim.claimId, resources: { nativeSession: { sessionId: nativeId } }, recovery: { pauseReason: null } });
  });

  it("keeps the first launch available when shutdown proves that no native launch was ever submitted", async () => {
    const f = fixture(null); const restarted = f.shutdown();
    expect(restarted.nativeExecution?.launchSubmission).toBe("never-submitted");
    await f.driver().advance(restarted, f.resources);
    expect(f.tasks.prepareWorkspace).toHaveBeenCalledOnce(); expect(f.tasks.start).toHaveBeenCalledOnce();
    expect(f.tasks.start.mock.calls[0]![2].resumeSessionId).toBeUndefined();
  });
});
