import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { createExecutionDriver, settleWorkerStops } from "../../../src/commands/worker/execution.js";
import type { ExecutionDependencies, ExecutionInput, WorkerEvent, WorkerGitManager } from "../../../src/commands/worker/execution.js";
import { createHerdrAgentManager, herdrExecutionAgentName, herdrExecutionLabel } from "../../../src/commands/worker/herdr/agents.js";
import type { HerdrExecutionContext, WorkerHerdrAdapter } from "../../../src/commands/worker/herdr.js";
import type { HerdrRpcClient, HerdrRpcResult } from "../../../src/commands/worker/herdr/rpc.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import type { ExecutionConfiguration, ResourceOwner, WorkerProject, WorktreeBinding } from "../../../src/commands/worker/types.js";

const uuid = (value: number): string => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const staleId = uuid(8);
const savedId = uuid(9);
const freshId = uuid(10);
type Entry = Record<string, unknown>;
const roots: string[] = [];
const stores: ReturnType<typeof openWorkerStore>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const fixture = async (agent: "codex" | "copilot", sessionId: string | null) => {
  const base = path.resolve("../../.tmp/execution-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "r-")); roots.push(root);
  const project: WorkerProject = { projectId: uuid(1), repoUrl: "https://example.test/owner/repo", localPath: path.join(root, "repo") };
  const owner: ResourceOwner = { serverOrigin: "https://daynight.example", projectId: project.projectId, taskId: uuid(2), claimId: uuid(3), worktreeId: uuid(4) };
  const cwd = path.join(project.localPath, ".worktrees", "daynight", owner.taskId); await mkdir(cwd, { recursive: true });
  const worktree: WorktreeBinding = { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: cwd, branch: `daynight/${owner.taskId}` };
  const configuration: ExecutionConfiguration = { agent, model: "current-model", args: [], recoveryLimit: 2 };
  const store = openWorkerStore(path.join(root, "state.sqlite")); stores.push(store); store.registerProject(project);
  store.registerPending({ ...owner, agent, sessionId }); const task = store.activateTask(owner);
  const context: HerdrExecutionContext = { ...owner, cwd, agent };
  const nativeEnvironment = { XDG_CONFIG_HOME: "/native/config", XDG_STATE_HOME: "/native/state" };
  const workerEnvironment = { XDG_CONFIG_HOME: "/worker/private/config", XDG_STATE_HOME: "/worker/private/state" };
  const binding = { session: "w", workspaceId: "restored-workspace", paneId: "restored-pane", terminalId: "restored-terminal" };
  const workspaces: Entry[] = [{ workspace_id: binding.workspaceId, label: herdrExecutionLabel(context) }];
  const panes: Entry[] = [{ workspace_id: binding.workspaceId, pane_id: binding.paneId, terminal_id: binding.terminalId, tab_id: "restored-tab", cwd, agent_status: "unknown", agent_session: { source: `herdr:${agent}`, agent, kind: "id", value: staleId } }];
  const agents: Entry[] = [];
  const environments = new Map<string, Entry>([[binding.paneId, workerEnvironment]]);
  const calls: { method: string; params: Entry }[] = [];
  const launches: { environment: Entry; args: readonly string[]; paneId: string }[] = [];
  let sequence = 0;
  const executing = new Set<number>();
  let closeFailure: Error | undefined;
  let hook: { paneId: string; sessionId: string; remaining: number } | undefined;
  const rpc: HerdrRpcClient = { request: async (method, params, operation): Promise<HerdrRpcResult> => {
    operation.check(); calls.push({ method, params: structuredClone(params) });
    if (method === "session.snapshot") {
      if (hook !== undefined && hook.remaining-- === 0) {
        agents.find((entry) => entry.pane_id === hook!.paneId)!.agent_session = { source: `herdr:${agent}`, agent, kind: "id", value: hook.sessionId };
        hook = undefined;
      }
      return { type: "session_snapshot", snapshot: structuredClone({ workspaces, panes, agents, tabs: [] }) };
    }
    if (method === "workspace.create") {
      sequence++; const workspace = { workspace_id: `new-workspace-${sequence}`, label: params.label };
      const pane = { workspace_id: workspace.workspace_id, pane_id: `new-pane-${sequence}`, terminal_id: `new-terminal-${sequence}`, tab_id: `new-tab-${sequence}`, cwd: params.cwd, agent_status: "unknown" };
      workspaces.push(workspace); panes.push(pane); environments.set(pane.pane_id, structuredClone(params.env as Entry));
      return { type: "workspace_created", workspace, root_pane: pane };
    }
    if (method === "workspace.close") {
      for (let index = workspaces.length - 1; index >= 0; index--) if (workspaces[index]!.workspace_id === params.workspace_id) workspaces.splice(index, 1);
      for (const collection of [panes, agents]) for (let index = collection.length - 1; index >= 0; index--) if (collection[index]!.workspace_id === params.workspace_id) collection.splice(index, 1);
      if (closeFailure !== undefined) { const failure = closeFailure; closeFailure = undefined; throw failure; }
      return { type: "ok" };
    }
    if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: params.pane_id, shell_pid: 100, foreground_processes: [{ pid: 100 }] } };
    if (method === "agent.start") {
      const pane = panes.find((entry) => entry.pane_id === params.pane_id)!;
      const current = { ...pane, agent, name: params.name, agent_status: "idle", interactive_ready: true, launch_pending: false, state_change_seq: 1, completion_seq: 0 };
      agents.push(current); launches.push({ environment: environments.get(String(params.pane_id))!, args: params.args as string[], paneId: String(params.pane_id) });
      return { type: "agent_started", agent: current, argv: [agent, ...params.args as string[]] };
    }
    if (method === "agent.read") {
      const pane = panes.find((entry) => entry.pane_id === params.target)!;
      return { type: "pane_read", read: { pane_id: pane.pane_id, workspace_id: pane.workspace_id, tab_id: pane.tab_id, source: "visible", format: "text", text: "› Ask Codex to do anything\n\n  GPT-6.1 Sol low · /task\n", revision: 0, truncated: false } };
    }
    if (method === "agent.prompt") {
      const current = agents.find((entry) => entry.pane_id === params.target)!;
      const args = launches.find((entry) => entry.paneId === params.target)!.args;
      const resume = agent === "codex" ? args[0] === "--no-daemon" && args[1] === "resume" ? args[2] : undefined : args.find((entry) => entry.startsWith("--resume="))?.slice("--resume=".length);
      hook = { paneId: String(params.target), sessionId: resume === undefined ? freshId : resume, remaining: 2 };
      return { type: "agent_prompted", agent: current };
    }
    throw new Error(`Unexpected RPC ${method}`);
  } };
  const manager = createHerdrAgentManager({ rpc, session: "w", preflight: { verifyStart: vi.fn(async () => {}) }, workspaceEnvironment: nativeEnvironment, processExecuting: async (pid) => executing.has(pid), pollIntervalMs: 1 });
  const events: WorkerEvent[] = [];
  const git = { prepareWorktree: vi.fn(async () => worktree), verifyWorktree: vi.fn(async () => worktree) } as unknown as WorkerGitManager;
  const dependencies: ExecutionDependencies = { store, git, herdr: { tasks: manager } as unknown as WorkerHerdrAdapter, platform: "linux", workerId: uuid(5), buildPrompt: vi.fn(() => "managed assignment"), emit: (event) => events.push(event), now: Date.now };
  const input: ExecutionInput = { task, project, owner, configuration };
  const resources = async () => { const operation = createOperation(); try { return await manager.listResources(operation); } finally { operation.dispose(); } };
  return { root, store, input, context, manager, resources, events, calls, launches, nativeEnvironment, workerEnvironment, workspaces, panes, agents, binding, dependencies, executing, failNextClose: (failure: Error) => { closeFailure = failure; }, driver: createExecutionDriver(dependencies) };
};

