import path from "node:path";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, readdir, rmdir, unlink } from "node:fs/promises";
import type { FileHandle, rm } from "node:fs/promises";
import type { Operation } from "../../api/operation.js";

const identity = (entry: BigIntStats): string => `${entry.dev}:${entry.ino}`;
type OpenDirectory = { target: string; entry: BigIntStats; handle: FileHandle | null };

export const removeWorktreeContents = async (
  target: string,
  expectedIdentity: string,
  operation: Operation,
  verifyOwnership: () => Promise<void>,
  removeEntry: typeof rm = target => unlink(target),
): Promise<void> => {
  operation.check();
  await verifyOwnership();
  operation.check();
  const root = await lstat(target, { bigint: true });
  if (!root.isDirectory() || identity(root) !== expectedIdentity) throw new Error(`Worktree directory identity changed: ${target}`);
  const posix = process.platform !== "win32";
  const uid = posix ? BigInt(process.geteuid!()) : null;
  const ancestors: OpenDirectory[] = [];
  const checkDirectory = (current: BigIntStats, expected: BigIntStats, name: string): void => {
    if (!current.isDirectory() || identity(current) !== identity(expected) || current.uid !== expected.uid) throw new Error(`Worktree directory identity changed: ${name}`);
    if (posix && (current.uid !== uid || current.dev !== root.dev)) throw new Error(`Worktree directory owner or device is not safe for removal: ${name}`);
    if (posix && (current.mode & 0o500n) !== 0o500n) throw new Error(`Worktree directory requires existing owner read and search permissions: ${name}`);
  };
  const verify = async (): Promise<void> => {
    operation.check();
    await verifyOwnership();
    operation.check();
    for (const ancestor of ancestors) {
      checkDirectory(await lstat(ancestor.target, { bigint: true }), ancestor.entry, ancestor.target);
      operation.check();
      if (ancestor.handle !== null) {
        checkDirectory(await ancestor.handle.stat({ bigint: true }), ancestor.entry, ancestor.target);
        operation.check();
      }
    }
  };
  const visit = async (directory: string, entry: BigIntStats, keepRoot: boolean): Promise<void> => {
    operation.check();
    checkDirectory(entry, entry, directory);
    // Node has no portable openat/unlinkat interface. Handles bind chmod to the
    // verified inode; path operations also recheck every retained ancestor.
    const handle = posix ? await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) : null;
    ancestors.push({ target: directory, entry, handle });
    let failure: unknown;
    let failed = false;
    try {
      await verify();
      if (handle !== null) {
        const current = await handle.stat({ bigint: true });
        checkDirectory(current, entry, directory);
        operation.check();
        if ((current.mode & 0o200n) === 0n) {
          await handle.chmod(Number(current.mode & 0o7777n) | 0o200);
          await verify();
        }
      }
      const names = await readdir(directory);
      operation.check();
      for (const name of names) {
        if (keepRoot && name === ".git") continue;
        await verify();
        const child = path.join(directory, name);
        const observed = await lstat(child, { bigint: true });
        operation.check();
        if (observed.isDirectory()) {
          await visit(child, observed, false);
        } else {
          await verify();
          const current = await lstat(child, { bigint: true });
          if (current.isDirectory() || identity(current) !== identity(observed) || (current.mode & 0o170000n) !== (observed.mode & 0o170000n)) throw new Error(`Worktree entry identity changed: ${child}`);
          operation.check();
          // Nonrecursive removal unlinks symlinks and hard links without
          // changing the target inode's permissions or following its contents.
          await removeEntry(child, { recursive: false });
          operation.check();
        }
      }
      await verify();
      if (!keepRoot) await rmdir(directory);
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      ancestors.pop();
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
