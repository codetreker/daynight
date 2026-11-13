import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AssistantTaskItem, JsonValue } from "../../../../api/assistant-task.js";
import type { TaskSessionObservation } from "../../../../api/task-observation.js";
import { assistantTaskPages } from "../assistant-task-pages.js";
import { ASSISTANT_TASK_INTERVAL_MS, type AssistantApplicationContext, type AssistantApplicationFactory, type AssistantTaskClock } from "../assistant-tasks.js";
import { matchingWatchdogRule } from "./watchdog-rules.js";

export type WatchdogCategory = "stalled" | "disconnected" | "waiting_input" | "no_execution" | "unobservable";
export const WATCHDOG_DURATION: Readonly<Record<WatchdogCategory, number>> = { stalled: 600_000, disconnected: 300_000, waiting_input: 600_000, no_execution: 600_000, unobservable: 900_000 };
export type WatchdogObservation = { projectId: string; taskId: string; title: string; inScope: boolean; taskStatus?: string; assignedTo?: string | null; session: TaskSessionObservation; textEvidence?: Record<string, TextEvidence> };
export type WatchdogProgress = { entryId: string; entrySeq: string; revision: string };
export type WatchdogHistory = { complete: boolean; lastEntryId: string | null; lastProgressId: string | null; progress: WatchdogProgress | null; headSeq: string | null; lastAssistantText: string | null; lastInputAt: number | null; untimedInputId?: string; inputQuietSince?: number; inputQuietObservedAt?: number };
export type WatchdogSource = {
  /** A complete inventory; a partial project or task listing must throw. */
  scan(signal: AbortSignal, prior?: WatchdogObservation[]): Promise<WatchdogObservation[]>;
  history(observation: WatchdogObservation, signal: AbortSignal): Promise<WatchdogHistory>;
  send(observation: WatchdogObservation, operationId: string, text: string, signal: AbortSignal, expectedHistory?: WatchdogHistory, beforeSubmit?: () => Promise<boolean>): Promise<string>;
  operation(observation: WatchdogObservation, operationId: string, signal: AbortSignal): Promise<string>;
};
type Notice = { id: string; recordId: string; type: string; kind: "fact" | "action" | "unknown"; text: string; payload: JsonValue };
type TextEvidence = { bytes: number; sha256: string; truncated: boolean };
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const summarize = (text: string): { preview: string; evidence: TextEvidence } => ({ preview: text.slice(0, 1024), evidence: { bytes: Buffer.byteLength(text), sha256: digest(text), truncated: text.length > 1024 } });
const snapshot = (observation: WatchdogObservation): WatchdogObservation => {
  const result = structuredClone(observation), title = summarize(result.title);
  if (title.evidence.truncated) { result.title = title.preview; result.textEvidence = { ...result.textEvidence, title: title.evidence }; }
  if (result.session.error !== null) {
    const message = summarize(result.session.error.message);
    if (message.evidence.truncated) {
      result.session = { ...result.session, error: { ...result.session.error, message: message.preview } };
      result.textEvidence = { ...result.textEvidence, "session.error.message": message.evidence };
    }
  }
  return result;
};
type Attempt = { operationId: string; ruleId: string; message: string; manualVersion?: string; ruleIndex?: number; messageEvidence?: TextEvidence; ruleIdEvidence?: TextEvidence; at: number; followUpSince?: number; historyId: string | null; progressId?: string | null; progressBaseline?: { headSeq: string; entry: WatchdogProgress | null }; observation: WatchdogObservation; result: string; notifiedResult: string | null; escalated: boolean; progressed: boolean };
export type WatchdogState = { schemaVersion: 1; since: number; reportedCategory: WatchdogCategory | null; reportedAt: number | null; closedAt: number | null; recurrence: boolean; observation: WatchdogObservation; attempt: Attempt | null; notices: Notice[]; inputQuiet?: { identity: string; since: number; observedAt: number } | null };
export const watchdogHistoryIdentity = (observation: WatchdogObservation, history: WatchdogHistory): string => digest(JSON.stringify([
  observation.session.sessionId, observation.session.claimId, observation.session.executionGeneration, observation.session.connectionEpoch,
  history.untimedInputId, history.lastEntryId, history.lastAssistantText,
]));
export const watchdogInputIsQuiet = (history: WatchdogHistory, now: number): boolean => {
  if (!history.complete) return false;
  if (history.untimedInputId !== undefined && (history.inputQuietObservedAt === undefined || !Number.isFinite(history.inputQuietObservedAt)
    || now < history.inputQuietObservedAt || now - history.inputQuietObservedAt > ASSISTANT_TASK_INTERVAL_MS * 2)) return false;
  const since = history.untimedInputId === undefined ? history.lastInputAt : history.inputQuietSince;
  return since === null || typeof since === "number" && Number.isFinite(since) && now - since >= 120_000;
};
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const confirmed = (state: string): boolean => ["provider_accepted", "confirmed"].includes(state);
const terminal = (state: string): boolean => confirmed(state) || ["failed", "rejected", "expired"].includes(state);
const clockDefault: AssistantTaskClock = { now: Date.now, wait: (ms, signal) => delay(ms, undefined, { signal }) };

