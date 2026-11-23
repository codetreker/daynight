import { randomUUID } from "node:crypto";
import { sessionBinding } from "../../../session/protocol.js";
import { controllerPayloadHash, MAX_INITIAL_PROMPT_BYTES, type ControllerLaunchTicket } from "../../controller/launch-ticket.js";
import { ControllerIpcFrameLimitError, ControllerIpcOutcomeUnknownError, encodeControllerLocalRequest, requestController } from "../../controller/local-client.js";
import type { ControllerOperation, ControllerSnapshot } from "../../controller/lifecycle-store.js";
import { appendWorkerPrompts, workerPingPrompt } from "../prompts.js";
import type { WorkerPromptSource } from "../prompt-source.js";
import type { LocalTask } from "./web-types.js";

export type WebAutomaticInputWait = "task_paused" | "claim_invalid" | "native_input" | "prompt_unknown" | "prompt_too_large";
export type WebAutomaticInputResult =
  | { kind: "observed"; snapshot: ControllerSnapshot }
  | { kind: "waiting"; reason: WebAutomaticInputWait; snapshot: ControllerSnapshot }
  | { kind: "upgrade"; snapshot: ControllerSnapshot };
export type LegacyInputAuthority = (task: LocalTask, ticket: ControllerLaunchTicket, signal: AbortSignal) => Promise<"task_paused" | "claim_invalid" | null>;
type Input = { task: LocalTask; ticket: ControllerLaunchTicket; snapshot: ControllerSnapshot; signal: AbortSignal; legacyAuthority: LegacyInputAuthority };
type StepInput = Input & { protocol: 1 | undefined };
type Purpose = "initial" | "assignment" | "ping";
type Pending = { purpose: Purpose; operationId: string; prompt: string; deadline: number; startedAt: number };
type Progress = { binding: string; initialOwned: boolean; assignmentAccepted: boolean; pending: Pending | null };

export type WebInputEvent = { purpose: Purpose; operationId: string | null; executionId: string; sessionId: string; controllerInstanceId: string; generation: string; outcome: string; detail?: string };
export type WebInputOptions = {
  current: (task: LocalTask) => LocalTask;
  currentSnapshot: (task: LocalTask, ticket: ControllerLaunchTicket) => ControllerSnapshot | null;
  buildPrompt: (task: LocalTask) => string;
  promptSource?: Pick<WorkerPromptSource, "current">;
  preparePromptSource?: (projectId: string, signal: AbortSignal) => Promise<void>;
  request?: typeof requestController;
  readOperation: (task: LocalTask, operationId: string, ticket: ControllerLaunchTicket) => ControllerOperation | null;
  now: () => number;
  report?: (task: LocalTask, error: Error) => void;
  event?: (task: LocalTask, event: WebInputEvent) => void;
};

