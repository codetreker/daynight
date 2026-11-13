import { createMemoryDatabase } from "../../helpers/sqlite.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { JsonValue, Task } from "../../../src/api/types.js";
import { readWorkerClaim } from "../../../src/api/task-properties.js";
import { createExecutionDriver, settleWorkerStops } from "../../../src/commands/worker/execution.js";
import { appendWorkerPrompts, workerPingPrompt } from "../../../src/commands/worker/prompts.js";
import type { ExecutionDependencies, ExecutionInput, WorkerEvent, WorkerGitManager } from "../../../src/commands/worker/execution.js";
import { createHerdrAgentManager, HerdrInputBlockedError, herdrExecutionAgentName, herdrExecutionLabel } from "../../../src/commands/worker/herdr/agents.js";
import { codexProjectTrustArguments } from "../../../src/commands/worker/herdr/arguments.js";
import { HerdrAgentActionError } from "../../../src/commands/worker/herdr.js";
import type { HerdrExecutionContext, WorkerHerdrAdapter } from "../../../src/commands/worker/herdr.js";
import type { HerdrRpcClient, HerdrRpcResult } from "../../../src/commands/worker/herdr/rpc.js";
import { HerdrRpcError } from "../../../src/commands/worker/herdr/rpc.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { createWorkerGitManager } from "../../../src/commands/worker/worktrees.js";
import { migrateLegacyWorktrees } from "../../../src/commands/worker/worktrees/migration.js";
import type { ExecutionConfiguration, ResourceOwner, WorkerProject, WorktreeBinding } from "../../../src/commands/worker/types.js";
import { nativeMenuScreens } from "../../fixtures/native-menu-screens.js";
import { frozenToolLaunch } from "../../helpers/tool-launch.js";
import type { HerdrToolLaunchMapping } from "../../../src/commands/worker/herdr/tool-launch.js";

const uuid = (value: number): string => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const staleId = uuid(8);
const savedId = uuid(9);
const freshId = uuid(10);
type Entry = Record<string, unknown>;
const roots: string[] = [];
const stores: ReturnType<typeof openWorkerStore>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const fixture = async (agent: "codex" | "copilot", sessionId: string | null, managerOptions: Partial<Parameters<typeof createHerdrAgentManager>[0]> = {}) => {
  const base = path.resolve("../../.tmp/execution-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "r-")); roots.push(root);
  const project: WorkerProject = { projectId: uuid(1), repoUrl: "https://example.test/owner/repo", localPath: path.join(root, "repo") };
  const owner: ResourceOwner = { projectId: project.projectId, taskId: uuid(2), claimId: uuid(3), worktreeId: uuid(4) };
  const cwd = path.join(project.localPath, ".worktrees", "daynight", owner.taskId); await mkdir(cwd, { recursive: true });
  const worktree: WorktreeBinding = { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: cwd, branch: `daynight/${owner.taskId}` };
  const configuration: ExecutionConfiguration = { agent, model: "current-model", args: [], recoveryLimit: 2 };
  const store = openWorkerStore(createMemoryDatabase()); stores.push(store); store.registerProject(project);
  store.registerPending({ ...owner, agent, sessionId }); const task = store.activateTask(owner);
  const context: HerdrExecutionContext = { ...owner, cwd, agent };
  const nativeEnvironment = { XDG_CONFIG_HOME: "/native/config", XDG_STATE_HOME: "/native/state" };
  const workerEnvironment = { XDG_CONFIG_HOME: "/worker/private/config", XDG_STATE_HOME: "/worker/private/state", COPILOT_ALLOW_ALL: "false", COPILOT_ASSISTED_APPROVAL: "true" };
  const expectedNativeEnvironment = { ...workerEnvironment, ...nativeEnvironment, ...(agent === "copilot" ? { COPILOT_ALLOW_ALL: "true", COPILOT_ASSISTED_APPROVAL: "false" } : {}) };
  const binding = { session: "w", workspaceId: "restored-workspace", paneId: "restored-pane", terminalId: "restored-terminal" };
  const workspaces: Entry[] = [{ workspace_id: binding.workspaceId, label: herdrExecutionLabel(context, "Task execution") }];
  const panes: Entry[] = [{ workspace_id: binding.workspaceId, pane_id: binding.paneId, terminal_id: binding.terminalId, tab_id: "restored-tab", cwd, agent_status: "unknown", agent_session: { source: `herdr:${agent}`, agent, kind: "id", value: staleId } }];
  const agents: Entry[] = [];
  const environments = new Map<string, Entry>([[binding.paneId, workerEnvironment]]);
  const calls: { method: string; params: Entry }[] = [];
  const screen = { text: "› Ask Codex to do anything\n\n  GPT-6.1 Terra medium · daynight/task · Context 0% used" };
  const launches: { environment: Entry; args: readonly string[]; paneId: string }[] = [];
  let sequence = 0;
  const executing = new Set<number>();
  let closeFailure: Error | undefined;
  let launchReference: string | undefined;
  let blockedLaunch = false;
  let firstTurnCompletion: "idle" | "done" | undefined;
  let hook: { paneId: string; sessionId: string; remaining: number } | undefined;
  let holdSessionDiscovery = false;
  let heldSessionSnapshots = 0;
  const rpc: HerdrRpcClient = { request: async (method, params, operation): Promise<HerdrRpcResult> => {
    operation.check(); calls.push({ method, params: structuredClone(params) });
    if (method === "session.snapshot") {
      if (hook !== undefined && holdSessionDiscovery) heldSessionSnapshots++;
      if (hook !== undefined && !holdSessionDiscovery && hook.remaining-- === 0) {
        agents.find((entry) => entry.pane_id === hook!.paneId)!.agent_session = { source: `herdr:${agent}`, agent, kind: "id", value: hook.sessionId };
        hook = undefined;
      }
      return { type: "session_snapshot", snapshot: structuredClone({ workspaces, panes, agents, tabs: [] }) };
    }
    if (method === "workspace.create") {
      sequence++; const workspace = { workspace_id: `new-workspace-${sequence}`, label: params.label };
      const pane = { workspace_id: workspace.workspace_id, pane_id: `new-pane-${sequence}`, terminal_id: `new-terminal-${sequence}`, tab_id: `new-tab-${sequence}`, cwd: params.cwd, agent_status: "unknown" };
      workspaces.push(workspace); panes.push(pane); environments.set(pane.pane_id, structuredClone({ ...workerEnvironment, ...params.env as Entry }));
      return { type: "workspace_created", workspace, root_pane: pane };
    }
    if (method === "workspace.close") {
      for (let index = workspaces.length - 1; index >= 0; index--) if (workspaces[index]!.workspace_id === params.workspace_id) workspaces.splice(index, 1);
      for (const collection of [panes, agents]) for (let index = collection.length - 1; index >= 0; index--) if (collection[index]!.workspace_id === params.workspace_id) collection.splice(index, 1);
      if (closeFailure !== undefined) { const failure = closeFailure; closeFailure = undefined; throw failure; }
      return { type: "ok" };
    }
    if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: params.pane_id, shell_pid: 100, foreground_processes: [{ pid: 100 }] } };
    if (method === "agent.read") return { type: "pane_read", read: { pane_id: params.target, workspace_id: panes.find(value => value.pane_id === params.target)!.workspace_id, source: "visible", format: "text", text: screen.text, truncated: false } };
    if (method === "agent.start") {
      const pane = panes.find((entry) => entry.pane_id === params.pane_id)!;
      const current: Entry = { ...pane, agent, name: params.name, agent_status: blockedLaunch ? "blocked" : "idle", interactive_ready: true, launch_pending: false, state_change_seq: 1, completion_seq: 0 };
      if (launchReference !== undefined) current.agent_session = { source: `herdr:${agent}`, agent, kind: "id", value: launchReference };
      agents.push(current); launches.push({ environment: environments.get(String(params.pane_id))!, args: params.args as string[], paneId: String(params.pane_id) });
      return { type: "agent_started", agent: current, argv: [agent, ...params.args as string[]] };
    }
    if (method === "agent.prompt") {
      const current = agents.find((entry) => entry.pane_id === params.target)!;
      if (firstTurnCompletion !== undefined) {
        current.agent_status = firstTurnCompletion; current.state_change_seq = 3; current.completion_seq = 1;
        firstTurnCompletion = undefined;
      }
      const launch = launches.find((entry) => entry.paneId === params.target);
      if (launch !== undefined) {
        const { args } = launch;
        const resume = agent === "codex" ? args[0] === "--no-daemon" && args[1] === "resume" ? args[2] : undefined : args.find((entry) => entry.startsWith("--resume="))?.slice("--resume=".length);
        hook = { paneId: String(params.target), sessionId: resume === undefined ? freshId : resume, remaining: 2 };
      }
      return { type: "agent_prompted", agent: current };
    }
    throw new Error(`Unexpected RPC ${method}`);
  } };
  const manager = createHerdrAgentManager({ rpc, session: "w", preflight: { verifyStart: vi.fn(async () => {}) }, workspaceEnvironment: nativeEnvironment, processExecuting: async (pid) => executing.has(pid), pollIntervalMs: 1, ...managerOptions });
  const events: WorkerEvent[] = [];
  const git = { resolveWorktreeBinding: vi.fn(async () => worktree), prepareWorktree: vi.fn(async () => worktree), verifyWorktree: vi.fn(async () => worktree) } as unknown as WorkerGitManager;
  const remoteTask: Omit<Task, "properties"> & { properties: Record<string, JsonValue> } = { type: "task", parentId: null,
    projectId: owner.projectId, id: owner.taskId, title: "Task execution", description: "task", tags: [], status: "in_progress", allowAgents: true, assignedTo: null, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null,
    version: 1n, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false,
    properties: { worker: { claimId: owner.claimId, state: "active", userId: uuid(6), workerId: uuid(5), machine: { id: uuid(7), name: "fixture" }, platform: "linux", agent, agentControlMode: "herdr", worktreeId: owner.worktreeId, phase: "executing", herdr: null, nativeSessionId: sessionId, claimedAt: "2026-10-27T00:00:00Z" } },
  };
  const readTask = vi.fn(async () => remoteTask);
  const dependencies: ExecutionDependencies = { store, git, herdr: { tasks: manager } as unknown as WorkerHerdrAdapter, readTask, platform: "linux", serverOrigin: "https://daynight.example", workerId: uuid(5), buildPrompt: vi.fn(() => "managed assignment"), emit: (event) => events.push(event), now: Date.now };
  const input: ExecutionInput = { task, project, owner, title: "Task execution", configuration };
  const resources = async () => { const operation = createOperation(); try { return await manager.listResources(operation); } finally { operation.dispose(); } };
  return { holdSessionDiscovery: () => { holdSessionDiscovery = true; }, releaseSessionDiscovery: () => { holdSessionDiscovery = false; }, heldSessionSnapshots: () => heldSessionSnapshots, root, store, input, context, manager, rpc, resources, events, calls, screen, launches, nativeEnvironment, expectedNativeEnvironment, workerEnvironment, workspaces, panes, agents, binding, dependencies, readTask, remoteTask, executing, failNextClose: (failure: Error) => { closeFailure = failure; }, reportOnLaunch: (id: string) => { launchReference = id; }, blockOnLaunch: () => { blockedLaunch = true; }, finishFirstTurnBeforeDiscovery: (status: "idle" | "done") => { firstTurnCompletion = status; }, driver: createExecutionDriver(dependencies) };
};

