import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOperation, OperationError } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import { buildHerdrAgentArguments, createHerdrAgentManager, HerdrAgentActionError, herdrExecutionAgentName, herdrExecutionLabel, parseHerdrExecutionLabel, validateHerdrAgentArguments } from "../../../src/commands/worker/herdr/agents.js";
import type { HerdrAgentConfiguration, HerdrExecutionContext, HerdrPromptReceipt, HerdrTaskBinding, HerdrWorkspaceEnvironment } from "../../../src/commands/worker/herdr/agents.js";
import { codexProjectTrustArguments } from "../../../src/commands/worker/herdr/arguments.js";
import { HerdrRpcError } from "../../../src/commands/worker/herdr/rpc.js";
import type { HerdrRpcClient, HerdrRpcResult } from "../../../src/commands/worker/herdr/rpc.js";

type Entry = Record<string, unknown>;
const directories: string[] = [];
const operations: Operation[] = [];
const operation = (totalMs = 10_000): Operation => { const value = createOperation({ limits: { totalMs } }); operations.push(value); return value; };
afterEach(async () => { operations.splice(0).forEach((value) => value.dispose()); await Promise.all(directories.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });

const taskTitle = "Repair worker startup";
const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const claimId = "33333333-3333-4333-8333-333333333333";
const worktreeId = "44444444-4444-4444-8444-444444444444";
const nativeId = "55555555-5555-4555-8555-555555555555";
const configuration: HerdrAgentConfiguration = { agent: "codex", model: "model-a", args: ["--config", "model_reasoning_effort=low", "--no-alt-screen"] };
const composerScreen = "  >_ OpenAI Codex (v0.164.0)\n\n› Ask Codex to do anything\n\n  GPT-6.1 Sol default · /task\n";
const trustScreen = "  Folder access\n  /task\n\n  Trust this folder? Codex can read, edit, and run files here.\n\n› 1. Trust and continue\n  2. Quit\n\n  enter continue · esc quit\n";

const fixture = async (kind: "codex" | "copilot" | "claude" = "codex", workspaceEnvironment = { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" }) => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/herdr-agent-tests"); await mkdir(scratch, { recursive: true });
  const cwd = await mkdtemp(path.join(scratch, "task-")); directories.push(cwd);
  const context: HerdrExecutionContext = { projectId, taskId, claimId, worktreeId, cwd, agent: kind };
  const workspaces: Entry[] = [];
  const panes: Entry[] = [];
  const agents: Entry[] = [];
  const tabs: Entry[] = [];
  const calls: { method: string; params: Entry }[] = [];
  const prompts: string[] = [];
  const processes = new Map<string, number[]>();
  const executing = new Set<number>([200]);
  let next = 0;
  let preflights = 0;
  const closeProcesses = { terminate: true };
  let hook: ((method: string, params: Entry) => Promise<HerdrRpcResult | undefined>) | undefined;
  const snapshot = (): HerdrRpcResult => ({ type: "session_snapshot", snapshot: structuredClone({ workspaces, panes, agents, tabs, layouts: [] }) });
  const addPane = (workspace: Entry, tabLabel: string) => {
    const ordinal = ++next;
    const tab = { tab_id: `tab-${ordinal}`, workspace_id: workspace.workspace_id, label: tabLabel };
    const pane = { pane_id: `pane-${ordinal}`, terminal_id: `terminal-${ordinal}`, workspace_id: workspace.workspace_id, tab_id: tab.tab_id, cwd, agent_status: "unknown" };
    tabs.push(tab); panes.push(pane); processes.set(pane.pane_id, [100]);
    return { tab, pane };
  };
  const launch = (params: Entry): Entry => {
    const pane = panes.find((value) => value.pane_id === params.pane_id)!;
    const agent = { ...pane, agent: kind, name: params.name, agent_status: "unknown", interactive_ready: true, launch_pending: false, state_change_seq: 7, agent_session: { source: `herdr:${kind}`, agent: kind, kind: "id", value: nativeId } };
    agents.splice(0, agents.length, agent); processes.set(String(pane.pane_id), [100, 200]);
    return agent;
  };
  const rpc: HerdrRpcClient = { request: async (method, params, op) => {
    op.check(); calls.push({ method, params: structuredClone(params) });
    const overridden = await hook?.(method, params); if (overridden !== undefined) return overridden;
    if (method === "session.snapshot") return snapshot();
    if (method === "workspace.create") {
      const workspace = { workspace_id: `workspace-${next + 1}`, label: params.label };
      workspaces.push(workspace); const created = addPane(workspace, "task");
      return { type: "workspace_created", workspace, tab: created.tab, root_pane: created.pane };
    }
    if (method === "workspace.rename") {
      const workspace = workspaces.find((value) => value.workspace_id === params.workspace_id)!;
      workspace.label = params.label;
      return { type: "workspace_info", workspace: structuredClone(workspace) };
    }
    if (method === "agent.start") return { type: "agent_started", agent: launch(params), argv: [kind, ...params.args as string[]] };
    if (method === "agent.prompt") { prompts.push(String(params.text)); return { type: "agent_prompted", agent: structuredClone(agents.find((value) => value.pane_id === params.target)) }; }
    if (method === "agent.read") {
      const pane = panes.find((value) => value.pane_id === params.target)!;
      return { type: "pane_read", read: { pane_id: pane.pane_id, workspace_id: pane.workspace_id, tab_id: pane.tab_id, source: "visible", format: "text", text: composerScreen, revision: 0, truncated: false } };
    }
    if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: params.pane_id, shell_pid: 100, foreground_process_group_id: 100, foreground_processes: (processes.get(String(params.pane_id)) ?? []).map((value) => ({ pid: value, name: value === 100 ? "shell" : kind })) } };
    if (method === "tab.create") {
      const workspace = workspaces.find((value) => value.workspace_id === params.workspace_id)!; const created = addPane(workspace, String(params.label));
      return { type: "tab_created", tab: created.tab, root_pane: created.pane };
    }
    if (method === "pane.close") {
      panes.splice(panes.findIndex((value) => value.pane_id === params.pane_id), 1); agents.splice(0, agents.length); return { type: "ok" };
    }
    if (method === "workspace.close") {
      workspaces.splice(workspaces.findIndex((value) => value.workspace_id === params.workspace_id), 1);
      for (let index = panes.length - 1; index >= 0; index -= 1) if (panes[index]!.workspace_id === params.workspace_id) {
        if (closeProcesses.terminate) for (const process of processes.get(String(panes[index]!.pane_id)) ?? []) executing.delete(process);
        panes.splice(index, 1);
      }
      for (let index = agents.length - 1; index >= 0; index -= 1) if (agents[index]!.workspace_id === params.workspace_id) agents.splice(index, 1);
      for (let index = tabs.length - 1; index >= 0; index -= 1) if (tabs[index]!.workspace_id === params.workspace_id) tabs.splice(index, 1);
      return { type: "ok" };
    }
    throw new Error(`Unexpected fixture method ${method}`);
  } };
  const manager = createHerdrAgentManager({ rpc, session: "w", preflight: { verifyStart: async () => { preflights += 1; } }, workspaceEnvironment, processExecuting: async (value) => executing.has(value), pollIntervalMs: 1 });
  return { context, manager, workspaces, panes, agents, tabs, calls, prompts, processes, executing, closeProcesses, rpc, snapshot, launch, hook: (value: typeof hook) => { hook = value; }, preflights: () => preflights };
};
const launch = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
  const result = await f.manager.start(f.context, binding, { configuration: { ...configuration, agent: f.context.agent, args: f.context.agent === "codex" ? configuration.args : ["--allow-all-tools"] }, prompt: "initial" }, operation());
  expect(result.nativeSession?.sessionId).toBe(nativeId); return binding;
};

