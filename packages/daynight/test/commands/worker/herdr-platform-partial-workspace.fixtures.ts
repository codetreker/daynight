import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Operation } from "../../../src/api/operation.js";
import { parseHerdrExecutionLabel, type HerdrAgentManager, type HerdrExecutionContext, type HerdrTaskBinding } from "../../../src/commands/worker/herdr/agents.js";
import type { HerdrRpcClient } from "../../../src/commands/worker/herdr/rpc.js";
import { assertOwnedDirectory, mappingFiles, optionalOwnedJson } from "../../../src/commands/worker/herdr/tool-launch-protocol.js";
import type { HerdrToolLaunchMapping } from "../../../src/commands/worker/herdr/tool-launch.js";
import { canonicalResourceOwner, sameResourceOwner } from "../../../src/commands/worker/resource-owner.js";
import type { inspectWindowsRootReadiness } from "./herdr-platform-readiness-diagnostics.fixtures.js";

type Row = Record<string, unknown>;
const object = (value: unknown): Row => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Invalid partial workspace observation.");
  return value as Row;
};
const list = (value: unknown): Row[] => {
  if (!Array.isArray(value)) throw new TypeError("Incomplete partial workspace snapshot.");
  return value.map(object);
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/.test(value)) throw new TypeError("Invalid partial workspace identity.");
  return value;
};
const sameDirectory = async (left: unknown, right: string): Promise<boolean> => {
  if (typeof left !== "string" || !path.isAbsolute(left) || !path.isAbsolute(right)) return false;
  const [actual, expected] = await Promise.all([realpath(left), realpath(right)]);
  return path.normalize(actual) === path.normalize(expected);
};
const snapshot = async (rpc: HerdrRpcClient, operation: Operation) => {
  const result = await rpc.request("session.snapshot", {}, operation);
  if (result.type !== "session_snapshot") throw new Error("The partial workspace snapshot is unavailable.");
  const data = object(result.snapshot);
  const workspaces = list(data.workspaces), panes = list(data.panes), agents = list(data.agents), tabs = list(data.tabs);
  for (const workspace of workspaces) { text(workspace.workspace_id); text(workspace.label); }
  for (const pane of panes) { text(pane.workspace_id); text(pane.pane_id); text(pane.terminal_id); text(pane.tab_id); }
  for (const agent of agents) { text(agent.workspace_id); text(agent.pane_id); text(agent.terminal_id); }
  for (const tab of tabs) { text(tab.workspace_id); text(tab.tab_id); }
  return { workspaces, panes, agents, tabs };
};
const owned = (workspace: Row, context: HerdrExecutionContext): boolean => {
  const owner = parseHerdrExecutionLabel(text(workspace.label));
  return owner !== null && sameResourceOwner(owner, context);
};
type Input = { context: HerdrExecutionContext; tasks: Pick<HerdrAgentManager, "listResources" | "processInfo">; rpc: HerdrRpcClient; mapping: HerdrToolLaunchMapping; operation: Operation };
type Witness = { binding: HerdrTaskBinding; tabId: string; shellPid: number; initialPaneId: string; initialTerminalId: string; initialTabId: string };

export const isRootReadinessFailure = (error: unknown): boolean => {
  if (!(error instanceof Error) || error.name !== "HerdrAgentActionError") return false;
  const action = error as Error & { action?: unknown; submission?: unknown };
  if (action.action !== "workspace.create" || action.submission !== "unknown" || !(error.cause instanceof Error)) return false;
  const phase = error.cause;
  return /^The original PowerShell root readiness phase failed \(startedRemainingMs=(?:\d+|null), remainingMs=(?:\d+|null)\)\.$/.test(phase.message) && phase.cause !== undefined;
};

export const isRootReadinessDeadline = (error: unknown): boolean => {
  if (!isRootReadinessFailure(error)) return false;
  const phase = (error as Error).cause as Error;
  const cause = phase.cause;
  if (!(cause instanceof Error)) return false;
  const terminal = cause.name === "AbortError" ? cause.cause : cause;
  return terminal instanceof Error && (terminal as Error & { kind?: unknown }).kind === "deadline";
};

export const hasReadinessContradiction = (diagnostic: Awaited<ReturnType<typeof inspectWindowsRootReadiness>>): boolean => {
  const ready = diagnostic.readyFile, pane = diagnostic.pane;
  return ready.state === "present" && (!ready.nonceMatches || !ready.pidMatches || !ready.executableMatches || !ready.validStartToken) ||
    ready.state === "unknown" && ready.reason === "invalid" || pane.state === "unknown" && pane.reason === "invalid";
};

type ReadinessProof = { state: "missing" } | { state: "verified"; digest: string };
const readinessDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const readReadiness = async (mapping: HerdrToolLaunchMapping, operation: Operation): Promise<unknown | null> => {
  operation.check();
  await assertOwnedDirectory(path.dirname(mapping.manifestPath));
  const ready = await optionalOwnedJson(mappingFiles(mapping.manifestPath).ready);
  operation.check();
  return ready;
};