export const classifyWatchdogObservation = (observation: WatchdogObservation, now: number): WatchdogCategory | null => {
  if (!observation.inScope) return null;
  const session = observation.session;
  if (session.observation !== "observed" || session.error !== null || session.freshUntil !== null && Date.parse(session.freshUntil) <= now) return "unobservable";
  if (["no_execution", "not_registered"].includes(session.reason) || ["not_registered", "not_applicable"].includes(session.registration)) return "no_execution";
  if (session.indicator === "notice") return "waiting_input";
  if (session.indicator === "warning" && (["disconnected", "stopped"].includes(session.reason) || session.lifecycle !== "active")) return "disconnected";
  if (session.indicator === "warning" && session.reason === "idle") return "stalled";
  if (session.activity === "unknown" || session.registration === "unknown") return "unobservable";
  return null;
};

const readState = (item: AssistantTaskItem): WatchdogState => {
  const value = item.appState as unknown as WatchdogState;
  if (value?.schemaVersion !== 1 || !Number.isFinite(value.since) || !Array.isArray(value.notices) || typeof value.recurrence !== "boolean" || !value.observation || value.observation.taskId !== item.key || !Object.hasOwn(value, "attempt")) throw new Error("Invalid persisted Watchdog item; original evidence is retained.");
  return structuredClone(value);
};
const notice = (state: WatchdogState, type: string, text: string, payload: unknown, kind: Notice["kind"] = "fact"): void => {
  state.notices.push({ id: randomUUID(), recordId: randomUUID(), type, kind, text, payload: json(payload) });
};

