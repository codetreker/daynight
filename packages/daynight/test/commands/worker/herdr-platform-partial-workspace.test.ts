import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createOperation, OperationError } from "../../../src/api/operation.js";
import { setTimeout as delay } from "node:timers/promises";
import { HerdrAgentActionError, herdrExecutionLabel, type HerdrExecutionContext, type HerdrOwnedWorkspace } from "../../../src/commands/worker/herdr/agents.js";
import type { HerdrRpcClient, HerdrRpcResult } from "../../../src/commands/worker/herdr/rpc.js";
import type { HerdrToolLaunchMapping } from "../../../src/commands/worker/herdr/tool-launch.js";
import { closePartialWorkspace, confirmReadinessUnchanged, hasReadinessContradiction, isRootReadinessDeadline, isRootReadinessFailure, observeClosedPartialWorkspace, observePartialWorkspace, verifyReadinessDiagnostic } from "./herdr-platform-partial-workspace.fixtures.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const fixture = async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/herdr-partial-workspace");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "test-")); roots.push(root);
  const context: HerdrExecutionContext = { projectId: "00000000-0000-4000-8000-000000000001", taskId: "00000000-0000-4000-8000-000000000002", claimId: "00000000-0000-4000-8000-000000000003", worktreeId: "00000000-0000-4000-8000-000000000004", cwd: root, agent: "copilot" };
  const binding = { session: "w", workspaceId: "workspace", paneId: "pane", terminalId: "terminal" };
  const command = ["powershell", "bootstrap"];
  const mapping = { manifestPath: path.join(root, "manifest.json"), nonce: "original-nonce", windowsCommand: command } as unknown as HerdrToolLaunchMapping;
  const intent = { nonce: mapping.nonce, initial: { session: "w", workspaceId: "workspace", paneId: "initial-pane", terminalId: "initial-terminal" }, tabId: "initial-tab", shellPid: 100, cwd: root, command };
  await writeFile(path.join(root, "layout-intent.json"), JSON.stringify(intent), { mode: 0o600 });
  const resource: HerdrOwnedWorkspace = { owner: context, workspaceId: binding.workspaceId, panes: [{ binding, cwd: root, kind: null, status: "unknown", launchPending: false, interactiveReady: false, nativeSession: null, stateChangeSeq: null, completionSeq: null }] };
  const state = { workspaces: [{ workspace_id: binding.workspaceId, label: herdrExecutionLabel(context, "Test") }], panes: [{ workspace_id: binding.workspaceId, pane_id: binding.paneId, terminal_id: binding.terminalId, tab_id: "prepared-tab" }], agents: [] as Record<string, unknown>[], tabs: [{ workspace_id: binding.workspaceId, tab_id: "prepared-tab" }] };
  const layout = { workspace_id: binding.workspaceId, tab_id: "prepared-tab", root: { type: "pane", pane_id: binding.paneId, cwd: root, command } };
  let closed = false, remain = false, closeFailure: Error | undefined, postCloseTab: string | undefined;
  const request = vi.fn(async (method: string): Promise<HerdrRpcResult> => {
    if (method === "session.snapshot") return { type: "session_snapshot", snapshot: closed && !remain ? { workspaces: [], panes: [], agents: [], tabs: postCloseTab === undefined ? [] : [{ workspace_id: "foreign", tab_id: postCloseTab }] } : structuredClone(state) };
    if (method === "layout.export") return { type: "layout_export", layout: structuredClone(layout) };
    if (method === "workspace.close") { if (closeFailure) throw closeFailure; closed = true; return { type: "ok" }; }
    throw new Error(`Unexpected RPC ${method}`);
  });
  const tasks = { listResources: vi.fn(async () => [resource]), processInfo: vi.fn(async () => ({ shellPid: 200, foregroundPids: [] })) };
  const operation = createOperation({ limits: { totalMs: 5000 } });
  const input = { context, tasks, rpc: { request } as unknown as HerdrRpcClient, mapping, operation };
  return { input, state, resource, layout, intent, request, tasks, binding, root, setRemain: () => { remain = true; }, setCloseFailure: () => { closeFailure = new Error("unknown close"); }, setPostCloseTab: (tab: string) => { postCloseTab = tab; } };
};

