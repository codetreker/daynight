import { decimalSequence, parseTaskSessionObservation } from "./task-observation.js";
import type { TaskSessionObservation } from "./task-observation.js";
import { bool, fields, id, malformed } from "./validation.js";
import { choice } from "./task-observation.js";
import { resourcePath } from "./resource-path.js";
import { createTaskSessionReadClient } from "./task-session-read.js";
import type { TaskSessionReadClient } from "./task-session-read.js";

export type * from "./task-session-read.js";

export type TaskSessionInspection = {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly currentBinding: boolean;
  readonly fence: { readonly sessionId: string; readonly claimId: string; readonly executionGeneration: string; readonly connectionEpoch: string };
  readonly source: "live" | "archive" | "unavailable";
  readonly session: TaskSessionObservation;
  readonly contentReadVersion?: 0 | 1;
};
export type TaskSessionClient = TaskSessionReadClient & { inspectTaskSession(projectId: string, taskId: string, sessionId: string): Promise<TaskSessionInspection> };
export type TaskSessionRequest = {
  readonly operation: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId?: string;
  readonly path: string;
  readonly responseBytes?: number;
};
export type TaskSessionReader = <T>(request: TaskSessionRequest, parse: (value: unknown) => T) => Promise<T>;

export const parseTaskSessionInspection = (value: unknown, projectId: string, taskId: string, sessionId: string): TaskSessionInspection => {
  const data = fields(value, ["schemaVersion", "projectId", "taskId", "sessionId", "currentBinding", "fence", "source", "session", "contentReadVersion"]);
  if (data.schemaVersion !== 1 || id(data.projectId) !== projectId || id(data.taskId) !== taskId || id(data.sessionId) !== sessionId) return malformed();
  const rawFence = fields(data.fence, ["sessionId", "claimId", "executionGeneration", "connectionEpoch"]);
  const fence = { sessionId: id(rawFence.sessionId), claimId: id(rawFence.claimId), executionGeneration: decimalSequence(rawFence.executionGeneration), connectionEpoch: decimalSequence(rawFence.connectionEpoch) };
  const session = parseTaskSessionObservation(data.session);
  if (fence.sessionId !== sessionId || session.sessionId !== sessionId || session.claimId !== fence.claimId || session.executionGeneration !== fence.executionGeneration || session.connectionEpoch !== fence.connectionEpoch) return malformed();
  if (data.contentReadVersion !== undefined && data.contentReadVersion !== 0 && data.contentReadVersion !== 1) return malformed();
  return { schemaVersion: 1, projectId, taskId, sessionId, currentBinding: bool(data.currentBinding), fence, source: choice(data.source, ["live", "archive", "unavailable"]), session, ...(data.contentReadVersion === undefined ? {} : { contentReadVersion: data.contentReadVersion }) };
};

export const createTaskSessionClient = (read: TaskSessionReader): TaskSessionClient => ({
  ...createTaskSessionReadClient(read),
  inspectTaskSession: async (projectId, taskId, sessionId) => {
    const project = id(projectId.toLowerCase()), task = id(taskId.toLowerCase()), session = id(sessionId.toLowerCase());
    return read({ operation: "task.session.inspection", projectId: project, taskId: task, sessionId: session, path: resourcePath("projects", project, "tasks", task, "sessions", session, "inspection") }, value => parseTaskSessionInspection(value, project, task, session));
  },
});
