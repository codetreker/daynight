import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import { buildHerdrAgentArguments, createHerdrAgentManager, HerdrAgentActionError, herdrExecutionAgentName, herdrExecutionLabel, parseHerdrExecutionLabel, validateHerdrAgentArguments } from "../../../src/commands/worker/herdr/agents.js";
import type { HerdrAgentConfiguration, HerdrExecutionContext, HerdrTaskBinding, HerdrWorkspaceEnvironment } from "../../../src/commands/worker/herdr/agents.js";
import { HerdrRpcError } from "../../../src/commands/worker/herdr/rpc.js";
import type { HerdrRpcClient, HerdrRpcResult } from "../../../src/commands/worker/herdr/rpc.js";

type Entry = Record<string, unknown>;
const directories: string[] = [];
const operations: Operation[] = [];
const operation = (totalMs = 10_000): Operation => { const value = createOperation({ limits: { totalMs } }); operations.push(value); return value; };
afterEach(async () => { operations.splice(0).forEach((value) => value.dispose()); await Promise.all(directories.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });

const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const claimId = "33333333-3333-4333-8333-333333333333";
const worktreeId = "44444444-4444-4444-8444-444444444444";
const nativeId = "55555555-5555-4555-8555-555555555555";
const configuration: HerdrAgentConfiguration = { agent: "codex", model: "model-a", args: ["--config", "model_reasoning_effort=low", "--no-alt-screen"] };

const fixture = async (kind: "codex" | "copilot" = "codex", workspaceEnvironment = { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" }) => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/herdr-agent-tests"); await mkdir(scratch, { recursive: true });
  const cwd = await mkdtemp(path.join(scratch, "task-")); directories.push(cwd);
  const context: HerdrExecutionContext = { serverOrigin: "https://daynight.example", projectId, taskId, claimId, worktreeId, cwd, agent: kind };
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
    if (method === "agent.start") return { type: "agent_started", agent: launch(params), argv: [kind, ...params.args as string[]] };
    if (method === "agent.prompt") { prompts.push(String(params.text)); return { type: "agent_prompted", agent: structuredClone(agents.find((value) => value.pane_id === params.target)) }; }
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
      for (let index = panes.length - 1; index >= 0; index -= 1) if (panes[index]!.workspace_id === params.workspace_id) panes.splice(index, 1);
      return { type: "ok" };
    }
    throw new Error(`Unexpected fixture method ${method}`);
  } };
  const manager = createHerdrAgentManager({ rpc, session: "w", preflight: { verifyStart: async () => { preflights += 1; } }, workspaceEnvironment, processExecuting: async (value) => executing.has(value), pollIntervalMs: 1 });
  return { context, manager, workspaces, panes, agents, tabs, calls, prompts, processes, executing, rpc, snapshot, launch, hook: (value: typeof hook) => { hook = value; }, preflights: () => preflights };
};
const launch = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const binding = await f.manager.prepareWorkspace(f.context, operation());
  const result = await f.manager.start(f.context, binding, { configuration: { ...configuration, agent: f.context.agent, args: f.context.agent === "codex" ? configuration.args : ["--allow-all-tools"] }, prompt: "initial" }, operation());
  expect(result.kind).toBe("started"); return binding;
};

describe("native argument ownership", () => {
  it("preserves exact configuration tokens and owns model/no-daemon/exact resume selection", () => {
    expect(buildHerdrAgentArguments(configuration)).toEqual(["--no-daemon", "--model", "model-a", ...configuration.args]);
    expect(buildHerdrAgentArguments(configuration, nativeId)).toEqual(["--no-daemon", "resume", nativeId, "--model", "model-a", ...configuration.args]);
    expect(buildHerdrAgentArguments({ agent: "copilot", model: null, args: ["--allow-tool=shell(git:*)", "--reasoning-effort", "low"] }, nativeId)).toEqual([`--resume=${nativeId}`, "--allow-tool=shell(git:*)", "--reasoning-effort", "low"]);
  });
  it.each(["resume", "a positional prompt", "--model=x", "-m", "--cd", "--no-daemon", "--worktree", "--remote=x", "--help"])("refuses Codex-owned/positional argument %s", (value) => {
    expect(() => validateHerdrAgentArguments("codex", [value])).toThrow();
  });
  it.each(["-p", "--prompt=execute", "-i", "--interactive=execute", "--resume=x", "--continue", "--session-id=x", "-C", "--mode=autopilot", "--autopilot", "--fleet", "--plan"])("refuses Copilot-owned argument %s", (value) => {
    expect(() => validateHerdrAgentArguments("copilot", [value])).toThrow();
  });
  it("rejects hidden option values, control characters, unknown flags and ambiguous variadic options", () => {
    expect(() => validateHerdrAgentArguments("codex", ["--config", "--model=x"])).toThrow();
    expect(() => validateHerdrAgentArguments("codex", ["--config", "x=one\ntwo"])).toThrow();
    expect(() => validateHerdrAgentArguments("copilot", ["--allow-tool", "shell(git:*)"])).toThrow("=value");
    expect(() => buildHerdrAgentArguments({ ...configuration, model: "x\ny" })).toThrow();
    expect(() => buildHerdrAgentArguments(configuration, "prefix")).toThrow("exact original session UUID");
  });
});