describe("native argument ownership", () => {
  it.each([undefined, nativeId])("owns full access while preserving model/configuration/exact resume selection (%s)", (resume) => {
    expect(buildHerdrAgentArguments(configuration, "/task", resume)).toEqual(["--no-daemon", ...(resume === undefined ? [] : ["resume", resume]), "--model", "model-a", ...configuration.args, "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", ...codexProjectTrustArguments("/task")]);
    expect(buildHerdrAgentArguments({ agent: "copilot", model: null, args: ["--allow-tool=shell(git:*)", "--reasoning-effort", "low"] }, "/task", resume)).toEqual([...(resume === undefined ? [] : [`--resume=${resume}`]), "--allow-tool=shell(git:*)", "--reasoning-effort", "low", "--allow-all", "--no-ask-user", "--no-sandbox"]);
  });
  it.each(['/repo/.worktrees/task.name', '/repo/中文/"quoted"', 'C:\\repo\\.worktrees\\中文 "task"'])('encodes the exact trust path in a final inline TOML table: %s', (cwd) => {
    const args = buildHerdrAgentArguments({ ...configuration, args: ["-c", 'projects={"other"={trust_level="untrusted"}}', "-c", 'approval_policy="on-request"', "--profile", "work"] }, cwd);
    const trust = codexProjectTrustArguments(cwd, "linux").at(-1)!;
    expect(args.at(-2)).toBe("-c");
    expect(trust.startsWith("projects={")).toBe(true);
    expect(trust.endsWith('={trust_level="trusted"}}')).toBe(true);
    expect(JSON.parse(trust.slice("projects={".length, -'={trust_level="trusted"}}'.length))).toBe(cwd);
    expect(args.slice(3, 9)).toEqual(["-c", 'projects={"other"={trust_level="untrusted"}}', "-c", 'approval_policy="on-request"', "--profile", "work"]);
  });
  it.each([
    [String.raw`C:\Repo\.Worktrees\ÄΩ中`, String.raw`c:\repo\.worktrees\ÄΩ中`, String.raw`\\?\c:\repo\.worktrees\ÄΩ中`],
    [String.raw`\\?\C:\Repo\.Worktrees\ÄΩ中`, String.raw`c:\repo\.worktrees\ÄΩ中`, String.raw`\\?\c:\repo\.worktrees\ÄΩ中`],
    [String.raw`\\Server\Share\Repo`, String.raw`\\server\share\repo`, String.raw`\\?\unc\server\share\repo`],
    [String.raw`\\?\UNC\Server\Share\Repo`, String.raw`\\server\share\repo`, String.raw`\\?\unc\server\share\repo`],
    [String.raw`C:\Repo\${"LongPath".repeat(40)}`, String.raw`c:\repo\${"longpath".repeat(40)}`, String.raw`\\?\c:\repo\${"longpath".repeat(40)}`],
  ])("targets Codex's exact Windows trust keys for %s", (cwd, regularKey, namespacedKey) => {
    expect(codexProjectTrustArguments(cwd, "win32")).toEqual(["-c", `projects={${JSON.stringify(regularKey)}={trust_level="trusted"},${JSON.stringify(namespacedKey)}={trust_level="trusted"}}`]);
  });
  it.each(["linux", "darwin"] as const)("preserves case-sensitive trust keys on %s", (platform) => {
    expect(codexProjectTrustArguments("/Repo/ÄΩ中/.Worktrees/Task", platform)).toEqual(["-c", 'projects={"/Repo/ÄΩ中/.Worktrees/Task"={trust_level="trusted"}}']);
  });
  it("deduplicates unchanged Windows device spellings", () => {
    expect(codexProjectTrustArguments(String.raw`\\.\Device\Volume`, "win32")).toEqual(["-c", `projects={${JSON.stringify(String.raw`\\.\device\volume`)}={trust_level="trusted"}}`]);
  });
  it.each(["resume", "a positional prompt", "--model=x", "-m", "--cd", "--no-daemon", "--worktree", "--remote=x", "--help", "-a", "--ask-for-approval=never", "-s", "--sandbox=read-only", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust"])("refuses Codex-owned/positional argument %s", (value) => {
    expect(() => validateHerdrAgentArguments("codex", [value])).toThrow();
  });
  it.each(["-p", "--prompt=execute", "-i", "--interactive=execute", "--resume=x", "--continue", "--session-id=x", "-C", "--mode=autopilot", "--autopilot", "--fleet", "--plan", "--assisted-approval", "--sandbox", "--deny-tool=shell", "--deny-url=*", "--available-tools=shell", "--excluded-tools=shell"])("refuses Copilot-owned argument %s", (value) => {
    expect(() => validateHerdrAgentArguments("copilot", [value])).toThrow();
  });
  it("rejects hidden option values, control characters, unknown flags and ambiguous variadic options", () => {
    expect(() => validateHerdrAgentArguments("codex", ["--config", "--model=x"])).toThrow();
    expect(() => validateHerdrAgentArguments("codex", ["--config", "x=one\ntwo"])).toThrow();
    expect(() => validateHerdrAgentArguments("copilot", ["--allow-tool", "shell(git:*)"])).toThrow("=value");
    expect(() => buildHerdrAgentArguments({ ...configuration, model: "x\ny" }, "/task")).toThrow();
    expect(() => buildHerdrAgentArguments(configuration, "/task", "prefix")).toThrow("exact original session UUID");
    expect(() => buildHerdrAgentArguments(configuration, "relative")).toThrow("absolute path");
  });
});

