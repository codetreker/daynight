import { parseSessionResource, parseTimelineEntry, type SessionResource, type TimelineEntry } from "./protocol.js";

export const HISTORY_RESPONSE_BYTES = 262144;
export const HISTORY_CHUNK_BYTES = 32768;
export const HISTORY_CURSOR_BYTES = 4096;
export const CONTENT_READ_VERSION_HEADER = "X-Daynight-Content-Read-Version";
export type InspectionResource = Omit<SessionResource, "error">;
export type SessionContentRef = { readonly cursor: string; readonly sha256: string; readonly byteLength: string };
export type SessionMessageItem = {
  readonly entryId: string; readonly entrySeq: string; readonly revision: string; readonly kind: TimelineEntry["kind"];
  readonly role: "user" | "assistant" | null; readonly timestamp: string | null;
  readonly body: TimelineEntry | null; readonly truncated: boolean; readonly contentRef: SessionContentRef | null;
  readonly resources: readonly InspectionResource[]; readonly resourcesTruncated: boolean;
};
export type HistoryCoverage = { readonly state: "complete"; readonly reason: null } | { readonly state: "partial"; readonly reason: "entry_truncated" | "resource_unavailable" };
export type InspectionPage = { readonly kind: "inspect_page"; readonly historyEpoch: string; readonly items: readonly SessionMessageItem[]; readonly beforeCursor: string | null; readonly hasMoreBefore: boolean; readonly coverage: HistoryCoverage };
export type EntryChunk = { readonly kind: "entry_chunk"; readonly historyEpoch: string; readonly entryId: string; readonly revision: string; readonly sha256: string; readonly byteLength: string; readonly offset: string; readonly fragment: string; readonly nextCursor: string | null; readonly eof: boolean };
export type HistorySource = "live" | "archive";
export type HistoryCursorIdentity = { readonly source: HistorySource; readonly sessionId: string; readonly historyEpoch: string; readonly sourceVersion: string };
export type HistoryPageCursor = HistoryCursorIdentity & { readonly entrySeq: string };
export type HistoryEntryCursor = HistoryCursorIdentity & { readonly entryId: string; readonly revision: string; readonly sha256: string; readonly byteLength: string; readonly offset: string };
export class SessionHistoryError extends Error {
  constructor(readonly code: "invalid_input" | "reset_required" | "content_changed" | "content_unavailable" | "payload_too_large", message: string) { super(message); this.name = "SessionHistoryError"; }
}
const fail = (): never => { throw new SessionHistoryError("invalid_input", "Invalid session history value."); };
const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const data = value as Record<string, unknown>;
  return Object.keys(data).length === keys.length && keys.every(key => Object.hasOwn(data, key)) ? data : fail();
};
const uuid = (value: unknown): string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) ? value : fail();
const hash = (value: unknown): string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : fail();
const sequence = (value: unknown, zero = false): string => typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value) && (zero || value !== "0") && BigInt(value) <= 9223372036854775807n ? value : fail();
const bool = (value: unknown): boolean => typeof value === "boolean" ? value : fail();
const epoch = (value: unknown): string => typeof value === "string" && (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) || /^[a-f0-9]{64}$/.test(value)) ? value : fail();
export const historyCursorText = (value: unknown): string => typeof value === "string" && value.length > 0 && value.length <= HISTORY_CURSOR_BYTES && /^[A-Za-z0-9_-]+$/.test(value) ? value : fail();
const nullableCursor = (value: unknown): string | null => value === null ? null : historyCursorText(value);
const timestamp = (value: unknown): string | null => value === null ? null : typeof value === "string" && value.length <= 64 && /^\d{4}-\d\d-\d\dT.*Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : fail();

/** Timeline form bounds can be fractional; identity sequences remain strings. */
export const canonicalHistoryJSON = (value: unknown): string => {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return value.isWellFormed() ? JSON.stringify(value) : fail();
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : fail();
  if (Array.isArray(value)) return `[${value.map(canonicalHistoryJSON).join(",")}]`;
  if (!value || typeof value !== "object") return fail();
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${canonicalHistoryJSON(key)}:${canonicalHistoryJSON(record[key])}`).join(",")}}`;
};