export const createWatchdogEvaluator = (context: AssistantApplicationContext, source: WatchdogSource, options: { clock?: AssistantTaskClock } = {}) => {
  const clock = options.clock ?? clockDefault;
  const save = async (item: AssistantTaskItem, state: WatchdogState, existing = true): Promise<AssistantTaskItem> => context.withClaim((api, task, credential) => api.saveItem(task.id, {
    ...credential, ...(existing ? { ifVersion: item.version } : { id: item.id }), key: item.key, episode: item.episode,
    state: item.state, category: item.category, appState: json(state),
  }, existing ? item.id : undefined));

  // The persisted outbox survives an item update, a lost response and a new holder.
  // Read each resource before deciding a write; the IDs preserve API idempotency.
  const flush = async (input: AssistantTaskItem, state: WatchdogState): Promise<AssistantTaskItem> => {
    let item = input;
    while (state.notices.length) {
      const current = state.notices[0]!;
      let recorded = false, delivered = false;
      for await (const record of assistantTaskPages(query => context.withClaim((api, task) => api.listRecords(task.id, query)), { itemId: item.id })) if (record.id === current.recordId) { recorded = true; break; }
      if (!recorded) await context.withClaim((api, task, credential) => api.addRecord(task.id, { ...credential, id: current.recordId, itemId: item.id, kind: current.kind, text: current.text, refs: current.payload }));
      for await (const event of assistantTaskPages(query => context.withClaim((api, task) => api.listEvents(task.id, query)))) if (event.id === current.id) { delivered = true; break; }
      if (!delivered) await context.withClaim((api, task, credential) => api.addEvent(task.id, { ...credential, id: current.id, targetBotId: context.botId, type: current.type, payload: current.payload }));
      state.notices.shift();
      item = await save(item, state);
    }
    return item;
  };
  const history = async (observation: WatchdogObservation): Promise<WatchdogHistory> => {
    try { return await source.history(observation, context.signal); }
    catch { context.signal.throwIfAborted(); return { complete: false, lastEntryId: null, lastProgressId: null, progress: null, headSeq: null, lastAssistantText: null, lastInputAt: null }; }
  };
  const updateAttempt = async (item: AssistantTaskItem, state: WatchdogState, observation: WatchdogObservation, now: number): Promise<void> => {
    const attempt = state.attempt;
    if (!attempt) return;
    if (!terminal(attempt.result) || attempt.followUpSince === undefined) {
      try {
        const result = await source.operation(attempt.observation, attempt.operationId, context.signal);
        if (!terminal(attempt.result)) attempt.result = result;
      }
      catch { context.signal.throwIfAborted(); if (!terminal(attempt.result)) attempt.result = "unknown"; }
      // Recovery cannot reconstruct submission time from the prepared intent.
      // Start a conservative follow-up interval after observing the original
      // operation, retaining any baseline already persisted by the sender.
      if (attempt.followUpSince === undefined) attempt.followUpSince = clock.now();
    }
    if (attempt.notifiedResult === null || terminal(attempt.result) && attempt.notifiedResult !== attempt.result) {
      const success = confirmed(attempt.result);
      notice(state, success ? "direct_success" : terminal(attempt.result) ? "escalation" : "result_unknown",
        success ? "Watchdog message was accepted by the Session provider." : terminal(attempt.result) ? "Watchdog message was not accepted; user attention is required." : "Watchdog message outcome is unknown; only the original operation will be queried.",
        { itemId: item.id, projectId: observation.projectId, taskId: observation.taskId, operationId: attempt.operationId,
          ruleId: summarize(attempt.ruleId).preview, message: summarize(attempt.message).preview,
          ruleIdEvidence: attempt.ruleIdEvidence ?? summarize(attempt.ruleId).evidence, messageEvidence: attempt.messageEvidence ?? summarize(attempt.message).evidence,
          messageRef: attempt.manualVersion === undefined ? { itemId: item.id, path: "appState.attempt.message" }
            : { assistantTaskId: context.task.id, manualVersion: attempt.manualVersion, ruleIndex: attempt.ruleIndex, path: "action.message" },
          result: attempt.result }, success ? "action" : "unknown");
      attempt.notifiedResult = attempt.result;
      if (terminal(attempt.result) && !success) attempt.escalated = true;
    }
    if (observation.session.observation === "observed" && observation.session.activity === "working" && classifyWatchdogObservation(observation, now) === null) attempt.progressed = true;
    if (!attempt.progressed && observation.session.sessionId === attempt.observation.session.sessionId) {
      const latest = await history(observation);
      if (latest.headSeq !== null) {
        const candidate = latest.progress;
        if (attempt.progressBaseline === undefined) {
          // Old IDs prove neither ordering nor an empty history. Establish a
          // conservative sequence floor without rewriting the original IDs.
          const legacyId = attempt.progressId ?? attempt.historyId?.match(/^.+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[1-9][0-9]*)$/i)?.[1];
          const legacyRevision = candidate && legacyId?.startsWith(`${candidate.entryId}/`) ? legacyId.slice(candidate.entryId.length + 1) : undefined;
          const entry = candidate && legacyRevision !== undefined && /^[1-9][0-9]*$/.test(legacyRevision) ? { ...candidate, revision: legacyRevision } : candidate;
          attempt.progressBaseline = { headSeq: latest.headSeq, entry };
        }
        const baseline = attempt.progressBaseline;
        if (candidate !== null && (BigInt(candidate.entrySeq) > BigInt(baseline.headSeq)
          || baseline.entry !== null && candidate.entryId === baseline.entry.entryId && candidate.entrySeq === baseline.entry.entrySeq
            && BigInt(candidate.revision) > BigInt(baseline.entry.revision))) attempt.progressed = true;
      }
    }
    if (!attempt.escalated && !attempt.progressed && clock.now() - attempt.followUpSince! >= 600_000) {
      attempt.escalated = true;
      notice(state, "escalation", "No new Session history or working activity was observed within the ten-minute follow-up interval.", { itemId: item.id, projectId: observation.projectId, taskId: observation.taskId, operationId: attempt.operationId, attemptedAt: attempt.at, followUpSince: attempt.followUpSince, result: attempt.result });
    }
  };

  const advance = async (input: AssistantTaskItem, observation: WatchdogObservation, category: WatchdogCategory | null): Promise<void> => {
    let item = input;
    const state = readState(item), now = clock.now(), before = state.observation;
    // Old unreported notifications are not replayed after recovery when the target
    // is already healthy. Completed actions still retain their operation evidence.
    if ((!observation.inScope || category === null && observation.session.activity === "working") && item.state === "open") {
      state.notices = state.notices.filter(entry => !["report", "update"].includes(entry.type));
      if (state.attempt !== null) state.attempt.progressed = true;
      await updateAttempt(item, state, observation, now);
      state.observation = snapshot(observation); state.closedAt = now; item = { ...item, state: "closed" };
      if (state.reportedCategory !== null) {
        const latest = await history(observation);
        notice(state, "resolved", "The observed anomaly ended. The cause is unknown unless supported by the recorded changes.", { itemId: item.id, before: snapshot(before), after: snapshot(observation), lastInputAt: latest.lastInputAt, lastEntryId: latest.lastEntryId, historyComplete: latest.complete });
      }
      item = await save(item, state); await flush(item, state); return;
    }
    if (item.state === "closed") {
      // Closed items may still carry an uncertain operation or an outbox write.
      await updateAttempt(item, state, observation, now);
      item = await save(item, state); await flush(item, state); return;
    }
    for (const queued of state.notices.filter(entry => ["report", "update"].includes(entry.type))) {
      const payload = queued.payload as { category?: string };
      if (payload.category === category) continue;
      // Reconcile a potentially committed report before replacing its category.
      // An unsubmitted initial report must not turn the new report into an update.
      if (queued.type === "report") {
        let reported = false;
        for await (const event of assistantTaskPages(query => context.withClaim((api, task) => api.listEvents(task.id, query)))) if (event.id === queued.id) { reported = true; break; }
        if (!reported) { state.reportedCategory = null; state.reportedAt = null; }
      }
      state.notices = state.notices.filter(entry => entry.id !== queued.id);
    }
    if (item.category !== (category ?? "observing")) { item = { ...item, category: category ?? "observing" }; state.since = now; }
    state.observation = snapshot(observation);
    await updateAttempt(item, state, observation, now);
    let directHistory: WatchdogHistory | undefined;
    if (category === "stalled" && !state.recurrence && state.attempt === null) {
      directHistory = await history(observation);
      if (directHistory.complete && directHistory.untimedInputId !== undefined) {
        const observedAt = clock.now(), identity = watchdogHistoryIdentity(observation, directHistory), prior = state.inputQuiet;
        // A missing poll, changed execution/history or clock reversal starts a
        // new observation interval; an unknown timestamp is never treated as old.
        if (!prior || prior.identity !== identity || !Number.isFinite(prior.since) || !Number.isFinite(prior.observedAt)
          || observedAt < prior.observedAt || prior.since > prior.observedAt || observedAt - prior.observedAt > ASSISTANT_TASK_INTERVAL_MS * 2) {
          state.inputQuiet = { identity, since: observedAt, observedAt };
        } else state.inputQuiet = { ...prior, observedAt };
        directHistory.inputQuietSince = state.inputQuiet.since;
        directHistory.inputQuietObservedAt = observedAt;
      } else state.inputQuiet = null;
    } else state.inputQuiet = null;
    const due = category !== null && now - state.since >= WATCHDOG_DURATION[category];
    if (due && state.reportedCategory !== category) {
      const latest = await history(observation);
      notice(state, state.reportedCategory === null ? "report" : "update", "Watchdog observed a persistent Task Session anomaly; possible causes require separate evidence.", {
        itemId: item.id, projectId: observation.projectId, taskId: observation.taskId, title: state.observation.title, category, since: state.since,
        recurrence: state.recurrence, observation: state.observation.session, textEvidence: state.observation.textEvidence,
        lastAssistantText: latest.lastAssistantText === null ? null : summarize(latest.lastAssistantText).preview,
        lastAssistantTextEvidence: latest.lastAssistantText === null ? null : summarize(latest.lastAssistantText).evidence,
        lastEntryId: latest.lastEntryId, historyComplete: latest.complete,
      });
      state.reportedCategory = category;
      state.reportedAt = now;
    }
    item = await save(item, state);
    item = await flush(item, state);
    if (!due || category !== "stalled" || state.recurrence || state.attempt !== null || observation.session.send.allowed !== true) return;
    const latest = directHistory!;
    if (!watchdogInputIsQuiet(latest, clock.now())) return;
    const manual = await context.withClaim((api, task) => api.getManual(task.id));
    const rule = await matchingWatchdogRule(manual.rules, observation.projectId, latest.lastAssistantText, context.signal);
    if (!rule) return;
    const message = summarize(rule.action.message), ruleId = summarize(rule.id);
    state.attempt = { operationId: randomUUID(), ruleId: ruleId.preview, message: message.preview, manualVersion: manual.version,
      ruleIndex: (manual.rules as JsonValue[]).indexOf(rule as unknown as JsonValue), messageEvidence: message.evidence, ruleIdEvidence: ruleId.evidence,
      at: clock.now(), historyId: latest.lastEntryId, progressId: latest.lastProgressId, progressBaseline: { headSeq: latest.headSeq ?? "0", entry: latest.progress },
      observation: snapshot(observation), result: "unknown", notifiedResult: null, escalated: false, progressed: false };
    // Persist the original fence before any possible submission. A crash here is
    // intentionally recovered by queries only, never by a replacement send.
    item = await save(item, state);
    try {
      state.attempt.result = await context.withClaim(async (_api, task) => {
        if (task.manualVersion !== manual.version) return "rejected";
        return source.send(observation, state.attempt!.operationId, rule.action.message, context.signal, latest,
          () => context.withClaim(async (_currentApi, current) => current.manualVersion === manual.version));
      });
    } catch { context.signal.throwIfAborted(); state.attempt.result = "unknown"; }
    state.attempt.followUpSince = clock.now();
    await updateAttempt(item, state, observation, clock.now());
    item = await save(item, state); await flush(item, state);
  };

  return { tick: async (): Promise<void> => {
    context.signal.throwIfAborted();
    const items: AssistantTaskItem[] = [];
    for await (const item of assistantTaskPages(query => context.withClaim((api, task) => api.listItems(task.id, query)))) items.push(item);
    const prior = new Map<string, WatchdogObservation>();
    for (const item of items) {
      const state = readState(item);
      if (item.state === "open" || state.notices.length || state.attempt !== null && !terminal(state.attempt.result)) prior.set(item.key, state.observation);
    }
    const observations = await source.scan(context.signal, [...prior.values()]);
    const now = clock.now(), seen = new Set<string>();
    for (const observation of observations) {
      if (seen.has(observation.taskId)) throw new Error("Watchdog inventory contains a duplicate Task.");
      seen.add(observation.taskId);
      const related = items.filter(item => item.key === observation.taskId).sort((a, b) => BigInt(a.episode) < BigInt(b.episode) ? 1 : -1);
      let item = related.find(candidate => candidate.state === "open");
      const category = classifyWatchdogObservation(observation, now);
      if (!item && category !== null) {
        const previous = related[0], previousState = previous === undefined ? null : readState(previous);
        if (previous && previous.category === category && previousState?.closedAt !== null && previousState !== null && (previousState.reportedCategory !== null || previousState.recurrence) && now - previousState.closedAt <= 1_800_000) {
          previousState.recurrence = true; previousState.since = now; previousState.closedAt = null; previousState.reportedCategory = null; previousState.reportedAt = null; previousState.observation = snapshot(observation);
          item = await save({ ...previous, state: "open" }, previousState);
        } else {
          const state: WatchdogState = { schemaVersion: 1, since: now, reportedCategory: null, reportedAt: null, closedAt: null, recurrence: false, observation: snapshot(observation), attempt: null, notices: [] };
          item = await save({ id: randomUUID(), taskId: context.task.id, key: observation.taskId, episode: previous === undefined ? "1" : String(BigInt(previous.episode) + 1n), category, state: "open", version: "0" } as AssistantTaskItem, state, false);
        }
      }
      if (item) await advance(item, observation, category);
      else if (related[0]) await advance(related[0], observation, category);
      for (const previous of related) {
        if (previous.id === item?.id || item === undefined && previous.id === related[0]?.id || previous.state !== "closed") continue;
        const state = readState(previous);
        if (state.notices.length || state.attempt !== null && !terminal(state.attempt.result)) await advance(previous, observation, category);
      }
    }
  } };
};

export const createWatchdogApplication = (source: WatchdogSource, options: { clock?: AssistantTaskClock; onError?(error: unknown): void } = {}): AssistantApplicationFactory => async context => {
  const clock = options.clock ?? clockDefault, evaluator = createWatchdogEvaluator(context, source, { clock });
  while (!context.signal.aborted) {
    const start = clock.now();
    try { await evaluator.tick(); } catch (error) { if (!context.signal.aborted) options.onError?.(error); }
    if (context.signal.aborted) return;
    try { await clock.wait(Math.max(1, ASSISTANT_TASK_INTERVAL_MS - (clock.now() - start)), context.signal); }
    catch (error) { if (!context.signal.aborted) throw error; }
  }
};