export const verifyReadinessDiagnostic = async (diagnostic: Awaited<ReturnType<typeof inspectWindowsRootReadiness>>, mapping: HerdrToolLaunchMapping, shellPid: number, operation: Operation): Promise<ReadinessProof> => {
  if (hasReadinessContradiction(diagnostic)) throw new Error("The PowerShell readiness diagnostics contradict the original pane identity.");
  if (diagnostic.readyFile.state === "unknown") throw new Error("The original PowerShell readiness file remains unconfirmed.");
  if (diagnostic.pane.state !== "observed" || diagnostic.pane.shellPid !== shellPid) throw new Error("The original PowerShell pane observation remains unconfirmed.");
  const ready = await readReadiness(mapping, operation);
  if (diagnostic.readyFile.state === "present" || ready !== null) {
    if (ready === null) throw new Error("The original PowerShell readiness file disappeared.");
    const digest = readinessDigest(ready);
    await mapping.verifyReady(shellPid, operation);
    const verified = await readReadiness(mapping, operation);
    if (verified === null || readinessDigest(verified) !== digest) throw new Error("The original PowerShell readiness file changed during verification.");
    return { state: "verified", digest };
  }
  return { state: "missing" };
};

export const confirmReadinessUnchanged = async (mapping: HerdrToolLaunchMapping, proof: ReadinessProof, operation: Operation): Promise<void> => {
  const current = await readReadiness(mapping, operation);
  if (proof.state === "missing" ? current !== null : current === null || readinessDigest(current) !== proof.digest) throw new Error("The original PowerShell readiness file changed during workspace close.");
};

const assertNoLaunch = async (mapping: HerdrToolLaunchMapping): Promise<void> => {
  const files = mappingFiles(mapping.manifestPath);
  for (const file of [files.nativeStart, files.intent, files.receipt, files.initialInput]) {
    if (await optionalOwnedJson(file) !== null) throw new Error("Native launch or input responsibility is not absent.");
  }
};

const verifyCurrent = async (input: Input, witness: Witness): Promise<void> => {
  const { context, rpc, operation, mapping } = input, { binding } = witness;
  const intent = object(await optionalOwnedJson(mappingFiles(mapping.manifestPath).layout)), initial = object(intent.initial);
  if (intent.nonce !== mapping.nonce || intent.cwd !== context.cwd || JSON.stringify(intent.command) !== JSON.stringify(mapping.windowsCommand) || initial.session !== binding.session || initial.workspaceId !== binding.workspaceId || initial.paneId !== witness.initialPaneId || initial.terminalId !== witness.initialTerminalId || intent.tabId !== witness.initialTabId) throw new Error("The original PowerShell layout intent changed.");
  const current = await snapshot(rpc, operation);
  const matching = current.workspaces.filter(row => row.workspace_id === binding.workspaceId || owned(row, context));
  if (matching.length !== 1 || matching[0]!.workspace_id !== binding.workspaceId || !owned(matching[0]!, context)) throw new Error("The partial workspace owner or ID changed.");
  const panes = current.panes.filter(row => row.workspace_id === binding.workspaceId || row.pane_id === binding.paneId || row.terminal_id === binding.terminalId);
  const tabs = current.tabs.filter(row => row.workspace_id === binding.workspaceId || row.tab_id === witness.tabId);
  if (panes.length !== 1 || panes[0]!.workspace_id !== binding.workspaceId || panes[0]!.pane_id !== binding.paneId || panes[0]!.terminal_id !== binding.terminalId || panes[0]!.tab_id !== witness.tabId || tabs.length !== 1 || tabs[0]!.workspace_id !== binding.workspaceId || tabs[0]!.tab_id !== witness.tabId || current.agents.some(row => row.workspace_id === binding.workspaceId || row.pane_id === binding.paneId || row.terminal_id === binding.terminalId)) throw new Error("The partial workspace pane, tab or agent association changed.");
  if ([...current.panes, ...current.agents].some(row => row.pane_id === witness.initialPaneId || row.terminal_id === witness.initialTerminalId) || current.tabs.some(row => row.tab_id === witness.initialTabId)) throw new Error("The original layout resources remain observable.");
  const exported = await rpc.request("layout.export", { tab_id: witness.tabId }, operation);
  const layout = object(exported.layout), root = object(layout.root);
  if (exported.type !== "layout_export" || layout.workspace_id !== binding.workspaceId || layout.tab_id !== witness.tabId || root.type !== "pane" || root.pane_id !== binding.paneId || JSON.stringify(root.command) !== JSON.stringify(mapping.windowsCommand) || !await sameDirectory(root.cwd, context.cwd)) throw new Error("The partial workspace layout does not match the original mapping.");
  const process = await input.tasks.processInfo(context, binding, operation);
  if (process.shellPid !== witness.shellPid) throw new Error("The partial workspace shell changed.");
  await assertNoLaunch(mapping);
};