describe("direct task resource management", () => {
  const visible = (f: Awaited<ReturnType<typeof fixture>>, binding: HerdrTaskBinding, screen: string, extra: Entry = {}): HerdrRpcResult => ({ type: "pane_read", read: { pane_id: binding.paneId, workspace_id: binding.workspaceId, tab_id: f.panes.find((pane) => pane.pane_id === binding.paneId)!.tab_id, source: "visible", format: "text", text: screen, revision: 0, truncated: false, ...extra } });

  it("creates one workspace with native XDG settings and rediscovers it without receipts", async () => {
    const environment = { XDG_CONFIG_HOME: "/native/config", XDG_STATE_HOME: "/native/state" };
    const f = await fixture("codex", environment); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    expect(await f.manager.prepareWorkspace(f.context, taskTitle, operation())).toEqual(binding);
    expect(f.calls.filter((call) => call.method === "workspace.create")).toEqual([{ method: "workspace.create", params: { cwd: f.context.cwd, focus: false, label: herdrExecutionLabel(f.context, taskTitle), env: environment } }]);
    expect(parseHerdrExecutionLabel(String(f.workspaces[0]!.label))).toMatchObject({ projectId, taskId, claimId, worktreeId });
    expect(herdrExecutionAgentName(f.context)).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });

  it("renames an existing live workspace without changing native identity or rediscoverability", async () => {
    const f = await fixture(); const binding = await launch(f);
    const name = f.agents[0]!.name;
    const newTitle = '修复中文任务 👨‍👩‍👧‍👦 | daynight:{"title":"literal"}';
    await f.manager.syncWorkspaceName(f.context, binding, newTitle, operation());
    expect(f.workspaces[0]!.label).toBe(herdrExecutionLabel(f.context, newTitle));
    expect(f.agents[0]!.name).toBe(name);
    expect(await f.manager.observe(f.context, binding, operation())).toMatchObject({ name, nativeSession: { sessionId: nativeId } });
    expect(await f.manager.prepareWorkspace(f.context, "another title", operation())).toEqual(binding);
    expect(await f.manager.listResources(operation())).toMatchObject([{ owner: { projectId, taskId, claimId, worktreeId }, workspaceId: binding.workspaceId }]);
    await f.manager.syncWorkspaceName(f.context, binding, newTitle, operation());
    expect(f.calls.filter((call) => call.method === "workspace.rename")).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === "agent.start")).toHaveLength(1);
    expect(f.prompts).toEqual(["initial"]);
    await f.manager.stopAndClose(f.context, binding, operation());
    expect(f.workspaces).toEqual([]);
  });

  it("observes a lost rename result before considering another rename", async () => {
    const f = await fixture(); const binding = await launch(f);
    const failure = new HerdrRpcError("rename result lost", { method: "workspace.rename", requestId: "rename", submission: "unknown" });
    f.hook(async (method, params) => {
      if (method !== "workspace.rename") return undefined;
      f.workspaces[0]!.label = params.label;
      throw failure;
    });
    await expect(f.manager.syncWorkspaceName(f.context, binding, "New title", operation())).rejects.toMatchObject({ action: "workspace.rename", submission: "unknown", cause: failure });
    await f.manager.syncWorkspaceName(f.context, binding, "New title", operation());
    expect(f.calls.filter((call) => call.method === "workspace.rename")).toHaveLength(1);
  });

  it("keeps a failed confirmation snapshot outside execution after a successful rename", async () => {
    const f = await fixture(); const binding = await launch(f);
    const failure = new HerdrRpcError("confirmation snapshot lost", { method: "session.snapshot", requestId: "snapshot", submission: "unknown" });
    let renamed = false;
    f.hook(async (method, params) => {
      if (method === "workspace.rename") {
        renamed = true;
        f.workspaces[0]!.label = params.label;
        return { type: "workspace_info", workspace: structuredClone(f.workspaces[0]) };
      }
      if (method === "session.snapshot" && renamed) { renamed = false; throw failure; }
      return undefined;
    });
    await expect(f.manager.syncWorkspaceName(f.context, binding, "New title", operation())).rejects.toMatchObject({ action: "workspace.rename", submission: "unknown", cause: failure });
    expect(await f.manager.observe(f.context, binding, operation())).toMatchObject({ nativeSession: { sessionId: nativeId } });
    await f.manager.syncWorkspaceName(f.context, binding, "New title", operation());
    expect(f.calls.filter((call) => call.method === "workspace.rename")).toHaveLength(1);
  });

  it.each([
    new HerdrRpcError("name observation unavailable", { method: "session.snapshot", requestId: "snapshot", submission: "unknown" }),
    new OperationError("deadline"),
  ])("classifies a failed pre-rename snapshot without claiming rename submission: %s", async (failure) => {
    const f = await fixture(); const binding = await launch(f);
    f.hook(async (method) => { if (method === "session.snapshot") throw failure; return undefined; });
    await expect(f.manager.syncWorkspaceName(f.context, binding, "New title", operation())).rejects.toMatchObject({ action: "workspace.rename", submission: "not-submitted", cause: failure });
    expect(f.calls.filter((call) => call.method === "workspace.rename")).toEqual([]);
  });

  it("preserves cancellation during a name ownership observation", async () => {
    const f = await fixture(); const binding = await launch(f);
    const controller = new AbortController(); const op = createOperation({ signal: controller.signal }); operations.push(op);
    const failure = new HerdrRpcError("snapshot cancelled", { method: "session.snapshot", requestId: "snapshot", submission: "not-submitted" });
    f.hook(async (method) => { if (method === "session.snapshot") { controller.abort(new Error("stop name update")); throw failure; } return undefined; });
    await expect(f.manager.syncWorkspaceName(f.context, binding, "New title", op)).rejects.toBe(failure);
    expect(f.calls.filter((call) => call.method === "workspace.rename")).toEqual([]);
  });

  it.each([{ type: "ok" }, { type: "workspace_info" }, { type: "workspace_info", workspace: {} }])("classifies a malformed rename receipt as an unknown naming outcome: %j", async (result) => {
    const f = await fixture(); const binding = await launch(f);
    f.hook(async (method) => method === "workspace.rename" ? result : undefined);
    await expect(f.manager.syncWorkspaceName(f.context, binding, "New title", operation())).rejects.toMatchObject({ action: "workspace.rename", submission: "unknown" });
    expect(await f.manager.observe(f.context, binding, operation())).toMatchObject({ nativeSession: { sessionId: nativeId } });
  });

  it("does not submit a rename once the operation is cancelled", async () => {
    const f = await fixture(); const binding = await launch(f);
    const controller = new AbortController(); controller.abort(new Error("cancel name update"));
    const op = createOperation({ signal: controller.signal }); operations.push(op);
    await expect(f.manager.syncWorkspaceName(f.context, binding, "New title", op)).rejects.toMatchObject({ kind: "cancelled" });
    expect(f.calls.filter((call) => call.method === "workspace.rename")).toEqual([]);
  });

  it("rejects ownership changed during a rename as a lifecycle error", async () => {
    const f = await fixture(); const binding = await launch(f);
    f.hook(async (method) => {
      if (method !== "workspace.rename") return undefined;
      f.workspaces[0]!.label = herdrExecutionLabel({ ...f.context, claimId: projectId }, "Foreign claim");
      return { type: "workspace_info", workspace: f.workspaces[0] };
    });
    const failure = await f.manager.syncWorkspaceName(f.context, binding, "New title", operation()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(HerdrAgentActionError);
  });

  it("keeps ownership and terminal replacement errors distinct from cosmetic rename failures", async () => {
    const f = await fixture(); const binding = await launch(f);
    f.panes[0]!.terminal_id = "replacement";
    const failure = await f.manager.syncWorkspaceName(f.context, binding, "New title", operation()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(HerdrAgentActionError);
    expect(f.calls.filter((call) => call.method === "workspace.rename")).toEqual([]);
  });

  it("rejects duplicate identities even when their displayed titles differ", async () => {
    const f = await fixture(); await launch(f);
    f.workspaces.push({ workspace_id: "duplicate", label: herdrExecutionLabel(f.context, "Different title") });
    await expect(f.manager.listResources(operation())).rejects.toThrow("duplicate identities");
    await expect(f.manager.prepareWorkspace(f.context, taskTitle, operation())).rejects.toThrow("identity is duplicated");
  });

  it("keeps process-stop responsibility after the title changes between close attempts", async () => {
    const f = await fixture(); const binding = await launch(f); f.closeProcesses.terminate = false;
    const failure = new HerdrRpcError("close rejected", { method: "workspace.close", requestId: "close", submission: "not-submitted" });
    let closeAttempts = 0;
    f.hook(async (method) => { if (method === "workspace.close" && ++closeAttempts === 1) throw failure; return undefined; });
    await expect(f.manager.stopAndClose(f.context, binding, operation())).rejects.toMatchObject({ cause: failure });
    f.workspaces[0]!.label = herdrExecutionLabel(f.context, "Renamed while awaiting stop");
    await expect(f.manager.stopAndClose(f.context, binding, operation(25))).rejects.toMatchObject({ kind: "deadline" });
    expect(f.manager.pendingStops()).toHaveLength(1);
    f.executing.delete(200);
    await f.manager.stopAndClose(f.context, binding, operation());
    expect(f.manager.pendingStops()).toEqual([]);
  });

  it("sets Copilot's permission environment on every new task workspace", async () => {
    const f = await fixture("copilot");
    await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    expect(f.calls.find((call) => call.method === "workspace.create")!.params.env).toEqual({ XDG_CONFIG_HOME: "", XDG_STATE_HOME: "", COPILOT_ALLOW_ALL: "true", COPILOT_ASSISTED_APPROVAL: "false" });
  });

  it("trusts the canonical working directory when the task path traverses a symlink", async () => {
    const f = await fixture(); const canonicalCwd = await realpath(f.context.cwd);
    const alias = path.join(f.context.cwd, "linked"); await symlink(canonicalCwd, alias, "junction"); f.context.cwd = alias;
    await launch(f);
    expect((f.calls.find((call) => call.method === "agent.start")!.params.args as string[]).at(-1)).toBe(codexProjectTrustArguments(canonicalCwd).at(-1));
  });

  it.each(["codex", "copilot"] as const)("rejects conflicting %s permissions before any native-start RPC", async (agent) => {
    const f = await fixture(agent); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation()); f.calls.splice(0);
    const args = agent === "codex" ? ["--sandbox", "workspace-write"] : ["--deny-tool=shell"];
    await expect(f.manager.start(f.context, binding, { configuration: { ...configuration, agent, args }, prompt: "assignment" }, operation())).rejects.toThrow("owned by the worker");
    expect(f.calls).toEqual([]); expect(f.preflights()).toBe(0);
  });

  it.each(["codex", "copilot"] as const)("starts %s with exact caller configuration and saves no execution receipt", async (kind) => {
    const f = await fixture(kind); const binding = await launch(f);
    expect(f.prompts).toEqual(["initial"]); expect(f.preflights()).toBe(1);
    expect(await f.manager.observe(f.context, binding, operation())).toMatchObject({ kind, nativeSession: { agent: kind, sessionId: nativeId } });
    expect(await f.manager.listResources(operation())).toMatchObject([{ owner: { projectId, taskId, claimId }, panes: [{ binding, nativeSession: { sessionId: nativeId } }] }]);
  });

  it.each(["codex", "copilot"] as const)("passes a known %s session directly to native resume without looking up history", async (kind) => {
    const f = await fixture(kind); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    const config: HerdrAgentConfiguration = { agent: kind, model: "current-model", args: [] };
    const result = await f.manager.start(f.context, binding, { configuration: config, prompt: "continue task", resumeSessionId: nativeId }, operation());
    expect(result.nativeSession?.sessionId).toBe(nativeId);
    expect(f.calls.find((call) => call.method === "agent.start")!.params.args).toEqual(buildHerdrAgentArguments(config, await realpath(f.context.cwd), nativeId));
    expect(f.prompts).toEqual(["continue task"]);
  });

  it("reconnects a surviving native process without launching or sending the assignment again", async () => {
    const f = await fixture(); const binding = await launch(f);
    let submissions = 0;
    await f.manager.start(f.context, binding, { configuration, prompt: "must not repeat", onPromptSubmitted: () => { submissions++; } }, operation());
    expect(submissions).toBe(0);
    expect(f.calls.filter((call) => call.method === "agent.start")).toHaveLength(1);
    expect(f.prompts).toEqual(["initial"]); expect(f.preflights()).toBe(1);
  });

  it("reports the acknowledged pre-input observation before startup discovers a completed turn", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    const receipts: HerdrPromptReceipt[] = [];
    f.hook(async (method, params) => {
      if (method === "agent.prompt") {
        f.prompts.push(String(params.text));
        const current = f.agents[0]!;
        current.agent_status = "idle"; current.state_change_seq = 9; current.completion_seq = 1;
        return { type: "agent_prompted", agent: current };
      }
      if (method === "session.snapshot" && f.prompts.length > 0) expect(receipts).toHaveLength(1);
      return undefined;
    });
    const result = await f.manager.start(f.context, binding, { configuration, prompt: "short turn", onPromptSubmitted: (receipt) => { receipts.push(receipt); } }, operation());
    expect(receipts).toMatchObject([{ submission: "submitted", observation: { status: "unknown", stateChangeSeq: 7, completionSeq: null } }]);
    expect(result).toMatchObject({ status: "idle", stateChangeSeq: 9, completionSeq: 1, nativeSession: { sessionId: nativeId } });
  });

  it("observes a native process after an unknown start response without replaying the launch", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    const failure = new HerdrRpcError("start response lost", { method: "agent.start", requestId: "request", submission: "unknown" });
    f.hook(async (method, params) => { if (method === "agent.start") { f.launch(params); throw failure; } return undefined; });
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "assignment" }, operation())).rejects.toMatchObject({ submission: "unknown", cause: failure });
    expect((await f.manager.start(f.context, binding, { configuration, prompt: "assignment" }, operation())).nativeSession?.sessionId).toBe(nativeId);
    expect(f.calls.filter((call) => call.method === "agent.start")).toHaveLength(1); expect(f.prompts).toEqual([]);
  });

  it("serializes concurrent starts against the same pane", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    await Promise.all([f.manager.start(f.context, binding, { configuration, prompt: "first" }, operation()), f.manager.start(f.context, binding, { configuration, prompt: "second" }, operation())]);
    expect(f.calls.filter((call) => call.method === "agent.start")).toHaveLength(1); expect(f.prompts).toEqual(["first"]);
  });

  it("observes SessionStart emitted only after the first native input", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    f.hook(async (method, params) => {
      if (method === "agent.start") { const agent = f.launch(params); delete agent.agent_session; return { type: "agent_started", agent, argv: ["codex", ...params.args as string[]] }; }
      if (method === "agent.prompt") { f.prompts.push(String(params.text)); f.agents[0]!.agent_session = { source: "herdr:codex", agent: "codex", kind: "id", value: nativeId }; return { type: "agent_prompted", agent: f.agents[0] }; }
      return undefined;
    });
    expect((await f.manager.start(f.context, binding, { configuration, prompt: "first managed assignment" }, operation())).nativeSession?.sessionId).toBe(nativeId);
    expect(f.prompts).toEqual(["first managed assignment"]);
  });

  it("reports a native resume that identifies another session", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "continue", resumeSessionId: "66666666-6666-4666-8666-666666666666" }, operation())).rejects.toThrow("different native session");
    expect(f.prompts).toEqual([]);
  });

  it("reports a definitely unsent startup prompt while the current native process is blocked", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    f.hook(async (method, params) => { if (method !== "agent.start") return undefined; const agent = f.launch(params); agent.agent_status = "blocked"; return { type: "agent_started", agent, argv: ["codex", ...params.args as string[]] }; });
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "task" }, operation())).rejects.toMatchObject({ action: "agent.prompt", submission: "not-submitted", promptSubmission: "not-submitted" }); expect(f.prompts).toEqual([]);
  });

  it("can submit a process-local deferred first prompt before SessionStart has reported an ID", async () => {
    const f = await fixture(); const binding = await launch(f); f.prompts.splice(0); delete f.agents[0]!.agent_session;
    await f.manager.submitPrompt(f.context, binding, "deferred assignment", operation());
    expect(f.prompts).toEqual(["deferred assignment"]);
    f.agents[0]!.interactive_ready = false;
    await expect(f.manager.submitPrompt(f.context, binding, "must wait", operation())).rejects.toMatchObject({ submission: "not-submitted" });
    expect(f.prompts).toEqual(["deferred assignment"]);
  });

  it("retains definite non-submission when cancellation interrupts readiness after a launch", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    const controller = new AbortController(); const op = createOperation({ signal: controller.signal }); operations.push(op);
    f.hook(async (method, params) => {
      if (method === "agent.start") { const agent = f.launch(params); agent.launch_pending = true; agent.interactive_ready = false; return { type: "agent_started", agent, argv: ["codex", ...params.args as string[]] }; }
      if (method === "session.snapshot" && f.agents.length > 0) controller.abort(new Error("stop readiness waiting"));
      return undefined;
    });
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "not submitted" }, op)).rejects.toMatchObject({ action: "agent.prompt", submission: "not-submitted", promptSubmission: "not-submitted", cause: { kind: "cancelled" } });
    expect(f.prompts).toEqual([]); expect(f.calls.filter((call) => call.method === "agent.start")).toHaveLength(1);
  });

  it("rejects false idle/readiness on a real folder trust screen", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    f.hook(async (method) => method === "agent.read" ? visible(f, binding, trustScreen) : undefined);
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "must not accept trust" }, operation())).rejects.toMatchObject({ action: "agent.prompt", submission: "not-submitted", promptSubmission: "not-submitted" });
    expect(f.prompts).toEqual([]); expect(f.calls.filter((call) => call.method === "agent.start")).toHaveLength(1);
  });

  it.each(["› Ask Codex to do anything", "» Ask Codex to do anything", "› Ask a follow-up question"])("accepts the current native composer %s", async (marker) => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    f.hook(async (method) => method === "agent.read" ? visible(f, binding, composerScreen.replace("› Ask Codex to do anything", marker)) : undefined);
    await f.manager.start(f.context, binding, { configuration, prompt: "exact\ntext" }, operation()); expect(f.prompts).toEqual(["exact\ntext"]);
  });

  it("waits through provisional frames during the current operation", async () => {
    const f = await fixture(); const binding = await launch(f); f.prompts.splice(0); let reads = 0;
    f.hook(async (method) => method === "agent.read" ? visible(f, binding, ++reads < 4 ? "initializing" : composerScreen) : undefined);
    await f.manager.submitPrompt(f.context, binding, "cleanup", operation()); expect(reads).toBe(4); expect(f.prompts).toEqual(["cleanup"]);
  });

  it("preserves input errors and sends nothing when readiness observation expires", async () => {
    const f = await fixture(); const binding = await launch(f); f.prompts.splice(0);
    f.hook(async (method) => method === "agent.read" ? visible(f, binding, "Resuming session…") : undefined);
    await expect(f.manager.submitPrompt(f.context, binding, "cleanup", operation(25))).rejects.toMatchObject({ action: "agent.prompt", submission: "not-submitted", cause: { kind: "deadline" } }); expect(f.prompts).toEqual([]);
  });

  it.each(["› 1. Yes, proceed\n  2. No\n\nPress enter to confirm or esc to cancel", "Input disabled", "Viewing sub-agent thread"])("keeps current modal or disabled surface interactive: %s", async (screen) => {
    const f = await fixture(); const binding = await launch(f); f.prompts.splice(0); f.agents[0]!.agent_status = "working";
    f.hook(async (method) => method === "agent.read" ? visible(f, binding, screen) : undefined);
    await expect(f.manager.submitPrompt(f.context, binding, "cleanup", operation())).rejects.toMatchObject({ action: "agent.prompt", submission: "not-submitted" }); expect(f.prompts).toEqual([]);
  });

  it.each([{ pane_id: "foreign" }, { workspace_id: "foreign" }, { tab_id: "foreign" }, { source: "recent" }, { format: "ansi" }, { revision: undefined }, { truncated: undefined }, { truncated: true }, { text: undefined }])("rejects invalid visible native input %j", async (extra) => {
    const f = await fixture(); const binding = await launch(f); f.prompts.splice(0); f.agents[0]!.agent_status = "working";
    f.hook(async (method) => method === "agent.read" ? visible(f, binding, composerScreen, extra) : undefined);
    await expect(f.manager.submitPrompt(f.context, binding, "cleanup", operation())).rejects.toMatchObject({ action: "agent.prompt", submission: "not-submitted" }); expect(f.prompts).toEqual([]);
  });

  it("does not input after the pane's terminal changes during a screen observation", async () => {
    const f = await fixture(); const binding = await launch(f); f.prompts.splice(0);
    f.hook(async (method) => { if (method !== "agent.read") return undefined; const result = visible(f, binding, composerScreen); f.panes[0]!.terminal_id = "replacement"; return result; });
    await expect(f.manager.submitPrompt(f.context, binding, "cleanup", operation())).rejects.toMatchObject({ action: "agent.prompt", submission: "not-submitted" }); expect(f.prompts).toEqual([]);
  });

  it("retains structured unknown transport failures without manufacturing success", async () => {
    const f = await fixture(); const binding = await launch(f);
    const failure = new HerdrRpcError("response lost", { method: "agent.prompt", requestId: "request", submission: "unknown" });
    f.hook(async (method) => { if (method === "agent.prompt") throw failure; return undefined; });
    await expect(f.manager.submitPrompt(f.context, binding, "cleanup", operation())).rejects.toMatchObject({ submission: "unknown", cause: failure });
  });

  it("closes an empty owned workspace without a native agent or persisted PID observation", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    const { agent: _agent, ...context } = f.context;
    await f.manager.stopAndClose(context, binding, operation()); expect(f.workspaces).toEqual([]);
    await f.manager.stopAndClose(context, binding, operation());
  });

  it("waits for the freshly observed native process after closing its workspace", async () => {
    const f = await fixture(); const binding = await launch(f); f.closeProcesses.terminate = false;
    let checkedClosed = false;
    f.hook(async (method) => { if (method === "workspace.close") setTimeout(() => { checkedClosed = f.workspaces.length === 0; f.executing.delete(200); }, 5); return undefined; });
    await f.manager.stopAndClose(f.context, binding, operation()); expect(checkedClosed).toBe(true); expect(f.workspaces).toEqual([]);
  });

  it("reports an unconfirmed process stop rather than authorizing further cleanup", async () => {
    const f = await fixture(); const binding = await launch(f); f.closeProcesses.terminate = false;
    await expect(f.manager.stopAndClose(f.context, binding, operation(25))).rejects.toMatchObject({ kind: "deadline" }); expect(f.executing.has(200)).toBe(true);
  });

  it("keeps waiting for the same process after a close wait times out and discovery is empty", async () => {
    const f = await fixture(); const binding = await launch(f); f.closeProcesses.terminate = false;
    await expect(f.manager.stopAndClose(f.context, binding, operation(100))).rejects.toMatchObject({ kind: "deadline" });
    expect(f.workspaces).toEqual([]);
    await expect(f.manager.stopAndClose(f.context, binding, operation(50))).rejects.toMatchObject({ kind: "deadline" });
    f.executing.delete(200);
    await f.manager.stopAndClose(f.context, binding, operation());
    expect(f.calls.filter((call) => call.method === "workspace.close")).toHaveLength(1);
  });

  it("retains observed processes when a close response is lost after the workspace disappears", async () => {
    const f = await fixture(); const binding = await launch(f);
    const failure = new HerdrRpcError("close response lost", { method: "workspace.close", requestId: "request", submission: "unknown" });
    f.hook(async (method) => {
      if (method !== "workspace.close") return undefined;
      f.workspaces.splice(0); f.panes.splice(0); f.agents.splice(0); f.tabs.splice(0);
      throw failure;
    });
    await expect(f.manager.stopAndClose(f.context, binding, operation())).rejects.toMatchObject({ submission: "unknown", cause: failure });
    await expect(f.manager.stopAndClose(f.context, binding, operation(50))).rejects.toMatchObject({ kind: "deadline" });
    f.executing.delete(200);
    await f.manager.stopAndClose(f.context, binding, operation());
    expect(f.calls.filter((call) => call.method === "workspace.close")).toHaveLength(1);
  });

  it("leaves unrelated workspaces alone and closes all panes of the claimed workspace", async () => {
    const f = await fixture(); const binding = await launch(f);
    f.workspaces.push({ workspace_id: "human", label: "human" });
    await f.manager.stopAndClose(f.context, binding, operation()); expect(f.workspaces).toEqual([{ workspace_id: "human", label: "human" }]);
    expect(f.calls.find((call) => call.method === "workspace.close")!.params).toEqual({ workspace_id: binding.workspaceId, close_group: false });
  });

  it("refuses to stop a replacement terminal or workspace", async () => {
    const f = await fixture(); const binding = await launch(f); f.panes[0]!.terminal_id = "replacement";
    await expect(f.manager.stopAndClose(f.context, binding, operation())).rejects.toThrow("terminal identity changed");
    expect(f.calls.filter((call) => call.method === "workspace.close")).toEqual([]);
    f.workspaces[0]!.label = "other";
    await expect(f.manager.stopAndClose(f.context, binding, operation())).rejects.toThrow("workspace identity changed");
  });

  it("rejects duplicate owned labels and mismatched native providers", async () => {
    const f = await fixture(); await launch(f); f.workspaces.push({ ...f.workspaces[0], workspace_id: "duplicate" });
    await expect(f.manager.listResources(operation())).rejects.toThrow("duplicate identities");
    f.workspaces.pop(); f.agents[0]!.agent_session = { source: "herdr:copilot", agent: "copilot", kind: "id", value: nativeId };
    await expect(f.manager.listResources(operation())).rejects.toThrow("provider differ");
  });

  it("reports unavailable worktree paths before creating anything", async () => {
    const f = await fixture(); await rm(f.context.cwd, { recursive: true });
    await expect(f.manager.prepareWorkspace(f.context, taskTitle, operation())).rejects.toMatchObject({ submission: "not-submitted", cause: { code: "ENOENT" } }); expect(f.calls).toEqual([]);
  });
});

