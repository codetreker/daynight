import path from "node:path";
import { lstat, readdir, realpath, rmdir } from "node:fs/promises";
import { createOperation, type Operation } from "../../api/operation.js";
import { removeWorktreeContents } from "./remove-worktree-contents.js";

/** Delete one explicitly selected source after the caller records authorization.
 * Handles and inode checks fence the original tree; no recursive rm follows paths.
 */
export const removeOwnedSourceDirectory = async (rootDirectory: string, sourceDirectory: string, operation?: Operation, expected?: { rootIdentity: string; sourceIdentity: string }): Promise<void> => {
  const root = path.resolve(rootDirectory), source = path.resolve(sourceDirectory);
  if (!path.isAbsolute(rootDirectory) || !path.isAbsolute(sourceDirectory) || path.dirname(source) !== root) throw new Error("Source deletion requires one original directory directly under the source root.");
  const local = operation ?? createOperation({ limits: { totalMs: 300_000 } });
  try {
    const parent = await lstat(root, { bigint: true });
    if (!parent.isDirectory() || await realpath(root) !== root) throw new Error("Source root must be a physical directory without symbolic links.");
    let target;
    try { target = await lstat(source, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!target.isDirectory() || await realpath(source) !== source) throw new Error("Source directory must be a physical directory without symbolic links.");
    const id = (entry: { dev: bigint; ino: bigint }) => `${entry.dev}:${entry.ino}`;
    if (expected !== undefined && (id(parent) !== expected.rootIdentity || id(target) !== expected.sourceIdentity)) throw new Error("Source directory directory identity changed after capture.");
    const verify = async (): Promise<void> => {
      local.check();
      const p = await lstat(root, { bigint: true }), t = await lstat(source, { bigint: true });
      if (!p.isDirectory() || !t.isDirectory() || id(p) !== id(parent) || id(t) !== id(target)) throw new Error("Source directory directory identity changed during disposal.");
    };
    const inspect = async (directory: string): Promise<void> => {
      await verify();
      for (const name of await readdir(directory)) {
        const entry = await lstat(path.join(directory, name));
        if (entry.isSymbolicLink() || name === ".git") throw new Error("Source directory contains a symbolic link or Git metadata; explicit disposal is refused.");
        if (entry.isDirectory()) await inspect(path.join(directory, name));
        else if (!entry.isFile()) throw new Error("Source directory contains an unsupported filesystem entry.");
      }
    };
    await inspect(source);
    await removeWorktreeContents({ target: source, expectedIdentity: id(target), operation: local, beforeMutation: verify });
    await verify();
    await rmdir(source);
  } finally { if (operation === undefined) local.dispose(); }
};
