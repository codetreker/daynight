import type Database from "better-sqlite3";
import { lstatSync } from "node:fs";

export const controllerJournalPhysicalBytes = (file: string, db: Database.Database): { databaseBytes: number; walBytes: number; shmBytes: number; journalBytes: number } => {
  if (db.memory) return { databaseBytes: Number(db.pragma("page_count", { simple: true })) * Number(db.pragma("page_size", { simple: true })), walBytes: 0, shmBytes: 0, journalBytes: 0 };
  const size = (suffix: string): number => {
    try { const stat = lstatSync(`${file}${suffix}`); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Controller metadata is not a private regular file."); return stat.size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && suffix !== "") return 0; throw error; }
  };
  return { databaseBytes: size(""), walBytes: size("-wal"), shmBytes: size("-shm"), journalBytes: size("-journal") };
};