it("closes only the original verified partial workspace and observes its absence", async () => {
  const f = await fixture();
  try {
    const witness = await observePartialWorkspace(f.input);
    expect(await closePartialWorkspace(f.input, witness)).toMatchObject({ owner: { projectId: f.input.context.projectId, taskId: f.input.context.taskId, claimId: f.input.context.claimId, worktreeId: f.input.context.worktreeId }, binding: f.binding, tabId: "prepared-tab", initialTabId: "initial-tab", initialPaneId: "initial-pane", initialTerminalId: "initial-terminal", shellPid: 200, failurePhase: "root-readiness", layoutVerified: true, noAgentLaunch: true, closeConfirmed: true, after: { ownerAbsent: true, workspaceAbsent: true, paneAbsent: true, terminalAbsent: true, tabAbsent: true } });
    const independentRequest = vi.fn(f.request.getMockImplementation()!);
    const independent = await observeClosedPartialWorkspace({ ...f.input, rpc: { request: independentRequest } as unknown as HerdrRpcClient }, witness);
    expect(independent).toMatchObject({ binding: f.binding, tabId: "prepared-tab", initialTabId: "initial-tab", initialPaneId: "initial-pane", initialTerminalId: "initial-terminal", ownerAbsent: true, workspaceAbsent: true, paneAbsent: true, terminalAbsent: true, tabAbsent: true });
    expect(independentRequest).toHaveBeenCalledOnce();
    expect(independentRequest.mock.calls[0]![0]).toBe("session.snapshot");
    expect(f.request.mock.calls.filter(([method]) => method === "workspace.close")).toHaveLength(1);
  } finally { f.input.operation.dispose(); }
});

it.each(["missing-owner", "duplicate-owner", "foreign-owner", "wrong-cwd", "agent", "old-terminal", "old-tab", "wrong-layout", "wrong-intent", "launch-intent", "changed-shell"])("does not close unconfirmed partial workspace evidence: %s", async failure => {
  const f = await fixture();
  try {
    if (failure === "missing-owner") f.tasks.listResources.mockResolvedValue([]);
    if (failure === "duplicate-owner") f.tasks.listResources.mockResolvedValue([f.resource, f.resource]);
    if (failure === "foreign-owner") f.state.workspaces[0]!.label = "foreign";
    if (failure === "wrong-cwd") f.resource.panes[0]!.cwd = path.join(f.root, "missing");
    if (failure === "agent") f.state.agents.push({ workspace_id: "workspace", pane_id: "pane", terminal_id: "terminal" });
    if (failure === "old-terminal") f.state.panes.push({ workspace_id: "foreign", pane_id: "foreign", terminal_id: "initial-terminal", tab_id: "foreign" });
    if (failure === "old-tab") f.state.tabs.push({ workspace_id: "foreign", tab_id: "initial-tab" });
    if (failure === "wrong-layout") f.layout.root.command = ["different"];
    if (failure === "wrong-intent") await writeFile(path.join(f.root, "layout-intent.json"), JSON.stringify({ ...f.intent, nonce: "other" }));
    if (failure === "launch-intent") await writeFile(path.join(f.root, "launch-intent.json"), "{}", { mode: 0o600 });
    if (failure === "changed-shell") f.tasks.processInfo.mockResolvedValueOnce({ shellPid: 200, foregroundPids: [] }).mockResolvedValue({ shellPid: 201, foregroundPids: [] });
    await expect(observePartialWorkspace(f.input)).rejects.toThrow();
    expect(f.request.mock.calls.some(([method]) => method === "workspace.close")).toBe(false);
  } finally { f.input.operation.dispose(); }
});

