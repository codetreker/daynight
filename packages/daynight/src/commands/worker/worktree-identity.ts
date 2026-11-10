import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { canonicalResourceOwner } from "./resource-owner.js";
import type { ResourceOwner } from "./types.js";
import type { Operation } from "../../api/operation.js";
import { openDirectoryIdentity, publishDirectoryFile } from "../../platform/directory-identity.js";
import type { DirectoryIdentityLease, StableDirectoryIdentity } from "../../platform/directory-identity.js";

const filename = "daynight-identity.json";
const roles = ["root", "common", "admin", "leaf"] as const;
type Role = typeof roles[number];
export type WorktreeIdentitySidecar = {
  version: 1;
  owner: ResourceOwner;
  markerSha256: string;
  directories: Record<Role, StableDirectoryIdentity>;
};
type FileObservation = { bytes: Buffer; dev: bigint; ino: bigint };
export type WorktreeIdentityEvidence = {
  marker: FileObservation;
  sidecar: FileObservation | null;
  candidate: WorktreeIdentitySidecar | null;
};
export type WorktreeIdentityContext = {
  owner: ResourceOwner;
  paths: Record<Role, string>;
  runtime: { root: string; common: string; leaf: string | null };
  marker: string;
  verifyLeaf: boolean;
};
const fingerprint = (entry: { dev: bigint; ino: bigint }): string => `${entry.dev}:${entry.ino}`;
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const sameFile = (entry: BigIntStats, original: BigIntStats): boolean => entry.isFile() && entry.dev === original.dev && entry.ino === original.ino;
const privateFile = (entry: BigIntStats): void => {
  if (!entry.isFile() || entry.nlink !== 1n || typeof process.getuid !== "function" || entry.uid !== BigInt(process.getuid()) || (entry.mode & 0o7777n) !== 0o600n) throw new Error("Worktree identity sidecar must be a private, owned regular file with one link.");
};

const readFile = async (target: string, privateRequired: boolean): Promise<FileObservation | null> => {
  let initial: BigIntStats;
  try { initial = await lstat(target, { bigint: true }); } catch (error) { if (missing(error)) return null; throw error; }
  if (!initial.isFile()) throw new Error(`Worktree identity metadata ${target} must be an ordinary file.`);
  if (privateRequired) privateFile(initial);
  const file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const observed = await file.stat({ bigint: true });
    if (!sameFile(observed, initial)) throw new Error("Worktree identity metadata changed while opening.");
    if (privateRequired) privateFile(observed);
    if (observed.size > 32768n) throw new Error("Worktree identity metadata exceeds its size limit.");
    const buffer = Buffer.alloc(32769); let size = 0;
    while (size < buffer.length) { const result = await file.read(buffer, size, buffer.length - size, null); if (!result.bytesRead) break; size += result.bytesRead; }
    if (size > 32768) throw new Error("Worktree identity metadata exceeds its size limit.");
    const after = await file.stat({ bigint: true }), current = await lstat(target, { bigint: true });
    if (!sameFile(current, initial) || after.size !== observed.size || after.mtimeNs !== observed.mtimeNs || after.ctimeNs !== observed.ctimeNs) throw new Error("Worktree identity metadata changed while reading.");
    if (privateRequired) { privateFile(after); privateFile(current); }
    return { bytes: buffer.subarray(0, size), dev: initial.dev, ino: initial.ino };
  } finally { await file.close(); }
};
const object = (value: unknown, fields: string[]): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const parse = (bytes: Buffer): WorktreeIdentitySidecar => {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!object(value, ["version", "owner", "markerSha256", "directories"]) || value.version !== 1 || typeof value.markerSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.markerSha256) || !object(value.owner, ["projectId", "taskId", "claimId", "worktreeId"]) || !object(value.directories, [...roles])) throw new Error("Invalid worktree identity sidecar format.");
  if (!isDeepStrictEqual(canonicalResourceOwner(value.owner as ResourceOwner), value.owner)) throw new Error("Noncanonical worktree identity sidecar owner.");
  for (const role of roles) {
    const identity = value.directories[role];
    if (!object(identity, ["kind", "volumeUuid", "fileId"]) || identity.kind !== "darwin-apfs-v1" || typeof identity.volumeUuid !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(identity.volumeUuid) || identity.volumeUuid === "00000000-0000-0000-0000-000000000000" || typeof identity.fileId !== "string" || !/^[1-9][0-9]{0,19}$/.test(identity.fileId) || BigInt(identity.fileId) > 0xffffffffffffffffn) throw new Error("Invalid stable directory identity in worktree sidecar.");
  }
  return value as WorktreeIdentitySidecar;
};

export const verifyWorktreeSidecar = async (admin: string, expected: FileObservation | null): Promise<void> => {
  const current = await readFile(path.join(admin, filename), true);
  if (expected === null ? current !== null : current === null || current.dev !== expected.dev || current.ino !== expected.ino || !current.bytes.equals(expected.bytes)) throw new Error("Worktree identity sidecar changed during the operation.");
};

