import type Database from "better-sqlite3";
import { sessionArchiveReferences } from "../../../session/archive.js";
import { BOT_HISTORY_WINDOW_ENTRIES, BOT_HISTORY_WINDOW_PREVIEW_BYTES, type BotHistoryWindowEntry } from "../../../session/bot-history-window.js";
import { canonicalImageJson, parseImageOccurrence, type ImageCaptureReceipt, type ImageOccurrence } from "../../../session/image-values.js";
import type { TimelineEntry } from "../../../session/protocol.js";
import { queueBotResourceRetirement } from "./bot-resource-retirement.js";
import { isBotDisplayEntry, projectBotDisplay, type BotDisplayEntry } from "./bot-history-display.js";
import type { TimelineStore } from "./timeline-store.js";
import { controllerPayloadHash } from "../launch-ticket.js";
import { sessionWireBytes } from "../wire-display.js";

type Identity = { id: string; entry_seq: string; turn_seq: string; source_hash: string; preview: string | null; summarized: number; preview_bytes: number; checkpoint_bytes: number };
type CacheRow = { id: string; turn_seq: string; kind: BotDisplayEntry["kind"]; summarized: number; bytes: number; checkpoint_bytes: number };
type State = { windowRevision: string; through: string; displayThrough: string; omitted: number };
export type BotHistoryCacheBudget = { readonly entries: number; readonly bytes: number; readonly checkpointBytes?: number };
const defaultBudget: BotHistoryCacheBudget = { entries: BOT_HISTORY_WINDOW_ENTRIES, bytes: 16 * 1024 * 1024 };
const identityColumns = "id,CAST(entry_seq AS TEXT) AS entry_seq,CAST(turn_seq AS TEXT) AS turn_seq,source_hash,preview,summarized,preview_bytes,checkpoint_bytes";
// Reserve the outer envelope, including the complete Controller fence.
const maxCheckpointBudget = 2 * 1024 * 1024 - 4096;

const resourceIds = (entry: TimelineEntry | undefined): ReadonlySet<string> => entry ? sessionArchiveReferences([entry], false).resources : new Set();