it.each(["changed-owner", "replaced-tab", "changed-original-pane", "changed-original-terminal", "changed-original-tab", "launch-after-observation", "unknown-close", "workspace-remains", "current-tab-remains", "initial-tab-remains"])("keeps partial closure unconfirmed on %s", async failure => {
  const f = await fixture();
  try {
    const witness = await observePartialWorkspace(f.input);
    if (failure === "changed-owner") f.state.workspaces[0]!.label = "foreign";
    if (failure === "replaced-tab") { f.state.tabs[0]!.tab_id = "replacement"; f.state.panes[0]!.tab_id = "replacement"; }
    if (failure === "changed-original-pane" || failure === "changed-original-terminal" || failure === "changed-original-tab") {
      const intent = structuredClone(f.intent);
      if (failure === "changed-original-pane") intent.initial.paneId = "replacement";
      if (failure === "changed-original-terminal") intent.initial.terminalId = "replacement";
      if (failure === "changed-original-tab") intent.tabId = "replacement";
      await writeFile(path.join(f.root, "layout-intent.json"), JSON.stringify(intent));
    }
    if (failure === "launch-after-observation") await writeFile(path.join(f.root, "native-start.json"), "{}", { mode: 0o600 });
    if (failure === "unknown-close") f.setCloseFailure();
    if (failure === "workspace-remains") f.setRemain();
    if (failure === "current-tab-remains") f.setPostCloseTab("prepared-tab");
    if (failure === "initial-tab-remains") f.setPostCloseTab("initial-tab");
    await expect(closePartialWorkspace(f.input, witness)).rejects.toThrow();
    expect(f.request.mock.calls.filter(([method]) => method === "workspace.close")).toHaveLength(["changed-owner", "replaced-tab", "changed-original-pane", "changed-original-terminal", "changed-original-tab", "launch-after-observation"].includes(failure) ? 0 : 1);
  } finally { f.input.operation.dispose(); }
});

it.each(["prepared-tab", "initial-tab"])("rejects a stale %s on the independent post-close snapshot", async tab => {
  const f = await fixture();
  try {
    const witness = await observePartialWorkspace(f.input);
    await closePartialWorkspace(f.input, witness);
    f.setPostCloseTab(tab);
    const independentRequest = vi.fn(f.request.getMockImplementation()!);
    await expect(observeClosedPartialWorkspace({ ...f.input, rpc: { request: independentRequest } as unknown as HerdrRpcClient }, witness)).rejects.toThrow(/remains observable/);
    expect(independentRequest).toHaveBeenCalledOnce();
  } finally { f.input.operation.dispose(); }
});

it.each(["owner", "workspace", "pane", "initial-pane", "terminal", "initial-terminal", "unavailable"])("rejects an unconfirmed independent observation: %s", async failure => {
  const f = await fixture();
  try {
    const witness = await observePartialWorkspace(f.input);
    await closePartialWorkspace(f.input, witness);
    const state = { workspaces: [] as Record<string, unknown>[], panes: [] as Record<string, unknown>[], agents: [] as Record<string, unknown>[], tabs: [] as Record<string, unknown>[] };
    if (failure === "owner") state.workspaces.push({ workspace_id: "replacement", label: herdrExecutionLabel(f.input.context, "Test") });
    if (failure === "workspace") state.workspaces.push({ workspace_id: f.binding.workspaceId, label: "foreign" });
    if (failure === "pane" || failure === "initial-pane" || failure === "terminal" || failure === "initial-terminal") state.panes.push({ workspace_id: "foreign", pane_id: failure === "pane" ? f.binding.paneId : failure === "initial-pane" ? "initial-pane" : "foreign", terminal_id: failure === "terminal" ? f.binding.terminalId : failure === "initial-terminal" ? "initial-terminal" : "foreign", tab_id: "foreign" });
    const independentRequest = vi.fn(async () => { if (failure === "unavailable") throw new Error("snapshot unavailable"); return { type: "session_snapshot", snapshot: state }; });
    await expect(observeClosedPartialWorkspace({ ...f.input, rpc: { request: independentRequest } as unknown as HerdrRpcClient }, witness)).rejects.toThrow();
    expect(independentRequest).toHaveBeenCalledOnce();
  } finally { f.input.operation.dispose(); }
});

it("recognizes structured original readiness failures", async () => {
  const deadline = new OperationError("deadline");
  const controller = new AbortController(); controller.abort(deadline);
  const abort = await delay(1, undefined, { signal: controller.signal }).catch(error => error);
  const phase = new Error("The original PowerShell root readiness phase failed (startedRemainingMs=19522, remainingMs=null).", { cause: abort });
  const failure = new HerdrAgentActionError(phase.message, "workspace.create", "unknown", { cause: phase });
  expect(isRootReadinessFailure(failure)).toBe(true);
  expect(isRootReadinessDeadline(failure)).toBe(true);
  for (const cause of [deadline, new Error("readiness mismatch")]) {
    const direct = new Error("The original PowerShell root readiness phase failed (startedRemainingMs=null, remainingMs=15).", { cause });
    const observed = new HerdrAgentActionError(direct.message, "workspace.create", "unknown", { cause: direct });
    expect(isRootReadinessFailure(observed)).toBe(true);
    expect(isRootReadinessDeadline(observed)).toBe(cause === deadline);
  }
  expect(isRootReadinessFailure(new HerdrAgentActionError(phase.message, "layout.apply", "unknown", { cause: phase }))).toBe(false);
  expect(isRootReadinessFailure(new Error(phase.message))).toBe(false);
  expect(isRootReadinessDeadline(new Error(phase.message))).toBe(false);
});

