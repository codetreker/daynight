import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createOperation, OperationError } from "../../../src/api/operation.js";
import { setTimeout as delay } from "node:timers/promises";
import { HerdrAgentActionError, herdrExecutionLabel, type HerdrExecutionContext, type HerdrOwnedWorkspace } from "../../../src/commands/worker/herdr/agents.js";
import type { HerdrRpcClient, HerdrRpcResult } from "../../../src/commands/worker/herdr/rpc.js";
import type { HerdrToolLaunchMapping } from "../../../src/commands/worker/herdr/tool-launch.js";
import { closePartialWorkspace, confirmReadinessUnchanged, hasReadinessContradiction, isRootReadinessDeadline, isRootReadinessFailure, observePartialWorkspace, verifyReadinessDiagnostic } from "./herdr-platform-partial-workspace.fixtures.js";

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
  let closed = false, remain = false, closeFailure: Error | undefined;
  const request = vi.fn(async (method: string): Promise<HerdrRpcResult> => {
    if (method === "session.snapshot") return { type: "session_snapshot", snapshot: closed && !remain ? { workspaces: [], panes: [], agents: [], tabs: [] } : structuredClone(state) };
    if (method === "layout.export") return { type: "layout_export", layout: structuredClone(layout) };
    if (method === "workspace.close") { if (closeFailure) throw closeFailure; closed = true; return { type: "ok" }; }
    throw new Error(`Unexpected RPC ${method}`);
  });
  const tasks = { listResources: vi.fn(async () => [resource]), processInfo: vi.fn(async () => ({ shellPid: 200, foregroundPids: [] })) };
  const operation = createOperation({ limits: { totalMs: 5000 } });
  const input = { context, tasks, rpc: { request } as unknown as HerdrRpcClient, mapping, operation };
  return { input, state, resource, layout, intent, request, tasks, binding, root, setRemain: () => { remain = true; }, setCloseFailure: () => { closeFailure = new Error("unknown close"); } };
};

it("closes only the original verified partial workspace and observes its absence", async () => {
  const f = await fixture();
  try {
    const witness = await observePartialWorkspace(f.input);
    expect(await closePartialWorkspace(f.input, witness)).toMatchObject({ owner: { projectId: f.input.context.projectId, taskId: f.input.context.taskId, claimId: f.input.context.claimId, worktreeId: f.input.context.worktreeId }, binding: f.binding, shellPid: 200, failurePhase: "root-readiness", layoutVerified: true, noAgentLaunch: true, closeConfirmed: true, after: { ownerAbsent: true, workspaceAbsent: true, paneAbsent: true, terminalAbsent: true } });
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

it.each(["changed-owner", "launch-after-observation", "unknown-close", "workspace-remains"])("keeps partial closure unconfirmed on %s", async failure => {
  const f = await fixture();
  try {
    const witness = await observePartialWorkspace(f.input);
    if (failure === "changed-owner") f.state.workspaces[0]!.label = "foreign";
    if (failure === "launch-after-observation") await writeFile(path.join(f.root, "native-start.json"), "{}", { mode: 0o600 });
    if (failure === "unknown-close") f.setCloseFailure();
    if (failure === "workspace-remains") f.setRemain();
    await expect(closePartialWorkspace(f.input, witness)).rejects.toThrow();
    expect(f.request.mock.calls.filter(([method]) => method === "workspace.close")).toHaveLength(failure === "changed-owner" || failure === "launch-after-observation" ? 0 : 1);
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
