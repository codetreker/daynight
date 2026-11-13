import { ConfigurationAdmissionWaiting } from "../../../src/commands/worker/configuration-admission.js";
import { performance } from "node:perf_hooks";
import { WindowsProcessProofError } from "../../../src/commands/controller/windows-process-proof.js";
import { ExecutionSourceConflictError } from "../../../src/commands/worker/execution-stop.js";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation, OperationError } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import { buildHerdrAgentArguments, createHerdrAgentManager, HerdrAgentActionError, HerdrInputBlockedError, LegacyBindingUnavailableError, herdrExecutionAgentName, herdrExecutionLabel, parseHerdrExecutionLabel, validateHerdrAgentArguments } from "../../../src/commands/worker/herdr/agents.js";
import type { HerdrAgentConfiguration, HerdrExecutionContext, HerdrPromptReceipt, HerdrTaskBinding, HerdrWorkspaceEnvironment } from "../../../src/commands/worker/herdr/agents.js";
import { codexProjectTrustArguments } from "../../../src/commands/worker/herdr/arguments.js";
import { HerdrRpcError } from "../../../src/commands/worker/herdr/rpc.js";
import type { HerdrRpcClient, HerdrRpcResult } from "../../../src/commands/worker/herdr/rpc.js";
import { nativeMenuScreens } from "../../fixtures/native-menu-screens.js";
import { nativeKeyDisplays } from "../../fixtures/native-key-displays.js";
import { nativeDisabledClips } from "../../fixtures/native-disabled-placeholders.js";
import { createToolLaunchMapping, type HerdrToolLaunchMapping } from "../../../src/commands/worker/herdr/tool-launch.js";
import { resolveToolLaunch } from "../../../src/platform/tool-executables.js";
import { expandedNarrowSessionPickerScreens, narrowSessionPickerScreens } from "../../fixtures/native-session-picker-screens.js";
import { frozenToolLaunch } from "../../helpers/tool-launch.js";
import { mappingFiles } from "../../../src/commands/worker/herdr/tool-launch-protocol.js";
import { HerdrCommandCleanupError } from "../../../src/commands/worker/herdr/command.js";

type Entry = Record<string, unknown>;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const setPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, "platform", { ...platformDescriptor, value });
const directories: string[] = [];
const mappingLifecycle = { captureProcesses: async (pids: readonly number[]) => [...pids], verifyProcesses: async () => {}, confirmStopped: async () => true, stopProcesses: async () => {}, releaseFrozen: async () => {}, retire: async () => {} };
const operations: Operation[] = [];
const operation = (totalMs = 10_000): Operation => { const value = createOperation({ limits: { totalMs } }); operations.push(value); return value; };
afterEach(async () => { Object.defineProperty(process, "platform", platformDescriptor); vi.restoreAllMocks(); operations.splice(0).forEach((value) => value.dispose()); await Promise.all(directories.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });

const taskTitle = "Repair worker startup";
const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const claimId = "33333333-3333-4333-8333-333333333333";
const worktreeId = "44444444-4444-4444-8444-444444444444";
const nativeId = "55555555-5555-4555-8555-555555555555";
const configuration: HerdrAgentConfiguration = { agent: "codex", model: "model-a", args: ["--config", "model_reasoning_effort=low", "--no-alt-screen"] };
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__model_reasoning_selection_popup.snap
const reasoningMenu = `  Select Reasoning Level for GPT-5.5


  1. Low               Fast responses with lighter reasoning
  2. Medium (default)  Balances speed and reasoning depth for everyday tasks
› 3. High (current)    Greater reasoning depth for complex problems
  4. Extra high        Extra high reasoning depth for complex problems
  5. Persistent        Continue working until put to sleep
  6. More reasoning…   Max and Ultra consume usage limits faster

  enter default · s session · esc back`;
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/config_panel/snapshots/codex_tui__config_panel__tests__config_Sessions.snap
const configurationMenu = `
  Configuration
  Changes save automatically

   Appearance   Notifications   Input   Sessions   Text selection

› Automatic recaps       [ ] Off              Prepare recaps while the terminal is unfocused
  Session picker layout  Dense ›              Choose tighter rows or a roomier list when resuming and forking conversations
  Resume directory       Ask ›                Choose which working directory to use when the current directory and saved session differ




  left/right group · / search · enter toggle · esc clear search/close`;
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/config_panel/snapshots/codex_tui__config_panel__tests__effects_picker.snap
const effectsMenu = `
  Effects
  Configure visual effects


› 1. [ ] Animations                 Animate the welcome screen, working
                                    indicator, and transitions
     [-] Composer stars (disabled)  Turn on Animations to show Astra task stars

  enter toggle · esc back`;
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__list_selection_view__picker_tests__browser_page_navigation_uses_rows_that_fit.snap
const keymapMenu = `
  Keymap
  All configurable shortcuts.

   All   Common   Customized (3)   Unbound (4)   App

  Type to search shortcuts
↑
  Action 01  Ctrl+1
  Action 02  Ctrl+2
  Action 03  Ctrl+3
  Action 04  Ctrl+4
  Action 05  Ctrl+5
  Action 06  Ctrl+6
  Action 07  Ctrl+7
› Action 08  Ctrl+8
↓
  left/right group · enter edit · esc close`;
// The complete 24×7 frame has wrapped controls and retains its selected action.
// https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__list_selection_view__picker_tests__short_browser_keeps_header_tabs_search_and_footer.snap
const keymapNarrowMenu = `
  Keymap
   All   Common      ›
  Type to search short
› Action 00  Ctrl+0
  left/right group ·
  enter edit · esc close`;

const fixture = async (kind: "codex" | "copilot" | "claude" = "codex", workspaceEnvironment: HerdrWorkspaceEnvironment = { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" }, readCodexConfig = async (_args: readonly string[], _cwd: string, _operation: Operation): Promise<unknown> => ({ config: {} }), extra: Partial<Parameters<typeof createHerdrAgentManager>[0]> = {}) => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/herdr-agent-tests"); await mkdir(scratch, { recursive: true });
  const cwd = await mkdtemp(path.join(scratch, "task-")); directories.push(cwd);
  const context: HerdrExecutionContext = { projectId, taskId, claimId, worktreeId, cwd, agent: kind };
  const workspaces: Entry[] = [];
  const panes: Entry[] = [];
  const agents: Entry[] = [];
  const tabs: Entry[] = [];
  const calls: { method: string; params: Entry }[] = [];
  const prompts: string[] = [];
  const screen = { text: "› Ask Codex to do anything\n\n  GPT-6.1 Terra medium · daynight/task · Context 0% used" };
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
    if (method === "agent.read") return { type: "pane_read", read: { pane_id: params.target, workspace_id: panes.find(value => value.pane_id === params.target)!.workspace_id, source: "visible", format: "text", text: screen.text, truncated: false } };
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
  const manager = createHerdrAgentManager({ rpc, session: "w", preflight: { verifyStart: async () => { preflights += 1; } }, workspaceEnvironment, readCodexConfig, processExecuting: async (value) => executing.has(value), pollIntervalMs: 1, ...extra });
  return { context, manager, workspaces, panes, agents, tabs, calls, prompts, screen, processes, executing, closeProcesses, rpc, snapshot, launch, hook: (value: typeof hook) => { hook = value; }, preflights: () => preflights };
};
const launch = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
  const result = await f.manager.start(f.context, binding, { configuration: { ...configuration, agent: f.context.agent, args: f.context.agent === "codex" ? configuration.args : f.context.agent === "copilot" ? ["--allow-all-tools"] : [] }, prompt: "initial" }, operation());
  expect(result.nativeSession?.sessionId).toBe(nativeId); return binding;
};

