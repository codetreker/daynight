import { sessionDisplayEntry, sessionWireBytes } from "./wire-display.js";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { parseTimelineEntry, parseSessionResource, type TimelineEntry, type SessionResource } from "../../session/protocol.js";
import type { TimelinePage } from "../../session/controller-protocol.js";

export type LocalTimelineQuery = { historyEpoch: string; direction: "tail" | "before" | "after"; cursor: string | null; limit: number };
const sequence = (value: string): bigint => {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n) throw new Error("Invalid local content sequence.");
  return BigInt(value);
};

type ContentTransactions = { read: <T>(action: () => T) => T; write: <T>(action: () => T) => T };

export const createLocalSessionContent = (db: Database.Database, sessionId: string, transactions: ContentTransactions) => {
  const resourcesFor = (items: readonly TimelineEntry[]): SessionResource[] => {
    const ids = new Set<string>();
    for (const item of items) {
      const parts = item.kind === "tool_call" ? item.output : item.kind === "user_message" || item.kind === "assistant_message" ? item.content : [];
      for (const part of parts) if (part.type === "resource") ids.add(part.resourceId);
    }
    return [...ids].flatMap(id => {
      const row = db.prepare("SELECT descriptor FROM resources WHERE id=?").get(id) as { descriptor: string } | undefined;
      return row ? [parseSessionResource(JSON.parse(row.descriptor))] : [];
    });
  };
  const content = {
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
      const where = query.direction === "tail" ? "" : query.direction === "before" ? "WHERE rowid < ?" : "WHERE rowid > ?";
      const ascending = query.direction === "after";
      const rows = db.prepare(`SELECT CAST(rowid AS TEXT) AS seq, value FROM projection ${where} ORDER BY rowid ${ascending ? "ASC" : "DESC"} LIMIT ?`).all(...(query.direction === "tail" ? [query.limit] : [pivot, query.limit])) as { seq: string; value: string }[];
      const items: TimelineEntry[] = [];
      // Leave room for the envelope and resource descriptors in the WS frame.
      let bytes = 1024;
      for (const row of rows) {
        const entry = sessionDisplayEntry(parseTimelineEntry({ ...JSON.parse(row.value) as object, entrySeq: row.seq }));
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
      const hasBefore = first !== undefined && db.prepare("SELECT 1 FROM projection WHERE rowid < ? LIMIT 1").get(sequence(first)) !== undefined;
      const hasAfter = last !== undefined && db.prepare("SELECT 1 FROM projection WHERE rowid > ? LIMIT 1").get(sequence(last)) !== undefined;
      return { kind: "timeline", historyEpoch: query.historyEpoch, items, resources: resourcesFor(items), beforeCursor: cursor(first), afterCursor: cursor(last), hasMoreBefore: hasBefore, hasMoreAfter: hasAfter };
    },
    pendingInteractions(): TimelineEntry[] {
      const rows = db.prepare("SELECT CAST(rowid AS TEXT) AS seq,value FROM projection WHERE json_extract(value,'$.kind')='interaction' AND json_extract(value,'$.interaction.state')='pending' ORDER BY rowid LIMIT 101").all() as { seq: string; value: string }[];
      if (rows.length > 100) throw new Error("Too many pending native interactions to synchronize safely.");
      return rows.map(row => parseTimelineEntry({ ...JSON.parse(row.value) as object, entrySeq: row.seq }));
    },
    saveResource(resource: SessionResource, content?: Uint8Array): void {
      parseSessionResource(resource);
      if (content && (content.byteLength > 8_388_608 || String(content.byteLength) !== resource.byteLength || createHash("sha256").update(content).digest("hex") !== resource.sha256)) throw new Error("Local session resource content does not match its descriptor.");
      const previous = db.prepare("SELECT descriptor FROM resources WHERE id=?").get(resource.resourceId) as { descriptor: string } | undefined;
      if (previous) {
        const old = parseSessionResource(JSON.parse(previous.descriptor));
        if (old.status === "available" && JSON.stringify(old) !== JSON.stringify(resource)) throw new Error("An available local resource cannot change identity.");
      }
      db.prepare("INSERT INTO resources(id,descriptor,content) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET descriptor=excluded.descriptor,content=COALESCE(excluded.content,resources.content)").run(resource.resourceId, JSON.stringify(resource), content ? Buffer.from(content) : null);
    },
    readResource(resourceId: string, offset: string, limit: number): { kind: "resource"; resource: SessionResource; offset: string; data: string; eof: boolean } {
      const position = sequence(offset);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 524288) throw new Error("Invalid local resource chunk limit.");
      const row = db.prepare("SELECT descriptor,content FROM resources WHERE id=?").get(resourceId) as { descriptor: string; content: Buffer | null } | undefined;
      if (!row?.content) throw new Error("Local session resource is unavailable.");
      const resource = parseSessionResource(JSON.parse(row.descriptor));
      if (resource.status !== "available" || position > BigInt(row.content.length)) throw new Error("Local session resource is unavailable.");
      const end = Math.min(Number(position) + limit, row.content.length);
      return { kind: "resource", resource, offset, data: row.content.subarray(Number(position), end).toString("base64"), eof: end === row.content.length };
    },
  };
  return {
    readTimeline: (query: LocalTimelineQuery) => transactions.read(() => content.readTimeline(query)),
    pendingInteractions: () => transactions.read(() => content.pendingInteractions()),
    saveResource: (resource: SessionResource, bytes?: Uint8Array): void => transactions.write(() => content.saveResource(resource, bytes)),
    readResource: (resourceId: string, offset: string, limit: number) => transactions.read(() => content.readResource(resourceId, offset, limit)),
  };
};