describe("execution from current Herdr resources", () => {
  it.each(["codex", "copilot"] as const)("replaces a cold inactive %s pane before a NULL-session fresh launch", async (agent) => {
    const f = await fixture(agent, null);
    const result = await f.driver.advance(f.input, await f.resources());
    expect(result.binding.workspaceId).not.toBe(f.binding.workspaceId);
    expect(f.calls.filter((call) => call.method === "workspace.close")).toHaveLength(1);
    expect(f.launches).toHaveLength(1); expect(f.launches[0]!.environment).toEqual(f.nativeEnvironment);
    expect(f.launches[0]!.args.some((arg) => arg === "resume" || arg.startsWith("--resume="))).toBe(false);
    expect(f.store.getTask(f.input.task)?.sessionId).toBe(freshId);
    expect(f.events.some((event) => event.kind === "warning")).toBe(true);
    expect(f.store.getTask(f.input.task)?.sessionId).not.toBe(staleId);
  });

  it.each(["codex", "copilot"] as const)("recreates a cold inactive %s workspace and resumes the saved ID", async (agent) => {
    const f = await fixture(agent, savedId);
    const result = await f.driver.advance(f.input, await f.resources());
    expect(result.nativeSession?.sessionId).toBe(savedId); expect(f.store.getTask(f.input.task)?.sessionId).toBe(savedId);
    expect(f.launches[0]!.environment).toEqual(f.nativeEnvironment);
    expect(f.launches[0]!.args).toContain(agent === "codex" ? savedId : `--resume=${savedId}`);
    expect(f.events.some((event) => event.kind === "warning")).toBe(false);
  });

  it.each(["codex", "copilot"] as const)("reconnects a live %s agent without replacing its workspace or sending a prompt", async (agent) => {
    const f = await fixture(agent, staleId);
    f.agents.push({ ...f.panes[0], agent, name: herdrExecutionAgentName(f.context), agent_status: "working", interactive_ready: true, launch_pending: false, state_change_seq: 1, completion_seq: 0 });
    const result = await f.driver.advance(f.input, await f.resources());
    expect(result.nativeSession?.sessionId).toBe(staleId);
    expect(f.calls.filter((call) => ["workspace.close", "workspace.create", "agent.start", "agent.prompt"].includes(call.method))).toEqual([]);
  });

  it("settles the adapter's interrupted inactive stop before recreating from an empty snapshot", async () => {
    const f = await fixture("codex", null);
    const failure = new Error("close response lost"); f.failNextClose(failure); f.executing.add(100);
    const stopping = vi.spyOn(f.manager, "stopAndClose");
    await expect(f.driver.advance(f.input, await f.resources())).rejects.toMatchObject({ cause: failure });
    expect(f.launches).toEqual([]); expect(f.workspaces).toEqual([]); expect(f.manager.pendingStops()).toMatchObject([{ context: f.input.owner, binding: f.binding }]);
    const retry = f.driver.advance(f.input, await f.resources());
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
    await expect(f.driver.advance(f.input, await f.resources())).rejects.toMatchObject({ cause: failure });
    f.driver.forget(f.input.task);
    expect(f.manager.pendingStops()).toMatchObject([{ context: f.input.owner, binding: f.binding }]);
    f.executing.delete(100);
    await settleWorkerStops(f.dependencies, f.input.owner);
    expect(stopping).toHaveBeenCalledTimes(2); expect(f.manager.pendingStops()).toEqual([]); expect(f.launches).toEqual([]);
  });
});
