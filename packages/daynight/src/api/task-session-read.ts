import { parseTimelineEntry } from "../session/protocol.js";
import type { TimelineEntry } from "../session/protocol.js";
import { choice, decimalSequence, nullable } from "./task-observation.js";
import { parseTaskSessionInspection } from "./task-session.js";
import type { TaskSessionInspection, TaskSessionReader } from "./task-session.js";
import { array, bool, fields, id, malformed, nullableTimestamp, text, timestamp } from "./validation.js";
import { resourcePath } from "./resource-path.js";

export type TaskSessionCurrent = {
  readonly status: "registered" | "not_registered" | "not_applicable";
  readonly claimId: string | null;
  readonly agentControlMode: "web" | "herdr" | null;
  readonly session: TaskSessionInspection | null;
};
export type TaskSessionDirectoryItem = {
  readonly sessionId: string; readonly claimId: string; readonly executionGeneration: string;
  readonly agentControlMode: "web" | "herdr"; readonly contentKind: "native_timeline" | "terminal_recording";
  readonly createdAt: string; readonly endedAt: string | null; readonly currentBinding: boolean;
  readonly archive: { readonly state: string; readonly sha256: string | null; readonly byteLength: string | null; readonly completeness: string | null };
};
export type TaskSessionDirectory = { readonly items: readonly TaskSessionDirectoryItem[]; readonly nextCursor: string | null };
export type TaskSessionResource = {
  readonly resourceId: string; readonly status: "pending" | "available" | "failed" | "unavailable";
  readonly name: string; readonly mediaType: string | null; readonly byteLength: string | null; readonly sha256: string | null;
};
export type TaskSessionMessage = {
  readonly entryId: string; readonly entrySeq: string; readonly revision: string; readonly kind: TimelineEntry["kind"];
  readonly role: string | null; readonly timestamp: string | null; readonly body: TimelineEntry | null;
  readonly truncated: boolean; readonly contentRef: { readonly cursor: string; readonly sha256: string; readonly byteLength: string } | null;
  readonly resources: readonly TaskSessionResource[]; readonly resourcesTruncated: boolean;
};
export type TaskSessionMessagePage = {
  readonly sessionId: string; readonly historyEpoch: string; readonly source: "live" | "archive";
  readonly items: readonly TaskSessionMessage[]; readonly beforeCursor: string | null; readonly hasMoreBefore: boolean;
  readonly coverage: { readonly state: "complete" | "partial"; readonly reason: string | null }; readonly observedAt: string;
};
export type TaskSessionEntryChunk = {
  readonly sessionId: string; readonly historyEpoch: string; readonly source: "live" | "archive";
  readonly entryId: string; readonly revision: string; readonly sha256: string; readonly byteLength: string;
  readonly offset: string; readonly fragment: string; readonly nextCursor: string | null; readonly eof: boolean; readonly observedAt: string;
};
export type TaskSessionListQuery = { readonly limit?: number; readonly cursor?: string };
export type TaskSessionReadQuery = { readonly limit?: number; readonly before?: string; readonly conversation?: boolean };
export type TaskSessionReadClient = {
  currentTaskSession(projectId: string, taskId: string): Promise<TaskSessionCurrent>;
  listTaskSessions(projectId: string, taskId: string, query?: TaskSessionListQuery): Promise<TaskSessionDirectory>;
  readTaskSession(projectId: string, taskId: string, sessionId: string, query?: TaskSessionReadQuery): Promise<TaskSessionMessagePage>;
  readTaskSessionEntry(projectId: string, taskId: string, sessionId: string, cursor: string): Promise<TaskSessionEntryChunk>;
};

const cursor = (value: unknown): string => {
  const parsed = text(value, true);
  return /^[\x21-\x7e]{1,4096}$/.test(parsed) ? parsed : malformed();
};
const hash = (value: unknown): string => {
  const parsed = text(value);
  return /^[a-f0-9]{64}$/.test(parsed) ? parsed : malformed();
};
const pageLimit = (value: number | undefined): number => value === undefined ? 20 : Number.isSafeInteger(value) && value >= 1 && value <= 200 ? value : malformed();
const mode = (value: unknown): "web" | "herdr" => choice(value, ["web", "herdr"]);
const source = (value: unknown): "live" | "archive" => choice(value, ["live", "archive"]);
const unique = <T>(items: readonly T[], key: (item: T) => string): readonly T[] => new Set(items.map(key)).size === items.length ? items : malformed();

