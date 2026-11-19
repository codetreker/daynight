import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { controllerPayloadHash } from "../../controller/launch-ticket.js";
import type { BotExecution } from "./execution-store.js";
import { resolveBotPaths } from "./paths.js";
import { botUUID, parseBotOwner, type BotOwner, type BotRecord } from "./types.js";

export type BotMigrationPhase = "prepared" | "copied" | "verified" | "committed";
export type BotMigrationFile = { source: string; destination: string; sha256: string; bytes: number; kind: "file" | "sqlite" };
export type BotMigrationManifest = {
  schemaVersion: 1; owner: BotOwner; botId: string; phase: BotMigrationPhase;
  sourceDatabase: string; sourceRecordHash: string; sourceExecutionHash: string;
  original: { record: BotRecord; execution: BotExecution | null };
  files: BotMigrationFile[]; journal: string | null; ticket: string | null;
  registration: "pending"; nativeRecovery: "missing" | "unverified";
};
export const botMigrationManifestPath = (stateDirectory: string, botId: string): string => path.join(resolveBotPaths(stateDirectory, botId).directory, "migration.json");
export const botMigrationHash = (manifest: BotMigrationManifest): string => {
  const { phase: _phase, ...content } = manifest;
  return controllerPayloadHash(content);
};
export const assertMigrationPhysicalPath = (file: string, kind: "file" | "directory"): void => {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) throw new Error("Bot migration paths must be canonical and absolute.");
  const entry = lstatSync(file);
  if (entry.isSymbolicLink() || (kind === "file" ? !entry.isFile() : !entry.isDirectory()) || realpathSync(file) !== file
    || process.platform !== "win32" && (entry.uid !== process.getuid!() || kind === "directory" && (entry.mode & 0o077) !== 0)) throw new Error("Bot migration requires physical files and private directories owned by the current operating-system user.");
};
export const migrationDestination = (stateDirectory: string, botId: string, relative: string): string => {
  if (typeof relative !== "string" || relative.includes("\\") || relative.split("/").some(part => part === "" || part === "." || part === "..")
    || !relative.startsWith("legacy/") || path.isAbsolute(relative) || /[\0\r\n]/.test(relative)) throw new Error("Bot migration destination escapes its owned legacy directory.");
  return path.join(resolveBotPaths(stateDirectory, botId).directory, ...relative.split("/"));
};
export const readBotMigrationManifest = (stateDirectory: string, owner: BotOwner, botId: string): BotMigrationManifest | null => {
  const file = botMigrationManifestPath(stateDirectory, botId);
  if (!existsSync(file)) return null;
  assertMigrationPhysicalPath(path.dirname(file), "directory"); assertMigrationPhysicalPath(file, "file");
  if (lstatSync(file).size > 32 * 1024 * 1024) throw new Error("Bot migration manifest exceeds its limit.");
  const value = JSON.parse(readFileSync(file, "utf8")) as BotMigrationManifest;
  const expected = parseBotOwner(owner);
  if (value === null || typeof value !== "object" || value.schemaVersion !== 1 || value.botId !== botUUID(botId, "Bot ID")
    || controllerPayloadHash(parseBotOwner(value.owner)) !== controllerPayloadHash(expected)
    || !["prepared", "copied", "verified", "committed"].includes(value.phase) || value.registration !== "pending"
    || !["missing", "unverified"].includes(value.nativeRecovery) || !path.isAbsolute(value.sourceDatabase)
    || !/^[a-f0-9]{64}$/.test(value.sourceRecordHash) || !/^[a-f0-9]{64}$/.test(value.sourceExecutionHash)
    || value.original?.record?.botId !== botId || controllerPayloadHash(value.original.record.owner) !== controllerPayloadHash(expected)
    || controllerPayloadHash(value.original.record) !== value.sourceRecordHash || controllerPayloadHash(value.original.execution) !== value.sourceExecutionHash
    || !Array.isArray(value.files) || new Set(value.files.map(item => item.destination)).size !== value.files.length) throw new Error("Bot migration manifest identity is inconsistent.");
  for (const item of value.files) {
    migrationDestination(stateDirectory, botId, item.destination);
    if (!path.isAbsolute(item.source) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !["file", "sqlite"].includes(item.kind)) throw new Error("Bot migration file evidence is invalid.");
  }
  for (const relative of [value.journal, value.ticket]) if (relative !== null) migrationDestination(stateDirectory, botId, relative);
  return value;
};

export const assertBotMigrationExecutable = (record: BotRecord): void => {
  if (record.migration !== undefined) throw new Error("Bot storage migration is committed; recovery identity registration and Provider verification are pending. The original execution must not be replayed.");
};
