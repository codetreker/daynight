import Database from "better-sqlite3";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";
import { record } from "./native-rpc.js";

export type CodexPersistenceConfiguration = { config: unknown; requirements: unknown };
const invalid = (): Error => new Error("Native Codex initial settings metadata is unconfirmed.");
const object = (value: unknown): boolean => value !== null && typeof value === "object" && !Array.isArray(value);

/** Match Codex's process-relative CODEX_HOME and dirs::home_dir fallback. */
export const codexNativeHome = (env: NodeJS.ProcessEnv, cwd: string): string => env.CODEX_HOME
  ? resolve(cwd, env.CODEX_HOME)
  : resolve(cwd, process.platform !== "win32" && env.HOME || userInfo().homedir, ".codex");

/** Resolve the native configuration priority without discovering or creating databases. */
export const codexMetadataPath = (configuration: CodexPersistenceConfiguration, env: NodeJS.ProcessEnv, home: string, cwd: string): string => {
  if (!object(configuration.config) || !object(record(configuration.config).config) || !object(configuration.requirements)) throw invalid();
  const requirements = record(configuration.requirements).requirements;
  if (requirements !== null && !object(requirements)) throw invalid();
  const managed = record(requirements).sqliteHome, configured = record(record(configuration.config).config).sqlite_home;
  let directory: string;
  if (managed !== undefined && managed !== null) {
    if (typeof managed !== "string") throw invalid();
    try { directory = fileURLToPath(managed); } catch { throw invalid(); }
  } else if (configured !== undefined && configured !== null) {
    if (typeof configured !== "string" || !isAbsolute(configured)) throw invalid();
    directory = configured;
  } else {
    const fromEnvironment = env.CODEX_SQLITE_HOME?.trim();
    directory = fromEnvironment ? resolve(cwd, fromEnvironment) : home;
  }
  if (!isAbsolute(directory)) throw invalid();
  // Codex state layout: https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/state/src/sqlite.rs#L52
  return join(directory, "state_5.sqlite");
};

/** Each observation uses one committed row and releases its SQLite snapshot before returning. */
export const observeCodexMetadata = (databasePath: string, owner: { threadId: string; path: string; cwd: string }, expected: { model?: string; effort?: string }): (() => Promise<boolean>) => {
  let identity: { dev: number; ino: number; path: string } | undefined;
  return async () => {
    let named;
    try { named = await lstat(databasePath); }
    catch (error) { if (!identity && record(error).code === "ENOENT") return false; throw invalid(); }
    if (!named.isFile()) throw invalid();
    const canonical = await realpath(databasePath);
    if (identity && (named.dev !== identity.dev || named.ino !== identity.ino || canonical !== identity.path)) throw invalid();
    identity ??= { dev: named.dev, ino: named.ino, path: canonical };
    let row: unknown, db: Database.Database | undefined, busy = false;
    try {
      db = new Database(canonical, { readonly: true, fileMustExist: true, timeout: 0 });
      row = db.prepare("SELECT id, rollout_path, cwd, model, reasoning_effort FROM threads WHERE id = ?").get(owner.threadId);
    } catch (error) {
      const code = record(error).code;
      if (typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))) busy = true;
      else throw invalid();
    } finally { db?.close(); }
    const after = await lstat(databasePath);
    if (!after.isFile() || after.dev !== identity.dev || after.ino !== identity.ino || await realpath(databasePath) !== identity.path) throw invalid();
    if (busy || row === undefined) return false;
    const metadata = record(row);
    if (metadata.id !== owner.threadId || typeof metadata.rollout_path !== "string" || typeof metadata.cwd !== "string"
      || !isAbsolute(metadata.rollout_path) || !isAbsolute(metadata.cwd)
      || await realpath(metadata.rollout_path) !== owner.path || await realpath(metadata.cwd) !== owner.cwd) throw invalid();
    return (expected.model === undefined || metadata.model === expected.model) && (expected.effort === undefined || metadata.reasoning_effort === expected.effort);
  };
};
