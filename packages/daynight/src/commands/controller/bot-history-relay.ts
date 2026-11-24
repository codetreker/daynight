import {
  BOT_HISTORY_WINDOW_VERSION, botHistoryWindowEntryDigest, parseBotHistoryCheckpoint,
  parseBotHistoryCheckpointReceipt, parseBotHistoryWindowPage, type BotHistoryWindowBoundary,
  type BotHistoryCheckpointEntry, type BotHistoryWindowEntry, type BotHistoryWindowPage, type BotHistoryWindowRequest,
} from "../../session/bot-history-window.js";
import { HISTORY_RESPONSE_BYTES, SessionHistoryError } from "../../session/history.js";
import type { ImageOccurrence } from "../../session/image-values.js";
import { SESSION_PROTOCOL, type ControllerFence } from "../../session/protocol.js";
import { SESSION_PROTOCOL_HEADER } from "../../session/v2/values.js";
import { readArchiveRequestError } from "./archive-retry.js";
import { sessionWireBytes } from "./wire-display.js";

type WindowBounds = Pick<BotHistoryWindowBoundary, "windowRevision" | "retainedFromSeq" | "throughSeq" | "earlierHistoryUnavailable">;
export type BotHistoryWindowSnapshot = WindowBounds & {
  readonly entries: readonly { readonly entry: BotHistoryWindowEntry; readonly imageOccurrences: readonly ImageOccurrence[] }[];
};
export type PublishedBotHistory = {
  readonly boundary: BotHistoryWindowBoundary;
  readonly sourceThrough: string;
  readonly entries: readonly BotHistoryWindowEntry[];
  readonly checkpointEntries: readonly BotHistoryCheckpointEntry[];
};

const readCheckpointReceipt = async (response: Response): Promise<unknown> => {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The Bot history checkpoint receipt is missing.");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) throw new Error("The Bot history checkpoint receipt exceeded its size limit.");
      chunks.push(value);
    }
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
};

