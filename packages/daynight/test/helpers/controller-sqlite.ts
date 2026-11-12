import type Database from "better-sqlite3";
import { openSqliteDatabase, type OpenSqliteOptions } from "../../src/platform/sqlite-access.js";
import { acquireControllerStoragePermit, controllerStorageConnectionIsOpen, type ControllerStoragePermit } from "../../src/commands/controller/storage-lock.js";
import { controllerJournalStateDirectory, controllerJournalWriteOptions } from "../../src/commands/controller/storage-preparation.js";

const permits = new WeakMap<Database.Database, ControllerStoragePermit>();
type ControllerTestDatabaseOptions = Omit<OpenSqliteOptions, "file" | "format"> & { file: string; stateDirectory?: string };

export const openControllerTestDatabase = (options: ControllerTestDatabaseOptions): Database.Database => {
  const { file, stateDirectory = controllerJournalStateDirectory(file), ...databaseOptions } = options;
  const permit = acquireControllerStoragePermit(file, undefined, { fileMustExist: !options.allowCreate });
  try {
    const db = openSqliteDatabase({ ...controllerJournalWriteOptions(file, permit, stateDirectory), ...databaseOptions });
    permits.set(db, permit);
    return db;
  } catch (failure) {
    if (!controllerStorageConnectionIsOpen(failure)) {
      try { permit.release(); }
      catch (release) { throw new AggregateError([failure, release], "Controller test database admission and permit release failed."); }
    }
    throw failure;
  }
};

export const closeControllerTestDatabase = (db: Database.Database): void => {
  let failed = false, failure: unknown;
  try { if (db.open) db.close(); }
  catch (error) { failed = true; failure = error; }
  if (!db.open) {
    const permit = permits.get(db);
    if (permit !== undefined) {
      try { permit.release(); permits.delete(db); }
      catch (release) { if (failed) throw new AggregateError([failure, release], "Controller test database close and permit release failed."); throw release; }
    }
  }
  if (failed) throw failure;
};
