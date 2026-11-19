import { choice, decimalSequence, nullable } from "./task-observation.js";
import { array, bool, fields, id, malformed, text, timestamp } from "./validation.js";

export type TaskSessionHistoryDirectoryItem = {
  readonly taskId: string; readonly sessionId: string; readonly claimId: string; readonly executionGeneration: string;
  readonly agentControlMode: "web" | "herdr"; readonly contentKind: "native_timeline" | "terminal_recording";
  readonly createdAt: string; readonly endedAt: string | null; readonly currentBinding: boolean;
  readonly archiveState: "pending" | "unavailable" | "failed" | "ready" | "partial" | "expired";
  readonly completeness: string | null;
  readonly expiresAt: string | null; readonly expiredAt: string | null;
  readonly reason: string; readonly retentionState: "waiting" | "unknown" | "scheduled" | "expired";
  readonly scopeEndedAt: string | null; readonly firstArchivedAt: string | null; readonly legacyGraceStartedAt: string | null;
};
export type TaskSessionHistoryDirectory = {
  readonly version: 1; readonly graphVersion: string; readonly items: readonly TaskSessionHistoryDirectoryItem[];
  readonly nextCursor: string | null; readonly observedAt: string;
};

const directoryTimestamp = (value: unknown): string => {
  const parsed = text(value);
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(parsed);
  if (offset === null) return timestamp(parsed);
  if (Number(offset[2]) > 23 || Number(offset[3]) > 59) return malformed();
  // Validate the local calendar fields without letting Date.parse normalize an
  // invalid day; PostgreSQL timestamps can retain the server's numeric offset.
  timestamp(`${parsed.slice(0, -offset[0].length)}Z`);
  return parsed;
};
const nullableDirectoryTimestamp = (value: unknown): string | null => nullable(value, directoryTimestamp);

export const parseTaskSessionHistoryDirectory = (value: unknown, taskId: string, limit: number): TaskSessionHistoryDirectory => {
  const data = fields(value, ["version", "graphVersion", "items", "nextCursor", "observedAt"]);
  // The shared JSON decoder preserves numeric version fields as bigint.
  if (data.version !== 1n && data.version !== 1) return malformed();
  const items = array(data.items, raw => {
    const item = fields(raw, ["taskId", "sessionId", "claimId", "executionGeneration", "agentControlMode", "contentKind", "createdAt", "endedAt", "currentBinding", "archiveState", "completeness", "expiresAt", "expiredAt", "reason", "retentionState", "scopeEndedAt", "firstArchivedAt", "legacyGraceStartedAt"]);
    if (id(item.taskId) !== taskId) return malformed();
    const agentControlMode = choice(item.agentControlMode, ["web", "herdr"]), contentKind = choice(item.contentKind, ["native_timeline", "terminal_recording"]);
    const executionGeneration = decimalSequence(item.executionGeneration);
    if ((agentControlMode === "web") !== (contentKind === "native_timeline") || executionGeneration === "0") return malformed();
    return {
      taskId, sessionId: id(item.sessionId), claimId: id(item.claimId), executionGeneration, agentControlMode, contentKind,
      createdAt: directoryTimestamp(item.createdAt), endedAt: nullableDirectoryTimestamp(item.endedAt), currentBinding: bool(item.currentBinding),
      archiveState: choice(item.archiveState, ["pending", "unavailable", "failed", "ready", "partial", "expired"]), completeness: nullable(item.completeness, text),
      expiresAt: nullableDirectoryTimestamp(item.expiresAt), expiredAt: nullableDirectoryTimestamp(item.expiredAt), reason: text(item.reason, true),
      retentionState: choice(item.retentionState, ["waiting", "unknown", "scheduled", "expired"]), scopeEndedAt: nullableDirectoryTimestamp(item.scopeEndedAt),
      firstArchivedAt: nullableDirectoryTimestamp(item.firstArchivedAt), legacyGraceStartedAt: nullableDirectoryTimestamp(item.legacyGraceStartedAt),
    };
  });
  if (items.length > limit || new Set(items.map(item => item.sessionId)).size !== items.length || items.filter(item => item.currentBinding).length > 1) return malformed();
  const nextCursor = nullable(data.nextCursor, value => {
    const parsed = text(value, true);
    return /^[\x21-\x7e]{1,4096}$/.test(parsed) ? parsed : malformed();
  });
  return { version: 1, graphVersion: decimalSequence(data.graphVersion), items, nextCursor, observedAt: directoryTimestamp(data.observedAt) };
};
