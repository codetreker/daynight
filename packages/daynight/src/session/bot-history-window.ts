import { imageObject, imageId, imageDecimal, imageInteger, imageSha, parseImageOccurrence, type ImageOccurrence } from "./image-values.js";
import { historyCursorText, HISTORY_RESPONSE_BYTES } from "./history.js";
import { canonicalSessionJson, hashSessionBytes } from "./v2/values.js";

export const BOT_HISTORY_WINDOW_VERSION = 1 as const;
export const BOT_HISTORY_WINDOW_ENTRIES = 500;
export const BOT_HISTORY_WINDOW_PREVIEW_BYTES = 32 * 1024;

export type BotHistoryWindowBoundary = {
  readonly sessionId: string;
  readonly testExecutionId: string;
  readonly executionGeneration: string;
  readonly connectionEpoch: string;
  readonly botHistoryWindowVersion: 1;
  readonly historyEpoch: string;
  readonly windowRevision: string;
  readonly retainedFromSeq: string | null;
  readonly throughSeq: string | null;
  readonly earlierHistoryUnavailable: boolean;
};

/** A display preview carries no promise that an omitted suffix is downloadable. */
export type BotHistoryWindowEntry = {
  readonly entryId: string;
  readonly entrySeq: string;
  readonly revision: string;
  readonly kind: "user_message" | "assistant_message" | "tool_call";
  readonly preview: string;
  readonly truncated: boolean;
  readonly originalBytes: string | null;
  readonly previewBytes: string;
  readonly omissionReason: string | null;
  readonly omittedEntryCount: number;
  readonly resourceIds: readonly string[];
  readonly tool: BotHistoryWindowTool | null;
};

export type BotHistoryWindowTool = {
  readonly toolName: string | null;
  readonly command: string | null;
  readonly cwd: string | null;
  readonly status: string | null;
  readonly exitCode: number | null;
};

export type BotHistoryWindowPage = BotHistoryWindowBoundary & {
  readonly kind: "bot_history_window";
  readonly items: readonly BotHistoryWindowEntry[];
  readonly hasEarlierHistory: boolean;
  readonly beforeCursor: string | null;
  readonly nextCursor: string | null;
};

export type BotHistoryWindowRequest = {
  readonly kind: "bot_history_window";
  readonly historyEpoch: string;
  readonly mode: "tail" | "before" | "changes";
  readonly cursor: string | null;
  readonly limit: number;
  readonly responseOverhead: number;
};

export type BotHistoryCheckpointEntry = {
  readonly entryId: string;
  readonly entrySeq: string;
  readonly revision: string;
  readonly sha256: string;
  readonly resourceIds: readonly string[];
  readonly imageOccurrences: readonly ImageOccurrence[];
};

export type BotHistoryCheckpoint = BotHistoryWindowBoundary & {
  readonly sourceThrough: string;
  readonly entries: readonly BotHistoryCheckpointEntry[];
};

export type BotHistoryCheckpointReceipt = BotHistoryWindowBoundary & { readonly sourceThrough: string; readonly cleanupPending: boolean };

const boundaryKeys = ["sessionId", "testExecutionId", "executionGeneration", "connectionEpoch", "botHistoryWindowVersion", "historyEpoch", "windowRevision", "retainedFromSeq", "throughSeq", "earlierHistoryUnavailable"] as const;
const fail = (): never => { throw new Error("Invalid Bot history window protocol value."); };
const text = (value: unknown, limit: number, empty = false): string => {
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0") || (!empty && value.length === 0) || new TextEncoder().encode(value).length > limit) return fail();
  return value;
};
const bool = (value: unknown): boolean => typeof value === "boolean" ? value : fail();
const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null => value === null ? null : parse(value);
const resourceIds = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 1000) return fail();
  const ids = value.map(imageId);
  if (new Set(ids).size !== ids.length) return fail();
  return ids;
};
const boundary = (o: Record<string, unknown>): BotHistoryWindowBoundary => {
  if (o.botHistoryWindowVersion !== 1) return fail();
  const retainedFromSeq = nullable(o.retainedFromSeq, imageDecimal), throughSeq = nullable(o.throughSeq, imageDecimal), earlierHistoryUnavailable = bool(o.earlierHistoryUnavailable);
  if (throughSeq === null ? retainedFromSeq !== null || earlierHistoryUnavailable : retainedFromSeq === null ? !earlierHistoryUnavailable : BigInt(retainedFromSeq) > BigInt(throughSeq)) return fail();
  return { sessionId: imageId(o.sessionId), testExecutionId: imageId(o.testExecutionId), executionGeneration: imageDecimal(o.executionGeneration), connectionEpoch: imageDecimal(o.connectionEpoch), botHistoryWindowVersion: 1, historyEpoch: imageId(o.historyEpoch), windowRevision: imageDecimal(o.windowRevision), retainedFromSeq, throughSeq, earlierHistoryUnavailable };
};
const entry = (value: unknown): BotHistoryWindowEntry => {
  const o = imageObject(value, ["entryId", "entrySeq", "revision", "kind", "preview", "truncated", "originalBytes", "previewBytes", "omissionReason", "omittedEntryCount", "resourceIds", "tool"]);
  if (o.kind !== "user_message" && o.kind !== "assistant_message" && o.kind !== "tool_call") return fail();
  const preview = text(o.preview, BOT_HISTORY_WINDOW_PREVIEW_BYTES, true), previewBytes = imageDecimal(o.previewBytes, true), originalBytes = nullable(o.originalBytes, value => imageDecimal(value, true));
  const truncated = bool(o.truncated), omissionReason = nullable(o.omissionReason, value => text(value, 1024)), omittedEntryCount = imageInteger(o.omittedEntryCount, 2147483647, true);
  if (BigInt(previewBytes) !== BigInt(new TextEncoder().encode(preview).length) || truncated !== (omissionReason !== null)
    || omittedEntryCount > 0 && (!truncated || o.kind !== "tool_call")
    || (!truncated ? originalBytes !== previewBytes : originalBytes !== null && BigInt(originalBytes) < BigInt(previewBytes))) return fail();
  const tool = nullable(o.tool, value => {
    const metadata = imageObject(value, ["toolName", "command", "cwd", "status", "exitCode"]);
    const exitCode = nullable(metadata.exitCode, value => typeof value === "number" && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? value : fail());
    return { toolName: nullable(metadata.toolName, value => text(value, 256)), command: nullable(metadata.command, value => text(value, 8192, true)), cwd: nullable(metadata.cwd, value => text(value, 4096)), status: nullable(metadata.status, value => text(value, 256)), exitCode };
  });
  if (o.kind !== "tool_call" && tool !== null) return fail();
  return { entryId: imageId(o.entryId), entrySeq: imageDecimal(o.entrySeq), revision: imageDecimal(o.revision), kind: o.kind, preview, truncated, originalBytes, previewBytes, omissionReason, omittedEntryCount, resourceIds: resourceIds(o.resourceIds), tool };
};

