import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { Operation } from "../../../api/operation.js";
import { canonicalId } from "../../../api/parse.js";
import type { WorkerAgent } from "../../../api/types.js";
import { normalizeServerUrl } from "../../../config/server.js";
import { buildHerdrAgentArguments, validateHerdrAgentArguments } from "./arguments.js";
import type { HerdrAgentConfiguration } from "./arguments.js";
import { codexInputSurface } from "./codex-input.js";
import { HerdrRpcError } from "./rpc.js";
import type { HerdrRpcClient, HerdrRpcResult } from "./rpc.js";

export type { HerdrAgentConfiguration } from "./arguments.js";
export { buildHerdrAgentArguments, validateHerdrAgentArguments } from "./arguments.js";
export type HerdrExecutionContext = { serverOrigin: string; projectId: string; taskId: string; claimId: string; worktreeId: string; cwd: string; agent: WorkerAgent };
export type HerdrExecutionOwner = Pick<HerdrExecutionContext, "serverOrigin" | "projectId" | "taskId" | "claimId" | "worktreeId">;
export type HerdrTaskBinding = { session: string; workspaceId: string; paneId: string; terminalId: string };
export type HerdrNativeReference = { source: string; agent: WorkerAgent; sessionId: string };
export type HerdrAgentObservation = { binding: HerdrTaskBinding; kind: string | null; name: string | null; status: string; launchPending: boolean; interactiveReady: boolean; nativeSession: HerdrNativeReference | null; stateChangeSeq: number | null; completionSeq: number | null };
export type HerdrOwnedWorkspace = { owner: HerdrExecutionOwner; workspaceId: string; panes: { binding: HerdrTaskBinding; cwd: string | null; kind: WorkerAgent | null; status: string; launchPending: boolean; interactiveReady: boolean; nativeSession: HerdrNativeReference | null; stateChangeSeq: number | null; completionSeq: number | null }[] };
export type HerdrAgentPreflight = { verifyStart(input: { context: HerdrExecutionContext; configuration: HerdrAgentConfiguration; resumeSessionId?: string }, operation: Operation): Promise<unknown> };
export type HerdrWorkspaceEnvironment = Readonly<{ XDG_CONFIG_HOME: string; XDG_STATE_HOME: string }>;

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
const expectedResult = (value: HerdrRpcResult, type: string): HerdrRpcResult => { if (value.type !== type) throw new TypeError(`Expected Herdr ${type} result; received ${value.type}.`); return value; };
const contextIdentity = (context: HerdrExecutionOwner) => {
  const identifier = (value: string, label: string): string => { const result = canonicalId(value); if (result === null) throw new TypeError(`${label} must be a UUID.`); return result; };
  return { serverOrigin: normalizeServerUrl(context.serverOrigin), projectId: identifier(context.projectId, "Project ID"), taskId: identifier(context.taskId, "Task ID"), claimId: identifier(context.claimId, "Claim ID"), worktreeId: identifier(context.worktreeId, "Worktree ID") };
};
export const herdrExecutionLabel = (context: HerdrExecutionOwner): string => `daynight:${JSON.stringify(contextIdentity(context))}`;
export const herdrExecutionAgentName = (context: HerdrExecutionOwner): string => `dn_${createHash("sha256").update(herdrExecutionLabel(context)).digest("hex").slice(0, 24)}`;
export const parseHerdrExecutionLabel = (label: string): HerdrExecutionOwner | null => {
  if (!label.startsWith("daynight:")) return null;
  const data = object(JSON.parse(label.slice("daynight:".length)) as unknown, "Herdr execution label");
  const fields = ["serverOrigin", "projectId", "taskId", "claimId", "worktreeId"];
  if (Object.keys(data).length !== fields.length || fields.some((field) => !Object.hasOwn(data, field))) throw new TypeError("The reserved Herdr execution label has invalid fields.");
  const owner = { serverOrigin: normalizeServerUrl(text(data.serverOrigin, "Label server origin")), projectId: text(data.projectId, "Label project ID"), taskId: text(data.taskId, "Label task ID"), claimId: text(data.claimId, "Label claim ID"), worktreeId: text(data.worktreeId, "Label worktree ID") };
  for (const value of [owner.projectId, owner.taskId, owner.claimId, owner.worktreeId]) if (canonicalId(value) !== value) throw new TypeError("Reserved Herdr label identifiers must be canonical UUIDs.");
  if (`daynight:${JSON.stringify(owner)}` !== label) throw new TypeError("The reserved Herdr execution label must use its canonical identity encoding.");
  return owner;
};