export const openBotHistoryCache = (db: Database.Database, timeline: TimelineStore, budget = defaultBudget) => {
  const checkpointBudget = budget.checkpointBytes ?? maxCheckpointBudget;
  if (!Number.isSafeInteger(budget.entries) || budget.entries < 1 || budget.entries > BOT_HISTORY_WINDOW_ENTRIES
    || !Number.isSafeInteger(budget.bytes) || budget.bytes < 1024 || budget.bytes > defaultBudget.bytes
    || !Number.isSafeInteger(checkpointBudget) || checkpointBudget < 1024 || checkpointBudget > maxCheckpointBudget) throw new Error("Invalid Bot history cache budget.");
  const previewLimit = Math.min(BOT_HISTORY_WINDOW_PREVIEW_BYTES, Math.floor(budget.bytes / 8));
  const state = (): State => db.prepare("SELECT CAST(window_revision AS TEXT) AS windowRevision,CAST(through_seq AS TEXT) AS through,CAST(display_through_seq AS TEXT) AS displayThrough,omitted FROM bot_history_state WHERE id=1").get() as State;
  const identity = (id: string): Identity | undefined => db.prepare(`SELECT ${identityColumns} FROM bot_history_identity WHERE id=?`).get(id) as Identity | undefined;
  const visible = (): Identity[] => db.prepare(`SELECT ${identityColumns} FROM bot_history_identity WHERE preview IS NOT NULL ORDER BY bot_history_identity.entry_seq`).all() as Identity[];
  const occurrenceQuery = db.prepare("SELECT occurrence FROM image_occurrences WHERE json_extract(occurrence,'$.entryId')=? ORDER BY image_id");
  const positionRows = (entryId: string): { occurrence: string }[] => occurrenceQuery.all(entryId) as { occurrence: string }[];
  const occurrences = (entry: TimelineEntry, rows?: { occurrence: string }[]): ImageOccurrence[] => {
    const parts = entry.kind === "tool_call" ? entry.output : entry.kind === "user_message" || entry.kind === "assistant_message" ? entry.content : [];
    const images = new Set(parts.flatMap(part => part.type === "image" || part.type === "image_unavailable" ? [part.imageId] : part.type === "markdown" ? [...(part.bindings ?? []), ...part.retainedImages].map(binding => binding.imageId) : []));
    if (images.size === 0) return [];
    return (rows ?? positionRows(entry.entryId)).map(row => parseImageOccurrence(JSON.parse(row.occurrence))).filter(occurrence => images.has(occurrence.imageId));
  };
  const captureResources = db.prepare(`SELECT json_extract(value,'$.request.occurrence.imageId') AS image_id,
      json_extract(value,'$.receipt.resourceId') AS resource_id FROM image_runtime_state
    WHERE key GLOB 'capture:*' AND json_extract(value,'$.request.occurrence.entryId')=?
      AND json_extract(value,'$.receipt.state')='committed'`);
  const retireRemovedResources = (previous: TimelineEntry, next?: TimelineEntry): void => {
    const retainedResources = resourceIds(next);
    const retainedImages = new Set(next ? occurrences(next).map(occurrence => occurrence.imageId) : []);
    const captured = captureResources.all(previous.entryId) as { image_id: string; resource_id: string | null }[];
    const released = new Set([...resourceIds(previous)].filter(id => !retainedResources.has(id)));
    // A receipt can commit before the corresponding display patch adds its blob.
    for (const { image_id, resource_id } of captured) {
      if (resource_id && !retainedImages.has(image_id) && !retainedResources.has(resource_id)) released.add(resource_id);
    }
    if (released.size !== 0) queueBotResourceRetirement(db, released);
  };
  const windowChanged = (omitted = false): void => {
    db.prepare("UPDATE bot_history_state SET window_revision=window_revision+1,omitted=MAX(omitted,?) WHERE id=1").run(Number(omitted));
  };
  const writePreview = (preview: BotHistoryWindowEntry, durable: TimelineEntry, summarized: boolean): void => {
    const encoded = JSON.stringify(preview);
    const imageOccurrences = occurrences(durable);
    const { entryId, entrySeq, revision, resourceIds } = preview;
    const checkpointBytes = imageOccurrences.length > 1000 || resourceIds.length > 1000 || sessionWireBytes(preview) > 240 * 1024
      ? checkpointBudget + 1
      : sessionWireBytes({ entryId, entrySeq, revision, resourceIds, sha256: "0".repeat(64), imageOccurrences }) + 1;
    db.prepare("UPDATE bot_history_identity SET preview=?,preview_bytes=?,summarized=?,checkpoint_bytes=? WHERE id=?")
      .run(encoded, Buffer.byteLength(encoded), Number(summarized), checkpointBytes, preview.entryId);
  };
  const retire = (row: { id: string }): void => {
    retireRemovedResources(timeline.get(row.id)!);
    timeline.remove(row.id);
    db.prepare("UPDATE bot_history_identity SET preview=NULL,preview_bytes=0,checkpoint_bytes=0 WHERE id=?").run(row.id);
    db.prepare("DELETE FROM image_runtime_state WHERE key=?").run(`markdown:projection:${row.id}`);
  };
  const trim = (): void => {
    const sizesSql = `SELECT i.id, i.entry_seq, CAST(i.turn_seq AS TEXT) AS turn_seq, t.kind, i.summarized, i.checkpoint_bytes,
        i.preview_bytes+t.byte_length+COALESCE(length(CAST(m.value AS BLOB)),0) AS bytes
      FROM bot_history_identity i JOIN timeline_entries t ON t.id=i.id
      LEFT JOIN image_runtime_state m ON m.key='markdown:projection:' || i.id WHERE i.preview IS NOT NULL`;
    const totals = db.prepare(`SELECT COUNT(*) AS entries,COALESCE(SUM(bytes),0) AS bytes,COALESCE(SUM(checkpoint_bytes),0) AS checkpoint FROM (${sizesSql})`).get() as { entries: number; bytes: number; checkpoint: number };
    if (totals.entries <= budget.entries && totals.bytes <= budget.bytes && totals.checkpoint <= checkpointBudget) return;
    let rows = db.prepare(`${sizesSql} ORDER BY i.entry_seq`).all() as CacheRow[];
    let bytes = totals.bytes;
    let checkpointBytes = totals.checkpoint;
    const exceeds = () => rows.length > budget.entries || bytes > budget.bytes || checkpointBytes > checkpointBudget;
    const subtract = (row: CacheRow): void => { bytes -= row.bytes; checkpointBytes -= row.checkpoint_bytes; };
    if (!exceeds()) return;
    while (exceeds() && rows[0]?.turn_seq !== rows.at(-1)?.turn_seq) {
      const end = rows.findIndex(row => row.turn_seq !== rows[0]!.turn_seq);
      for (const row of rows.splice(0, end)) { retire(row); subtract(row); }
    }
    if (exceeds()) {
      const tools = rows.filter(row => row.kind === "tool_call");
      if (tools.length > 1 || tools.length === 1 && tools[0]!.summarized === 0) {
        const anchor = tools.shift()!, original = JSON.parse(identity(anchor.id)!.preview!) as BotHistoryWindowEntry;
        const raw = timeline.get(anchor.id) as Extract<BotDisplayEntry, { kind: "tool_call" }>;
        let omitted = original.omittedEntryCount || 1;
        subtract(anchor);
        const removed = new Set<string>();
        // Keep the summary anchored at the first discarded tool and reserve room for its envelope.
        for (const row of tools) {
          if (rows.length - removed.size <= budget.entries && bytes + 1024 <= budget.bytes && checkpointBytes + 1024 <= checkpointBudget) break;
          omitted += row.summarized ? (JSON.parse(identity(row.id)!.preview!) as BotHistoryWindowEntry).omittedEntryCount : 1;
          retire(row); removed.add(row.id); subtract(row);
        }
        rows = rows.filter(row => !removed.has(row.id));
        const revision = String(BigInt(original.revision) + 1n);
        const durable = { ...raw, revision, name: "Earlier tools", input: "", output: [], truncated: true };
        retireRemovedResources(raw, durable);
        timeline.save(durable, "bot_detail");
        db.prepare("DELETE FROM image_runtime_state WHERE key=?").run(`markdown:projection:${anchor.id}`);
        writePreview({ ...original, revision, preview: "", originalBytes: null, previewBytes: "0", truncated: true, omissionReason: "earlier_tool_details", omittedEntryCount: omitted, resourceIds: [], tool: null }, durable, true);
        const summary = identity(anchor.id)!;
        anchor.bytes = Buffer.byteLength(JSON.stringify(durable)) + summary.preview_bytes;
        anchor.checkpoint_bytes = summary.checkpoint_bytes;
        bytes += anchor.bytes;
        checkpointBytes += anchor.checkpoint_bytes;
      }
    }
    while (exceeds()) {
      const row = rows.shift()!;
      retire(row); subtract(row);
    }
    windowChanged(true);
  };
  const remember = (entry: TimelineEntry, hash: string): void => {
    const prior = identity(entry.entryId);
    if (!prior) {
      const latest = db.prepare("SELECT CAST(turn_seq AS TEXT) AS turn FROM bot_history_identity ORDER BY entry_seq DESC LIMIT 1").get() as { turn: string } | undefined;
      db.prepare("INSERT INTO bot_history_identity(id,entry_seq,turn_seq,source_hash) VALUES(?,?,?,?)")
        .run(entry.entryId, BigInt(entry.entrySeq), BigInt(entry.kind === "user_message" ? entry.entrySeq : latest?.turn ?? "0"), hash);
    } else db.prepare("UPDATE bot_history_identity SET source_hash=? WHERE id=?").run(hash, entry.entryId);
    db.prepare("UPDATE bot_history_state SET through_seq=MAX(through_seq,?) WHERE id=1").run(BigInt(entry.entrySeq));
    if (isBotDisplayEntry(entry)) db.prepare("UPDATE bot_history_state SET display_through_seq=MAX(display_through_seq,?) WHERE id=1").run(BigInt(entry.entrySeq));
  };
  const save = (entry: TimelineEntry, hash: string, preservePreview = false): TimelineEntry => {
    const known = identity(entry.entryId);
    const previous = timeline.get(entry.entryId);
    remember(entry, hash);
    if (!isBotDisplayEntry(entry)) {
      if (entry.kind === "interaction" && entry.interaction.state === "pending") timeline.save(entry);
      else if (previous) {
        retireRemovedResources(previous);
        timeline.remove(entry.entryId);
        db.prepare("DELETE FROM image_runtime_state WHERE key=?").run(`markdown:projection:${entry.entryId}`);
      }
      return entry;
    }
    const { durable, preview } = projectBotDisplay(entry, previewLimit);
    if (preservePreview && known?.preview) {
      const previousPreview = JSON.parse(known.preview) as BotHistoryWindowEntry;
      Object.assign(preview, {
        preview: previousPreview.preview, previewBytes: previousPreview.previewBytes, originalBytes: previousPreview.originalBytes,
        truncated: previousPreview.truncated, omissionReason: previousPreview.omissionReason,
        tool: previousPreview.tool,
      });
    }
    if (previous) retireRemovedResources(previous, durable);
    timeline.save(durable, "bot_detail");
    writePreview(preview, durable, false);
    windowChanged();
    trim();
    return durable;
  };
  const initialize = (): void => {
    if (state()) return;
    db.prepare("INSERT INTO bot_history_state VALUES(1,1,0,0,0)").run();
    // Install durable identities before enabling eviction on a previously full Bot journal.
    const existing = db.prepare("SELECT id FROM timeline_entries ORDER BY entry_seq").all() as { id: string }[];
    for (const { id } of existing) {
      const entry = timeline.get(id)!;
      const { revision, entrySeq, ...payload } = entry;
      void entrySeq;
      if (!isBotDisplayEntry(entry)) { save(entry, controllerPayloadHash(payload)); continue; }
      const { durable, preview } = projectBotDisplay(entry, previewLimit);
      remember(entry, controllerPayloadHash(payload));
      retireRemovedResources(entry, durable);
      timeline.remove(id);
      timeline.save(durable, "bot_detail");
      writePreview({ ...preview, revision }, durable, false);
    }
    trim();
  };
  const snapshot = () => {
    const current = state(), rows = visible();
    const entries = rows.map(row => {
      const entry = JSON.parse(row.preview!) as BotHistoryWindowEntry;
      const positions = positionRows(entry.entryId);
      return { entry, imageOccurrences: positions.length === 0 ? [] : occurrences(timeline.get(entry.entryId)!, positions) };
    });
    return { windowRevision: current.windowRevision, retainedFromSeq: entries[0]?.entry.entrySeq ?? null, throughSeq: current.displayThrough === "0" ? null : current.displayThrough, earlierHistoryUnavailable: current.omitted === 1, entries };
  };
  return {
    initialize, save, identity, snapshot, revision: () => state().windowRevision,
    nextSequence: () => String(BigInt(state().through) + 1n),
    observeCaptureReceipt: (receipt: ImageCaptureReceipt): void => {
      if (receipt.state !== "committed" || receipt.resourceId === null) return;
      const { occurrence } = receipt, row = identity(occurrence.entryId);
      const entry = row?.preview && !row.summarized ? timeline.get(occurrence.entryId) : undefined;
      if (!entry || !occurrences(entry).some(position => canonicalImageJson(position) === canonicalImageJson(occurrence))) {
        queueBotResourceRetirement(db, [receipt.resourceId]);
      }
    },
    reviseOccurrence: (occurrence: ImageOccurrence): void => {
      const row = identity(occurrence.entryId);
      if (!row?.preview || row.summarized) return;
      const preview = JSON.parse(row.preview) as BotHistoryWindowEntry;
      writePreview({ ...preview, revision: String(BigInt(preview.revision) + 1n) }, timeline.get(occurrence.entryId)!, false);
      windowChanged();
      trim();
    },
    clear: (): void => {
      const rows = visible();
      for (const row of rows) retire(row);
      if (rows.length !== 0) windowChanged(true);
    },
    trim,
  };
};
