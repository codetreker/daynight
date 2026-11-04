import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalId } from "../../../api/parse.js";
import { readWorkerClaim, readTaskPaused } from "../../../api/task-properties.js";
import { createOperation, type Operation } from "../../../api/operation.js";
import type { Task } from "../../../api/types.js";
import { canonicalSessionJson, SessionV2Error, SESSION_V2_PROTOCOL } from "../../../session/v2/values.js";
import type { SessionV2Message, TerminalBinding } from "../../../session/v2/types.js";
import { createWorkerHerdr, HerdrAgentActionError } from "../herdr.js";
import type { WorkerHerdrAdapter } from "../herdr.js";
import type { HerdrAgentObservation, HerdrExecutionContext, HerdrExecutionOwner, HerdrTaskBinding } from "./agents.js";
import { openHerdrLifecycleStore, herdrLedgerHash } from "./lifecycle-store.js";
import { connectHerdrSession, publishHerdrLedger } from "./session-connection.js";
import type { HerdrLifecycleRecord, HerdrLocalRun, HerdrRunPhase } from "./lifecycle-types.js";
import { createMacProcessControl } from "./native-macos.js";
import { createHerdrSessionApi } from "./session-api.js";
import { resolveHerdrInstancePaths } from "./instance.js";

import { openHerdrInputStore } from "./input-store.js";
import { createHerdrInputArbiter, type HerdrInputArbiter } from "./input-arbiter.js";
import type { HerdrInputTarget } from "./input-types.js";
import { inspectHerdrInput } from "./input-readiness.js";
import { submitTerminalInput, type TerminalInput } from "./terminal-input.js";
import { createHerdrRpcClient } from "./rpc.js";
import { createHerdrInputSession } from "./input-session.js";

type BaseOptions = Parameters<typeof createWorkerHerdr>[0];
type Identity = HerdrExecutionOwner;
const identity = (record: HerdrLifecycleRecord): Identity => ({ ...record.owner, claimId: record.claimId });
const current = (record: HerdrLifecycleRecord): HerdrLocalRun => {
  const run = record.runs.at(-1);
  if (!run) throw new Error("The original Herdr runtime has no durable identity.");
  return run;
};
const contextFor = (record: HerdrLifecycleRecord): HerdrExecutionContext => ({ ...identity(record), cwd: record.cwd, agent: record.owner.provider });
const bindingFor = (run: HerdrLocalRun): HerdrTaskBinding => ({ session: run.run.binding.sessionId, workspaceId: run.run.binding.workspaceId, paneId: String(run.run.binding.paneId), terminalId: run.run.binding.terminalId });
const key = (owner: Identity): string => `${owner.projectId}/${owner.taskId}/${owner.claimId}`;

export const herdrRunDirectory = (root: string, instanceId: string): string => {
  if (!path.isAbsolute(root) || canonicalId(instanceId) !== instanceId) throw new Error("Herdr instance directory requires an absolute root and canonical instance UUID.");
  return path.join(root, "r", Buffer.from(instanceId.replaceAll("-", ""), "hex").toString("base64url"));
};

export const assertHerdrRecovery = (run: { phase: HerdrRunPhase; nativeSessionId: string | null; initialAssignment: HerdrLifecycleRecord["initialAssignment"] }): void => {
  if (run.phase !== "stopped_confirmed") throw new Error("The original Herdr run has no confirmed stop; replacement startup is prohibited.");
  if (run.nativeSessionId === null) throw new Error("The original native session identity is unknown; recovery cannot create another conversation.");
  if (run.initialAssignment !== "transport_completed") throw new Error("The original initial input is unconfirmed; automatic recovery requires explicit resolution.");
};