export const parseBotHistoryWindowPage = (value: unknown): BotHistoryWindowPage => {
  const o = imageObject(value, [...boundaryKeys, "kind", "items", "hasEarlierHistory", "beforeCursor", "nextCursor"]);
  if (o.kind !== "bot_history_window" || !Array.isArray(o.items) || o.items.length > 200 || new TextEncoder().encode(JSON.stringify(value)).length > HISTORY_RESPONSE_BYTES) return fail();
  const state = boundary(o), items = o.items.map(entry), hasEarlierHistory = bool(o.hasEarlierHistory), beforeCursor = nullable(o.beforeCursor, historyCursorText), nextCursor = nullable(o.nextCursor, historyCursorText);
  if (hasEarlierHistory !== (beforeCursor !== null) || beforeCursor !== null && items.length === 0 || new Set(items.map(item => item.entryId)).size !== items.length) return fail();
  let last = 0n;
  for (const item of items) {
    const position = BigInt(item.entrySeq);
    if (state.retainedFromSeq === null || state.throughSeq === null || position < BigInt(state.retainedFromSeq) || position > BigInt(state.throughSeq) || position <= last) return fail();
    last = position;
  }
  return { ...state, kind: "bot_history_window", items, hasEarlierHistory, beforeCursor, nextCursor };
};

/** Hash the complete validated preview and its resource references. */
export const botHistoryWindowEntryDigest = (value: BotHistoryWindowEntry): Promise<string> => hashSessionBytes(canonicalSessionJson(entry(value)));

export const parseBotHistoryWindowRequest = (value: unknown): BotHistoryWindowRequest => {
  const o = imageObject(value, ["kind", "historyEpoch", "mode", "cursor", "limit", "responseOverhead"]);
  if (o.kind !== "bot_history_window" || o.mode !== "tail" && o.mode !== "before" && o.mode !== "changes") return fail();
  const cursor = nullable(o.cursor, historyCursorText);
  if ((o.mode === "tail") !== (cursor === null)) return fail();
  return { kind: "bot_history_window", historyEpoch: imageId(o.historyEpoch), mode: o.mode, cursor, limit: imageInteger(o.limit, 200), responseOverhead: imageInteger(o.responseOverhead, HISTORY_RESPONSE_BYTES - 1, true) };
};

export const parseBotHistoryCheckpoint = (value: unknown): BotHistoryCheckpoint => {
  const o = imageObject(value, [...boundaryKeys, "sourceThrough", "entries"]), state = boundary(o);
  if (!Array.isArray(o.entries) || o.entries.length > BOT_HISTORY_WINDOW_ENTRIES || new TextEncoder().encode(JSON.stringify(value)).length > 2_097_152) return fail();
  const entries = o.entries.map((value): BotHistoryCheckpointEntry => {
    const item = imageObject(value, ["entryId", "entrySeq", "revision", "sha256", "resourceIds", "imageOccurrences"]);
    if (!Array.isArray(item.imageOccurrences) || item.imageOccurrences.length > 1000) return fail();
    return { entryId: imageId(item.entryId), entrySeq: imageDecimal(item.entrySeq), revision: imageDecimal(item.revision), sha256: imageSha(item.sha256), resourceIds: resourceIds(item.resourceIds), imageOccurrences: item.imageOccurrences.map(parseImageOccurrence) };
  });
  if ((entries.length === 0) !== (state.retainedFromSeq === null) || new Set(entries.map(item => item.entryId)).size !== entries.length) return fail();
  let last = 0n;
  const imageIds = new Set<string>();
  for (const [index, item] of entries.entries()) {
    const position = BigInt(item.entrySeq);
    if (position <= last || state.throughSeq === null || position > BigInt(state.throughSeq) || index === 0 && item.entrySeq !== state.retainedFromSeq) return fail();
    last = position;
    for (const occurrence of item.imageOccurrences) {
      if (occurrence.entryId !== item.entryId || imageIds.has(occurrence.imageId)) return fail();
      imageIds.add(occurrence.imageId);
    }
  }
  return { ...state, sourceThrough: imageDecimal(o.sourceThrough, true), entries };
};

export const parseBotHistoryCheckpointReceipt = (value: unknown): BotHistoryCheckpointReceipt => {
  const o = imageObject(value, [...boundaryKeys, "sourceThrough", "cleanupPending"]);
  return { ...boundary(o), sourceThrough: imageDecimal(o.sourceThrough, true), cleanupPending: bool(o.cleanupPending) };
};
