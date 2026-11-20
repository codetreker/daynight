import path from "node:path";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, readdir, rmdir, unlink } from "node:fs/promises";
import type { FileHandle, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Operation } from "../../api/operation.js";

const identity = (entry: BigIntStats): string => `${entry.dev}:${entry.ino}`;

// Windows binds a directory handle to every process working directory and keeps
// it open briefly after that process exits, so removal immediately after a
// terminated agent observes EBUSY on an otherwise unowned directory. These
// delays cover that release window; a directory held by a live process still
// fails with its original error once they are exhausted.
const busyRetryDelaysMs = [20, 40, 80, 160, 320];

/**
 * Each delay is a window in which another writer can replace the target, so
 * `reprove` must re-establish the same ownership the caller verified before its
 * first attempt and re-admit the mutation. Cancellation and deadline alone do
 * not make a later attempt safe.
 */
export const retryWhileBusy = async <T>(operation: Operation, reprove: () => Promise<void>, action: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) {
      if (attempt >= busyRetryDelaysMs.length) throw error;
      if (!(error instanceof Error && "code" in error && error.code === "EBUSY")) throw error;
      operation.check();
      await delay(busyRetryDelaysMs[attempt]!);
      operation.check();
      await reprove();
    }
  }
};

export class WorktreePermissionError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "WorktreePermissionError"; }
}
const filesystem = async <T>(action: () => Promise<T>): Promise<T> => {
  try { return await action(); }
  catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) throw new WorktreePermissionError("Worktree filesystem permission denied.", { cause: error });
    throw error;
  }
};

export type RemoveContentsInput = {
  target: string;
  expectedIdentity: string;
  operation: Operation;
  beforeMutation?: () => Promise<void>;
};

export const removeWorktreeContents = async (
  { target, expectedIdentity, operation, beforeMutation }: RemoveContentsInput,
  removeEntry: typeof rm = target => unlink(target),
): Promise<void> => {
  operation.check();
  const root = await filesystem(() => lstat(target, { bigint: true }));
  operation.check();
  if (!root.isDirectory() || identity(root) !== expectedIdentity) throw new Error(`Worktree directory identity changed: ${target}`);
  const posix = process.platform !== "win32";
  const uid = posix ? BigInt(process.geteuid!()) : null;
  const checkDirectory = (current: BigIntStats, expected: BigIntStats, name: string): void => {
    if (!current.isDirectory() || identity(current) !== identity(expected) || current.uid !== expected.uid) throw new Error(`Worktree directory identity changed: ${name}`);
    if (posix && current.dev !== root.dev) throw new Error(`Worktree directory device is not safe for removal: ${name}`);
    if (posix && current.uid !== uid) throw new WorktreePermissionError(`Worktree directory owner prevents ordinary removal: ${name}`);
    if (posix && (current.mode & 0o500n) !== 0o500n) throw new WorktreePermissionError(`Worktree directory requires existing owner read and search permissions: ${name}`);
  };
  const verifyDirectory = async (directory: string, entry: BigIntStats, handle: FileHandle | null): Promise<void> => {
    operation.check();
    checkDirectory(await filesystem(() => lstat(directory, { bigint: true })), entry, directory);
    operation.check();
    if (handle !== null) {
      checkDirectory(await handle.stat({ bigint: true }), entry, directory);
      operation.check();
    }
  };
  const admitMutation = async (): Promise<void> => {
    operation.check();
    if (beforeMutation !== undefined) await beforeMutation();
    operation.check();
  };
  const visit = async (directory: string, entry: BigIntStats, keepRoot: boolean): Promise<void> => {
    operation.check();
    checkDirectory(entry, entry, directory);
    // Handles bind permission recovery to the checked directory. Node has no
    // portable openat/unlinkat; path checks detect local replacement but do not
    // make path operations atomic against concurrent external writers.
    const handle = posix ? await filesystem(() => open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)) : null;
    let failure: unknown;
    let failed = false;
    try {
      operation.check();
      await verifyDirectory(directory, entry, handle);
      if (handle !== null) {
        const current = await handle.stat({ bigint: true });
        operation.check();
        checkDirectory(current, entry, directory);
        if ((current.mode & 0o200n) === 0n) {
          await admitMutation();
          await filesystem(() => handle.chmod(Number(current.mode & 0o7777n) | 0o200));
          operation.check();
          await verifyDirectory(directory, entry, handle);
        }
      }
      operation.check();
      const names = await filesystem(() => readdir(directory));
      operation.check();
      for (const name of names) {
        if (keepRoot && name === ".git") continue;
        await verifyDirectory(directory, entry, handle);
        const child = path.join(directory, name);
        const observed = await filesystem(() => lstat(child, { bigint: true }));
        operation.check();
        if (observed.isDirectory()) {
          await visit(child, observed, false);
        } else {
          const current = await filesystem(() => lstat(child, { bigint: true }));
          operation.check();
          if (current.isDirectory() || identity(current) !== identity(observed) || (current.mode & 0o170000n) !== (observed.mode & 0o170000n)) throw new Error(`Worktree entry identity changed: ${child}`);
          await admitMutation();
          // Nonrecursive removal unlinks symlinks and hard links without
          // changing the target inode's permissions or following its contents.
          await filesystem(() => retryWhileBusy(operation, async () => {
            await verifyDirectory(directory, entry, handle);
            const retained = await lstat(child, { bigint: true });
            if (retained.isDirectory() || identity(retained) !== identity(observed) || (retained.mode & 0o170000n) !== (observed.mode & 0o170000n)) throw new Error(`Worktree entry identity changed: ${child}`);
            await admitMutation();
          }, () => removeEntry(child, { recursive: false })));
          operation.check();
        }
        await verifyDirectory(directory, entry, handle);
      }
      await verifyDirectory(directory, entry, handle);
      if (!keepRoot) {
        await admitMutation();
        await filesystem(() => retryWhileBusy(operation, async () => {
          await verifyDirectory(directory, entry, handle);
          await admitMutation();
        }, () => rmdir(directory)));
        operation.check();
      }
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      if (handle !== null) {
        try { await handle.close(); }
        catch (error) {
          if (failed) throw new AggregateError([failure, error], `Worktree removal and directory handle cleanup failed: ${directory}`);
          throw error;
        }
      }
    }
  };
  await visit(target, root, true);
  operation.check();
};
