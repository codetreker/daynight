import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { access, opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type WorkerDirectoryInput = { path?: string; filter?: string; showHidden?: boolean; limit?: number; cursor?: string };
export type WorkerDirectoryResult = { path: string; parentPath: string | null; entries: { name: string; path: string }[]; nextCursor: string | null };
export type WorkerDirectoryErrorCode = "permission_denied" | "not_found" | "timeout" | "cancelled" | "invalid_path" | "io_error" | "invalid_cursor" | "limit_exceeded";
export class WorkerDirectoryError extends Error {
  constructor(readonly code: WorkerDirectoryErrorCode) { super(`Worker directory browse failed: ${code}.`); this.name = "WorkerDirectoryError"; }
}

type DirectoryMetadata = { directory: boolean; identity: string; revision: string };
export type DirectoryFileSystem = {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<DirectoryMetadata>;
  access(path: string): Promise<void>;
  openDirectory(path: string): Promise<{ read(): Promise<{ name: string; directory: boolean; symbolicLink: boolean } | null>; close(): Promise<void> }>;
};
const nativeFileSystem: DirectoryFileSystem = {
  realpath,
  stat: async target => { const value = await stat(target, { bigint: true }); return { directory: value.isDirectory(), identity: `${value.dev}:${value.ino}`, revision: `${value.mtimeNs}:${value.ctimeNs}` }; },
  access: target => access(target, constants.R_OK | constants.X_OK),
  openDirectory: async target => {
    const directory = await opendir(target, { bufferSize: 32 });
    return { read: async () => { const entry = await directory.read(); return entry === null ? null : { name: entry.name, directory: entry.isDirectory(), symbolicLink: entry.isSymbolicLink() }; }, close: () => directory.close() };
  },
};
const maxPathBytes = 4096, maxNameBytes = 1024, maxResponseBytes = 65_536, maxScanEntries = 10_000;
const validText = (value: unknown, maxBytes: number, allowEmpty = false): value is string => typeof value === "string"
  && (allowEmpty || value.trim() !== "") && value.isWellFormed() && !/\p{Cc}/u.test(value) && Buffer.byteLength(value) <= maxBytes;
const failure = (error: unknown): WorkerDirectoryError => {
  if (error instanceof WorkerDirectoryError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return new WorkerDirectoryError(code === "EACCES" || code === "EPERM" ? "permission_denied"
    : code === "ENOENT" ? "not_found" : code === "ENOTDIR" || code === "ELOOP" ? "invalid_path" : "io_error");
};

/**
 * Enumerate the target Worker's current layer only. OS access checks are the
 * admission boundary; no project-root restriction or file-content read applies.
 * Cursors expire on directory changes and browser-instance replacement.
 */
export const createWorkerDirectoryBrowser = (dependencies: { filesystem?: DirectoryFileSystem; platform?: NodeJS.Platform } = {}) => {
  const filesystem = dependencies.filesystem ?? nativeFileSystem;
  const windows = (dependencies.platform ?? process.platform) === "win32", paths = windows ? path.win32 : path.posix;
  const secret = randomBytes(32);
  // Node filesystem calls cannot be cancelled in flight. A timed-out syscall
  // retains its slot until it and its directory close settle, bounding backlog.
  let occupied = 0;
  const absolute = (value: unknown): value is string => {
    if (!validText(value, maxPathBytes)) return false;
    if (!windows) return paths.isAbsolute(value);
    const normalized = value.replaceAll("\\", "/");
    return /^[a-z]:\//i.test(normalized) || /^\/\/[^/?.][^/]*\/[^/]+(?:\/|$)/.test(normalized);
  };
  const cursorFor = (fingerprint: string, after: string): string => {
    const payload = Buffer.from(JSON.stringify({ version: 1, fingerprint, after })).toString("base64url");
    return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
  };
  const cursorAfter = (cursor: string | undefined, fingerprint: string): string | null => {
    if (cursor === undefined) return null;
    if (!validText(cursor, 4096)) throw new WorkerDirectoryError("invalid_cursor");
    const parts = cursor.split(".");
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) throw new WorkerDirectoryError("invalid_cursor");
    const expected = createHmac("sha256", secret).update(parts[0]!).digest();
    const supplied = Buffer.from(parts[1]!, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) throw new WorkerDirectoryError("invalid_cursor");
    let value: { version?: unknown; fingerprint?: unknown; after?: unknown };
    try { value = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")); }
    catch { throw new WorkerDirectoryError("invalid_cursor"); }
    if (value === null || value.version !== 1 || value.fingerprint !== fingerprint || !validText(value.after, maxNameBytes)) throw new WorkerDirectoryError("invalid_cursor");
    return value.after;
  };
  return async (input: WorkerDirectoryInput, options: { defaultCwd: string; signal: AbortSignal }): Promise<WorkerDirectoryResult> => {
    if (options.signal.aborted) throw new WorkerDirectoryError("cancelled");
    const target = input.path ?? options.defaultCwd, limit = input.limit ?? 100, filter = input.filter ?? "", showHidden = input.showHidden ?? false;
    if (!absolute(target) || input.path === null || !validText(filter, 256, true) || typeof showHidden !== "boolean") throw new WorkerDirectoryError("invalid_path");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || occupied >= 4) throw new WorkerDirectoryError("limit_exceeded");
    occupied++;
    let stopped: WorkerDirectoryError | undefined;
    const check = (): void => { if (stopped !== undefined) throw stopped; };
    const perform = async (): Promise<WorkerDirectoryResult> => {
      const resolved = paths.normalize(await filesystem.realpath(target)); check();
      if (!absolute(resolved)) throw new WorkerDirectoryError("invalid_path");
      const metadata = await filesystem.stat(resolved); check();
      if (!metadata.directory) throw new WorkerDirectoryError("invalid_path");
      await filesystem.access(resolved); check();
      const fingerprint = createHash("sha256").update(JSON.stringify([resolved, metadata.identity, metadata.revision, filter, showHidden])).digest("hex");
      const after = cursorAfter(input.cursor, fingerprint);
      let parentPath: string | null = paths.dirname(resolved);
      if (parentPath === resolved) parentPath = null;
      else {
        try { await filesystem.access(parentPath); check(); }
        catch (error) { check(); if (failure(error).code === "permission_denied" || failure(error).code === "not_found") parentPath = null; else throw error; }
      }
      const entries: WorkerDirectoryResult["entries"] = [];
      const directory = await filesystem.openDirectory(resolved);
      let scanned = 0;
      try {
        check();
        for (;;) {
          const entry = await directory.read(); check();
          if (entry === null) break;
          if (++scanned > maxScanEntries) throw new WorkerDirectoryError("limit_exceeded");
          if (!entry.directory && !entry.symbolicLink) continue;
          if (!validText(entry.name, maxNameBytes) || entry.name === "." || entry.name === ".." || entry.name.includes("/") || windows && entry.name.includes("\\")) throw new WorkerDirectoryError("limit_exceeded");
          if ((!showHidden && entry.name.startsWith(".")) || !entry.name.toLowerCase().includes(filter.toLowerCase()) || after !== null && entry.name <= after) continue;
          const entryPath = paths.join(resolved, entry.name);
          if (!validText(entryPath, maxPathBytes)) throw new WorkerDirectoryError("limit_exceeded");
          let isDirectory = entry.directory;
          if (entry.symbolicLink) {
            try { isDirectory = (await filesystem.stat(entryPath)).directory; check(); }
            catch (error) { check(); const code = (error as NodeJS.ErrnoException).code; if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") continue; throw error; }
          }
          if (!isDirectory) continue;
          const index = entries.findIndex(existing => existing.name > entry.name);
          entries.splice(index < 0 ? entries.length : index, 0, { name: entry.name, path: entryPath });
          if (entries.length > limit + 1) entries.pop();
        }
      } finally { await directory.close(); }
      check();
      const current = await filesystem.stat(resolved); check();
      if (current.identity !== metadata.identity || current.revision !== metadata.revision) throw new WorkerDirectoryError("invalid_cursor");
      let hasMore = entries.length > limit;
      if (hasMore) entries.pop();
      const result: WorkerDirectoryResult = { path: resolved, parentPath, entries, nextCursor: null };
      for (;;) {
        result.nextCursor = hasMore ? cursorFor(fingerprint, entries.at(-1)!.name) : null;
        if (Buffer.byteLength(JSON.stringify(result)) <= maxResponseBytes) return result;
        entries.pop(); hasMore = true;
        if (entries.length === 0) throw new WorkerDirectoryError("limit_exceeded");
      }
    };
    return new Promise<WorkerDirectoryResult>((resolve, reject) => {
      const stop = (code: "cancelled" | "timeout"): void => { stopped ??= new WorkerDirectoryError(code); reject(stopped); cleanup(); };
      const cancel = (): void => stop("cancelled");
      const timer = setTimeout(() => stop("timeout"), 5_000);
      const cleanup = (): void => { clearTimeout(timer); options.signal.removeEventListener("abort", cancel); };
      options.signal.addEventListener("abort", cancel, { once: true });
      void perform().then(value => { if (stopped === undefined) resolve(value); }, error => reject(stopped ?? failure(error)))
        .finally(() => { occupied--; cleanup(); });
      if (options.signal.aborted) cancel();
    });
  };
};
export const browseWorkerDirectory = createWorkerDirectoryBrowser();
