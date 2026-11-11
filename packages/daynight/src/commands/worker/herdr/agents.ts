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
export type HerdrAgentLaunchInput = { configuration: HerdrAgentConfiguration; resumeSessionId?: string; beforeStart?: (operation: Operation) => Promise<void> };
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
export type HerdrWorkspaceEnvironment = Readonly<{ XDG_CONFIG_HOME: string; XDG_STATE_HOME: string; PATH?: string; DN_CONFIG_DIR?: string }>;

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
export class HerdrInputWaitingError extends HerdrAgentActionError {
  constructor(readonly reason: "task_paused" | "control_suspended" | "native_blocked", message: string, options?: ErrorOptions) {
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
  "agent.start": new Set(["invalid_agent_name", "unsupported_agent_kind", "invalid_agent_argument", "invalid_agent_timeout", "agent_pane_not_found", "agent_pane_busy", "agent_pane_unavailable", "agent_name_taken"]),
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

export const createHerdrAgentManager = (options: { rpc: HerdrRpcClient; session: string; preflight: HerdrAgentPreflight; workspaceEnvironment: HerdrWorkspaceEnvironment; readCodexConfig?: (args: readonly string[], cwd: string, operation: Operation) => Promise<unknown>; processExecuting?: (pid: number) => Promise<boolean>; pollIntervalMs?: number }) => {
  const session = text(options.session, "Herdr session");
  const suppliedEnvironment = object(options.workspaceEnvironment, "Task workspace environment");
  const xdgFields = ["XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const;
  const allowedFields = new Set<string>([...xdgFields, "PATH", "DN_CONFIG_DIR"]);
  if (xdgFields.some(field => !Object.hasOwn(suppliedEnvironment, field)) || Object.entries(suppliedEnvironment).some(([field, value]) => !allowedFields.has(field) || typeof value !== "string" || value.includes("\0"))) throw new TypeError("Task workspace environment requires XDG_CONFIG_HOME and XDG_STATE_HOME and permits optional PATH and DN_CONFIG_DIR string values without NUL.");
  const workspaceEnvironment = { ...suppliedEnvironment } as HerdrWorkspaceEnvironment;
  const isExecuting = options.processExecuting === undefined ? processExecuting : options.processExecuting;
  const pollInterval = options.pollIntervalMs === undefined ? 100 : options.pollIntervalMs;
  if (!Number.isSafeInteger(pollInterval) || pollInterval <= 0 || pollInterval > 1000) throw new TypeError("The Herdr observation interval must be between 1 and 1000 milliseconds.");
  const inputTails = new Map<string, Promise<void>>();
  const stoppingProcesses = new Map<string, HerdrPendingStop & { processIds: Set<number>; originalBindingObserved: boolean }>();
  const workerRun = randomUUID();
  const stoppedRuns = new Map<string, HerdrTaskBinding>();
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
    while (true) {
      let running = false;
      for (const processId of pending.processIds) { operation.check(); if (await isExecuting(processId)) running = true; }
      if (!running) { stoppingProcesses.delete(key); return; }
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
  const startNative = async (context: HerdrExecutionContext, binding: HerdrTaskBinding, cwd: string, args: string[], operation: Operation, beforeStart?: HerdrAgentLaunchInput["beforeStart"]): Promise<HerdrRpcResult> => {
    let readiness: { deadline: number; rejection: HerdrAgentActionError } | undefined;
    while (true) {
      operation.check();
      if (readiness !== undefined && performance.now() >= readiness.deadline) throw readiness.rejection;
      // A definite rejection authorizes another attempt only after fresh caller admission.
      if (beforeStart !== undefined) await beforeStart(operation);
      operation.check();
      try {
        const { pane } = await readOwned(context, binding, operation);
        const actualCwd = text(pane!.cwd, "Native launch shell cwd");
        if (!path.isAbsolute(actualCwd)) throw new Error("The original task shell cwd must be absolute before native launch.");
        if (path.normalize(await realpath(actualCwd)) !== cwd) throw new Error(`The original task shell cwd is ${actualCwd}; expected ${cwd}. Restore its working directory before starting the native agent.`);
        operation.check();
      } catch (cause) { throw new HerdrAgentActionError(cause instanceof Error ? cause.message : "The original task shell cwd could not be confirmed before native launch.", "agent.start", "not-submitted", { cause }); }
      if (readiness !== undefined && performance.now() >= readiness.deadline) throw readiness.rejection;
      const timeout = Math.floor(Math.min(30_000, operation.remainingMs()));
      if (timeout <= 3000) throw readiness === undefined ? new HerdrAgentActionError("The remaining operation budget cannot start a native agent.", "agent.start", "not-submitted") : readiness.rejection;
      try { return await mutation("agent.start", { name: herdrExecutionAgentName(context), kind: context.agent, pane_id: binding.paneId, args, timeout_ms: timeout }, "agent_started", operation); }
      catch (error) {
        if (!(error instanceof HerdrAgentActionError) || error.submission !== "rejected" || !(error.cause instanceof HerdrRpcError) || error.cause.method !== "agent.start" || error.cause.code !== "agent_pane_busy") throw error;
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
  const submit = async (context: HerdrExecutionContext, binding: HerdrTaskBinding, prompt: string, operation: Operation, initialPrompt = false, beforeSubmit?: HerdrPromptGuard): Promise<HerdrPromptResult> => {
    if (typeof prompt !== "string" || prompt.length === 0) throw new HerdrAgentActionError("The caller prompt must be nonempty text.", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" });
    let before: HerdrAgentObservation;
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
      if (beforeSubmit !== undefined && !await beforeSubmit(operation)) return { submission: "skipped", observation: before };
      operation.check();
    } catch (cause) {
      if (cause instanceof HerdrInputBlockedError) throw cause;
      throw new HerdrAgentActionError(cause instanceof Error ? cause.message : "The original native agent input readiness could not be verified.", "agent.prompt", "not-submitted", { cause, promptSubmission: "not-submitted" });
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
    await options.preflight.verifyStart({ context, configuration: input.configuration, ...(input.resumeSessionId === undefined ? {} : { resumeSessionId: input.resumeSessionId }) }, operation);
    if (context.agent === "codex" && workspaceEnvironment.PATH !== undefined) {
      const effective = options.readCodexConfig
        ? await options.readCodexConfig(args, cwd, operation)
        : await readCodexConfiguration({ args, cwd, environment: { ...process.env, ...workspaceEnvironment } }, operation);
      const overrides = codexAgentCliOverrides({ ...workspaceEnvironment, PATH: workspaceEnvironment.PATH }, effective);
      for (const [key, value] of Object.entries(overrides)) args.push("-c", `${key}=${JSON.stringify(value)}`);
    }
    const started = await startNative(context, binding, cwd, args, operation, input.beforeStart);
    const acknowledged = object(started.agent, "Started native agent");
    const argv = array(started.argv, "Native launch arguments");
    const expectedArgv = [context.agent, ...args];
    if (acknowledged.pane_id !== binding.paneId || acknowledged.terminal_id !== binding.terminalId || acknowledged.workspace_id !== binding.workspaceId || argv.length !== expectedArgv.length || argv.some((value, index) => value !== expectedArgv[index])) throw new HerdrAgentActionError("The native start result differs from the requested target or arguments.", "agent.start", "unknown");
    try {
      while (true) {
        const current = await observation(context, binding, operation);
        if (input.resumeSessionId !== undefined && current.nativeSession !== null && current.nativeSession.sessionId !== canonicalId(input.resumeSessionId)) throw new HerdrAgentActionError("The resumed agent reported a different native session.", "agent.start", "unknown");
        if (current.status === "blocked" || (!current.launchPending && current.interactiveReady && (current.kind === context.agent || current.nativeSession?.agent === context.agent || current.name === herdrExecutionAgentName(context)))) return { observation: current, started: true };
        await wait(operation);
      }
    } catch (cause) {
      if (cause instanceof HerdrAgentActionError) throw cause;
      throw new HerdrAgentActionError("The native process could not become ready before its first input.", "agent.prompt", "not-submitted", { cause, promptSubmission: "not-submitted" });
    }
  };
  return {
    observeExecutionStop: async (target: CleanupTarget, operation: Operation): Promise<StopObservation> => {
      try {
        operation.check();
        if (target.worktreeId === undefined) throw new Error("The original Herdr worktree identity is missing.");
        const owner = { ...target, worktreeId: target.worktreeId }, id = resourceOwnerKey(owner);
        const binding = stoppedRuns.get(id);
        if (binding === undefined) throw new Error("No stop receipt for the original legacy Herdr binding exists in this Worker run.");
        if ([...stoppingProcesses.values()].some(pending => sameResourceOwner(pending.context, owner))) throw new Error("The original Herdr stop has not joined.");
        const data = await snapshot(operation);
        if (data.workspaces.some(workspace => workspace.workspace_id === binding.workspaceId || matchesWorkspaceOwner(workspace, owner)) || [...data.panes, ...data.agents].some(value => value.workspace_id === binding.workspaceId || value.pane_id === binding.paneId || value.terminal_id === binding.terminalId)) throw new ExecutionSourceConflictError("The original Herdr binding is still present or conflicts with another resource.");
        return { kind: "stopped", execution: { owner, backend: "herdr-legacy", runKey: runKey(binding) }, observedAt: Date.now() };
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
    prepareWorkspace: async (context: HerdrExecutionContext, title: string, operation: Operation, startup?: { shellNonce: string }): Promise<HerdrTaskBinding> => {
      stoppedRuns.delete(resourceOwnerKey(context));
      if (startup !== undefined && canonicalId(startup.shellNonce) !== startup.shellNonce) throw new TypeError("The managed shell startup nonce must be a canonical UUID.");
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
          const binding = { session, workspaceId, paneId: text(pane.pane_id, "Task pane ID"), terminalId: text(pane.terminal_id, "Task terminal ID") };
          await readOwned(context, binding, operation);
          return binding;
        }
        createPossible = true;
        const result = await mutation("workspace.create", { cwd: context.cwd, focus: false, label, env: { ...workspaceEnvironment, ...nativeAgentPermissionEnvironment(context.agent), ...(startup === undefined ? {} : { DAYNIGHT_HERDR_SHELL_NONCE: startup.shellNonce }) } }, "workspace_created", operation);
        const workspace = object(result.workspace, "Created workspace");
        const pane = object(result.root_pane, "Created task pane");
        const binding = { session, workspaceId: text(workspace.workspace_id, "Created workspace ID"), paneId: text(pane.pane_id, "Created pane ID"), terminalId: text(pane.terminal_id, "Created terminal ID") };
        await readOwned(context, binding, operation);
        return binding;
      } catch (cause) {
        if (cause instanceof HerdrAgentActionError) throw cause;
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
    submitInitialPrompt: (context: HerdrExecutionContext, binding: HerdrTaskBinding, prompt: string, operation: Operation, beforeSubmit?: HerdrPromptGuard, onTransportCompleted?: () => void): Promise<HerdrPromptResult> => serialized(binding.workspaceId, operation, async () => { const result = await submit(context, binding, prompt, operation, true, beforeSubmit); if (result.submission === "submitted") try { onTransportCompleted?.(); } catch { /* Optional observation cannot alter input. */ } return result; }),
    start: (context: HerdrExecutionContext, binding: HerdrTaskBinding, input: HerdrAgentStartInput, operation: Operation): Promise<HerdrAgentObservation> => serialized(binding.workspaceId, operation, async () => {
      if (typeof input.prompt !== "string" || input.prompt.length === 0) throw new TypeError("The startup prompt must be nonempty text.");
      const launched = await launch(context, binding, input, operation);
      if (!launched.started) { try { input.onExistingAgentObserved?.(); } catch { /* Optional observation cannot alter launch. */ } return launched.observation; }
      try { input.onAgentStarted?.(); } catch { /* Optional observation cannot alter launch. */ }
      if (launched.observation.status === "blocked") throw new HerdrAgentActionError("The native agent requires operator action before its first input.", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" });
      try { input.onPromptSubmitting?.(); } catch { /* Optional observation cannot alter input. */ }
      const receipt = await submit(context, binding, input.prompt, operation, true);
      if (receipt.submission === "submitted") {
        try { input.onPromptTransportCompleted?.(); } catch { /* Optional observation cannot alter input. */ }
        input.onPromptSubmitted?.(receipt);
      }
      // SessionStart may be emitted on the first input rather than process launch.
      // https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/session/turn.rs#L340-L342
      while (true) {
        const current = await observation(context, binding, operation);
        if (current.nativeSession !== null) {
          if (input.resumeSessionId !== undefined && current.nativeSession.sessionId !== canonicalId(input.resumeSessionId)) throw new Error("The resumed native identity differs from the requested session.");
          return current;
        }
        if (current.status === "blocked") return current;
        await wait(operation);
      }
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
        if (original?.originalBindingObserved) stoppedRuns.set(identity, { ...binding });
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
      await mutation("workspace.close", { workspace_id: binding.workspaceId, close_group: false }, "ok", operation);
      const after = await snapshot(operation);
      if (after.workspaces.some((workspace) => workspace.workspace_id === binding.workspaceId || matchesWorkspaceOwner(workspace, context)) || [...after.panes, ...after.agents].some((resource) => resource.workspace_id === binding.workspaceId)) throw new HerdrAgentActionError("The task workspace still exists after closure.", "workspace.close", "unknown");
      await finishStop(key, operation);
      if (pending.originalBindingObserved) stoppedRuns.set(identity, { ...binding });
    }),
  };
};
export type HerdrAgentManager = ReturnType<typeof createHerdrAgentManager>;