describe("task workspace ownership and native input", () => {
  it("creates and reconciles one full-identity workspace without mutating other workspaces", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, operation());
    expect(f.workspaces[0]!.label).toBe(herdrExecutionLabel(f.context));
    expect(await f.manager.prepareWorkspace(f.context, operation())).toEqual(binding);
    expect(f.calls.filter((value) => value.method === "workspace.create")).toHaveLength(1);
    expect(herdrExecutionAgentName(f.context)).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });
  it("snapshots and forwards only caller XDG roots to new workspaces and force-stop anchors", async () => {
    const original = { XDG_CONFIG_HOME: "/caller/config", XDG_STATE_HOME: "/caller/state" }; const f = await fixture("codex", original);
    original.XDG_CONFIG_HOME = "/changed after construction";
    f.hook(async (method, params) => { if (method === "workspace.create") (params.env as Entry).XDG_CONFIG_HOME = "/changed by RPC executor"; return undefined; });
    const binding = await launch(f); const expected = { XDG_CONFIG_HOME: "/caller/config", XDG_STATE_HOME: "/caller/state" };
    expect(f.calls.find((value) => value.method === "workspace.create")!.params.env).toEqual(expected);
    const beforeReconnect = f.calls.length; await f.manager.prepareWorkspace(f.context, operation());
    expect(f.calls.slice(beforeReconnect).every((value) => value.method === "session.snapshot")).toBe(true);
    const evidence = await f.manager.captureStop(f.context, binding, operation()); f.executing.delete(200);
    await f.manager.forceStop(f.context, binding, evidence, operation());
    expect(f.calls.find((value) => value.method === "tab.create")!.params.env).toEqual(expected);
  });
  it("rejects workspace environment payloads that contain routing, credentials or incomplete XDG state", async () => {
    const f = await fixture();
    for (const workspaceEnvironment of [{ XDG_CONFIG_HOME: "" }, { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "", HERDR_SOCKET_PATH: "/foreign/socket" }, { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "", GITHUB_TOKEN: "synthetic" }, { XDG_CONFIG_HOME: "bad\0path", XDG_STATE_HOME: "" }]) {
      expect(() => createHerdrAgentManager({ rpc: f.rpc, session: "w", preflight: { verifyStart: async () => undefined }, workspaceEnvironment: workspaceEnvironment as unknown as HerdrWorkspaceEnvironment })).toThrow("only XDG_CONFIG_HOME and XDG_STATE_HOME");
    }
    expect(f.calls).toEqual([]);
  });
  it("enumerates typed owned resources and restored shells without interpreting lifecycle", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, operation());
    f.workspaces.push({ workspace_id: "human", label: "" });
    const resources = await f.manager.listResources(operation());
    expect(resources).toEqual([{ owner: { serverOrigin: f.context.serverOrigin, projectId, taskId, claimId, worktreeId }, workspaceId: binding.workspaceId, panes: [{ binding, cwd: f.context.cwd, kind: null, status: "unknown", launchPending: false, interactiveReady: false, nativeSession: null, stateChangeSeq: null, completionSeq: null }] }]);
    expect(parseHerdrExecutionLabel("ordinary label")).toBeNull();
    await f.manager.start(f.context, binding, { configuration, prompt: "first" }, operation());
    expect((await f.manager.listResources(operation()))[0]!.panes[0]!.nativeSession?.sessionId).toBe(nativeId);
  });
  it("exposes native activity counters and rejects missing, negative or imprecise observations", async () => {
    const f = await fixture(); const binding = await launch(f); f.agents[0]!.completion_seq = 6;
    expect(await f.manager.observe(f.context, binding, operation())).toMatchObject({ stateChangeSeq: 7, completionSeq: 6 });
    expect((await f.manager.submitPrompt(f.context, binding, "next", operation())).observation).toMatchObject({ stateChangeSeq: 7, completionSeq: 6 });
    for (const value of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      f.agents[0]!.state_change_seq = value;
      await expect(f.manager.observe(f.context, binding, operation())).rejects.toThrow("state-change sequence");
    }
    f.agents[0]!.state_change_seq = 7; f.agents[0]!.completion_seq = -1;
    await expect(f.manager.listResources(operation())).rejects.toThrow("completion sequence");
  });
  it("rejects malformed reserved labels, duplicate ownership and orphan agent associations", async () => {
    const f = await fixture(); await f.manager.prepareWorkspace(f.context, operation());
    f.workspaces.push({ workspace_id: "bad", label: "daynight:not-json" });
    await expect(f.manager.listResources(operation())).rejects.toThrow(); f.workspaces.pop();
    f.workspaces.push({ ...f.workspaces[0], workspace_id: "duplicate" });
    await expect(f.manager.listResources(operation())).rejects.toThrow("duplicate labels"); f.workspaces.pop();
    f.agents.push({ workspace_id: f.workspaces[0]!.workspace_id, pane_id: "missing", terminal_id: "orphan" });
    await expect(f.manager.listResources(operation())).rejects.toThrow("unassociated native agent");
  });
  it("rejects duplicate labels, foreign cwd/terminal identity and a new claim at an occupied cwd", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, operation());
    f.workspaces.push({ ...f.workspaces[0], workspace_id: "duplicate" });
    await expect(f.manager.observe(f.context, binding, operation())).rejects.toThrow("duplicated"); f.workspaces.pop();
    await expect(f.manager.observe(f.context, { ...binding, terminalId: "foreign" }, operation())).rejects.toThrow("identity has changed");
    const other = await mkdtemp(path.join(f.context.cwd, "other-")); f.panes[0]!.cwd = other;
    await expect(f.manager.observe(f.context, binding, operation())).rejects.toThrow("cwd differs"); f.panes[0]!.cwd = f.context.cwd;
    await expect(f.manager.prepareWorkspace({ ...f.context, claimId: nativeId }, operation())).rejects.toThrow("different Herdr workspace");
  });
  it("does not resolve unrelated missing worktrees while preparing another task", async () => {
    const f = await fixture(); f.workspaces.push({ workspace_id: "other", label: "ordinary" });
    f.panes.push({ workspace_id: "other", pane_id: "other-pane", terminal_id: "other-terminal", cwd: path.join(f.context.cwd, "missing unrelated task"), agent_status: "unknown" });
    expect((await f.manager.prepareWorkspace(f.context, operation())).paneId).toBe("pane-1");
  });
  it.each(["codex", "copilot"] as const)("submits the caller's exact multiline %s prompt after readiness", async (kind) => {
    const f = await fixture(kind); const binding = await f.manager.prepareWorkspace(f.context, operation());
    const prompt = "调用方内容\n\nline two\twith space  \n";
    const result = await f.manager.start(f.context, binding, { configuration: { agent: kind, model: "fixed-model", args: [] }, prompt }, operation());
    expect(result.kind).toBe("started"); expect(f.prompts).toEqual([prompt]); expect(f.preflights()).toBe(1);
    expect(f.calls.findIndex((value) => value.method === "agent.start")).toBeLessThan(f.calls.findIndex((value) => value.method === "agent.prompt"));
    expect(f.calls.find((value) => value.method === "agent.prompt")!.params.target).toBe(binding.paneId);
    expect(f.calls.find((value) => value.method === "agent.start")!.params.args).not.toContain(prompt);
  });
  it("reconnects a live native agent without resubmitting startup input", async () => {
    const f = await fixture(); const binding = await launch(f); f.prompts.splice(0);
    const result = await f.manager.start(f.context, binding, { configuration, prompt: "must not resend" }, operation());
    expect(result.kind).toBe("reconnected"); expect(f.prompts).toEqual([]); expect(f.preflights()).toBe(1);
    expect(f.calls.filter((value) => value.method === "agent.start")).toHaveLength(1);
  });
  it("allows readiness established by the official native report without heuristic agent text", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, operation());
    f.hook(async (method, params) => { if (method !== "agent.start") return undefined; const agent = f.launch(params); delete agent.agent; return { type: "agent_started", agent, argv: [f.context.agent, ...params.args as string[]] }; });
    const result = await f.manager.start(f.context, binding, { configuration, prompt: "opaque" }, operation());
    expect(result.kind).toBe("started"); expect(f.prompts).toEqual(["opaque"]);
    expect((await f.manager.start(f.context, binding, { configuration, prompt: "never resend" }, operation())).kind).toBe("reconnected");
    expect(f.calls.filter((value) => value.method === "agent.start")).toHaveLength(1); expect(f.prompts).toEqual(["opaque"]);
  });
  it.each([false, true])("delivers one first prompt before lazy SessionStart identity (resume=%s)", async (resume) => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, operation());
    f.hook(async (method, params) => {
      if (method === "agent.start") {
        const agent = f.launch(params); delete agent.agent_session;
        return { type: "agent_started", agent, argv: [f.context.agent, ...params.args as string[]] };
      }
      if (method === "agent.prompt") {
        expect(f.agents[0]!.agent_session).toBeUndefined(); const receipt = structuredClone(f.agents[0]);
        f.prompts.push(String(params.text));
        f.agents[0]!.agent_session = { source: "herdr:codex", agent: "codex", kind: "id", value: nativeId };
        return { type: "agent_prompted", agent: receipt };
      }
      return undefined;
    });
    const result = await f.manager.start(f.context, binding, { configuration, prompt: "first\ncaller prompt", ...(resume ? { resumeSessionId: nativeId } : {}) }, operation());
    expect(result.kind).toBe("started"); expect(result.promptSubmission).toBe("submitted"); expect(result.observation.nativeSession?.sessionId).toBe(nativeId); expect(f.prompts).toEqual(["first\ncaller prompt"]);
    expect(f.calls.find((value) => value.method === "agent.start")!.params.args).toEqual(buildHerdrAgentArguments(configuration, resume ? nativeId : undefined));
  });
  it("requires explicit never-submitted evidence to deliver first input after blocked readiness", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, operation());
    f.hook(async (method, params) => {
      if (method === "agent.start") {
        const agent = f.launch(params); delete agent.agent_session; agent.agent_status = "blocked";
        return { type: "agent_started", agent, argv: [f.context.agent, ...params.args as string[]] };
      }
      if (method === "agent.prompt") {
        f.prompts.push(String(params.text)); f.agents[0]!.agent_session = { source: "herdr:codex", agent: "codex", kind: "id", value: nativeId };
        return { type: "agent_prompted", agent: f.agents[0] };
      }
      return undefined;
    });
    const waiting = await f.manager.start(f.context, binding, { configuration, prompt: "only once" }, operation()); expect(waiting.kind).toBe("waiting"); expect(waiting.promptSubmission).toBe("not-submitted");
    if (waiting.launchEvidence === null) throw new Error("Expected the verified launch receipt.");
    f.agents[0]!.agent_status = "unknown";
    expect((await f.manager.start(f.context, binding, { configuration, prompt: "not permission to resend" }, operation())).kind).toBe("reconnected"); expect(f.prompts).toEqual([]);
    expect((await f.manager.start(f.context, binding, { configuration, prompt: "flag alone is insufficient", initialPromptNotSubmitted: true }, operation())).kind).toBe("rebind-required"); expect(f.prompts).toEqual([]);
    const continued = await f.manager.start(f.context, binding, { configuration, prompt: "only once", initialPromptNotSubmitted: true, launchEvidence: waiting.launchEvidence }, operation());
    expect(continued.kind).toBe("started"); expect(f.prompts).toEqual(["only once"]); expect(f.calls.filter((value) => value.method === "agent.start")).toHaveLength(1);
  });
  it("preserves submitted input fact when subsequent official identity observation is cancelled", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, operation());
    const controller = new AbortController(); const op = createOperation({ signal: controller.signal }); operations.push(op);
    f.hook(async (method, params) => {
      if (method === "agent.start") { const agent = f.launch(params); delete agent.agent_session; return { type: "agent_started", agent, argv: [f.context.agent, ...params.args as string[]] }; }
      if (method === "agent.prompt") { f.prompts.push(String(params.text)); setTimeout(() => controller.abort(new Error("stop identity observation")), 5); return { type: "agent_prompted", agent: f.agents[0] }; }
      return undefined;
    });
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "submitted before identity" }, op)).rejects.toMatchObject({ action: "agent.start", submission: "unknown", promptSubmission: "submitted", launchEvidence: { binding, referenceBaseline: "empty", argv: ["codex", ...buildHerdrAgentArguments(configuration)] } });
    expect(f.prompts).toEqual(["submitted before identity"]);
    expect((await f.manager.start(f.context, binding, { configuration, prompt: "must not resend" }, operation())).kind).toBe("reconnected"); expect(f.prompts).toHaveLength(1);
  });
  it("refuses a different post-input resume identity without marking the recovery restored", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, operation());
    f.hook(async (method, params) => {
      if (method === "agent.start") { const agent = f.launch(params); delete agent.agent_session; return { type: "agent_started", agent, argv: [f.context.agent, ...params.args as string[]] }; }
      if (method === "agent.prompt") { f.prompts.push(String(params.text)); setTimeout(() => { f.agents[0]!.agent_session = { source: "herdr:codex", agent: "codex", kind: "id", value: worktreeId }; }, 5); return { type: "agent_prompted", agent: f.agents[0] }; }
      return undefined;
    });
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "recovery once", resumeSessionId: nativeId }, operation())).rejects.toMatchObject({ submission: "unknown", promptSubmission: "submitted" });
    expect(f.prompts).toEqual(["recovery once"]);
  });
  it("returns blocked without submitting input and refuses a different resumed native ID", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, operation());
    f.hook(async (method, params) => { if (method !== "agent.start") return undefined; const agent = f.launch(params); agent.agent_status = "blocked"; return { type: "agent_started", agent, argv: [f.context.agent, ...params.args as string[]] }; });
    const waiting = await f.manager.start(f.context, binding, { configuration, prompt: "do not submit" }, operation()); expect(waiting.kind).toBe("waiting"); expect(f.prompts).toEqual([]);
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "recover", resumeSessionId: worktreeId }, operation())).rejects.toThrow("differs");
  });
  it("restarts the exact original session with frozen model and args before caller recovery text", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, operation());
    await f.manager.start(f.context, binding, { configuration, prompt: "original recovery\ncontext", resumeSessionId: nativeId }, operation());
    expect(f.calls.find((value) => value.method === "agent.start")!.params.args).toEqual(buildHerdrAgentArguments(configuration, nativeId));
    expect(f.prompts).toEqual(["original recovery\ncontext"]);
  });
  it("requires a fresh binding for retained shell history even when its original ID matches", async () => {
    const f = await fixture(); const binding = await launch(f);
    f.panes[0]!.agent_session = f.agents[0]!.agent_session; f.agents.splice(0); f.processes.set(binding.paneId, [100]);
    expect(await f.manager.start(f.context, binding, { configuration, prompt: "do not replace history" }, operation())).toMatchObject({ kind: "rebind-required", reason: "retained-native-reference", promptSubmission: "not-submitted" });
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "do not switch history", resumeSessionId: worktreeId }, operation())).rejects.toThrow("differs");
    expect(await f.manager.start(f.context, binding, { configuration, prompt: "no stale success", resumeSessionId: nativeId }, operation())).toMatchObject({ kind: "rebind-required", promptSubmission: "not-submitted" });
    expect(f.calls.filter((value) => value.method === "agent.start")).toHaveLength(1); expect(f.prompts).toEqual(["initial"]);
    f.executing.delete(200); await f.manager.closeWorkspace(f.context, binding, { agentStopped: true }, operation());
    const fresh = await f.manager.prepareWorkspace(f.context, operation());
    const resumed = await f.manager.start(f.context, fresh, { configuration, prompt: "resume original", resumeSessionId: nativeId }, operation());
    expect(resumed.kind).toBe("started"); expect(f.calls.filter((value) => value.method === "agent.start")).toHaveLength(2);
    expect(f.prompts.at(-1)).toBe("resume original");
  });
  it("does not bless an existing reference with missing or mismatched continuation launch evidence", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, operation());
    f.hook(async (method, params) => { if (method !== "agent.start") return undefined; const agent = f.launch(params); agent.agent_status = "blocked"; return { type: "agent_started", agent, argv: [f.context.agent, ...params.args as string[]] }; });
    const waiting = await f.manager.start(f.context, binding, { configuration, prompt: "not yet" }, operation());
    if (waiting.launchEvidence === null) throw new Error("Expected verified clean-baseline launch evidence.");
    expect(waiting.launchEvidence).toEqual({ binding, ownerLabel: herdrExecutionLabel(f.context), agent: "codex", argv: ["codex", ...buildHerdrAgentArguments(configuration)], referenceBaseline: "empty" });
    f.agents[0]!.agent_status = "unknown";
    const calls = f.calls.length;
    const missing = await f.manager.start(f.context, binding, { configuration, prompt: "must not send", initialPromptNotSubmitted: true }, operation());
    expect(missing).toMatchObject({ kind: "rebind-required", reason: "unverified-launch", promptSubmission: "not-submitted" });
    const mismatched = await f.manager.start(f.context, binding, { configuration, prompt: "must not send", initialPromptNotSubmitted: true, launchEvidence: { ...waiting.launchEvidence, binding: { ...binding, terminalId: "different" } } }, operation());
    expect(mismatched.kind).toBe("rebind-required");
    const wrongArgs = await f.manager.start(f.context, binding, { configuration, prompt: "must not send", initialPromptNotSubmitted: true, launchEvidence: { ...waiting.launchEvidence, argv: ["codex", "--model", "different"] } }, operation());
    expect(wrongArgs.kind).toBe("rebind-required");
    expect(f.calls.slice(calls).some((value) => value.method === "agent.start" || value.method === "agent.prompt")).toBe(false); expect(f.prompts).toEqual([]);
  });
  it("does not submit caller input after a launch acknowledgement changes target or frozen args", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, operation());
    f.hook(async (method, params) => { if (method !== "agent.start") return undefined; return { type: "agent_started", agent: f.launch(params), argv: [f.context.agent, "--model", "changed"] }; });
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "must not submit" }, operation())).rejects.toMatchObject({ action: "agent.start", submission: "unknown" });
    expect(f.prompts).toEqual([]);
  });
  it("does not replay a start or prompt after an unknown submission", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, operation());
    f.hook(async (method, params) => { if (method !== "agent.start") return undefined; f.launch(params); throw new HerdrRpcError("lost start", { method, requestId: "fixture", submission: "unknown" }); });
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "original" }, operation())).rejects.toMatchObject({ submission: "unknown" });
    f.hook(undefined); expect((await f.manager.start(f.context, binding, { configuration, prompt: "never replay" }, operation())).kind).toBe("reconnected"); expect(f.prompts).toEqual([]);
    f.hook(async (method, params) => { if (method !== "agent.prompt") return undefined; f.prompts.push(String(params.text)); throw new HerdrRpcError("lost prompt", { method, requestId: "fixture", submission: "unknown", code: "agent_prompt_failed", apiMessage: "PTY failure" }); });
    await expect(f.manager.submitPrompt(f.context, binding, "once", operation())).rejects.toMatchObject({ submission: "unknown" }); expect(f.prompts).toEqual(["once"]);
  });
  it("keeps malformed prompt acknowledgements unknown after startup delivery", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, operation());
    f.hook(async (method, params) => { if (method !== "agent.prompt") return undefined; f.prompts.push(String(params.text)); return { type: "ok" }; });
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "once despite bad ack" }, operation())).rejects.toMatchObject({ action: "agent.prompt", submission: "unknown", promptSubmission: "unknown" });
    expect(f.prompts).toEqual(["once despite bad ack"]);
  });
  it("classifies only method-specific preflight rejection as definite and preserves original errors", async () => {
    const f = await fixture(); const binding = await launch(f); const error = new HerdrRpcError("blocked", { method: "agent.prompt", requestId: "fixture", submission: "unknown", code: "agent_blocked" });
    f.hook(async (method) => { if (method === "agent.prompt") throw error; return undefined; });
    await expect(f.manager.submitPrompt(f.context, binding, "input", operation())).rejects.toMatchObject({ submission: "rejected", cause: error });
  });
  it("serializes concurrent input submissions to the same original pane", async () => {
    const f = await fixture(); const binding = await launch(f); f.prompts.splice(0);
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let first = true;
    f.hook(async (method, params) => { if (method !== "agent.prompt") return undefined; f.prompts.push(String(params.text)); if (first) { first = false; await gate; } return { type: "agent_prompted", agent: f.agents[0] }; });
    const one = f.manager.submitPrompt(f.context, binding, "one", operation()); const two = f.manager.submitPrompt(f.context, binding, "two", operation());
    while (f.prompts.length === 0) await new Promise((resolve) => setTimeout(resolve, 1)); expect(f.prompts).toEqual(["one"]); release(); await Promise.all([one, two]); expect(f.prompts).toEqual(["one", "two"]);
  });
  it("cancels a queued input promptly without allowing a later input to overtake", async () => {
    const f = await fixture(); const binding = await launch(f); f.prompts.splice(0);
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let first = true;
    f.hook(async (method, params) => { if (method !== "agent.prompt") return undefined; f.prompts.push(String(params.text)); if (first) { first = false; await gate; } return { type: "agent_prompted", agent: f.agents[0] }; });
    const one = f.manager.submitPrompt(f.context, binding, "one", operation());
    while (f.prompts.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const controller = new AbortController(); const queuedOperation = createOperation({ signal: controller.signal }); operations.push(queuedOperation);
    const two = f.manager.submitPrompt(f.context, binding, "must not send", queuedOperation).catch((error: unknown) => error);
    controller.abort(new Error("queued input cancelled"));
    const three = f.manager.submitPrompt(f.context, binding, "three", operation());
    try {
      const outcome = await Promise.race([two, new Promise((resolve) => setTimeout(() => resolve("still queued"), 500))]);
      expect(outcome).toBe(queuedOperation.signal.reason); expect(f.prompts).toEqual(["one"]);
    } finally { release(); }
    await Promise.all([one, three]); expect(f.prompts).toEqual(["one", "three"]);
  });
});