export const parseTaskSessionCurrent = (value: unknown, projectId: string, taskId: string): TaskSessionCurrent => {
  const data = fields(value, ["status", "claimId", "agentControlMode", "session"]);
  const status = choice(data.status, ["registered", "not_registered", "not_applicable"]);
  const claimId = nullable(data.claimId, id), agentControlMode = nullable(data.agentControlMode, mode);
  const session = data.session === null ? null : parseTaskSessionInspection(data.session, projectId, taskId, id(fields(data.session, ["schemaVersion", "projectId", "taskId", "sessionId", "currentBinding", "fence", "source", "session", "contentReadVersion"]).sessionId));
  if ((status === "registered") !== (session !== null) || session !== null && (session.fence.claimId !== claimId || session.session.agentControlMode !== agentControlMode)) return malformed();
  return { status, claimId, agentControlMode, session };
};

export const parseTaskSessionDirectory = (value: unknown, limit: number): TaskSessionDirectory => {
  const data = fields(value, ["items", "nextCursor"]);
  const items = unique(array(data.items, raw => {
    const item = fields(raw, ["sessionId", "claimId", "executionGeneration", "agentControlMode", "contentKind", "createdAt", "endedAt", "currentBinding", "archive"]);
    const archive = fields(item.archive, ["state", "sha256", "byteLength", "completeness"]);
    const agentControlMode = mode(item.agentControlMode), contentKind = choice(item.contentKind, ["native_timeline", "terminal_recording"]);
    if ((agentControlMode === "web") !== (contentKind === "native_timeline")) return malformed();
    return { sessionId: id(item.sessionId), claimId: id(item.claimId), executionGeneration: decimalSequence(item.executionGeneration), agentControlMode, contentKind, createdAt: timestamp(item.createdAt), endedAt: nullableTimestamp(item.endedAt), currentBinding: bool(item.currentBinding), archive: { state: text(archive.state, true), sha256: nullable(archive.sha256, hash), byteLength: nullable(archive.byteLength, decimalSequence), completeness: nullable(archive.completeness, text) } };
  }), item => item.sessionId);
  if (items.length > limit || items.filter(item => item.currentBinding).length > 1) return malformed();
  return { items, nextCursor: nullable(data.nextCursor, cursor) };
};

const parseResource = (value: unknown): TaskSessionResource => {
  const data = fields(value, ["resourceId", "status", "name", "mediaType", "byteLength", "sha256"]);
  return { resourceId: id(data.resourceId), status: choice(data.status, ["pending", "available", "failed", "unavailable"]), name: text(data.name), mediaType: nullable(data.mediaType, text), byteLength: nullable(data.byteLength, decimalSequence), sha256: nullable(data.sha256, hash) };
};
const parseMessage = (value: unknown): TaskSessionMessage => {
  const data = fields(value, ["entryId", "entrySeq", "revision", "kind", "role", "timestamp", "body", "truncated", "contentRef", "resources", "resourcesTruncated"]);
  const entryId = id(data.entryId), entrySeq = decimalSequence(data.entrySeq), revision = decimalSequence(data.revision);
  const kind = choice(data.kind, ["user_message", "assistant_message", "reasoning", "tool_call", "interaction", "error", "compaction", "todo"]);
  const body = data.body === null ? null : parseTimelineEntry(data.body), truncated = bool(data.truncated);
  const ref = data.contentRef === null ? null : fields(data.contentRef, ["cursor", "sha256", "byteLength"]);
  const contentRef = ref === null ? null : { cursor: cursor(ref.cursor), sha256: hash(ref.sha256), byteLength: decimalSequence(ref.byteLength) };
  const resources = array(data.resources, parseResource);
  if (resources.length > 20 || truncated !== (body === null) || truncated !== (contentRef !== null) || body !== null && (body.entryId !== entryId || body.entrySeq !== entrySeq || body.revision !== revision || body.kind !== kind)) return malformed();
  return { entryId, entrySeq, revision, kind, role: nullable(data.role, text), timestamp: nullableTimestamp(data.timestamp), body, truncated, contentRef, resources, resourcesTruncated: bool(data.resourcesTruncated) };
};
export const parseTaskSessionMessagePage = (value: unknown, sessionId: string, limit: number): TaskSessionMessagePage => {
  const data = fields(value, ["sessionId", "historyEpoch", "source", "items", "beforeCursor", "hasMoreBefore", "coverage", "observedAt"]);
  if (id(data.sessionId) !== sessionId) return malformed();
  const items = unique(array(data.items, parseMessage), item => item.entryId);
  const beforeCursor = nullable(data.beforeCursor, cursor), hasMoreBefore = bool(data.hasMoreBefore);
  if (items.length > limit || hasMoreBefore && beforeCursor === null || items.some((item, index) => index > 0 && BigInt(item.entrySeq) <= BigInt(items[index - 1]!.entrySeq))) return malformed();
  const coverage = fields(data.coverage, ["state", "reason"]);
  return { sessionId, historyEpoch: text(data.historyEpoch, true), source: source(data.source), items, beforeCursor, hasMoreBefore, coverage: { state: choice(coverage.state, ["complete", "partial"]), reason: nullable(coverage.reason, text) }, observedAt: timestamp(data.observedAt) };
};
export const parseTaskSessionEntryChunk = (value: unknown, sessionId: string): TaskSessionEntryChunk => {
  const data = fields(value, ["sessionId", "historyEpoch", "source", "entryId", "revision", "sha256", "byteLength", "offset", "fragment", "nextCursor", "eof", "observedAt"]);
  if (id(data.sessionId) !== sessionId) return malformed();
  const byteLength = decimalSequence(data.byteLength), offset = decimalSequence(data.offset), fragment = text(data.fragment);
  const nextCursor = nullable(data.nextCursor, cursor), eof = bool(data.eof), bytes = Buffer.byteLength(fragment, "utf8");
  const end = BigInt(offset) + BigInt(bytes), total = BigInt(byteLength);
  if (bytes > 32768 || end > total || eof !== (end === total) || eof !== (nextCursor === null) || !eof && bytes === 0) return malformed();
  return { sessionId, historyEpoch: text(data.historyEpoch, true), source: source(data.source), entryId: id(data.entryId), revision: decimalSequence(data.revision), sha256: hash(data.sha256), byteLength, offset, fragment, nextCursor, eof, observedAt: timestamp(data.observedAt) };
};

