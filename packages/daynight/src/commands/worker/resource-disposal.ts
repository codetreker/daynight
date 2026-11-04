import path from "node:path";
import { lstat, readdir, realpath, rmdir, statfs } from "node:fs/promises";
import { createOperation } from "../../api/operation.js";
import type { Operation } from "../../api/operation.js";
import { canonicalId } from "../../api/parse.js";
import { removeWorktreeContents } from "./remove-worktree-contents.js";
import type { HerdrDisposalRequest, HerdrResourceTarget, HerdrRetainedResource } from "./herdr/resource-types.js";

export type WorkerResourceCommandRequest = { kind: "list" } | ({ kind: "retry" } & HerdrResourceTarget) | ({ kind: "dispose" } & HerdrDisposalRequest);

export const assertHerdrResourceBudget = (resources: readonly HerdrRetainedResource[], availableBytes: bigint): void => {
  const retained = resources.filter(value => !value.worktreeDeleted);
  if (retained.length >= 20) throw new Error("Herdr retained worktree budget reached (20); inspect worker resources before acquiring another claim.");
  let pendingBytes = 0n;
  for (const resource of resources) {
    if (!/^(0|[1-9][0-9]*)$/.test(resource.sourceBytes)) throw new Error("The retained recording source size is unknown; new claims are blocked.");
    if (resource.state !== "ready" && resource.state !== "unavailable") pendingBytes += BigInt(resource.sourceBytes);
  }
  if (pendingBytes >= 2147483648n) throw new Error("Herdr pending recording source budget reached (2 GiB); new claims are blocked.");
  // Ready sources remain on disk. They are excluded only from the pending upload
  // count, never from this actual filesystem availability check.
  if (availableBytes < 1073741824n) throw new Error("Worker disk availability is below 1 GiB; new claims are blocked.");
};

export const herdrAvailableDiskBytes = async (directory: string): Promise<bigint> => {
  const filesystem = await statfs(directory, { bigint: true });
  return filesystem.bavail * filesystem.bsize;
};

export const assertHerdrDisposalTarget = (resource: HerdrRetainedResource, request: HerdrDisposalRequest): void => {
  if (request.confirmed !== true || !["abandon", "delete"].includes(request.action)) throw new Error("Resource disposal requires an explicit confirmed action.");
  if (canonicalId(request.operationId) !== request.operationId) throw new Error("Resource disposal requires a canonical operation identity.");
  for (const field of ["projectId", "taskId", "claimId", "worktreeId"] as const) {
    if (canonicalId(request[field]) !== request[field] || resource.owner[field] !== request[field]) throw new Error("The disposal identity differs from the original retained execution.");
  }
  if (canonicalId(request.sessionId) !== request.sessionId || resource.sessionId !== request.sessionId) throw new Error("The disposal identity differs from the original retained Session.");
  if (!resource.stopped || resource.stopEvidence.length === 0 || resource.stopEvidence.some(proof => proof.terminalStopped !== true)) throw new Error("The original execution stop is unconfirmed; disposal is prohibited.");
  if (!resource.terminal) throw new Error("The original claim is not terminal; disposal is prohibited while recovery remains possible.");
  if (resource.disposition !== null && (resource.disposition.operationId !== request.operationId || resource.disposition.action !== request.action)) throw new Error("Another original disposal decision already owns these resources.");
};

/** Delete one explicitly selected source after the caller records authorization.
 * Handles and inode checks fence the original tree; no recursive rm follows paths.
 */
export const removeHerdrSourceDirectory = async (rootDirectory: string, sourceDirectory: string, operation?: Operation): Promise<void> => {
  const root = path.resolve(rootDirectory), source = path.resolve(sourceDirectory);
  if (!path.isAbsolute(rootDirectory) || !path.isAbsolute(sourceDirectory) || path.dirname(source) !== root) throw new Error("Source deletion requires one original directory directly under the recording root.");
  const local = operation ?? createOperation({ limits: { totalMs: 300_000 } });
  try {
    const parent = await lstat(root, { bigint: true });
    if (!parent.isDirectory() || await realpath(root) !== root) throw new Error("Recording root must be a physical directory without symbolic links.");
    let target;
    try { target = await lstat(source, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!target.isDirectory() || await realpath(source) !== source) throw new Error("Recording source must be a physical directory without symbolic links.");
    const id = (entry: { dev: bigint; ino: bigint }) => `${entry.dev}:${entry.ino}`;
    const verify = async (): Promise<void> => {
      local.check();
      const p = await lstat(root, { bigint: true }), t = await lstat(source, { bigint: true });
      if (!p.isDirectory() || !t.isDirectory() || id(p) !== id(parent) || id(t) !== id(target)) throw new Error("Recording source directory identity changed during disposal.");
    };
    const inspect = async (directory: string): Promise<void> => {
      await verify();
      for (const name of await readdir(directory)) {
        const entry = await lstat(path.join(directory, name));
        if (entry.isSymbolicLink() || name === ".git") throw new Error("Recording source contains a symbolic link or Git metadata; explicit disposal is refused.");
        if (entry.isDirectory()) await inspect(path.join(directory, name));
        else if (!entry.isFile()) throw new Error("Recording source contains an unsupported filesystem entry.");
      }
    };
    await inspect(source);
    await removeWorktreeContents(source, id(target), local, verify);
    await verify();
    await rmdir(source);
  } finally { if (operation === undefined) local.dispose(); }
};
