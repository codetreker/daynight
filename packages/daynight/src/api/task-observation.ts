import type { GraphTask, Task, TaskGraph } from "./types.js";
import { parseTask, parseTaskGraph } from "./parse.js";
import { array, bool, count, fields, id, malformed, nullableTimestamp, record, text, timestamp } from "./validation.js";

export type SessionIndicator = "working" | "notice" | "warning" | null;
export type TaskSessionSend = { readonly allowed: boolean | null; readonly mode: "start" | "steer" | null; readonly reason: string };
export type TaskSessionObservation = {
  readonly schemaVersion: 1;
  readonly observation: "observed" | "unavailable" | "unsupported";
  readonly registration: "registered" | "not_registered" | "not_applicable" | "unknown";
  readonly sessionId: string | null;
  readonly nativeSessionId: string | null;
  readonly claimId: string | null;
  readonly executionGeneration: string | null;
  readonly connectionEpoch: string | null;
  readonly agentControlMode: "web" | "herdr" | null;
  readonly contentKind: "native_timeline" | "terminal_recording" | null;
  readonly provider: string | null;
  readonly indicator: SessionIndicator;
  readonly reason: string;
  readonly activity: "initializing" | "idle" | "working" | "waiting_input" | "stopped" | "unknown" | null;
  readonly connectionState: "connected" | "disconnected" | "synchronizing" | null;
  readonly lifecycle: "active" | "draining" | "archived" | null;
  readonly currentTurnId: string | null;
  readonly needsAttention: boolean | null;
  readonly send: TaskSessionSend;
  readonly observedAt: string | null;
  readonly lastSeenAt: string | null;
  readonly freshUntil: string | null;
  readonly error: { readonly code: string; readonly message: string } | null;
};
export type ObservedTask = Task & { readonly session: TaskSessionObservation };
export type TaskObservationList = { readonly items: readonly ObservedTask[]; readonly partial: boolean; readonly unsupported: boolean };
export type SessionAggregation = {
  readonly indicator: SessionIndicator;
  readonly workingCount: number;
  readonly noticeCount: number;
  readonly warningCount: number;
  readonly unknownCount: number;
  readonly complete: boolean;
  readonly observedAt: string | null;
};
export type ObservedGraphTask = GraphTask & { readonly session: TaskSessionObservation; readonly relation: "member" | "external" };
export type ObservedTaskGraph = Omit<TaskGraph, "tasks"> & { readonly tasks: readonly ObservedGraphTask[]; readonly sessionSummary: SessionAggregation; readonly partial: boolean };

export const choice = <T extends string>(value: unknown, values: readonly T[]): T => typeof value === "string" && values.includes(value as T) ? value as T : malformed();
export const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null => value === null ? null : parse(value);
export const decimalSequence = (value: unknown): string => {
  const parsed = text(value, true);
  return /^(0|[1-9][0-9]*)$/.test(parsed) ? parsed : malformed();
};
export const sessionIndicator = (value: unknown): SessionIndicator => nullable(value, item => choice(item, ["working", "notice", "warning"]));
export const parseTaskSessionSend = (value: unknown): TaskSessionSend => {
  const data = fields(value, ["allowed", "mode", "reason"]);
  return { allowed: nullable(data.allowed, bool), mode: nullable(data.mode, item => choice(item, ["start", "steer"])), reason: text(data.reason, true) };
};
export const parseTaskSessionObservation = (value: unknown): TaskSessionObservation => {
  const data = fields(value, ["schemaVersion", "observation", "registration", "sessionId", "nativeSessionId", "claimId", "executionGeneration", "connectionEpoch", "agentControlMode", "contentKind", "provider", "indicator", "reason", "activity", "connectionState", "lifecycle", "currentTurnId", "needsAttention", "send", "observedAt", "lastSeenAt", "freshUntil", "error"]);
  if (data.schemaVersion !== 1) return malformed();
  const error = data.error === null ? null : fields(data.error, ["code", "message"]);
  return {
    schemaVersion: 1, observation: choice(data.observation, ["observed", "unavailable", "unsupported"]),
    registration: choice(data.registration, ["registered", "not_registered", "not_applicable", "unknown"]),
    sessionId: nullable(data.sessionId, id), nativeSessionId: nullable(data.nativeSessionId, text), claimId: nullable(data.claimId, id),
    executionGeneration: nullable(data.executionGeneration, decimalSequence), connectionEpoch: nullable(data.connectionEpoch, decimalSequence),
    agentControlMode: nullable(data.agentControlMode, item => choice(item, ["web", "herdr"])),
    contentKind: nullable(data.contentKind, item => choice(item, ["native_timeline", "terminal_recording"])), provider: nullable(data.provider, text),
    indicator: sessionIndicator(data.indicator), reason: text(data.reason, true),
    activity: nullable(data.activity, item => choice(item, ["initializing", "idle", "working", "waiting_input", "stopped", "unknown"])),
    connectionState: nullable(data.connectionState, item => choice(item, ["connected", "disconnected", "synchronizing"])),
    lifecycle: nullable(data.lifecycle, item => choice(item, ["active", "draining", "archived"])), currentTurnId: nullable(data.currentTurnId, text),
    needsAttention: nullable(data.needsAttention, bool), send: parseTaskSessionSend(data.send), observedAt: nullableTimestamp(data.observedAt),
    lastSeenAt: nullableTimestamp(data.lastSeenAt), freshUntil: nullableTimestamp(data.freshUntil),
    error: error === null ? null : { code: text(error.code, true), message: text(error.message) },
  };
};

