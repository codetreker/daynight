import { ConfigurationAdmissionWaiting, assertConfigurationAdmission } from "../configuration-admission.js";
import { WindowsProcessProofError } from "../../controller/windows-process-proof.js";
import { codexAgentCliOverrides } from "../../../cli/codex-agent-environment.js";
import { readCodexConfiguration } from "./codex-config.js";
import { createHash, randomUUID } from "node:crypto";
import { ExecutionSourceConflictError } from "../execution-stop.js";
import type { CleanupTarget, StopObservation } from "../execution-stop.js";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { OperationError } from "../../../api/operation.js";
import type { Operation } from "../../../api/operation.js";
import { canonicalId } from "../../../api/parse.js";
import type { WorkerAgent } from "../../../api/types.js";
import type { ResourceOwner } from "../types.js";
import { parseResourceOwner, resourceOwnerKey, sameResourceOwner } from "../resource-owner.js";
import { buildHerdrAgentArguments, nativeAgentPermissionEnvironment, validateHerdrAgentArguments } from "./arguments.js";
import type { HerdrAgentConfiguration } from "./arguments.js";
import { nativeInputBlocker } from "./input-blockers.js";
import type { NativeInputBlocker } from "./input-blockers.js";
import { HerdrRpcError } from "./rpc.js";
import type { HerdrRpcClient, HerdrRpcResult } from "./rpc.js";
import type { ResolvedToolLaunch } from "../../../platform/tool-executables.js";
import { mappingFiles, optionalOwnedJson, publishOwnedJson } from "./tool-launch.js";
import type { HerdrToolLaunchMapping, HerdrToolLaunchReceipt } from "./tool-launch.js";
import { advanceToolStartRequest, deferToolStartRequest, nativeStartRejectionCodes, reserveToolStartRequest, type ToolStartRequest } from "./tool-launch-start.js";

export type { HerdrAgentConfiguration } from "./arguments.js";
export { buildHerdrAgentArguments, validateHerdrAgentArguments } from "./arguments.js";
export type HerdrExecutionOwner = ResourceOwner;
export type HerdrExecutionContext = HerdrExecutionOwner & { cwd: string; agent: WorkerAgent };
export type HerdrTaskBinding = { session: string; workspaceId: string; paneId: string; terminalId: string };
export type HerdrPendingStop = { context: HerdrExecutionOwner & { cwd: string }; binding: HerdrTaskBinding };
export type HerdrNativeReference = { source: string; agent: WorkerAgent; sessionId: string };
export type HerdrAgentObservation = { binding: HerdrTaskBinding; kind: string | null; name: string | null; status: string; launchPending: boolean; interactiveReady: boolean; nativeSession: HerdrNativeReference | null; stateChangeSeq: number | null; completionSeq: number | null };
export type HerdrPromptReceipt = { submission: "submitted"; observation: HerdrAgentObservation };
export type HerdrPromptResult = HerdrPromptReceipt | { submission: "skipped"; observation: HerdrAgentObservation };
export type HerdrPromptGuard = (operation: Operation) => Promise<boolean>;
export type HerdrAgentLaunchInput = { configuration: HerdrAgentConfiguration; resumeSessionId?: string; beforeStart?: (operation: Operation) => Promise<void>; canAdmitNewExecution?: () => boolean; onSubmitting?: () => void; onRejected?: (rejection: HerdrAgentActionError) => void };
export type HerdrAgentStartInput = HerdrAgentLaunchInput & {
  prompt: string;
  /** Capture the current input immediately before the durable native launch. */
  preparePrompt?: (recovery: boolean) => string;
  preparePromptSource?: (operation: Operation) => Promise<void>;
  onPromptPrepared?: (prompt: string, recovery: boolean) => void;
  onAgentStarted?: () => void;
  onAgentInitializing?: () => void;
  onAgentInitialized?: () => void;
  onExistingAgentObserved?: () => void;
  onPromptSubmitting?: () => void;
  onPromptTransportCompleted?: () => void;
  // The receipt preserves the pre-input observation before session discovery
  // can observe a completed turn or fail after acknowledged submission.
  onPromptSubmitted?: (receipt: HerdrPromptReceipt) => void;
};
export type HerdrOwnedWorkspace = { owner: HerdrExecutionOwner; workspaceId: string; panes: { binding: HerdrTaskBinding; cwd: string | null; kind: WorkerAgent | null; status: string; launchPending: boolean; interactiveReady: boolean; nativeSession: HerdrNativeReference | null; stateChangeSeq: number | null; completionSeq: number | null }[] };
export type HerdrAgentPreflight = { verifyStart(input: { context: HerdrExecutionContext; configuration: HerdrAgentConfiguration; resumeSessionId?: string }, operation: Operation): Promise<unknown> };
export type HerdrWorkspaceEnvironment = Readonly<{ XDG_CONFIG_HOME: string; XDG_STATE_HOME: string; PATH?: string; DN_CONFIG_DIR?: string; DAYNIGHT_HERDR_TOOL_MANIFEST?: string }>;

