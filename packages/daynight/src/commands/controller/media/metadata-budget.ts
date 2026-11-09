import type Database from "better-sqlite3";
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
export const CONTROLLER_METADATA_BYTES = 128 * 1048576;
export const CONTROLLER_SETTLEMENT_BYTES = 8 * 1048576;
/** Count real SQLite sidecars and the pending archive's metadata, excluding blobs. */
export const controllerMetadataBudget = (file: string, db: Database.Database) => {
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
    if (!Number.isSafeInteger(additional) || additional < 0 || bytes() + additional > CONTROLLER_METADATA_BYTES + (settlement ? CONTROLLER_SETTLEMENT_BYTES : 0)) throw new Error("Controller metadata budget exceeded.");
  };
  return { bytes, assert };
};