export const createTaskSessionReadClient = (read: TaskSessionReader): TaskSessionReadClient => ({
  currentTaskSession: async (projectId, taskId) => {
    const project = id(projectId.toLowerCase()), task = id(taskId.toLowerCase());
    return read({ operation: "task.session.current", projectId: project, taskId: task, path: `${resourcePath("projects", project, "tasks", task, "sessions", "current")}?view=inspection` }, value => parseTaskSessionCurrent(value, project, task));
  },
  listTaskSessions: async (projectId, taskId, input = {}) => {
    const project = id(projectId.toLowerCase()), task = id(taskId.toLowerCase()), limit = pageLimit(input.limit);
    const query = new URLSearchParams({ view: "inspection", limit: String(limit) });
    if (input.cursor !== undefined) query.set("cursor", cursor(input.cursor));
    return read({ operation: "task.session.list", projectId: project, taskId: task, path: `${resourcePath("projects", project, "tasks", task, "sessions")}?${query}` }, value => parseTaskSessionDirectory(value, limit));
  },
  readTaskSession: async (projectId, taskId, sessionId, input = {}) => {
    const project = id(projectId.toLowerCase()), task = id(taskId.toLowerCase()), session = id(sessionId.toLowerCase()), limit = pageLimit(input.limit);
    const query = new URLSearchParams({ limit: String(limit) });
    if (input.before !== undefined) query.set("before", cursor(input.before));
    if (input.conversation === true) query.set("conversation", "true");
    return read({ operation: "task.session.read", projectId: project, taskId: task, sessionId: session, responseBytes: 262144, path: `${resourcePath("projects", project, "tasks", task, "sessions", session, "messages")}?${query}` }, value => parseTaskSessionMessagePage(value, session, limit));
  },
  readTaskSessionEntry: async (projectId, taskId, sessionId, token) => {
    const project = id(projectId.toLowerCase()), task = id(taskId.toLowerCase()), session = id(sessionId.toLowerCase());
    const query = new URLSearchParams({ cursor: cursor(token) });
    return read({ operation: "task.session.entry", projectId: project, taskId: task, sessionId: session, responseBytes: 262144, path: `${resourcePath("projects", project, "tasks", task, "sessions", session, "message-content")}?${query}` }, value => parseTaskSessionEntryChunk(value, session));
  },
});