it("keeps explicit readiness identity contradictions separate from unavailable diagnostics", () => {
  const missing = { readyFile: { state: "missing" as const }, temporaryFiles: { state: "observed" as const, count: 0 }, pane: { state: "unknown" as const, reason: "unavailable" as const } };
  expect(hasReadinessContradiction(missing)).toBe(false);
  expect(hasReadinessContradiction({ ...missing, pane: { state: "unknown", reason: "invalid" } })).toBe(true);
  expect(hasReadinessContradiction({ ...missing, readyFile: { state: "unknown", reason: "invalid" } })).toBe(true);
  for (const field of ["nonceMatches", "pidMatches", "executableMatches", "validStartToken"] as const) {
    expect(hasReadinessContradiction({ ...missing, readyFile: { state: "present", size: 10, nonceMatches: true, pidMatches: true, executableMatches: true, validStartToken: true, [field]: false } })).toBe(true);
  }
});

it("requires the complete native readiness proof for a late matching ready file", async () => {
  const f = await fixture(), verifyReady = vi.fn(async () => {});
  const diagnostic = { readyFile: { state: "present" as const, size: 10, nonceMatches: true, pidMatches: true, executableMatches: true, validStartToken: true }, temporaryFiles: { state: "observed" as const, count: 0 }, pane: { state: "observed" as const, shellPid: 200, screenBytes: 0, screenSignals: [] } };
  try {
    const mapping = { ...f.input.mapping, verifyReady };
    expect(await verifyReadinessDiagnostic({ ...diagnostic, readyFile: { state: "missing" } }, mapping, 200, f.input.operation)).toEqual({ state: "missing" });
    expect(verifyReady).not.toHaveBeenCalled();
    await writeFile(path.join(f.root, "shell-ready.json"), "{}", { mode: 0o600 });
    const proof = await verifyReadinessDiagnostic(diagnostic, mapping, 200, f.input.operation);
    expect(proof.state).toBe("verified");
    expect(verifyReady).toHaveBeenCalledWith(200, f.input.operation);
    const failure = new Error("root birth changed"); verifyReady.mockRejectedValueOnce(failure);
    await expect(verifyReadinessDiagnostic(diagnostic, mapping, 200, f.input.operation)).rejects.toBe(failure);
    await expect(verifyReadinessDiagnostic({ ...diagnostic, readyFile: { ...diagnostic.readyFile, pidMatches: false } }, mapping, 200, f.input.operation)).rejects.toThrow(/contradict/);
    await expect(verifyReadinessDiagnostic({ ...diagnostic, readyFile: { state: "unknown", reason: "unavailable" } }, mapping, 200, f.input.operation)).rejects.toThrow(/unconfirmed/);
    expect(verifyReady).toHaveBeenCalledTimes(2);
    expect((await verifyReadinessDiagnostic({ ...diagnostic, readyFile: { state: "missing" } }, mapping, 200, f.input.operation)).state).toBe("verified");
    expect(verifyReady).toHaveBeenCalledTimes(3);
    await confirmReadinessUnchanged(mapping, proof, f.input.operation);
    await writeFile(path.join(f.root, "shell-ready.json"), '{"changed":true}', { mode: 0o600 });
    await expect(confirmReadinessUnchanged(mapping, proof, f.input.operation)).rejects.toThrow(/changed/);
    await expect(confirmReadinessUnchanged(mapping, { state: "missing" }, f.input.operation)).rejects.toThrow(/changed/);
    await expect(verifyReadinessDiagnostic({ ...diagnostic, readyFile: { state: "missing" }, pane: { state: "unknown", reason: "unavailable" } }, mapping, 200, f.input.operation)).rejects.toThrow(/pane/);
  } finally { f.input.operation.dispose(); }
});