describe("native stop evidence and workspace closure", () => {
  it("captures a folder-trust-blocked pending Copilot launch with concrete foreground native PIDs", async () => {
    const f = await fixture("copilot"); const binding = await launch(f); f.agents[0]!.agent_status = "blocked"; f.agents[0]!.launch_pending = true; f.agents[0]!.interactive_ready = false; delete f.agents[0]!.agent_session;
    f.hook(async (method) => method === "pane.process_info" ? { type: "pane_process_info", process_info: { pane_id: binding.paneId, shell_pid: 830500, foreground_process_group_id: 830816, foreground_processes: [
      { pid: 830816, name: "MainThread", argv: ["node", "/native/bin/copilot", "--model", "fixed"], cwd: f.context.cwd },
      { pid: 830828, name: "MainThread", argv: ["/native/lib/@github/copilot-linux-x64/copilot", "--model", "fixed"], cwd: f.context.cwd },
    ] } } : undefined);
    const evidence = await f.manager.captureStop(f.context, binding, operation());
    expect(evidence).toMatchObject({ shellPid: 830500, processIds: [830816, 830828], nativeSessionId: null, ownerLabel: herdrExecutionLabel(f.context) });
    expect(f.calls.some((value) => value.method === "pane.close")).toBe(false);
  });
  it("does not turn a pending launch with no native process evidence into stop proof", async () => {
    const f = await fixture(); const binding = await launch(f); f.agents[0]!.launch_pending = true;
    f.processes.set(binding.paneId, [100]); await expect(f.manager.captureStop(f.context, binding, operation())).rejects.toThrow("identities are unavailable");
    f.hook(async (method) => method === "pane.process_info" ? { type: "pane_process_info", process_info: { pane_id: binding.paneId, shell_pid: 100, foreground_processes: [{ pid: 201, name: "other", argv: ["unrelated-tool", "--output", "codex"] }] } } : undefined);
    await expect(f.manager.captureStop(f.context, binding, operation())).rejects.toThrow("no concrete original native process evidence");
  });
  it("captures original PIDs before graceful stop and verifies actual absence", async () => {
    const f = await fixture(); const binding = await launch(f); const evidence = await f.manager.captureStop(f.context, binding, operation());
    expect(evidence.processIds).toEqual([200]); await f.manager.requestGracefulStop(f.context, binding, operation()); expect(f.prompts.at(-1)).toBe("/exit");
    await expect(f.manager.confirmStopped(f.context, binding, evidence, operation())).rejects.toThrow("still executing");
    f.executing.delete(200); f.processes.set(binding.paneId, [100]); f.agents.splice(0);
    expect(await f.manager.confirmStopped(f.context, binding, evidence, operation())).toEqual({ agentStopped: true });
    expect(await f.manager.closeWorkspace(f.context, binding, { agentStopped: true }, operation())).toEqual({ workspaceClosed: true });
    expect(await f.manager.closeWorkspace(f.context, binding, { agentStopped: true }, operation())).toEqual({ workspaceClosed: true });
  });
  it("confirms a new empty restored shell only after original native and shell processes are absent", async () => {
    const f = await fixture(); const binding = await launch(f); const evidence = await f.manager.captureStop(f.context, binding, operation());
    f.executing.delete(200);
    f.hook(async (method) => method === "pane.process_info" ? { type: "pane_process_info", process_info: { pane_id: binding.paneId, shell_pid: 300, foreground_processes: [{ pid: 300, name: "new shell" }] } } : undefined);
    expect(await f.manager.confirmStopped(f.context, binding, evidence, operation())).toEqual({ agentStopped: true });
    f.executing.add(evidence.shellPid);
    await expect(f.manager.confirmStopped(f.context, binding, evidence, operation())).rejects.toThrow("original task shell is still executing");
    f.executing.delete(evidence.shellPid);
    f.hook(async (method) => method === "pane.process_info" ? { type: "pane_process_info", process_info: { pane_id: binding.paneId, shell_pid: 300, foreground_processes: [{ pid: 300, name: "new shell" }, { pid: 301, name: "current foreground work" }] } } : undefined);
    await expect(f.manager.confirmStopped(f.context, binding, evidence, operation())).rejects.toThrow("still hosts foreground work");
  });
  it("confirms a cold-restored terminal against immutable old process evidence", async () => {
    const f = await fixture(); const original = await launch(f); const evidence = await f.manager.captureStop(f.context, original, operation());
    const saved = structuredClone(evidence); const nativeReference = f.agents[0]!.agent_session;
    f.executing.delete(200); f.agents.splice(0); f.panes[0]!.terminal_id = "restored-terminal"; f.panes[0]!.agent_session = nativeReference;
    const restored = { ...original, terminalId: "restored-terminal" };
    f.hook(async (method) => method === "pane.process_info" ? { type: "pane_process_info", process_info: { pane_id: original.paneId, shell_pid: 300, foreground_processes: [{ pid: 300, name: "restored shell" }] } } : undefined);
    await expect(f.manager.confirmStopped(f.context, original, evidence, operation())).rejects.toThrow("identity has changed");
    const proof = await f.manager.confirmRestoredStop(f.context, original, restored, evidence, operation());
    expect(proof).toEqual({ agentStopped: true, binding: restored }); expect(evidence).toEqual(saved);
    expect(f.calls.some((value) => value.method === "pane.close" || value.method === "workspace.close")).toBe(false);
    expect(await f.manager.closeWorkspace(f.context, proof.binding, proof, operation())).toEqual({ workspaceClosed: true });
  });
  it("refuses restored-stop proof for changed associations, surviving originals or current native work", async () => {
    const f = await fixture(); const original = await launch(f); const evidence = await f.manager.captureStop(f.context, original, operation());
    f.agents.splice(0); f.panes[0]!.terminal_id = "restored-terminal"; const restored = { ...original, terminalId: "restored-terminal" };
    f.hook(async (method) => method === "pane.process_info" ? { type: "pane_process_info", process_info: { pane_id: original.paneId, shell_pid: 300, foreground_processes: [{ pid: 300, name: "restored shell" }] } } : undefined);
    await expect(f.manager.confirmRestoredStop(f.context, original, { ...restored, workspaceId: "different" }, evidence, operation())).rejects.toThrow("original task workspace and pane association");
    await expect(f.manager.confirmRestoredStop(f.context, original, restored, evidence, operation())).rejects.toThrow("original native process is still executing");
    f.executing.delete(200); f.executing.add(100);
    await expect(f.manager.confirmRestoredStop(f.context, original, restored, evidence, operation())).rejects.toThrow("original task shell is still executing");
    f.executing.delete(100);
    f.hook(async (method) => method === "pane.process_info" ? { type: "pane_process_info", process_info: { pane_id: original.paneId, shell_pid: 300, foreground_processes: [{ pid: 300, name: "restored shell" }, { pid: 301, name: "other work" }] } } : undefined);
    await expect(f.manager.confirmRestoredStop(f.context, original, restored, evidence, operation())).rejects.toThrow("still hosts foreground work");
    f.panes[0]!.agent = "codex";
    await expect(f.manager.confirmRestoredStop(f.context, original, restored, evidence, operation())).rejects.toThrow("not an inactive shell");
    expect(f.calls.some((value) => value.method === "pane.close" || value.method === "workspace.close")).toBe(false);
  });
  it("requires original evidence rather than empty process lists or pane absence", async () => {
    const f = await fixture(); const binding = await launch(f); f.processes.set(binding.paneId, [100]);
    await expect(f.manager.captureStop(f.context, binding, operation())).rejects.toThrow("identities are unavailable");
    const evidence = { binding, ownerLabel: herdrExecutionLabel(f.context), agent: f.context.agent, nativeSessionId: nativeId, shellPid: 100, processIds: [], observedAt: Date.now() };
    await expect(f.manager.forceStop(f.context, binding, evidence, operation())).rejects.toThrow("observation is invalid");
  });
  it("keeps a temporary task anchor until original process absence is proven", async () => {
    const f = await fixture(); const binding = await launch(f); const evidence = await f.manager.captureStop(f.context, binding, operation());
    f.workspaces.push({ workspace_id: "other", label: "human" });
    await expect(f.manager.forceStop(f.context, binding, evidence, operation())).rejects.toThrow("still executing");
    expect(f.workspaces).toHaveLength(2); expect(f.panes.some((value) => value.pane_id === binding.paneId)).toBe(false); expect(f.tabs.some((value) => String(value.label).startsWith("daynight-stop:"))).toBe(true);
    f.executing.delete(200); expect(await f.manager.forceStop(f.context, binding, evidence, operation())).toEqual({ agentStopped: true, originalPaneClosed: true });
    await f.manager.closeWorkspace(f.context, binding, { agentStopped: true }, operation()); expect(f.workspaces).toEqual([{ workspace_id: "other", label: "human" }]);
  });
  it("does not treat reused or permission-denied PIDs as stopped and never kills them", async () => {
    const f = await fixture(); const binding = await launch(f); const evidence = await f.manager.captureStop(f.context, binding, operation());
    const denied = new Error("permission denied"); const manager = createHerdrAgentManager({ rpc: f.rpc, session: "w", preflight: { verifyStart: async () => undefined }, workspaceEnvironment: { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" }, processExecuting: async () => { throw denied; } });
    await expect(manager.confirmStopped(f.context, binding, evidence, operation())).rejects.toBe(denied);
    await expect(f.manager.confirmStopped(f.context, binding, evidence, operation())).rejects.toThrow("still executing");
    expect(f.calls.some((value) => value.method === "workspace.close")).toBe(false);
  });
  it("rejects foreign stop evidence and changed native identity before closing a pane", async () => {
    const f = await fixture(); const binding = await launch(f); const evidence = await f.manager.captureStop(f.context, binding, operation());
    await expect(f.manager.forceStop(f.context, binding, { ...evidence, ownerLabel: "foreign" }, operation())).rejects.toThrow("another execution");
    (f.agents[0]!.agent_session as Entry).value = taskId;
    await expect(f.manager.forceStop(f.context, binding, evidence, operation())).rejects.toThrow("another native session");
    expect(f.calls.some((value) => value.method === "pane.close")).toBe(false);
  });
});
