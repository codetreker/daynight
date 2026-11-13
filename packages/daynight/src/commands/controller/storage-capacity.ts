import Database from "better-sqlite3";
import { lstatSync, statfsSync } from "node:fs";
import path from "node:path";
import { canonicalId } from "../../api/parse.js";
import { IMAGE_LIMITS } from "../../session/image-values.js";
import { ControllerMediaBudgetError, openMediaBudgetLedger } from "./media/budget-ledger.js";
import { controllerMediaDiskBytes } from "./media/disk-budget.js";
import { controllerMetadataBudget, ControllerMetadataBudgetError } from "./media/metadata-budget.js";

export class ControllerStorageFreeSpaceError extends Error {
  constructor() { super("Controller media storage free-space budget exceeded."); this.name = "ControllerStorageFreeSpaceError"; }
}
export const isControllerStorageCapacityError = (error: unknown): error is Error => error instanceof ControllerMediaBudgetError || error instanceof ControllerMetadataBudgetError || error instanceof ControllerStorageFreeSpaceError;
const exists = (file: string): boolean => {
  try { lstatSync(file); return true; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
};
const hasTable = (db: Database.Database, name: string): boolean => db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name) !== undefined;
const reservations = (file: string, db: Database.Database): Map<string, number> => {
  const root = `${file}.media-staging`, reserved = new Map<string, number>();
  if (hasTable(db, "image_preparations")) for (const row of db.prepare("SELECT value FROM image_preparations").iterate() as Iterable<{ value: string }>) {
    const value = JSON.parse(row.value) as { filename: string; spec: { byteLength: string }; receipt: { state: string } };
    if (!/^[a-f0-9-]{36}\.part$/.test(value.filename) || !/^[1-9][0-9]*$/.test(value.spec.byteLength) || BigInt(value.spec.byteLength) > BigInt(IMAGE_LIMITS.imageBytes)) throw new Error("Controller image preparation reservation is corrupt.");
    if (value.receipt.state !== "released") reserved.set(path.join(root, value.filename), Number(value.spec.byteLength));
  }
  if (hasTable(db, "image_runtime_state")) for (const row of db.prepare("SELECT key,value FROM image_runtime_state WHERE key LIKE 'capture-source:%'").iterate() as Iterable<{ key: string; value: string }>) {
    const value = JSON.parse(row.value) as { captureId: string; attemptId: string; source: string; stage: string; released: boolean };
    if (row.key !== `capture-source:${value.captureId}:${value.attemptId}` || typeof value.released !== "boolean" || !/^[a-f0-9-]{36}\.part$/.test(value.source) || !/^[a-f0-9-]{36}\.part$/.test(value.stage) || value.source === value.stage) throw new Error("Controller capture source reservation is corrupt.");
    if (!value.released) { reserved.set(path.join(root, value.source), IMAGE_LIMITS.imageBytes); reserved.set(path.join(root, value.stage), IMAGE_LIMITS.imageBytes); }
  }
  return reserved;
};

export const controllerStorageMediaUsage = (file: string, db: Database.Database): { reservedBytes: number; actualBytes: number } => {
  const roots = [`${file}.media-staging`, path.join(`${file}.pending-content`, "blobs")].filter(exists);
  return { reservedBytes: controllerMediaDiskBytes(roots, reservations(file, db)), actualBytes: controllerMediaDiskBytes(roots, new Map()) };
};

/** Replace the original execution's charge only after checking its complete remaining peak. */
export const reserveControllerStoragePeak = (file: string, stateDirectory: string, executionId: string | undefined, absoluteBytes: number, additionalDiskBytes: number, deadline?: number): void => {
  if (!Number.isSafeInteger(absoluteBytes) || absoluteBytes < 0 || !Number.isSafeInteger(additionalDiskBytes) || additionalDiskBytes < 0) throw new TypeError("Controller storage peak must be a nonnegative safe integer.");
  if (absoluteBytes > 2_306_867_200) throw new ControllerMediaBudgetError("execution");
  const space = statfsSync(path.dirname(file), { bigint: true });
  if (space.bavail * space.bsize < 536_870_912n + BigInt(additionalDiskBytes)) throw new ControllerStorageFreeSpaceError();
  if (executionId === undefined) return;
  if (canonicalId(executionId) !== executionId) throw new Error("Controller storage reservation requires its original execution identity.");
  const remaining = deadline === undefined ? 5000 : deadline - Date.now();
  if (remaining <= 0) throw new Error("Controller storage reservation exceeded its deadline.");
  const ledger = openMediaBudgetLedger(stateDirectory, executionId, { timeoutMs: Math.min(5000, remaining) });
  let failure: unknown;
  try { ledger.reserve(absoluteBytes); }
  catch (error) { failure = error; }
  try { ledger.close(); }
  catch (close) { if (failure !== undefined) throw new AggregateError([failure, close], "Controller storage reservation and ledger close failed."); throw close; }
  if (failure !== undefined) throw failure;
};

/** A reservation replaces the execution's absolute charge, including durable unfinished uploads. */
export const assertControllerStorageCapacity = (file: string, db: Database.Database, stateDirectory: string, executionId: string | undefined, additionalBytes = 0, deadline?: number): void => {
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new TypeError("Controller storage growth must be a nonnegative safe integer.");
  const metadata = controllerMetadataBudget(file, db);
  metadata.assert(additionalBytes);
  if (db.memory) return;
  const media = controllerStorageMediaUsage(file, db);
  reserveControllerStoragePeak(file, stateDirectory, executionId, media.reservedBytes + metadata.reservationCeiling(), Math.max(0, media.reservedBytes - media.actualBytes) + additionalBytes, deadline);
};
