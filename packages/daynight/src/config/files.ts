import { lstat, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { ConfigurationPaths } from "./paths.js";
import { replaceFileAtomically } from "../platform/files.js";
import { MissingConfigurationFileError } from "./errors.js";
import { parseConfigurationDocument } from "./document.js";
import { verifyConfigurationUpdate } from "./ownership.js";
import type { ConfigurationOwnership } from "./ownership.js";

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const isMissingFile = async (file: string): Promise<boolean> => {
  const absolute = path.resolve(file);
  const root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep)) {
    current = path.join(current, component);
    let entry;
    try { entry = await lstat(current); }
    catch (cause) {
      if (hasCode(cause, "ENOENT")) return true;
      return false;
    }
    if (entry.isSymbolicLink()) {
      try { entry = await stat(current); }
      catch { return false; }
    }
    if (current !== absolute && !entry.isDirectory()) return false;
  }
  return false;
};

export const readConfigurationSource = async (paths: ConfigurationPaths, signal?: AbortSignal): Promise<string> => {
  try {
    return await readFile(paths.configFile, { encoding: "utf8", ...(signal === undefined ? {} : { signal }) });
  } catch (cause) {
    if (hasCode(cause, "ENOENT") && await isMissingFile(paths.configFile)) {
      throw new MissingConfigurationFileError(paths.configFile, cause);
    }
    throw new Error(`Cannot read configuration file ${paths.configFile}.`, { cause });
  }
};

export type ConfigurationUpdate<Result> =
  | { kind: "unchanged"; result: Result }
  | { kind: "write"; result: Result; source: string; ownership: ConfigurationOwnership };

export const updateConfigurationFile = async <Result>(
  paths: ConfigurationPaths,
  update: (source: string | undefined) => Promise<ConfigurationUpdate<Result>>,
  signal?: AbortSignal,
): Promise<Result> => {
  signal?.throwIfAborted();
  await mkdir(path.dirname(paths.configFile), { recursive: true });
  const lockFile = `${paths.configFile}.lock`;
  let lock;
  try {
    lock = await open(lockFile, "wx", 0o600);
  } catch (cause) {
    throw new Error(hasCode(cause, "EEXIST")
      ? `Configuration is locked by another writer at ${lockFile}; retry when that writer exits. Remove the lock only after confirming no writer is running.`
      : `Cannot acquire configuration lock ${lockFile}.`, { cause });
  }
  let failure: unknown;
  try {
    let existingEntry;
    try {
      existingEntry = await lstat(paths.configFile);
    } catch (cause) {
      if (!hasCode(cause, "ENOENT")) {
        throw new Error(`Cannot inspect configuration file ${paths.configFile}.`, { cause });
      }
    }
    if (existingEntry !== undefined && !existingEntry.isFile()) {
      throw new Error(`Configuration file ${paths.configFile} must be a regular file; symbolic-link writes are not supported.`);
    }
    const source = existingEntry === undefined ? undefined : await readConfigurationSource(paths);
    const updated = await update(source);
    signal?.throwIfAborted();
    if (updated.kind === "write") {
      const before = source === undefined ? {} : parseConfigurationDocument(source, paths).mapping;
      const { mapping } = parseConfigurationDocument(updated.source, paths);
      verifyConfigurationUpdate(before, mapping, updated.ownership);
      const mode = process.platform !== "win32" && Object.hasOwn(mapping, "serverToken") ? 0o600 : existingEntry?.mode;
      await replaceFileAtomically(paths.configFile, updated.source, mode);
    }
    return updated.result;
  } catch (cause) {
    failure = cause;
    throw cause;
  } finally {
    const cleanup: unknown[] = [];
    try { await lock.close(); } catch (cause) { cleanup.push(cause); }
    try { await unlink(lockFile); } catch (cause) { cleanup.push(cause); }
    if (cleanup.length !== 0) {
      throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Configuration update or lock cleanup failed.");
    }
  }
};
