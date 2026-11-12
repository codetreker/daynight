import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";

type InstanceOwner = { owner: string; pid: number; startedAt: string };

export class InstanceLockHeldError extends Error {
  constructor(readonly pid: number, options?: ErrorOptions) {
    super(`CLI process ${pid} is still running; its instance lock was retained.`, options);
    this.name = "InstanceLockHeldError";
  }
}
const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";

const withOwnershipGate = <T>(databaseFile: string, operation: () => T, fileMustExist = false, timeoutMs = 5_000): T => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError("Instance-lock timeout must be a positive safe integer of at most 60000 milliseconds.");
  const database = new Database(databaseFile, { timeout: timeoutMs, fileMustExist });
  let result: T;
  try { result = database.transaction(operation).immediate(); }
  catch (error) {
    try { database.close(); }
    catch (cause) { throw new AggregateError([error, cause], "Instance-lock operation and ownership-gate shutdown failed."); }
    throw error;
  }
  database.close();
  return result;
};

const readOwner = (content: string): InstanceOwner => {
  const value: unknown = JSON.parse(content);
  if (typeof value !== "object" || value === null || !("owner" in value) || typeof value.owner !== "string" || value.owner === "" ||
    !("pid" in value) || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid < 1 || value.pid > 2_147_483_647 ||
    !("startedAt" in value) || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) {
    throw new Error("The instance lock does not contain a valid owner, positive process ID, and startup timestamp; it was retained.");
  }
  return { owner: value.owner, pid: value.pid, startedAt: value.startedAt };
};

const liveOwnerAtBlockedGate = (lockFile: string, busy: unknown): unknown => {
  let original: string, record: InstanceOwner;
  try { original = readFileSync(lockFile, "utf8"); record = readOwner(original); }
  catch (observation) {
    if (isMissing(observation)) return busy;
    return new AggregateError([busy, observation], "SQLite ownership gate is busy and its instance-lock evidence cannot be read.");
  }
  try { process.kill(record.pid, 0); }
  catch (observation) { return new AggregateError([busy, observation], "SQLite ownership gate is busy and its original live lock owner is unconfirmed."); }
  try {
    if (readFileSync(lockFile, "utf8") !== original) throw new Error("Instance-lock ownership changed while its SQLite gate was busy.");
  } catch (observation) { return new AggregateError([busy, observation], "SQLite ownership gate is busy and its original lock evidence changed."); }
  return new InstanceLockHeldError(record.pid, { cause: busy });
};

const replaceOwner = (lockFile: string, content: string): void => {
  const temporary = `${lockFile}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${content}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    // Atomic replacement preserves the predecessor's evidence even if this CLI crashes while taking ownership.
    renameSync(temporary, lockFile);
  } catch (error) {
    const failures = [error];
    if (descriptor !== undefined) try { closeSync(descriptor); } catch (cause) { failures.push(cause); }
    try { unlinkSync(temporary); } catch (cause) { if (!isMissing(cause)) failures.push(cause); }
    if (failures.length > 1) throw new AggregateError(failures, "Instance-lock replacement and temporary-file cleanup failed.");
    throw error;
  }
};

export const acquireInstanceLockSync = (lockFile: string, ownershipGateFile: string, owner: string = randomUUID(), options: { timeoutMs?: () => number; fileMustExist?: boolean } = {}) => {
  const timeout = (): number => options.timeoutMs === undefined ? 5000 : options.timeoutMs();
  const content = JSON.stringify({ owner, pid: process.pid, startedAt: new Date().toISOString() });
  let previousProcessesExcluded: boolean, gateEntered = false;
  try {
    previousProcessesExcluded = withOwnershipGate(ownershipGateFile, () => {
      gateEntered = true;
      let previous: string | undefined;
      try { previous = readFileSync(lockFile, "utf8"); }
      catch (error) { if (!isMissing(error)) throw error; }
      if (previous !== undefined) {
        const record = readOwner(previous);
        try { process.kill(record.pid, 0); }
        catch (cause) {
          if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) {
            throw new Error(`Cannot determine whether CLI process ${record.pid} has stopped; the instance lock was retained.`, { cause });
          }
          replaceOwner(lockFile, content);
          return false;
        }
        throw new InstanceLockHeldError(record.pid);
      }
      replaceOwner(lockFile, content);
      return true;
    }, options.fileMustExist === true, timeout());
  } catch (cause) {
    const failure = !gateEntered && cause instanceof Error && "code" in cause && cause.code === "SQLITE_BUSY" ? liveOwnerAtBlockedGate(lockFile, cause) : cause;
    throw new Error(`Cannot acquire instance lock ${lockFile}. If recovery requires operator confirmation, confirm that the previous CLI and all managed processes have stopped before manually removing the lock.`, { cause: failure });
  }
  let released = false;
  return {
    owner,
    previousProcessesExcluded,
    release: (): void => {
      if (released) return;
      withOwnershipGate(ownershipGateFile, () => {
        if (readFileSync(lockFile, "utf8").trim() !== content) throw new Error(`Instance lock ${lockFile} no longer belongs to this CLI; it was retained.`);
        unlinkSync(lockFile);
      }, options.fileMustExist === true, timeout());
      released = true;
    },
  };
};


export const acquireInstanceLock = async (lockFile: string, ownershipGateFile: string, owner: string = randomUUID()) => {
  const lock = acquireInstanceLockSync(lockFile, ownershipGateFile, owner);
  return { ...lock, release: async (): Promise<void> => { lock.release(); } };
};

export class MaintenanceLockHeldError extends Error {
  constructor(readonly lockFile: string, options?: ErrorOptions) {
    super(`An existing instance lock blocks SQLite maintenance: ${lockFile}. Its ownership evidence was retained.`, options);
    this.name = "MaintenanceLockHeldError";
  }
}

export type MaintenancePaths = { lockFile: string; ownershipGateFile: string; gateFileMustExist: boolean };
export type MaintenancePermit = { owner: string; release(): void };

/** Maintenance cannot consume the predecessor uncertainty carried by an existing lock. */
export const acquireMaintenanceLock = (paths: MaintenancePaths): MaintenancePermit => {
  const owner = randomUUID();
  const content = JSON.stringify({ owner, pid: process.pid, startedAt: new Date().toISOString() });
  withOwnershipGate(paths.ownershipGateFile, () => {
    try { lstatSync(paths.lockFile); }
    catch (error) {
      if (!isMissing(error)) throw error;
      replaceOwner(paths.lockFile, content);
      return;
    }
    throw new MaintenanceLockHeldError(paths.lockFile);
  }, paths.gateFileMustExist);
  let released = false;
  const verify = (): void => {
    if (readFileSync(paths.lockFile, "utf8").trim() !== content) throw new Error(`Maintenance lock ${paths.lockFile} no longer belongs to this CLI; it was retained.`);
  };
  return {
    owner,
    release: (): void => {
      if (released) return;
      // A cooperating acquisition cannot replace our live PID while this lock remains.
      withOwnershipGate(paths.ownershipGateFile, verify, paths.gateFileMustExist);
      verify();
      unlinkSync(paths.lockFile);
      released = true;
    },
  };
};