export const verifyWorktreeIdentityMetadata = async (admin: string, expected: WorktreeIdentityEvidence): Promise<void> => {
  const marker = await readFile(path.join(admin, "locked"), false);
  if (marker === null || marker.dev !== expected.marker.dev || marker.ino !== expected.marker.ino || !marker.bytes.equals(expected.marker.bytes)) throw new Error("Worktree ownership marker changed during the operation.");
  await verifyWorktreeSidecar(admin, expected.sidecar);
};

export const inspectWorktreeIdentity = async (context: WorktreeIdentityContext, operation: Operation): Promise<WorktreeIdentityEvidence> => {
  const leases = new Map<Role, DirectoryIdentityLease>();
  try {
    for (const role of roles) {
      operation.check();
      if (role === "leaf" && !context.verifyLeaf) continue;
      const lease = await openDirectoryIdentity(context.paths[role]); leases.set(role, lease);
      if (role !== "admin" && fingerprint(lease.runtime) !== context.runtime[role]) throw new Error(`Worktree ${role} identity changed during inspection.`);
    }
    const marker = await readFile(path.join(context.paths.admin, "locked"), false);
    if (marker === null || marker.bytes.toString("utf8").replace(/\r?\n$/, "") !== context.marker) throw new Error("Worktree ownership marker changed during identity inspection.");
    const sidecar = await readFile(path.join(context.paths.admin, filename), true);
    const directories = {} as Record<Role, StableDirectoryIdentity>;
    for (const [role, lease] of leases) if (lease.stable.kind === "supported") directories[role] = lease.stable.identity;
    const candidate: WorktreeIdentitySidecar | null = roles.every(role => directories[role] !== undefined)
      ? { version: 1, owner: canonicalResourceOwner(context.owner), markerSha256: digest(marker.bytes), directories } : null;
    if (sidecar !== null) {
      const stored = parse(sidecar.bytes);
      if (!isDeepStrictEqual(stored.owner, canonicalResourceOwner(context.owner)) || stored.markerSha256 !== digest(marker.bytes)) throw new Error("Worktree identity sidecar does not match the original ownership marker.");
      for (const [role, lease] of leases) {
        if (lease.stable.kind !== "supported") throw new Error(`Stable worktree identity cannot be verified: ${lease.stable.reason}`);
        if (!isDeepStrictEqual(stored.directories[role], lease.stable.identity)) throw new Error(`Stable worktree ${role} volume or object identity changed.`);
      }
    }
    for (const lease of leases.values()) await lease.verifyPath();
    const confirmedMarker = await readFile(path.join(context.paths.admin, "locked"), false);
    if (confirmedMarker === null || !confirmedMarker.bytes.equals(marker.bytes)) throw new Error("Worktree ownership marker changed during identity inspection.");
    await verifyWorktreeSidecar(context.paths.admin, sidecar);
    operation.check();
    return { marker, sidecar, candidate };
  } finally {
    const results = await Promise.allSettled([...leases.values()].map(lease => lease.close()));
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Worktree identity lease cleanup failed.");
  }
};

export const bootstrapWorktreeIdentity = async (admin: string, expected: WorktreeIdentitySidecar, operation: Operation, verify: () => Promise<WorktreeIdentityEvidence>): Promise<void> => {
  const lease = await openDirectoryIdentity(admin);
  const temporary = `.daynight-identity.${randomUUID()}.tmp`;
  let created = false;
  try {
    const before = await verify();
    if (!isDeepStrictEqual(before.candidate, expected)) throw new Error("Worktree identity changed before publication.");
    if (lease.handle === null || lease.stable.kind !== "supported") throw new Error("Stable worktree identity publication is unavailable.");
    if (before.sidecar === null) {
      operation.check(); await lease.verifyPath();
      const file = await open(path.join(admin, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try { await file.writeFile(`${JSON.stringify(expected)}\n`); await file.sync(); } finally { await file.close(); }
      operation.check();
      const confirmed = await verify();
      if (!isDeepStrictEqual(confirmed.candidate, expected)) throw new Error("Worktree identity changed before publication.");
      await lease.verifyPath();
      try { await publishDirectoryFile(lease, temporary, filename); created = false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    await lease.handle.sync();
    const after = await verify();
    if (after.sidecar === null || !isDeepStrictEqual(parse(after.sidecar.bytes), expected)) throw new Error("Worktree identity publication could not be confirmed.");
    await lease.verifyPath(); operation.check();
  } finally {
    try { if (created) { await lease.verifyPath(); try { await unlink(path.join(admin, temporary)); } catch (error) { if (!missing(error)) throw error; } } }
    finally { await lease.close(); }
  }
};
