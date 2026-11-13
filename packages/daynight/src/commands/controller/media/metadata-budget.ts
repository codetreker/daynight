import type Database from "better-sqlite3";
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { SESSION_ARCHIVE_HISTORY_MAX_BYTES, SESSION_ARCHIVE_TIMELINE_MAX_BYTES } from "../../../session/archive.js";
export const CONTROLLER_METADATA_BYTES = 128 * 1048576;
export const CONTROLLER_SETTLEMENT_BYTES = 8 * 1048576;
export class ControllerMetadataBudgetError extends Error {
  constructor() { super("Controller metadata budget exceeded."); }
}
const rootExists = (file: string): boolean => {
  try { lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};
export const controllerJournalPhysicalBytes = (file: string, db: Database.Database): { databaseBytes: number; walBytes: number; shmBytes: number; journalBytes: number } => {
  if (db.memory) return { databaseBytes: Number(db.pragma("page_count", { simple: true })) * Number(db.pragma("page_size", { simple: true })), walBytes: 0, shmBytes: 0, journalBytes: 0 };
  const size = (suffix: string): number => {
    try { const stat = lstatSync(`${file}${suffix}`); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Controller metadata is not a private regular file."); return stat.size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && suffix !== "") return 0; throw error; }
  };
  return { databaseBytes: size(""), walBytes: size("-wal"), shmBytes: size("-shm"), journalBytes: size("-journal") };
};
/** Count real SQLite sidecars and the pending archive's metadata, excluding blobs. */
export const controllerMetadataBudget = (file: string, db: Database.Database) => {
  const contentBytes = (): number => {
    let timeline = 0, history = 0;
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='timeline_totals'").get()) {
      const row = db.prepare("SELECT byte_length FROM timeline_totals WHERE id=1").get() as { byte_length: number } | undefined;
      if (!row || !Number.isSafeInteger(row.byte_length) || row.byte_length < 0 || row.byte_length > SESSION_ARCHIVE_TIMELINE_MAX_BYTES) throw new Error("Controller timeline totals are corrupt.");
      timeline = row.byte_length;
    }
    if (!db.memory && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_runtime_state'").get()) {
      const row = db.prepare("SELECT value FROM image_runtime_state WHERE key='active_history_sync'").get() as { value: string } | undefined;
      if (row) {
        const intent = JSON.parse(row.value) as { syncId?: unknown; filename?: unknown; byteLength?: unknown };
        if (typeof intent.syncId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(intent.syncId) || intent.filename !== path.join(`${file}.history-sync`, `${intent.syncId}.json`) || typeof intent.byteLength !== "string" || !/^[1-9][0-9]{0,8}$/.test(intent.byteLength) || Number(intent.byteLength) > SESSION_ARCHIVE_HISTORY_MAX_BYTES) throw new Error("Controller history synchronization intent is corrupt.");
        try {
          const stat = lstatSync(intent.filename);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Number(intent.byteLength)) throw new Error("Controller history synchronization file is corrupt.");
          history = stat.size;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    return timeline + history;
  };
  const nativeIndexBytes = (): number => {
    const visit = (filename: string): number => {
      const stat = lstatSync(filename);
      if (stat.isSymbolicLink()) throw new Error("Controller native index contains an untrusted symbolic link.");
      if (stat.isDirectory()) return readdirSync(filename).reduce((sum, name) => sum + visit(path.join(filename, name)), 0);
      if (!stat.isFile()) throw new Error("Controller native index must contain regular files.");
      return stat.size;
    };
    return rootExists(`${file}.native-index`) ? visit(`${file}.native-index`) : 0;
  };
  const bytes = (): number => {
    let total = 0;
    const pending = `${file}.pending-content`;
    const visit = (filename: string): void => {
      const stat = lstatSync(filename);
      if (stat.isSymbolicLink()) throw new Error("Controller pending metadata contains an untrusted symbolic link.");
      if (stat.isDirectory()) { for (const name of readdirSync(filename)) if (filename !== pending || name !== "blobs") visit(path.join(filename, name)); }
      else if (stat.isFile()) total += stat.size;
      else throw new Error("Controller pending metadata must contain regular files.");
    };
    if (rootExists(pending)) visit(pending);
    let indexMaximum = nativeIndexBytes();
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='image_runtime_state'").get()) {
      const row = db.prepare("SELECT value FROM image_runtime_state WHERE key='native_index_reservation'").get() as { value: string } | undefined;
      if (row) {
        const reservation = JSON.parse(row.value) as { maximumBytes?: unknown };
        if (!Number.isSafeInteger(reservation.maximumBytes) || Number(reservation.maximumBytes) < 0 || Number(reservation.maximumBytes) > CONTROLLER_METADATA_BYTES) throw new Error("Controller native index reservation is corrupt.");
        // The outstanding ceiling replaces the covered index bytes; writing the
        // admitted batch never charges those same bytes a second time.
        indexMaximum = Math.max(indexMaximum, Number(reservation.maximumBytes));
      }
    }
    total += indexMaximum;
    const physical = controllerJournalPhysicalBytes(file, db);
    total += physical.databaseBytes + physical.walBytes + physical.shmBytes + physical.journalBytes;
    if (rootExists(`${file}.timeline-maintenance`)) visit(`${file}.timeline-maintenance`);
    if (db.memory) return total;
    if (rootExists(`${file}.history-sync`)) {
      const directory = lstatSync(`${file}.history-sync`);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Controller history metadata is not a private directory.");
      for (const name of readdirSync(`${file}.history-sync`)) { const stat = lstatSync(path.join(`${file}.history-sync`, name)); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Controller history metadata is not a private regular file."); total += stat.size; }
    }
    return total;
  };
  const ceiling = (contentGrowth = 0): number => {
    if (!Number.isSafeInteger(contentGrowth) || contentGrowth < 0 || contentGrowth > SESSION_ARCHIVE_HISTORY_MAX_BYTES) throw new Error("Controller content growth is invalid.");
    return CONTROLLER_METADATA_BYTES + CONTROLLER_SETTLEMENT_BYTES + contentBytes() + contentGrowth;
  };
  const reservationCeiling = (contentGrowth = 0): number => {
    const base = CONTROLLER_METADATA_BYTES + CONTROLLER_SETTLEMENT_BYTES;
    return base + Math.ceil((ceiling(contentGrowth) - base) / (8 * 1048576)) * (8 * 1048576);
  };
  const assert = (additional = 0, settlement = false, contentGrowth = 0): void => {
    if (!Number.isSafeInteger(additional) || additional < 0 || contentGrowth > additional) throw new Error("Controller metadata budget exceeded.");
    if (bytes() + additional > ceiling(contentGrowth) - (settlement ? 0 : CONTROLLER_SETTLEMENT_BYTES)) throw new ControllerMetadataBudgetError();
  };
  return { bytes, assert, ceiling, reservationCeiling, nativeIndexBytes };
};
