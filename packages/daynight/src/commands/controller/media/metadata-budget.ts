import type Database from "better-sqlite3";
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
export const CONTROLLER_METADATA_BYTES = 128 * 1048576;
export const CONTROLLER_SETTLEMENT_BYTES = 8 * 1048576;
export class ControllerMetadataBudgetError extends Error {
  constructor() { super("Controller metadata budget exceeded."); }
}
/** Count real SQLite sidecars and the pending archive's metadata, excluding blobs. */
export const controllerMetadataBudget = (file: string, db: Database.Database) => {
  const nativeIndexBytes = (): number => {
    const visit = (filename: string): number => {
      const stat = lstatSync(filename);
      if (stat.isSymbolicLink()) throw new Error("Controller native index contains an untrusted symbolic link.");
      if (stat.isDirectory()) return readdirSync(filename).reduce((sum, name) => sum + visit(path.join(filename, name)), 0);
      if (!stat.isFile()) throw new Error("Controller native index must contain regular files.");
      return stat.size;
    };
    try { return visit(`${file}.native-index`); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
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
    try { visit(pending); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
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
    if (db.memory) return total + Number(db.pragma("page_count", { simple: true })) * Number(db.pragma("page_size", { simple: true }));
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try { const stat = lstatSync(`${file}${suffix}`); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Controller metadata is not a private regular file."); total += stat.size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    try { for (const name of readdirSync(`${file}.history-sync`)) { const stat = lstatSync(path.join(`${file}.history-sync`, name)); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Controller history metadata is not a private regular file."); total += stat.size; } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return total;
  };
  const assert = (additional = 0, settlement = false): void => {
    if (!Number.isSafeInteger(additional) || additional < 0) throw new Error("Controller metadata budget exceeded.");
    if (bytes() + additional > CONTROLLER_METADATA_BYTES + (settlement ? CONTROLLER_SETTLEMENT_BYTES : 0)) throw new ControllerMetadataBudgetError();
  };
  return { bytes, assert, nativeIndexBytes };
};