it("launches and resumes Claude only with its original hook identity and visible composer", async () => {
  const f = await fixture("claude"); const prepared = await f.manager.prepareWorkspace(f.context,taskTitle,operation());
  f.hook(async method => method === "agent.read" ? { type: "pane_read", read: { pane_id:prepared.paneId,workspace_id:prepared.workspaceId,tab_id:f.panes[0]!.tab_id,source:"visible",format:"text",text:"─────────────────\n❯\n─────────────────\n? for shortcuts",revision:0,truncated:false } } : undefined);
  const config = { agent:"claude" as const, model:"sonnet", args:[] };
  const result = await f.manager.start(f.context,prepared,{ ...prepared,configuration:config,prompt:"managed task",resumeSessionId:nativeId },operation());
  expect(result.kind).toBe("claude"); expect(result.nativeSession?.sessionId).toBe(nativeId);
  expect(f.calls.find(call=>call.method==="agent.start")?.params.args).toEqual(["--resume",nativeId,"--model","sonnet","--dangerously-skip-permissions"]);
  expect(f.prompts).toEqual(["managed task"]);
});
it("does not type into Claude trust even when its native hook and OSC state say ready", async () => {
  const f = await fixture("claude"); const prepared = await f.manager.prepareWorkspace(f.context,taskTitle,operation());
  f.hook(async method => method === "agent.read" ? { type:"pane_read",read:{pane_id:prepared.paneId,workspace_id:prepared.workspaceId,tab_id:f.panes[0]!.tab_id,source:"visible",format:"text",text:"Do you trust the files in this folder?\n❯ 1. Yes\nEnter to confirm · Esc to cancel",revision:0,truncated:false} } : undefined);
  await expect(f.manager.start(f.context,prepared,{...prepared,configuration:{agent:"claude",model:null,args:[]},prompt:"business"},operation())).rejects.toMatchObject({promptSubmission:"not-submitted"});
  expect(f.prompts).toEqual([]);
});