/** Recover only a verified root-readiness failure in the isolated acceptance daemon. */
export const observePartialWorkspace = async (input: Input): Promise<Witness> => {
  const { context, mapping, operation, tasks, rpc } = input;
  if (mapping.windowsCommand === undefined) throw new Error("The partial workspace has no original PowerShell mapping.");
  const resources = (await tasks.listResources(operation)).filter(resource => sameResourceOwner(resource.owner, context));
  if (resources.length !== 1 || resources[0]!.panes.length !== 1) throw new Error("The partial workspace identity is missing or ambiguous.");
  const resource = resources[0]!, pane = resource.panes[0]!, binding = pane.binding;
  if (binding.workspaceId !== resource.workspaceId || pane.kind !== null || pane.launchPending || pane.nativeSession !== null || pane.cwd !== null && !await sameDirectory(pane.cwd, context.cwd)) throw new Error("The partial workspace has an unconfirmed pane or native agent.");
  const intent = object(await optionalOwnedJson(mappingFiles(mapping.manifestPath).layout)), initial = object(intent.initial);
  if (intent.nonce !== mapping.nonce || intent.cwd !== context.cwd || JSON.stringify(intent.command) !== JSON.stringify(mapping.windowsCommand) || initial.session !== binding.session || initial.workspaceId !== binding.workspaceId || initial.paneId === binding.paneId) throw new Error("The original PowerShell layout intent differs from the partial workspace.");
  const initialPaneId = text(initial.paneId), initialTerminalId = text(initial.terminalId), initialTabId = text(intent.tabId);
  if (typeof intent.shellPid !== "number" || !Number.isSafeInteger(intent.shellPid) || intent.shellPid <= 0) throw new Error("The original layout shell is unknown.");
  const current = await snapshot(rpc, operation);
  const panes = current.panes.filter(row => row.workspace_id === binding.workspaceId && row.pane_id === binding.paneId && row.terminal_id === binding.terminalId);
  if (panes.length !== 1 || text(panes[0]!.tab_id) === initialTabId) throw new Error("The original layout replacement is unconfirmed.");
  const shell = await tasks.processInfo(context, binding, operation);
  const witness = { binding, tabId: text(panes[0]!.tab_id), shellPid: shell.shellPid, initialPaneId, initialTerminalId, initialTabId };
  await verifyCurrent(input, witness);
  return witness;
};

export const observeClosedPartialWorkspace = async (input: Pick<Input, "context" | "rpc" | "operation">, witness: Witness) => {
  const after = await snapshot(input.rpc, input.operation), { binding } = witness;
  const ownerAbsent = after.workspaces.every(row => !owned(row, input.context));
  const workspaceAbsent = after.workspaces.every(row => row.workspace_id !== binding.workspaceId) && [...after.panes, ...after.agents, ...after.tabs].every(row => row.workspace_id !== binding.workspaceId);
  const paneAbsent = [...after.panes, ...after.agents].every(row => row.pane_id !== binding.paneId && row.pane_id !== witness.initialPaneId);
  const terminalAbsent = [...after.panes, ...after.agents].every(row => row.terminal_id !== binding.terminalId && row.terminal_id !== witness.initialTerminalId);
  const tabAbsent = after.tabs.every(row => row.tab_id !== witness.tabId && row.tab_id !== witness.initialTabId);
  if (!ownerAbsent || !workspaceAbsent || !paneAbsent || !terminalAbsent || !tabAbsent) throw new Error("The original partial workspace remains observable after close.");
  return { owner: canonicalResourceOwner(input.context), binding: { ...binding }, tabId: witness.tabId, initialTabId: witness.initialTabId, initialPaneId: witness.initialPaneId, initialTerminalId: witness.initialTerminalId, ownerAbsent, workspaceAbsent, paneAbsent, terminalAbsent, tabAbsent };
};

export const closePartialWorkspace = async (input: Input, witness: Witness) => {
  await verifyCurrent(input, witness);
  const result = await input.rpc.request("workspace.close", { workspace_id: witness.binding.workspaceId, close_group: false }, input.operation);
  if (result.type !== "ok") throw new Error("The partial workspace close was not confirmed.");
  const { ownerAbsent, workspaceAbsent, paneAbsent, terminalAbsent, tabAbsent } = await observeClosedPartialWorkspace(input, witness);
  return { owner: canonicalResourceOwner(input.context), binding: { ...witness.binding }, tabId: witness.tabId, initialTabId: witness.initialTabId, initialPaneId: witness.initialPaneId, initialTerminalId: witness.initialTerminalId, shellPid: witness.shellPid, failurePhase: "root-readiness" as const, layoutVerified: true, noAgentLaunch: true, closeConfirmed: true, after: { ownerAbsent, workspaceAbsent, paneAbsent, terminalAbsent, tabAbsent } };
};