export class HerdrAgentActionError extends Error {
  readonly promptSubmission: "not-submitted" | "submitted" | "unknown" | null;
  constructor(message: string, readonly action: string, readonly submission: "not-submitted" | "rejected" | "unknown", options?: ErrorOptions & { promptSubmission?: "not-submitted" | "submitted" | "unknown" }) {
    super(message, options); this.name = "HerdrAgentActionError";
    this.promptSubmission = options?.promptSubmission === undefined ? null : options.promptSubmission;
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

export const createHerdrAgentManager = (options: { rpc: HerdrRpcClient; session: string; preflight: HerdrAgentPreflight; workspaceEnvironment: HerdrWorkspaceEnvironment; processExecuting?: (pid: number) => Promise<boolean>; pollIntervalMs?: number }) => {
  const session = text(options.session, "Herdr session");
  const suppliedEnvironment = object(options.workspaceEnvironment, "Task workspace environment");
  const xdgFields = ["XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const;
  if (Object.keys(suppliedEnvironment).length !== xdgFields.length || xdgFields.some((field) => !Object.hasOwn(suppliedEnvironment, field) || typeof suppliedEnvironment[field] !== "string" || suppliedEnvironment[field].includes("\0"))) throw new TypeError("Task workspace environment must contain only XDG_CONFIG_HOME and XDG_STATE_HOME string values without NUL.");
  const workspaceEnvironment = { XDG_CONFIG_HOME: suppliedEnvironment.XDG_CONFIG_HOME as string, XDG_STATE_HOME: suppliedEnvironment.XDG_STATE_HOME as string };
  const isExecuting = options.processExecuting === undefined ? processExecuting : options.processExecuting;
  const pollInterval = options.pollIntervalMs === undefined ? 100 : options.pollIntervalMs;
  if (!Number.isSafeInteger(pollInterval) || pollInterval <= 0 || pollInterval > 1000) throw new TypeError("The Herdr observation interval must be between 1 and 1000 milliseconds.");
  const inputTails = new Map<string, Promise<void>>();
  const stoppingProcesses = new Map<string, Set<number>>();
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
  const wait = (operation: Operation): Promise<void> => new Promise((resolve, reject) => {
    operation.check();
    const abort = (): void => { clearTimeout(timer); operation.signal.removeEventListener("abort", abort); reject(operation.signal.reason); };
    const timer = setTimeout(() => { operation.signal.removeEventListener("abort", abort); resolve(); }, Math.min(pollInterval, Math.max(1, operation.remainingMs())));
    operation.signal.addEventListener("abort", abort, { once: true });
    if (operation.signal.aborted) abort();
  });
  const finishStop = async (key: string, operation: Operation): Promise<void> => {
    const processIds = stoppingProcesses.get(key);
    if (processIds === undefined) return;
    while (true) {
      let running = false;
      for (const processId of processIds) { operation.check(); if (await isExecuting(processId)) running = true; }
      if (!running) { stoppingProcesses.delete(key); return; }
      await wait(operation);
    }
  };
  const snapshot = async (operation: Operation) => {
    const result = expectedResult(await options.rpc.request("session.snapshot", {}, operation), "session_snapshot");
    const data = object(result.snapshot, "Herdr snapshot");
    return { workspaces: array(data.workspaces, "Herdr workspaces").map((value) => object(value, "Herdr workspace")), panes: array(data.panes, "Herdr panes").map((value) => object(value, "Herdr pane")), agents: array(data.agents, "Herdr agents").map((value) => object(value, "Herdr agent")), tabs: array(data.tabs, "Herdr tabs").map((value) => object(value, "Herdr tab")) };
  };
  const verifyCwd = async (actual: unknown, context: { cwd: string }): Promise<void> => {
    const actualPath = text(actual, "Herdr pane cwd");
    if (!path.isAbsolute(actualPath) || path.normalize(await realpath(actualPath)) !== path.normalize(await realpath(context.cwd))) throw new Error("The Herdr pane cwd differs from the original task worktree.");
  };
  const readOwned = async (context: HerdrExecutionContext, binding: HerdrTaskBinding, operation: Operation, allowMissingPane = false) => {
    if (binding.session !== session) throw new Error("The task binding belongs to another Herdr session.");
    const data = await snapshot(operation);
    const label = herdrExecutionLabel(context);
    const matching = data.workspaces.filter((workspace) => workspace.label === label);
    if (matching.length !== 1 || matching[0]!.workspace_id !== binding.workspaceId) throw new Error("The original task workspace is missing, duplicated or has different ownership.");
    const panes = data.panes.filter((pane) => pane.pane_id === binding.paneId);
    if (panes.length === 0 && allowMissingPane) return { data, pane: null };
    if (panes.length !== 1) throw new Error("The original task pane is missing or duplicated.");
    const pane = panes[0]!;
    if (pane.workspace_id !== binding.workspaceId || pane.terminal_id !== binding.terminalId) throw new Error("The task pane or terminal identity has changed.");
    await verifyCwd(pane.cwd, context);
    return { data, pane };
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
    await verifyCwd(info.cwd, context);
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
  const visibleCodexSurface = async (context: HerdrExecutionContext, binding: HerdrTaskBinding, operation: Operation) => {
    const owned = await readOwned(context, binding, operation);
    const tabId = text(owned.pane!.tab_id, "Input pane tab ID");
    const result = expectedResult(await options.rpc.request("agent.read", { target: binding.paneId, source: "visible", format: "text", strip_ansi: true }, operation), "pane_read");
    const read = object(result.read, "Visible native input surface");
    if (read.pane_id !== binding.paneId || read.workspace_id !== binding.workspaceId || read.tab_id !== tabId || read.source !== "visible" || read.format !== "text") throw new Error("The visible input surface does not identify the original task pane and requested source.");
    if (typeof read.text !== "string" || typeof read.truncated !== "boolean") throw new TypeError("The visible input surface must contain text and an explicit truncation fact.");
    counter(read.revision, "Visible input revision");
    if (read.truncated) throw new Error("The original native input surface was truncated and cannot authorize automatic input.");
    // Herdr 0.9.5 reports revision zero. It is not a freshness or input receipt.
    const confirmed = await readOwned(context, binding, operation);
    if (confirmed.pane!.tab_id !== tabId) throw new Error("The original input pane changed tabs during the visible surface observation.");
    return codexInputSurface(read.text);
  };
  const submit = async (context: HerdrExecutionContext, binding: HerdrTaskBinding, prompt: string, operation: Operation, initialPrompt = false): Promise<{ submission: "submitted"; observation: HerdrAgentObservation }> => {
    if (typeof prompt !== "string" || prompt.length === 0) throw new HerdrAgentActionError("The caller prompt must be nonempty text.", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" });
    let before: HerdrAgentObservation;
    const verifyInputAgent = (current: HerdrAgentObservation): void => {
      const knownAgent = current.kind === context.agent || current.nativeSession?.agent === context.agent || (initialPrompt && current.name === herdrExecutionAgentName(context));
      if (!knownAgent || current.launchPending || ((initialPrompt || current.nativeSession === null) && !current.interactiveReady) || current.status === "blocked") throw new Error("The original native agent is not ready for input.");
    };
    try {
      while (true) {
        before = await observation(context, binding, operation);
        verifyInputAgent(before);
        if (context.agent !== "codex") break;
        const surface = await visibleCodexSurface(context, binding, operation);
        if (surface === "blocked") throw new Error("The original Codex input surface requires operator action; automatic input was not submitted.");
        before = await observation(context, binding, operation);
        verifyInputAgent(before);
        if (surface === "composer" || (!initialPrompt && before.status === "working")) break;
        await wait(operation);
      }
      operation.check();
    } catch (cause) { throw new HerdrAgentActionError(cause instanceof Error ? cause.message : "The original native input surface could not be verified.", "agent.prompt", "not-submitted", { cause, promptSubmission: "not-submitted" }); }
    const result = await mutation("agent.prompt", { target: binding.paneId, text: prompt }, "agent_prompted", operation);
    try {
      const returned = object(result.agent, "Prompt agent receipt");
      if (returned.pane_id !== binding.paneId || returned.terminal_id !== binding.terminalId || returned.workspace_id !== binding.workspaceId) throw new Error("The prompt receipt does not identify the original task agent.");
    } catch (cause) { throw new HerdrAgentActionError("The prompt receipt could not identify the original task agent.", "agent.prompt", "unknown", { cause, promptSubmission: "unknown" }); }
    return { submission: "submitted", observation: before };
  };
  return {
    listResources: async (operation: Operation): Promise<HerdrOwnedWorkspace[]> => {
      const data = await snapshot(operation);
      const result: HerdrOwnedWorkspace[] = [];
      const labels = new Set<string>();
      const workspaceIds = new Set<string>();
      for (const workspace of data.workspaces) {
        if (typeof workspace.label !== "string") throw new TypeError("The Herdr workspace label must be a string.");
        const label = workspace.label;
        const owner = parseHerdrExecutionLabel(label);
        if (owner === null) continue;
        const workspaceId = text(workspace.workspace_id, "Owned workspace ID");
        if (labels.has(label) || workspaceIds.has(workspaceId) || data.workspaces.filter((value) => value.workspace_id === workspaceId).length !== 1) throw new Error("Owned Herdr workspaces have duplicate labels or IDs.");
        labels.add(label); workspaceIds.add(workspaceId);
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
          if (pane.cwd !== undefined && cwd !== null && path.normalize(text(pane.cwd, "Owned terminal cwd")) !== path.normalize(cwd)) throw new Error("The owned Herdr pane and agent cwd differ.");
          const kind = optionalText(info.agent, "Owned agent kind");
          if (kind !== null && kind !== "codex" && kind !== "copilot") throw new Error("The owned task workspace hosts an unsupported native agent.");
          const native = info.agent_session === undefined ? null : object(info.agent_session, "Owned native session");
          const nativeAgent = native === null ? null : text(native.agent, "Owned native provider");
          if (nativeAgent !== null && nativeAgent !== "codex" && nativeAgent !== "copilot") throw new Error("The owned native reference has an unsupported provider.");
          if (kind !== null && nativeAgent !== null && kind !== nativeAgent) throw new Error("The owned agent and native history provider differ.");
          const status = text(info.agent_status, "Owned agent status");
          if (!["idle", "working", "blocked", "done", "unknown"].includes(status)) throw new TypeError("The owned native status is invalid.");
          const name = optionalText(info.name, "Owned agent name");
          if (name !== null && name !== `dn_${createHash("sha256").update(label).digest("hex").slice(0, 24)}`) throw new Error("The owned Herdr pane has a foreign managed agent name.");
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
    prepareWorkspace: async (context: HerdrExecutionContext, operation: Operation): Promise<HerdrTaskBinding> => {
      let createPossible = false;
      try {
        const label = herdrExecutionLabel(context);
        const expectedCwd = path.normalize(await realpath(context.cwd));
        const data = await snapshot(operation);
        const matching = data.workspaces.filter((workspace) => workspace.label === label);
        if (matching.length > 1) throw new Error("The task workspace label is duplicated.");
        if (matching.length === 1) {
          const workspaceId = text(matching[0]!.workspace_id, "Task workspace ID");
          const panes = data.panes.filter((pane) => pane.workspace_id === workspaceId);
          if (panes.length !== 1) throw new Error("The existing task workspace has ambiguous panes; it was retained.");
          const pane = panes[0]!;
          const binding = { session, workspaceId, paneId: text(pane.pane_id, "Task pane ID"), terminalId: text(pane.terminal_id, "Task terminal ID") };
          await readOwned(context, binding, operation);
          return binding;
        }
        for (const pane of data.panes) {
          if (typeof pane.cwd === "string" && [expectedCwd, path.normalize(path.resolve(context.cwd))].includes(path.normalize(path.resolve(pane.cwd)))) throw new Error("The requested task cwd already belongs to a different Herdr workspace.");
        }
        createPossible = true;
        const result = await mutation("workspace.create", { cwd: context.cwd, focus: false, label, env: { ...workspaceEnvironment } }, "workspace_created", operation);
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
    observe: observation,
    start: (context: HerdrExecutionContext, binding: HerdrTaskBinding, input: { configuration: HerdrAgentConfiguration; prompt: string; resumeSessionId?: string }, operation: Operation): Promise<HerdrAgentObservation> => serialized(binding.workspaceId, operation, async () => {
      if (input.configuration.agent !== context.agent) throw new TypeError("The agent configuration differs from the execution identity.");
      const args = buildHerdrAgentArguments(input.configuration, input.resumeSessionId);
      if (typeof input.prompt !== "string" || input.prompt.length === 0) throw new TypeError("The startup prompt must be nonempty text.");
      const before = await observation(context, binding, operation);
      if (before.kind !== null || before.launchPending || before.interactiveReady) return before;
      await options.preflight.verifyStart({ context, configuration: input.configuration, ...(input.resumeSessionId === undefined ? {} : { resumeSessionId: input.resumeSessionId }) }, operation);
      const timeout = Math.floor(Math.min(30_000, operation.remainingMs()));
      if (timeout <= 3000) throw new HerdrAgentActionError("The remaining operation budget cannot start a native agent.", "agent.start", "not-submitted");
      const started = await mutation("agent.start", { name: herdrExecutionAgentName(context), kind: context.agent, pane_id: binding.paneId, args, timeout_ms: timeout }, "agent_started", operation);
      const acknowledged = object(started.agent, "Started native agent");
      const argv = array(started.argv, "Native launch arguments");
      const expectedArgv = [context.agent, ...args];
      if (acknowledged.pane_id !== binding.paneId || acknowledged.terminal_id !== binding.terminalId || acknowledged.workspace_id !== binding.workspaceId || argv.length !== expectedArgv.length || argv.some((value, index) => value !== expectedArgv[index])) throw new HerdrAgentActionError("The native start result differs from the requested target or arguments.", "agent.start", "unknown");
      try {
        while (true) {
          const current = await observation(context, binding, operation);
          if (current.status === "blocked") throw new HerdrAgentActionError("The native agent requires operator action before its first input.", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" });
          if (input.resumeSessionId !== undefined && current.nativeSession !== null && current.nativeSession.sessionId !== canonicalId(input.resumeSessionId)) throw new HerdrAgentActionError("The resumed agent reported a different native session.", "agent.start", "unknown");
          if (!current.launchPending && current.interactiveReady && (current.kind === context.agent || current.nativeSession?.agent === context.agent || current.name === herdrExecutionAgentName(context))) break;
          await wait(operation);
        }
      } catch (cause) {
        if (cause instanceof HerdrAgentActionError) throw cause;
        throw new HerdrAgentActionError("The native process could not become ready before its first input.", "agent.prompt", "not-submitted", { cause, promptSubmission: "not-submitted" });
      }
      await submit(context, binding, input.prompt, operation, true);
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
    submitPrompt: (context: HerdrExecutionContext, binding: HerdrTaskBinding, prompt: string, operation: Operation) => serialized(binding.workspaceId, operation, () => submit(context, binding, prompt, operation)),
    stopAndClose: (context: HerdrExecutionOwner & { cwd: string }, binding: HerdrTaskBinding, operation: Operation): Promise<void> => serialized(binding.workspaceId, operation, async () => {
      if (binding.session !== session) throw new Error("The task binding belongs to another Herdr session.");
      const before = await snapshot(operation);
      const label = herdrExecutionLabel(context);
      const key = JSON.stringify([binding.session, binding.workspaceId, label]);
      const matching = before.workspaces.filter((workspace) => workspace.workspace_id === binding.workspaceId || workspace.label === label);
      if (matching.length === 0) {
        if ([...before.panes, ...before.agents].some((resource) => resource.workspace_id === binding.workspaceId || resource.pane_id === binding.paneId || resource.terminal_id === binding.terminalId)) throw new Error("The missing task workspace still has associated resources.");
        return finishStop(key, operation);
      }
      if (matching.length !== 1 || matching[0]!.workspace_id !== binding.workspaceId || matching[0]!.label !== label) throw new Error("The task workspace identity changed before stopping.");
      const currentPanes = before.panes.filter((pane) => pane.workspace_id === binding.workspaceId);
      // Closing removes discovery evidence before all processes necessarily exit.
      // Retain this process-local responsibility across failed close/wait calls.
      let processIds = stoppingProcesses.get(key);
      if (processIds === undefined) { processIds = new Set<number>(); stoppingProcesses.set(key, processIds); }
      for (const pane of currentPanes) {
        const paneId = text(pane.pane_id, "Stop pane ID");
        if (paneId === binding.paneId && pane.terminal_id !== binding.terminalId) throw new Error("The task terminal identity changed before stopping.");
        await verifyCwd(pane.cwd, context);
        const result = expectedResult(await options.rpc.request("pane.process_info", { pane_id: paneId }, operation), "pane_process_info");
        const info = object(result.process_info, "Current stop process observation");
        if (info.pane_id !== paneId) throw new Error("The stop process observation belongs to another pane.");
        processIds.add(pid(info.shell_pid));
        const foreground = info.foreground_processes === undefined ? [] : array(info.foreground_processes, "Current foreground processes");
        for (const entry of foreground) processIds.add(pid(object(entry, "Current foreground process").pid));
      }
      await mutation("workspace.close", { workspace_id: binding.workspaceId, close_group: false }, "ok", operation);
      const after = await snapshot(operation);
      if (after.workspaces.some((workspace) => workspace.workspace_id === binding.workspaceId || workspace.label === label) || [...after.panes, ...after.agents].some((resource) => resource.workspace_id === binding.workspaceId)) throw new HerdrAgentActionError("The task workspace still exists after closure.", "workspace.close", "unknown");
      await finishStop(key, operation);
    }),
  };
};
export type HerdrAgentManager = ReturnType<typeof createHerdrAgentManager>;
