import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";

type InstanceOwner = { owner: string; pid: number; startedAt: string };

export class InstanceLockHeldError extends Error {
  constructor(readonly pid: number) {
    super(`CLI process ${pid} is still running; its instance lock was retained.`);
    this.name = "InstanceLockHeldError";
  }
}
const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";

const withOwnershipGate = <T>(databaseFile: string, operation: () => T): T => {
  const database = new Database(databaseFile, { timeout: 5_000 });
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

export const acquireInstanceLock = async (lockFile: string, ownershipGateFile: string, owner: string = randomUUID()) => {
  const content = JSON.stringify({ owner, pid: process.pid, startedAt: new Date().toISOString() });
  let previousProcessesExcluded: boolean;
  try {
    previousProcessesExcluded = withOwnershipGate(ownershipGateFile, () => {
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
    });
  } catch (cause) {
    throw new Error(`Cannot acquire instance lock ${lockFile}. If recovery requires operator confirmation, confirm that the previous CLI and all managed processes have stopped before manually removing the lock.`, { cause });
  }
  let released = false;
  return {
    owner,
    previousProcessesExcluded,
    release: async (): Promise<void> => {
      if (released) return;
      withOwnershipGate(ownershipGateFile, () => {
        if (readFileSync(lockFile, "utf8").trim() !== content) throw new Error(`Instance lock ${lockFile} no longer belongs to this CLI; it was retained.`);
        unlinkSync(lockFile);
      });
      released = true;
    },
  };
};
