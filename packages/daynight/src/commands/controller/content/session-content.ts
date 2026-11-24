import type Database from "better-sqlite3";
import { sessionArchiveReferences } from "../../../session/archive.js";
import { openResourceFiles, ResourceRetainedError, type ResourceFiles } from "./resource-files.js";
import { openTimelineStore, openOnlineTimelineStore, type TimelineStore, type TimelineWriteContext } from "./timeline-store.js";
import type { TimelineEntry } from "../../../session/protocol.js";
import { readFileSync } from "node:fs";

export type SessionContentContext = TimelineWriteContext & { readonly read: <T>(action: () => T) => T };
export type SessionHistoryContentPolicy = "legacy" | "task_body";

/** Old journal formats retain their full-history meaning until normal migration. */
export const readSessionHistoryContentPolicy = (db: Database.Database): SessionHistoryContentPolicy => {
  if (!(db.prepare("PRAGMA table_info(execution)").all() as { name: string }[]).some(column => column.name === "history_content_policy")) return "legacy";
  const row = db.prepare("SELECT history_content_policy AS policy FROM execution WHERE id=1").get() as { policy: unknown } | undefined;
  if (row === undefined) return "legacy";
  if (row.policy !== "legacy" && row.policy !== "task_body") throw new Error("Controller history content policy is corrupt.");
  return row.policy;
};

const combineTimeline = (db: Database.Database, history: TimelineStore, details: TimelineStore): TimelineStore => {
  const get = (id: string): TimelineEntry | undefined => history.get(id) ?? details.get(id);
  return {
    get,
    remove: id => { history.remove(id); details.remove(id); },
    has: id => history.has(id) || details.has(id),
    nextSequence: () => {
      const body = BigInt(history.nextSequence()), online = BigInt(details.nextSequence());
      return String(body > online ? body : online);
    },
    save: entry => {
      const previous = get(entry.entryId);
      if (previous !== undefined && previous.kind !== entry.kind) throw new Error("Online entry cannot change its original kind.");
      const other = db.prepare("SELECT id FROM timeline_entries WHERE entry_seq=? UNION ALL SELECT id FROM online_entries WHERE entry_seq=?").all(BigInt(entry.entrySeq), BigInt(entry.entrySeq)) as { id: string }[];
      if (other.some(row => row.id !== entry.entryId)) throw new Error("Online timeline sequence is already occupied.");
      return entry.kind === "user_message" || entry.kind === "assistant_message" ? history.save(entry, "task_body") : details.save(entry);
    },
    page: query => {
      const selected = [...history.page(query), ...details.page(query)].sort((a, b) => BigInt(a.entrySeq) < BigInt(b.entrySeq) ? -1 : 1);
      return query.direction === "after" ? selected.slice(0, query.limit) : selected.slice(-query.limit);
    },
    hasBefore: pivot => history.hasBefore(pivot) || details.hasBefore(pivot),
    hasAfter: pivot => history.hasAfter(pivot) || details.hasAfter(pivot),
    iterate: visit => {
      if (!db.inTransaction) throw new Error("Online traversal requires the original journal read transaction.");
      for (const row of db.prepare("SELECT id,entry_seq FROM timeline_entries UNION ALL SELECT id,entry_seq FROM online_entries ORDER BY entry_seq").iterate() as Iterable<{ id: string }>) {
        const result = visit(get(row.id)!);
        if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result && typeof result.then === "function") throw new TypeError("SQL timeline traversal callbacks must be synchronous.");
      }
    },
    totals: () => {
      const body = history.totals(), online = details.totals(), entryCount = body.entryCount + online.entryCount, byteLength = body.byteLength + online.byteLength;
      return { entryCount, byteLength, timelineBytes: Buffer.byteLength('{"entries":[]}') + byteLength + Math.max(entryCount - 1, 0) };
    },
  };
};

/** SQL owns current bodies; resource files retain their original Session-bound locations. */
export const openSessionContent = (journal: string, sessionId: string, db: Database.Database, context: SessionContentContext, options: { maxOnlineBytes?: number } = {}) => {
  const timeline = openTimelineStore(db, context), files = openResourceFiles(journal, sessionId);
  const contentPolicy = readSessionHistoryContentPolicy(db);
  const details = contentPolicy === "task_body" ? openOnlineTimelineStore(db, context, options.maxOnlineBytes) : null;
  if (details !== null) {
    const invalid = db.prepare("SELECT 1 FROM timeline_entries WHERE kind NOT IN ('user_message','assistant_message') UNION ALL SELECT 1 FROM online_entries WHERE kind IN ('user_message','assistant_message') UNION ALL SELECT 1 FROM online_entries o JOIN timeline_entries t ON o.id=t.id OR o.entry_seq=t.entry_seq LIMIT 1").get();
    if (invalid !== undefined) throw new Error("Task history and online details have conflicting ownership.");
  }
  const onlineTimeline = details === null ? timeline : combineTimeline(db, timeline, details);
  const assertReferences = (id: string): void => {
    if (!db.inTransaction) throw new Error("Resource reference validation requires the original journal read transaction.");
    files.assertResourceReleasable(id);
    if (db.prepare("SELECT 1 FROM native_input_publication_images WHERE resource_id=? LIMIT 1").get(id) !== undefined) throw new ResourceRetainedError("Resource is referenced by session history.");
    let referenced = false;
    onlineTimeline.iterate(entry => { if (sessionArchiveReferences([entry], false).resources.has(id)) referenced = true; });
    if (referenced) throw new ResourceRetainedError("Resource is referenced by session history.");
  };
  const assertResourceReleasable = (id: string): void => context.read(() => assertReferences(id));
  const releaseResource = (id: string): void => context.read(() => {
    assertReferences(id);
    files.releaseResource(id);
  });
  const resourceFiles: ResourceFiles = { ...files, get resources() { return files.resources; }, assertResourceReleasable, releaseResource };
  return {
    timeline,
    onlineTimeline,
    contentPolicy,
    resourceFiles,
    metadataBytes: (): number => onlineTimeline.totals().timelineBytes + files.descriptorBytes(),
  };
};
export type SessionContent = ReturnType<typeof openSessionContent>;

