import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureDurableDirectory, syncDurableDirectory } from "../../../platform/durable-directory.js";
import { sqliteFilename } from "../../../platform/sqlite-filename.js";
import { assertMigrationPhysicalPath, migrationDestination, type BotMigrationFile, type BotMigrationManifest } from "./migration-state.js";

export const migrationFileDigest = (file: string): { sha256: string; bytes: number } => {
  assertMigrationPhysicalPath(file, "file");
  const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024), fd = openSync(file, "r");
  let bytes = 0;
  try { for (;;) { const count = readSync(fd, buffer, 0, buffer.length, null); if (count === 0) break; hash.update(buffer.subarray(0, count)); bytes += count; } }
  finally { closeSync(fd); }
  return { sha256: hash.digest("hex"), bytes };
};
export const saveMigrationManifest = (file: string, value: BotMigrationManifest): void => {
  const temporary = `${file}.tmp`;
  if (existsSync(temporary)) assertMigrationPhysicalPath(temporary, "file");
  const fd = openSync(temporary, "w", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  if (existsSync(file)) assertMigrationPhysicalPath(file, "file");
  renameSync(temporary, file); syncDurableDirectory(path.dirname(file));
};
export const copyMigrationFile = async (source: string, destination: string, kind: "file" | "sqlite", signal: AbortSignal): Promise<{ sha256: string; bytes: number }> => {
  signal.throwIfAborted(); assertMigrationPhysicalPath(source, "file");
  ensureDurableDirectory(path.dirname(destination)); assertMigrationPhysicalPath(path.dirname(destination), "directory");
  const temporary = `${destination}.copy`;
  if (existsSync(temporary)) { assertMigrationPhysicalPath(temporary, "file"); unlinkSync(temporary); }
  if (kind === "sqlite") {
    for (const suffix of ["-wal", "-shm"]) if (existsSync(`${source}${suffix}`)) assertMigrationPhysicalPath(`${source}${suffix}`, "file");
    const db = new Database(sqliteFilename(source), { readonly: true, fileMustExist: true });
    try { await db.backup(sqliteFilename(temporary), { progress: () => { signal.throwIfAborted(); return 128; } }); }
    finally { db.close(); }
    chmodSync(temporary, 0o600);
    const fd = openSync(temporary, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); }
  } else {
    const input = openSync(source, "r"), output = openSync(temporary, "wx", 0o600), buffer = Buffer.alloc(64 * 1024);
    try {
      for (;;) {
        signal.throwIfAborted(); const count = readSync(input, buffer, 0, buffer.length, null); if (count === 0) break;
        let written = 0; while (written < count) written += writeSync(output, buffer, written, count - written);
      }
      fsyncSync(output);
    } finally { closeSync(input); closeSync(output); }
  }
  signal.throwIfAborted();
  if (existsSync(destination)) assertMigrationPhysicalPath(destination, "file");
  renameSync(temporary, destination); syncDurableDirectory(path.dirname(destination));
  return migrationFileDigest(destination);
};

/** Locks and WAL/SHM are process coordination; database backups include their committed pages. */
export const copyMigrationTree = async (source: string, relative: string, stateDirectory: string, botId: string, signal: AbortSignal): Promise<BotMigrationFile[]> => {
  assertMigrationPhysicalPath(source, "directory");
  const files: BotMigrationFile[] = [];
  for (const name of readdirSync(source).sort()) {
    signal.throwIfAborted();
    if (name === "storage.lock" || /\.sqlite-(wal|shm|journal)$/.test(name)) continue;
    const file = path.join(source, name), destination = `${relative}/${name}`, entry = lstatSync(file);
    if (entry.isSymbolicLink()) throw new Error("Bot migration cannot follow linked Controller resources.");
    if (entry.isDirectory()) files.push(...await copyMigrationTree(file, destination, stateDirectory, botId, signal));
    else {
      const kind = name.endsWith(".sqlite") ? "sqlite" : "file";
      const digest = await copyMigrationFile(file, migrationDestination(stateDirectory, botId, destination), kind, signal);
      files.push({ source: file, destination, kind, ...digest });
    }
  }
  return files;
};

export const verifyMigrationFiles = (stateDirectory: string, manifest: BotMigrationManifest): void => {
  for (const file of manifest.files) {
    const digest = migrationFileDigest(migrationDestination(stateDirectory, manifest.botId, file.destination));
    if (digest.sha256 !== file.sha256 || digest.bytes !== file.bytes) throw new Error("Bot migration copied resource digest changed; original evidence was retained.");
  }
};

export const verifyMigrationSources = async (stateDirectory: string, manifest: BotMigrationManifest, signal: AbortSignal): Promise<void> => {
  const listFiles = (directory: string): string[] => {
    signal.throwIfAborted(); assertMigrationPhysicalPath(directory, "directory");
    return readdirSync(directory).sort().flatMap(name => {
      if (name === "storage.lock" || /\.sqlite-(wal|shm|journal)$/.test(name)) return [];
      const file = path.join(directory, name), entry = lstatSync(file);
      if (entry.isSymbolicLink()) throw new Error("Bot migration cannot follow linked Controller resources.");
      return entry.isDirectory() ? listFiles(file) : [file];
    });
  };
  const intent = manifest.original.record.intent, execution = manifest.original.execution;
  const roots = [...(intent === null || !existsSync(path.dirname(intent.journalPath)) ? [] : [path.dirname(intent.journalPath)]),
    ...new Set([...(execution?.retainedAliasDirectories ?? []), ...(execution?.aliasDirectory == null ? [] : [execution.aliasDirectory])])];
  for (const root of roots) {
    const expected = manifest.files.filter(file => { const relative = path.relative(root, file.source); return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }).map(file => file.source).sort();
    if (JSON.stringify(listFiles(root).sort()) !== JSON.stringify(expected)) throw new Error("Bot migration original resource inventory changed after its snapshot.");
  }
  for (const file of manifest.files) {
    signal.throwIfAborted();
    const temporary = `${migrationDestination(stateDirectory, manifest.botId, file.destination)}.verify`;
    const digest = file.kind === "sqlite" ? await copyMigrationFile(file.source, temporary, "sqlite", signal) : migrationFileDigest(file.source);
    if (file.kind === "sqlite") { unlinkSync(temporary); syncDurableDirectory(path.dirname(temporary)); }
    if (digest.sha256 !== file.sha256 || digest.bytes !== file.bytes) throw new Error("Bot migration original resource changed after its snapshot; no authority was switched.");
  }
};