export const parseSessionContentRef = (value: unknown): SessionContentRef => {
  const data = exact(value, ["cursor", "sha256", "byteLength"]);
  return { cursor: historyCursorText(data.cursor), sha256: hash(data.sha256), byteLength: sequence(data.byteLength) };
};
export const parseSessionMessageItem = (value: unknown): SessionMessageItem => {
  const data = exact(value, ["entryId", "entrySeq", "revision", "kind", "role", "timestamp", "body", "truncated", "contentRef", "resources", "resourcesTruncated"]);
  const entryId = uuid(data.entryId), entrySeq = sequence(data.entrySeq), revision = sequence(data.revision);
  const kinds: readonly TimelineEntry["kind"][] = ["user_message", "assistant_message", "reasoning", "tool_call", "interaction", "error", "compaction", "todo"];
  if (typeof data.kind !== "string" || !kinds.includes(data.kind as TimelineEntry["kind"])) return fail();
  const kind = data.kind as TimelineEntry["kind"], role = kind === "user_message" ? "user" : kind === "assistant_message" ? "assistant" : null;
  if (data.role !== role || !Array.isArray(data.resources) || data.resources.length > 20) return fail();
  const resources = data.resources.map(value => {
    const resource = exact(value, ["resourceId", "status", "name", "mediaType", "byteLength", "sha256"]);
    const { error: _, ...parsed } = parseSessionResource({ ...resource, error: null });
    return parsed;
  });
  if (new Set(resources.map(resource => resource.resourceId)).size !== resources.length) return fail();
  const body = data.body === null ? null : parseTimelineEntry(data.body), truncated = bool(data.truncated), contentRef = data.contentRef === null ? null : parseSessionContentRef(data.contentRef);
  if (truncated !== (body === null) || truncated !== (contentRef !== null) || body && (body.entryId !== entryId || body.entrySeq !== entrySeq || body.revision !== revision || body.kind !== kind)) return fail();
  return { entryId, entrySeq, revision, kind, role, timestamp: timestamp(data.timestamp), body, truncated, contentRef, resources, resourcesTruncated: bool(data.resourcesTruncated) };
};
export const parseInspectionPage = (value: unknown): InspectionPage => {
  const data = exact(value, ["kind", "historyEpoch", "items", "beforeCursor", "hasMoreBefore", "coverage"]);
  if (data.kind !== "inspect_page" || !Array.isArray(data.items) || data.items.length > 200) return fail();
  const items = data.items.map(parseSessionMessageItem);
  if (new Set(items.map(item => item.entryId)).size !== items.length || items.some((item, index) => index > 0 && BigInt(items[index - 1]!.entrySeq) >= BigInt(item.entrySeq))) return fail();
  const beforeCursor = nullableCursor(data.beforeCursor), hasMoreBefore = bool(data.hasMoreBefore);
  if (hasMoreBefore && beforeCursor === null) return fail();
  const rawCoverage = exact(data.coverage, ["state", "reason"]);
  const coverage: HistoryCoverage = rawCoverage.state === "complete" && rawCoverage.reason === null ? { state: "complete", reason: null }
    : rawCoverage.state === "partial" && (rawCoverage.reason === "entry_truncated" || rawCoverage.reason === "resource_unavailable") ? { state: "partial", reason: rawCoverage.reason } : fail();
  return { kind: "inspect_page", historyEpoch: epoch(data.historyEpoch), items, beforeCursor, hasMoreBefore, coverage };
};
export const parseEntryChunk = (value: unknown): EntryChunk => {
  const data = exact(value, ["kind", "historyEpoch", "entryId", "revision", "sha256", "byteLength", "offset", "fragment", "nextCursor", "eof"]);
  if (data.kind !== "entry_chunk" || typeof data.fragment !== "string" || !data.fragment.isWellFormed()) return fail();
  const size = new TextEncoder().encode(data.fragment).length;
  if (size > HISTORY_CHUNK_BYTES) return fail();
  const byteLength = sequence(data.byteLength), offset = sequence(data.offset, true), eof = bool(data.eof), nextCursor = nullableCursor(data.nextCursor);
  const end = BigInt(offset) + BigInt(size);
  if (end > BigInt(byteLength) || eof !== (end === BigInt(byteLength)) || eof !== (nextCursor === null) || !eof && size === 0) return fail();
  return { kind: "entry_chunk", historyEpoch: epoch(data.historyEpoch), entryId: uuid(data.entryId), revision: sequence(data.revision), sha256: hash(data.sha256), byteLength, offset, fragment: data.fragment, nextCursor, eof };
};

const encode = (values: unknown[]): string => Buffer.from(JSON.stringify(values)).toString("base64url");
const decode = (value: string, length: number): unknown[] => {
  historyCursorText(value);
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) return fail();
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== length || parsed[0] !== 1) return fail();
    return parsed;
  } catch { return fail(); }
};
const cursorIdentity = (values: unknown[]): HistoryCursorIdentity => {
  const source = values[1];
  if (source !== "live" && source !== "archive") return fail();
  const historyEpoch = source === "live" ? uuid(values[3]) : hash(values[3]);
  if (values[4] !== historyEpoch) return fail();
  return { source, sessionId: uuid(values[2]), historyEpoch, sourceVersion: historyEpoch };
};
const identityValues = (value: HistoryCursorIdentity): unknown[] => [1, value.source, value.sessionId, value.historyEpoch, value.sourceVersion];
export const encodeHistoryPageCursor = (value: HistoryPageCursor): string => encode([...identityValues(value), value.entrySeq]);
export const decodeHistoryPageCursor = (value: string): HistoryPageCursor => { const values = decode(value, 6); return { ...cursorIdentity(values), entrySeq: sequence(values[5]) }; };
export const encodeHistoryEntryCursor = (value: HistoryEntryCursor): string => encode([...identityValues(value), value.entryId, value.revision, value.sha256, value.byteLength, value.offset]);
export const decodeHistoryEntryCursor = (value: string): HistoryEntryCursor => {
  const values = decode(value, 10), out = { ...cursorIdentity(values), entryId: uuid(values[5]), revision: sequence(values[6]), sha256: hash(values[7]), byteLength: sequence(values[8]), offset: sequence(values[9], true) };
  return BigInt(out.offset) <= BigInt(out.byteLength) ? out : fail();
};
