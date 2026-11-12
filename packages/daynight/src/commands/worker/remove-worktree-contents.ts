import path from "node:path";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, readdir, rmdir, unlink } from "node:fs/promises";
import type { FileHandle, rm } from "node:fs/promises";
import type { Operation } from "../../api/operation.js";

const identity = (entry: BigIntStats): string => `${entry.dev}:${entry.ino}`;

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
  const root = await lstat(target, { bigint: true });
  operation.check();
  if (!root.isDirectory() || identity(root) !== expectedIdentity) throw new Error(`Worktree directory identity changed: ${target}`);
  const posix = process.platform !== "win32";
  const uid = posix ? BigInt(process.geteuid!()) : null;
  const checkDirectory = (current: BigIntStats, expected: BigIntStats, name: string): void => {
    if (!current.isDirectory() || identity(current) !== identity(expected) || current.uid !== expected.uid) throw new Error(`Worktree directory identity changed: ${name}`);
    if (posix && (current.uid !== uid || current.dev !== root.dev)) throw new Error(`Worktree directory owner or device is not safe for removal: ${name}`);
    if (posix && (current.mode & 0o500n) !== 0o500n) throw new Error(`Worktree directory requires existing owner read and search permissions: ${name}`);
  };
  const verifyDirectory = async (directory: string, entry: BigIntStats, handle: FileHandle | null): Promise<void> => {
    operation.check();
    checkDirectory(await lstat(directory, { bigint: true }), entry, directory);
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
    const handle = posix ? await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) : null;
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
          await handle.chmod(Number(current.mode & 0o7777n) | 0o200);
          operation.check();
          await verifyDirectory(directory, entry, handle);
        }
      }
      operation.check();
      const names = await readdir(directory);
      operation.check();
      for (const name of names) {
        if (keepRoot && name === ".git") continue;
        await verifyDirectory(directory, entry, handle);
        const child = path.join(directory, name);
        const observed = await lstat(child, { bigint: true });
        operation.check();
        if (observed.isDirectory()) {
          await visit(child, observed, false);
        } else {
          const current = await lstat(child, { bigint: true });
          operation.check();
          if (current.isDirectory() || identity(current) !== identity(observed) || (current.mode & 0o170000n) !== (observed.mode & 0o170000n)) throw new Error(`Worktree entry identity changed: ${child}`);
          await admitMutation();
          // Nonrecursive removal unlinks symlinks and hard links without
          // changing the target inode's permissions or following its contents.
          await removeEntry(child, { recursive: false });
          operation.check();
        }
        await verifyDirectory(directory, entry, handle);
      }
      await verifyDirectory(directory, entry, handle);
      if (!keepRoot) {
        await admitMutation();
        await rmdir(directory);
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