/**
 * Retire online-only data after the uploader has saved its verified archive
 * receipt. The caller holds the stopped Controller storage permit throughout.
 * Failures retain the journal and remaining resources for the same retry.
 */
export const retireStoppedOnlineContent = (journal: string, sessionId: string, db: Database.Database): void => {
  if (readSessionHistoryContentPolicy(db) !== "task_body") return;
  if (db.inTransaction) throw new Error("Online retirement owns its stopped journal transaction.");
  const row = db.prepare("SELECT snapshot,owner_pid,last_sequence=last_acknowledged AS acknowledged FROM execution WHERE id=1").get() as { snapshot: string; owner_pid: number | null; acknowledged: number };
  const snapshot = JSON.parse(row.snapshot) as { sessionId: string; executionGeneration: string; nativeStopped: boolean; lifecycle: string };
  if (snapshot.sessionId !== sessionId || !/^[1-9][0-9]*$/.test(snapshot.executionGeneration) || !snapshot.nativeStopped || snapshot.lifecycle !== "stopped" || row.owner_pid !== null || row.acknowledged !== 1) throw new Error("Online retirement requires the original stopped and acknowledged Session.");
  const receipt = JSON.parse(readFileSync(`${journal}.archive-receipt-${snapshot.executionGeneration}.json`, "utf8")) as { state: string; schemaVersion: number; sha256: string; byteLength: string };
  if (receipt.state !== "ready" || receipt.schemaVersion !== 3 || !/^[a-f0-9]{64}$/.test(receipt.sha256) || !/^[1-9][0-9]*$/.test(receipt.byteLength)) throw new Error("Online retirement requires its confirmed task-body archive receipt.");
  const content = openSessionContent(journal, sessionId, db, { read: action => db.inTransaction ? action() : db.transaction(action).deferred(), assertWrite: () => { if (!db.inTransaction) throw new Error("Online retirement requires its original transaction."); } });
  // Resource deletion retries enumerate the same remaining unreferenced files,
  // even when an earlier attempt already committed removal of the online rows.
  const keep = new Set<string>();
  db.transaction(() => {
    content.timeline.iterate(entry => { for (const id of sessionArchiveReferences([entry], false).resources) keep.add(id); });
    for (const native of db.prepare("SELECT resource_id FROM native_input_publication_images").iterate() as Iterable<{ resource_id: string }>) keep.add(native.resource_id);
  }).deferred();
  const removable = [...content.resourceFiles.resources.keys()].filter(id => !keep.has(id));
  // Check in-flight leases and pins independently of online references, which
  // end only after this check and the original stopped receipt are established.
  const files = openResourceFiles(journal, sessionId);
  for (const id of removable) files.assertResourceReleasable(id);
  const secureDelete = db.pragma("secure_delete", { simple: true });
  db.pragma("secure_delete = ON");
  try {
    db.transaction(() => {
      db.prepare("DELETE FROM image_runtime_state WHERE key LIKE 'markdown:projection:%' AND (json_extract(value,'$.entryId') IN (SELECT id FROM online_entries) OR json_extract(value,'$.input.kind') NOT IN ('user_message','assistant_message'))").run();
      db.prepare("DELETE FROM image_runtime_state WHERE key LIKE 'markdown:source:%' AND json_extract(value,'$.occurrence.entryId') IS NOT NULL AND json_extract(value,'$.occurrence.entryId') NOT IN (SELECT id FROM timeline_entries)").run();
      db.prepare("DELETE FROM image_runtime_state WHERE key LIKE 'markdown:context:%' AND json_extract(value,'$.entryId') IS NOT NULL AND json_extract(value,'$.entryId') NOT IN (SELECT id FROM timeline_entries)").run();
      db.prepare("DELETE FROM image_occurrences WHERE json_extract(occurrence,'$.entryId') NOT IN (SELECT id FROM timeline_entries)").run();
      db.prepare("DELETE FROM online_entries").run();
      db.prepare("DELETE FROM timeline_source_revisions WHERE entry_id NOT IN (SELECT id FROM timeline_entries)").run();
      db.prepare("UPDATE online_totals SET entry_count=0,byte_length=0 WHERE id=1").run();
    }).immediate();
  } finally { db.pragma(`secure_delete = ${secureDelete === 0 ? "OFF" : secureDelete === 2 ? "FAST" : "ON"}`); }
  for (const id of removable) content.resourceFiles.releaseResource(id);
  content.resourceFiles.retryCleanup();
  if ((db.pragma("freelist_count", { simple: true }) as number) > 0) db.exec("VACUUM");
  const checkpoint = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
  if (checkpoint.some(result => result.busy !== 0)) throw new Error("Online detail retirement is waiting for journal readers to release their snapshots.");
};