const mappedFixture = async () => {
  let mapping: HerdrToolLaunchMapping;
  const f = await fixture("copilot", { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" }, undefined, { toolMapping: async () => mapping });
  const receipt = { schemaVersion: 1 as const, owner: f.context, nonce: nativeId, selectionKey: "a".repeat(64), logicalArgvDigest: "b".repeat(64), file: "/selected/copilot", prefixArgs: [], helperPid: 300, childPid: 301 };
  mapping = { ...mappingLifecycle, manifestPath: path.join(f.context.cwd, "manifest.json"), nonce: nativeId, selectionKey: receipt.selectionKey, environment: { DAYNIGHT_HERDR_TOOL_MANIFEST: path.join(f.context.cwd, "manifest.json") }, verifyReady: async () => {}, verifyReceipt: async () => receipt, readReceipt: async () => receipt };
  const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
  return { ...f, mapping, binding, receipt, config: { agent: "copilot" as const, model: null, args: [] } };
};

describe("native argument ownership", () => {
  it("keeps recovered frozen input and stop closed when the original mapping index is missing", async () => {
    const f = await fixture("copilot"), binding = await launch(f);
    const toolLaunch = await resolveToolLaunch({ tool: "copilot", context: "herdr", choice: { kind: "path", path: process.execPath }, environment: process.env, cwd: f.context.cwd }, operation());
    const input = { directory: f.context.cwd, owner: f.context, launch: toolLaunch, nativeEnvironment: process.env };
    const mapping = (await createToolLaunchMapping(input, operation()))!;
    const original = await readFile(mapping.manifestPath, "utf8"), index = path.join(path.dirname(path.dirname(mapping.manifestPath)), "index.json");
    await rm(index);
    const toolMapping = vi.fn(async (_context: HerdrExecutionContext, active: Operation, existingOnly?: boolean) => createToolLaunchMapping({ ...input, ...(existingOnly === undefined ? {} : { existingOnly }) }, active));
    const recovered = createHerdrAgentManager({ rpc: f.rpc, session: "w", preflight: { verifyStart: async () => {} }, workspaceEnvironment: { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" }, toolMapping, processExecuting: async id => f.executing.has(id) });
    await expect(recovered.submitPrompt(f.context, binding, "must stay closed", operation())).rejects.toMatchObject({ action: "agent.prompt", submission: "not-submitted", cause: { message: expect.stringContaining("generation index is missing") } });
    expect(f.prompts).toEqual(["initial"]);
    await expect(recovered.stopAndClose(f.context, binding, operation())).rejects.toThrow("generation index is missing");
    expect(f.calls.filter(call => call.method === "workspace.close")).toEqual([]);
    expect(f.workspaces).toHaveLength(1);
    expect(toolMapping).toHaveBeenCalledTimes(2);
    expect(toolMapping.mock.calls.every(([, , existingOnly]) => existingOnly === true)).toBe(true);
    expect(await readFile(mapping.manifestPath, "utf8")).toBe(original);
    await expect(readFile(index)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains existing legacy input and stop when no historical tool recipe supplies a mapping", async () => {
    const f = await fixture("copilot"), binding = await launch(f);
    const toolMapping = vi.fn(async () => null);
    const recovered = createHerdrAgentManager({ rpc: f.rpc, session: "w", preflight: { verifyStart: async () => {} }, workspaceEnvironment: { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" }, toolMapping, processExecuting: async id => f.executing.has(id) });
    await expect(recovered.submitPrompt(f.context, binding, "legacy input", operation())).resolves.toMatchObject({ submission: "submitted" });
    await recovered.stopAndClose(f.context, binding, operation());
    expect(f.prompts).toEqual(["initial", "legacy input"]);
    expect(f.calls.filter(call => call.method === "agent.start")).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "workspace.close")).toHaveLength(1);
    expect(f.workspaces).toEqual([]);
  });

  it.each(["unknown", "acknowledged"] as const)("persists a mapped launch reservation before RPC and never replays it after %s", async outcome => {
    const f = await mappedFixture(), file = mappingFiles(f.mapping.manifestPath).nativeStart;
    f.hook(async (method, params) => {
      if (method !== "agent.start") return undefined;
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ nonce: f.mapping.nonce, selectionKey: f.mapping.selectionKey, binding: f.binding, attempt: 0, state: "reserved" });
      if (outcome === "unknown") throw new HerdrRpcError("Original start response lost before native discovery.", { method, requestId: "lost", submission: "unknown" });
      return { type: "agent_started", agent: f.launch(params), argv: ["copilot", ...params.args as string[]] };
    });
    const launch = () => f.manager.launch(f.context, f.binding, { configuration: f.config }, operation());
    if (outcome === "unknown") await expect(launch()).rejects.toMatchObject({ action: "agent.start", submission: "unknown" });
    else { await launch(); f.agents.splice(0); }
    const original = await readFile(file, "utf8");
    f.hook(async () => undefined);
    await expect(launch()).rejects.toMatchObject({ action: "agent.start", submission: "unknown" });
    const recovered = createHerdrAgentManager({ rpc: f.rpc, session: "w", preflight: { verifyStart: async () => {} }, workspaceEnvironment: { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" }, toolMapping: async () => f.mapping });
    await expect(recovered.launch(f.context, f.binding, { configuration: f.config }, operation())).rejects.toMatchObject({ action: "agent.start", submission: "unknown" });
    expect(await readFile(file, "utf8")).toBe(original);
    expect(f.calls.filter(call => call.method === "agent.start")).toHaveLength(1);
    expect(f.prompts).toEqual([]);
  });

  it.each(["intent", "receipt"] as const)("keeps a legacy helper %s from admitting another native start RPC", async evidence => {
    const f = await mappedFixture(), files = mappingFiles(f.mapping.manifestPath);
    const { childPid: _child, ...intent } = f.receipt;
    await writeFile(files[evidence], JSON.stringify(evidence === "intent" ? intent : f.receipt), { mode: 0o600 });
    await expect(f.manager.launch(f.context, f.binding, { configuration: f.config }, operation())).rejects.toMatchObject({ action: "agent.start", submission: "unknown" });
    await expect(readFile(files.nativeStart, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.calls.filter(call => call.method === "agent.start")).toHaveLength(0);
  });

  it("durably settles a mapped pane-busy rejection before reserving its same-call retry", async () => {
    const f = await mappedFixture(), file = mappingFiles(f.mapping.manifestPath).nativeStart, states: unknown[] = [];
    let attempts = 0, rejectedObserved = false;
    f.hook(async (method, params) => {
      if (method === "pane.process_info") {
        try { const row = JSON.parse(await readFile(file, "utf8")); if (row.state === "rejected") { expect(row).toMatchObject({ attempt: 0, rejectionCode: "agent_pane_busy" }); rejectedObserved = true; } } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        return { type: "pane_process_info", process_info: { pane_id: f.binding.paneId, shell_pid: 100, foreground_process_group_id: 100, foreground_processes: [{ pid: 100, name: "/bin/bash", argv: ["-bash"] }] } };
      }
      if (method !== "agent.start") return undefined;
      states.push(JSON.parse(await readFile(file, "utf8")));
      if (++attempts === 1) throw new HerdrRpcError("Original shell is initializing.", { method, requestId: "busy", code: "agent_pane_busy", submission: "unknown" });
      expect(rejectedObserved).toBe(true);
      return { type: "agent_started", agent: f.launch(params), argv: ["copilot", ...params.args as string[]] };
    });
    const admitted = vi.fn(async () => {});
    await f.manager.launch(f.context, f.binding, { configuration: f.config, beforeStart: admitted }, operation());
    expect(states).toMatchObject([{ state: "reserved", attempt: 0 }, { state: "reserved", attempt: 1 }]);
    expect((states[0] as { requestId: string }).requestId).toBe((states[1] as { requestId: string }).requestId);
    expect(admitted).toHaveBeenCalledTimes(2);
    expect(f.prompts).toEqual([]);
  });

  it("does not retry a rejected mapped launch when its durable reservation changes", async () => {
    const f = await mappedFixture(), file = mappingFiles(f.mapping.manifestPath).nativeStart;
    f.hook(async method => {
      if (method !== "agent.start") return undefined;
      const row = JSON.parse(await readFile(file, "utf8")); row.attempt++;
      await writeFile(file, JSON.stringify(row), { mode: 0o600 });
      throw new HerdrRpcError("Original shell is initializing.", { method, requestId: "busy", code: "agent_pane_busy", submission: "unknown" });
    });
    await expect(f.manager.launch(f.context, f.binding, { configuration: f.config }, operation())).rejects.toMatchObject({ action: "agent.start", submission: "unknown" });
    expect(f.calls.filter(call => call.method === "agent.start")).toHaveLength(1);
  });

  it("waits for the caller's final shell readiness before registering its process proof", async () => {
    let mapping: HerdrToolLaunchMapping, ready = false;
    const f = await fixture("copilot", { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" }, undefined, { toolMapping: async () => mapping });
    mapping = { ...mappingLifecycle, manifestPath: path.join(f.context.cwd, "manifest.json"), nonce: nativeId, selectionKey: "a".repeat(64), environment: { DAYNIGHT_HERDR_TOOL_MANIFEST: path.join(f.context.cwd, "manifest.json") }, verifyReady: async (_pid, _operation, nonce) => { expect(nonce).toBe(claimId); ready = true; }, captureProcesses: async pids => { if (!ready) throw new Error("shell wrapper has not execed"); return [...pids]; }, readReceipt: async () => null, verifyReceipt: async () => { throw new Error("not launched"); } };
    await expect(f.manager.prepareWorkspace(f.context, taskTitle, operation(), { shellNonce: claimId })).resolves.toMatchObject({ paneId: "pane-1" });
    expect(f.prompts).toEqual([]);
  });

  it("does not report startup success from a late Session after the original native child changed", async () => {
    const f = await mappedFixture();
    f.mapping.verifyProcesses = async input => { if (input.receipt !== undefined && f.prompts.length > 0) throw new Error("original native child exited"); };
    await expect(f.manager.start(f.context, f.binding, { configuration: f.config, prompt: "once" }, operation())).rejects.toMatchObject({ submission: "unknown", promptSubmission: "submitted" });
    expect(f.prompts).toEqual(["once"]);
  });

  it("reobserves a terminating Windows process after submission without repeating input", async () => {
    const f = await mappedFixture(); setPlatform("win32"); let confirmations = 0;
    f.mapping.verifyProcesses = async input => {
      if (f.prompts.length === 0) return;
      expect(input.receipt).toEqual(f.receipt);
      if (++confirmations === 1) throw new WindowsProcessProofError("command-line", 0xc000010a | 0, "NTSTATUS");
    };
    await expect(f.manager.start(f.context, f.binding, { configuration: f.config, prompt: "once" }, operation())).resolves.toMatchObject({ nativeSession: { sessionId: nativeId } });
    expect(confirmations).toBe(2); expect(f.prompts).toEqual(["once"]);
    expect(f.calls.filter(call => call.method === "agent.start")).toHaveLength(1);
  });

  it("pins the first official Session while retrying when none existed before input", async () => {
    const f = await mappedFixture();
    await f.manager.launch(f.context, f.binding, { configuration: f.config }, operation());
    delete f.agents[0]!.agent_session; setPlatform("win32");
    f.hook(async method => {
      if (method === "session.snapshot" && f.prompts.length && !f.agents[0]!.agent_session) f.agents[0]!.agent_session = { source: "herdr:copilot", agent: "copilot", kind: "id", value: nativeId };
      return undefined;
    });
    let confirmations = 0;
    f.mapping.verifyProcesses = async () => {
      if (!f.prompts.length) return;
      confirmations++;
      f.agents[0]!.agent_session = { source: "herdr:copilot", agent: "copilot", kind: "id", value: projectId };
      throw new WindowsProcessProofError("command-line", 0xc000010a | 0, "NTSTATUS");
    };
    const error = await f.manager.submitInitialPrompt(f.context, f.binding, "once", operation()).catch(error => error);
    expect(error).toMatchObject({ promptSubmission: "submitted", cause: { errors: [expect.any(WindowsProcessProofError), expect.objectContaining({ message: expect.stringMatching(/session/i) })] } });
    expect(confirmations).toBe(1); expect(f.prompts).toEqual(["once"]);
  });

  it.each(["retry", "final"] as const)("rejects an original receipt changed during %s confirmation", async phase => {
    const f = await mappedFixture(); setPlatform("win32"); let confirmations = 0;
    f.mapping.verifyProcesses = async () => {
      if (!f.prompts.length) return;
      confirmations++; f.receipt.childPid++;
      if (phase === "retry") throw new WindowsProcessProofError("command-line", 0xc000010a | 0, "NTSTATUS");
    };
    const error = await f.manager.start(f.context, f.binding, { configuration: f.config, prompt: "once" }, operation()).catch(error => error);
    expect(error).toMatchObject({ promptSubmission: "submitted" });
    expect(error.cause.message).toMatch(/receipt|confirmation/i);
    if (phase === "retry") expect(error.cause.errors[1].message).toMatch(/receipt/i);
    expect(confirmations).toBe(1); expect(f.prompts).toEqual(["once"]);
  });

  it.each(["deadline", "cancelled"] as const)("retains the first termination error and terminal %s without another input", async terminal => {
    const f = await mappedFixture(); setPlatform("win32");
    const abort = new AbortController(), active = createOperation({ signal: abort.signal, limits: { totalMs: 10_000 } }); operations.push(active);
    const originalNow = performance.now.bind(performance); let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => originalNow() + elapsed);
    const first = new WindowsProcessProofError("command-line", 0xc000010a | 0, "NTSTATUS"); let confirmations = 0;
    f.mapping.verifyProcesses = async () => {
      if (!f.prompts.length) return;
      if (++confirmations === 2) { if (terminal === "deadline") elapsed = 20_000; else abort.abort(new Error("controlled cancellation")); }
      throw confirmations === 1 ? first : new WindowsProcessProofError("command-line", 0xc000010a | 0, "NTSTATUS");
    };
    const error = await f.manager.start(f.context, f.binding, { configuration: f.config, prompt: "once" }, active).catch(error => error);
    expect(error).toMatchObject({ promptSubmission: "submitted", cause: { cause: first, errors: [first, expect.objectContaining({ kind: terminal })] } });
    expect(confirmations).toBe(2); expect(f.prompts).toEqual(["once"]);
  });

  it.each(["aggregate", "wrapped", "access", "stage", "domain", "other", "non-windows"] as const)("does not retry a %s failure after initial input", async kind => {
    const f = await mappedFixture(); setPlatform("win32");
    const terminating = new WindowsProcessProofError("command-line", 0xc000010a | 0, "NTSTATUS");
    const failure = kind === "aggregate" ? new AggregateError([terminating, new Error("CloseHandle failed")], "close failed", { cause: terminating })
      : kind === "wrapped" ? new Error("wrapped failure", { cause: terminating })
      : kind === "access" ? new WindowsProcessProofError("command-line", 0xc0000022 | 0, "NTSTATUS")
      : kind === "stage" ? new WindowsProcessProofError("basic-information", 0xc000010a | 0, "NTSTATUS")
      : kind === "domain" ? new WindowsProcessProofError("command-line", 0xc000010a | 0, "Win32")
      : kind === "other" ? new Error("changed native birth") : terminating;
    let confirmations = 0;
    f.mapping.verifyProcesses = async () => { if (f.prompts.length) { confirmations++; if (kind === "non-windows") setPlatform("linux"); throw failure; } };
    await expect(f.manager.start(f.context, f.binding, { configuration: f.config, prompt: "once" }, operation())).rejects.toMatchObject({ promptSubmission: "submitted", cause: failure });
    expect(confirmations).toBe(1); expect(f.prompts).toEqual(["once"]);
  });

  it("keeps pre-input Windows termination failures closed without retrying", async () => {
    const f = await mappedFixture(); setPlatform("win32"); let checks = 0;
    const failure = new WindowsProcessProofError("command-line", 0xc000010a | 0, "NTSTATUS");
    f.mapping.verifyProcesses = async () => { checks++; throw failure; };
    await expect(f.manager.start(f.context, f.binding, { configuration: f.config, prompt: "never" }, operation())).rejects.toMatchObject({ cause: failure });
    expect(checks).toBe(1); expect(f.prompts).toEqual([]);
  });

  it("keeps input closed when the receipt processes do not belong to the original shell", async () => {
    const f = await mappedFixture();
    f.mapping.verifyProcesses = async input => { if (input.receipt !== undefined) throw new Error("foreign helper parent"); };
    await expect(f.manager.start(f.context, f.binding, { configuration: f.config, prompt: "never submit" }, operation())).rejects.toMatchObject({ submission: "unknown" });
    expect(f.prompts).toEqual([]);
  });

  it("rechecks the original native process chain immediately before initial input", async () => {
    const f = await mappedFixture(); let checks = 0;
    f.mapping.verifyProcesses = async input => { if (input.receipt !== undefined && ++checks > 1) throw new Error("native child replaced"); };
    await expect(f.manager.start(f.context, f.binding, { configuration: f.config, prompt: "never submit" }, operation())).rejects.toMatchObject({ promptSubmission: "not-submitted" });
    expect(f.prompts).toEqual([]);
  });

  it("does not send continuation input before the original official hook reports a Session", async () => {
    const f = await mappedFixture();
    f.hook(async (method, params) => { if (method === "agent.start") { const agent = f.launch(params); delete agent.agent_session; return { type: "agent_started", agent, argv: ["copilot", ...params.args as string[]] }; } return undefined; });
    await f.manager.launch(f.context, f.binding, { configuration: f.config }, operation());
    await expect(f.manager.submitPrompt(f.context, f.binding, "must not ping", operation())).rejects.toMatchObject({ promptSubmission: "not-submitted" });
    expect(f.prompts).toEqual([]);
  });

  it("fences an initial input across manager reconstruction using the original mapping", async () => {
    const f = await mappedFixture();
    await f.manager.start(f.context, f.binding, { configuration: f.config, prompt: "once" }, operation());
    const other = createHerdrAgentManager({ rpc: f.rpc, session: "w", preflight: { verifyStart: async () => {} }, workspaceEnvironment: { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" }, toolMapping: async () => f.mapping });
    await expect(other.submitInitialPrompt(f.context, f.binding, "never repeat", operation())).rejects.toMatchObject({ promptSubmission: "unknown" });
    expect(f.prompts).toEqual(["once"]);
  });

  it("does not reserve mapped initial input when its final guard skips submission", async () => {
    const f = await mappedFixture(), completed = vi.fn();
    await f.manager.launch(f.context, f.binding, { configuration: f.config }, operation());
    const verify = vi.fn(async () => {}); f.mapping.verifyProcesses = verify;
    const guard = vi.fn(async () => { expect(verify).toHaveBeenCalledOnce(); return false; });
    await expect(f.manager.submitInitialPrompt(f.context, f.binding, "once", operation(), guard, completed)).resolves.toMatchObject({ submission: "skipped" });
    expect(guard).toHaveBeenCalledOnce(); expect(completed).not.toHaveBeenCalled(); expect(f.prompts).toEqual([]);
    await expect(readFile(mappingFiles(f.mapping.manifestPath).initialInput)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(f.manager.submitInitialPrompt(f.context, f.binding, "once", operation(), async () => true, completed)).resolves.toMatchObject({ submission: "submitted" });
    const reservation = await readFile(mappingFiles(f.mapping.manifestPath).initialInput, "utf8");
    await expect(f.manager.submitInitialPrompt(f.context, f.binding, "must not repeat", operation(), async () => true, completed)).rejects.toMatchObject({ promptSubmission: "unknown" });
    expect(await readFile(mappingFiles(f.mapping.manifestPath).initialInput, "utf8")).toBe(reservation);
    expect(completed).toHaveBeenCalledOnce(); expect(f.prompts).toEqual(["once"]);
  });

  it.each(["submitted", "cancelled", "unknown"] as const)("keeps mapped continuation admission at dispatch for a %s outcome", async outcome => {
    const f = await mappedFixture(), completed = vi.fn();
    await f.manager.start(f.context, f.binding, { configuration: f.config, prompt: "initial" }, operation());
    const reservation = await readFile(mappingFiles(f.mapping.manifestPath).initialInput, "utf8"), order: string[] = [];
    f.mapping.verifyProcesses = async () => { order.push("process-proof"); };
    const failure = new HerdrRpcError("prompt response lost", { method: "agent.prompt", requestId: "lost", submission: "unknown" });
    f.hook(async method => { order.push(method); if (method === "agent.prompt" && outcome === "unknown") throw failure; return undefined; });
    const abort = new AbortController(), active = createOperation({ signal: abort.signal }); operations.push(active);
    const guard = vi.fn(async () => { expect(order).toContain("process-proof"); order.push("guard"); if (outcome === "cancelled") abort.abort(); return true; });
    const pending = f.manager.submitPrompt(f.context, f.binding, "continuation", active, guard, completed);
    if (outcome === "submitted") {
      await expect(pending).resolves.toMatchObject({ submission: "submitted" });
      expect(f.prompts).toEqual(["initial", "continuation"]); expect(completed).toHaveBeenCalledOnce();
    } else {
      await expect(pending).rejects.toMatchObject({ action: "agent.prompt", promptSubmission: outcome === "cancelled" ? "not-submitted" : "unknown", cause: outcome === "cancelled" ? expect.objectContaining({ kind: "cancelled" }) : failure });
      expect(f.prompts).toEqual(["initial"]); expect(completed).not.toHaveBeenCalled();
    }
    expect(guard).toHaveBeenCalledOnce();
    expect(order.slice(outcome === "cancelled" ? -1 : -2)).toEqual(outcome === "cancelled" ? ["guard"] : ["guard", "agent.prompt"]);
    expect(await readFile(mappingFiles(f.mapping.manifestPath).initialInput, "utf8")).toBe(reservation);
  });

  it("retains submitted input as unknown when blocked before the official Session confirmation", async () => {
    const f = await mappedFixture();
    f.hook(async (method, params) => {
      if (method === "agent.start") { const agent = f.launch(params); delete agent.agent_session; return { type: "agent_started", agent, argv: ["copilot", ...params.args as string[]] }; }
      if (method === "agent.prompt") { f.prompts.push(String(params.text)); f.agents[0]!.agent_status = "blocked"; return { type: "agent_prompted", agent: f.agents[0] }; }
      return undefined;
    });
    await expect(f.manager.start(f.context, f.binding, { configuration: f.config, prompt: "once" }, operation())).rejects.toMatchObject({ promptSubmission: "submitted" });
    await expect(f.manager.start(f.context, f.binding, { configuration: f.config, prompt: "never repeat" }, operation())).rejects.toMatchObject({ submission: "unknown" });
    expect(f.prompts).toEqual(["once"]);
  });

  it("keeps logical argv validation and refuses input when the selected launch has no receipt", async () => {
    const verifyReceipt = vi.fn(async () => { throw new Error("missing original launch receipt"); });
    const mapping = { ...mappingLifecycle, manifestPath: "/owned/manifest.json", nonce: nativeId, selectionKey: "a".repeat(64), environment: { DAYNIGHT_HERDR_TOOL_MANIFEST: "/owned/manifest.json" }, verifyReady: async () => {}, verifyReceipt, readReceipt: async () => null } satisfies HerdrToolLaunchMapping;
    const callback = vi.fn(async (_context: HerdrExecutionContext, _operation: Operation, _existingOnly?: boolean) => mapping);
    const f = await fixture("codex", { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" }, undefined, { toolMapping: callback });
    mapping.manifestPath = path.join(f.context.cwd, "manifest.json");
    mapping.environment.DAYNIGHT_HERDR_TOOL_MANIFEST = mapping.manifestPath;
    const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    expect(f.calls.find(call => call.method === "workspace.create")!.params.env).toMatchObject(mapping.environment);
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "never submit" }, operation())).rejects.toMatchObject({ submission: "unknown" });
    expect(verifyReceipt).toHaveBeenCalledOnce(); expect(f.prompts).toEqual([]);
    expect(f.calls.find(call => call.method === "agent.start")!.params).not.toHaveProperty("executable");
  });

  it("does not create mappings or replace a pane when reconnecting an existing workspace", async () => {
    const f = await fixture(), binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    const callback = vi.fn(async (_context: HerdrExecutionContext, _operation: Operation, existingOnly?: boolean) => { expect(existingOnly).toBe(true); return null; });
    const other = createHerdrAgentManager({ rpc: f.rpc, session: "w", preflight: { verifyStart: async () => {} }, workspaceEnvironment: { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" }, toolMapping: callback });
    expect(await other.prepareWorkspace(f.context, taskTitle, operation())).toEqual(binding);
    expect(callback).toHaveBeenCalledOnce();
    expect(f.calls.filter(call => call.method === "workspace.create")).toHaveLength(1);
    expect(f.calls.some(call => call.method === "layout.apply")).toBe(false);
  });
  it.each([
    { unknownResponse: false, mismatch: undefined, cwdVariant: "exact" }, { unknownResponse: true, mismatch: undefined, cwdVariant: "exact" },
    ...["workspace_id", "tab_id", "type", "pane_id", "cwd", "command"].map(mismatch => ({ unknownResponse: true, mismatch, cwdVariant: "exact" })),
    ...["trailing", "different", "relative", "missing"].map(cwdVariant => ({ unknownResponse: true, mismatch: cwdVariant === "trailing" ? undefined : "cwd", cwdVariant })),
    ...["readiness", "capture", "readiness-aborted", "capture-aborted"].map(phaseFailure => ({ unknownResponse: false, mismatch: undefined, cwdVariant: "exact", phaseFailure })),
  ])("prepares one root PowerShell layout without replay and diagnoses $mismatch ($unknownResponse, $cwdVariant, $phaseFailure)", async input => {
    const { unknownResponse, mismatch, cwdVariant } = input;
    const phaseFailure = "phaseFailure" in input && typeof input.phaseFailure === "string" ? input.phaseFailure : undefined;
    const cancellation = new AbortController();
    const prerequisiteFailure = phaseFailure?.endsWith("-aborted") ? new HerdrCommandCleanupError([new Error("isolated unconfirmed close")], new Error("isolated command deadline")) : new Error("isolated prerequisite command timeout");
    let mapping: HerdrToolLaunchMapping;
    const ready = vi.fn(async (_pid: number) => { if (phaseFailure?.startsWith("readiness")) { if (phaseFailure.endsWith("-aborted")) cancellation.abort(); throw prerequisiteFailure; } });
    const f = await fixture("copilot", { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" }, undefined, { toolMapping: async () => mapping });
    let observedCwd = f.context.cwd;
    if (cwdVariant === "trailing") observedCwd += path.sep;
    if (cwdVariant === "different") { observedCwd = path.join(f.context.cwd, "different-directory"); await mkdir(observedCwd); }
    if (cwdVariant === "relative") observedCwd = path.relative(process.cwd(), f.context.cwd);
    if (cwdVariant === "missing") observedCwd = path.join(f.context.cwd, "missing-directory");
    const command = ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoProfile", "-NoLogo", "-NoExit", "-File", "C:\\owned\\bootstrap.ps1"];
    mapping = { ...mappingLifecycle, manifestPath: path.join(f.context.cwd, "manifest.json"), nonce: nativeId, selectionKey: "a".repeat(64), environment: { DAYNIGHT_HERDR_TOOL_MANIFEST: path.join(f.context.cwd, "manifest.json") }, windowsCommand: command, verifyReady: ready, readReceipt: async () => null, verifyReceipt: async () => { throw new Error("not launched"); } };
    if (phaseFailure?.startsWith("capture")) mapping.captureProcesses = async () => { if (phaseFailure.endsWith("-aborted")) cancellation.abort(); throw prerequisiteFailure; };
    f.executing.add(100);
    f.hook(async (method, params) => {
      if (method === "layout.apply") {
        expect(params).not.toHaveProperty("workspace_id");
        expect(params).toMatchObject({ focus: false, root: { type: "pane", command, cwd: f.context.cwd, env: mapping.environment } });
        const workspaceId = f.workspaces[0]!.workspace_id;
        f.panes.splice(0, f.panes.length, { pane_id: "prepared-pane", terminal_id: "prepared-terminal", workspace_id: workspaceId, tab_id: "prepared-tab", cwd: f.context.cwd, agent_status: "unknown" });
        f.tabs.splice(0, f.tabs.length, { tab_id: "prepared-tab", workspace_id: workspaceId });
        f.processes.set("prepared-pane", [101]); f.executing.delete(100);
        if (unknownResponse) throw new HerdrRpcError("layout response lost", { method, requestId: "layout", submission: "unknown" });
        return { type: "layout_apply", layout: {} };
      }
      if (method === "layout.export") {
        const layout = { workspace_id: f.workspaces[0]!.workspace_id, tab_id: "prepared-tab", root: { type: "pane", pane_id: "prepared-pane", cwd: observedCwd, command, env: { PRIVATE_FIXTURE_VALUE: "must-never-appear-in-layout-diagnostics" } } };
        if (mismatch === "workspace_id" || mismatch === "tab_id") layout[mismatch] = "different";
        else if (mismatch !== undefined && cwdVariant === "exact") Object.assign(layout.root, { [mismatch]: mismatch === "command" ? Array.from({ length: 50 }, () => `token-secret-must-not-leak${"x".repeat(8192)}`) : "different" });
        return { type: "layout_export", layout };
      }
      if (method === "pane.process_info" && params.pane_id === "prepared-pane") return { type: "pane_process_info", process_info: { pane_id: "prepared-pane", shell_pid: 101, foreground_process_group_id: 101, foreground_processes: [{ pid: 101 }] } };
      return undefined;
    });
    if (phaseFailure !== undefined) {
      const active = createOperation({ signal: cancellation.signal }); operations.push(active);
      const error = await f.manager.prepareWorkspace(f.context, taskTitle, active).catch(error => error);
      expect(error).toMatchObject({ action: "workspace.create", submission: "unknown", cause: { message: expect.stringContaining(phaseFailure.split("-")[0]!), cause: prerequisiteFailure } });
      expect(error.cause.message).toMatch(phaseFailure.endsWith("-aborted") ? /startedRemainingMs=\d+, remainingMs=null/ : /startedRemainingMs=\d+, remainingMs=\d+/);
      expect(f.calls.filter(call => call.method === "layout.apply")).toHaveLength(1);
      return;
    }
    if (mismatch !== undefined) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const error = await f.manager.prepareWorkspace(f.context, taskTitle, operation()).catch(error => error);
        expect(error).toMatchObject({ submission: "unknown", cause: { message: expect.stringContaining(mismatch) } });
        expect(error.cause.message).not.toContain("must-never-appear-in-layout-diagnostics");
        expect(error.cause.message).not.toContain("token-secret-must-not-leak");
        expect(error.cause.message.length).toBeLessThanOrEqual(8192);
        if (mismatch === "command") {
          const diagnostic = JSON.parse(error.cause.message);
          expect(diagnostic.expected.command).toEqual(command);
          expect(diagnostic.observed.command).toMatchObject({ type: "array", length: 50, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), differingIndices: Array.from({ length: 16 }, (_, index) => index) });
        }
      }
      expect(ready).not.toHaveBeenCalled();
      expect(f.calls.filter(call => call.method === "layout.apply")).toHaveLength(1);
      return;
    }
    const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    expect(binding).toMatchObject({ paneId: "prepared-pane", terminalId: "prepared-terminal" });
    expect(ready).toHaveBeenCalledWith(101, expect.anything());
    expect(await f.manager.prepareWorkspace(f.context, taskTitle, operation())).toEqual(binding);
    expect(f.calls.filter(call => call.method === "layout.apply")).toHaveLength(1);
  });
  it("disables automatic updates for a frozen Copilot launch while retaining logical native arguments", () => {
    const toolLaunch = frozenToolLaunch("copilot", "herdr");
    expect(buildHerdrAgentArguments({ agent: "copilot", model: null, args: [], toolLaunch }, "/task")).toEqual(["--no-auto-update", "--allow-all", "--no-ask-user", "--no-sandbox"]);
  });
  it("retains hidden helper/native descendants and retires a mapping only after their confirmed stop", async () => {
    let mapping: HerdrToolLaunchMapping;
    const stopped = vi.fn(async () => {}), retired = vi.fn(async () => {}), callback = vi.fn(async (_context: HerdrExecutionContext, _operation: Operation, _existingOnly?: boolean) => mapping);
    const f = await fixture("copilot", { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" }, undefined, { toolMapping: callback });
    const receipt = { schemaVersion: 1 as const, owner: f.context, nonce: nativeId, selectionKey: "a".repeat(64), logicalArgvDigest: "b".repeat(64), file: "/selected/copilot", prefixArgs: [], helperPid: 300, childPid: 301 };
    mapping = { ...mappingLifecycle, manifestPath: path.join(f.context.cwd, "manifest.json"), nonce: nativeId, selectionKey: receipt.selectionKey, environment: { DAYNIGHT_HERDR_TOOL_MANIFEST: path.join(f.context.cwd, "manifest.json") }, verifyReady: async () => {}, verifyReceipt: async () => receipt, readReceipt: async () => receipt, captureProcesses: async pids => [...pids, 302], stopProcesses: stopped, confirmStopped: async () => ![300, 301, 302].some(id => f.executing.has(id)), retire: retired };
    const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    await f.manager.launch(f.context, binding, { configuration: { agent: "copilot", model: null, args: [] } }, operation());
    [300, 301, 302].forEach(id => f.executing.add(id));
    await expect(f.manager.stopAndClose(f.context, binding, operation(30))).rejects.toMatchObject({ kind: "deadline" });
    expect(retired).not.toHaveBeenCalled();
    expect(stopped).toHaveBeenCalledOnce();
    await expect(f.manager.prepareWorkspace(f.context, taskTitle, operation())).rejects.toThrow("stop");
    f.executing.delete(300); f.executing.delete(301);
    await expect(f.manager.stopAndClose(f.context, binding, operation(30))).rejects.toMatchObject({ kind: "deadline" });
    f.executing.delete(302); await f.manager.stopAndClose(f.context, binding, operation());
    expect(stopped).toHaveBeenCalledTimes(3);
    expect(retired).toHaveBeenCalledOnce();
    await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    expect(callback.mock.calls.at(-1)?.[2]).toBe(false);
  });
  it.each([undefined, nativeId])("owns full access while preserving model/configuration/exact resume selection (%s)", (resume) => {
    expect(buildHerdrAgentArguments(configuration, "/task", resume)).toEqual(["--no-daemon", ...(resume === undefined ? ["--model", "model-a"] : ["resume", resume]), ...(resume === undefined ? configuration.args : ["--no-alt-screen"]), "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "-c", "check_for_update_on_startup=false", ...codexProjectTrustArguments("/task")]);
    expect(buildHerdrAgentArguments({ agent: "copilot", model: null, args: ["--allow-tool=shell(git:*)", "--reasoning-effort", "low"] }, "/task", resume)).toEqual([...(resume === undefined ? [] : [`--resume=${resume}`]), "--allow-tool=shell(git:*)", ...(resume === undefined ? ["--reasoning-effort", "low"] : []), "--allow-all", "--no-ask-user", "--no-sandbox"]);
  });
  it.each([undefined, nativeId])("disables startup updates after configurable overrides for fresh/resumed Codex (%s)", (resume) => {
    for (const configured of [["-c", "check_for_update_on_startup=true"], ["--config", "check_for_update_on_startup=true"], ["--config=check_for_update_on_startup=true"]]) {
      const args = buildHerdrAgentArguments({ ...configuration, args: configured }, "/task", resume);
      expect(args.slice(-4)).toEqual(["-c", "check_for_update_on_startup=false", ...codexProjectTrustArguments("/task")]);
      expect(args.slice(3, -(4 + 2))).toEqual(configured);
    }
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
  it("owns Claude resume and model arguments while refusing print, prompt, and settings overrides", () => {
    expect(buildHerdrAgentArguments({ agent: "claude", model: "sonnet", args: ["--permission-mode", "default"] }, "/task", nativeId)).toEqual(["--resume", nativeId, "--permission-mode", "default", "--dangerously-skip-permissions"]);
    for (const arg of ["--print", "--resume", "--session-id", "--settings", "--setting-sources", "business prompt"]) expect(() => validateHerdrAgentArguments("claude", [arg])).toThrow();
  });
  it("resumes each provider without overriding its saved model or effort", () => {
    expect(buildHerdrAgentArguments({ agent: "codex", model: "new", args: ["--config=model=\"new\"", "-c", 'model_reasoning_effort="high"', "--config", '"model_reasoning_effort"="low"', "-c", 'features.web_search_request=true', "--profile", "work"] }, "/task", nativeId))
      .toEqual(["--no-daemon", "resume", nativeId, "-c", "features.web_search_request=true", "--profile", "work", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "-c", "check_for_update_on_startup=false", ...codexProjectTrustArguments("/task")]);
    expect(buildHerdrAgentArguments({ agent: "claude", model: "new", args: ["--effort=high", "--effort", "low", "--add-dir", "/other"] }, "/task", nativeId))
      .toEqual(["--resume", nativeId, "--add-dir", "/other", "--dangerously-skip-permissions"]);
    expect(buildHerdrAgentArguments({ agent: "copilot", model: "new", args: ["--reasoning-effort=xhigh", "--reasoning-effort", "low", "--no-auto-update"] }, "/task", nativeId))
      .toEqual([`--resume=${nativeId}`, "--no-auto-update", "--allow-all", "--no-ask-user", "--no-sandbox"]);
  });
});

describe("direct task resource management", () => {
  it.each(nativeDisabledClips)("retains initial/continuation input on a source-owned clipped disabled field: $visible", async ({ visible }) => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    f.screen.text = `› ${visible}\n\n ? for shortcuts`;
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "initial" }, operation())).rejects.toMatchObject({ name: "HerdrInputBlockedError", blocker: "disabled" });
    await expect(f.manager.submitPrompt(f.context, binding, "continuation", operation())).rejects.toMatchObject({ name: "HerdrInputBlockedError", blocker: "disabled" });
    expect(f.prompts).toEqual([]);
    f.screen.text = `A historical code sample:\n› ${visible}\n\n› Continue`;
    await f.manager.submitPrompt(f.context, binding, "continuation after dismissal", operation());
    expect(f.prompts).toEqual(["continuation after dismissal"]);
  });

  it.each(nativeKeyDisplays)("keeps input unsent for production $platform key display $spec = $display", async ({ display }) => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    const screen = nativeMenuScreens.find(menu => menu.name === "hooks_browser_handlers")!.screen;
    f.screen.text = screen.replace("esc back", `${display} back`);
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "initial" }, operation())).rejects.toBeInstanceOf(HerdrInputBlockedError);
    await expect(f.manager.submitPrompt(f.context, binding, "continuation", operation())).rejects.toBeInstanceOf(HerdrInputBlockedError);
    expect(f.prompts).toEqual([]);
  });

  it.each(nativeMenuScreens)("keeps initial and continuation input unsent in the native $name menu", async ({ screen }) => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation()); f.screen.text = screen;
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "initial" }, operation())).rejects.toBeInstanceOf(HerdrInputBlockedError);
    await expect(f.manager.submitPrompt(f.context, binding, "continuation", operation())).rejects.toBeInstanceOf(HerdrInputBlockedError);
    expect(f.prompts).toEqual([]);
    f.screen.text = `${screen}\n› Any custom current composer`;
    await f.manager.submitPrompt(f.context, binding, "continuation after dismissal", operation());
    expect(f.prompts).toEqual(["continuation after dismissal"]);
  });

  it.each(["fork", "restore"])("keeps input unsent for the source-owned session-picker %s action", async action => {
    const f = await fixture(); const binding = await launch(f); f.prompts.splice(0);
    f.screen.text = nativeMenuScreens.find(menu => menu.name === "resume_picker_118x30")!.screen
      .replace("Resume a previous session", action === "fork" ? "Fork a previous session" : "Resume a previous session")
      .replace("enter resume", `enter ${action}`).replace("esc new", "esc clear search").replace("⌃c quit", "⌃c exit");
    await expect(f.manager.submitPrompt(f.context, binding, "continuation", operation())).rejects.toBeInstanceOf(HerdrInputBlockedError);
    expect(f.prompts).toEqual([]);
  });

  it.each(narrowSessionPickerScreens)("retains input until the primary-only $action session picker closes", async ({ screen }) => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    f.screen.text = screen;
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "initial" }, operation())).rejects.toMatchObject({ name: "HerdrInputBlockedError", blocker: "menu", promptSubmission: "not-submitted" });
    await expect(f.manager.submitPrompt(f.context, binding, "continuation", operation())).rejects.toMatchObject({ name: "HerdrInputBlockedError", blocker: "menu", promptSubmission: "not-submitted" });
    expect(f.prompts).toEqual([]);
    f.screen.text = `${screen}\n› Any custom current composer`;
    await expect(f.manager.submitInitialPrompt(f.context, binding, "initial", operation())).resolves.toMatchObject({ submission: "submitted" });
    await f.manager.submitPrompt(f.context, binding, "continuation", operation());
    expect(f.prompts).toEqual(["initial", "continuation"]);
  });

  it.each(expandedNarrowSessionPickerScreens)("retains input on an expanded primary-only $action picker with an inline error", async ({ screen }) => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    f.screen.text = screen;
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "initial" }, operation())).rejects.toMatchObject({ name: "HerdrInputBlockedError", blocker: "menu", promptSubmission: "not-submitted" });
    await expect(f.manager.submitPrompt(f.context, binding, "continuation", operation())).rejects.toMatchObject({ name: "HerdrInputBlockedError", blocker: "menu", promptSubmission: "not-submitted" });
    expect(f.prompts).toEqual([]);
    f.screen.text = `${screen}\n› Any custom current composer`;
    await f.manager.submitInitialPrompt(f.context, binding, "initial", operation());
    expect(f.prompts).toEqual(["initial"]);
  });

  it("rechecks new-launch readiness after awaited shell verification before dispatch", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    let complete = true;
    const submitting = vi.fn();
    await expect(f.manager.launch(f.context, binding, {
      configuration, canAdmitNewExecution: () => complete, onSubmitting: submitting,
      beforeStart: async () => { await Promise.resolve(); complete = false; },
    }, operation())).rejects.toBeInstanceOf(ConfigurationAdmissionWaiting);
    expect(f.calls.filter(call => call.method === "agent.start")).toEqual([]);
    expect(submitting).not.toHaveBeenCalled();
    complete = true;
    await f.manager.launch(f.context, binding, { configuration, canAdmitNewExecution: () => complete, onSubmitting: submitting }, operation());
    expect(submitting).toHaveBeenCalledOnce();
  });

  it("returns a launched process before its first input or native SessionStart", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    f.hook(async (method, params) => {
      if (method !== "agent.start") return undefined;
      const agent = f.launch(params); delete agent.agent_session;
      return { type: "agent_started", agent, argv: ["codex", ...params.args as string[]] };
    });
    const result = await f.manager.launch(f.context, binding, { configuration }, operation());
    expect(result).toMatchObject({ interactiveReady: true, nativeSession: null });
    expect(f.prompts).toEqual([]);
    expect(await f.manager.processInfo(f.context, binding, operation())).toEqual({ shellPid: 100, foregroundPids: [100, 200] });
    await f.manager.submitInitialPrompt(f.context, binding, "assignment after durable identity", operation());
    expect(f.prompts).toEqual(["assignment after durable identity"]);
  });

  it("returns a blocked launch for identity capture without attempting its first input", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    f.hook(async (method, params) => {
      if (method !== "agent.start") return undefined;
      const agent = f.launch(params); agent.agent_status = "blocked";
      return { type: "agent_started", agent, argv: ["codex", ...params.args as string[]] };
    });
    expect(await f.manager.launch(f.context, binding, { configuration }, operation())).toMatchObject({ status: "blocked" });
    expect(f.prompts).toEqual([]);
  });

  it("rechecks first-input admission after readiness and skips revoked input", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    await f.manager.launch(f.context, binding, { configuration }, operation());
    const result = await f.manager.submitInitialPrompt(f.context, binding, "revoked assignment", operation(), async () => false);
    expect(result.submission).toBe("skipped");
    expect(f.prompts).toEqual([]);
  });

  it("rejects process discovery when the original terminal changes during the query", async () => {
    const f = await fixture(); const binding = await launch(f);
    f.hook(async (method) => {
      if (method === "pane.process_info") f.panes[0]!.terminal_id = "replacement";
      return undefined;
    });
    await expect(f.manager.processInfo(f.context, binding, operation())).rejects.toThrow("terminal identity has changed");
  });

  it("rejects process discovery from another pane", async () => {
    const f = await fixture(); const binding = await launch(f);
    f.hook(async (method) => method === "pane.process_info" ? { type: "pane_process_info", process_info: { pane_id: "replacement", shell_pid: 100, foreground_processes: [] } } : undefined);
    await expect(f.manager.processInfo(f.context, binding, operation())).rejects.toThrow("another pane");
  });

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

  it("adds a validated shell startup nonce only to a newly created workspace", async () => {
    const f = await fixture("codex");
    const shellNonce = "12345678-1234-4234-8234-123456789abc";
    const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation(), { shellNonce });
    expect(f.calls.find(call => call.method === "workspace.create")!.params.env).toMatchObject({ DAYNIGHT_HERDR_SHELL_NONCE: shellNonce });
    await f.manager.prepareWorkspace(f.context, taskTitle, operation(), { shellNonce: "22345678-1234-4234-8234-123456789abc" });
    expect(f.calls.filter(call => call.method === "workspace.create")).toHaveLength(1);
    expect(binding.paneId).toBeTruthy();
  });

  it("rejects a malformed shell startup nonce before touching a workspace", async () => {
    const f = await fixture("codex");
    await expect(f.manager.prepareWorkspace(f.context, taskTitle, operation(), { shellNonce: "../foreign" })).rejects.toThrow("nonce");
    expect(f.calls).toEqual([]);
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

  it.each([undefined, nativeId])("passes Codex update configuration through RPC separately from opaque task input (%s)", async (resume) => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    const instructionPath = String.raw`/repo/中文 'task' "quoted" $HOME;$(echo literal).md`;
    const config: HerdrAgentConfiguration = { ...configuration, args: ["--config", `model_instructions_file=${JSON.stringify(instructionPath)}`, "--no-alt-screen"] };
    const prompt = `Continue 中文 task with 'quotes', "quotes", $HOME; $(echo literal).\n-c check_for_update_on_startup=true belongs to this task text.`;
    await f.manager.start(f.context, binding, { configuration: config, prompt, ...(resume === undefined ? {} : { resumeSessionId: resume }) }, operation());
    const args = f.calls.find((call) => call.method === "agent.start")!.params.args as string[];
    expect(args).toContain(`model_instructions_file=${JSON.stringify(instructionPath)}`);
    expect(args.slice(-4)).toEqual(["-c", "check_for_update_on_startup=false", ...codexProjectTrustArguments(await realpath(f.context.cwd))]);
    expect(args).not.toContain(prompt);
    expect(f.prompts).toEqual([prompt]);
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

  const busyShell = () => new HerdrRpcError("agent target pane is not an available shell", { method: "agent.start", requestId: "busy", code: "agent_pane_busy", submission: "unknown" });
  const shellProcesses = (binding: HerdrTaskBinding, extra: Entry = {}): HerdrRpcResult => ({ type: "pane_process_info", process_info: { pane_id: binding.paneId, shell_pid: 100, foreground_process_group_id: 100, foreground_processes: [{ pid: 100, name: "/bin/bash", argv: ["-bash"] }, { pid: 101, name: "shell startup script" }], ...extra } });

  it("reports a definite busy rejection before a retry loses configuration admission", async () => {
    const f = await fixture(), binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    let complete = true;
    const onRejected = vi.fn((error: HerdrAgentActionError) => { expect(error).toMatchObject({ submission: "rejected", cause: { method: "agent.start", code: "agent_pane_busy" } }); complete = false; });
    f.hook(async method => {
      if (method === "agent.start") throw busyShell();
      if (method === "pane.process_info") return shellProcesses(binding);
      return undefined;
    });
    await expect(f.manager.launch(f.context, binding, { configuration, canAdmitNewExecution: () => complete, onRejected }, operation())).rejects.toBeInstanceOf(ConfigurationAdmissionWaiting);
    expect(onRejected).toHaveBeenCalledOnce();
    expect(f.calls.filter(call => call.method === "agent.start")).toHaveLength(1);
    expect(f.prompts).toEqual([]);
  });

  it("readmits the exact mapped request after a definite busy rejection and configuration recovery", async () => {
    const f = await mappedFixture(); let complete = true;
    f.hook(async method => {
      if (method === "agent.start") throw busyShell();
      if (method === "pane.process_info") return shellProcesses(f.binding);
      return undefined;
    });
    await expect(f.manager.launch(f.context, f.binding, { configuration: f.config, canAdmitNewExecution: () => complete, onRejected: () => { complete = false; } }, operation())).rejects.toBeInstanceOf(ConfigurationAdmissionWaiting);
    const file = path.join(f.context.cwd, "native-start.json"), rejected = JSON.parse(await readFile(file, "utf8"));
    expect(rejected).toMatchObject({ state: "rejected", rejectionCode: "agent_pane_busy", attempt: 0 });
    complete = true; f.hook(undefined);
    await f.manager.launch(f.context, f.binding, { configuration: f.config, canAdmitNewExecution: () => complete }, operation());
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ requestId: rejected.requestId, state: "reserved", rejectionCode: null, attempt: 1 });
    expect(f.calls.filter(call => call.method === "agent.start")).toHaveLength(2);
    expect(f.prompts).toEqual([]);
  });

  it.each(["admission", "submission-hook"] as const)("keeps a mapped reservation recoverable when %s prevents actual dispatch", async failure => {
    const f = await mappedFixture(); let admissions = 0;
    const hookFailure = new Error("Original launch state could not be committed.");
    const attempt = f.manager.launch(f.context, f.binding, { configuration: f.config,
      canAdmitNewExecution: () => ++admissions === 1 || failure !== "admission",
      onSubmitting: () => { if (failure === "submission-hook") throw hookFailure; },
    }, operation());
    if (failure === "admission") await expect(attempt).rejects.toBeInstanceOf(ConfigurationAdmissionWaiting);
    else await expect(attempt).rejects.toBe(hookFailure);
    expect(f.calls.filter(call => call.method === "agent.start")).toEqual([]);
    const file = path.join(f.context.cwd, "native-start.json"), held = JSON.parse(await readFile(file, "utf8"));
    expect(held).toMatchObject({ state: "not_submitted", rejectionCode: null, attempt: 0 });
    await f.manager.launch(f.context, f.binding, { configuration: f.config, canAdmitNewExecution: () => true }, operation());
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ requestId: held.requestId, state: "reserved", attempt: 1 });
    expect(f.calls.filter(call => call.method === "agent.start")).toHaveLength(1);
    expect(f.prompts).toEqual([]);
  });

  it("does not report an unknown start response as a definite busy rejection", async () => {
    const f = await fixture(), binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    const onRejected = vi.fn(), unknown = new HerdrRpcError("Start result unknown.", { method: "agent.start", requestId: "unknown", submission: "unknown" });
    f.hook(async method => { if (method === "agent.start") throw unknown; return undefined; });
    await expect(f.manager.launch(f.context, binding, { configuration, onRejected }, operation())).rejects.toMatchObject({ submission: "unknown", cause: unknown });
    expect(onRejected).not.toHaveBeenCalled();
    expect(f.calls.filter(call => call.method === "agent.start")).toHaveLength(1);
  });

  it.each(["/bin/bash", "-zsh", "/usr/local/bin/fish", "C:\\shell\\pwsh.exe"])("retries a rejected launch while the original %s shell initializes", async (shell) => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    let attempts = 0;
    f.hook(async (method) => {
      if (method === "agent.start" && ++attempts < 3) throw busyShell();
      if (method === "pane.process_info") return shellProcesses(binding, { foreground_processes: [{ pid: 100, name: "initializing", argv: [shell] }, { pid: 101, name: "startup script" }] });
      return undefined;
    });
    expect((await f.manager.start(f.context, binding, { configuration, prompt: "assignment" }, operation())).nativeSession?.sessionId).toBe(nativeId);
    const starts = f.calls.filter((call) => call.method === "agent.start");
    expect(starts).toHaveLength(3);
    expect(starts.every((call) => call.params.pane_id === binding.paneId)).toBe(true);
    expect(f.prompts).toEqual(["assignment"]); expect(f.preflights()).toBe(1);
  });

  it("retries the split launch without requiring SessionStart or submitting initial input", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    let attempts = 0;
    f.hook(async (method, params) => {
      if (method === "pane.process_info") return shellProcesses(binding);
      if (method !== "agent.start") return undefined;
      if (++attempts === 1) throw busyShell();
      const agent = f.launch(params); delete agent.agent_session;
      return { type: "agent_started", agent, argv: ["codex", ...params.args as string[]] };
    });
    const launched = await f.manager.launch(f.context, binding, { configuration }, operation());
    expect(attempts).toBe(2);
    expect(launched).toMatchObject({ interactiveReady: true, nativeSession: null });
    expect(f.prompts).toEqual([]);
    await f.manager.submitInitialPrompt(f.context, binding, "assignment", operation());
    expect(f.prompts).toEqual(["assignment"]);
    expect(attempts).toBe(2);
  });

  it("checks start admission immediately before every native launch attempt", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    const order: string[] = []; const op = operation();
    const beforeStart = vi.fn(async (active: Operation) => { expect(active).toBe(op); order.push("guard"); });
    let attempts = 0;
    f.hook(async method => {
      if (method === "pane.process_info") return shellProcesses(binding);
      if (method === "agent.start") { order.push("start"); if (++attempts < 3) throw busyShell(); }
      return undefined;
    });
    await f.manager.launch(f.context, binding, { configuration, beforeStart }, op);
    expect(order).toEqual(["guard", "start", "guard", "start", "guard", "start"]);
    expect(beforeStart).toHaveBeenCalledTimes(3);
    expect(f.prompts).toEqual([]);
  });

  it("rejects a fresh launch when the original shell changes cwd during caller admission", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    const otherCwd = path.join(f.context.cwd, "other"); await mkdir(otherCwd);
    const beforeStart = vi.fn(async () => { f.panes[0]!.cwd = otherCwd; });
    await expect(f.manager.launch(f.context, binding, { configuration, beforeStart }, operation())).rejects.toMatchObject({
      action: "agent.start", submission: "not-submitted", message: expect.stringContaining(`cwd is ${otherCwd}; expected`), cause: expect.any(Error),
    });
    expect(beforeStart).toHaveBeenCalledOnce();
    expect(f.calls.filter(call => call.method === "agent.start")).toEqual([]);
    expect(f.prompts).toEqual([]);
  });

  it("does not retry a definitely rejected launch after the original shell changes cwd", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    const otherCwd = path.join(f.context.cwd, "other"); await mkdir(otherCwd);
    f.hook(async method => {
      if (method === "pane.process_info") return shellProcesses(binding);
      if (method === "agent.start") { f.panes[0]!.cwd = otherCwd; throw busyShell(); }
      return undefined;
    });
    await expect(f.manager.launch(f.context, binding, { configuration }, operation())).rejects.toMatchObject({ action: "agent.start", submission: "not-submitted", message: expect.stringContaining(`cwd is ${otherCwd}; expected`) });
    expect(f.calls.filter(call => call.method === "agent.start")).toHaveLength(1);
    expect(f.prompts).toEqual([]);
  });

  it.each(["pane_id", "terminal_id"])("does not launch after caller admission replaces the original %s", async field => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    await expect(f.manager.launch(f.context, binding, { configuration, beforeStart: async () => { f.panes[0]![field] = "replacement"; } }, operation())).rejects.toMatchObject({ action: "agent.start", submission: "not-submitted", cause: expect.any(Error) });
    expect(f.calls.filter(call => call.method === "agent.start")).toEqual([]);
    expect(f.prompts).toEqual([]);
  });

  it("preserves a failed final shell observation as a definitely unsubmitted launch", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    const failure = new HerdrRpcError("shell snapshot unavailable", { method: "session.snapshot", requestId: "final-shell", submission: "unknown" });
    let admitted = false;
    f.hook(async method => { if (method === "session.snapshot" && admitted) throw failure; return undefined; });
    await expect(f.manager.launch(f.context, binding, { configuration, beforeStart: async () => { admitted = true; } }, operation())).rejects.toMatchObject({ action: "agent.start", submission: "not-submitted", cause: failure });
    expect(f.calls.filter(call => call.method === "agent.start")).toEqual([]);
    expect(f.prompts).toEqual([]);
  });

  it.each([1, 2])("does not retry a rejected start guard on attempt %s", async rejectedAttempt => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    const failure = new HerdrAgentActionError("Original launch target changed.", "agent.start", "rejected", { cause: busyShell() });
    let attempts = 0; let checks = 0;
    const beforeStart = vi.fn(async () => { if (++checks === rejectedAttempt) throw failure; });
    f.hook(async method => {
      if (method === "pane.process_info") return shellProcesses(binding);
      if (method === "agent.start" && ++attempts === 1) throw busyShell();
      return undefined;
    });
    await expect(f.manager.launch(f.context, binding, { configuration, beforeStart }, operation())).rejects.toBe(failure);
    expect(beforeStart).toHaveBeenCalledTimes(rejectedAttempt);
    expect(attempts).toBe(rejectedAttempt - 1);
    expect(f.prompts).toEqual([]);
  });

  it.each([2500, 7500])("uses the remaining launch budget after admission consumes %s ms", async elapsed => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    let now = 1000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const op = createOperation({ limits: { totalMs: 10_000 } }); operations.push(op);
    try {
      const launched = f.manager.launch(f.context, binding, { configuration, beforeStart: async () => { now += elapsed; } }, op);
      if (elapsed === 2500) {
        await launched;
        expect(f.calls.filter(call => call.method === "agent.start")).toMatchObject([{ params: { timeout_ms: 7500 } }]);
      } else {
        await expect(launched).rejects.toMatchObject({ action: "agent.start", submission: "not-submitted" });
        expect(f.calls.filter(call => call.method === "agent.start")).toEqual([]);
      }
      expect(f.prompts).toEqual([]);
    } finally { clock.mockRestore(); }
  });

  it("does not reuse start admission after an unknown launch response", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    const beforeStart = vi.fn(async () => {});
    const failure = new HerdrRpcError("launch response lost", { method: "agent.start", requestId: "unknown", submission: "unknown" });
    f.hook(async method => { if (method === "agent.start") throw failure; return undefined; });
    await expect(f.manager.launch(f.context, binding, { configuration, beforeStart }, operation())).rejects.toMatchObject({ submission: "unknown", cause: failure });
    expect(beforeStart).toHaveBeenCalledOnce();
    expect(f.calls.filter(call => call.method === "agent.start")).toHaveLength(1);
    expect(f.prompts).toEqual([]);
  });

  it("bounds shell initialization retries and retains the actual rejected launch", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    const failure = busyShell();
    let attempts = 0;
    let now = performance.now();
    const op = operation();
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      f.hook(async (method) => {
        if (method === "agent.start") { if (++attempts === 2) now += 2001; throw failure; }
        if (method === "pane.process_info") return shellProcesses(binding);
        return undefined;
      });
      await expect(f.manager.start(f.context, binding, { configuration, prompt: "assignment" }, op)).rejects.toMatchObject({ action: "agent.start", submission: "rejected", cause: failure });
      expect(f.calls.filter((call) => call.method === "agent.start")).toHaveLength(2); expect(f.prompts).toEqual([]);
    } finally { clock.mockRestore(); }
  });

  it.each([
    { foreground_process_group_id: 200 },
    { foreground_process_group_id: undefined },
    { shell_pid: undefined },
    { foreground_processes: [] },
    { foreground_processes: [{ pid: 100, name: "codex", argv: ["codex"] }] },
    { foreground_processes: [{ pid: 200, name: "bash", argv: ["bash"] }] },
  ])("retains pane busy without shell initialization evidence: %j", async (info) => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    const failure = busyShell();
    f.hook(async (method) => { if (method === "agent.start") throw failure; if (method === "pane.process_info") return shellProcesses(binding, info); return undefined; });
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "assignment" }, operation())).rejects.toMatchObject({ submission: "rejected", cause: failure });
    expect(f.calls.filter((call) => call.method === "agent.start")).toHaveLength(1); expect(f.prompts).toEqual([]);
  });

  it.each([undefined, "agent_pane_unavailable", "agent_start_input_failed"])("does not retry a launch without a definite pane-busy rejection: %s", async (code) => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    const failure = new HerdrRpcError("launch unconfirmed", { method: "agent.start", requestId: "start", submission: "unknown", ...(code === undefined ? {} : { code }) });
    f.hook(async (method) => { if (method === "agent.start") throw failure; return undefined; });
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "assignment" }, operation())).rejects.toMatchObject({ cause: failure });
    expect(f.calls.filter((call) => call.method === "agent.start")).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === "pane.process_info")).toEqual([]); expect(f.prompts).toEqual([]);
  });

  it("stops shell-readiness retry when the original terminal changes", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    f.hook(async (method) => { if (method === "agent.start") { f.panes[0]!.terminal_id = "replacement"; throw busyShell(); } return undefined; });
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "assignment" }, operation())).rejects.toThrow("terminal identity has changed");
    expect(f.calls.filter((call) => call.method === "agent.start")).toHaveLength(1); expect(f.prompts).toEqual([]);
  });

  it("observes a native launch appearing during shell readiness without submitting another start", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    const failure = busyShell();
    f.hook(async (method) => {
      if (method === "agent.start") throw failure;
      if (method === "pane.process_info") { f.launch({ pane_id: binding.paneId, name: herdrExecutionAgentName(f.context) }); return shellProcesses(binding); }
      return undefined;
    });
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "assignment" }, operation())).rejects.toMatchObject({ submission: "rejected", cause: failure });
    expect(f.calls.filter((call) => call.method === "agent.start")).toHaveLength(1); expect(f.prompts).toEqual([]);
  });

  it("preserves cancellation before another shell-readiness attempt", async () => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    const controller = new AbortController(); const op = createOperation({ signal: controller.signal }); operations.push(op);
    const cancelled = new Error("stop shell readiness");
    f.hook(async (method) => {
      if (method === "agent.start") throw busyShell();
      if (method === "pane.process_info") { controller.abort(cancelled); return shellProcesses(binding); }
      return undefined;
    });
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "assignment" }, op)).rejects.toMatchObject({ kind: "cancelled", cause: cancelled });
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

  it.each(["codex", "claude"] as const)("reports a definitely unsent startup prompt while %s reports blocked", async (kind) => {
    const f = await fixture(kind); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    f.hook(async (method, params) => { if (method !== "agent.start") return undefined; const agent = f.launch(params); agent.agent_status = "blocked"; return { type: "agent_started", agent, argv: [kind, ...params.args as string[]] }; });
    await expect(f.manager.start(f.context, binding, { configuration: { agent: kind, model: null, args: [] }, prompt: "task" }, operation())).rejects.toMatchObject({ action: "agent.prompt", submission: "not-submitted", promptSubmission: "not-submitted" }); expect(f.prompts).toEqual([]);
  });

  it.each(["codex", "claude"] as const)("can submit a deferred first prompt before %s SessionStart has reported an ID", async (kind) => {
    const f = await fixture(kind); const binding = await launch(f); f.prompts.splice(0); delete f.agents[0]!.agent_session;
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

  it.each(["codex", "claude"] as const)("delivers %s initial and continuation input without a recognized composer or status layout", async (kind) => {
    const f = await fixture(kind); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    f.screen.text = "Custom terminal presentation without prompt, model or directory metadata";
    await f.manager.start(f.context, binding, { configuration: { agent: kind, model: null, args: [] }, prompt: "managed\nassignment" }, operation());
    f.agents[0]!.agent_status = "idle";
    await f.manager.submitPrompt(f.context, binding, "continue", operation());
    expect(f.prompts).toEqual(["managed\nassignment", "continue"]);
    expect(f.calls.filter((call) => call.method === "agent.read")).toHaveLength(2);
  });

  it.each([
    { agent: "codex" as const, screen: "Select model\n› 1. GPT-6.1 Terra\n  2. GPT-6.1 Sol\n\nenter select · esc back", blocker: "menu" },
    { agent: "codex" as const, screen: reasoningMenu, blocker: "menu" },
    { agent: "codex" as const, screen: effectsMenu, blocker: "menu" },
    { agent: "codex" as const, screen: keymapMenu, blocker: "menu" },
    { agent: "codex" as const, screen: keymapNarrowMenu, blocker: "menu" },
    { agent: "codex" as const, screen: keymapMenu.replace("enter edit · esc close", "enter edit shortcut · * custom · - unbound · esc close"), blocker: "menu" },
    { agent: "codex" as const, screen: "Select model\n› 1. GPT-6.1 Terra\n› Search models\nenter select · esc back", blocker: "menu" },
    { agent: "codex" as const, screen: "Folder access\nTrust this folder?\n› 1. Trust and continue\n  2. Quit\nenter continue · esc quit", blocker: "menu" },
    { agent: "codex" as const, screen: "› Input disabled.", blocker: "disabled" },
    { agent: "codex" as const, screen: "› Viewing sub-agent — direct input is disabled", blocker: "disabled" },
    { agent: "claude" as const, screen: "Do you trust the files in this folder?\n❯ 1. Yes\n2. No\nEnter to confirm · Esc to cancel", blocker: "menu" },
    { agent: "claude" as const, screen: "Select model\n❯ Default (recommended)\n  Sonnet\nEnter to set as default · Esc to cancel", blocker: "menu" },
  ])("retains definitely unsent initial and continuation input for $agent $blocker", async ({ agent, screen, blocker }) => {
    const f = await fixture(agent); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation()); f.screen.text = screen;
    await expect(f.manager.start(f.context, binding, { configuration: { agent, model: null, args: [] }, prompt: "initial" }, operation())).rejects.toMatchObject({ name: "HerdrInputBlockedError", blocker, action: "agent.prompt", promptSubmission: "not-submitted" });
    await expect(f.manager.submitPrompt(f.context, binding, "continuation", operation())).rejects.toBeInstanceOf(HerdrInputBlockedError);
    expect(f.prompts).toEqual([]);
  });

  it.each([
    "enter select · esc back",
    "enter default · s session · esc back",
    "enter apply · s session · esc back",
    "f3 default · s session · f2 back",
    "^j select · ^k back",
    "ctrl+x enter select · alt+esc back",
    "enter default ·\ns session · esc back",
    "enter default · s\nsession · esc back",
    "Press enter to confirm or esc to go back",
    "Press f3 to confirm or f2 to cancel",
    "Press enter to confirm or esc to cancel or ^o to open thread",
    "enter select · / search · esc back",
    "s session · esc back",
    "enter select",
    "enter toggle · esc back",
    "f3 toggle · f2 back",
    "enter toggle",
    "enter toggle ·\nesc back",
  ])("recognizes source-owned Codex picker controls: %s", async footer => {
    const f = await fixture(); const binding = await launch(f); f.prompts.splice(0);
    f.screen.text = `Select an option\n› 1. Current selection\n  2. Another selection\n\n${footer}`;
    await expect(f.manager.submitPrompt(f.context, binding, "continuation", operation())).rejects.toBeInstanceOf(HerdrInputBlockedError);
    expect(f.prompts).toEqual([]);
  });

  it.each([
    "space toggle · ←/→ reorder · enter save · esc cancel",
    "space toggle · h/l reorder · f3 save · f2 cancel",
    "space toggle · ctrl+x ←/ctrl+x → reorder · f3 save · f2 cancel",
    "space toggle · ←/→ reorder ·\nenter save · esc cancel",
    "space toggle · enter save · esc cancel",
    "space toggle · esc cancel",
    "space toggle · f3 save",
    "space toggle",
    "space/enter toggle · esc back",
    "space/f3 toggle · f2 back",
    "space/ctrl+x enter toggle · ctrl+k esc back",
    "space/enter toggle ·\nesc back",
    "space toggle · enter save/select · esc cancel",
    "space toggle · f3 save/select · f2 cancel",
    "space toggle · enter save/select",
    "space toggle · enter\nsave/select · esc cancel",
    "space/enter toggle · esc close",
    "space toggle · enter save · esc save/close",
  ])("recognizes the shared checkbox controls without a title whitelist: %s", async footer => {
    const f = await fixture(); const binding = await launch(f); f.prompts.splice(0);
    f.screen.text = `An arbitrary widget title\n› [x] Selected checkbox\n  [ ] Another checkbox\n${footer}`;
    await expect(f.manager.submitPrompt(f.context, binding, "continuation", operation())).rejects.toBeInstanceOf(HerdrInputBlockedError);
    expect(f.prompts).toEqual([]);
  });

  it("retains checkbox ownership when a non-checkbox action has the current selection", async () => {
    const f = await fixture(); const binding = await launch(f); f.prompts.splice(0);
    f.screen.text = "A checkbox view\n  [x] Existing option\n› Reset all options\nspace toggle · enter save/select · esc cancel";
    await expect(f.manager.submitPrompt(f.context, binding, "continuation", operation())).rejects.toBeInstanceOf(HerdrInputBlockedError);
    expect(f.prompts).toEqual([]);
  });

  it.each([
    configurationMenu,
    configurationMenu.replace(" · esc clear search/close", ""),
    configurationMenu.replace("/ search · enter toggle", "/ search ·\n  enter toggle"),
    configurationMenu.replace("left/right group · / search · enter toggle · esc clear search/close", "enter test · esc clear search"),
  ])("blocks initial and continuation input on the actual unnumbered Configuration menu: %s", async screen => {
    const f = await fixture(); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation()); f.screen.text = screen;
    await expect(f.manager.start(f.context, binding, { configuration, prompt: "initial" }, operation())).rejects.toBeInstanceOf(HerdrInputBlockedError);
    await expect(f.manager.submitPrompt(f.context, binding, "continuation", operation())).rejects.toBeInstanceOf(HerdrInputBlockedError);
    expect(f.prompts).toEqual([]);
  });

  it.each([
    { agent: "codex" as const, screen: "Input disabled in this business example; press enter to confirm or esc to cancel." },
    ...["Viewing", "Viewing sub", "Viewing sub-agents", "Viewing sub-agent examples", "Input", "Input disabled in this business example", "Input disabled for test.", "Answer the questions", "Respond to the tool suggestion"].map(text => ({ agent: "codex" as const, screen: `› ${text}\n\n ? for shortcuts` })),
    { agent: "codex" as const, screen: "Viewing sub-agent — direct input is disabled" },
    { agent: "codex" as const, screen: "› Ask any custom question\nGPT-6.1 Terra medium · daynight/task" },
    { agent: "codex" as const, screen: "› 1. Historical model\nenter select · esc back\n\n› Completely custom current composer" },
    { agent: "codex" as const, screen: "› 1. Historical model\nenter select · esc back\n\n›✨Custom current prompt marker" },
    { agent: "codex" as const, screen: "› 1. Historical model\nenter select · esc back\n\n› Continue" },
    { agent: "codex" as const, screen: "› 1. Historical model\nenter select · esc back\n\n› select" },
    { agent: "codex" as const, screen: "› 1. Historical model\nenter select · esc back\n\n› apply" },
    { agent: "codex" as const, screen: "› 1. Historical model\nenter select · esc back\n\n› f3 select" },
    ...["open", "choose", "close"].map(label => ({ agent: "codex" as const, screen: `› 1. Historical model\nenter select · esc back\n\n› ${label}` })),
    { agent: "codex" as const, screen: "› 1. Historical reasoning\nenter default ·\ns session · esc back\n› Completely custom current composer" },
    { agent: "codex" as const, screen: "› 1. Business example\nenter invent · esc back" },
    { agent: "codex" as const, screen: "› 1. Historical choice\n› Current composer\nenter send ·\nesc cancel" },
    { agent: "codex" as const, screen: "› 1. Historical choice\n› Current composer\nenter send · esc cancel" },
    { agent: "codex" as const, screen: "Business prose: enter default · s session · esc back" },
    { agent: "codex" as const, screen: "Business description of keyboard controls\nspace toggle · ←/→ reorder · enter save · esc cancel" },
    { agent: "codex" as const, screen: "› [x] A literal checkbox draft\nenter send · esc cancel" },
    { agent: "codex" as const, screen: "› [x] Old selection\nspace toggle · ←/→ reorder · enter save · esc cancel\n› Continue" },
    { agent: "codex" as const, screen: "A discussion of checkbox controls\nspace/enter toggle · esc back" },
    { agent: "codex" as const, screen: "A discussion of saving settings\nspace toggle · enter save/select · esc cancel" },
    { agent: "codex" as const, screen: "› [x] A literal draft\nenter send · esc cancel" },
    ...["insert", "return", "page up", "page down", "back tab", "caps lock", "media play", "f25", "λ", "🚀"].map(key => ({ agent: "codex" as const, screen: `A checkbox discussion\n› [x] Existing option\nspace/enter toggle · ${key} back` })),
    ...["delete", "fwd del", "⌃fwd del"].map(key => ({ agent: "codex" as const, screen: `› 1. Historical model\nenter select · esc back\n› ${key} back` })),
    { agent: "codex" as const, screen: `${configurationMenu}\n\n› A custom current composer` },
    { agent: "codex" as const, screen: `${keymapMenu}\n\n› Continue` },
    { agent: "codex" as const, screen: "› Arbitrary business row\nleft/right group · enter edit · esc close" },
    { agent: "codex" as const, screen: "› Arbitrary business question\nleft/right group · / search · enter toggle" },
    { agent: "codex" as const, screen: "Configuration\n› Current composer\nenter send · esc cancel" },
    { agent: "codex" as const, screen: "Select model\n› Unnumbered business row\nenter select · esc back" },
    { agent: "claude" as const, screen: "Business prose says esc to cancel, then enter to confirm the example." },
    { agent: "claude" as const, screen: "❯ 1. Historical choice\nEnter to confirm · Esc to cancel\n\n❯ Completely custom current composer" },
    { agent: "claude" as const, screen: "Select model\n❯ Default\nEnter to set as default · Esc to cancel\n\n❯ New placeholder without borders" },
    { agent: "codex" as const, screen: "" },
  ])("accepts $agent content without an active explicit blocker: $screen", async ({ agent, screen }) => {
    const f = await fixture(agent); const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation()); f.screen.text = screen;
    await f.manager.start(f.context, binding, { configuration: { agent, model: null, args: [] }, prompt: "managed" }, operation());
    expect(f.prompts).toEqual(["managed"]);
  });

  it.each([{ pane_id: "foreign" }, { workspace_id: "foreign" }, { source: "recent" }, { format: "ansi" }, { text: undefined }, { truncated: undefined }, { truncated: true }])("rejects unusable negative-blocker observations %j", async extra => {
    const f = await fixture(); const binding = await launch(f); f.prompts.splice(0);
    f.hook(async method => method === "agent.read" ? { type: "pane_read", read: { pane_id: binding.paneId, workspace_id: binding.workspaceId, source: "visible", format: "text", text: "unknown layout", truncated: false, ...extra } } : undefined);
    await expect(f.manager.submitPrompt(f.context, binding, "continue", operation())).rejects.toMatchObject({ action: "agent.prompt", promptSubmission: "not-submitted" });
    expect(f.prompts).toEqual([]);
  });

  it("retains target changes during visible reads as errors rather than menu waiting", async () => {
    const f = await fixture(); const binding = await launch(f); f.prompts.splice(0);
    f.hook(async method => {
      if (method !== "agent.read") return undefined;
      f.panes[0]!.terminal_id = "replacement";
      return { type: "pane_read", read: { pane_id: binding.paneId, workspace_id: binding.workspaceId, source: "visible", format: "text", text: "› 1. GPT\nenter select · esc back", truncated: false } };
    });
    const error = await f.manager.submitPrompt(f.context, binding, "continue", operation()).catch(error => error);
    expect(error).toMatchObject({ action: "agent.prompt", promptSubmission: "not-submitted", cause: { message: "The task pane or terminal identity has changed." } });
    expect(error).not.toBeInstanceOf(HerdrInputBlockedError);
    expect(f.prompts).toEqual([]);
  });

  it("preserves a failed visible read as a protocol error with its original cause", async () => {
    const f = await fixture(); const binding = await launch(f); f.prompts.splice(0);
    const failure = new HerdrRpcError("read connection lost", { method: "agent.read", requestId: "read", submission: "unknown" });
    f.hook(async method => { if (method === "agent.read") throw failure; return undefined; });
    const error = await f.manager.submitPrompt(f.context, binding, "continue", operation()).catch(error => error);
    expect(error).toMatchObject({ action: "agent.prompt", promptSubmission: "not-submitted", cause: failure });
    expect(error).not.toBeInstanceOf(HerdrInputBlockedError);
    expect(f.prompts).toEqual([]);
  });

  it("keeps owned input, resource discovery and stopping independent of live cwd metadata", async () => {
    const f = await fixture(); const binding = await launch(f); f.prompts.splice(0);
    const subdirectory = path.join(f.context.cwd, "packages"); await mkdir(subdirectory);
    f.panes[0]!.cwd = subdirectory;
    f.agents[0]!.cwd = path.join(subdirectory, "daynight");
    expect(await f.manager.prepareWorkspace(f.context, taskTitle, operation())).toEqual(binding);
    expect(await f.manager.observe(f.context, binding, operation())).toMatchObject({ binding, kind: "codex" });
    expect(await f.manager.listResources(operation())).toMatchObject([{ panes: [{ binding, cwd: f.agents[0]!.cwd }] }]);
    expect((await f.manager.start(f.context, binding, { configuration, prompt: "must not repeat assignment" }, operation())).binding).toEqual(binding);
    expect(f.calls.filter(call => call.method === "agent.start")).toHaveLength(1);
    await f.manager.submitPrompt(f.context, binding, "continue in the original agent", operation());
    expect(f.prompts).toEqual(["continue in the original agent"]);
    await f.manager.stopAndClose(f.context, binding, operation());
    expect(f.workspaces).toEqual([]);
    expect(f.executing.has(200)).toBe(false);
  });

  it("can skip input after checking the native agent without reporting a submission", async () => {
    const f = await fixture(); const binding = await launch(f); f.prompts.splice(0); let guarded = 0;
    const result = await f.manager.submitPrompt(f.context, binding, "periodic", operation(), async () => { guarded += 1; return false; });
    expect(result).toMatchObject({ submission: "skipped", observation: { binding } });
    expect(guarded).toBe(1); expect(f.prompts).toEqual([]);
  });

  it("checks a supplied guard immediately before prompt mutation", async () => {
    const f = await fixture(); const binding = await launch(f); f.prompts.splice(0); const order: string[] = [];
    f.hook(async (method) => { order.push(method); return undefined; });
    const result = await f.manager.submitPrompt(f.context, binding, "periodic", operation(), async () => { order.push("guard"); return true; });
    expect(result.submission).toBe("submitted"); expect(order.slice(-2)).toEqual(["guard", "agent.prompt"]);
    expect(f.prompts).toEqual(["periodic"]);
  });

  it("preserves a guard failure as definitely unsent with its original cause", async () => {
    const f = await fixture(); const binding = await launch(f); f.prompts.splice(0); const failure = new Error("fresh task read failed");
    await expect(f.manager.submitPrompt(f.context, binding, "periodic", operation(), async () => { throw failure; })).rejects.toMatchObject({ action: "agent.prompt", promptSubmission: "not-submitted", cause: failure });
    expect(f.prompts).toEqual([]);
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

  it("observes the original live binding and treats lost or conflicting evidence as unknown", async () => {
    const f = await fixture(); const binding = await launch(f);
    const running = await f.manager.observeExecutionStop(f.context, operation());
    expect(running).toMatchObject({ kind: "running", execution: { backend: "herdr-legacy", owner: expect.objectContaining({ claimId: f.context.claimId, worktreeId: f.context.worktreeId }) } });
    f.agents[0]!.terminal_id = "replacement";
    expect(await f.manager.observeExecutionStop(f.context, operation())).toMatchObject({ kind: "unknown", error: expect.any(ExecutionSourceConflictError) });
    f.agents[0]!.terminal_id = binding.terminalId;
    f.panes.splice(0); f.agents.splice(0); f.workspaces.splice(0);
    expect(await f.manager.observeExecutionStop(f.context, operation())).toMatchObject({ kind: "unknown" });
  });

  it("reports an unconfirmed process stop rather than authorizing further cleanup", async () => {
    const f = await fixture(); const binding = await launch(f); f.closeProcesses.terminate = false;
    await expect(f.manager.stopAndClose(f.context, binding, operation(25))).rejects.toMatchObject({ kind: "deadline" }); expect(f.executing.has(200)).toBe(true);
  });

  it("keeps waiting for the same process after a close wait times out and discovery is empty", async () => {
    const f = await fixture(); const binding = await launch(f); f.closeProcesses.terminate = false;
    await expect(f.manager.stopAndClose(f.context, binding, operation(100))).rejects.toMatchObject({ kind: "deadline" });
    expect(f.workspaces).toEqual([]);
    expect(await f.manager.observeExecutionStop(f.context, operation())).toMatchObject({ kind: "unknown" });
    await expect(f.manager.stopAndClose(f.context, binding, operation(50))).rejects.toMatchObject({ kind: "deadline" });
    f.executing.delete(200);
    await f.manager.stopAndClose(f.context, binding, operation());
    expect(await f.manager.observeExecutionStop(f.context, operation())).toMatchObject({ kind: "stopped", execution: { backend: "herdr-legacy", owner: expect.objectContaining({ claimId: f.context.claimId }) } });
    f.workspaces.push({ workspace_id: binding.workspaceId, label: "human" });
    expect(await f.manager.observeExecutionStop(f.context, operation())).toMatchObject({ kind: "unknown", error: expect.any(ExecutionSourceConflictError) });
    f.workspaces.splice(0);
    const restarted = await fixture();
    expect(await restarted.manager.observeExecutionStop(f.context, operation())).toMatchObject({ kind: "unknown", error: expect.any(LegacyBindingUnavailableError) });
    expect(f.calls.filter((call) => call.method === "workspace.close")).toHaveLength(1);
  });

  it("preserves the original binding through a partially completed close", async () => {
    const f = await fixture(); const binding = await launch(f);
    f.hook(async method => {
      if (method !== "workspace.close") return undefined;
      f.panes.splice(0); f.agents.splice(0);
      f.hook(undefined);
      throw new HerdrRpcError("partial close", { method: "workspace.close", requestId: "request", submission: "unknown" });
    });
    await expect(f.manager.stopAndClose(f.context, binding, operation())).rejects.toThrow();
    expect(await f.manager.observeExecutionStop(f.context, operation())).toMatchObject({ kind: "unknown" });
    await expect(f.manager.stopAndClose(f.context, { ...binding, terminalId: "replacement" }, operation())).rejects.toThrow("different original binding");
    f.executing.delete(200);
    await f.manager.stopAndClose(f.context, binding, operation());
    expect(await f.manager.observeExecutionStop(f.context, operation())).toMatchObject({ kind: "stopped", execution: { backend: "herdr-legacy" } });
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

  it.each(["human", "human | daynight:{", "human | daynight:{}"])("ignores unrecognized workspace label %j during discovery and stop", async (label) => {
    const f = await fixture(); const binding = await launch(f);
    f.workspaces.push({ workspace_id: "human", label });
    expect((await f.manager.listResources(operation())).map((workspace) => workspace.workspaceId)).toEqual([binding.workspaceId]);
    await f.manager.stopAndClose(f.context, binding, operation()); expect(f.workspaces).toEqual([{ workspace_id: "human", label }]);
    expect(f.calls.find((call) => call.method === "workspace.close")!.params).toEqual({ workspace_id: binding.workspaceId, close_group: false });
  });

  it.each(["", "bad\nname"])("keeps live owned resources discoverable and stoppable with display title %j", async (title) => {
    const f = await fixture(); const binding = await launch(f);
    f.agents[0]!.agent_status = "working";
    f.workspaces[0]!.label = `${title} | daynight:${JSON.stringify({ projectId, taskId, claimId, worktreeId })}`;
    const resources = await f.manager.listResources(operation());
    expect(resources.map((workspace) => workspace.workspaceId)).toEqual([binding.workspaceId]);
    expect(resources[0]!.panes[0]!.status).toBe("working");
    await f.manager.stopAndClose(f.context, binding, operation());
    expect(f.workspaces).toEqual([]);
    expect(f.executing.has(200)).toBe(false);
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

  it("creates an owned workspace when a human workspace uses the same directory", async () => {
    const f = await fixture();
    const human = { workspace_id: "human-workspace", label: "Human workspace" };
    f.workspaces.push(human);
    f.panes.push({ workspace_id: human.workspace_id, pane_id: "human-pane", terminal_id: "human-terminal", cwd: f.context.cwd });
    const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
    expect(binding.workspaceId).not.toBe(human.workspace_id);
    expect(f.workspaces).toContainEqual(human);
    expect(await f.manager.listResources(operation())).toMatchObject([{ owner: { projectId, taskId, claimId, worktreeId }, workspaceId: binding.workspaceId }]);
    expect(f.calls.filter((call) => call.method === "workspace.create")).toHaveLength(1);
  });
});

it("launches and resumes Claude with its original hook identity", async () => {
  const f = await fixture("claude"); const prepared = await f.manager.prepareWorkspace(f.context,taskTitle,operation());
  const config = { agent:"claude" as const, model:"sonnet", args:[] };
  const result = await f.manager.start(f.context,prepared,{ ...prepared,configuration:config,prompt:"managed task",resumeSessionId:nativeId },operation());
  expect(result.kind).toBe("claude"); expect(result.nativeSession?.sessionId).toBe(nativeId);
  expect(f.calls.find(call=>call.method==="agent.start")?.params.args).toEqual(["--resume",nativeId,"--dangerously-skip-permissions"]);
  expect(f.prompts).toEqual(["managed task"]);
});


it("passes explicit CLI routing into each new Herdr workspace without changing native XDG settings", async () => {
  const environment = { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "/native/state", PATH: "/private/aliases:/usr/bin", DN_CONFIG_DIR: "/private/dev" };
  const f = await fixture("codex", environment);
  await f.manager.prepareWorkspace(f.context, taskTitle, operation());
  expect(f.calls.find(call => call.method === "workspace.create")?.params.env).toMatchObject(environment);
});


it("binds Codex CLI mappings through native shell policy after all user arguments", async () => {
  const environment = { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "", PATH: "/private/aliases:/usr/bin", DN_CONFIG_DIR: "/private/dev" };
  const f = await fixture("codex", environment);
  await launch(f);
  const args = f.calls.find(call => call.method === "agent.start")!.params.args as string[];
  expect(args.slice(-4)).toEqual(["-c", 'shell_environment_policy.set.PATH="/private/aliases:/usr/bin"', "-c", 'shell_environment_policy.set.DN_CONFIG_DIR="/private/dev"']);
});


it.skipIf(process.platform === "win32").each([undefined, nativeId])("preserves effective Codex PATH and native override order (resume %s)", async resumeSessionId => {
  const environment = { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "", PATH: "/private/aliases:/worker/bin", DN_CONFIG_DIR: "/private/dev" };
  const reads: { args: readonly string[]; cwd: string }[] = [];
  const f = await fixture("codex", environment, async (args, cwd) => { reads.push({ args: [...args], cwd }); return { config: { shell_environment_policy: { set: { PATH: "/custom/toolchain:/usr/bin:/bin" } } } }; });
  const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
  const configuration = { agent: "codex" as const, model: null, args: ["-p", "work", "-c", 'shell_environment_policy.set.PATH="/custom/toolchain:/usr/bin:/bin"'] };
  await f.manager.start(f.context, binding, { configuration, prompt: "initial", ...(resumeSessionId ? { resumeSessionId } : {}) }, operation());
  const args = f.calls.find(call => call.method === "agent.start")!.params.args as string[];
  expect(reads).toHaveLength(1);
  expect(reads[0]!.cwd).toBe(await realpath(f.context.cwd));
  expect(reads[0]!.args).toEqual(buildHerdrAgentArguments(configuration, await realpath(f.context.cwd), resumeSessionId));
  expect(args.slice(-4)).toEqual(["-c", 'shell_environment_policy.set.PATH="/private/aliases:/custom/toolchain:/usr/bin:/bin"', "-c", 'shell_environment_policy.set.DN_CONFIG_DIR="/private/dev"']);
});


it("does not inspect Codex config without aliases or before an existing Agent", async () => {
  let reads = 0;
  const read = async () => { reads++; throw new Error("unexpected config inspection"); };
  const plain = await fixture("codex", { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" }, read);
  await launch(plain);
  const mapped = await fixture("codex", { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "", PATH: "/private/aliases:/bin" }, read);
  const binding = await mapped.manager.prepareWorkspace(mapped.context, taskTitle, operation());
  mapped.launch({ pane_id: binding.paneId, name: herdrExecutionAgentName(mapped.context) });
  await mapped.manager.start(mapped.context, binding, { configuration, prompt: "never sent" }, operation());
  expect(reads).toBe(0);
});

it("does not start an Agent when effective configuration inspection fails", async () => {
  const f = await fixture("codex", { XDG_CONFIG_HOME: "", XDG_STATE_HOME: "", PATH: "/private/aliases:/bin" }, async () => { throw new Error("native configuration unavailable"); });
  const binding = await f.manager.prepareWorkspace(f.context, taskTitle, operation());
  await expect(f.manager.start(f.context, binding, { configuration, prompt: "never sent" }, operation())).rejects.toThrow("native configuration unavailable");
  expect(f.calls.some(call => call.method === "agent.start")).toBe(false);
});