/** Each run owns a daemon so stopping its PTY cannot affect another task. */
export const createDurableWorkerHerdr = (options: BaseOptions & {
  serverOrigin: string;
  serverToken: string;
  workerId: string;
  readTask: (projectId: string, taskId: string, signal: AbortSignal) => Promise<Task>;
  processControl?: ReturnType<typeof createMacProcessControl>;
  sessionApi?: ReturnType<typeof createHerdrSessionApi>;
  createAdapter?: typeof createWorkerHerdr;
  inspectInput?: typeof inspectHerdrInput;
  submitInput?: typeof submitTerminalInput;
}) : WorkerHerdrAdapter => {
  mkdirSync(options.paths.workerDirectory, { recursive: true, mode: 0o700 });
  const store = openHerdrLifecycleStore(path.join(options.paths.workerDirectory, "herdr-executions.sqlite"));
  const inheritedSessions = new Set(store.list().map(record => record.sessionId));
  const inputStore = openHerdrInputStore(path.join(options.paths.workerDirectory, "herdr-inputs.sqlite"));
  const arbiters = new Map<string, HerdrInputArbiter>();
  const nativeBatches = new Map<string, { written: boolean; width: number; height: number }>();
  const inputFailures = new Map<string, Error>();
  const promptGuards = new Map<string, (operation: Operation) => Promise<boolean>>();
  const bridgeRegistrations = new Set<string>();
  const disconnectedBeforeInput = new Set<string>();
  const native = options.processControl ?? createMacProcessControl();
  const apiFor = (operation: Operation) => {
    if (options.sessionApi) return options.sessionApi;
    const http = createHerdrSessionApi(options.serverOrigin, options.serverToken, { timeoutMs: operation.limits.requestMs });
    return { ...http, register: async (...args: Parameters<typeof http.register>) => {
      const request = args[0], owner = { ...request.payload.owner, claimId: request.claimId }, record = need(owner);
      if (current(record).phase !== "active" || record.segments.at(-1)?.endedAt !== null) return http.register(...args);
      bridgeRegistrations.add(record.sessionId);
      return inputSession.register(...args);
    } };
  };
  const createAdapter = options.createAdapter ?? createWorkerHerdr;
  const adapters = new Map<string, ReturnType<typeof createWorkerHerdr>>();
  const connected = new Set<string>();
  const attachedRuns = new Set<string>();
  const locks = new Map<string, Promise<void>>();
  const legacy = createAdapter(options);
  const need = (owner: Identity): HerdrLifecycleRecord => {
    const record = store.get(owner);
    if (!record || record.owner.workerId !== options.workerId || record.owner.serverOrigin !== options.serverOrigin || record.owner.worktreeId !== owner.worktreeId) throw new Error("The original Herdr execution evidence is missing or belongs to another owner; resources are retained.");
    return record;
  };
  const update = (owner: Identity, change: (record: HerdrLifecycleRecord) => void): HerdrLifecycleRecord => store.update(need(owner), change);
  const serialize = async <T>(owner: Identity, action: () => Promise<T>): Promise<T> => {
    const name = key(owner), previous = locks.get(name) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate); locks.set(name, tail);
    await previous;
    try { return await action(); }
    finally { release(); if (locks.get(name) === tail) locks.delete(name); }
  };
  const verifyClaim = async (owner: Identity, operation: Operation, input: boolean): Promise<Task> => {
    const task = await options.readTask(owner.projectId, owner.taskId, operation.signal);
    const claim = readWorkerClaim(task.properties);
    if (task.projectId !== owner.projectId || task.id !== owner.taskId || task.status !== "in_progress" || !task.allowAgents || !claim || claim.state !== "active" || claim.claimId !== owner.claimId || claim.workerId !== options.workerId || claim.worktreeId !== owner.worktreeId || claim.agentControlMode !== "herdr") throw new Error("The original active Herdr claim no longer authorizes native execution.");
    if (input && readTaskPaused(task.properties) === true) throw new HerdrAgentActionError("The task is paused; input was not submitted.", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" });
    return task;
  };
  const adapter = (record: HerdrLifecycleRecord, directory = current(record).instanceDirectory) => {
    let value = adapters.get(directory);
    if (!value) {
      const owner = identity(record);
      value = createAdapter({ ...options, paths: { ...options.paths, herdrDirectory: directory, logsDirectory: path.join(directory, "logs") },
        retainOnStartupFailure: true, isolatedRun: true,
        onDaemonSpawn: async pid => {
          const daemon = await native.capture(pid, "daemon");
          update(owner, draft => {
            if (!draft.preparation || draft.preparation.instanceDirectory !== directory || draft.preparation.phase !== "launch_requested") throw new Error("The Herdr launch no longer owns its preparation intent.");
            draft.preparation.daemon = daemon;
          });
        },
      });
      adapters.set(directory, value);
    }
    return value;
  };
  const envelope = (record: HerdrLifecycleRecord) => ({ protocol: SESSION_V2_PROTOCOL, schemaVersion: 2 as const, projectionVersion: 1 as const, sessionId: record.sessionId, claimId: record.claimId,
    executionGeneration: current(record).run.executionGeneration, agentControlMode: "herdr" as const, contentKind: "terminal_recording" as const });
  const connect = async (owner: Identity, operation: Operation): Promise<void> => {
    const record = need(owner);
    if (connected.has(record.sessionId) && record.registrationRequest === null) return;
    await connectHerdrSession(store, owner, apiFor(operation), operation.signal);
    if (bridgeRegistrations.has(record.sessionId)) inputSession.activate(record.sessionId);
    connected.add(record.sessionId);
  };
  const publish = async (owner: Identity, operation: Operation): Promise<void> => {
    const record = need(owner);
    if (current(record).phase !== "stopped_confirmed" || record.connectionEpoch === null) await connect(owner, operation);
    await publishHerdrLedger(store, owner, apiFor(operation), operation.signal);
  };
  const verifyRuntime = async (record: HerdrLifecycleRecord): Promise<void> => {
    const run = current(record);
    if (!run.daemon || run.processes.length < 2 || !run.processes.some(p => p.role === "shell") || !run.processes.some(p => p.role === "agent")) throw new Error("The original shell and native process evidence is incomplete.");
    for (const endpoint of [adapter(record).paths.apiEndpoint, adapter(record).paths.clientEndpoint]) {
      const peer = await native.peer(endpoint);
      if (JSON.stringify(peer.auditToken) !== JSON.stringify(run.daemon.auditToken) || peer.birthToken !== run.daemon.birthToken || peer.bootId !== run.daemon.bootId) throw new Error("The private Herdr daemon was replaced.");
    }
    for (const proof of [run.daemon, ...run.processes]) if (await native.observe(proof) !== "same") throw new Error("An original Herdr process is unavailable or changed; automatic input is prohibited.");
  };
  const inputTarget = (record: HerdrLifecycleRecord): HerdrInputTarget => {
    const run = current(record), segment = record.segments.at(-1);
    if (record.connectionEpoch === null || !segment || segment.executionGeneration !== run.run.executionGeneration || segment.endedAt !== null) throw new SessionV2Error("automation_suspended");
    return { sessionId: record.sessionId, claimId: record.claimId, executionGeneration: run.run.executionGeneration, connectionEpoch: record.connectionEpoch, segmentId: segment.segmentId, binding: { ...run.run.binding } };
  };
  const matchesInput = (record: HerdrLifecycleRecord, target: HerdrInputTarget): boolean => {
    const fresh = inputTarget(record);
    return canonicalSessionJson({ ...target, binding: { ...target.binding, nativeSessionId: fresh.binding.nativeSessionId } }) === canonicalSessionJson(fresh) && (target.binding.nativeSessionId === null || target.binding.nativeSessionId === fresh.binding.nativeSessionId);
  };
  const inspect = async (record: HerdrLifecycleRecord, purpose: "automatic" | "manual" | "resume" | "cleanup", operation: Operation) => {
    const local = adapter(record), context = contextFor(record), binding = bindingFor(current(record));
    return (options.inspectInput ?? inspectHerdrInput)({ binding, provider: record.owner.provider, purpose, operation,
      observe: () => local.tasks.observe(context, binding, operation), rpc: createHerdrRpcClient(local.paths.apiEndpoint) });
  };
  const getInput = (owner: Identity, allowRecovery = false): HerdrInputArbiter => {
    const record = need(owner);
    if (inputFailures.has(record.sessionId)) throw new Error("The original input journal could not persist suspension; input remains disabled.", { cause: inputFailures.get(record.sessionId) });
    let arbiter = arbiters.get(record.sessionId);
    if (arbiter && current(record).phase !== "active" && current(record).run.executionGeneration === arbiter.record().target.executionGeneration) return arbiter;
    const target = inputTarget(record);
    if (arbiter) { arbiter.bind(target, { allowRecovery }); return arbiter; }
    const hadJournal = inputStore.get(record.sessionId) !== null;
    const initialized = inputStore.bind(target, !hadJournal && inheritedSessions.has(record.sessionId) ? "unconfirmed" : record.initialAssignment, record.controlEpoch, { allowRecovery });
    if (!hadJournal && (record.automationBlocked || disconnectedBeforeInput.has(record.sessionId))) inputStore.update(initialized, draft => { draft.state = "suspended"; draft.unknownInput = true; });
    arbiter = createHerdrInputArbiter({ store: inputStore, sessionId: record.sessionId,
      verify: async (expected, purpose, signal) => {
        const operation = createOperation({ ...(signal ? { signal } : {}), limits: { totalMs: 10_000 } });
        try {
          const fresh = need(owner);
          if (inputFailures.has(fresh.sessionId)) throw new SessionV2Error("source_corrupt");
          if (!matchesInput(fresh, expected) || current(fresh).phase !== "active") throw new SessionV2Error("stale_fence");
          if (purpose === "cleanup") {
            const task = await options.readTask(owner.projectId, owner.taskId, operation.signal), claim = readWorkerClaim(task.properties);
            if (!claim || claim.claimId !== owner.claimId || claim.workerId !== options.workerId || claim.worktreeId !== owner.worktreeId || !task.allowAgents || readTaskPaused(task.properties) === true) throw new SessionV2Error("permission_denied");
          } else { try { await verifyClaim(owner, operation, true); } catch { throw new SessionV2Error("permission_denied"); } }
          try { await verifyRuntime(fresh); } catch { throw new SessionV2Error("target_changed"); }
          // Lease requests use only read-only ownership/readiness checks; no native attach occurs here.
          const batch = nativeBatches.get(fresh.sessionId);
          // Paste intentionally makes the composer nonempty. Subsequent frames
          // retain authority and target checks without rejecting this batch's own text.
          const readiness = await inspect(fresh, batch?.written ? "manual" : purpose, operation);
          if (batch && (batch.width !== readiness.width || batch.height !== readiness.height)) throw new SessionV2Error("target_changed");
          const guard = purpose === "automatic" ? promptGuards.get(fresh.sessionId) : undefined;
          if (guard && !await guard(operation)) throw new SessionV2Error("automation_suspended");
          try { await verifyRuntime(need(owner)); } catch { throw new SessionV2Error("target_changed"); }
          const input = inputStore.get(fresh.sessionId);
          const manualWrite = input?.operations.some(value => value.source === "web" && value.result.state === "dispatching") === true;
          if (purpose !== "cleanup") {
            const remote = await (options.sessionApi ?? createHerdrSessionApi(options.serverOrigin, options.serverToken, { timeoutMs: 10_000 })).state({ owner: fresh.owner, sessionId: fresh.sessionId, claimId: fresh.claimId }, operation.signal);
            if (!remote.connected || remote.connectionEpoch !== fresh.connectionEpoch || remote.executionGeneration !== expected.executionGeneration) throw new SessionV2Error("stale_fence");
            if (manualWrite && (remote.control?.state !== "manual" || remote.control.controlEpoch !== input!.controlEpoch || canonicalSessionJson(remote.control.lease) !== canonicalSessionJson(input!.lease))) throw new SessionV2Error("lease_expired");
            if (purpose === "automatic" && remote.control !== null && (remote.control.state !== "automation" || remote.control.controlEpoch !== input?.controlEpoch)) throw new SessionV2Error("automation_suspended");
          }
          if (inputFailures.has(fresh.sessionId)) throw new SessionV2Error("source_corrupt");
        } finally { operation.dispose(); }
      },
      execute: async (batch, write) => {
        const fresh = need(owner), operation = createOperation({ signal: write.signal, limits: { totalMs: 10_000 } });
        let progress: { written: boolean; width: number; height: number } | undefined;
        try {
          const readiness = await inspect(fresh, batch.source === "web" ? "manual" : batch.source === "cleanup" ? "cleanup" : "automatic", operation);
          progress = { written: false, width: readiness.width, height: readiness.height };
          nativeBatches.set(fresh.sessionId, progress);
          const payload = batch.payload;
          const inputs: TerminalInput[] = payload.kind === "keys" ? [{ kind: "keys", key: payload.key }] : [{ kind: "paste", text: payload.text }, ...(payload.kind === "prompt" ? [{ kind: "keys" as const, key: "Enter" as const }] : [])];
          // Every prompt is a single bounded paste followed by a separate Enter frame.
          // Oversize prompts fail before attach rather than submitting a truncated assignment.
          let transportError: Error | undefined;
          const outcome = await (options.submitInput ?? submitTerminalInput)({ endpoint: adapter(fresh).paths.clientEndpoint, terminalId: batch.target.binding.terminalId, ...readiness, inputs, signal: write.signal,
            beforeWrite: async () => { try { await write.beforeWrite(); } catch (error) { transportError = error instanceof Error ? error : new Error(String(error)); throw error; } }, onWrite: () => { write.markWritten(); progress!.written = true; } });
          if (outcome.status !== "transport_completed") throw transportError ?? new Error(outcome.reason);
        } finally { if (nativeBatches.get(fresh.sessionId) === progress) nativeBatches.delete(fresh.sessionId); operation.dispose(); }
      },
    });
    arbiters.set(record.sessionId, arbiter); return arbiter;
  };
  const inputSession = createHerdrInputSession({ serverToken: options.serverToken, getRecord: need,
    api: () => options.sessionApi ?? createHerdrSessionApi(options.serverOrigin, options.serverToken, { timeoutMs: 10_000 }),
    state: owner => getInput(owner).state(),
    control: (owner, message, signal) => getInput(owner).control(message, signal),
    input: (owner, message, signal) => getInput(owner).input(message, signal),
    onError: (owner, error) => { inputFailures.set(need(owner).sessionId, error); },
    suspend: owner => {
      const record = need(owner), input = arbiters.get(record.sessionId);
      if (input) input.suspend();
      else disconnectedBeforeInput.add(record.sessionId);
      connected.delete(record.sessionId);
    },
  });
  const enrich = (owner: Identity, observed: HerdrAgentObservation): void => {
    if (observed.nativeSession === null) return;
    update(owner, draft => {
      const run = current(draft), id = observed.nativeSession!.sessionId;
      if (run.run.binding.nativeSessionId !== null && run.run.binding.nativeSessionId !== id) throw new Error("The native conversation identity changed.");
      run.run.binding.nativeSessionId = id;
      for (const segment of draft.segments.filter(segment => segment.executionGeneration === run.run.executionGeneration && segment.endedAt === null)) segment.binding.nativeSessionId = id;
    });
    const input = arbiters.get(need(owner).sessionId);
    if (input && need(owner).segments.at(-1)?.endedAt === null) input.bind(inputTarget(need(owner)));
  };
  const send = async (context: HerdrExecutionContext, prompt: string, operation: Operation, guard?: (operation: Operation) => Promise<boolean>) => {
    const record = need(context), run = current(record), arbiter = getInput(context);
    if (run.phase !== "active" || arbiter.state().state !== "automation" || arbiter.record().unknownInput) throw new HerdrAgentActionError("The original input admission is not available.", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" });
    await verifyClaim(context, operation, true); await verifyRuntime(record);
    if (guard && !await guard(operation)) return { submission: "skipped" as const, observation: await adapter(record).tasks.observe(context, bindingFor(run), operation) };
    const initial = arbiter.record().initialOutcome === "pending";
    const body = initial ? record.initialPrompt : prompt;
    if (body === null) throw new Error("The original pending assignment body is missing.");
    const operationId = initial ? arbiter.record().initialOperationId : randomUUID();
    update(context, draft => { current(draft).admission = operationId; if (initial) draft.initialAssignment = "dispatching"; });
    if (guard) promptGuards.set(record.sessionId, guard);
    const result = await arbiter.submit({ operationId, source: initial ? "initial" : "continuation", text: body }, operation.signal).finally(() => { promptGuards.delete(record.sessionId); });
    update(context, draft => {
      current(draft).admission = null;
      if (initial) draft.initialAssignment = result.state === "transport_completed" ? "transport_completed" : result.state === "rejected" ? "pending" : "unknown";
      else if (result.state === "unknown") draft.automationBlocked = true;
    });
    if (result.state !== "transport_completed") throw new HerdrAgentActionError(`The original input admission returned ${result.state}: ${result.errorCode ?? "input_unknown"}.`, "agent.prompt", result.state === "rejected" ? "not-submitted" : "unknown", { promptSubmission: result.state === "rejected" ? "not-submitted" : "unknown" });
    const observed = await adapter(need(context)).tasks.observe(context, bindingFor(run), operation); enrich(context, observed);
    return { submission: "submitted" as const, observation: observed };
  };
  const finishStop = async (owner: Identity, operation: Operation): Promise<void> => {
    // Each segment ends at its own run boundary, including after interrupted closure.
    update(owner, draft => {
      for (const segment of draft.segments) {
        if (segment.endedAt !== null) continue;
        const run = draft.runs.find(value => value.run.executionGeneration === segment.executionGeneration);
        if (run?.phase !== "stopped_confirmed" || run.run.stoppedAt === null) throw new Error("An open segment has no confirmed original run stop.");
        segment.endedAt = run.run.stoppedAt;
        segment.durationMs = String(Math.max(0, Date.parse(segment.endedAt) - Date.parse(segment.startedAt)));
      }
    });
    await publish(owner, operation);
  };
  const stop = async (owner: Identity, reason: "shutdown" | "terminal", operation: Operation): Promise<void> => {
    const before = need(owner);
    let input = arbiters.get(before.sessionId);
    let inputJournalError: unknown;
    try {
      if (!input && before.runs.at(-1)?.phase === "active" && before.segments.at(-1)?.endedAt === null) input = getInput(owner);
      input?.beginClosing();
    } catch (error) { inputJournalError = error; }
    try { inputSession.close(before.sessionId); } catch (error) { inputJournalError ??= error; }
    bridgeRegistrations.delete(before.sessionId);
    await serialize(owner, async () => {
    let record = need(owner);
    if (record.runs.length === 0 && record.preparation === null) return;
    let run = current(record);
    if (run.phase !== "stopped_confirmed") {
      if (run.stopOperationId === null && run.daemon !== null && await native.observe(run.daemon) !== "same" && await native.bootIdentity() === run.daemon.bootId) {
        update(owner, draft => { current(draft).phase = "stop_unknown"; current(draft).error = "The original daemon disappeared without a durable stop intent."; });
        throw new Error("Herdr stop_unknown: absence without a durable stop intent cannot prove controlled resource shutdown.");
      }
      try { record = update(owner, draft => { const r = current(draft); r.phase = "stop_intent"; r.stopReason ??= reason; r.stopOperationId ??= randomUUID(); r.admission = null; draft.controlEpoch = String(BigInt(draft.controlEpoch) + 1n); if (draft.initialAssignment === "dispatching") draft.initialAssignment = "unknown"; }); }
      catch (journalError) {
        // A failed journal cannot authorize a durable stop conclusion, even if emergency signaling succeeds.
        if (run.daemon !== null) await native.stopExclusiveRun({ daemon: run.daemon, processes: run.processes }, operation);
        throw new Error("Herdr stop journal could not commit; emergency stop remains unconfirmed and resources must be retained.", { cause: journalError });
      }
      run = current(record);
      if (run.daemon === null) { update(owner, draft => { current(draft).phase = "stop_unknown"; current(draft).error = "Original daemon identity is missing."; }); throw new Error("Herdr stop_unknown: original daemon identity is missing."); }
      try { update(owner, draft => { current(draft).phase = "close_requested"; }); }
      catch (journalError) {
        await native.stopExclusiveRun({ daemon: run.daemon, processes: run.processes }, operation);
        throw new Error("Herdr close journal could not commit; emergency stop remains unconfirmed.", { cause: journalError });
      }
      const outcome = await native.stopExclusiveRun({ daemon: run.daemon, processes: run.processes, onDiscovered: async proof => { update(owner, draft => { current(draft).processes.push(proof); }); } }, operation);
      if (outcome.state !== "stopped_confirmed" || !run.processes.some(p => p.role === "shell") || !run.processes.some(p => p.role === "agent")) {
        update(owner, draft => { current(draft).phase = "stop_unknown"; current(draft).error = outcome.reason ?? "The original shell/native resource evidence is incomplete."; });
        throw new Error(`Herdr stop_unknown: ${outcome.reason ?? "original resource proof is incomplete"}`);
      }
      const stoppedAt = new Date().toISOString();
      record = update(owner, draft => { const r = current(draft); r.phase = "stopped_confirmed"; r.error = null; r.run.stoppedAt = stoppedAt;
        r.run.stopProof = { recordId: r.stopOperationId!, executionGeneration: r.run.executionGeneration, binding: { ...r.run.binding }, bootId: r.daemon!.bootId, stoppedAt,
          method: outcome.method ?? "instances_exited", terminalStopped: true, processes: r.processes.map(p => ({ role: p.role === "shell" ? "shell" : "agent", pid: p.pid, birthToken: p.birthToken, bootId: p.bootId })) };
      });
    }
    // Segment closure is a separate recoverable boundary after the stop proof commits.
    await finishStop(owner, operation);
    if (reason === "terminal" && input && !inputJournalError) input.close();
    });
    if (inputJournalError) throw new Error("The input closing journal could not commit; native stopping was attempted but input evidence remains unavailable.", { cause: inputJournalError });
  };
  const attachRun = async (owner: Identity, operation: Operation): Promise<void> => {
    const record = need(owner), run = current(record), runKey = `${record.sessionId}/${run.run.executionGeneration}`;
    if (run.phase !== "active" || attachedRuns.has(runKey)) return;
    await verifyRuntime(record);
    await connect(owner, operation);
    update(owner, draft => {
      const r = current(draft), previous = draft.segments.at(-1), segmentId = randomUUID();
      // No recorder is enabled yet. Recovery cannot extend an uncheckpointed segment across downtime.
      for (const segment of draft.segments) if (segment.endedAt === null) { segment.endedAt = segment.startedAt; segment.durationMs = "0"; }
      r.run.segmentIds.push(segmentId);
      draft.segments.push({ segmentId, segmentOrdinal: String(draft.segments.length + 1), executionGeneration: r.run.executionGeneration, binding: { ...r.run.binding }, startedAt: new Date().toISOString(), endedAt: null, durationMs: null,
        gap: previous ? { kind: "boundary", reason: "restart", from: { executionGeneration: previous.executionGeneration, segmentId: previous.segmentId }, to: { executionGeneration: r.run.executionGeneration, segmentId } } : null });
    });
    await publish(owner, operation);
    attachedRuns.add(runKey);
  };
  for (const record of store.list()) { store.recover(record); if (inputStore.get(record.sessionId)) inputStore.recover(record.sessionId); }
  const tasks: ReturnType<typeof createWorkerHerdr>["tasks"] = {
    ...legacy.tasks,
    pendingStops: () => store.list().filter(record => record.runs.length > 0 && (["stop_intent", "close_requested", "stop_unknown"].includes(current(record).phase) || current(record).phase === "stopped_confirmed" && (record.segments.some(segment => segment.endedAt === null) || record.publishedLedgerHash !== herdrLedgerHash(record)))).map(record => ({ context: contextFor(record), binding: bindingFor(current(record)) })),
    listResources: async operation => {
      const result = [];
      for (const record of store.list()) {
        if (record.owner.serverOrigin !== options.serverOrigin || record.runs.length === 0 || current(record).phase === "stopped_confirmed") continue;
        const run = current(record);
        try { result.push(...await adapter(record).tasks.listResources(operation)); }
        catch { if (run.phase === "active") update(identity(record), draft => { current(draft).phase = "stop_unknown"; current(draft).error = "The original private daemon could not be observed."; }); }
      }
      return result;
    },
    prepareWorkspace: (context, title, operation) => serialize(context, async () => {
      await verifyClaim(context, operation, false);
      let record = need(context);
      if (record.runs.length === 0) {
        const state = await apiFor(operation).current({ owner: record.owner, claimId: record.claimId }, operation.signal);
        if (state.status !== "not_registered") throw new Error("An existing Session has no matching local runtime; replacement startup is prohibited.");
      }
      if (record.runs.length > 0 && (current(record).phase === "active" || current(record).phase === "prepared")) {
        const run = current(record);
        if (run.daemon === null || await native.observe(run.daemon) !== "same" || await native.observe(run.processes[0]!) !== "same") throw new Error("The original prepared runtime changed.");
        return bindingFor(run);
      }
      if (record.runs.length > 0 && current(record).phase === "stopped_confirmed") {
        await finishStop(context, operation);
        record = need(context);
      }
      if (record.runs.length > 0) await connect(context, operation);
      if (record.runs.length > 0 && (!inputStore.get(record.sessionId) || inputStore.get(record.sessionId)!.unknownInput)) throw new Error("The original input journal is missing or unknown; automatic runtime recovery requires explicit resolution.");
      if (record.runs.length > 0) assertHerdrRecovery({ phase: current(record).phase, nativeSessionId: current(record).run.binding.nativeSessionId, initialAssignment: inputStore.get(record.sessionId)?.initialDisposition ? "transport_completed" : record.initialAssignment });
      if (record.preparation !== null) throw new Error("A previous Herdr preparation is unconfirmed; no replacement daemon may start.");
      const instanceId = randomUUID(), instanceDirectory = herdrRunDirectory(options.paths.herdrDirectory, instanceId);
      // Validate the native socket budget before persisting a preparation that could launch.
      resolveHerdrInstancePaths({ herdrDirectory: instanceDirectory, logsDirectory: path.join(instanceDirectory, "logs") });
      record = update(context, draft => { draft.preparation = { instanceId, instanceDirectory, phase: "prepared", daemon: null }; });
      record = update(context, draft => { draft.preparation!.phase = "launch_requested"; });
      const local = adapter(record, instanceDirectory);
      await local.ensureInstance(operation);
      const peer = await native.peer(local.paths.apiEndpoint);
      record = need(context);
      if (!record.preparation?.daemon || JSON.stringify(record.preparation.daemon.auditToken) !== JSON.stringify(peer.auditToken)) throw new Error("The prepared Herdr endpoint does not belong to its original daemon.");
      const binding = await local.tasks.prepareWorkspace(context, title, operation);
      const processInfo = await local.tasks.processInfo(context, binding, operation);
      let shell = await native.capture(processInfo.shellPid, "shell");
      for (;;) {
        await delay(50, undefined, { signal: operation.signal }); operation.check();
        const sampled = await native.capture(processInfo.shellPid, "shell");
        if (sampled.birthToken !== shell.birthToken || sampled.bootId !== shell.bootId) throw new Error("The prepared shell was replaced before identity registration.");
        if (JSON.stringify(sampled.auditToken) === JSON.stringify(shell.auditToken)) break;
        shell = sampled;
      }
      const generation = String(record.runs.length + 1), startedAt = new Date().toISOString();
      const terminal: TerminalBinding = { instanceId, sessionId: binding.session, workspaceId: binding.workspaceId, paneId: binding.paneId, terminalId: binding.terminalId, nativeSessionId: record.runs.at(-1)?.run.binding.nativeSessionId ?? null };
      record = update(context, draft => { draft.runs.push({ run: { executionGeneration: generation, owner: draft.owner, binding: terminal, startedAt, stoppedAt: null, stopProof: null, segmentIds: [] }, phase: "prepared", instanceDirectory, daemon: draft.preparation!.daemon, processes: [shell], stopOperationId: null, stopReason: null, error: null, admission: null }); draft.preparation = null; });
      await publish(context, operation);
      return binding;
    }),
    start: (context, binding, input, operation) => serialize(context, async () => {
      let record = need(context), run = current(record);
      if (run.phase !== "prepared" || JSON.stringify(bindingFor(run)) !== JSON.stringify(binding)) throw new Error("Native launch requires the original prepared Herdr run.");
      const beforeStart = async (active: Operation): Promise<void> => {
        const fresh = need(context), target = current(fresh), shell = run.processes.find(proof => proof.role === "shell");
        if (target.run.executionGeneration !== run.run.executionGeneration || !["prepared", "launch_requested"].includes(target.phase)) throw new Error("The original native launch no longer owns its prepared run.");
        await verifyClaim(context, active, false);
        if (run.daemon === null || shell === undefined || await native.observe(run.daemon) !== "same" || await native.observe(shell) !== "same") throw new Error("The original prepared runtime changed before native launch.");
        const peer = await native.peer(adapter(fresh).paths.apiEndpoint);
        if (JSON.stringify(peer.auditToken) !== JSON.stringify(run.daemon.auditToken) || peer.bootId !== run.daemon.bootId || peer.birthToken !== run.daemon.birthToken) throw new Error("The original daemon endpoint was replaced before native launch.");
        active.check();
      };
      await beforeStart(operation);
      await publish(context, operation);
      record = update(context, draft => { current(draft).phase = "launch_requested"; if (draft.initialAssignment === "pending") draft.initialPrompt = input.prompt; });
      const manager = adapter(record).tasks;
      const observed = await manager.launch(context, binding, { configuration: input.configuration, beforeStart, ...(run.run.binding.nativeSessionId === null ? {} : { resumeSessionId: run.run.binding.nativeSessionId }) }, operation);
      const info = await manager.processInfo(context, binding, operation);
      if (info.shellPid !== run.processes.find(p => p.role === "shell")?.pid) throw new Error("The original shell changed while launching the native agent.");
      const agents = await Promise.all(info.foregroundPids.filter(pid => pid !== info.shellPid).map(pid => native.capture(pid, "agent")));
      if (agents.length === 0) throw new Error("The original native agent has no identifiable foreground process; input remains closed.");
      update(context, draft => { current(draft).processes.push(...agents); current(draft).phase = "active"; });
      enrich(context, observed);
      update(context, draft => {
        const r = current(draft), segmentId = randomUUID(), previous = draft.segments.at(-1);
        r.run.segmentIds.push(segmentId);
        draft.segments.push({ segmentId, segmentOrdinal: String(draft.segments.length + 1), executionGeneration: r.run.executionGeneration, binding: { ...r.run.binding }, startedAt: new Date().toISOString(), endedAt: null, durationMs: null,
          gap: previous ? { kind: "boundary", reason: "restart", from: { executionGeneration: previous.executionGeneration, segmentId: previous.segmentId }, to: { executionGeneration: r.run.executionGeneration, segmentId } } : null });
      });
      // Preparation uses HTTP registration. Start the input channel only after a
      // real active segment exists, so slow native launch cannot time out its channel.
      await publish(context, operation);
      if (!options.sessionApi) { connected.delete(record.sessionId); await connect(context, operation); }
      getInput(context, true);
      if (!options.sessionApi) await inputSession.poll(record.sessionId);
      attachedRuns.add(`${record.sessionId}/${run.run.executionGeneration}`);
      if (observed.status === "blocked") throw new HerdrAgentActionError("The native agent requires operator action before input.", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" });
      if (getInput(context).state().state !== "automation") return observed;
      const receipt = await send(context, need(context).initialAssignment === "pending" ? input.prompt : "Continue the original assigned task under its existing authorization.", operation);
      if (receipt.submission === "submitted") input.onPromptSubmitted?.(receipt);
      const after = await manager.observe(context, binding, operation); enrich(context, after); return after;
    }),
    observe: (context, binding, operation) => serialize(context, async () => { await attachRun(context, operation); const record = need(context); const observed = await adapter(record).tasks.observe(context, binding, operation); enrich(context, observed); return observed; }),
    submitPrompt: (context, binding, prompt, operation, guard) => serialize(context, () => { if (canonicalSessionJson(binding) !== canonicalSessionJson(bindingFor(current(need(context))))) throw new SessionV2Error("target_changed"); return send(context, prompt, operation, guard); }),
    submitInitialPrompt: (context, binding, prompt, operation, guard) => serialize(context, () => { if (canonicalSessionJson(binding) !== canonicalSessionJson(bindingFor(current(need(context))))) throw new SessionV2Error("target_changed"); return send(context, prompt, operation, guard); }),
    launch: async () => { throw new Error("Native launch must pass the durable Herdr admission path."); },
    processInfo: (context, binding, operation) => adapter(need(context)).tasks.processInfo(context, binding, operation),
    syncWorkspaceName: async (context, binding, title, operation) => { const record = need(context); if (record.runs.length > 0 && current(record).phase === "active") await adapter(record).tasks.syncWorkspaceName(context, binding, title, operation); },
    stopAndClose: (context, _binding, operation) => stop(context, "shutdown", operation),
  };
  return { ...legacy, tasks, ensureInstance: async () => ({ reconnected: true, version: "0.9.5", protocol: 22, snapshot: {} }),
    stopInstance: async () => { throw new Error("Durable Herdr runs must be stopped by their original process identities."); },
    input: {
      state: owner => getInput(owner).state(),
      control: (owner, message, operation) => getInput(owner).control(message, operation.signal),
      submit: (owner, message, operation) => getInput(owner).input(message, operation.signal),
      suspend: owner => { getInput(owner).suspend(); },
    },
    lifecycle: {
      registerClaim: (context, ownerUserId) => {
        const previous = store.get(context);
        if (previous !== null) { need(context); return; }
        store.create({ owner: { projectId: context.projectId, taskId: context.taskId, workerId: options.workerId, worktreeId: context.worktreeId, ownerUserId, serverOrigin: options.serverOrigin, provider: context.agent }, claimId: context.claimId, cwd: context.cwd });
      },
      assertCanAdvance: context => { const record = store.get(context); if (!record) throw new Error("The original Herdr launch provenance is missing."); if (record.preparation !== null) throw new Error("The original Herdr preparation remains unconfirmed."); if (record.runs.length === 0) return; const run = current(record); if (run.phase === "active" || run.phase === "prepared") return; assertHerdrRecovery({ phase: run.phase, nativeSessionId: run.run.binding.nativeSessionId, initialAssignment: inputStore.get(record.sessionId)?.initialDisposition ? "transport_completed" : record.initialAssignment }); },
      responsibilities: () => store.list().filter(record => record.owner.serverOrigin === options.serverOrigin).map(identity),
      hasPreparedRun: owner => { const record = store.get(owner); return record !== null && record.preparation === null && record.runs.at(-1)?.phase === "prepared"; },
      isStopped: owner => { const record = store.get(owner); return record !== null && record.preparation === null && record.ledgerRequest === null && (record.runs.length === 0 || current(record).phase === "stopped_confirmed" && record.publishedLedgerHash === herdrLedgerHash(record)) && record.segments.every(segment => segment.endedAt !== null); },
      cleanup: async (owner, prompt, operation) => {
        let notified = false;
        const record = need(owner);
        try { if (record.runs.at(-1)?.phase === "active" && record.segments.at(-1)?.endedAt === null) {
          const input = getInput(owner);
          const { canNotify } = input.beginClosing();
          if (canNotify) {
            const operationId = input.record().cleanupOperationId;
            update(owner, draft => { current(draft).admission = operationId; });
            try { notified = (await input.submit({ operationId, source: "cleanup", text: prompt }, operation.signal)).state === "transport_completed"; }
            finally { update(owner, draft => { current(draft).admission = null; }); }
          }
        } } catch { notified = false; }
        await stop(owner, "terminal", operation);
        return notified;
      },
      stop,
      close: () => { inputSession.close(); inputStore.close(); store.close(); },
    },
  };
};