export const publishBotHistoryWindow = async (options: {
  readonly serverOrigin: string;
  readonly token: string;
  readonly fence: ControllerFence;
  readonly historyEpoch: string;
  readonly sourceEpoch: string;
  readonly sourceThrough: string;
  readonly snapshot: BotHistoryWindowSnapshot | null;
  readonly previous: PublishedBotHistory | null;
  readonly signal: AbortSignal;
}): Promise<PublishedBotHistory> => {
  const { snapshot, previous, fence, sourceThrough, sourceEpoch, historyEpoch, signal } = options;
  if (fence.testExecutionId === undefined) throw new Error("A Bot history checkpoint requires a Test execution identity.");
  const bounds = snapshot ?? previous?.boundary;
  if (!bounds) throw new Error("The original Bot has no local history window.");
  const boundary: BotHistoryWindowBoundary = {
    sessionId: fence.sessionId, testExecutionId: fence.testExecutionId,
    executionGeneration: fence.executionGeneration, connectionEpoch: fence.connectionEpoch,
    botHistoryWindowVersion: BOT_HISTORY_WINDOW_VERSION, historyEpoch,
    windowRevision: bounds.windowRevision, retainedFromSeq: bounds.retainedFromSeq,
    throughSeq: bounds.throughSeq, earlierHistoryUnavailable: bounds.earlierHistoryUnavailable,
  };
  const entries = snapshot ? await Promise.all(snapshot.entries.map(async ({ entry, imageOccurrences }) => ({
    entryId: entry.entryId, entrySeq: entry.entrySeq, revision: entry.revision,
    sha256: await botHistoryWindowEntryDigest(entry), resourceIds: entry.resourceIds, imageOccurrences,
  }))) : previous!.checkpointEntries;
  signal.throwIfAborted();
  const body = parseBotHistoryCheckpoint({ ...boundary, sourceEpoch, sourceThrough, entries });
  const url = new URL(`/api/v1/test-sessions/${fence.sessionId}/bot-history-window/checkpoint`, options.serverOrigin);
  const response = await fetch(url, {
    method: "PUT", redirect: "error", signal,
    headers: { Authorization: `Bearer ${options.token}`, [SESSION_PROTOCOL_HEADER]: SESSION_PROTOCOL, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.headers.get("Daynight-Bot-History-Window-Version") !== "1") {
    await response.body?.cancel();
    throw new SessionHistoryError("upgrade_required", "The service did not identify a Bot history checkpoint response.");
  }
  if (!response.ok) {
    const cause = await readArchiveRequestError(response, signal);
    throw new Error(`Bot history checkpoint failed (HTTP ${cause.status}${cause.code ? `, ${cause.code}` : ""}).`, { cause });
  }
  const { cleanupPending: _cleanupPending, ...receipt } = parseBotHistoryCheckpointReceipt(await readCheckpointReceipt(response));
  signal.throwIfAborted();
  if (JSON.stringify(receipt) !== JSON.stringify({ ...boundary, sourceEpoch, sourceThrough })) throw new Error("Bot history checkpoint receipt differs from the original publication.");
  return { boundary, sourceThrough, entries: snapshot ? snapshot.entries.map(row => row.entry) : previous!.entries, checkpointEntries: body.entries };
};

const reset = (): never => { throw new SessionHistoryError("reset_required", "The Bot history cursor is outside the current window."); };
const sequence = (value: string): bigint => {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) return reset();
  return BigInt(value);
};

const candidatesFor = (window: PublishedBotHistory, request: BotHistoryWindowRequest): readonly BotHistoryWindowEntry[] => {
  const { boundary, entries } = window;
  if (request.historyEpoch !== boundary.historyEpoch) return reset();
  if (request.cursor === null) return entries;
  const raw = Buffer.from(request.cursor, "base64url");
  if (raw.toString("base64url") !== request.cursor) return reset();
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
  catch { return reset(); }
  if (!Array.isArray(decoded) || decoded.length !== 10 || !decoded.every(value => typeof value === "string")) return reset();
  const [kind, sessionId, executionId, generation, connection, epoch, revision, mode, pivot, through] = decoded as [string, string, string, string, string, string, string, string, string, string];
  if (kind !== "bot_history_window" || sessionId !== boundary.sessionId || executionId !== boundary.testExecutionId
    || generation !== boundary.executionGeneration || connection !== boundary.connectionEpoch || epoch !== boundary.historyEpoch || mode !== request.mode) return reset();
  const cursorRevision = sequence(revision), cursorPosition = sequence(pivot), cursorThrough = sequence(through);
  if (cursorRevision === 0n || cursorRevision > sequence(boundary.windowRevision) || cursorPosition > cursorThrough
    || cursorThrough > sequence(boundary.throughSeq ?? "0")) return reset();
  if (mode === "before") {
    if (cursorPosition === 0n || boundary.retainedFromSeq === null
      || boundary.earlierHistoryUnavailable && cursorPosition <= sequence(boundary.retainedFromSeq)) return reset();
    return entries.filter(entry => sequence(entry.entrySeq) < cursorPosition);
  }
  if (revision !== boundary.windowRevision) {
    if (cursorPosition !== 0n || boundary.retainedFromSeq === null
      || boundary.earlierHistoryUnavailable && cursorThrough < sequence(boundary.retainedFromSeq)) return reset();
    return entries;
  }
  return cursorPosition === 0n ? [] : entries.filter(entry => sequence(entry.entrySeq) > cursorPosition);
};

export const readPublishedBotHistoryPage = (window: PublishedBotHistory, request: BotHistoryWindowRequest): BotHistoryWindowPage => {
  const candidates = candidatesFor(window, request);
  const items: BotHistoryWindowEntry[] = [];
  // The service chooses the public cursors after validating these exact entries.
  const page = { ...window.boundary, kind: "bot_history_window" as const, items, hasEarlierHistory: false, beforeCursor: null, nextCursor: null };
  const ascending = request.mode === "changes";
  let bytes = sessionWireBytes(page) + request.responseOverhead;
  if (bytes > HISTORY_RESPONSE_BYTES) throw new SessionHistoryError("payload_too_large", "The Bot history response budget is too small.");
  for (let index = 0; index < Math.min(request.limit, candidates.length); index++) {
    const entry = candidates[ascending ? index : candidates.length - 1 - index]!;
    bytes += sessionWireBytes(entry) + (index === 0 ? 0 : 1);
    if (bytes > HISTORY_RESPONSE_BYTES) break;
    items.push(entry);
  }
  if (items.length === 0 && candidates.length !== 0) throw new SessionHistoryError("payload_too_large", "A retained Bot history entry exceeds the available response budget.");
  if (!ascending) items.reverse();
  return parseBotHistoryWindowPage(page);
};
