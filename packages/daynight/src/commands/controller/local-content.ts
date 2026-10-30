import { sessionDisplayEntry, sessionWireBytes } from "./wire-display.js";
import type { PendingContent } from "./pending-content.js";
import { createHash } from "node:crypto";
import { parseSessionResource, type TimelineEntry, type SessionResource } from "../../session/protocol.js";
import type { TimelinePage } from "../../session/controller-protocol.js";

export type LocalTimelineQuery = { historyEpoch: string; direction: "tail" | "before" | "after"; cursor: string | null; limit: number };
const sequence = (value: string): bigint => {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n) throw new Error("Invalid local content sequence.");
  return BigInt(value);
};

export const createLocalSessionContent = (store: PendingContent, sessionId: string) => {
  const resourcesFor = (items: readonly TimelineEntry[]): SessionResource[] => {
    const ids = new Set<string>();
    for (const item of items) {
      const parts = item.kind === "tool_call" ? item.output : item.kind === "user_message" || item.kind === "assistant_message" ? item.content : [];
      for (const part of parts) if (part.type === "resource") ids.add(part.resourceId);
    }
    return [...ids].flatMap(id => {
      const row = store.resources.get(id);
      return row ? [row.resource] : [];
    });
  };
  return {
    readTimeline(query: LocalTimelineQuery): Omit<TimelinePage, "sessionId" | "lastEventSeq"> & { kind: "timeline" } {
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200 || !["tail", "before", "after"].includes(query.direction)) throw new Error("Invalid local timeline page.");
      let pivot = 0n;
      if (query.direction === "tail") {
        if (query.cursor !== null) throw new Error("Tail must not contain a cursor.");
      } else {
        if (!query.cursor || query.cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error("Invalid local timeline cursor.");
        try {
          const values: unknown = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
          if (!Array.isArray(values) || values.length !== 3 || values[0] !== sessionId || values[1] !== query.historyEpoch || typeof values[2] !== "string") throw new Error();
          pivot = sequence(values[2]);
        } catch { throw new Error("Invalid local timeline cursor."); }
      }
      const ascending = query.direction === "after";
      const ordered = [...store.entries.values()].sort((a, b) => sequence(a.entrySeq) < sequence(b.entrySeq) ? -1 : 1);
      const eligible = ordered.filter(entry => query.direction === "tail" || (ascending ? sequence(entry.entrySeq) > pivot : sequence(entry.entrySeq) < pivot));
      const rows = (ascending ? eligible : eligible.reverse()).slice(0, query.limit);
      const items: TimelineEntry[] = [];
      // Leave room for the envelope and resource descriptors in the WS frame.
      let bytes = 1024;
      for (const row of rows) {
        const entry = sessionDisplayEntry(row);
        const size = sessionWireBytes(entry) + sessionWireBytes(resourcesFor([entry]));
        if (bytes + size > 1_500_000) {
          if (!items.length) throw new Error("Local timeline entry exceeds the relay frame limit.");
          break;
        }
        items.push(entry); bytes += size;
      }
      if (!ascending) items.reverse();
      const first = items[0]?.entrySeq, last = items.at(-1)?.entrySeq;
      const cursor = (seq: string | undefined): string | null => seq === undefined ? null : Buffer.from(JSON.stringify([sessionId, query.historyEpoch, seq])).toString("base64url");
      const hasBefore = first !== undefined && ordered.some(entry => sequence(entry.entrySeq) < sequence(first));
      const hasAfter = last !== undefined && ordered.some(entry => sequence(entry.entrySeq) > sequence(last));
      return { kind: "timeline", historyEpoch: query.historyEpoch, items, resources: resourcesFor(items), beforeCursor: cursor(first), afterCursor: cursor(last), hasMoreBefore: hasBefore, hasMoreAfter: hasAfter };
    },
    pendingInteractions(): TimelineEntry[] {
      const rows = [...store.entries.values()].filter(entry => entry.kind === "interaction" && entry.interaction.state === "pending").sort((a,b) => sequence(a.entrySeq) < sequence(b.entrySeq) ? -1 : 1);
      if (rows.length > 100) throw new Error("Too many pending native interactions to synchronize safely.");
      return rows;
    },
    saveResource(resource: SessionResource, content?: Uint8Array): void {
      parseSessionResource(resource);
      if (content && (content.byteLength > 8_388_608 || String(content.byteLength) !== resource.byteLength || createHash("sha256").update(content).digest("hex") !== resource.sha256)) throw new Error("Local session resource content does not match its descriptor.");
      const previous = store.resources.get(resource.resourceId);
      if (previous) {
        const old = previous.resource;
        if (old.status === "available" && JSON.stringify(old) !== JSON.stringify(resource)) throw new Error("An available local resource cannot change identity.");
      }
      store.saveResource({ resource, data: content ? Buffer.from(content).toString("base64") : previous?.data ?? null });
    },
    readResource(resourceId: string, offset: string, limit: number): { kind: "resource"; resource: SessionResource; offset: string; data: string; eof: boolean } {
      const position = sequence(offset);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 524288) throw new Error("Invalid local resource chunk limit.");
      const row = store.resources.get(resourceId);
      if (row?.data === null || row === undefined) throw new Error("Local session resource is unavailable.");
      const resource = row.resource;
      const content = Buffer.from(row.data, "base64");
      if (resource.status !== "available" || position > BigInt(content.length)) throw new Error("Local session resource is unavailable.");
      const end = Math.min(Number(position) + limit, content.length);
      return { kind: "resource", resource, offset, data: content.subarray(Number(position), end).toString("base64"), eof: end === content.length };
    },
  };
};