// Progress is intentionally process-local and tied to the authenticated generation.
export const createWebInput = (options: WebInputOptions) => {
  const progress = new Map<string, Progress>();
  const running = new Map<string, Promise<WebAutomaticInputResult>>();
  const recordedWaiting = new WeakSet<WebAutomaticInputResult>();
  const key = (task: LocalTask) => `${task.projectId}/${task.taskId}/${task.claimId}`;
  const binding = (ticket: ControllerLaunchTicket) => JSON.stringify([ticket.executionId, ticket.sessionId, ticket.controllerInstanceId, ticket.executionGeneration]);
  const matches = (task: LocalTask, ticket: ControllerLaunchTicket, snapshot: ControllerSnapshot): boolean => {
    const execution = task.webExecution;
    return task.status === "active" && task.cleanup === null && task.control === null && execution !== null
      && task.claimId === ticket.claimId && task.projectId === ticket.projectId && task.taskId === ticket.taskId
      && task.workerId === ticket.workerId && task.worktreeId === ticket.worktreeId && task.userId === ticket.userId
      && task.serverOrigin === ticket.serverOrigin && task.configuration?.agent === ticket.provider
      && execution.executionId === ticket.executionId && execution.sessionId === ticket.sessionId
      && execution.controllerInstanceId === ticket.controllerInstanceId && execution.executionGeneration === ticket.executionGeneration
      && snapshot.executionId === ticket.executionId && snapshot.claimId === ticket.claimId && snapshot.sessionId === ticket.sessionId
      && snapshot.controllerInstanceId === ticket.controllerInstanceId && snapshot.executionGeneration === ticket.executionGeneration
      && (task.resources.nativeSession === null || snapshot.nativeSessionId === task.resources.nativeSession.sessionId);
  };
  const ready = (snapshot: ControllerSnapshot): boolean => (snapshot.lifecycle === "ready" || snapshot.lifecycle === "working")
    && (snapshot.startup === undefined || snapshot.startup.state === "ready") && snapshot.activity === "idle" && snapshot.currentTurnId === null
    && snapshot.capabilities.send && !snapshot.nativeStopped && snapshot.error === null;
  const wait = (snapshot: ControllerSnapshot, reason: WebAutomaticInputWait): WebAutomaticInputResult => ({ kind: "waiting", reason, snapshot });
  const readProgress = (task: LocalTask, ticket: ControllerLaunchTicket, snapshot: ControllerSnapshot): Progress => {
    const id = key(task), currentBinding = binding(ticket), old = progress.get(id);
    if (old?.binding === currentBinding) return old;
    const result: Progress = { binding: currentBinding, initialOwned: snapshot.initialInputState === "not_submitted", assignmentAccepted: false, pending: null };
    progress.set(id, result);
    return result;
  };
  const emit = (task: LocalTask, ticket: ControllerLaunchTicket, pending: Pending, outcome: string, detail?: string): void => {
    try { options.event?.(task, { purpose: pending.purpose, operationId: pending.operationId, executionId: ticket.executionId, sessionId: ticket.sessionId,
      controllerInstanceId: ticket.controllerInstanceId, generation: ticket.executionGeneration, outcome, ...(detail === undefined ? {} : { detail }) }); } catch { /* Diagnostics do not change input outcomes. */ }
  };
  const validate = (operation: ControllerOperation, pending: Pending, ticket: ControllerLaunchTicket): void => {
    const kind = pending.purpose === "initial" ? "initial" : "worker_input";
    const payload = kind === "initial" ? { text: pending.prompt } : { content: [{ type: "text", text: pending.prompt }], expectedTurnId: null, origin: "daynight" };
    if (operation.operationId !== pending.operationId || operation.executionGeneration !== ticket.executionGeneration || operation.kind !== kind
      || operation.payloadHash !== controllerPayloadHash({ kind, payload }) || controllerPayloadHash(operation.payload) !== controllerPayloadHash(payload)) {
      throw new Error("The original automatic input operation conflicts with its execution or content.");
    }
  };
  const resolve = (task: LocalTask, ticket: ControllerLaunchTicket, snapshot: ControllerSnapshot, state: Progress, operation: ControllerOperation | null): WebAutomaticInputResult | null => {
    const pending = state.pending!;
    if (operation === null) {
      if (options.now() <= pending.deadline) {
        if (pending.purpose === "initial" && options.now() > pending.startedAt + 70_000) throw new Error("The original initial input cannot yet be reconciled.");
        return wait(snapshot, "native_input");
      }
      state.pending = null;
      return wait(snapshot, "native_input");
    }
    validate(operation, pending, ticket);
    emit(task, ticket, pending, operation.state);
    if (["accepted", "offered", "dispatching"].includes(operation.state)) {
      if (options.now() > pending.startedAt + 70_000) throw new Error("The original automatic input did not settle within its expected deadline.");
      return wait(snapshot, "native_input");
    }
    if (operation.state === "provider_accepted" || operation.state === "confirmed") {
      state.pending = null;
      if (pending.purpose === "assignment" || pending.purpose === "initial" && state.initialOwned) state.assignmentAccepted = true;
      return { kind: "observed", snapshot };
    }
    if (operation.state === "unknown") {
      const failure = new Error(`The original ${pending.purpose} input has an unknown outcome.`);
      options.report?.(task, failure);
      if (pending.purpose !== "initial") state.pending = null;
      return wait(snapshot, "native_input");
    }
    state.pending = null;
    if (operation.state === "expired") return wait(snapshot, "native_input");
    if (operation.state === "rejected" && operation.error !== null && [
      "Native turn changed or interaction is pending.",
      "Claude cannot accept input in this session state.",
      "Claude has pending native input.",
      "Native Copilot turn changed or cannot accept input.",
    ].includes(operation.error)) return wait(snapshot, "native_input");
    throw new Error(`The original ${pending.purpose} input was ${operation.state}.`);
  };
  const preflight = (ticket: ControllerLaunchTicket, operationId: string, prompt: string, deadline: number): boolean => {
    if (prompt.trim() === "" || !prompt.isWellFormed()) throw new Error("The automatic input prompt is invalid.");
    if (Buffer.byteLength(prompt, "utf8") > MAX_INITIAL_PROMPT_BYTES) return false;
    try {
      encodeControllerLocalRequest({ requestId: randomUUID(), executionId: ticket.executionId, ...sessionBinding(ticket), executionGeneration: ticket.executionGeneration,
        controllerInstanceId: ticket.controllerInstanceId, secret: ticket.ipcSecret, action: { kind: "submit_worker_input", operationId, prompt, deadline } });
      return true;
    } catch (error) { if (error instanceof ControllerIpcFrameLimitError) return false; throw error; }
  };
  const waitEvent = (input: Input, result: WebAutomaticInputResult): WebAutomaticInputResult => {
    if (result.kind !== "waiting" || recordedWaiting.has(result)) return result;
    const state = progress.get(key(input.task)), snapshot = result.snapshot;
    const purpose = state?.pending?.purpose ?? (["not_submitted", "dispatching", "unknown"].includes(snapshot.initialInputState) ? "initial" : state?.assignmentAccepted ? "ping" : "assignment");
    const activity = ["initializing", "idle", "working", "waiting_input", "stopped", "unknown"].includes(snapshot.activity) ? snapshot.activity : "invalid";
    const detail = result.reason === "native_input" ? `${result.reason}:activity=${activity},send=${snapshot.capabilities.send === true},turn=${snapshot.currentTurnId === null ? "none" : "present"}` : result.reason;
    try { options.event?.(input.task, { purpose, operationId: state?.pending?.operationId ?? null, executionId: input.ticket.executionId,
      sessionId: input.ticket.sessionId, controllerInstanceId: input.ticket.controllerInstanceId, generation: input.ticket.executionGeneration, outcome: "waiting", detail }); } catch { /* Diagnostics do not change input outcomes. */ }
    return result;
  };
  const verifyUpgrade = async ({ task, ticket, snapshot, signal, legacyAuthority }: Input): Promise<WebAutomaticInputResult> => {
    const state = progress.get(key(task));
    if (!state || state.binding !== binding(ticket) || state.pending !== null || !matches(options.current(task), ticket, snapshot)
      || !ready(snapshot) || !["provider_accepted", "confirmed"].includes(snapshot.initialInputState)
      || snapshot.nativeSessionId === null || options.current(task).resources.nativeSession?.sessionId !== snapshot.nativeSessionId) return wait(snapshot, "native_input");
    const authority = await legacyAuthority(task, ticket, signal);
    signal.throwIfAborted();
    if (authority !== null) return wait(snapshot, authority);
    const latest = options.currentSnapshot(task, ticket);
    if (state !== progress.get(key(task)) || state.pending !== null || latest === null || !matches(options.current(task), ticket, latest)
      || !ready(latest) || !["provider_accepted", "confirmed"].includes(latest.initialInputState)
      || latest.nativeSessionId === null || options.current(task).resources.nativeSession?.sessionId !== latest.nativeSessionId) return wait(snapshot, "native_input");
    return { kind: "upgrade", snapshot: latest };
  };
  const execute = async ({ task, ticket, snapshot, protocol, signal, legacyAuthority }: StepInput): Promise<WebAutomaticInputResult> => {
    if (protocol !== undefined && protocol !== 1) throw new Error("The Controller Worker input protocol is unsupported.");
    if (!matches(options.current(task), ticket, snapshot)) return wait(snapshot, "claim_invalid");
    const state = readProgress(task, ticket, snapshot);
    if (state.pending !== null) {
      const operation = options.readOperation(task, state.pending.operationId, ticket);
      // The backend verifies the stopped predecessor and the same journal before
      // each recovered initial submission. The Controller deduplicates this ID in
      // its native queue and atomically adopts only a still-prepared operation.
      if (state.pending.purpose === "initial" && BigInt(ticket.executionGeneration) > 1n
        && snapshot.initialInputState === "not_submitted" && (operation === null || operation.state === "accepted")) state.pending = null;
      else return resolve(task, ticket, snapshot, state, operation)!;
    }

    if (["dispatching", "unknown"].includes(snapshot.initialInputState)) {
      state.pending = { purpose: "initial", operationId: ticket.initialOperationId, prompt: ticket.initialPrompt, deadline: Infinity, startedAt: options.now() };
      return resolve(task, ticket, snapshot, state, options.readOperation(task, ticket.initialOperationId, ticket))!;
    }
    if (snapshot.initialInputState === "failed") throw new Error("The original initial input failed.");
    if (!ready(snapshot)) return wait(snapshot, "native_input");
    if (snapshot.initialInputState === "not_submitted") {
      if (protocol === undefined) {
        const authority = await legacyAuthority(task, ticket, signal);
        signal.throwIfAborted();
        if (authority !== null) return wait(snapshot, authority);
        const latest = options.currentSnapshot(task, ticket);
        if (latest === null || !matches(options.current(task), ticket, latest) || !ready(latest) || latest.initialInputState !== "not_submitted") return wait(snapshot, "native_input");
        snapshot = latest;
      }
      const pending: Pending = { purpose: "initial", operationId: ticket.initialOperationId, prompt: ticket.initialPrompt, deadline: protocol === undefined ? Infinity : options.now() + 100_000, startedAt: options.now() };
      state.pending = pending;
      try {
        const response = await (options.request ?? requestController)(ticket, { kind: "submit_initial", operationId: pending.operationId }, { signal, timeoutMs: 70_000 });
        snapshot = response.snapshot;
        if (response.operation) return resolve(task, ticket, snapshot, state, response.operation)!;
        if (["provider_accepted", "confirmed"].includes(snapshot.initialInputState)) { emit(task, ticket, pending, snapshot.initialInputState); state.pending = null; if (state.initialOwned) state.assignmentAccepted = true; return { kind: "observed", snapshot }; }
        if (snapshot.initialInputState === "not_submitted") state.pending = null;
        return wait(snapshot, "native_input");
      } catch (error) { if (error instanceof ControllerIpcOutcomeUnknownError) { emit(task, ticket, pending, "transport_unknown"); return wait(snapshot, "native_input"); } throw error; }
    }
    if (!["provider_accepted", "confirmed"].includes(snapshot.initialInputState)) return wait(snapshot, "native_input");
    if (protocol === undefined) return verifyUpgrade({ task, ticket, snapshot, signal, legacyAuthority });
    if (snapshot.nativeSessionId === null || options.current(task).resources.nativeSession?.sessionId !== snapshot.nativeSessionId) return wait(snapshot, "native_input");
    if (options.preparePromptSource) await options.preparePromptSource(task.projectId, signal);
    const tuple = options.promptSource?.current(task.projectId);
    if (options.promptSource !== undefined && tuple == null) return wait(snapshot, "prompt_unknown");
    const latest = options.current(task);
    if (!matches(latest, ticket, snapshot)) return wait(snapshot, "claim_invalid");
    const purpose: Purpose = state.assignmentAccepted ? "ping" : "assignment";
    const base = purpose === "ping" ? workerPingPrompt(latest) : options.buildPrompt(latest);
    const prompt = tuple == null ? base : appendWorkerPrompts(base, tuple);
    const pending: Pending = { purpose, operationId: randomUUID(), prompt, deadline: options.now() + 30_000, startedAt: options.now() };
    if (!preflight(ticket, pending.operationId, prompt, pending.deadline)) return wait(snapshot, "prompt_too_large");
    state.pending = pending;
    try {
      const response = await (options.request ?? requestController)(ticket, { kind: "submit_worker_input", operationId: pending.operationId, prompt, deadline: pending.deadline }, { signal, timeoutMs: 70_000 });
      snapshot = response.snapshot;
      if (!response.inputResult) throw new Error("Controller Worker input result is missing.");
      if (response.inputResult.kind === "waiting") {
        state.pending = null;
        const reason = response.inputResult.reason;
        emit(task, ticket, pending, "waiting", reason);
        const result = wait(snapshot, reason === "task_paused" || reason === "claim_invalid" ? reason : "native_input");
        recordedWaiting.add(result);
        return result;
      }
      return resolve(task, ticket, snapshot, state, response.inputResult.operation)!;
    } catch (error) { if (error instanceof ControllerIpcOutcomeUnknownError) { emit(task, ticket, pending, "transport_unknown"); return wait(snapshot, "native_input"); } throw error; }
  };
  const step = (input: StepInput): Promise<WebAutomaticInputResult> => {
    const id = key(input.task), existing = running.get(id);
    if (existing) return existing;
    const result = execute(input).then(value => waitEvent(input, value));
    running.set(id, result);
    void result.finally(() => { if (running.get(id) === result) running.delete(id); }).catch(() => {});
    return result;
  };
  const confirmUpgrade = async (input: Input): Promise<WebAutomaticInputResult> => waitEvent(input, await verifyUpgrade(input));
  const forget = (task: LocalTask): void => { progress.delete(key(task)); };
  const close = (): void => { progress.clear(); };
  return { step, confirmUpgrade, forget, close };
};
