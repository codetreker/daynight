import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { Operation } from "../../../api/operation.js";
import { canonicalId } from "../../../api/parse.js";
import type { WorkerAgent } from "../../../api/types.js";
import { normalizeServerUrl } from "../../../config/server.js";
import { buildHerdrAgentArguments } from "./arguments.js";
import type { HerdrAgentConfiguration } from "./arguments.js";
import { HerdrRpcError } from "./rpc.js";
import type { HerdrRpcClient, HerdrRpcResult } from "./rpc.js";

export type { HerdrAgentConfiguration } from "./arguments.js";
export { buildHerdrAgentArguments, validateHerdrAgentArguments } from "./arguments.js";
export type HerdrExecutionContext = { serverOrigin: string; projectId: string; taskId: string; claimId: string; worktreeId: string; cwd: string; agent: WorkerAgent };
export type HerdrExecutionOwner = Pick<HerdrExecutionContext, "serverOrigin" | "projectId" | "taskId" | "claimId" | "worktreeId">;
export type HerdrTaskBinding = { session: string; workspaceId: string; paneId: string; terminalId: string };
export type HerdrLaunchEvidence = { binding: HerdrTaskBinding; ownerLabel: string; agent: WorkerAgent; argv: readonly string[]; referenceBaseline: "empty" };
export type HerdrNativeReference = { source: string; agent: WorkerAgent; sessionId: string };
export type HerdrAgentObservation = { binding: HerdrTaskBinding; kind: string | null; name: string | null; status: string; launchPending: boolean; interactiveReady: boolean; nativeSession: HerdrNativeReference | null; stateChangeSeq: number | null; completionSeq: number | null };
export type HerdrStopObservation = { binding: HerdrTaskBinding; ownerLabel: string; agent: WorkerAgent; nativeSessionId: string | null; shellPid: number; processIds: readonly number[]; observedAt: number };
export type HerdrOwnedWorkspace = { owner: HerdrExecutionOwner; workspaceId: string; panes: { binding: HerdrTaskBinding; cwd: string | null; kind: WorkerAgent | null; status: string; launchPending: boolean; interactiveReady: boolean; nativeSession: HerdrNativeReference | null; stateChangeSeq: number | null; completionSeq: number | null }[] };
export type HerdrAgentPreflight = { verifyStart(input: { context: HerdrExecutionContext; configuration: HerdrAgentConfiguration; resumeSessionId?: string }, operation: Operation): Promise<unknown> };

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
const nativeProcessEvidence = (value: RecordValue, agent: WorkerAgent): boolean => {
  const executable = (candidate: unknown): boolean => {
    if (typeof candidate !== "string") return false;
    const leaf = candidate.split(/[\\/]/).at(-1)?.toLowerCase();
    return leaf === agent || leaf === `${agent}.exe` || leaf === `${agent}.js`;
  };
  if (value.argv !== undefined) {
    const argv = array(value.argv, "Native process arguments");
    if (argv.some((argument) => typeof argument !== "string")) throw new TypeError("Native process arguments must be strings.");
    if (executable(argv[0])) return true;
    const interpreter = typeof argv[0] === "string" ? argv[0].split(/[\\/]/).at(-1)?.toLowerCase() : undefined;
    if ((interpreter === "node" || interpreter === "node.exe") && executable(argv[1])) return true;
  }
  return executable(value.argv0) || executable(value.name);
};
const expectedResult = (value: HerdrRpcResult, type: string): HerdrRpcResult => { if (value.type !== type) throw new TypeError(`Expected Herdr ${type} result; received ${value.type}.`); return value; };
const sameBinding = (left: HerdrTaskBinding, right: HerdrTaskBinding): boolean => left.session === right.session && left.workspaceId === right.workspaceId && left.paneId === right.paneId && left.terminalId === right.terminalId;
const contextIdentity = (context: HerdrExecutionContext) => {
  if (context.agent !== "codex" && context.agent !== "copilot") throw new TypeError("Execution agent must be codex or copilot.");
  if (!path.isAbsolute(context.cwd) || /[\r\n\0]/.test(context.cwd)) throw new TypeError("The task cwd must be an absolute path without line breaks or NUL.");
  const identifier = (value: string, label: string): string => { const result = canonicalId(value); if (result === null) throw new TypeError(`${label} must be a UUID.`); return result; };
  return { serverOrigin: normalizeServerUrl(context.serverOrigin), projectId: identifier(context.projectId, "Project ID"), taskId: identifier(context.taskId, "Task ID"), claimId: identifier(context.claimId, "Claim ID"), worktreeId: identifier(context.worktreeId, "Worktree ID") };
};
export const herdrExecutionLabel = (context: HerdrExecutionContext): string => `daynight:${JSON.stringify(contextIdentity(context))}`;
export const herdrExecutionAgentName = (context: HerdrExecutionContext): string => `dn_${createHash("sha256").update(herdrExecutionLabel(context)).digest("hex").slice(0, 24)}`;
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
  readonly launchEvidence: HerdrLaunchEvidence | null;
  constructor(message: string, readonly action: string, readonly submission: "not-submitted" | "rejected" | "unknown", options?: ErrorOptions & { promptSubmission?: "not-submitted" | "submitted" | "unknown"; launchEvidence?: HerdrLaunchEvidence }) {
    super(message, options); this.name = "HerdrAgentActionError";
    this.promptSubmission = options?.promptSubmission === undefined ? null : options.promptSubmission;
    this.launchEvidence = options?.launchEvidence === undefined ? null : options.launchEvidence;
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

export const createHerdrAgentManager = (options: { rpc: HerdrRpcClient; session: string; preflight: HerdrAgentPreflight; processExecuting?: (pid: number) => Promise<boolean>; pollIntervalMs?: number }) => {
  const session = text(options.session, "Herdr session");
  const isExecuting = options.processExecuting === undefined ? processExecuting : options.processExecuting;
  const pollInterval = options.pollIntervalMs === undefined ? 100 : options.pollIntervalMs;
  if (!Number.isSafeInteger(pollInterval) || pollInterval <= 0 || pollInterval > 1000) throw new TypeError("The Herdr observation interval must be between 1 and 1000 milliseconds.");
  const inputTails = new Map<string, Promise<void>>();
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
  const snapshot = async (operation: Operation) => {
    const result = expectedResult(await options.rpc.request("session.snapshot", {}, operation), "session_snapshot");
    const data = object(result.snapshot, "Herdr snapshot");
    return { workspaces: array(data.workspaces, "Herdr workspaces").map((value) => object(value, "Herdr workspace")), panes: array(data.panes, "Herdr panes").map((value) => object(value, "Herdr pane")), agents: array(data.agents, "Herdr agents").map((value) => object(value, "Herdr agent")), tabs: array(data.tabs, "Herdr tabs").map((value) => object(value, "Herdr tab")) };
  };
  const verifyCwd = async (actual: unknown, context: HerdrExecutionContext): Promise<void> => {
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
  const submit = async (context: HerdrExecutionContext, binding: HerdrTaskBinding, prompt: string, operation: Operation, initialPrompt = false): Promise<{ submission: "submitted"; observation: HerdrAgentObservation }> => {
    if (typeof prompt !== "string" || prompt.length === 0) throw new HerdrAgentActionError("The caller prompt must be nonempty text.", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" });
    const before = await observation(context, binding, operation);
    const knownAgent = before.kind === context.agent || before.nativeSession?.agent === context.agent || (initialPrompt && before.name === herdrExecutionAgentName(context));
    if (!knownAgent || before.launchPending || (!initialPrompt && before.nativeSession === null) || (initialPrompt && !before.interactiveReady) || before.status === "blocked") throw new HerdrAgentActionError("The original native agent is not ready for input.", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" });
    const result = await mutation("agent.prompt", { target: binding.paneId, text: prompt }, "agent_prompted", operation);
    try {
      const returned = object(result.agent, "Prompt agent receipt");
      if (returned.pane_id !== binding.paneId || returned.terminal_id !== binding.terminalId || returned.workspace_id !== binding.workspaceId) throw new Error("The prompt receipt does not identify the original task agent.");
    } catch (cause) { throw new HerdrAgentActionError("The prompt receipt could not identify the original task agent.", "agent.prompt", "unknown", { cause, promptSubmission: "unknown" }); }
    return { submission: "submitted", observation: before };
  };
  const verifyStopObservation = (context: HerdrExecutionContext, binding: HerdrTaskBinding, evidence: HerdrStopObservation): void => {
    if (!sameBinding(binding, evidence.binding) || evidence.ownerLabel !== herdrExecutionLabel(context) || evidence.agent !== context.agent) throw new Error("The saved process observation belongs to another execution.");
    pid(evidence.shellPid);
    if (evidence.nativeSessionId !== null && canonicalId(evidence.nativeSessionId) === null) throw new Error("The saved native session identity is invalid.");
    if (!Array.isArray(evidence.processIds) || evidence.processIds.length === 0 || new Set(evidence.processIds).size !== evidence.processIds.length || evidence.processIds.some((value) => pid(value) === evidence.shellPid)) throw new Error("The original native process observation is invalid.");
    if (!Number.isSafeInteger(evidence.observedAt) || evidence.observedAt < 0) throw new Error("The original process observation time is invalid.");
  };
  const absentProcesses = async (evidence: HerdrStopObservation, operation: Operation): Promise<void> => {
    for (const processId of evidence.processIds) { operation.check(); if (await isExecuting(processId)) throw new Error("The original native process is still executing or its absence is unconfirmed."); }
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
      const label = herdrExecutionLabel(context);
      await realpath(context.cwd);
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
      const expectedCwd = path.normalize(await realpath(context.cwd));
      for (const pane of data.panes) {
        if (typeof pane.cwd !== "string") continue;
        const reportedCwd = path.normalize(path.resolve(pane.cwd));
        if (reportedCwd === expectedCwd || reportedCwd === path.normalize(path.resolve(context.cwd))) throw new Error("The requested task cwd already belongs to a different Herdr workspace.");
      }
      const result = await mutation("workspace.create", { cwd: context.cwd, focus: false, label, env: {} }, "workspace_created", operation);
      try {
        const workspace = object(result.workspace, "Created workspace");
        const pane = object(result.root_pane, "Created task pane");
        const binding = { session, workspaceId: text(workspace.workspace_id, "Created workspace ID"), paneId: text(pane.pane_id, "Created pane ID"), terminalId: text(pane.terminal_id, "Created terminal ID") };
        await readOwned(context, binding, operation);
        return binding;
      } catch (cause) { throw new HerdrAgentActionError("The created task workspace could not be verified.", "workspace.create", "unknown", { cause }); }
    },
    observe: observation,
    start: (context: HerdrExecutionContext, binding: HerdrTaskBinding, input: { configuration: HerdrAgentConfiguration; prompt: string; resumeSessionId?: string; initialPromptNotSubmitted?: true; launchEvidence?: HerdrLaunchEvidence }, operation: Operation) => serialized(binding.paneId, operation, async () => {
      if (input.configuration.agent !== context.agent) throw new TypeError("The frozen agent configuration differs from the execution identity.");
      const args = buildHerdrAgentArguments(input.configuration, input.resumeSessionId);
      if (typeof input.prompt !== "string" || input.prompt.length === 0) throw new TypeError("The caller startup prompt must be nonempty text.");
      const before = await observation(context, binding, operation);
      const existing = before.kind !== null || before.name !== null || before.launchPending || before.interactiveReady;
      if (input.resumeSessionId !== undefined && before.nativeSession !== null && before.nativeSession.sessionId !== canonicalId(input.resumeSessionId)) throw new Error("The retained native session differs from the original recovery session.");
      const rebind = (reason: "retained-native-reference" | "unverified-launch") => ({ kind: "rebind-required" as const, reason, observation: before, promptSubmission: "not-submitted" as const, launchEvidence: null });
      if (!before.launchPending && !before.interactiveReady && before.kind === null && before.nativeSession !== null) return rebind("retained-native-reference");
      let launchEvidence: HerdrLaunchEvidence | null = null;
      if (existing) {
        // A reconnect observes the existing input history. Only the caller's persisted
        // never-submitted fact and verified empty-reference launch can authorize deferred first input.
        if (input.initialPromptNotSubmitted !== true) return { kind: "reconnected" as const, observation: before, promptSubmission: "not-submitted" as const, launchEvidence: null };
        const evidence = input.launchEvidence;
        const expectedArgv = [context.agent, ...args];
        if (evidence === undefined || evidence.referenceBaseline !== "empty" || evidence.ownerLabel !== herdrExecutionLabel(context) || evidence.agent !== context.agent || !sameBinding(evidence.binding, binding) || !Array.isArray(evidence.argv) || evidence.argv.length !== expectedArgv.length || evidence.argv.some((value, index) => value !== expectedArgv[index])) return rebind("unverified-launch");
        launchEvidence = evidence;
      } else if (input.initialPromptNotSubmitted === true) {
        return rebind("unverified-launch");
      } else if (before.nativeSession !== null) {
        return rebind("retained-native-reference");
      }
      await options.preflight.verifyStart({ context, configuration: input.configuration, ...(input.resumeSessionId === undefined ? {} : { resumeSessionId: input.resumeSessionId }) }, operation);
      let promptSubmission: "not-submitted" | "submitted" = "not-submitted";
      try {
        if (!existing) {
          const timeout = Math.floor(Math.min(30_000, operation.remainingMs()));
          if (timeout <= 3000) throw new HerdrAgentActionError("The remaining operation budget cannot start a native agent.", "agent.start", "not-submitted", { promptSubmission: "not-submitted" });
          const started = await mutation("agent.start", { name: herdrExecutionAgentName(context), kind: context.agent, pane_id: binding.paneId, args, timeout_ms: timeout }, "agent_started", operation);
          const acknowledged = object(started.agent, "Native launch receipt");
          const argv = array(started.argv, "Native launch arguments");
          const expectedArgv = [context.agent, ...args];
          if (acknowledged.pane_id !== binding.paneId || acknowledged.terminal_id !== binding.terminalId || acknowledged.workspace_id !== binding.workspaceId || argv.length !== expectedArgv.length || argv.some((value, index) => value !== expectedArgv[index])) throw new Error("The native launch receipt does not preserve its original target and frozen arguments.");
          launchEvidence = { binding: { ...binding }, ownerLabel: herdrExecutionLabel(context), agent: context.agent, argv: [...expectedArgv], referenceBaseline: "empty" };
        }
        while (true) {
          const current = await observation(context, binding, operation);
          if (current.status === "blocked") return { kind: "waiting" as const, observation: current, promptSubmission: "not-submitted" as const, launchEvidence };
          const ready = !current.launchPending && current.interactiveReady && (current.kind === context.agent || current.nativeSession?.agent === context.agent || current.name === herdrExecutionAgentName(context));
          const originalSessionReady = input.resumeSessionId === undefined || current.nativeSession === null || current.nativeSession.sessionId === canonicalId(input.resumeSessionId);
          if (input.resumeSessionId !== undefined && current.nativeSession !== null && !originalSessionReady) throw new Error("The resumed agent reported a different native session.");
          if (ready && originalSessionReady) {
            // Native SessionStart can run on the first user turn, including resume.
            // The verified explicit launch authorizes one input; its reported identity is checked afterward.
            // https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/session/turn.rs#L340-L342
            await submit(context, binding, input.prompt, operation, true);
            promptSubmission = "submitted";
            while (true) {
              const reported = await observation(context, binding, operation);
              if (reported.nativeSession !== null) {
                if (input.resumeSessionId !== undefined && reported.nativeSession.sessionId !== canonicalId(input.resumeSessionId)) throw new Error("The resumed native identity changed after prompt submission.");
                return { kind: "started" as const, observation: reported, promptSubmission: "submitted" as const, launchEvidence };
              }
              if (reported.status === "blocked") return { kind: "waiting" as const, observation: reported, promptSubmission: "submitted" as const, launchEvidence };
              await wait(operation);
            }
          }
          await wait(operation);
        }
      } catch (cause) {
        const evidence = launchEvidence === null ? {} : { launchEvidence };
        if (cause instanceof HerdrAgentActionError) throw new HerdrAgentActionError(cause.message, cause.action, cause.submission, { cause, promptSubmission: cause.promptSubmission === null ? promptSubmission : cause.promptSubmission, ...evidence });
        throw new HerdrAgentActionError("The native launch or initial prompt could not be confirmed; observe the original pane before any further action.", "agent.start", "unknown", { cause, promptSubmission, ...evidence });
      }
    }),
    submitPrompt: (context: HerdrExecutionContext, binding: HerdrTaskBinding, prompt: string, operation: Operation) => serialized(binding.paneId, operation, () => submit(context, binding, prompt, operation)),
    captureStop: async (context: HerdrExecutionContext, binding: HerdrTaskBinding, operation: Operation): Promise<HerdrStopObservation> => {
      const current = await observation(context, binding, operation);
      const result = expectedResult(await options.rpc.request("pane.process_info", { pane_id: binding.paneId }, operation), "pane_process_info");
      const info = object(result.process_info, "Pane process observation");
      if (info.pane_id !== binding.paneId) throw new Error("The process observation belongs to another pane.");
      const shellPid = pid(info.shell_pid);
      const processes = info.foreground_processes === undefined ? [] : array(info.foreground_processes, "Foreground processes");
      const records = processes.map((value) => object(value, "Foreground process"));
      const processIds = [...new Set(records.map((value) => pid(value.pid)).filter((value) => value !== shellPid))];
      if (processIds.length === 0) throw new Error("The original native process identities are unavailable; pane absence or an empty process list cannot establish stopped confirmation.");
      if (current.launchPending && (current.name !== herdrExecutionAgentName(context) || !records.some((value) => pid(value.pid) !== shellPid && nativeProcessEvidence(value, context.agent)))) throw new Error("The pending task launch has no concrete original native process evidence.");
      return { binding, ownerLabel: herdrExecutionLabel(context), agent: context.agent, nativeSessionId: current.nativeSession?.sessionId ?? null, shellPid, processIds, observedAt: Date.now() };
    },
    requestGracefulStop: (context: HerdrExecutionContext, binding: HerdrTaskBinding, operation: Operation) => serialized(binding.paneId, operation, () => submit(context, binding, "/exit", operation)),
    confirmStopped: async (context: HerdrExecutionContext, binding: HerdrTaskBinding, evidence: HerdrStopObservation, operation: Operation): Promise<{ agentStopped: true }> => {
      verifyStopObservation(context, binding, evidence);
      const current = await readOwned(context, binding, operation, true);
      await absentProcesses(evidence, operation);
      if (current.pane !== null) {
        const result = expectedResult(await options.rpc.request("pane.process_info", { pane_id: binding.paneId }, operation), "pane_process_info");
        const info = object(result.process_info, "Current pane process observation");
        if (info.pane_id !== binding.paneId) throw new Error("The current process observation belongs to another pane.");
        const currentShellPid = pid(info.shell_pid);
        if (currentShellPid !== evidence.shellPid && await isExecuting(evidence.shellPid)) throw new Error("The original task shell is still executing or its absence is unconfirmed.");
        const currentProcesses = info.foreground_processes === undefined ? [] : array(info.foreground_processes, "Current foreground processes");
        if (currentProcesses.some((value) => pid(object(value, "Current foreground process").pid) !== currentShellPid)) throw new Error("The original pane still hosts foreground work.");
      }
      return { agentStopped: true };
    },
    confirmRestoredStop: async (context: HerdrExecutionContext, originalBinding: HerdrTaskBinding, restoredBinding: HerdrTaskBinding, evidence: HerdrStopObservation, operation: Operation): Promise<{ agentStopped: true; binding: HerdrTaskBinding }> => {
      verifyStopObservation(context, originalBinding, evidence);
      if (originalBinding.session !== restoredBinding.session || originalBinding.workspaceId !== restoredBinding.workspaceId || originalBinding.paneId !== restoredBinding.paneId) throw new Error("The restored shell does not have the original task workspace and pane association.");
      const current = await observation(context, restoredBinding, operation);
      if (current.kind !== null || current.launchPending || current.interactiveReady) throw new Error("The restored task pane is not an inactive shell.");
      if (evidence.nativeSessionId !== null && current.nativeSession !== null && evidence.nativeSessionId !== current.nativeSession.sessionId) throw new Error("The restored shell retains a different original native session.");
      await absentProcesses(evidence, operation);
      operation.check();
      if (await isExecuting(evidence.shellPid)) throw new Error("The original task shell is still executing or its absence is unconfirmed.");
      const result = expectedResult(await options.rpc.request("pane.process_info", { pane_id: restoredBinding.paneId }, operation), "pane_process_info");
      const info = object(result.process_info, "Restored pane process observation");
      if (info.pane_id !== restoredBinding.paneId) throw new Error("The restored process observation belongs to another pane.");
      const currentShellPid = pid(info.shell_pid);
      const currentProcesses = info.foreground_processes === undefined ? [] : array(info.foreground_processes, "Restored foreground processes");
      if (currentProcesses.some((value) => pid(object(value, "Restored foreground process").pid) !== currentShellPid)) throw new Error("The restored task pane still hosts foreground work.");
      return { agentStopped: true, binding: { ...restoredBinding } };
    },
    forceStop: (context: HerdrExecutionContext, binding: HerdrTaskBinding, evidence: HerdrStopObservation, operation: Operation) => serialized(binding.paneId, operation, async () => {
      verifyStopObservation(context, binding, evidence);
      const { data, pane } = await readOwned(context, binding, operation, true);
      if (pane !== null) {
        const current = await observation(context, binding, operation);
        if (evidence.nativeSessionId !== null && current.nativeSession !== null && current.nativeSession.sessionId !== evidence.nativeSessionId) throw new Error("The task pane now identifies another native session; the original stop observation was retained.");
        const processResult = expectedResult(await options.rpc.request("pane.process_info", { pane_id: binding.paneId }, operation), "pane_process_info");
        const processInfo = object(processResult.process_info, "Current stop process observation");
        if (processInfo.pane_id !== binding.paneId || pid(processInfo.shell_pid) !== evidence.shellPid) throw new Error("The original task shell identity has changed.");
        const foreground = processInfo.foreground_processes === undefined ? [] : array(processInfo.foreground_processes, "Current stop processes");
        const currentPids = foreground.map((value) => pid(object(value, "Current stop process").pid)).filter((value) => value !== evidence.shellPid);
        if (currentPids.length !== 0 && !currentPids.some((value) => evidence.processIds.includes(value))) throw new Error("The task pane now hosts processes outside the original stop observation.");
        const guardLabel = `daynight-stop:${binding.terminalId}`;
        const guards = data.tabs.filter((tab) => tab.workspace_id === binding.workspaceId && tab.label === guardLabel);
        if (guards.length > 1) throw new Error("The task stop anchor is duplicated.");
        if (guards.length === 0) {
          const result = await mutation("tab.create", { workspace_id: binding.workspaceId, cwd: context.cwd, focus: false, label: guardLabel, env: {} }, "tab_created", operation);
          const tab = object(result.tab, "Created stop anchor tab");
          const root = object(result.root_pane, "Created stop anchor pane");
          if (tab.workspace_id !== binding.workspaceId || tab.label !== guardLabel || root.workspace_id !== binding.workspaceId || root.pane_id === binding.paneId || root.agent !== undefined) throw new HerdrAgentActionError("The stop anchor does not identify an empty task-owned pane.", "tab.create", "unknown");
        }
        const anchored = await readOwned(context, binding, operation);
        const ownedPanes = anchored.data.panes.filter((candidate) => candidate.workspace_id === binding.workspaceId);
        if (ownedPanes.length < 2 || !anchored.data.tabs.some((tab) => tab.workspace_id === binding.workspaceId && tab.label === guardLabel)) throw new Error("The task workspace has no verified stop anchor.");
        await mutation("pane.close", { pane_id: binding.paneId }, "ok", operation);
      }
      await readOwned(context, binding, operation, true);
      await absentProcesses(evidence, operation);
      return { agentStopped: true as const, originalPaneClosed: true as const };
    }),
    closeWorkspace: async (context: HerdrExecutionContext, binding: HerdrTaskBinding, proof: { agentStopped: true }, operation: Operation): Promise<{ workspaceClosed: true }> => {
      if (proof.agentStopped !== true) throw new Error("Task workspace closure requires confirmed original agent stop.");
      const before = await snapshot(operation);
      const original = before.workspaces.find((workspace) => workspace.workspace_id === binding.workspaceId);
      if (original === undefined) {
        if (before.workspaces.some((workspace) => workspace.label === herdrExecutionLabel(context))) throw new Error("The task label now identifies another workspace; the original binding was retained.");
        return { workspaceClosed: true };
      }
      await readOwned(context, binding, operation, true);
      await mutation("workspace.close", { workspace_id: binding.workspaceId, close_group: false }, "ok", operation);
      const after = await snapshot(operation);
      if (after.workspaces.some((workspace) => workspace.workspace_id === binding.workspaceId || workspace.label === herdrExecutionLabel(context))) throw new HerdrAgentActionError("The original workspace still exists after closure.", "workspace.close", "unknown");
      return { workspaceClosed: true };
    },
  };
};
export type HerdrAgentManager = ReturnType<typeof createHerdrAgentManager>;
