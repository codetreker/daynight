import type { Task, TaskGraph } from "../../src/api/types.js";
import type { ObservedTaskGraph } from "../../src/api/task-observation.js";

export const projectId = "11111111-1111-4111-8111-111111111111";
export const taskId = "22222222-2222-4222-8222-222222222222";
export const sessionId = "33333333-3333-4333-8333-333333333333";
export const claimId = "44444444-4444-4444-8444-444444444444";
export const actorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const time = "2026-11-10T01:02:03.123456789Z";
export const project = { id: projectId, name: "Project", repoUrl: "git@github.com:Org/Repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", version: 1n }, createdAt: time, updatedAt: time };
export const task: Task = { type: "task", parentId: null,
  id: taskId, projectId, assignedTo: actorId, title: "Task", description: "Body", tags: [], properties: {}, status: "in_progress", allowAgents: true, requiredPlatform: null,
  version: 9_007_199_254_740_993n, startedAt: time, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false,
};
export const observation = {
  schemaVersion: 1, observation: "observed", registration: "registered", sessionId, nativeSessionId: "native-identity", claimId,
  executionGeneration: "9007199254740993", connectionEpoch: "3", agentControlMode: "web", contentKind: "native_timeline", provider: "codex",
  indicator: "warning", reason: "idle", activity: "idle", connectionState: "connected", lifecycle: "active", currentTurnId: null,
  needsAttention: true, send: { allowed: true, mode: "start", reason: "allowed" }, observedAt: time, lastSeenAt: time,
  freshUntil: "2026-11-10T01:02:33.123456789Z", error: null,
} as const;
export const notApplicableObservation = {
  schemaVersion: 1, observation: "observed", registration: "not_applicable", sessionId: null, nativeSessionId: null, claimId: null,
  executionGeneration: null, connectionEpoch: null, agentControlMode: null, contentKind: null, provider: null,
  indicator: null, reason: "not_started", activity: null, connectionState: null, lifecycle: null, currentTurnId: null,
  needsAttention: null, send: { allowed: false, mode: null, reason: "not_applicable" }, observedAt: time, lastSeenAt: null,
  freshUntil: null, error: null,
} as const;
export const inspection = {
  schemaVersion: 1, projectId, taskId, sessionId, currentBinding: true,
  fence: { sessionId, claimId, executionGeneration: observation.executionGeneration, connectionEpoch: "3" }, source: "live", session: observation,
} as const;
export const aggregation = { indicator: "warning", workingCount: 0, noticeCount: 0, warningCount: 1, unknownCount: 0, complete: true, observedAt: time } as const;
export const workGroup = {
  groupId: taskId, kind: "task", displayTaskId: taskId, titlePreview: "Task", titleTruncated: false, assignedTo: actorId,
  aggregationScope: "accessible_in_progress_members", memberCount: 1, matchedCount: 1, inProgressCount: 1, rootCount: 1,
  roots: [{ taskId, titlePreview: "Task", titleTruncated: false }], rootsTruncated: false, summary: aggregation,
  targets: [{ taskId, assignedTo: actorId, matchesAssignee: true, sessionId, indicator: "warning", reason: "idle", send: observation.send }],
  contributorCursor: null, observedAt: time,
} as const;
export const workPage = { groups: [workGroup], nextCursor: null, observedAt: time, partial: false } as const;
export const observedGraph = (() => {
  const { projectId: _project, title, description: _description, tags: _tags, version: _version, properties: _properties, ...node } = task;
  return { project, observedAt: time, summary: { total: 1, proposed: 0, todo: 0, inProgress: 1, done: 0, cancelled: 0, ready: 0, blocked: 0 }, tasks: [{ ...node, titlePreview: title, titleTruncated: false, session: observation, relation: "member" }], sessionSummary: aggregation, partial: false } as const;
})();

export const withTaskObservation = <T>(value: T) => ({ ...value, session: notApplicableObservation });
export const withGraphObservations = (graph: TaskGraph, focus: string): ObservedTaskGraph => {
  const members = new Set([focus]);
  const remaining = [...graph.tasks];
  for (let previous = -1; previous !== members.size;) {
    previous = members.size;
    for (const task of remaining) for (const dependency of task.dependsOn.filter(id => !task.externalDependsOn.includes(id))) {
      if (members.has(task.id) || members.has(dependency)) { members.add(task.id); members.add(dependency); }
    }
  }
  return { ...graph, tasks: graph.tasks.map(task => ({ ...withTaskObservation(task), relation: members.has(task.id) ? "member" : "external" })), sessionSummary: { indicator: null, workingCount: 0, noticeCount: 0, warningCount: 0, unknownCount: 0, complete: true, observedAt: time }, partial: false };
};

// Legacy command fixtures provide Task facts; negotiated reads also supply a
// fixed no-Session observation, without starting a Session or changing writes.
export const observedFixtureResponse = (value: unknown, requestUrl: string): unknown => {
  const url = new URL(requestUrl, "http://localhost");
  if (url.searchParams.get("include") !== "session" || typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const data = value as Record<string, unknown>;
  if (Array.isArray(data.tasks)) return withGraphObservations(value as TaskGraph, url.searchParams.get("taskId")!);
  if (Array.isArray(data.items)) return { ...data, items: data.items.map(withTaskObservation), observedAt: time, partial: false };
  return Object.hasOwn(data, "description") && Object.hasOwn(data, "projectId") ? withTaskObservation(data) : value;
};