describe("execution from current Herdr resources", () => {
  it.each(["confirmed", "deadline"] as const)("keeps a mapped shared deferred first input closed until official Session confirmation: %s", async outcome => {
    let mapping: HerdrToolLaunchMapping;
    const f = await fixture("codex", null, { toolMapping: async () => mapping });
    const launch = frozenToolLaunch("codex", "herdr"), nonce = uuid(20), manifestPath = path.join(f.root, "manifest.json");
    f.input.configuration.toolLaunch = launch;
    const receipt = { schemaVersion: 1 as const, owner: f.input.owner, nonce, selectionKey: launch.selectionKey, logicalArgvDigest: "a".repeat(64), file: launch.command.file, prefixArgs: [], helperPid: 101, childPid: 102 };
    mapping = { manifestPath, nonce, selectionKey: launch.selectionKey, environment: { DAYNIGHT_HERDR_TOOL_MANIFEST: manifestPath }, verifyReady: async () => {}, verifyReceipt: async () => receipt, readReceipt: async () => receipt, captureProcesses: async pids => [...pids], verifyProcesses: async () => {}, confirmStopped: async () => true, stopProcesses: async () => {}, releaseFrozen: async () => {}, retire: async () => {} };
    f.workspaces.splice(0); f.panes.splice(0);
    const readyScreen = f.screen.text; f.screen.text = nativeMenuScreens[0]!.screen;
    await f.driver.advance(f.input);
    expect(f.agents[0]).not.toHaveProperty("agent_session");
    expect(f.calls.filter(call => call.method === "agent.prompt")).toHaveLength(0);
    expect(f.store.getTask(f.input.task)?.sessionId).toBeNull();
    f.screen.text = readyScreen;
    const operation = createOperation();
    try { await expect(f.manager.submitPrompt(f.context, { session: "w", workspaceId: String(f.agents[0]!.workspace_id), paneId: String(f.agents[0]!.pane_id), terminalId: String(f.agents[0]!.terminal_id) }, "ordinary continuation must remain closed", operation)).rejects.toMatchObject({ promptSubmission: "not-submitted" }); }
    finally { operation.dispose(); }
    f.holdSessionDiscovery();
    if (outcome === "deadline") {
      const submit = f.manager.submitInitialPrompt.bind(f.manager);
      vi.spyOn(f.manager, "submitInitialPrompt").mockImplementationOnce(async (context, binding, prompt, _operation, guard, completed) => {
        const deadline = createOperation({ limits: { totalMs: 100 } });
        try { return await submit(context, binding, prompt, deadline, guard, completed); }
        finally { deadline.dispose(); }
      });
    }
    let completed = false;
    const advance = f.driver.advance(f.input).finally(() => { completed = true; });
    const expected = outcome === "deadline" ? expect(advance).rejects.toMatchObject({ promptSubmission: "submitted", submission: "unknown" }) : undefined;
    await vi.waitFor(() => expect(f.heldSessionSnapshots()).toBeGreaterThanOrEqual(3));
    expect(completed).toBe(false);
    expect(f.store.getTask(f.input.task)?.sessionId).toBeNull();
    expect(f.events.filter(event => event.kind === "started" || event.kind === "reconnected")).toHaveLength(0);
    if (expected !== undefined) await expected;
    f.releaseSessionDiscovery();
    if (outcome === "confirmed") await expect(advance).resolves.toMatchObject({ kind: "observed" });
    await f.driver.advance(f.input); await f.driver.advance(f.input);
    expect(f.calls.filter(call => call.method === "agent.prompt").map(call => call.params.text)).toEqual(["managed assignment"]);
    expect(f.calls.filter(call => call.method === "agent.start")).toHaveLength(1);
    expect(f.store.getTask(f.input.task)?.sessionId).toBe(freshId);
  });

  it("reports native progress only when its observed state changes", async () => {
    const f = await fixture("codex", staleId);
    const current: Entry = { ...f.panes[0], agent: "codex", name: herdrExecutionAgentName(f.context), agent_status: "working", interactive_ready: true, launch_pending: false, state_change_seq: 10, completion_seq: 3 };
    f.agents.push(current);
    const observe = vi.fn(), success = vi.fn();
    f.dependencies.observePhase = observe; f.dependencies.observeSuccess = success;
    await f.driver.advance(f.input);
    expect(observe).toHaveBeenCalledWith(f.input.owner, { kind: "execution", phase: "agent-observation" }, true, undefined);
    expect(success).toHaveBeenCalledWith(f.input.owner, { kind: "execution", phase: "observation" });
    expect(success).toHaveBeenCalledWith(f.input.owner, { kind: "execution", phase: "worktree-preparation" });
    expect(success).toHaveBeenCalledWith(f.input.owner, { kind: "execution", phase: "agent-observation" });
    observe.mockClear(); success.mockClear();
    await f.driver.advance(f.input);
    expect(success).toHaveBeenCalledWith(f.input.owner, { kind: "execution", phase: "agent-observation" });
    expect(success).toHaveBeenCalledWith(f.input.owner, { kind: "execution", phase: "worktree-preparation" });
    expect(observe).not.toHaveBeenCalledWith(f.input.owner, { kind: "execution", phase: "agent-observation" }, true, undefined);
    expect(observe).not.toHaveBeenCalledWith(f.input.owner, { kind: "execution", phase: "worktree-preparation" }, true, undefined);
    current.state_change_seq = 11;
    await f.driver.advance(f.input);
    expect(observe).toHaveBeenCalledWith(f.input.owner, { kind: "execution", phase: "agent-observation" }, true, undefined);
  });

  it("records successful start and input submission without allowing callback failure to change execution", async () => {
    const f = await fixture("codex", null);
    const phases: string[] = [];
    f.dependencies.observeSuccess = (_identity, phase) => { phases.push(phase.phase); throw new Error("monitoring callback"); };
    expect((await f.driver.advance(f.input)).kind).toBe("observed");
    expect(phases).toEqual(expect.arrayContaining(["observation", "worktree-preparation", "agent-start", "input-submission"]));
  });

  it("labels an observation failure after confirmed input and recovers at the same operation", async () => {
    const f = await fixture("copilot", staleId);
    f.agents.push({ ...f.panes[0], agent: "copilot", name: herdrExecutionAgentName(f.context), agent_status: "idle", interactive_ready: true, launch_pending: false, state_change_seq: 10, completion_seq: 3 });
    const observePhase = vi.fn(), observeSuccess = vi.fn();
    f.dependencies.observePhase = observePhase; f.dependencies.observeSuccess = observeSuccess;
    const originalObserve = f.manager.observe.bind(f.manager);
    const failure = new Error("post-submission observation failed");
    vi.spyOn(f.manager, "observe").mockImplementationOnce(originalObserve).mockRejectedValueOnce(failure);
    await expect(f.driver.advance(f.input)).rejects.toBe(failure);
    expect(f.calls.filter(call => call.method === "agent.prompt")).toHaveLength(1);
    expect(observeSuccess).toHaveBeenCalledWith(expect.objectContaining({ claimId: f.input.owner.claimId }), { kind: "execution", phase: "input-submission" });
    expect(observePhase).toHaveBeenLastCalledWith(expect.objectContaining({ claimId: f.input.owner.claimId }), { kind: "execution", phase: "agent-observation" }, false, undefined);
    observeSuccess.mockClear();
    await f.driver.advance(f.input);
    expect(observeSuccess).toHaveBeenCalledWith(f.input.owner, { kind: "execution", phase: "agent-observation" });
    expect(f.calls.filter(call => call.method === "agent.prompt")).toHaveLength(1);
  });

  it("labels a failed fallback observation after startup input waits and reconnects without restarting", async () => {
    const f = await fixture("copilot", savedId);
    f.blockOnLaunch();
    const observePhase = vi.fn(), observeSuccess = vi.fn();
    f.dependencies.observePhase = observePhase; f.dependencies.observeSuccess = observeSuccess;
    const failure = new Error("fallback observation failed");
    vi.spyOn(f.manager, "observe").mockRejectedValueOnce(failure);
    await expect(f.driver.advance(f.input)).rejects.toBe(failure);
    expect(f.calls.filter(call => call.method === "agent.start")).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "agent.prompt")).toHaveLength(0);
    expect(observePhase).toHaveBeenLastCalledWith(f.input.owner, { kind: "execution", phase: "agent-observation" }, false, undefined);
    observeSuccess.mockClear();
    const result = await f.driver.advance(f.input);
    expect(result.observation?.status).toBe("blocked");
    expect(observeSuccess).toHaveBeenCalledWith(f.input.owner, { kind: "execution", phase: "agent-observation" });
    expect(f.calls.filter(call => call.method === "agent.start")).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "agent.prompt")).toHaveLength(0);
  });

  it("tracks cold resource stop separately from the ordinary observation", async () => {
    const f = await fixture("copilot", savedId);
    const phases = vi.fn(), successes = vi.fn();
    f.dependencies.observePhase = phases; f.dependencies.observeSuccess = successes;
    const failure = new Error("original workspace stop failed");
    vi.spyOn(f.manager, "stopAndClose").mockRejectedValueOnce(failure);
    await expect(f.driver.advance(f.input)).rejects.toBe(failure);
    expect(successes).toHaveBeenCalledWith(f.input.owner, { kind: "execution", phase: "observation" });
    expect(successes).not.toHaveBeenCalledWith(f.input.owner, { kind: "execution", phase: "observation" }, "resource-stop");
    expect(phases).toHaveBeenLastCalledWith(f.input.owner, { kind: "execution", phase: "observation" }, false, undefined, "resource-stop");
    await f.driver.advance(f.input);
    expect(successes).toHaveBeenCalledWith(f.input.owner, { kind: "execution", phase: "observation" }, "resource-stop");
  });

  it("labels an unconfirmed startup input without resending the assignment", async () => {
    const f = await fixture("copilot", savedId);
    const phases = vi.fn(); f.dependencies.observePhase = phases;
    const original = f.rpc.request;
    let rejectReceipt = true;
    vi.spyOn(f.rpc, "request").mockImplementation(async (method, params, operation) => {
      const result = await original(method, params, operation);
      if (method === "agent.prompt" && rejectReceipt) { rejectReceipt = false; throw new Error("receipt lost"); }
      return result;
    });
    await expect(f.driver.advance(f.input)).rejects.toMatchObject({ action: "agent.prompt", promptSubmission: "unknown" });
    expect(phases).toHaveBeenLastCalledWith(f.input.owner, { kind: "execution", phase: "input-submission" }, false, undefined, "startup-input");
    const attempts = f.calls.filter(call => call.method === "agent.prompt").length;
    f.agents[0]!.agent_status = "working";
    await f.driver.advance(f.input);
    expect(f.calls.filter(call => call.method === "agent.prompt")).toHaveLength(attempts);
  });

  it("separates prompt source failures from successful agent observations", async () => {
    const f = await fixture("copilot", staleId);
    f.agents.push({ ...f.panes[0], agent: "copilot", name: herdrExecutionAgentName(f.context), agent_status: "idle", interactive_ready: true, launch_pending: false, state_change_seq: 10, completion_seq: 3 });
    const phases = vi.fn(), successes = vi.fn(); f.dependencies.observePhase = phases; f.dependencies.observeSuccess = successes;
    const failure = new Error("prompt source unavailable");
    f.dependencies.preparePromptSource = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    await expect(f.driver.advance(f.input)).rejects.toBe(failure);
    expect(phases).toHaveBeenLastCalledWith(expect.objectContaining({ claimId: f.input.owner.claimId }), { kind: "execution", phase: "preparing" }, false, undefined, "prompt-source");
    expect(successes).not.toHaveBeenCalledWith(expect.anything(), { kind: "execution", phase: "preparing" }, "prompt-source");
    await f.driver.advance(f.input);
    expect(successes).toHaveBeenCalledWith(expect.objectContaining({ claimId: f.input.owner.claimId }), { kind: "execution", phase: "preparing" }, "prompt-source");
  });

  it("preserves the original execution failure when monitoring throws", async () => {
    const f = await fixture("codex", null);
    const failure = new Error("original worktree failure");
    f.dependencies.observePhase = () => { throw new Error("monitoring failure"); };
    f.dependencies.observeSuccess = () => { throw new Error("monitoring failure"); };
    vi.mocked(f.dependencies.git.prepareWorktree).mockRejectedValueOnce(failure);
    await expect(f.driver.advance(f.input)).rejects.toBe(failure);
  });

  it("waits for the initial tuple and captures the value received during workspace preparation", async () => {
    const f = await fixture("codex", null);
    const resource = (scope: "user" | "project" | "worker", text: string) => ({ scope, scopeId: scope === "project" ? f.input.task.projectId : uuid(5), revision: "1", text, updatedAt: "2026-11-09T00:00:00Z" });
    let tuple: ReturnType<NonNullable<ExecutionDependencies["promptSource"]>["current"]> = null;
    f.dependencies.promptSource = { current: () => tuple };
    expect(await f.driver.advance(f.input)).toMatchObject({ kind: "waiting_input", reason: "prompt_unknown", observation: null });
    expect(f.calls.filter(call => call.method === "agent.start" || call.method === "agent.prompt")).toEqual([]);
    tuple = { user: resource("user", "old"), project: resource("project", ""), worker: resource("worker", "worker") };
    const prepare = f.manager.prepareWorkspace.bind(f.manager);
    vi.spyOn(f.manager, "prepareWorkspace").mockImplementation(async (...args) => {
      const binding = await prepare(...args);
      tuple = { user: resource("user", "new"), project: resource("project", "project"), worker: resource("worker", "worker") };
      return binding;
    });
    expect((await f.driver.advance(f.input)).kind).toBe("observed");
    const prompt = String(f.calls.find(call => call.method === "agent.prompt")!.params.text);
    expect(prompt).toContain("----- begin user prompt -----\nnew\n----- end user prompt -----");
    expect(prompt).toContain("----- begin project prompt -----\nproject\n----- end project prompt -----");
    expect(prompt).not.toContain("\nold\n");
  });

  it("rejects an oversized complete request before native launch and retries after a revision changes", async () => {
    const f = await fixture("codex", null);
    const resource = (scope: "user" | "project" | "worker", revision: string, text: string) => ({ scope, scopeId: scope === "project" ? f.input.task.projectId : uuid(5), revision, text, updatedAt: "2026-11-09T00:00:00Z" });
    let tuple = { user: resource("user", "1", "x".repeat(1_100_000)), project: resource("project", "1", ""), worker: resource("worker", "1", "") };
    f.dependencies.promptSource = { current: () => tuple };
    expect(await f.driver.advance(f.input)).toMatchObject({ kind: "waiting_input", reason: "prompt_too_large" });
    expect(await f.driver.advance(f.input)).toMatchObject({ kind: "waiting_input", reason: "prompt_too_large" });
    expect(f.calls.filter(call => call.method === "agent.start" || call.method === "agent.prompt")).toEqual([]);
    expect(f.events.filter(event => event.kind === "waiting")).toHaveLength(1);
    tuple = { ...tuple, user: resource("user", "2", "small") };
    expect((await f.driver.advance(f.input)).kind).toBe("observed");
    expect(f.calls.filter(call => call.method === "agent.prompt")).toHaveLength(1);
  });

  it("revalidates the same revisions when an oversized ping is followed by a shorter startup", async () => {
    const f = await fixture("codex", null);
    const resource = (scope: "user" | "project" | "worker", revision: string, text: string) => ({ scope, scopeId: scope === "project" ? f.input.task.projectId : uuid(5), revision, text, updatedAt: "2026-11-09T00:00:00Z" });
    let tuple = { user: resource("user", "1", ""), project: resource("project", "1", ""), worker: resource("worker", "1", "") };
    f.dependencies.promptSource = { current: () => tuple };
    const initial = await f.driver.advance(f.input);
    const pane = f.agents.find(value => value.pane_id === initial.observation!.binding.paneId)!;
    pane.agent_status = "idle"; pane.state_change_seq = 7;
    const base = { ...tuple, user: resource("user", "2", "x") };
    const size = Buffer.byteLength(JSON.stringify({ id: uuid(0), method: "agent.prompt", params: { target: "new-pane-2", text: appendWorkerPrompts("managed assignment", base) } }));
    tuple = { ...base, user: resource("user", "2", "x".repeat(1 + 1_048_576 - size - 100)) };
    expect(await f.driver.advance(f.input)).toMatchObject({ kind: "waiting_input", reason: "prompt_too_large" });
    expect(f.calls.filter(call => call.method === "agent.prompt")).toHaveLength(1);
    f.agents.splice(0);
    const exited = f.panes.find(value => value.pane_id === initial.observation!.binding.paneId)!;
    exited.agent_session = { source: "herdr:codex", agent: "codex", kind: "id", value: freshId };
    expect((await f.driver.advance(f.input)).kind).toBe("observed");
    expect(f.calls.filter(call => call.method === "agent.prompt")).toHaveLength(2);
  });

  it("revalidates the same ping revisions when the actual target changes", async () => {
    const f = await fixture("codex", staleId);
    const longTarget = "p".repeat(500);
    f.panes[0]!.pane_id = longTarget;
    const current: Entry = { ...f.panes[0], agent: "codex", name: herdrExecutionAgentName(f.context), agent_status: "idle", interactive_ready: true, launch_pending: false, state_change_seq: 10, completion_seq: 3 };
    f.agents.push(current);
    const resource = (scope: "user" | "project" | "worker", text: string) => ({ scope, scopeId: scope === "project" ? f.input.task.projectId : uuid(5), revision: "1", text, updatedAt: "2026-11-09T00:00:00Z" });
    const tuple = { user: resource("user", "x"), project: resource("project", ""), worker: resource("worker", "") };
    const shortTarget = "p";
    const size = Buffer.byteLength(JSON.stringify({ id: uuid(0), method: "agent.prompt", params: { target: shortTarget, text: appendWorkerPrompts(workerPingPrompt(f.input.task), tuple) } }));
    tuple.user = resource("user", "x".repeat(1 + 1_048_576 - size - 100));
    f.dependencies.promptSource = { current: () => tuple };
    expect(await f.driver.advance(f.input)).toMatchObject({ kind: "waiting_input", reason: "prompt_too_large" });
    current.pane_id = shortTarget; f.panes[0]!.pane_id = shortTarget;
    expect((await f.driver.advance(f.input)).kind).toBe("observed");
    expect(f.calls.filter(call => call.method === "agent.prompt")).toHaveLength(1);
  });
  it("refuses worktree and native mutations when durable launch provenance is unknown", async () => {
    const f = await fixture("codex", null);
    Object.assign(f.dependencies.herdr, { lifecycle: { assertCanAdvance: () => { throw new Error("Original run is stop_unknown"); } } });
    await expect(f.driver.advance(f.input)).rejects.toThrow("stop_unknown");
    expect(f.dependencies.git.prepareWorktree).not.toHaveBeenCalled();
    expect(f.calls.filter(call => ["workspace.create", "workspace.close", "agent.start", "agent.prompt"].includes(call.method))).toEqual([]);
  });

  it("retains a workspace with no original cwd or manifest without preparing a replacement", async () => {
    const f = await fixture("codex", null);
    const observed = await f.resources();
    observed[0]!.panes[0]!.cwd = null;
    vi.spyOn(f.manager, "listResources").mockResolvedValue(observed);
    vi.mocked(f.dependencies.git.resolveWorktreeBinding).mockResolvedValue(null);
    await expect(f.driver.advance(f.input)).rejects.toThrow("original Herdr workspace has no worktree path evidence");
    expect(f.dependencies.git.prepareWorktree).not.toHaveBeenCalled();
    expect(f.calls.filter(call => ["workspace.create", "workspace.close", "agent.start", "agent.prompt"].includes(call.method))).toEqual([]);
  });

  it.each([null, staleId])("stops the original workspace before restoring its missing cwd (session %s)", async sessionId => {
    const f = await fixture("codex", sessionId);
    f.agents.push({ ...f.panes[0], agent: "codex", name: herdrExecutionAgentName(f.context), agent_status: "working", interactive_ready: true, launch_pending: false, state_change_seq: 1, completion_seq: 0 });
    await rm(f.context.cwd, { recursive: true });
    vi.mocked(f.dependencies.git.prepareWorktree).mockImplementation(async () => {
      expect(f.calls.some(call => call.method === "workspace.close")).toBe(true);
      await mkdir(f.context.cwd, { recursive: true });
      return { repositoryPath: f.input.project.localPath, commonDirectory: path.join(f.input.project.localPath, ".git"), worktreePath: f.context.cwd, branch: `daynight/${f.input.owner.taskId}` };
    });
    await f.driver.advance(f.input);
    expect(f.calls.filter(call => call.method === "workspace.close")).toHaveLength(1);
    expect(f.launches).toHaveLength(1);
    if (sessionId !== null) expect(f.launches[0]!.args).toContain(sessionId);
  });

  it("does not restore a missing cwd if the original workspace stop is unconfirmed", async () => {
    const f = await fixture("codex", staleId);
    await rm(f.context.cwd, { recursive: true });
    vi.spyOn(f.manager, "stopAndClose").mockRejectedValue(new Error("stop unknown"));
    await expect(f.driver.advance(f.input)).rejects.toThrow("stop unknown");
    expect(f.dependencies.git.prepareWorktree).not.toHaveBeenCalled();
  });

  it("retains an observed live binding when its workspace disappears without stop evidence", async () => {
    const f = await fixture("codex", null);
    await f.driver.advance(f.input);
    f.workspaces.splice(0); f.panes.splice(0); f.agents.splice(0);
    await rm(f.context.cwd, { recursive: true });
    vi.mocked(f.dependencies.git.prepareWorktree).mockClear();
    await expect(f.driver.advance(f.input)).rejects.toThrow("original Herdr execution stop is unconfirmed");
    expect(f.dependencies.git.prepareWorktree).not.toHaveBeenCalled();
    expect(f.launches).toHaveLength(1);
  });

  it("requires durable stop and recovery admission before restoring a missing cwd", async () => {
    const f = await fixture("codex", staleId);
    await rm(f.context.cwd, { recursive: true });
    let stopped = false;
    const admission = vi.fn(() => { if (!stopped && admission.mock.calls.length > 1) throw new Error("stop proof missing"); });
    const stop = vi.fn(async (_owner: ResourceOwner, _reason: "shutdown", operation: Parameters<typeof f.manager.stopAndClose>[2]) => {
      await f.manager.stopAndClose(f.context, f.binding, operation); stopped = true;
    });
    Object.assign(f.dependencies.herdr, { lifecycle: { worktreePath: () => f.context.cwd, hasStarted: () => true, isStopped: () => stopped, assertCanAdvance: admission, hasPreparedRun: () => false, stop } });
    vi.mocked(f.dependencies.git.prepareWorktree).mockImplementation(async () => {
      expect(stopped).toBe(true); expect(admission).toHaveBeenCalledTimes(2);
      await mkdir(f.context.cwd, { recursive: true });
      return { repositoryPath: f.input.project.localPath, commonDirectory: path.join(f.input.project.localPath, ".git"), worktreePath: f.context.cwd, branch: `daynight/${f.input.owner.taskId}` };
    });
    await f.driver.advance(f.input);
    expect(stop).toHaveBeenCalledOnce();
    expect(f.launches).toHaveLength(1);
  });

  it.each([null, staleId])("prepares the original worktree after restart with session %s", async sessionId => {
    const f = await fixture("codex", sessionId);
    f.workspaces.splice(0); f.panes.splice(0);
    const repo = f.input.project.localPath, root = path.dirname(repo);
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))) }).trim();
    git(repo, "init", "--initial-branch=main");
    git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture");
    git(root, "clone", "--bare", repo, "origin.git");
    git(repo, "remote", "add", "origin", f.input.project.repoUrl);
    git(repo, "config", `url.${path.join(root, "origin.git")}.insteadOf`, f.input.project.repoUrl);
    if (sessionId !== null) git(repo, "branch", `daynight/${f.input.owner.taskId}`);
    const sources = { listSchedules: () => [], listWebTasks: () => [], listHerdrLifecycles: () => [], listHerdrBindings: () => [], listHerdrRetired: () => [], listHerdrResources: () => [] };
    const adapter = createWorkerGitManager({ temporaryDirectory: path.join(root, "git-temp"), prepareFormat: async (_project, repository, operation) => { await migrateLegacyWorktrees({ repositoryPath: repository.root, commonDirectory: repository.commonDirectory, operation, sources }); } });
    const operation = createOperation();
    try {
      await adapter.prepareRepository(f.input.project, operation);
      await mkdir(path.join(repo, ".worktrees", "daynight", f.input.owner.worktreeId), { recursive: true });
      f.dependencies.git = adapter;
      await f.driver.advance({ ...f.input, freshClaim: false });
      const cwd = path.join(repo, ".worktrees", "daynight", f.input.owner.worktreeId);
      expect(git(cwd, "branch", "--show-current")).toBe(`daynight/${f.input.owner.taskId}`);
      expect(f.launches).toHaveLength(1);
    } finally { operation.dispose(); await adapter.dispose(); }
  }, 30_000);

  it("stops the live workspace if its cwd disappears after observation", async () => {
    const f = await fixture("codex", staleId);
    const repo = f.input.project.localPath, root = path.dirname(repo);
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))) }).trim();
    git(repo, "init", "--initial-branch=main");
    git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture");
    git(root, "clone", "--bare", repo, "origin.git");
    git(repo, "remote", "add", "origin", f.input.project.repoUrl);
    git(repo, "config", `url.${path.join(root, "origin.git")}.insteadOf`, f.input.project.repoUrl);
    const sources = { listSchedules: () => [], listWebTasks: () => [], listHerdrLifecycles: () => [], listHerdrBindings: () => [], listHerdrRetired: () => [], listHerdrResources: () => [] };
    const adapter = createWorkerGitManager({ temporaryDirectory: path.join(root, "git-temp"), prepareFormat: async (_project, repository, operation) => { await migrateLegacyWorktrees({ repositoryPath: repository.root, commonDirectory: repository.commonDirectory, operation, sources }); } });
    const operation = createOperation();
    try {
      await adapter.prepareRepository(f.input.project, operation);
      await adapter.prepareWorktree(f.input.project, f.input.owner, operation, f.context.cwd);
      const prepare = adapter.prepareWorktree;
      vi.spyOn(adapter, "prepareWorktree")
        .mockImplementationOnce(async (...args) => { await rm(f.context.cwd, { recursive: true }); return prepare(...args); })
        .mockImplementationOnce(async (...args) => { expect(f.calls.some(call => call.method === "workspace.close")).toBe(true); return prepare(...args); });
      f.dependencies.git = adapter;
      f.agents.push({ ...f.panes[0], agent: "codex", name: herdrExecutionAgentName(f.context), agent_status: "working", interactive_ready: true, launch_pending: false, state_change_seq: 1, completion_seq: 0 });
      await f.driver.advance(f.input);
      expect(f.calls.some(call => call.method === "workspace.close")).toBe(true);
      expect(f.launches).toHaveLength(1);
      const registered = git(repo, "worktree", "list", "--porcelain", "-z").split("\0").filter(field => field.startsWith("worktree ")).map(field => path.normalize(field.slice("worktree ".length)));
      expect(registered).toContain(path.normalize(f.context.cwd));
    } finally { operation.dispose(); await adapter.dispose(); }
  }, 30_000);

  it("finishes a pending durable stop before applying replacement admission", async () => {
    const f = await fixture("codex", null);
    let settled = false;
    vi.spyOn(f.manager, "pendingStops").mockImplementation(() => settled ? [] : [{ context: f.context, binding: f.binding }]);
    vi.spyOn(f.manager, "stopAndClose").mockImplementation(async () => {
      expect(f.dependencies.git.prepareWorktree).not.toHaveBeenCalled();
      settled = true;
    });
    Object.assign(f.dependencies.herdr, { lifecycle: { assertCanAdvance: () => { if (!settled) throw new Error("Original stop_intent must finish first"); }, hasPreparedRun: () => true } });
    await f.driver.advance(f.input);
    expect(settled).toBe(true); expect(f.launches).toHaveLength(1);
  });

  it("resumes a durably prepared shell without requiring nonexistent agent stop proof", async () => {
    const f = await fixture("codex", null);
    const stop = vi.fn(async () => { throw new Error("A prepared run has not launched an agent"); });
    Object.assign(f.dependencies.herdr, { lifecycle: { assertCanAdvance: () => {}, hasPreparedRun: () => true, stop } });
    const result = await f.driver.advance(f.input);
    expect(result.observation!.binding).toEqual(f.binding);
    expect(f.launches).toHaveLength(1);
    expect(stop).not.toHaveBeenCalled();
    expect(f.calls.some(call => call.method === "workspace.close")).toBe(false);
    expect(f.calls.some(call => call.method === "workspace.create")).toBe(false);
  });
  it.each(["codex", "copilot"] as const)("replaces a cold inactive %s pane before a NULL-session fresh launch", async (agent) => {
    const f = await fixture(agent, null);
    const result = await f.driver.advance(f.input);
    expect(result.observation!.binding.workspaceId).not.toBe(f.binding.workspaceId);
    expect(f.calls.filter((call) => call.method === "workspace.close")).toHaveLength(1);
    expect(f.launches).toHaveLength(1); expect(f.launches[0]!.environment).toEqual(f.expectedNativeEnvironment);
    expect(f.workerEnvironment.COPILOT_ALLOW_ALL).toBe("false"); expect(f.workerEnvironment.COPILOT_ASSISTED_APPROVAL).toBe("true");
    expect(f.launches[0]!.args).toEqual(expect.arrayContaining(agent === "codex" ? ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust"] : ["--allow-all", "--no-ask-user", "--no-sandbox"]));
    if (agent === "codex") expect(f.launches[0]!.args.at(-1)).toBe(codexProjectTrustArguments(f.context.cwd).at(-1));
    expect(f.launches[0]!.args.some((arg) => arg === "resume" || arg.startsWith("--resume="))).toBe(false);
    expect(f.store.getTask(f.input.task)?.sessionId).toBe(freshId);
    expect(f.events).toContainEqual({ kind: "info", task: f.input.task, message: "Starting a new native conversation in the task worktree." });
    expect(f.events.some((event) => event.kind === "warning")).toBe(false);
    expect(f.store.getTask(f.input.task)?.sessionId).not.toBe(staleId);
  });

  it.each(["codex", "copilot"] as const)("recreates a cold inactive %s workspace and resumes the saved ID", async (agent) => {
    const f = await fixture(agent, savedId);
    const result = await f.driver.advance(f.input);
    expect(result.observation!.nativeSession?.sessionId).toBe(savedId); expect(f.store.getTask(f.input.task)?.sessionId).toBe(savedId);
    expect(f.launches[0]!.environment).toEqual(f.expectedNativeEnvironment);
    expect(f.launches[0]!.args).toEqual(expect.arrayContaining(agent === "codex" ? ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust"] : ["--allow-all", "--no-ask-user", "--no-sandbox"]));
    if (agent === "codex") expect(f.launches[0]!.args.at(-1)).toBe(codexProjectTrustArguments(f.context.cwd).at(-1));
    expect(f.launches[0]!.args).toContain(agent === "codex" ? savedId : `--resume=${savedId}`);
    expect(f.events.some((event) => event.kind === "info")).toBe(false);
    expect(f.events.some((event) => event.kind === "warning")).toBe(false);
  });

  it.each(["codex", "copilot"] as const)("reconnects a live %s agent without replacing its workspace or sending a prompt", async (agent) => {
    const f = await fixture(agent, staleId);
    f.agents.push({ ...f.panes[0], agent, name: herdrExecutionAgentName(f.context), agent_status: "working", interactive_ready: true, launch_pending: false, state_change_seq: 1, completion_seq: 0 });
    const result = await f.driver.advance(f.input);
    expect(result.observation!.nativeSession?.sessionId).toBe(staleId);
    expect(f.calls.filter((call) => ["workspace.close", "workspace.create", "agent.start", "agent.prompt"].includes(call.method))).toEqual([]);
  });

  it.each(["codex", "copilot"] as const)("automatically resumes %s after an exit while the replacement shell initializes", async (agent) => {
    const f = await fixture(agent, savedId);
    const first = await f.driver.advance(f.input);
    const originalTask = f.store.getTask(f.input.task);
    f.agents.splice(0);
    const exitedPane = f.panes.find((pane) => pane.pane_id === first.observation!.binding.paneId)!;
    exitedPane.agent_session = { source: `herdr:${agent}`, agent, kind: "id", value: savedId };
    const request = f.rpc.request;
    const busy = new HerdrRpcError("replacement shell is initializing", { method: "agent.start", requestId: "restart", submission: "unknown", code: "agent_pane_busy" });
    let attempts = 0;
    vi.spyOn(f.rpc, "request").mockImplementation(async (method, params, operation) => {
      if (method === "agent.start" && ++attempts === 1) throw busy;
      if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: params.pane_id, shell_pid: 100, foreground_process_group_id: 100, foreground_processes: [{ pid: 100, name: "bash", argv: ["/bin/bash"] }, { pid: 101, name: "shell-init" }] } };
      return request(method, params, operation);
    });

    const recovered = await f.driver.advance(f.input);
    expect(attempts).toBe(2);
    expect(recovered.observation!.binding.workspaceId).not.toBe(first.observation!.binding.workspaceId);
    expect(recovered.observation!.nativeSession?.sessionId).toBe(savedId);
    expect(f.store.getTask(f.input.task)).toEqual(originalTask);
    expect(f.launches).toHaveLength(2);
    expect(f.launches[1]!.args).toContain(agent === "codex" ? savedId : `--resume=${savedId}`);
    expect(f.launches[1]!.environment).toEqual(f.expectedNativeEnvironment);
    expect(f.calls.filter((call) => call.method === "agent.prompt")).toHaveLength(2);
    expect(f.dependencies.git.prepareWorktree).toHaveBeenCalledTimes(2);
  });

  it.each(["codex", "copilot"] as const)("pings stopped %s turns once and resumes checking after native progress", async (agent) => {
    const f = await fixture(agent, staleId);
    const current: Entry = { ...f.panes[0], agent, name: herdrExecutionAgentName(f.context), agent_status: "idle", interactive_ready: true, launch_pending: false, state_change_seq: 10, completion_seq: 3 };
    f.agents.push(current);
    await f.driver.advance(f.input);
    await f.driver.advance(f.input);
    const prompts = () => f.calls.filter((call) => call.method === "agent.prompt");
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]!.params).toMatchObject({ target: f.binding.paneId, text: expect.stringContaining(f.input.task.claimId) });
    expect(prompts()[0]!.params.text).toContain("review or CI is pending");

    current.agent_status = "working";
    await f.driver.advance(f.input);
    expect(prompts()).toHaveLength(1);
    current.agent_status = "done";
    current.state_change_seq = 12;
    current.completion_seq = 4;
    await f.driver.advance(f.input);
    await f.driver.advance(f.input);
    expect(prompts()).toHaveLength(2);
    expect(f.calls.filter((call) => ["workspace.close", "workspace.create", "agent.start"].includes(call.method))).toEqual([]);
    expect(f.store.getTask(f.input.task)?.status).toBe("active");
  });

  it.each([false, undefined])("suppresses paused patrols and resumes the unchanged native turn when paused becomes %s", async (resumed) => {
    const f = await fixture("copilot", staleId);
    f.agents.push({ ...f.panes[0], agent: "copilot", name: herdrExecutionAgentName(f.context), agent_status: "idle", interactive_ready: true, launch_pending: false, state_change_seq: 10, completion_seq: 3 });
    f.remoteTask.properties.paused = true;
    for (let patrol = 0; patrol < 3; patrol++) await f.driver.advance(f.input);
    expect(f.calls.filter((call) => call.method === "agent.prompt")).toEqual([]);
    expect(f.readTask).toHaveBeenCalledTimes(3);
    expect(f.store.getTask(f.input.task)).toEqual(f.input.task);
    expect(f.launches).toEqual([]);

    if (resumed === undefined) delete f.remoteTask.properties.paused;
    else f.remoteTask.properties.paused = resumed;
    await f.driver.advance(f.input);
    await f.driver.advance(f.input);
    expect(f.calls.filter((call) => call.method === "agent.prompt")).toHaveLength(1);
    expect(f.readTask).toHaveBeenCalledTimes(4);
  });

  it.each(["codex", "copilot"] as const)("checks fresh pause state after waiting for %s workspace serialization", async (agent) => {
    const f = await fixture(agent, staleId);
    f.agents.push({ ...f.panes[0], agent, name: herdrExecutionAgentName(f.context), agent_status: "idle", interactive_ready: true, launch_pending: false, state_change_seq: 10, completion_seq: 3 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const submit = vi.spyOn(f.manager, "submitPrompt");
    const operation = createOperation();
    try {
      const blocker = f.manager.submitPrompt(f.context, f.binding, "serialized caller", operation, async () => { await gate; return false; });
      const patrol = f.driver.advance(f.input);
      await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
      expect(f.readTask).not.toHaveBeenCalled();
      f.remoteTask.properties.paused = true;
      release();
      await blocker;
      await patrol;
    } finally { release(); operation.dispose(); }
    expect(f.calls.filter((call) => call.method === "agent.prompt")).toEqual([]);
    expect(f.readTask).toHaveBeenCalledOnce();
    delete f.remoteTask.properties.paused;
    await f.driver.advance(f.input);
    expect(f.calls.filter((call) => call.method === "agent.prompt")).toHaveLength(1);
  });

  it.each(["paused", "claim changed", "read failure"] as const)("keeps mapped continuation unsent when task authority becomes %s during process verification", async change => {
    let mapping: HerdrToolLaunchMapping;
    const f = await fixture("copilot", staleId, { toolMapping: async () => mapping });
    const launch = frozenToolLaunch("copilot", "herdr"), nonce = uuid(20), manifestPath = path.join(f.root, "manifest.json");
    const receipt = { schemaVersion: 1 as const, owner: f.input.owner, nonce, selectionKey: launch.selectionKey, logicalArgvDigest: "a".repeat(64), file: launch.command.file, prefixArgs: [], helperPid: 101, childPid: 102 };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const verifyProcesses = vi.fn(async () => { await gate; });
    mapping = { manifestPath, nonce, selectionKey: launch.selectionKey, environment: { DAYNIGHT_HERDR_TOOL_MANIFEST: manifestPath }, verifyReady: async () => {}, verifyReceipt: async () => receipt, readReceipt: async () => receipt, captureProcesses: async pids => [...pids], verifyProcesses, confirmStopped: async () => true, stopProcesses: async () => {}, releaseFrozen: async () => {}, retire: async () => {} };
    f.agents.push({ ...f.panes[0], agent: "copilot", name: herdrExecutionAgentName(f.context), agent_status: "idle", interactive_ready: true, launch_pending: false, state_change_seq: 10, completion_seq: 3 });
    const original = readWorkerClaim(f.remoteTask.properties)!, failure = new Error("current task authority unavailable");
    const pending = f.driver.advance(f.input);
    try {
      await vi.waitFor(() => expect(verifyProcesses).toHaveBeenCalledOnce());
      if (change === "paused") f.remoteTask.properties.paused = true;
      else if (change === "claim changed") f.remoteTask.properties.worker = { ...original, claimId: uuid(21) };
      else f.readTask.mockRejectedValueOnce(failure);
      release();
      if (change === "read failure") await expect(pending).rejects.toMatchObject({ action: "agent.prompt", promptSubmission: "not-submitted", cause: failure });
      else await pending;
      expect(f.calls.filter(call => call.method === "agent.prompt")).toEqual([]);
      expect(f.store.getTask(f.input.task)).toEqual(f.input.task);
      expect(f.launches).toEqual([]);
    } finally { release(); await pending.catch(() => {}); }
    delete f.remoteTask.properties.paused; f.remoteTask.properties.worker = { ...original };
    await f.driver.advance(f.input);
    await f.driver.advance(f.input);
    expect(f.calls.filter(call => call.method === "agent.prompt")).toHaveLength(1);
    expect(f.calls.filter(call => ["workspace.close", "workspace.create", "agent.start"].includes(call.method))).toEqual([]);
  });

  it("checks fresh pause state after visible input inspection", async () => {
    const f = await fixture("codex", staleId);
    f.agents.push({ ...f.panes[0], agent: "codex", name: herdrExecutionAgentName(f.context), agent_status: "idle", interactive_ready: true, launch_pending: false, state_change_seq: 10, completion_seq: 3 });
    const request = f.rpc.request;
    vi.spyOn(f.rpc, "request").mockImplementation(async (method, params, operation) => {
      const result = await request(method, params, operation);
      if (method === "agent.read") {
        expect(f.readTask).not.toHaveBeenCalled();
        f.remoteTask.properties.paused = true;
      }
      return result;
    });
    await f.driver.advance(f.input);
    expect(f.readTask).toHaveBeenCalledOnce();
    expect(f.calls.filter(call => call.method === "agent.prompt")).toEqual([]);
    vi.restoreAllMocks(); delete f.remoteTask.properties.paused;
    await f.driver.advance(f.input);
    expect(f.calls.filter(call => call.method === "agent.prompt")).toHaveLength(1);
  });

  it.each(["read failure", "invalid pause"])("exposes %s without sending or consuming the continuation decision", async (failureKind) => {
    const f = await fixture("copilot", staleId);
    f.agents.push({ ...f.panes[0], agent: "copilot", name: herdrExecutionAgentName(f.context), agent_status: "idle", interactive_ready: true, launch_pending: false, state_change_seq: 10, completion_seq: 3 });
    const failure = new Error("fresh task unavailable");
    if (failureKind === "read failure") f.readTask.mockRejectedValueOnce(failure);
    else f.remoteTask.properties.paused = "true";
    await expect(f.driver.advance(f.input)).rejects.toMatchObject({ action: "agent.prompt", promptSubmission: "not-submitted", ...(failureKind === "read failure" ? { cause: failure } : {}) });
    expect(f.calls.filter((call) => call.method === "agent.prompt")).toEqual([]);
    delete f.remoteTask.properties.paused;
    await f.driver.advance(f.input);
    expect(f.calls.filter((call) => call.method === "agent.prompt")).toHaveLength(1);
  });

  it.each(["missing", "completed", "claim", "worker", "worktree", "local completed"])("does not ping when the original active ownership is %s", async (change) => {
    const f = await fixture("copilot", staleId);
    f.agents.push({ ...f.panes[0], agent: "copilot", name: herdrExecutionAgentName(f.context), agent_status: "idle", interactive_ready: true, launch_pending: false, state_change_seq: 10, completion_seq: 3 });
    const original = readWorkerClaim(f.remoteTask.properties)!;
    f.readTask.mockImplementationOnce(async () => {
      if (change === "missing") delete f.remoteTask.properties.worker;
      else if (change === "local completed") f.store.completeTask(f.input.task);
      else f.remoteTask.properties.worker = { ...original, ...(change === "completed" ? { state: "completed" } : change === "claim" ? { claimId: uuid(20) } : change === "worker" ? { workerId: uuid(21) } : { worktreeId: uuid(22) }) };
      return f.remoteTask;
    });
    if (change === "local completed") await expect(f.driver.advance(f.input)).rejects.toThrow("already done");
    else await f.driver.advance(f.input);
    expect(f.calls.filter((call) => call.method === "agent.prompt")).toEqual([]);
    expect(f.launches).toEqual([]);
    expect(f.store.listTasks()).toHaveLength(1);
  });

  it.each(["initial", "deferred"])("delivers the %s assignment while periodic continuation is paused", async (assignment) => {
    const f = await fixture("copilot", savedId);
    f.remoteTask.properties.paused = true;
    if (assignment === "deferred") {
      f.blockOnLaunch();
      await f.driver.advance(f.input);
      f.agents[0]!.agent_status = "idle";
    }
    await f.driver.advance(f.input);
    expect(f.calls.filter((call) => call.method === "agent.prompt").map((call) => call.params.text)).toEqual(["managed assignment"]);
    expect(f.readTask).not.toHaveBeenCalled();
  });

  it.each([
    { status: "working", ready: true, launchPending: false },
    { status: "blocked", ready: true, launchPending: false },
    { status: "unknown", ready: true, launchPending: false },
    { status: "idle", ready: false, launchPending: false },
    { status: "done", ready: true, launchPending: true },
  ])("does not ping an unavailable or running native agent: $status/$ready/$launchPending", async ({ status, ready, launchPending }) => {
    const f = await fixture("copilot", staleId);
    f.agents.push({ ...f.panes[0], agent: "copilot", name: herdrExecutionAgentName(f.context), agent_status: status, interactive_ready: ready, launch_pending: launchPending, state_change_seq: 1, completion_seq: 0 });
    await f.driver.advance(f.input);
    await f.driver.advance(f.input);
    expect(f.calls.filter((call) => call.method === "agent.prompt")).toEqual([]);
  });

  it.each([["idle", "working"], ["working", "idle"]])("uses fresh %s -> %s status when deciding whether to ping", async (snapshotStatus, observedStatus) => {
    const f = await fixture("copilot", staleId);
    const current: Entry = { ...f.panes[0], agent: "copilot", name: herdrExecutionAgentName(f.context), agent_status: snapshotStatus, interactive_ready: true, launch_pending: false, state_change_seq: 10, completion_seq: 3 };
    f.agents.push(current);
    const verify = f.dependencies.git.prepareWorktree;
    vi.mocked(f.dependencies.git.prepareWorktree).mockImplementationOnce(async (...args) => { current.agent_status = observedStatus; return verify(...args); });
    await f.driver.advance(f.input);
    expect(f.calls.filter((call) => call.method === "agent.prompt")).toHaveLength(observedStatus === "idle" ? 1 : 0);
  });

  it("retries a definitely unsent ping but observes an unknown submission without replay", async () => {
    const f = await fixture("copilot", staleId);
    const current: Entry = { ...f.panes[0], agent: "copilot", name: herdrExecutionAgentName(f.context), agent_status: "idle", interactive_ready: true, launch_pending: false, state_change_seq: 10, completion_seq: 3 };
    f.agents.push(current);
    const prompt = vi.spyOn(f.manager, "submitPrompt");
    const unsent = new HerdrAgentActionError("not sent", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" });
    prompt.mockRejectedValueOnce(unsent);
    await expect(f.driver.advance(f.input)).rejects.toBe(unsent);
    await f.driver.advance(f.input);
    expect(prompt).toHaveBeenCalledTimes(2);

    current.state_change_seq = 12;
    current.completion_seq = 4;
    const unknown = new HerdrAgentActionError("ACK lost", "agent.prompt", "unknown", { promptSubmission: "unknown" });
    prompt.mockImplementationOnce(async () => { current.state_change_seq = 14; current.completion_seq = 5; throw unknown; });
    await expect(f.driver.advance(f.input)).rejects.toBe(unknown);
    await f.driver.advance(f.input);
    await f.driver.advance(f.input);
    expect(prompt).toHaveBeenCalledTimes(3);
    current.state_change_seq = 16;
    current.completion_seq = 6;
    await f.driver.advance(f.input);
    expect(prompt).toHaveBeenCalledTimes(4);
  });

  it.each([
    "Select model\n› 1. GPT-6.1 Terra\n  2. GPT-6.1 Sol\nenter select · esc back",
    "Select Reasoning Level for GPT-5.5\n› 3. High (current)    Greater reasoning depth for complex problems\nenter default · s session · esc back",
    "Advanced Reasoning\n› 1. Ultra\nenter apply · s session · esc back",
    "Configuration\nChanges save automatically\n› Automatic recaps       [ ] Off              Prepare recaps while the terminal is unfocused\nleft/right group · / search · enter toggle · esc clear search/close",
    "Configuration\nChanges save automatically\n› Automatic recaps       [ ] Off              Prepare recaps while the terminal is unfocused\nleft/right group · / search · enter toggle",
    "Effects\nConfigure visual effects\n› 1. [ ] Animations                 Animate the welcome screen, working\n                                    indicator, and transitions\n     [-] Composer stars (disabled)  Turn on Animations to show Astra task stars\nenter toggle · esc back",
    "Keymap\nAll configurable shortcuts.\n› Action 08  Ctrl+8\nleft/right group · enter edit · esc close",
    ...nativeMenuScreens.map(menu => menu.screen),
    ...["fwd del", "delete", "⌃x fwd del"].map(key => nativeMenuScreens.find(menu => menu.name === "hooks_browser_handlers")!.screen.replace("esc back", `${key} back`)),
    "› Viewing sub-agent\n\n ? for shortcuts",
    "› Viewing sub-agent — direct in\n\n ? for shortcuts",
    "› Input disabled\n\n ? for shortcuts",
    "› Input disabled until setup comp\n\n ? for shortcuts",
  ])("keeps a continuation decision available while a Codex picker reports unchanged idle readiness: %s", async menu => {
    const f = await fixture("codex", staleId);
    f.agents.push({ ...f.panes[0], agent: "codex", name: herdrExecutionAgentName(f.context), agent_status: "idle", interactive_ready: true, launch_pending: false, state_change_seq: 10, completion_seq: 3 });
    f.screen.text = menu;
    for (let attempt = 0; attempt < 4; attempt++) await expect(f.driver.advance(f.input)).rejects.toBeInstanceOf(HerdrInputBlockedError);
    expect(f.calls.filter(call => call.method === "agent.prompt")).toEqual([]);
    expect(f.readTask).not.toHaveBeenCalled();
    f.screen.text = "› Custom input placeholder\nGPT-6.1 Terra medium · daynight/task";
    await f.driver.advance(f.input); await f.driver.advance(f.input);
    expect(f.calls.filter(call => call.method === "agent.prompt")).toHaveLength(1);
    expect(f.calls.find(call => call.method === "agent.prompt")!.params.text).toContain("worker's periodic check");
    expect(f.agents[0]).toMatchObject({ agent_status: "idle", state_change_seq: 10, completion_seq: 3 });
  });

  it("retains the initial assignment across an open menu and deferred input attempts", async () => {
    const f = await fixture("codex", null);
    f.screen.text = "Select model\n› 1. GPT-6.1 Terra\nenter select · esc back";
    await f.driver.advance(f.input);
    for (let attempt = 0; attempt < 4; attempt++) await expect(f.driver.advance(f.input)).rejects.toBeInstanceOf(HerdrInputBlockedError);
    expect(f.calls.filter(call => call.method === "agent.prompt")).toEqual([]);
    expect(f.calls.filter(call => call.method === "agent.start")).toHaveLength(1);
    f.screen.text = "Unknown layout without a positive composer signal";
    await f.driver.advance(f.input); await f.driver.advance(f.input);
    expect(f.calls.filter(call => call.method === "agent.prompt")).toHaveLength(1);
    expect(f.calls.find(call => call.method === "agent.prompt")!.params.text).toBe("managed assignment");
  });

  it("retains an unknown startup input until the live agent progresses", async () => {
    const f = await fixture("copilot", savedId);
    const request = f.rpc.request;
    const failure = new HerdrRpcError("prompt ACK lost", { method: "agent.prompt", requestId: "prompt", submission: "unknown" });
    let lost = false;
    vi.spyOn(f.rpc, "request").mockImplementation(async (method, params, operation) => {
      const result = await request(method, params, operation);
      if (method === "agent.prompt" && !lost) { lost = true; throw failure; }
      return result;
    });
    await expect(f.driver.advance(f.input)).rejects.toMatchObject({ action: "agent.prompt", promptSubmission: "unknown", cause: failure });
    await f.driver.advance(f.input);
    await f.driver.advance(f.input);
    expect(f.calls.filter((call) => call.method === "agent.prompt")).toHaveLength(1);
    f.agents[0]!.agent_status = "working";
    await f.driver.advance(f.input);
    f.agents[0]!.agent_status = "idle";
    await f.driver.advance(f.input);
    expect(f.calls.filter((call) => call.method === "agent.prompt")).toHaveLength(2);
    expect(f.calls.filter((call) => call.method === "agent.start")).toHaveLength(1);
  });

  it.each(["codex", "copilot"] as const)("delivers the original %s assignment after a lost native-launch ACK", async (agent) => {
    for (const sessionId of [null, savedId]) {
      const f = await fixture(agent, sessionId);
      f.reportOnLaunch(sessionId === null ? freshId : savedId);
      const request = f.rpc.request;
      const failure = new HerdrRpcError("launch ACK lost", { method: "agent.start", requestId: "start", submission: "unknown" });
      let lost = false;
      vi.spyOn(f.rpc, "request").mockImplementation(async (method, params, operation) => {
        const result = await request(method, params, operation);
        if (method === "agent.start" && !lost) { lost = true; throw failure; }
        return result;
      });
      await expect(f.driver.advance(f.input)).rejects.toMatchObject({ action: "agent.start", submission: "unknown", promptSubmission: null, cause: failure });
      expect(f.calls.filter((call) => call.method === "agent.prompt")).toEqual([]);
      await f.driver.advance(f.input);
      await f.driver.advance(f.input);
      const prompts = () => f.calls.filter((call) => call.method === "agent.prompt");
      expect(prompts()).toHaveLength(1); expect(prompts()[0]!.params.text).toBe("managed assignment");
      expect(f.calls.filter((call) => call.method === "agent.start")).toHaveLength(1);
      const current = f.agents[0]!;
      current.agent_status = "idle"; current.state_change_seq = 3; current.completion_seq = 1;
      await f.driver.advance(f.input);
      expect(prompts()).toHaveLength(2); expect(prompts()[1]!.params.text).toContain("worker's periodic check");
    }
  });

  it("rejects an idle agent's mismatched session and an ended local claim before ping", async () => {
    const f = await fixture("copilot", savedId);
    f.agents.push({ ...f.panes[0], agent: "copilot", name: herdrExecutionAgentName(f.context), agent_status: "idle", interactive_ready: true, launch_pending: false, state_change_seq: 1, completion_seq: 0 });
    await expect(f.driver.advance(f.input)).rejects.toThrow(/native session/);
    f.store.completeTask(f.input.task);
    await expect(f.driver.advance(f.input)).rejects.toThrow(/active local claim/);
    expect(f.calls.filter((call) => call.method === "agent.prompt")).toEqual([]);
  });

  it.each(["codex", "copilot"] as const)("reports %s waiting transitions without repeating stable polls or native turn activity", async (agent) => {
    const f = await fixture(agent, staleId);
    const current: Entry = { ...f.panes[0], agent, name: herdrExecutionAgentName(f.context), agent_status: "blocked", interactive_ready: true, launch_pending: false, state_change_seq: 1, completion_seq: 0 };
    f.agents.push(current);
    await f.driver.advance(f.input);
    await f.driver.advance(f.input);
    expect(f.events.map((event) => event.kind)).toEqual(["waiting"]);
    expect(f.events[0]!.message).toContain("daynight worker attach");

    current.agent_status = "working";
    await f.driver.advance(f.input);
    current.agent_status = "idle";
    current.state_change_seq = 10;
    current.completion_seq = 3;
    await f.driver.advance(f.input);
    current.agent_status = "working";
    await f.driver.advance(f.input);
    expect(f.events.map((event) => event.kind)).toEqual(["waiting", "reconnected"]);

    current.agent_status = "blocked";
    await f.driver.advance(f.input);
    await f.driver.advance(f.input);
    expect(f.events.map((event) => event.kind)).toEqual(["waiting", "reconnected", "waiting"]);
    expect(f.calls.filter((call) => ["workspace.close", "workspace.create", "agent.start"].includes(call.method))).toEqual([]);
    expect(f.calls.filter((call) => call.method === "agent.prompt")).toHaveLength(1);
  });

  it.each(["codex", "copilot"] as const)("keeps a successful %s startup as the baseline for subsequent polls", async (agent) => {
    const f = await fixture(agent, savedId);
    await f.driver.advance(f.input);
    await f.driver.advance(f.input);
    await f.driver.advance(f.input);
    expect(f.events.map((event) => event.kind)).toEqual(["started"]);
    expect(f.launches).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === "agent.prompt")).toHaveLength(1);
  });

  it.each(["codex", "copilot"] as const)("pings a fast %s startup or resumed turn completed before native session discovery", async (agent) => {
    for (const sessionId of [null, savedId]) for (const status of ["idle", "done"] as const) {
      const f = await fixture(agent, sessionId);
      f.finishFirstTurnBeforeDiscovery(status);
      const first = await f.driver.advance(f.input);
      expect(first.observation!.status).toBe(status); expect(first.observation!.completionSeq).toBe(1);
      expect(first.observation!.nativeSession?.sessionId).toBe(sessionId === null ? freshId : savedId);
      expect(f.calls.filter((call) => call.method === "agent.prompt")).toHaveLength(1);
      await f.driver.advance(f.input);
      await f.driver.advance(f.input);
      const prompts = f.calls.filter((call) => call.method === "agent.prompt");
      expect(prompts).toHaveLength(2);
      expect(prompts[0]!.params.text).toBe("managed assignment");
      expect(prompts[1]!.params.text).toContain("worker's periodic check");
      expect(f.calls.filter((call) => call.method === "agent.start")).toHaveLength(1);
    }
  });

  it("pings the idle agent that appeared before serialized startup without submitting an assignment", async () => {
    const f = await fixture("copilot", savedId);
    const phases = vi.fn(), successes = vi.fn(); f.dependencies.observePhase = phases; f.dependencies.observeSuccess = successes;
    const start = f.manager.start;
    vi.spyOn(f.manager, "start").mockImplementationOnce(async (context, binding, input, operation) => {
      const pane = f.panes.find((candidate) => candidate.pane_id === binding.paneId)!;
      f.agents.push({ ...pane, agent: "copilot", name: herdrExecutionAgentName(context), agent_status: "idle", interactive_ready: true, launch_pending: false, state_change_seq: 10, completion_seq: 3, agent_session: { source: "herdr:copilot", agent: "copilot", kind: "id", value: savedId } });
      return start(context, binding, input, operation);
    });
    await f.driver.advance(f.input);
    expect(f.calls.filter((call) => ["agent.start", "agent.prompt"].includes(call.method))).toEqual([]);
    expect(successes).not.toHaveBeenCalledWith(f.input.owner, { kind: "execution", phase: "agent-start" });
    expect(phases).not.toHaveBeenCalledWith(f.input.owner, { kind: "execution", phase: "agent-start" }, true, undefined);
    expect(successes).toHaveBeenCalledWith(f.input.owner, { kind: "execution", phase: "agent-observation" });
    await f.driver.advance(f.input);
    await f.driver.advance(f.input);
    const prompts = f.calls.filter((call) => call.method === "agent.prompt");
    expect(prompts).toHaveLength(1); expect(prompts[0]!.params.text).toContain("worker's periodic check");
    expect(f.calls.filter((call) => call.method === "agent.start")).toEqual([]);
  });

  it.each(["startup", "ping", "deferred startup"])("keeps the %s submission baseline when its following observation fails", async (inputKind) => {
    const f = await fixture("copilot", inputKind === "ping" ? staleId : savedId);
    const failure = new Error("post-input snapshot failed");
    if (inputKind === "deferred startup") {
      f.blockOnLaunch(); await f.driver.advance(f.input);
      f.agents[0]!.agent_status = "idle";
    } else if (inputKind === "ping") {
      f.agents.push({ ...f.panes[0], agent: "copilot", name: herdrExecutionAgentName(f.context), agent_status: "idle", interactive_ready: true, launch_pending: false, state_change_seq: 1, completion_seq: 0 });
    }
    const phases = vi.fn(), successes = vi.fn(); f.dependencies.observePhase = phases; f.dependencies.observeSuccess = successes;
    const request = f.rpc.request;
    let failSnapshot = false;
    let firstPrompt = true;
    vi.spyOn(f.rpc, "request").mockImplementation(async (method, params, operation) => {
      if (method === "session.snapshot" && failSnapshot) { failSnapshot = false; throw failure; }
      const result = await request(method, params, operation);
      if (method === "agent.prompt" && firstPrompt) {
        firstPrompt = false; failSnapshot = true;
        const current = f.agents[0]!;
        current.agent_status = "idle"; current.state_change_seq = 3; current.completion_seq = 1;
      }
      return result;
    });
    await expect(f.driver.advance(f.input)).rejects.toBe(failure);
    expect(phases).toHaveBeenLastCalledWith(expect.objectContaining({ claimId: f.input.owner.claimId }), { kind: "execution", phase: "agent-observation" }, false, undefined);
    successes.mockClear();
    await f.driver.advance(f.input);
    expect(successes).toHaveBeenCalledWith(f.input.owner, { kind: "execution", phase: "agent-observation" });
    await f.driver.advance(f.input);
    const prompts = f.calls.filter((call) => call.method === "agent.prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.params.text).toContain("worker's periodic check");
  });

  it.each(["codex", "copilot"] as const)("reports deferred first %s input once and submits it once after operator intervention", async (agent) => {
    const f = await fixture(agent, savedId);
    f.blockOnLaunch();
    await f.driver.advance(f.input);
    await f.driver.advance(f.input);
    await f.driver.advance(f.input);
    expect(f.events.map((event) => event.kind)).toEqual(["waiting"]);
    expect(f.events[0]!.message).toContain("The first managed input");
    expect(f.events[0]!.message).toContain("daynight worker attach");
    expect(f.calls.filter((call) => call.method === "agent.prompt")).toHaveLength(0);

    f.agents[0]!.agent_status = "idle";
    f.agents[0]!.interactive_ready = false;
    await f.driver.advance(f.input);
    await f.driver.advance(f.input);
    expect(f.events.map((event) => event.kind)).toEqual(["waiting"]);
    expect(f.calls.filter((call) => call.method === "agent.prompt")).toHaveLength(0);

    f.agents[0]!.interactive_ready = true;
    await f.driver.advance(f.input);
    await f.driver.advance(f.input);
    expect(f.events.map((event) => event.kind)).toEqual(["waiting", "reconnected"]);
    expect(f.calls.filter((call) => call.method === "agent.prompt")).toHaveLength(1);
    expect(f.launches).toHaveLength(1);
  });

  it("reports native identity discovery and changed terminal bindings without repeated stable polls", async () => {
    const f = await fixture("codex", null);
    delete f.panes[0]!.agent_session;
    const current: Entry = { ...f.panes[0], agent: "codex", name: herdrExecutionAgentName(f.context), agent_status: "working", interactive_ready: true, launch_pending: false, state_change_seq: 1, completion_seq: 0 };
    f.agents.push(current);
    await f.driver.advance(f.input);
    await f.driver.advance(f.input);
    expect(f.events.map((event) => event.task!.sessionId)).toEqual([null]);

    current.agent_session = { source: "herdr:codex", agent: "codex", kind: "id", value: staleId };
    await f.driver.advance(f.input);
    await f.driver.advance(f.input);
    expect(f.events.map((event) => event.task!.sessionId)).toEqual([null, staleId]);

    current.terminal_id = "replacement-terminal";
    f.panes[0]!.terminal_id = "replacement-terminal";
    await f.driver.advance(f.input);
    await f.driver.advance(f.input);
    expect(f.events.map((event) => event.kind)).toEqual(["reconnected", "reconnected", "reconnected"]);
    expect(f.calls.filter((call) => ["workspace.close", "workspace.create", "agent.start", "agent.prompt"].includes(call.method))).toEqual([]);
  });

  it("keeps interleaved task observations independent and forgets only the requested claim", async () => {
    const f = await fixture("codex", staleId);
    f.agents.push({ ...f.panes[0], agent: "codex", name: herdrExecutionAgentName(f.context), agent_status: "blocked", interactive_ready: true, launch_pending: false, state_change_seq: 1, completion_seq: 0 });
    const otherOwner = { ...f.input.owner, taskId: uuid(11), claimId: uuid(12), worktreeId: uuid(13) };
    const otherContext = { ...f.context, ...otherOwner, cwd: path.join(f.input.project.localPath, ".worktrees", "daynight", otherOwner.taskId) };
    await mkdir(otherContext.cwd, { recursive: true });
    const otherWorktree = { repositoryPath: f.input.project.localPath, commonDirectory: path.join(f.input.project.localPath, ".git"), worktreePath: otherContext.cwd, branch: `daynight/${otherOwner.taskId}` };
    const originalResolve = vi.mocked(f.dependencies.git.resolveWorktreeBinding).getMockImplementation()!;
    const originalVerify = vi.mocked(f.dependencies.git.prepareWorktree).getMockImplementation()!;
    vi.mocked(f.dependencies.git.resolveWorktreeBinding).mockImplementation((project, owner, operation) => owner.claimId === otherOwner.claimId ? Promise.resolve(otherWorktree) : originalResolve(project, owner, operation));
    vi.mocked(f.dependencies.git.prepareWorktree).mockImplementation((project, owner, operation) => owner.claimId === otherOwner.claimId ? Promise.resolve(otherWorktree) : originalVerify(project, owner, operation));
    f.store.registerPending({ ...otherOwner, agent: "codex", sessionId: staleId });
    const otherInput = { ...f.input, owner: otherOwner, task: f.store.activateTask(otherOwner) };
    f.workspaces.push({ workspace_id: "other-workspace", label: herdrExecutionLabel(otherContext, "Other task") });
    const otherPane = { workspace_id: "other-workspace", pane_id: "other-pane", terminal_id: "other-terminal", tab_id: "other-tab", cwd: otherContext.cwd, agent_status: "unknown" };
    f.panes.push(otherPane);
    f.agents.push({ ...otherPane, agent: "codex", name: herdrExecutionAgentName(otherContext), agent_status: "blocked", interactive_ready: true, launch_pending: false, state_change_seq: 1, completion_seq: 0, agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: staleId } });

    await f.driver.advance(f.input);
    await f.driver.advance(otherInput);
    await f.driver.advance(f.input);
    await f.driver.advance(otherInput);
    expect(f.events.map((event) => event.task!.taskId)).toEqual([f.input.task.taskId, otherInput.task.taskId]);
    f.driver.forget(f.input.task);
    await f.driver.advance(otherInput);
    await f.driver.advance(f.input);
    expect(f.events.map((event) => event.task!.taskId)).toEqual([f.input.task.taskId, otherInput.task.taskId, f.input.task.taskId]);
  });

  it("reports a new claim for the same task independently of the old claim", async () => {
    const f = await fixture("codex", staleId);
    const current = { ...f.panes[0], agent: "codex", name: herdrExecutionAgentName(f.context), agent_status: "blocked", interactive_ready: true, launch_pending: false, state_change_seq: 1, completion_seq: 0 };
    f.agents.push(current);
    await f.driver.advance(f.input);
    f.store.completeTask(f.input.task);
    const owner = { ...f.input.owner, claimId: uuid(12), worktreeId: uuid(13) };
    const context = { ...f.context, ...owner };
    f.store.registerPending({ ...owner, agent: "codex", sessionId: staleId });
    const input = { ...f.input, owner, task: f.store.activateTask(owner) };
    f.workspaces[0]!.label = herdrExecutionLabel(context, "Task execution");
    current.name = herdrExecutionAgentName(context);
    await f.driver.advance(input);
    await f.driver.advance(input);
    expect(f.events.map((event) => event.task!.claimId)).toEqual([f.input.task.claimId, input.task.claimId]);
  });

  it.each(["codex", "copilot"] as const)("uses current live %s state after scheduling observed an inactive pane", async (agent) => {
    const f = await fixture(agent, staleId);
    const scheduled = await f.resources();
    expect(scheduled[0]!.panes[0]!.kind).toBeNull();
    f.agents.push({ ...f.panes[0], agent, name: herdrExecutionAgentName(f.context), agent_status: "working", interactive_ready: true, launch_pending: false, state_change_seq: 1, completion_seq: 0 });
    const result = await f.driver.advance(f.input);
    expect(result.observation!.binding).toEqual(f.binding);
    expect(f.calls.filter((call) => ["workspace.close", "workspace.create", "agent.start", "agent.prompt"].includes(call.method))).toEqual([]);
  });

  it.each(["codex", "copilot"] as const)("keeps the saved %s session after a rejected resume and later mismatched live observation", async (agent) => {
    const f = await fixture(agent, savedId); f.reportOnLaunch(staleId);
    await expect(f.driver.advance(f.input)).rejects.toThrow(/native session/);
    expect(f.store.getTask(f.input.task)?.sessionId).toBe(savedId);
    await expect(f.driver.advance(f.input)).rejects.toThrow(/native session/);
    expect(f.store.getTask(f.input.task)?.sessionId).toBe(savedId);
    expect(f.calls.filter((call) => call.method === "agent.start")).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === "agent.prompt")).toEqual([]);
  });

  it.each(["codex", "copilot"] as const)("rejects a mismatched live %s session before sending a deferred first prompt", async (agent) => {
    const f = await fixture(agent, savedId); f.blockOnLaunch();
    const blocked = await f.driver.advance(f.input);
    expect(blocked.observation!.status).toBe("blocked"); expect(f.calls.filter((call) => call.method === "agent.prompt")).toEqual([]);
    f.agents[0]!.agent_status = "idle";
    f.agents[0]!.agent_session = { source: `herdr:${agent}`, agent, kind: "id", value: staleId };
    await expect(f.driver.advance(f.input)).rejects.toThrow(/native session/);
    expect(f.store.getTask(f.input.task)?.sessionId).toBe(savedId);
    expect(f.calls.filter((call) => call.method === "agent.prompt")).toEqual([]);
    expect(f.calls.filter((call) => call.method === "agent.start")).toHaveLength(1);
  });

  it.each(["codex", "copilot"] as const)("binds an unknown NULL session to a genuine live %s observation", async (agent) => {
    const f = await fixture(agent, null);
    f.agents.push({ ...f.panes[0], agent, name: herdrExecutionAgentName(f.context), agent_status: "working", interactive_ready: true, launch_pending: false, state_change_seq: 1, completion_seq: 0 });
    await f.driver.advance(f.input);
    expect(f.store.getTask(f.input.task)?.sessionId).toBe(staleId);
    expect(f.calls.filter((call) => ["workspace.close", "workspace.create", "agent.start", "agent.prompt"].includes(call.method))).toEqual([]);
  });

  it("settles the adapter's interrupted inactive stop before recreating from an empty snapshot", async () => {
    const f = await fixture("codex", null);
    const failure = new Error("close response lost"); f.failNextClose(failure); f.executing.add(100);
    const stopping = vi.spyOn(f.manager, "stopAndClose");
    await expect(f.driver.advance(f.input)).rejects.toMatchObject({ cause: failure });
    expect(f.launches).toEqual([]); expect(f.workspaces).toEqual([]); expect(f.manager.pendingStops()).toMatchObject([{ context: f.input.owner, binding: f.binding }]);
    const retry = f.driver.advance(f.input);
    await vi.waitFor(() => expect(stopping).toHaveBeenCalledTimes(2));
    expect(f.launches).toEqual([]);
    f.executing.delete(100);
    await retry;
    expect(f.store.getTask(f.input.task)?.sessionId).toBe(freshId); expect(f.manager.pendingStops()).toEqual([]);
  });

  it("preserves the adapter's stop responsibility after forgetting a pending startup prompt", async () => {
    const f = await fixture("copilot", null);
    const failure = new Error("close response lost"); f.failNextClose(failure); f.executing.add(100);
    const stopping = vi.spyOn(f.manager, "stopAndClose");
    await expect(f.driver.advance(f.input)).rejects.toMatchObject({ cause: failure });
    f.driver.forget(f.input.task);
    expect(f.manager.pendingStops()).toMatchObject([{ context: f.input.owner, binding: f.binding }]);
    f.executing.delete(100);
    await settleWorkerStops(f.dependencies, f.input.owner);
    expect(stopping).toHaveBeenCalledTimes(2); expect(f.manager.pendingStops()).toEqual([]); expect(f.launches).toEqual([]);
  });
});
