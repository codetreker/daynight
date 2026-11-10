import { parseSessionCommand, parseSessionOperation } from "../session/protocol.js";
import type { SessionCommand, SessionOperation } from "../session/protocol.js";
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
export type TaskSessionClient = TaskSessionReadClient & {
  inspectTaskSession(projectId: string, taskId: string, sessionId: string): Promise<TaskSessionInspection>;
  readTaskSessionOperation(target: TaskSessionOperationTarget, expected?: TaskSessionOperationExpectation, timeoutMs?: number): Promise<TaskSessionOperationRead>;
  sendTaskSessionCommand(target: TaskSessionOperationTarget, command: SessionCommand): Promise<TaskSessionOperationReceipt>;
};
export type TaskSessionRequest = {
  readonly operation: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId?: string;
  readonly path: string;
  readonly responseBytes?: number;
  readonly timeoutMs?: number;
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

export type TaskSessionWriter = <T>(request: TaskSessionRequest, body: SessionCommand, parse: (value: unknown, location: string | null) => T) => Promise<T>;
const normalizeTarget = (target: TaskSessionOperationTarget): TaskSessionOperationTarget => ({ projectId: id(target.projectId.toLowerCase()), taskId: id(target.taskId.toLowerCase()), sessionId: id(target.sessionId.toLowerCase()), operationId: id(target.operationId.toLowerCase()) });
export const createTaskSessionClient = (read: TaskSessionReader, write: TaskSessionWriter): TaskSessionClient => ({
  ...createTaskSessionReadClient(read),
  readTaskSessionOperation: async (target, expected, timeoutMs) => {
    const normalized = normalizeTarget(target);
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error("Operation read deadline must be positive.");
    return read({ ...normalized, operation: "task.session.operation", path: operationPath(normalized), ...(timeoutMs === undefined ? {} : { timeoutMs }) }, value => {
      const data = fields(value, ["operation", "currentBinding"]);
      return { operation: parseTaskSessionOperation(data.operation, normalized, expected), currentBinding: bool(data.currentBinding) };
    });
  },
  sendTaskSessionCommand: async (target, input) => {
    const normalized = normalizeTarget(target), command = parseSessionCommand(input);
    if (command.sessionId !== normalized.sessionId || command.operationId !== normalized.operationId || command.kind !== "send_message" || command.claimId === undefined) return malformed();
    if (Buffer.byteLength(JSON.stringify(command), "utf8") > SESSION_COMMAND_BYTES) throw new Error("Session command exceeds 2 MiB.");
    return write({ ...normalized, operation: "task.session.send", path: resourcePath("projects", normalized.projectId, "tasks", normalized.taskId, "sessions", normalized.sessionId, "commands") }, command, (value, location) => {
      const data = fields(value, ["operation", "operationUrl"]);
      const url = `/api/v1${operationPath(normalized)}`;
      if (data.operationUrl !== url || location !== url) return malformed();
      return { operation: parseTaskSessionOperation(data.operation, normalized, { claimId: command.claimId!, executionGeneration: command.executionGeneration, kind: "send_message" }), operationUrl: url };
    });
  },
  inspectTaskSession: async (projectId, taskId, sessionId) => {
    const project = id(projectId.toLowerCase()), task = id(taskId.toLowerCase()), session = id(sessionId.toLowerCase());
    return read({ operation: "task.session.inspection", projectId: project, taskId: task, sessionId: session, path: resourcePath("projects", project, "tasks", task, "sessions", session, "inspection") }, value => parseTaskSessionInspection(value, project, task, session));
  },
});

export type TaskSessionOperationTarget = { readonly projectId: string; readonly taskId: string; readonly sessionId: string; readonly operationId: string };
export type TaskSessionOperationExpectation = { readonly claimId?: string; readonly executionGeneration?: string; readonly kind: "send_message" };
export type TaskSessionOperationRead = { readonly operation: SessionOperation; readonly currentBinding: boolean };
export type TaskSessionOperationReceipt = { readonly operation: SessionOperation; readonly operationUrl: string };
export const SESSION_COMMAND_BYTES = 2 * 1_048_576;
const operationPath = (target: TaskSessionOperationTarget): string => resourcePath("projects", target.projectId, "tasks", target.taskId, "sessions", target.sessionId, "operations", target.operationId);
export const parseTaskSessionOperation = (value: unknown, target: TaskSessionOperationTarget, expected?: TaskSessionOperationExpectation): SessionOperation => {
  let operation: SessionOperation;
  try { operation = parseSessionOperation(value); } catch { return malformed(); }
  if (operation.sessionId !== target.sessionId || operation.operationId !== target.operationId || operation.claimId === undefined || expected !== undefined && (expected.claimId !== undefined && operation.claimId !== expected.claimId || expected.executionGeneration !== undefined && operation.executionGeneration !== expected.executionGeneration || operation.kind !== expected.kind)) return malformed();
  return operation;
};