export const unsupportedSessionObservation = (): TaskSessionObservation => ({
  schemaVersion: 1, observation: "unsupported", registration: "unknown", sessionId: null, nativeSessionId: null, claimId: null,
  executionGeneration: null, connectionEpoch: null, agentControlMode: null, contentKind: null, provider: null, indicator: null,
  reason: "upgrade_required", activity: null, connectionState: null, lifecycle: null, currentTurnId: null, needsAttention: null,
  send: { allowed: null, mode: null, reason: "upgrade_required" }, observedAt: null, lastSeenAt: null, freshUntil: null,
  error: { code: "unsupported", message: "Upgrade the Daynight service to read Task Session observations." },
});
export const taskObservationPartial = (session: TaskSessionObservation): boolean => session.observation !== "observed" || session.error !== null;
export const parseObservedTask = (value: unknown, projectId: string, taskId?: string): ObservedTask => {
  const task = parseTask(value, projectId, taskId);
  const data = record(value);
  return { ...task, session: Object.hasOwn(data, "session") ? parseTaskSessionObservation(data.session) : unsupportedSessionObservation() };
};
export const parseSessionAggregation = (value: unknown): SessionAggregation => {
  const data = fields(value, ["indicator", "workingCount", "noticeCount", "warningCount", "unknownCount", "complete", "observedAt"]);
  return { indicator: sessionIndicator(data.indicator), workingCount: count(data.workingCount), noticeCount: count(data.noticeCount), warningCount: count(data.warningCount), unknownCount: count(data.unknownCount), complete: bool(data.complete), observedAt: timestamp(data.observedAt) };
};

export const parseObservedTaskGraph = (value: unknown, projectId: string, taskId: string): ObservedTaskGraph => {
  const graph = parseTaskGraph(value, projectId, taskId);
  const data = record(value);
  const rawTasks = array(data.tasks, record);
  const hasObservation = Object.hasOwn(data, "sessionSummary") || Object.hasOwn(data, "partial") || rawTasks.some(task => Object.hasOwn(task, "session") || Object.hasOwn(task, "relation"));
  if (hasObservation && (!Object.hasOwn(data, "sessionSummary") || !Object.hasOwn(data, "partial"))) return malformed();
  const members = new Set([taskId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const task of graph.tasks) for (const dependency of task.dependsOn) {
      if (task.externalDependsOn.includes(dependency)) continue;
      if (members.has(task.id) && !members.has(dependency) && graph.tasks.some(candidate => candidate.id === dependency)) { members.add(dependency); changed = true; }
      if (members.has(dependency) && !members.has(task.id)) { members.add(task.id); changed = true; }
    }
  }
  const tasks = graph.tasks.map((task, index): ObservedGraphTask => {
    const raw = rawTasks[index]!;
    const relation = members.has(task.id) ? "member" : "external";
    if (Object.hasOwn(raw, "relation") && choice(raw.relation, ["member", "external"]) !== relation) return malformed();
    if (Object.hasOwn(raw, "session") && !Object.hasOwn(raw, "relation")) return malformed();
    return { ...task, relation, session: Object.hasOwn(raw, "session") ? parseTaskSessionObservation(raw.session) : unsupportedSessionObservation() };
  });
  const sessionSummary = Object.hasOwn(data, "sessionSummary") ? parseSessionAggregation(data.sessionSummary) : {
    indicator: null, workingCount: 0, noticeCount: 0, warningCount: 0, unknownCount: tasks.filter(task => task.relation === "member" && task.status === "in_progress").length,
    complete: false, observedAt: null,
  };
  const partial = Object.hasOwn(data, "partial") ? bool(data.partial) : true;
  return { ...graph, tasks, sessionSummary, partial: partial || tasks.some(task => taskObservationPartial(task.session)) };
};
