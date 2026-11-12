import { closeSync, lstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { SqliteAccessError } from "../../platform/sqlite-error.js";
import { acquireInstanceLockSync, InstanceLockHeldError } from "../../platform/instance-lock.js";

export type ControllerStoragePermit = {
  readonly journalFile: string;
  readonly owner: string;
  release(): void;
};
type PermitState = { readonly journalFile: string; readonly owner: string; readonly lockFile: string; released: boolean };
const permits = new WeakMap<ControllerStoragePermit, PermitState>();

export const isControllerStorageLockHeld = (error: unknown): boolean => {
  const active = new Set<Error>();
  const visit = (cause: unknown): boolean => {
    if (cause instanceof SqliteAccessError && cause.kind === "cleanup-failed") return false;
    if (cause instanceof InstanceLockHeldError) return true;
    if (!(cause instanceof Error) || active.has(cause)) return false;
    active.add(cause);
    try {
      if (cause instanceof AggregateError) return cause.errors.length > 0 && cause.errors.every(visit) && (cause.cause === undefined || visit(cause.cause));
      return visit(cause.cause);
    } finally { active.delete(cause); }
  };
  return visit(error);
};

export const controllerStorageConnectionIsOpen = (error: unknown): boolean => {
  const seen = new Set<unknown>();
  const visit = (cause: unknown): boolean => {
    if (seen.has(cause)) return false;
    seen.add(cause);
    if (cause instanceof SqliteAccessError) return !cause.connectionClosed;
    return cause instanceof Error && (visit(cause.cause) || cause instanceof AggregateError && cause.errors.some(visit));
  };
  return visit(error);
};

export const assertControllerStoragePermit = (permit: ControllerStoragePermit, journalFile: string): void => {
  const state = permits.get(permit);
  if (state === undefined || state.released || state.journalFile !== journalFile || permit.journalFile !== journalFile || permit.owner !== state.owner) throw new Error("Controller storage permit is invalid, released, or belongs to another execution.");
  const record: unknown = JSON.parse(readFileSync(state.lockFile, "utf8"));
  if (typeof record !== "object" || record === null || !("owner" in record) || record.owner !== state.owner || !("pid" in record) || record.pid !== process.pid) throw new Error("Controller storage lock no longer belongs to this permit; its evidence was retained.");
};

export const acquireControllerStoragePermit = (journalFile: string, deadline?: number, options: { fileMustExist?: boolean } = {}): ControllerStoragePermit => {
  if (deadline !== undefined && (!Number.isSafeInteger(deadline) || deadline <= Date.now())) throw new Error("Controller storage acquisition exceeded its deadline.");
  if (!path.isAbsolute(journalFile) || path.normalize(journalFile) !== journalFile) throw new TypeError("Controller journal path must be absolute and normalized.");
  const lockFile = path.join(path.dirname(journalFile), "storage.lock");
  if (options.fileMustExist !== true) {
    try { const descriptor = openSync(journalFile, "wx", 0o600); closeSync(descriptor); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  }
  const journal = lstatSync(journalFile);
  if (!journal.isFile() || journal.isSymbolicLink()) throw new Error("Controller journal must be a private regular file.");
  const lock = acquireInstanceLockSync(lockFile, journalFile, undefined, { fileMustExist: true, ...(deadline === undefined ? {} : { timeoutMs: () => Math.max(1, Math.min(5000, deadline - Date.now())) }) });
  const state: PermitState = { journalFile, owner: lock.owner, lockFile, released: false };
  const permit: ControllerStoragePermit = Object.freeze({ journalFile, owner: lock.owner, release: (): void => {
    if (state.released) return;
    assertControllerStoragePermit(permit, journalFile);
    lock.release();
    state.released = true;
  } });
  permits.set(permit, state);
  return permit;
};
