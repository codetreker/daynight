import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { jsonObjectSources } from "../../api/json-source.js";
import { canonicalId } from "../../api/parse.js";
import { isWebhookIssuedAt } from "../../api/webhook.js";

export class PayloadCleanupError extends Error {
  constructor(readonly path: string) { super("Could not remove temporary payload file."); }
}

export type PreparedOperation = {
  formatVersion: 1;
  serverOrigin: string;
  actorUserId: string;
  owner: { kind: "personal" | "team"; id: string };
  kind: string;
  operationId: string;
  issuedAt: string;
  endpointId: string | null;
  deliveryId: string | null;
  ifVersion: string | null;
  ifGeneration: string | null;
  requestSha256: string;
};

const writePrivate = async (path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> => {
  if (process.platform === "win32") throw new Error("Private file creation is unavailable on this platform.");
  signal.throwIfAborted();
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let identity: { dev: number; ino: number } | undefined;
  try {
    try {
      const stat = await file.stat();
      identity = { dev: stat.dev, ino: stat.ino };
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Could not create a private regular file.");
      await file.writeFile(bytes, { signal });
    } finally { await file.close(); }
    const current = await lstat(path);
    if (identity === undefined || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("Prepared operation file was replaced.");
  } catch (error) {
    try {
      const current = await lstat(path);
      if (identity === undefined || current.dev !== identity.dev || current.ino !== identity.ino) throw new PayloadCleanupError(path);
      await unlink(path);
    } catch (cleanup) {
      if (!(cleanup instanceof Error && "code" in cleanup && cleanup.code === "ENOENT")) throw new PayloadCleanupError(path);
    }
    throw error;
  }
};

export const writePrepared = async (path: string, value: PreparedOperation, signal: AbortSignal): Promise<void> => {
  await writePrivate(path, Buffer.from(`${JSON.stringify(value)}\n`), signal);
};

export const readPrepared = async (path: string, signal: AbortSignal): Promise<PreparedOperation> => {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    const limit = 2 * 256 * 1024 + 8192;
    if (!stat.isFile() || stat.size > limit) throw new Error("Invalid prepared operation file.");
    const buffer = Buffer.allocUnsafe(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    signal.throwIfAborted();
    if (size > limit) throw new Error("Invalid prepared operation file.");
    const source = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
    jsonObjectSources(source);
    const record = JSON.parse(source) as unknown;
    if (typeof record !== "object" || record === null || Array.isArray(record)) throw new Error("Invalid prepared operation file.");
    const r = record as Record<string, unknown>;
    const names = ["formatVersion", "serverOrigin", "actorUserId", "owner", "kind", "operationId", "issuedAt", "endpointId", "deliveryId", "ifVersion", "ifGeneration", "requestSha256"];
    const validId = (v: unknown): v is string => typeof v === "string" && canonicalId(v) === v;
    const validVersion = (v: unknown): boolean => v === null || typeof v === "string" && /^[1-9][0-9]*$/.test(v) && BigInt(v) <= 9_223_372_036_854_775_807n;
    if (Object.keys(r).length !== names.length || names.some((key) => !Object.hasOwn(r, key)) || r.formatVersion !== 1 || typeof r.serverOrigin !== "string" || typeof r.owner !== "object" || r.owner === null || Array.isArray(r.owner)) throw new Error("Invalid prepared operation file.");
    const owner = r.owner as Record<string, unknown>;
    let validOrigin = false;
    try { const url = new URL(r.serverOrigin); validOrigin = ["http:", "https:"].includes(url.protocol) && url.origin === r.serverOrigin; } catch { /* Invalid origin. */ }
    if (!validOrigin || Object.keys(owner).length !== 2 || !["personal", "team"].includes(String(owner.kind)) || !validId(owner.id) || !validId(r.actorUserId) || !validId(r.operationId) || !["endpoint.create", "endpoint.patch", "endpoint.delete", "signing-secret.rotate", "delivery.redeliver"].includes(String(r.kind)) || typeof r.issuedAt !== "string" || !isWebhookIssuedAt(r.issuedAt) || (r.endpointId !== null && !validId(r.endpointId)) || (r.deliveryId !== null && !validId(r.deliveryId)) || !validVersion(r.ifVersion) || !validVersion(r.ifGeneration) || typeof r.requestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.requestSha256)) throw new Error("Invalid prepared operation file.");
    return record as PreparedOperation;
  } finally { await file.close(); }
};

// Keep a read-only inode handle after the writer is closed. Linux resolves the
// procfs descriptor through linkat, so replacing the temporary name cannot
// substitute different bytes. The destination directory is pinned separately.
export const publishPayload = async (path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> => {
  if (process.platform !== "linux") throw new Error("Atomic private payload publication is unavailable on this platform.");
  signal.throwIfAborted();
  const name = basename(path), temporaryName = `.${name}.${randomUUID()}.tmp`;
  const temporary = join(dirname(path), temporaryName);
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  const anchoredTemporary = `/proc/self/fd/${directory.fd}/${temporaryName}`;
  let created = false;
  let identity: { dev: number; ino: number } | undefined;
  let retained: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const writer = await open(anchoredTemporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try {
      const stat = await writer.stat();
      identity = { dev: stat.dev, ino: stat.ino };
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Could not create a private regular file.");
      await writer.writeFile(bytes, { signal });
      // O_PATH preserves the inode without keeping a write-capable descriptor.
      retained = await open(`/proc/self/fd/${writer.fd}`, 0x200000);
      const bound = await retained.stat();
      if (bound.dev !== stat.dev || bound.ino !== stat.ino) throw new Error("Could not bind the payload file identity.");
    } finally { await writer.close(); }
    signal.throwIfAborted();
    const koffi = await import("koffi");
    const library = koffi.load("libc.so.6");
    const linkat = library.func("int linkat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, int flags)");
    if (linkat(-100, `/proc/self/fd/${retained!.fd}`, directory.fd, name, 0x400) !== 0) throw new Error("Could not publish payload without overwriting the destination.");
  } finally {
    let cleanupFailure = false;
    if (created) {
      try {
        const current = await lstat(anchoredTemporary);
        if (identity === undefined || current.dev !== identity.dev || current.ino !== identity.ino) cleanupFailure = true;
        else await unlink(anchoredTemporary);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) cleanupFailure = true;
      }
    }
    try { await retained?.close(); } catch { cleanupFailure = true; }
    try { await directory.close(); } catch { cleanupFailure = true; }
    if (cleanupFailure) throw new PayloadCleanupError(temporary);
  }
};
