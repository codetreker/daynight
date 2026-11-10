import { createHash } from "node:crypto";
import { HISTORY_CHUNK_BYTES, HISTORY_RESPONSE_BYTES, SessionHistoryError, canonicalHistoryJSON, decodeHistoryEntryCursor, decodeHistoryPageCursor, encodeHistoryEntryCursor, encodeHistoryPageCursor, type EntryChunk, type HistoryCursorIdentity, type InspectionPage, type InspectionResource, type SessionMessageItem } from "../../session/history.js";
import type { TimelineEntry } from "../../session/protocol.js";
import type { PendingContent } from "./pending-content.js";

export type LocalInspectionQuery = { historyEpoch: string; cursor: string | null; limit: number; responseOverhead: number };
export type LocalEntryQuery = { historyEpoch: string; cursor: string; limit: number };
const invalid = (message: string): never => { throw new SessionHistoryError("invalid_input", message); };
const changed = (): never => { throw new SessionHistoryError("content_changed", "The original entry changed; read its current page again."); };
const reset = (): never => { throw new SessionHistoryError("reset_required", "The cursor belongs to another session history source; start from its latest page."); };
const byteDescription = (entry: TimelineEntry) => {
  const bytes = Buffer.from(canonicalHistoryJSON(entry));
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: String(bytes.length) };
};
// MCP embeds the result with Go's HTML-safe JSON encoder. Budget for its
// escaping even though the Controller's WebSocket representation is smaller.
const responseBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`));

export const createInspectionContent = (store: PendingContent, sessionId: string) => {
  const identity = (historyEpoch: string): HistoryCursorIdentity => ({ source: "live", sessionId, historyEpoch, sourceVersion: historyEpoch });
  const requireIdentity = (cursor: HistoryCursorIdentity, historyEpoch: string): void => {
    if (cursor.source !== "live" || cursor.sessionId !== sessionId || cursor.historyEpoch !== historyEpoch || cursor.sourceVersion !== historyEpoch) reset();
  };
  const resourcesFor = (entry: TimelineEntry): { resources: InspectionResource[]; resourcesTruncated: boolean } => {
    const parts = entry.kind === "tool_call" ? entry.output : entry.kind === "user_message" || entry.kind === "assistant_message" ? entry.content : [];
    const ids = [...new Set(parts.flatMap(part => part.type === "resource" ? [part.resourceId] : []))];
    const resources = ids.slice(0, 20).map(resourceId => {
      const saved = store.resources.get(resourceId)?.resource;
      if (!saved) return { resourceId, status: "unavailable" as const, name: resourceId, mediaType: null, byteLength: null, sha256: null };
      const { error: _, ...descriptor } = saved;
      return descriptor;
    });
    return { resources, resourcesTruncated: ids.length > resources.length };
  };
  const itemFor = (entry: TimelineEntry): SessionMessageItem => ({ entryId: entry.entryId, entrySeq: entry.entrySeq, revision: entry.revision, kind: entry.kind, role: entry.kind === "user_message" ? "user" : entry.kind === "assistant_message" ? "assistant" : null, timestamp: null, body: entry, truncated: false, contentRef: null, ...resourcesFor(entry) });
  return {
    readInspection(query: LocalInspectionQuery): InspectionPage {
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200 || !Number.isSafeInteger(query.responseOverhead) || query.responseOverhead < 0 || query.responseOverhead >= HISTORY_RESPONSE_BYTES) invalid("Invalid inspection page limit or response budget.");
      let pivot: bigint | null = null;
      if (query.cursor !== null) { const cursor = decodeHistoryPageCursor(query.cursor); requireIdentity(cursor, query.historyEpoch); pivot = BigInt(cursor.entrySeq); }
      const ordered = [...store.entries.values()].sort((a, b) => BigInt(a.entrySeq) < BigInt(b.entrySeq) ? -1 : 1);
      const selected = ordered.filter(entry => pivot === null || BigInt(entry.entrySeq) < pivot).reverse().slice(0, query.limit);
      const items: SessionMessageItem[] = [];
      const page = (): InspectionPage => ({ kind: "inspect_page", historyEpoch: query.historyEpoch, items, beforeCursor: items.length ? encodeHistoryPageCursor({ ...identity(query.historyEpoch), entrySeq: items[0]!.entrySeq }) : null, hasMoreBefore: items.length > 0 && ordered.some(entry => BigInt(entry.entrySeq) < BigInt(items[0]!.entrySeq)) });
      for (const entry of selected) {
        items.unshift(itemFor(entry));
        if (responseBytes(page()) + query.responseOverhead <= HISTORY_RESPONSE_BYTES) continue;
        const { sha256, byteLength } = byteDescription(entry);
        const cursor = encodeHistoryEntryCursor({ ...identity(query.historyEpoch), entryId: entry.entryId, revision: entry.revision, sha256, byteLength, offset: "0" });
        items[0] = { ...items[0]!, body: null, truncated: true, contentRef: { cursor, sha256, byteLength } };
        if (responseBytes(page()) + query.responseOverhead <= HISTORY_RESPONSE_BYTES) continue;
        items.shift();
        if (!items.length) throw new SessionHistoryError("payload_too_large", "The response budget cannot contain an entry reference.");
        break;
      }
      const result = page();
      if (responseBytes(result) + query.responseOverhead > HISTORY_RESPONSE_BYTES) throw new SessionHistoryError("payload_too_large", "The response budget cannot contain a history page.");
      return result;
    },
    readEntryChunk(query: LocalEntryQuery): EntryChunk {
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > HISTORY_CHUNK_BYTES) invalid("Invalid entry chunk limit.");
      const cursor = decodeHistoryEntryCursor(query.cursor); requireIdentity(cursor, query.historyEpoch);
      const entry = store.entries.get(cursor.entryId);
      if (!entry || entry.revision !== cursor.revision) return changed();
      const { bytes, sha256, byteLength } = byteDescription(entry);
      if (sha256 !== cursor.sha256 || byteLength !== cursor.byteLength) return changed();
      const start = Number(cursor.offset);
      if (start > bytes.length || start < bytes.length && (bytes[start]! & 0xc0) === 0x80) invalid("The entry cursor is not on a UTF-8 boundary.");
      let end = Math.min(start + query.limit, bytes.length);
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
      if (end === start && start < bytes.length) throw new SessionHistoryError("payload_too_large", "The chunk limit cannot contain the next UTF-8 code point.");
      const eof = end === bytes.length;
      return { kind: "entry_chunk", historyEpoch: query.historyEpoch, entryId: entry.entryId, revision: entry.revision, sha256, byteLength, offset: cursor.offset, fragment: bytes.subarray(start, end).toString("utf8"), nextCursor: eof ? null : encodeHistoryEntryCursor({ ...cursor, offset: String(end) }), eof };
    },
  };
};
