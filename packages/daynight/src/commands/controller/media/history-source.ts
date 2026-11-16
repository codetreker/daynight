import type Database from "better-sqlite3";
import { SESSION_ARCHIVE_HISTORY_MAX_BYTES, sessionArchiveReferences } from "../../../session/archive.js";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { SessionContent } from "../content/session-content.js";
import type { TimelineEntry } from "../../../session/protocol.js";
import { parseImageError, type ImageError } from "../../../session/image-values.js";
import { writeDurableJson } from "../../../platform/durable-json.js";
export type ImageHistorySyncIntent = { syncId: string; historyEpoch: string; sourceThrough: string; sha256: string; byteLength: string; filename: string };
type Transactions = { read<T>(action: () => T): T; write<T>(action: () => T): T };
const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
export const createImageHistorySource = (file: string, db: Database.Database, content: SessionContent, transactions: Transactions, reserveContent: (additionalBytes: number, contentGrowth: number) => void) => {
  const root = `${file}.history-sync`, key = "active_history_sync", checkpoint = "active_history_checkpoint", failureKey = "active_history_failure";
  const syncDirectory = () => { if (process.platform !== "win32") { const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } } };
  const intent = (): ImageHistorySyncIntent | null => {
    const row = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(key) as { value: string } | undefined;
    if (!row) return null;
    const value = JSON.parse(row.value) as ImageHistorySyncIntent;
    if (!new RegExp(`^${uuid}$`).test(value.syncId) || value.filename !== path.join(root, `${value.syncId}.json`) || !/^[a-f0-9]{64}$/.test(value.sha256) || !/^[1-9][0-9]{0,8}$/.test(value.byteLength) || Number(value.byteLength) > SESSION_ARCHIVE_HISTORY_MAX_BYTES) throw new Error("Controller history synchronization intent is corrupt.");
    return value;
  };
  const prepareImageHistorySync = (): ImageHistorySyncIntent | null => transactions.write(() => {
    const previous = intent(); if (previous) return previous;
    const source = db.prepare("SELECT CAST(last_sequence AS TEXT) AS through,CAST(last_acknowledged AS TEXT) AS ack,projection_gap,archive_incomplete FROM execution WHERE id=1").get() as { through: string; ack: string; projection_gap: string | null; archive_incomplete: number };
    if (source.through !== source.ack) return null;
    if (source.projection_gap !== null || source.archive_incomplete) throw new Error("Controller history has an unresolved projection gap.");
    const epoch = db.prepare("SELECT value FROM image_runtime_state WHERE key='history_epoch'").get() as { value: string } | undefined;
    if (!epoch) return null;
    const historyEpoch = JSON.parse(epoch.value) as string;
    const completed = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(checkpoint) as { value: string } | undefined;
    if (completed) { const c = JSON.parse(completed.value) as ImageHistorySyncIntent; if (c.historyEpoch === historyEpoch && c.sourceThrough === source.through) return null; }
    mkdirSync(root, { recursive: true, mode: 0o700 }); const directory = lstatSync(root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || process.platform !== "win32" && (directory.mode & 0o077) !== 0) throw new Error("Controller history synchronization directory must be private.");
    // A file without a committed intent could never have been sent. Preserve
    // every file while an original intent is still pending or unknown.
    for (const name of readdirSync(root)) if (new RegExp(`^${uuid}\\.json(?:\\.${uuid}\\.tmp)?$`).test(name)) { const p = path.join(root, name); const stat = lstatSync(p); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid frozen controller history file."); unlinkSync(p); }
    syncDirectory();
    const entries: TimelineEntry[] = [];
    content.timeline.iterate(entry => { entries.push(entry); });
    const resources = [...sessionArchiveReferences(entries, false).resources].sort().map(id => {
      const resource = content.resourceFiles.resources.get(id)?.resource;
      if (!resource) throw new Error("Controller history references a missing resource descriptor.");
      return resource;
    });
    const body = { historyEpoch, sourceThrough: source.through, entries, resources }, bytes = Buffer.from(JSON.stringify(body));
    if (bytes.length > SESSION_ARCHIVE_HISTORY_MAX_BYTES) throw new Error("Controller image history exceeds its synchronization budget.");
    reserveContent(bytes.length + 16_384, bytes.length);
    const syncId = randomUUID(), filename = path.join(root, `${syncId}.json`), next: ImageHistorySyncIntent = { syncId, filename, historyEpoch, sourceThrough: source.through, byteLength: String(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex") };
    writeDurableJson(filename, body);
    // Acquire write access before sealing: Windows cannot flush a read-only handle.
    const fd = openSync(filename, constants.O_RDWR | constants.O_NOFOLLOW); try { chmodSync(filename, 0o400); fsyncSync(fd); } finally { closeSync(fd); } syncDirectory();
    db.prepare("INSERT INTO image_runtime_state VALUES(?,?)").run(key, JSON.stringify(next));
    return next;
  });
  return { prepareImageHistorySync,
    hasImageHistoryCheckpoint: (sourceThrough: string): boolean => transactions.read(() => {
      const epoch = db.prepare("SELECT value FROM image_runtime_state WHERE key='history_epoch'").get() as { value: string } | undefined;
      const completed = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(checkpoint) as { value: string } | undefined;
      if (!epoch || !completed) return false;
      const value = JSON.parse(completed.value) as ImageHistorySyncIntent;
      return value.historyEpoch === JSON.parse(epoch.value) && BigInt(value.sourceThrough) >= BigInt(sourceThrough);
    }),
    getImageHistorySyncFailure: (): ImageError | null => transactions.read(() => {
      const row = db.prepare("SELECT value FROM image_runtime_state WHERE key=?").get(failureKey) as { value: string } | undefined;
      return row ? parseImageError(JSON.parse(row.value)) : null;
    }),
    finishImageHistorySync: (syncId: string, complete: boolean, failure?: ImageError): void => {
      const savedFailure = complete ? null : parseImageError(failure);
      const current = transactions.write(() => {
        const current = intent(); if (!current || current.syncId !== syncId) throw new Error("Controller history synchronization identity changed.");
        if (complete) {
          db.prepare("INSERT INTO image_runtime_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(checkpoint, JSON.stringify(current));
          db.prepare("DELETE FROM image_runtime_state WHERE key=?").run(failureKey);
        } else {
          db.prepare("INSERT INTO image_runtime_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(failureKey, JSON.stringify(savedFailure));
        }
        db.prepare("DELETE FROM image_runtime_state WHERE key=?").run(key); return current;
      });
      unlinkSync(current.filename); syncDirectory();
    },
  };
};