type RecordValue = Record<string, unknown>;
const object = (value: unknown, name: string): RecordValue => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  return value as RecordValue;
};
const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value === "" || /[\r\n\0]/.test(value)) throw new TypeError(`${name} must be nonempty text without line breaks or NUL.`);
  return value;
};
const array = (value: unknown, name: string): unknown[] => { if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`); return value; };
const optionalText = (value: unknown, name: string): string | null => value === undefined ? null : text(value, name);
const optionalBoolean = (value: unknown, name: string): boolean => { if (value === undefined) return false; if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean.`); return value; };
const pid = (value: unknown): number => { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new TypeError("Herdr process ID must be a positive process identifier."); return value; };
const counter = (value: unknown, name: string): number => { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer.`); return value; };
const diagnosticRemainingMs = (operation: Operation): number | null => { try { return Math.floor(operation.remainingMs()); } catch { return null; } };
const paneShellNames = new Set(["sh", "bash", "dash", "zsh", "fish", "ksh", "mksh", "csh", "tcsh", "elvish", "xonsh", "nu", "pwsh", "powershell", "cmd"]);
const paneShellName = (value: unknown): boolean => typeof value === "string" && paneShellNames.has(value.split(/[\\/]/).at(-1)!.replace(/^-+/, "").replace(/\.exe$/, "").toLowerCase());
const expectedResult = (value: HerdrRpcResult, type: string): HerdrRpcResult => { if (value.type !== type) throw new TypeError(`Expected Herdr ${type} result; received ${value.type}.`); return value; };
const labelSeparator = " | daynight:";
const unsafeTitleCharacter = /[\p{Cc}\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;
const workspaceTitle = (title: string): string => {
  if (typeof title !== "string" || title.trim().length === 0) throw new TypeError("The task title must be nonempty text.");
  return Array.from(title, (character) => unsafeTitleCharacter.test(character) ? `\\u{${character.codePointAt(0)!.toString(16)}}` : character).join("");
};
export const herdrExecutionLabel = (context: HerdrExecutionOwner, title: string): string => `${workspaceTitle(title)}${labelSeparator}${resourceOwnerKey(context)}`;
export const herdrExecutionAgentName = (context: HerdrExecutionOwner): string => `dn_${createHash("sha256").update(resourceOwnerKey(context)).digest("hex").slice(0, 24)}`;
export const parseHerdrExecutionLabel = (label: string): HerdrExecutionOwner | null => {
  const separator = label.lastIndexOf(labelSeparator);
  if (separator === -1) return null;
  try { return parseResourceOwner(label.slice(separator + labelSeparator.length)); }
  catch { return null; }
};
const matchesWorkspaceOwner = (workspace: RecordValue, owner: HerdrExecutionOwner): boolean => {
  if (typeof workspace.label !== "string") throw new TypeError("The Herdr workspace label must be a string.");
  const actual = parseHerdrExecutionLabel(workspace.label);
  return actual !== null && sameResourceOwner(actual, owner);
};

export class HerdrAgentActionError extends Error {
  readonly promptSubmission: "not-submitted" | "submitted" | "unknown" | null;
  constructor(message: string, readonly action: string, readonly submission: "not-submitted" | "rejected" | "unknown", options?: ErrorOptions & { promptSubmission?: "not-submitted" | "submitted" | "unknown" }) {
    super(message, options); this.name = "HerdrAgentActionError";
    this.promptSubmission = options?.promptSubmission === undefined ? null : options.promptSubmission;
  }
}
export class LegacyBindingUnavailableError extends Error {
  override readonly name = "LegacyBindingUnavailableError";
}
export class HerdrInputWaitingError extends HerdrAgentActionError {
  constructor(readonly reason: "task_paused" | "control_suspended" | "native_blocked" | "native_session_pending", message: string, options?: ErrorOptions) {
    super(message, "agent.prompt", "not-submitted", { ...options, promptSubmission: "not-submitted" });
    this.name = "HerdrInputWaitingError";
  }
}
export class HerdrInputBlockedError extends HerdrInputWaitingError {
  constructor(readonly blocker: NativeInputBlocker) {
    super("native_blocked", `The native agent has ${blocker === "menu" ? "an open menu" : "disabled input"}; use daynight worker attach to resolve it.`);
    this.name = "HerdrInputBlockedError";
  }
}
const rejectionCodes: Readonly<Record<string, ReadonlySet<string>>> = {
  "agent.start": nativeStartRejectionCodes,
  "agent.prompt": new Set(["empty_agent_prompt", "agent_blocked", "agent_not_ready", "agent_not_found", "ambiguous_agent_target"]),
};
const classifyMutationError = (action: string, cause: unknown): HerdrAgentActionError => {
  if (cause instanceof HerdrRpcError) {
    const submission = cause.code !== null && rejectionCodes[action]?.has(cause.code) ? "rejected" : cause.submission;
    return new HerdrAgentActionError(`Herdr ${action} did not establish a successful result.`, action, submission, { cause, ...(action === "agent.prompt" ? { promptSubmission: submission === "unknown" ? "unknown" as const : "not-submitted" as const } : {}) });
  }
  return new HerdrAgentActionError(`Herdr ${action} did not establish a successful result.`, action, "unknown", { cause, ...(action === "agent.prompt" ? { promptSubmission: "unknown" as const } : {}) });
};
const processExecuting = async (processId: number): Promise<boolean> => {
  try { process.kill(processId, 0); return true; }
  catch (cause) { if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return false; throw cause; }
};

export const createHerdrAgentManager = (options: { rpc: HerdrRpcClient; session: string; preflight: HerdrAgentPreflight; workspaceEnvironment: HerdrWorkspaceEnvironment; nativeEnvironment?: NodeJS.ProcessEnv; toolMapping?: (context: HerdrExecutionContext, operation: Operation, existingOnly?: boolean) => Promise<HerdrToolLaunchMapping | null>; stopToolMapping?: (context: HerdrExecutionOwner & { cwd: string }, operation: Operation) => Promise<HerdrToolLaunchMapping | null>; readCodexConfig?: (args: readonly string[], cwd: string, operation: Operation, toolLaunch?: ResolvedToolLaunch) => Promise<unknown>; processExecuting?: (pid: number) => Promise<boolean>; pollIntervalMs?: number }) => {
  const session = text(options.session, "Herdr session");
  const suppliedEnvironment = object(options.workspaceEnvironment, "Task workspace environment");
  const xdgFields = ["XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const;
  const allowedFields = new Set<string>([...xdgFields, "PATH", "DN_CONFIG_DIR", "DAYNIGHT_HERDR_TOOL_MANIFEST"]);
  if (Object.hasOwn(suppliedEnvironment, "DAYNIGHT_HERDR_TOOL_MANIFEST")) throw new TypeError("Herdr tool manifests may only come from the registered execution mapping.");
  if (xdgFields.some(field => !Object.hasOwn(suppliedEnvironment, field)) || Object.entries(suppliedEnvironment).some(([field, value]) => !allowedFields.has(field) || typeof value !== "string" || value.includes("\0"))) throw new TypeError("Task workspace environment requires XDG_CONFIG_HOME and XDG_STATE_HOME and permits optional PATH and DN_CONFIG_DIR string values without NUL.");
  const workspaceEnvironment = { ...suppliedEnvironment } as HerdrWorkspaceEnvironment;
  const isExecuting = options.processExecuting === undefined ? processExecuting : options.processExecuting;
  const pollInterval = options.pollIntervalMs === undefined ? 100 : options.pollIntervalMs;
  if (!Number.isSafeInteger(pollInterval) || pollInterval <= 0 || pollInterval > 1000) throw new TypeError("The Herdr observation interval must be between 1 and 1000 milliseconds.");
  const inputTails = new Map<string, Promise<void>>();
  const stoppingProcesses = new Map<string, HerdrPendingStop & { processIds: Set<number>; originalBindingObserved: boolean; mapping?: HerdrToolLaunchMapping }>();
  const workerRun = randomUUID();
  const stoppedRuns = new Map<string, HerdrTaskBinding>();
  const activeBindings = new Map<string, { binding: HerdrTaskBinding; agent: WorkerAgent }>();
  const mappings = new Map<string, HerdrToolLaunchMapping | null>();
  const rememberMapping = (key: string, mapping: HerdrToolLaunchMapping | null): HerdrToolLaunchMapping | null => {
    if (mapping !== null && (!path.isAbsolute(mapping.manifestPath) || mapping.environment.DAYNIGHT_HERDR_TOOL_MANIFEST !== mapping.manifestPath || canonicalId(mapping.nonce) !== mapping.nonce || !/^[a-f0-9]{64}$/.test(mapping.selectionKey))) throw new Error("The registered Herdr tool mapping has invalid execution identity.");
    mappings.set(key, mapping);
    return mapping;
  };
  const mappingFor = async (context: HerdrExecutionContext, operation: Operation, existingOnly = true): Promise<HerdrToolLaunchMapping | null> => {
    const key = resourceOwnerKey(context);
    if (mappings.has(key)) return mappings.get(key)!;
    const mapping = await options.toolMapping?.(context, operation, existingOnly) ?? null;
    return rememberMapping(key, mapping);
  };
  const stopMappingFor = async (context: HerdrExecutionOwner & { cwd: string }, operation: Operation, observedAgent: WorkerAgent | undefined): Promise<HerdrToolLaunchMapping | null> => {
    const key = resourceOwnerKey(context), cached = mappings.get(key);
    if (options.stopToolMapping === undefined) return cached ?? (observedAgent === undefined ? null : mappingFor({ ...context, agent: observedAgent }, operation));
    // A prepared pane may not have a native agent yet. Its persisted owner still
    // determines the mapping, including after this manager's caches are lost.
    const restored = await options.stopToolMapping(context, operation);
    if (mappings.has(key) && (cached === null ? restored !== null : restored === null || cached!.nonce !== restored.nonce || cached!.selectionKey !== restored.selectionKey || cached!.manifestPath !== restored.manifestPath)) throw new Error("The original Herdr stop mapping differs from its frozen execution identity.");
    return rememberMapping(key, cached ?? restored);
  };
  const runKey = (binding: HerdrTaskBinding): string => JSON.stringify([workerRun, binding.session, binding.workspaceId, binding.paneId, binding.terminalId]);
  const serialized = async <T>(key: string, operation: Operation, action: () => Promise<T>): Promise<T> => {
    operation.check();
    const previous = inputTails.get(key);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous === undefined ? gate : previous.then(() => gate);
    inputTails.set(key, tail);
    void tail.then(() => { if (inputTails.get(key) === tail) inputTails.delete(key); });
    try {
      if (previous !== undefined) await new Promise<void>((resolve, reject) => {
        let completed = false;
        const abort = (): void => { if (completed) return; completed = true; operation.signal.removeEventListener("abort", abort); reject(operation.signal.reason); };
        operation.signal.addEventListener("abort", abort, { once: true });
        void previous.then(() => { if (completed) return; completed = true; operation.signal.removeEventListener("abort", abort); resolve(); });
        if (operation.signal.aborted) abort();
      });
      operation.check();
      return await action();
    } finally { release(); }
  };
  const wait = (operation: Operation, maximumMs = pollInterval): Promise<void> => new Promise((resolve, reject) => {
    operation.check();
    const abort = (): void => { clearTimeout(timer); operation.signal.removeEventListener("abort", abort); reject(operation.signal.reason); };
    const timer = setTimeout(() => { operation.signal.removeEventListener("abort", abort); resolve(); }, Math.min(pollInterval, maximumMs, Math.max(1, operation.remainingMs())));
    operation.signal.addEventListener("abort", abort, { once: true });
    if (operation.signal.aborted) abort();
  });
  const finishStop = async (key: string, operation: Operation): Promise<void> => {
    const pending = stoppingProcesses.get(key);
    if (pending === undefined) return;
    if (pending.mapping !== undefined) await pending.mapping.stopProcesses(operation);
    while (true) {
      let running = false;
      if (pending.mapping === undefined) for (const processId of pending.processIds) { operation.check(); if (await isExecuting(processId)) running = true; }
      if (!running && (pending.mapping === undefined || await pending.mapping.confirmStopped(operation))) { if (pending.mapping === undefined) stoppingProcesses.delete(key); return; }
      await wait(operation);
    }
  };
  const snapshot = async (operation: Operation) => {
    const result = expectedResult(await options.rpc.request("session.snapshot", {}, operation), "session_snapshot");
    const data = object(result.snapshot, "Herdr snapshot");
    return { workspaces: array(data.workspaces, "Herdr workspaces").map((value) => object(value, "Herdr workspace")), panes: array(data.panes, "Herdr panes").map((value) => object(value, "Herdr pane")), agents: array(data.agents, "Herdr agents").map((value) => object(value, "Herdr agent")), tabs: array(data.tabs, "Herdr tabs").map((value) => object(value, "Herdr tab")) };
  };
  const readOwned = async (context: HerdrExecutionContext, binding: HerdrTaskBinding, operation: Operation, allowMissingPane = false) => {
    if (binding.session !== session) throw new Error("The task binding belongs to another Herdr session.");
    const data = await snapshot(operation);
    const matching = data.workspaces.filter((workspace) => matchesWorkspaceOwner(workspace, context));
    if (matching.length !== 1 || matching[0]!.workspace_id !== binding.workspaceId) throw new Error("The original task workspace is missing, duplicated or has different ownership.");
    const panes = data.panes.filter((pane) => pane.pane_id === binding.paneId);
    if (panes.length === 0 && allowMissingPane) return { data, workspace: matching[0]!, pane: null };
    if (panes.length !== 1) throw new Error("The original task pane is missing or duplicated.");
    const pane = panes[0]!;
    if (pane.workspace_id !== binding.workspaceId || pane.terminal_id !== binding.terminalId) throw new Error("The task pane or terminal identity has changed.");
    return { data, workspace: matching[0]!, pane };
  };
  const prepareWindowsRoot = async (context: HerdrExecutionContext, initial: HerdrTaskBinding, mapping: HerdrToolLaunchMapping, operation: Operation, newlyCreated: boolean): Promise<HerdrTaskBinding> => {
    if (mapping.windowsCommand === undefined) return initial;
    const file = mappingFiles(mapping.manifestPath).layout;
    let intent = await optionalOwnedJson(file) as RecordValue | null;
    if (intent === null) {
      if (!newlyCreated) throw new HerdrAgentActionError("The original PowerShell layout preparation intent is missing; the pane was retained.", "layout.apply", "unknown");
      const { data, pane } = await readOwned(context, initial, operation);
      if (data.panes.filter(value => value.workspace_id === initial.workspaceId).length !== 1 || data.agents.some(value => value.workspace_id === initial.workspaceId)) throw new Error("Only a newly created, empty owned workspace can prepare a PowerShell root.");
      const tabId = text(pane!.tab_id, "Initial owned tab ID");
      const result = expectedResult(await options.rpc.request("pane.process_info", { pane_id: initial.paneId }, operation), "pane_process_info"), info = object(result.process_info, "Initial owned pane process");
      if (info.pane_id !== initial.paneId) throw new Error("The initial process observation belongs to another pane.");
      const shellPid = pid(info.shell_pid), processes = [shellPid, ...array(info.foreground_processes ?? [], "Initial pane processes").map(value => pid(object(value, "Initial process").pid))];
      if (processes.some(value => value !== shellPid)) throw new Error("The initial owned shell has active descendants; layout replacement is prohibited.");
      intent = { nonce: mapping.nonce, initial, tabId, shellPid, cwd: context.cwd, command: [...mapping.windowsCommand] };
      await publishOwnedJson(file, intent);
      try { await mutation("layout.apply", { tab_id: tabId, focus: false, root: { type: "pane", cwd: context.cwd, command: [...mapping.windowsCommand], env: { ...workspaceEnvironment, ...mapping.environment, ...nativeAgentPermissionEnvironment(context.agent) } } }, "layout_apply", operation); }
      catch (cause) { if (!(cause instanceof HerdrAgentActionError) || cause.submission !== "unknown") throw cause; }
    }
    if (intent.nonce !== mapping.nonce || intent.cwd !== context.cwd || JSON.stringify(intent.command) !== JSON.stringify(mapping.windowsCommand)) throw new HerdrAgentActionError("The original PowerShell layout intent differs from the frozen mapping.", "layout.apply", "unknown");
    const original = object(intent.initial, "Original PowerShell layout binding");
    if (original.session !== session || original.workspaceId !== initial.workspaceId) throw new Error("The original layout intent belongs to another execution.");
    const data = await snapshot(operation), owned = data.workspaces.filter(value => matchesWorkspaceOwner(value, context));
    const panes = data.panes.filter(value => value.workspace_id === initial.workspaceId), tabs = data.tabs.filter(value => value.workspace_id === initial.workspaceId);
    if (owned.length !== 1 || owned[0]!.workspace_id !== initial.workspaceId || panes.length !== 1 || tabs.length !== 1 || panes[0]!.pane_id === original.paneId || tabs[0]!.tab_id === intent.tabId) throw new HerdrAgentActionError("The original PowerShell layout replacement remains unknown; both pane responsibilities were retained.", "layout.apply", "unknown");
    const pane = panes[0]!, binding = { session, workspaceId: initial.workspaceId, paneId: text(pane.pane_id, "Prepared PowerShell pane"), terminalId: text(pane.terminal_id, "Prepared PowerShell terminal") };
    const exported = expectedResult(await options.rpc.request("layout.export", { tab_id: text(tabs[0]!.tab_id, "Prepared PowerShell tab") }, operation), "layout_export"), layout = object(exported.layout, "Prepared PowerShell layout"), root = object(layout.root, "Prepared PowerShell root");
    const sameCwd = typeof root.cwd === "string" && path.isAbsolute(root.cwd) && path.isAbsolute(context.cwd)
      ? await Promise.all([realpath(root.cwd), realpath(context.cwd)]).then(([actual, expected]) => path.normalize(actual) === path.normalize(expected), () => false)
      : false;
    const mismatches = [
      ["workspace_id", layout.workspace_id === initial.workspaceId], ["tab_id", layout.tab_id === tabs[0]!.tab_id],
      ["type", root.type === "pane"], ["pane_id", root.pane_id === binding.paneId],
      ["cwd", sameCwd], ["command", JSON.stringify(root.command) === JSON.stringify(mapping.windowsCommand)],
    ].filter(([, matches]) => !matches).map(([field]) => field);
    if (mismatches.length !== 0) {
      const boundedText = (value: unknown) => typeof value === "string" ? value.slice(0, 512) : null;
      const boundedCommand = (value: unknown) => Array.isArray(value) ? value.slice(0, 16).map(boundedText) : null;
      const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
      const observedCommand = Array.isArray(root.command) ? root.command : null;
      const differingIndices: number[] = [];
      if (observedCommand !== null) for (let index = 0; index < Math.max(observedCommand.length, mapping.windowsCommand.length) && differingIndices.length < 16; index++) {
        if (JSON.stringify(observedCommand[index]) !== JSON.stringify(mapping.windowsCommand[index])) differingIndices.push(index);
      }
      const commandSummary = { type: observedCommand === null ? root.command === null ? "null" : typeof root.command : "array", length: observedCommand?.length ?? null, sha256: digest(root.command), differingIndices, arguments: observedCommand?.slice(0, 16).map(value => ({ type: value === null ? "null" : typeof value, length: typeof value === "string" ? value.length : null, sha256: digest(value) })) ?? null };
      const diagnostic = JSON.stringify({ mismatches, expected: { cwd: boundedText(context.cwd), command: boundedCommand(mapping.windowsCommand) }, observed: { cwd: boundedText(root.cwd), command: commandSummary } }).slice(0, 8192);
      throw new HerdrAgentActionError("The observed PowerShell root does not match the original layout intent.", "layout.apply", "unknown", { cause: new Error(diagnostic) });
    }
    while (await isExecuting(pid(intent.shellPid))) await wait(operation);
    const processes = expectedResult(await options.rpc.request("pane.process_info", { pane_id: binding.paneId }, operation), "pane_process_info"), info = object(processes.process_info, "PowerShell root process");
    if (info.pane_id !== binding.paneId) throw new Error("The prepared PowerShell process belongs to another pane.");
    const readinessRemainingMs = diagnosticRemainingMs(operation);
    try { await mapping.verifyReady(pid(info.shell_pid), operation); }
    catch (cause) {
      if (cause instanceof HerdrAgentActionError) throw cause;
      throw new Error(`The original PowerShell root readiness phase failed (startedRemainingMs=${readinessRemainingMs}, remainingMs=${diagnosticRemainingMs(operation)}).`, { cause });
    }
    await readOwned(context, binding, operation);
    return binding;
  };
  const readNameOwnership = async (context: HerdrExecutionContext, binding: HerdrTaskBinding, operation: Operation, submission: "not-submitted" | "unknown") => {
    try { return await readOwned(context, binding, operation); }
    catch (cause) {
      const timedOut = cause instanceof OperationError && cause.kind === "deadline";
      const snapshotFailure = cause instanceof HerdrRpcError && cause.method === "session.snapshot";
      const deadlineSignal = operation.signal.reason instanceof OperationError && operation.signal.reason.kind === "deadline";
      if ((timedOut || snapshotFailure) && (!operation.signal.aborted || deadlineSignal)) {
        throw new HerdrAgentActionError("The workspace name ownership observation could not be completed.", "workspace.rename", submission, { cause });
      }
      throw cause;
    }
  };
  const nativeReference = (value: unknown, expectedAgent: WorkerAgent): HerdrNativeReference | null => {
    if (value === undefined) return null;
    const reference = object(value, "Native session reference");
    if (reference.source !== `herdr:${expectedAgent}` || reference.agent !== expectedAgent || reference.kind !== "id") throw new Error("The native session reference was not reported by the expected official Herdr integration.");
    const sessionId = canonicalId(text(reference.value, "Native session ID"));
    if (sessionId === null) throw new Error("The native session reference must contain an exact session UUID.");
    return { source: reference.source, agent: expectedAgent, sessionId };
  };
  const observation = async (context: HerdrExecutionContext, binding: HerdrTaskBinding, operation: Operation): Promise<HerdrAgentObservation> => {
    const { data, pane } = await readOwned(context, binding, operation);
    const candidates = data.agents.filter((agent) => agent.pane_id === binding.paneId);
    if (candidates.length > 1) throw new Error("The original task pane has multiple agent observations.");
    const agent = candidates[0];
    const info = agent === undefined ? pane! : agent;
    if (info.workspace_id !== binding.workspaceId || info.terminal_id !== binding.terminalId) throw new Error("The task agent observation belongs to another workspace or terminal.");
    const kind = optionalText(info.agent, "Native agent kind");
    if (kind !== null && kind !== context.agent) throw new Error("The task pane hosts a different native agent.");
    const name = optionalText(info.name, "Managed agent name");
    if (name !== null && name !== herdrExecutionAgentName(context)) throw new Error("The task pane has a different managed agent name.");
    const status = text(info.agent_status, "Native agent status");
    if (!["idle", "working", "blocked", "done", "unknown"].includes(status)) throw new TypeError("The native agent status is invalid.");
    return { binding, kind, name, status, launchPending: optionalBoolean(info.launch_pending, "Native launch state"), interactiveReady: optionalBoolean(info.interactive_ready, "Native readiness"), nativeSession: nativeReference(info.agent_session, context.agent), stateChangeSeq: agent === undefined ? null : counter(info.state_change_seq, "Native state-change sequence"), completionSeq: agent === undefined || info.completion_seq === undefined ? null : counter(info.completion_seq, "Native completion sequence") };
  };
  const mutation = async (method: string, params: Record<string, unknown>, type: string, operation: Operation): Promise<HerdrRpcResult> => {
    try { return expectedResult(await options.rpc.request(method, params, operation), type); }
    catch (cause) { throw classifyMutationError(method, cause); }
  };
  const shellInitializing = async (context: HerdrExecutionContext, binding: HerdrTaskBinding, operation: Operation): Promise<boolean> => {
    const current = await observation(context, binding, operation);
    if (current.kind !== null || current.name !== null || current.launchPending || current.interactiveReady) return false;
    const result = expectedResult(await options.rpc.request("pane.process_info", { pane_id: binding.paneId }, operation), "pane_process_info");
    const info = object(result.process_info, "Shell initialization process observation");
    if (info.pane_id !== binding.paneId) throw new Error("The shell initialization observation belongs to another pane.");
    if (info.shell_pid === undefined || info.foreground_process_group_id === undefined || info.foreground_processes === undefined) return false;
    const shellPid = pid(info.shell_pid);
    if (pid(info.foreground_process_group_id) !== shellPid) return false;
    return array(info.foreground_processes, "Shell initialization foreground processes").some((entry) => {
      const foreground = object(entry, "Shell initialization foreground process");
      if (pid(foreground.pid) !== shellPid) return false;
      const argv = foreground.argv === undefined ? [] : array(foreground.argv, "Shell initialization process arguments");
      return paneShellName(foreground.name) || paneShellName(argv[0]);
    });
  };
  const startNative = async (context: HerdrExecutionContext, binding: HerdrTaskBinding, cwd: string, args: string[], operation: Operation, input: HerdrAgentLaunchInput): Promise<HerdrRpcResult> => {
    let readiness: { deadline: number; rejection: HerdrAgentActionError } | undefined;
    let request: ToolStartRequest | undefined;
    const mapping = await mappingFor(context, operation);
    while (true) {
      operation.check();
      if (readiness !== undefined && performance.now() >= readiness.deadline) throw readiness.rejection;
      // A definite rejection authorizes another attempt only after fresh caller admission.
      if (input.beforeStart !== undefined) await input.beforeStart(operation);
      operation.check();
      try {
        const { pane } = await readOwned(context, binding, operation);
        const actualCwd = text(pane!.cwd, "Native launch shell cwd");
        if (!path.isAbsolute(actualCwd)) throw new Error("The original task shell cwd must be absolute before native launch.");
        if (path.normalize(await realpath(actualCwd)) !== cwd) throw new Error(`The original task shell cwd is ${actualCwd}; expected ${cwd}. Restore its working directory before starting the native agent.`);
        const mapping = await mappingFor(context, operation);
        if (mapping !== null) await verifyMappingProcesses(context, binding, mapping, operation);
        operation.check();
      } catch (cause) { throw new HerdrAgentActionError(cause instanceof Error ? cause.message : "The original task shell cwd could not be confirmed before native launch.", "agent.start", "not-submitted", { cause }); }
      if (readiness !== undefined && performance.now() >= readiness.deadline) throw readiness.rejection;
      const timeout = Math.floor(Math.min(30_000, operation.remainingMs()));
      if (timeout <= 3000) throw readiness === undefined ? new HerdrAgentActionError("The remaining operation budget cannot start a native agent.", "agent.start", "not-submitted") : readiness.rejection;
      assertConfigurationAdmission(input.canAdmitNewExecution);
      if (mapping !== null) {
        try {
          request = request === undefined
            ? await reserveToolStartRequest(mapping.manifestPath, { nonce: mapping.nonce, selectionKey: mapping.selectionKey, owner: context }, binding, context.agent, args)
            : await advanceToolStartRequest(mapping.manifestPath, request);
        } catch (cause) { throw new HerdrAgentActionError("The original native launch request is already reserved or its durable outcome is unknown; agent.start cannot be repeated.", "agent.start", "unknown", { cause }); }
      }
      try {
        operation.check();
        assertConfigurationAdmission(input.canAdmitNewExecution);
        input.onSubmitting?.();
      } catch (cause) {
        if (mapping !== null && request !== undefined) {
          try { request = await deferToolStartRequest(mapping.manifestPath, request); }
          catch (settlementError) { throw new HerdrAgentActionError("The unsubmitted native launch request could not be durably settled; agent.start cannot be repeated.", "agent.start", "unknown", { cause: new AggregateError([cause, settlementError]) }); }
        }
        throw cause;
      }
      try { return await mutation("agent.start", { name: herdrExecutionAgentName(context), kind: context.agent, pane_id: binding.paneId, args, timeout_ms: timeout }, "agent_started", operation); }
      catch (error) {
        if (mapping !== null && request !== undefined && error instanceof HerdrAgentActionError && error.submission === "rejected" && error.cause instanceof HerdrRpcError && error.cause.code !== null && nativeStartRejectionCodes.has(error.cause.code)) {
          try { request = await advanceToolStartRequest(mapping.manifestPath, request, error.cause.code); }
          catch (cause) { throw new HerdrAgentActionError("The native launch rejection could not be durably settled; agent.start cannot be repeated.", "agent.start", "unknown", { cause }); }
        }
        if (!(error instanceof HerdrAgentActionError) || error.submission !== "rejected" || !(error.cause instanceof HerdrRpcError) || error.cause.method !== "agent.start" || error.cause.code !== "agent_pane_busy") throw error;
        try { input.onRejected?.(error); }
        catch (cause) { throw new AggregateError([error, cause], "The definite native rejection could not be committed.", { cause: error }); }
        // A new shell can still be running its startup scripts. Herdr's CLI retries
        // this definite rejection with the same terminal and shell-process proof.
        // https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/cli/agent.rs#L358-L403
        readiness = { deadline: readiness === undefined ? performance.now() + 2000 : readiness.deadline, rejection: error };
        if (performance.now() >= readiness.deadline || !await shellInitializing(context, binding, operation)) throw error;
        await wait(operation, readiness.deadline - performance.now());
        if (performance.now() >= readiness.deadline || !await shellInitializing(context, binding, operation)) throw error;
      }
    }
  };
  const verifyMappingProcesses = async (context: HerdrExecutionContext, binding: HerdrTaskBinding, mapping: HerdrToolLaunchMapping, operation: Operation, receipt?: HerdrToolLaunchReceipt): Promise<void> => {
    await readOwned(context, binding, operation);
    const result = expectedResult(await options.rpc.request("pane.process_info", { pane_id: binding.paneId }, operation), "pane_process_info"), info = object(result.process_info, "Original launch process ownership");
    if (info.pane_id !== binding.paneId) throw new Error("The original launch process proof belongs to another pane.");
    const foregroundPids = array(info.foreground_processes, "Original foreground processes").map(value => pid(object(value, "Original foreground process").pid));
    await mapping.verifyProcesses({ shellPid: pid(info.shell_pid), foregroundPids, ...(receipt === undefined ? {} : { receipt }) }, operation);
    await readOwned(context, binding, operation);
  };
  const submit = async (context: HerdrExecutionContext, binding: HerdrTaskBinding, prompt: string, operation: Operation, initialPrompt = false, beforeSubmit?: HerdrPromptGuard): Promise<HerdrPromptResult> => {
    if (typeof prompt !== "string" || prompt.length === 0) throw new HerdrAgentActionError("The caller prompt must be nonempty text.", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" });
    let before: HerdrAgentObservation;
    let mapping: HerdrToolLaunchMapping | null;
    const verifyInputAgent = (current: HerdrAgentObservation): void => {
      const knownAgent = current.kind === context.agent || current.nativeSession?.agent === context.agent || (initialPrompt && current.name === herdrExecutionAgentName(context));
      if (!knownAgent || current.launchPending || ((initialPrompt || current.nativeSession === null) && !current.interactiveReady) || current.status === "blocked") throw new Error("The original native agent is not ready for input.");
    };
    try {
      before = await observation(context, binding, operation);
      verifyInputAgent(before);
      if (context.agent === "codex" || context.agent === "claude") {
        const result = expectedResult(await options.rpc.request("agent.read", { target: binding.paneId, source: "visible", format: "text", strip_ansi: true }, operation), "pane_read");
        const read = object(result.read, "Visible native input");
        if (read.pane_id !== binding.paneId || read.workspace_id !== binding.workspaceId || read.source !== "visible" || read.format !== "text") throw new Error("The visible native input does not identify the original task pane and requested source.");
        if (typeof read.text !== "string" || typeof read.truncated !== "boolean") throw new TypeError("The visible native input must contain text and an explicit truncation fact.");
        if (read.truncated) throw new Error("The visible native input was truncated; an open native menu cannot be ruled out.");
        const blocker = nativeInputBlocker(context.agent, read.text);
        before = await observation(context, binding, operation);
        verifyInputAgent(before);
        if (blocker !== null) throw new HerdrInputBlockedError(blocker);
      }
      mapping = await mappingFor(context, operation);
      if (mapping !== null) {
        if (before.kind !== context.agent || !before.interactiveReady || !initialPrompt && before.nativeSession === null) throw new Error("The original mapped native agent has no confirmed official Session and readiness for this input.");
        const receipt = await mapping.readReceipt(operation);
        if (receipt === null) throw new Error("The original mapped native launch receipt is missing; input remains closed.");
        await verifyMappingProcesses(context, binding, mapping, operation, receipt);
        before = await observation(context, binding, operation);
        verifyInputAgent(before);
        if (before.kind !== context.agent || !initialPrompt && before.nativeSession === null) throw new Error("The original official native identity changed before input.");
      }
      // Recheck task authority after the asynchronous native ownership checks.
      if (beforeSubmit !== undefined && !await beforeSubmit(operation)) return { submission: "skipped", observation: before };
      operation.check();
    } catch (cause) {
      if (cause instanceof HerdrInputBlockedError) throw cause;
      throw new HerdrAgentActionError(cause instanceof Error ? cause.message : "The original native agent input readiness could not be verified.", "agent.prompt", "not-submitted", { cause, promptSubmission: "not-submitted" });
    }
    if (initialPrompt && mapping !== null) {
      try { await publishOwnedJson(mappingFiles(mapping.manifestPath).initialInput, { nonce: mapping.nonce, selectionKey: mapping.selectionKey, binding }); }
      catch (cause) { throw new HerdrAgentActionError("The original mapped initial input has already been reserved or its durable outcome is unknown; it cannot be repeated.", "agent.prompt", "unknown", { cause, promptSubmission: "unknown" }); }
    }
    const result = await mutation("agent.prompt", { target: binding.paneId, text: prompt }, "agent_prompted", operation);
    try {
      const returned = object(result.agent, "Prompt agent receipt");
      if (returned.pane_id !== binding.paneId || returned.terminal_id !== binding.terminalId || returned.workspace_id !== binding.workspaceId) throw new Error("The prompt receipt does not identify the original task agent.");
    } catch (cause) { throw new HerdrAgentActionError("The prompt receipt could not identify the original task agent.", "agent.prompt", "unknown", { cause, promptSubmission: "unknown" }); }
    return { submission: "submitted", observation: before };
  };
  const launch = async (context: HerdrExecutionContext, binding: HerdrTaskBinding, input: HerdrAgentLaunchInput, operation: Operation): Promise<{ observation: HerdrAgentObservation; started: boolean }> => {
    if (input.configuration.agent !== context.agent) throw new TypeError("The agent configuration differs from the execution identity.");
    const cwd = path.normalize(await realpath(context.cwd));
    const args = buildHerdrAgentArguments(input.configuration, cwd, input.resumeSessionId);
    const before = await observation(context, binding, operation);
    if (before.kind !== null || before.launchPending || before.interactiveReady) return { observation: before, started: false };
    const mapping = await mappingFor(context, operation);
    if (input.configuration.toolLaunch !== undefined && (mapping === null || mapping.selectionKey !== input.configuration.toolLaunch.selectionKey) || options.toolMapping !== undefined && context.agent !== "claude" && mapping === null) throw new HerdrAgentActionError("The prepared Herdr mapping does not identify the original selected native tool.", "agent.start", "not-submitted");
    await options.preflight.verifyStart({ context, configuration: input.configuration, ...(input.resumeSessionId === undefined ? {} : { resumeSessionId: input.resumeSessionId }) }, operation);
    const nativeEnvironment = options.nativeEnvironment ?? workspaceEnvironment;
    if (context.agent === "codex" && nativeEnvironment.PATH !== undefined) {
      const effective = options.readCodexConfig
        ? await options.readCodexConfig(args, cwd, operation, input.configuration.toolLaunch)
        : await readCodexConfiguration({ args, cwd, environment: { ...process.env, ...nativeEnvironment }, ...(input.configuration.toolLaunch === undefined ? {} : { toolLaunch: input.configuration.toolLaunch }) }, operation);
      const overrides = codexAgentCliOverrides({ ...workspaceEnvironment, PATH: nativeEnvironment.PATH }, effective);
      for (const [key, value] of Object.entries(overrides)) args.push("-c", `${key}=${JSON.stringify(value)}`);
    }
    const started = await startNative(context, binding, cwd, args, operation, input);
    const acknowledged = object(started.agent, "Started native agent");
    const argv = array(started.argv, "Native launch arguments");
    const expectedArgv = [context.agent, ...args];
    if (acknowledged.pane_id !== binding.paneId || acknowledged.terminal_id !== binding.terminalId || acknowledged.workspace_id !== binding.workspaceId || argv.length !== expectedArgv.length || argv.some((value, index) => value !== expectedArgv[index])) throw new HerdrAgentActionError("The native start result differs from the requested target or arguments.", "agent.start", "unknown");
    try {
      while (true) {
        const current = await observation(context, binding, operation);
        if (input.resumeSessionId !== undefined && current.nativeSession !== null && current.nativeSession.sessionId !== canonicalId(input.resumeSessionId)) throw new HerdrAgentActionError("The resumed agent reported a different native session.", "agent.start", "unknown");
        if (current.status === "blocked" || (!current.launchPending && current.interactiveReady && (current.kind === context.agent || current.nativeSession?.agent === context.agent || current.name === herdrExecutionAgentName(context)))) {
          const mapping = await mappingFor(context, operation);
          if (mapping !== null) {
            try {
              const receipt = await mapping.verifyReceipt(args, operation);
              if (current.kind !== context.agent || current.launchPending || !current.interactiveReady) throw new Error("The original selected native tool has no official kind readiness.");
              await verifyMappingProcesses(context, binding, mapping, operation, receipt);
            }
            catch (cause) { throw new HerdrAgentActionError("The selected native tool launch could not be confirmed by its original receipt.", "agent.start", "unknown", { cause }); }
          }
          return { observation: current, started: true };
        }
        await wait(operation);
      }
    } catch (cause) {
      if (cause instanceof HerdrAgentActionError) throw cause;
      throw new HerdrAgentActionError("The native process could not become ready before its first input.", "agent.prompt", "not-submitted", { cause, promptSubmission: "not-submitted" });
    }
  };
  const confirmInitialSession = async (context: HerdrExecutionContext, binding: HerdrTaskBinding, operation: Operation, expectedSession?: string): Promise<HerdrAgentObservation> => {
    // SessionStart may be emitted on the first input rather than process launch.
    // https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/session/turn.rs#L340-L342
    const mapping = await mappingFor(context, operation);
    let originalSession = expectedSession === undefined ? undefined : canonicalId(expectedSession);
    let receiptIdentity: string | undefined, firstTermination: WindowsProcessProofError | undefined;
    const readOriginalReceipt = async (): Promise<HerdrToolLaunchReceipt> => {
      const receipt = await mapping!.readReceipt(operation);
      if (receipt === null) throw new Error("The original native launch receipt disappeared before Session confirmation.");
      const identity = JSON.stringify(receipt);
      if (receiptIdentity !== undefined && identity !== receiptIdentity) throw new Error("The original native launch receipt changed during Session confirmation.");
      receiptIdentity = identity;
      return receipt;
    };
    try {
      while (true) {
        const current = await observation(context, binding, operation);
        if (current.nativeSession !== null) {
          if (originalSession === undefined) originalSession = current.nativeSession.sessionId;
          if (current.nativeSession.sessionId !== originalSession) throw new Error("The original native identity differs from the requested session.");
          if (mapping !== null) {
            const originalReceipt = await readOriginalReceipt();
            try { await verifyMappingProcesses(context, binding, mapping, operation, originalReceipt); }
            catch (cause) {
              // A sampled descendant can exit while its command line is read.
              // Reobserve the complete original chain without resubmitting input.
              if (process.platform !== "win32" || !(cause instanceof WindowsProcessProofError) || cause.domain !== "NTSTATUS" || cause.stage !== "command-line" || (cause.code >>> 0) !== 0xc000010a) throw cause;
              firstTermination ??= cause;
              await wait(operation);
              continue;
            }
            const confirmed = await observation(context, binding, operation);
            if (confirmed.nativeSession?.sessionId !== originalSession) throw new Error("The original official Session identity changed during native process confirmation.");
            await readOriginalReceipt();
            operation.check();
            return confirmed;
          }
          return current;
        }
        if (current.status === "blocked") {
          if (mapping !== null) throw new Error("The original official hook did not confirm the native Session before blocking.");
          return current;
        }
        await wait(operation);
      }
    } catch (cause) {
      if (mapping === null) throw cause;
      const failure = firstTermination === undefined || cause === firstTermination ? cause : new AggregateError([firstTermination, cause], "The original native Session confirmation failed after a process exited during observation.", { cause: firstTermination });
      throw new HerdrAgentActionError("The initial input was submitted but its original official native Session could not be confirmed; input cannot be repeated.", "agent.prompt", "unknown", { cause: failure, promptSubmission: "submitted" });
    }
  };
  return {
    observeExecutionStop: async (target: CleanupTarget, operation: Operation): Promise<StopObservation> => {
      try {
        operation.check();
        if (target.worktreeId === undefined) throw new Error("The original Herdr worktree identity is missing.");
        const owner = { ...target, worktreeId: target.worktreeId }, id = resourceOwnerKey(owner);
        const stoppedBinding = stoppedRuns.get(id);
        const active = activeBindings.get(id);
        const binding = stoppedBinding ?? active?.binding;
        if (binding === undefined) throw new LegacyBindingUnavailableError("No original legacy Herdr binding exists in this Worker run.");
        if ([...stoppingProcesses.values()].some(pending => sameResourceOwner(pending.context, owner))) throw new Error("The original Herdr stop has not joined.");
        const data = await snapshot(operation);
        if ([...stoppingProcesses.values()].some(pending => sameResourceOwner(pending.context, owner))) throw new Error("The original Herdr stop has not joined.");
        if (stoppedBinding !== undefined) {
          if (stoppedRuns.get(id) !== stoppedBinding) throw new ExecutionSourceConflictError("The original Herdr binding changed during observation.");
          if (data.workspaces.some(workspace => workspace.workspace_id === binding.workspaceId || matchesWorkspaceOwner(workspace, owner)) || [...data.panes, ...data.agents].some(value => value.workspace_id === binding.workspaceId || value.pane_id === binding.paneId || value.terminal_id === binding.terminalId)) throw new ExecutionSourceConflictError("The original Herdr binding is still present or conflicts with another resource.");
          return { kind: "stopped", execution: { owner, backend: "herdr-legacy", runKey: runKey(binding) }, observedAt: Date.now() };
        }
        if (activeBindings.get(id) !== active || stoppedRuns.has(id)) throw new ExecutionSourceConflictError("The original Herdr binding changed during observation.");
        const workspaces = data.workspaces.filter(workspace => workspace.workspace_id === binding.workspaceId || matchesWorkspaceOwner(workspace, owner));
        const panes = data.panes.filter(pane => pane.pane_id === binding.paneId || pane.terminal_id === binding.terminalId);
        if (workspaces.length === 0 || panes.length === 0) throw new Error("The original Herdr binding is missing; stop is unconfirmed.");
        if (workspaces.length !== 1 || workspaces[0]!.workspace_id !== binding.workspaceId || !matchesWorkspaceOwner(workspaces[0]!, owner)
          || panes.length !== 1 || panes[0]!.pane_id !== binding.paneId || panes[0]!.terminal_id !== binding.terminalId || panes[0]!.workspace_id !== binding.workspaceId)
          throw new ExecutionSourceConflictError("The original Herdr workspace or pane identity conflicts.");
        const agents = data.agents.filter(agent => agent.pane_id === binding.paneId || agent.terminal_id === binding.terminalId);
        if (agents.length > 1 || agents.some(agent => agent.pane_id !== binding.paneId || agent.terminal_id !== binding.terminalId || agent.workspace_id !== binding.workspaceId))
          throw new ExecutionSourceConflictError("The original Herdr agent identity conflicts.");
        const info = agents[0] ?? panes[0]!;
        if (info.agent != null && info.agent !== active!.agent || info.name != null && info.name !== herdrExecutionAgentName(owner))
          throw new ExecutionSourceConflictError("The original Herdr agent identity conflicts.");
        if (info.agent == null && info.launch_pending !== true && info.interactive_ready !== true) throw new Error("The original Herdr agent is not known to be running.");
        return { kind: "running", execution: { owner, backend: "herdr-legacy", runKey: runKey(binding) }, observedAt: Date.now() };
      } catch (error) {
        operation.check();
        return { kind: "unknown", target, error, observedAt: Date.now() };
      }
    },
    pendingStops: (): readonly HerdrPendingStop[] => [...stoppingProcesses.values()].map(({ context, binding }) => ({ context: { ...context }, binding: { ...binding } })),
    listResources: async (operation: Operation): Promise<HerdrOwnedWorkspace[]> => {
      const data = await snapshot(operation);
      const result: HerdrOwnedWorkspace[] = [];
      const identities = new Set<string>();
      const workspaceIds = new Set<string>();
      for (const workspace of data.workspaces) {
        if (typeof workspace.label !== "string") throw new TypeError("The Herdr workspace label must be a string.");
        const label = workspace.label;
        const owner = parseHerdrExecutionLabel(label);
        if (owner === null) continue;
        const workspaceId = text(workspace.workspace_id, "Owned workspace ID");
        const identity = resourceOwnerKey(owner);
        if (identities.has(identity) || workspaceIds.has(workspaceId) || data.workspaces.filter((value) => value.workspace_id === workspaceId).length !== 1) throw new Error("Owned Herdr workspaces have duplicate identities or IDs.");
        identities.add(identity); workspaceIds.add(workspaceId);
        const resource: HerdrOwnedWorkspace = { owner, workspaceId, panes: [] };
        for (const pane of data.panes.filter((value) => value.workspace_id === workspaceId)) {
          const paneId = text(pane.pane_id, "Owned pane ID");
          const terminalId = text(pane.terminal_id, "Owned terminal ID");
          if (data.panes.filter((value) => value.pane_id === paneId || value.terminal_id === terminalId).length !== 1) throw new Error("Owned Herdr panes have ambiguous pane or terminal IDs.");
          const agents = data.agents.filter((value) => value.pane_id === paneId);
          if (agents.length > 1) throw new Error("An owned Herdr pane has multiple agent observations.");
          const info = agents[0] === undefined ? pane : agents[0];
          if (info.workspace_id !== workspaceId || info.terminal_id !== terminalId) throw new Error("The owned Herdr agent association is inconsistent.");
          const cwd = optionalText(info.cwd, "Owned pane cwd");
          if (cwd !== null && !path.isAbsolute(cwd)) throw new TypeError("The owned Herdr pane cwd must be absolute.");
          const kind = optionalText(info.agent, "Owned agent kind");
          if (kind !== null && kind !== "codex" && kind !== "copilot" && kind !== "claude") throw new Error("The owned task workspace hosts an unsupported native agent.");
          const native = info.agent_session === undefined ? null : object(info.agent_session, "Owned native session");
          const nativeAgent = native === null ? null : text(native.agent, "Owned native provider");
          if (nativeAgent !== null && nativeAgent !== "codex" && nativeAgent !== "copilot" && nativeAgent !== "claude") throw new Error("The owned native reference has an unsupported provider.");
          if (kind !== null && nativeAgent !== null && kind !== nativeAgent) throw new Error("The owned agent and native history provider differ.");
          const status = text(info.agent_status, "Owned agent status");
          if (!["idle", "working", "blocked", "done", "unknown"].includes(status)) throw new TypeError("The owned native status is invalid.");
          const name = optionalText(info.name, "Owned agent name");
          if (name !== null && name !== herdrExecutionAgentName(owner)) throw new Error("The owned Herdr pane has a foreign managed agent name.");
          resource.panes.push({ binding: { session, workspaceId, paneId, terminalId }, cwd, kind, status, launchPending: optionalBoolean(info.launch_pending, "Owned launch state"), interactiveReady: optionalBoolean(info.interactive_ready, "Owned readiness"), nativeSession: nativeAgent === null ? null : nativeReference(info.agent_session, nativeAgent), stateChangeSeq: agents[0] === undefined ? null : counter(info.state_change_seq, "Owned state-change sequence"), completionSeq: agents[0] === undefined || info.completion_seq === undefined ? null : counter(info.completion_seq, "Owned completion sequence") });
        }
        if (resource.panes.length === 0) throw new Error("The owned Herdr workspace has no associated panes.");
        for (const agent of data.agents.filter((value) => value.workspace_id === workspaceId)) {
          if (!resource.panes.some((value) => value.binding.paneId === agent.pane_id && value.binding.terminalId === agent.terminal_id)) throw new Error("The owned Herdr workspace has an unassociated native agent.");
        }
        result.push(resource);
      }
      return result;
    },
    prepareWorkspace: async (context: HerdrExecutionContext, title: string, operation: Operation, startup?: { shellNonce?: string; canAdmitNewExecution?: () => boolean }): Promise<HerdrTaskBinding> => {
      if ([...stoppingProcesses.values()].some(pending => sameResourceOwner(pending.context, context))) throw new Error("The original Herdr stop remains unconfirmed; a replacement workspace cannot start.");
      stoppedRuns.delete(resourceOwnerKey(context));
      activeBindings.delete(resourceOwnerKey(context));
      if (startup?.shellNonce !== undefined && canonicalId(startup.shellNonce) !== startup.shellNonce) throw new TypeError("The managed shell startup nonce must be a canonical UUID.");
      let createPossible = false;
      try {
        const label = herdrExecutionLabel(context, title);
        const data = await snapshot(operation);
        const matching = data.workspaces.filter((workspace) => matchesWorkspaceOwner(workspace, context));
        if (matching.length > 1) throw new Error("The task workspace identity is duplicated.");
        if (matching.length === 1) {
          const workspaceId = text(matching[0]!.workspace_id, "Task workspace ID");
          const panes = data.panes.filter((pane) => pane.workspace_id === workspaceId);
          if (panes.length !== 1) throw new Error("The existing task workspace has ambiguous panes; it was retained.");
          const pane = panes[0]!;
          let binding = { session, workspaceId, paneId: text(pane.pane_id, "Task pane ID"), terminalId: text(pane.terminal_id, "Task terminal ID") };
          const mapping = await mappingFor(context, operation);
          if (mapping?.windowsCommand !== undefined) binding = await prepareWindowsRoot(context, binding, mapping, operation, false);
          await readOwned(context, binding, operation);
          activeBindings.set(resourceOwnerKey(context), { binding, agent: context.agent });
          return binding;
        }
        const mapping = await mappingFor(context, operation, false);
        assertConfigurationAdmission(startup?.canAdmitNewExecution);
        createPossible = true;
        const shellNonce = startup?.shellNonce ?? (mapping?.windowsCommand === undefined ? mapping?.nonce : undefined);
        const result = await mutation("workspace.create", { cwd: context.cwd, focus: false, label, env: { ...workspaceEnvironment, ...mapping?.environment, ...nativeAgentPermissionEnvironment(context.agent), ...(shellNonce === undefined ? {} : { DAYNIGHT_HERDR_SHELL_NONCE: shellNonce }) } }, "workspace_created", operation);
        const workspace = object(result.workspace, "Created workspace");
        const pane = object(result.root_pane, "Created task pane");
        let binding = { session, workspaceId: text(workspace.workspace_id, "Created workspace ID"), paneId: text(pane.pane_id, "Created pane ID"), terminalId: text(pane.terminal_id, "Created terminal ID") };
        if (mapping?.windowsCommand !== undefined) binding = await prepareWindowsRoot(context, binding, mapping, operation, true);
        else if (mapping !== null) {
          const result = expectedResult(await options.rpc.request("pane.process_info", { pane_id: binding.paneId }, operation), "pane_process_info"), info = object(result.process_info, "Mapped Bash process");
          if (info.pane_id !== binding.paneId) throw new Error("The mapped Bash process belongs to another pane.");
          if (startup === undefined) await mapping.verifyReady(pid(info.shell_pid), operation);
          else await mapping.verifyReady(pid(info.shell_pid), operation, startup.shellNonce);
        }
        await readOwned(context, binding, operation);
        if (mapping !== null) {
          const result = expectedResult(await options.rpc.request("pane.process_info", { pane_id: binding.paneId }, operation), "pane_process_info"), info = object(result.process_info, "Prepared original shell process");
          if (info.pane_id !== binding.paneId) throw new Error("The prepared shell process belongs to another pane.");
          const captureRemainingMs = diagnosticRemainingMs(operation);
          try { await mapping.captureProcesses([pid(info.shell_pid)], operation); }
          catch (cause) {
            if (mapping.windowsCommand === undefined || cause instanceof HerdrAgentActionError) throw cause;
            throw new Error(`The original PowerShell process capture phase failed (startedRemainingMs=${captureRemainingMs}, remainingMs=${diagnosticRemainingMs(operation)}).`, { cause });
          }
        }
        activeBindings.set(resourceOwnerKey(context), { binding, agent: context.agent });
        return binding;
      } catch (cause) {
        if (cause instanceof ConfigurationAdmissionWaiting || cause instanceof HerdrAgentActionError) throw cause;
        throw new HerdrAgentActionError(cause instanceof Error ? cause.message : "The task workspace could not be prepared.", "workspace.create", createPossible ? "unknown" : "not-submitted", { cause });
      }
    },
    syncWorkspaceName: (context: HerdrExecutionContext, binding: HerdrTaskBinding, title: string, operation: Operation): Promise<void> => serialized(binding.workspaceId, operation, async () => {
      const label = herdrExecutionLabel(context, title);
      const before = await readNameOwnership(context, binding, operation, "not-submitted");
      if (before.workspace.label === label) return;
      const renamed = await mutation("workspace.rename", { workspace_id: binding.workspaceId, label }, "workspace_info", operation);
      let workspace: RecordValue;
      try {
        workspace = object(renamed.workspace, "Renamed workspace");
        text(workspace.workspace_id, "Renamed workspace ID");
        text(workspace.label, "Renamed workspace label");
      } catch (cause) { throw new HerdrAgentActionError("The workspace rename receipt could not be decoded.", "workspace.rename", "unknown", { cause }); }
      if (workspace.workspace_id !== binding.workspaceId || !matchesWorkspaceOwner(workspace, context)) throw new Error("The workspace name receipt has different resource ownership.");
      const after = await readNameOwnership(context, binding, operation, "unknown");
      if (workspace.label !== label || after.workspace.label !== label) throw new HerdrAgentActionError("The requested workspace name was not confirmed by the current snapshot.", "workspace.rename", "unknown");
    }),
    observe: (context: HerdrExecutionContext, binding: HerdrTaskBinding, operation: Operation, _onAttached?: () => void) => observation(context, binding, operation),
    /** Launches only; the caller must persist original process identity before submitting input. */
    launch: (context: HerdrExecutionContext, binding: HerdrTaskBinding, input: HerdrAgentLaunchInput, operation: Operation): Promise<HerdrAgentObservation> => serialized(binding.workspaceId, operation, async () => (await launch(context, binding, input, operation)).observation),
    launchReceipt: async (context: HerdrExecutionContext, binding: HerdrTaskBinding, operation: Operation): Promise<HerdrToolLaunchReceipt | null> => {
      await readOwned(context, binding, operation);
      return await (await mappingFor(context, operation))?.readReceipt(operation) ?? null;
    },
    processInfo: async (context: HerdrExecutionContext, binding: HerdrTaskBinding, operation: Operation): Promise<{ shellPid: number; foregroundPids: number[] }> => {
      await readOwned(context, binding, operation);
      const result = expectedResult(await options.rpc.request("pane.process_info", { pane_id: binding.paneId }, operation), "pane_process_info");
      const info = object(result.process_info, "Native process observation");
      if (info.pane_id !== binding.paneId) throw new Error("The native process observation belongs to another pane.");
      const shellPid = pid(info.shell_pid);
      const foregroundPids = (info.foreground_processes === undefined ? [] : array(info.foreground_processes, "Native foreground processes")).map(value => pid(object(value, "Native foreground process").pid));
      await readOwned(context, binding, operation);
      return { shellPid, foregroundPids };
    },
    submitInitialPrompt: (context: HerdrExecutionContext, binding: HerdrTaskBinding, prompt: string, operation: Operation, beforeSubmit?: HerdrPromptGuard, onTransportCompleted?: () => void): Promise<HerdrPromptResult> => serialized(binding.workspaceId, operation, async () => {
      const result = await submit(context, binding, prompt, operation, true, beforeSubmit);
      if (result.submission === "submitted") {
        try { onTransportCompleted?.(); } catch { /* Optional observation cannot alter input. */ }
        if (await mappingFor(context, operation) !== null) await confirmInitialSession(context, binding, operation, result.observation.nativeSession?.sessionId);
      }
      return result;
    }),
    start: (context: HerdrExecutionContext, binding: HerdrTaskBinding, input: HerdrAgentStartInput, operation: Operation): Promise<HerdrAgentObservation> => serialized(binding.workspaceId, operation, async () => {
      if (typeof input.prompt !== "string" || input.prompt.length === 0) throw new TypeError("The startup prompt must be nonempty text.");
      const launched = await launch(context, binding, input, operation);
      if (!launched.started) {
        if (await mappingFor(context, operation) !== null && launched.observation.nativeSession === null) throw new HerdrAgentActionError("The original mapped native launch has no official Session confirmation; input cannot be repeated.", "agent.start", "unknown");
        try { input.onExistingAgentObserved?.(); } catch { /* Optional observation cannot alter launch. */ } return launched.observation;
      }
      try { input.onAgentStarted?.(); } catch { /* Optional observation cannot alter launch. */ }
      if (launched.observation.status === "blocked") throw new HerdrAgentActionError("The native agent requires operator action before its first input.", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" });
      try { input.onPromptSubmitting?.(); } catch { /* Optional observation cannot alter input. */ }
      const receipt = await submit(context, binding, input.prompt, operation, true);
      if (receipt.submission === "submitted") {
        try { input.onPromptTransportCompleted?.(); } catch { /* Optional observation cannot alter input. */ }
        input.onPromptSubmitted?.(receipt);
      }
      return await confirmInitialSession(context, binding, operation, input.resumeSessionId ?? receipt.observation.nativeSession?.sessionId);
    }),
    submitPrompt: (context: HerdrExecutionContext, binding: HerdrTaskBinding, prompt: string, operation: Operation, beforeSubmit?: HerdrPromptGuard, onTransportCompleted?: () => void) => serialized(binding.workspaceId, operation, async () => { const result = await submit(context, binding, prompt, operation, false, beforeSubmit); if (result.submission === "submitted") try { onTransportCompleted?.(); } catch { /* Optional observation cannot alter input. */ } return result; }),
    stopAndClose: (context: HerdrExecutionOwner & { cwd: string }, binding: HerdrTaskBinding, operation: Operation): Promise<void> => serialized(binding.workspaceId, operation, async () => {
      if (binding.session !== session) throw new Error("The task binding belongs to another Herdr session.");
      const before = await snapshot(operation);
      const identity = resourceOwnerKey(context);
      const key = JSON.stringify([binding.session, binding.workspaceId, identity]);
      const matching = before.workspaces.filter((workspace) => workspace.workspace_id === binding.workspaceId || matchesWorkspaceOwner(workspace, context));
      const existing = stoppingProcesses.get(key);
      if (existing !== undefined && (existing.binding.session !== binding.session || existing.binding.workspaceId !== binding.workspaceId || existing.binding.paneId !== binding.paneId || existing.binding.terminalId !== binding.terminalId)) throw new Error("The pending stop belongs to a different original binding.");
      if (matching.length === 0) {
        if ([...before.panes, ...before.agents].some((resource) => resource.workspace_id === binding.workspaceId || resource.pane_id === binding.paneId || resource.terminal_id === binding.terminalId)) throw new Error("The missing task workspace still has associated resources.");
        const original = stoppingProcesses.get(key);
        await finishStop(key, operation);
        if (original?.originalBindingObserved) { await original.mapping?.retire(operation); stoppingProcesses.delete(key); mappings.delete(identity); activeBindings.delete(identity); stoppedRuns.set(identity, { ...binding }); }
        return;
      }
      if (matching.length !== 1 || matching[0]!.workspace_id !== binding.workspaceId || !matchesWorkspaceOwner(matching[0]!, context)) throw new Error("The task workspace identity changed before stopping.");
      const currentPanes = before.panes.filter((pane) => pane.workspace_id === binding.workspaceId);
      // Closing removes discovery evidence before all processes necessarily exit.
      // Retain this process-local responsibility across failed close/wait calls.
      let pending = stoppingProcesses.get(key);
      if (pending === undefined) {
        pending = { context: { ...context }, binding: { ...binding }, processIds: new Set<number>(), originalBindingObserved: false };
        stoppingProcesses.set(key, pending);
      }
      let originalBindingObserved = false;
      for (const pane of currentPanes) {
        const paneId = text(pane.pane_id, "Stop pane ID");
        if (paneId === binding.paneId && pane.terminal_id !== binding.terminalId) throw new Error("The task terminal identity changed before stopping.");
        if (paneId === binding.paneId && pane.terminal_id === binding.terminalId) originalBindingObserved = true;
        const result = expectedResult(await options.rpc.request("pane.process_info", { pane_id: paneId }, operation), "pane_process_info");
        const info = object(result.process_info, "Current stop process observation");
        if (info.pane_id !== paneId) throw new Error("The stop process observation belongs to another pane.");
        pending.processIds.add(pid(info.shell_pid));
        const foreground = info.foreground_processes === undefined ? [] : array(info.foreground_processes, "Current foreground processes");
        for (const entry of foreground) pending.processIds.add(pid(object(entry, "Current foreground process").pid));
      }
      pending.originalBindingObserved ||= originalBindingObserved;
      const observedAgent = activeBindings.get(identity)?.agent ?? [...currentPanes, ...before.agents.filter(value => value.pane_id === binding.paneId), context].map(value => (value as RecordValue).agent).find(value => value === "codex" || value === "copilot" || value === "claude");
      const mapping = await stopMappingFor(context, operation, observedAgent as WorkerAgent | undefined);
      if (mapping !== null) {
        pending.mapping = mapping;
        const receipt = await mapping.readReceipt(operation);
        if (receipt !== null) { pending.processIds.add(receipt.helperPid); pending.processIds.add(receipt.childPid); }
        for (const id of await mapping.captureProcesses([...pending.processIds], operation, true)) pending.processIds.add(id);
      }
      try {
        await mutation("workspace.close", { workspace_id: binding.workspaceId, close_group: false }, "ok", operation);
        const after = await snapshot(operation);
        if (after.workspaces.some((workspace) => workspace.workspace_id === binding.workspaceId || matchesWorkspaceOwner(workspace, context)) || [...after.panes, ...after.agents].some((resource) => resource.workspace_id === binding.workspaceId)) throw new HerdrAgentActionError("The task workspace still exists after closure.", "workspace.close", "unknown");
        await finishStop(key, operation);
        if (pending.originalBindingObserved) { await mapping?.retire(operation); stoppingProcesses.delete(key); mappings.delete(identity); activeBindings.delete(identity); stoppedRuns.set(identity, { ...binding }); }
      } catch (cause) { await mapping?.releaseFrozen(); throw cause; }
    }),
  };
};
export type HerdrAgentManager = ReturnType<typeof createHerdrAgentManager>;
