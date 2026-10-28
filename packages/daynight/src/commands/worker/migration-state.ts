import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomically } from "../../platform/files.js";
import type { WorkerPaths } from "./paths.js";

export type MigrationFile = { target: string; backup: string; hash: string; mode: number; parentIdentity: string };
export type MigrationTreeEntry = { relative: string; directory: boolean; hash: string | null; mode: number };
export type WorkspaceMigrationManifest = {
  version: 1;
  workerDirectory: string;
  backupDirectory: string;
  phase: string;
  files: MigrationFile[];
  privateTree: { existed: boolean; entries: MigrationTreeEntry[] };
};

export const workspaceMigrationFile = (paths: Pick<WorkerPaths, "workerDirectory">): string => path.join(paths.workerDirectory, "workspace-migration.json");
export const migrationMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
export const migrationHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const migrationExists = async (target: string): Promise<boolean> => {
  try { await lstat(target); return true; } catch (error) { if (migrationMissing(error)) return false; throw error; }
};
export const migrationDirectoryIdentity = async (target: string): Promise<string> => {
  const entry = await lstat(target, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Migration directory must be ordinary: ${target}.`);
  return `${entry.dev}:${entry.ino}`;
};
export const readMigrationFile = async (target: string): Promise<Buffer> => {
  const entry = await lstat(target);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Migration input must be an ordinary file: ${target}.`);
  return readFile(target);
};
export const syncMigrationDirectory = async (directory: string): Promise<void> => {
  // Windows does not expose a directory handle usable by fsync through Node.
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
};
export const writeMigrationFile = async (target: string, contents: string | Uint8Array, mode = 0o600): Promise<void> => {
  await replaceFileAtomically(target, contents, mode);
  await syncMigrationDirectory(path.dirname(target));
};

export const assertWorkerWorkspaceMigrationReady = async (paths: Pick<WorkerPaths, "workerDirectory">): Promise<void> => {
  if (await migrationExists(workspaceMigrationFile(paths))) {
    throw new Error("A worker workspace migration is incomplete. Keep the worker stopped and run daynight worker migrate-workspaces --rollback before retrying the migration.");
  }
};

const below = (root: string, relative: string): string => {
  const target = path.resolve(root, relative);
  if (relative === "" || path.isAbsolute(relative) || target === root || !target.startsWith(`${root}${path.sep}`)) throw new Error("The migration backup contains an invalid relative path.");
  return target;
};
export const captureMigrationTree = async (root: string, omitted: ReadonlySet<string> = new Set()): Promise<MigrationTreeEntry[]> => {
  const result: MigrationTreeEntry[] = [];
  const visit = async (directory: string): Promise<void> => {
    await migrationDirectoryIdentity(directory);
    for (const name of (await readdir(directory)).sort()) {
      const target = path.join(directory, name);
      if (omitted.has(target)) continue;
      const entry = await lstat(target);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error(`Migration backup cannot contain a symlink or special file: ${target}.`);
      result.push({ relative: path.relative(root, target), directory: entry.isDirectory(), hash: entry.isDirectory() ? null : migrationHash(await readMigrationFile(target)), mode: entry.mode & 0o777 });
      if (entry.isDirectory()) await visit(target);
    }
  };
  await visit(root);
  return result;
};
const copyTree = async (source: string, destination: string, entries: readonly MigrationTreeEntry[]): Promise<void> => {
  await mkdir(destination, { mode: 0o700 });
  for (const entry of entries) {
    const target = below(destination, entry.relative);
    if (entry.directory) await mkdir(target, { mode: 0o700 });
    else {
      const bytes = await readMigrationFile(below(source, entry.relative));
      if (migrationHash(bytes) !== entry.hash) throw new Error(`The migration backup source changed: ${entry.relative}.`);
      await writeMigrationFile(target, bytes, entry.mode);
    }
  }
  for (const entry of [...entries].reverse()) if (entry.directory) {
    const directory = below(destination, entry.relative);
    await chmod(directory, entry.mode);
    await syncMigrationDirectory(directory);
  }
  await syncMigrationDirectory(destination);
};

export const createWorkspaceMigrationBackup = async (
  paths: WorkerPaths,
  targets: readonly string[],
  omitted: ReadonlySet<string>,
): Promise<WorkspaceMigrationManifest> => {
  const backupRoot = path.join(paths.workerDirectory, "workspace-migration-backups");
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await migrationDirectoryIdentity(backupRoot);
  const backupDirectory = path.join(backupRoot, randomUUID());
  await mkdir(backupDirectory, { mode: 0o700 });
  await mkdir(path.join(backupDirectory, "files"), { mode: 0o700 });
  const files: MigrationFile[] = [];
  for (const target of targets) {
    const bytes = await readMigrationFile(target);
    const metadata = await lstat(target);
    const backup = path.join("files", `${files.length}.bin`);
    await writeMigrationFile(path.join(backupDirectory, backup), bytes, metadata.mode);
    files.push({ target, backup, hash: migrationHash(bytes), mode: metadata.mode & 0o777, parentIdentity: await migrationDirectoryIdentity(path.dirname(target)) });
  }
  const existed = await migrationExists(paths.herdrDirectory);
  const entries = existed ? await captureMigrationTree(paths.herdrDirectory, omitted) : [];
  if (existed) {
    await copyTree(paths.herdrDirectory, path.join(backupDirectory, "herdr"), entries);
    if (JSON.stringify(await captureMigrationTree(path.join(backupDirectory, "herdr"))) !== JSON.stringify(entries)
      || JSON.stringify(await captureMigrationTree(paths.herdrDirectory, omitted)) !== JSON.stringify(entries)) throw new Error("The Herdr migration backup or original source failed integrity verification.");
  }
  for (const file of files) {
    if (migrationHash(await readMigrationFile(path.join(backupDirectory, file.backup))) !== file.hash
      || migrationHash(await readMigrationFile(file.target)) !== file.hash) throw new Error(`The migration backup or source failed integrity verification: ${file.target}.`);
  }
  const manifest: WorkspaceMigrationManifest = { version: 1, workerDirectory: paths.workerDirectory, backupDirectory, phase: "backed-up", files, privateTree: { existed, entries } };
  await writeMigrationFile(path.join(backupDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await syncMigrationDirectory(backupDirectory);
  await syncMigrationDirectory(backupRoot);
  return manifest;
};

export const readWorkspaceMigrationManifest = async (paths: WorkerPaths): Promise<WorkspaceMigrationManifest> => {
  const value: unknown = JSON.parse((await readMigrationFile(workspaceMigrationFile(paths))).toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("The worker migration manifest is invalid.");
  const data = value as WorkspaceMigrationManifest;
  const root = path.join(paths.workerDirectory, "workspace-migration-backups");
  if (data.version !== 1 || data.workerDirectory !== paths.workerDirectory || typeof data.backupDirectory !== "string" || path.dirname(data.backupDirectory) !== root || !/^[0-9a-f-]{36}$/.test(path.basename(data.backupDirectory)) || typeof data.phase !== "string" || !Array.isArray(data.files) || typeof data.privateTree !== "object" || data.privateTree === null || typeof data.privateTree.existed !== "boolean" || !Array.isArray(data.privateTree.entries)) throw new Error("The worker migration manifest has an unsupported format or belongs to another state directory.");
  for (const file of data.files) {
    if (typeof file.target !== "string" || !path.isAbsolute(file.target) || typeof file.backup !== "string" || typeof file.hash !== "string" || !/^[a-f0-9]{64}$/.test(file.hash) || !Number.isInteger(file.mode) || typeof file.parentIdentity !== "string") throw new Error("The worker migration file record is invalid.");
    below(data.backupDirectory, file.backup);
  }
  for (const entry of data.privateTree.entries) {
    if (typeof entry.relative !== "string" || typeof entry.directory !== "boolean" || !Number.isInteger(entry.mode) || (entry.directory ? entry.hash !== null : typeof entry.hash !== "string" || !/^[a-f0-9]{64}$/.test(entry.hash))) throw new Error("The worker migration tree record is invalid.");
    below(paths.herdrDirectory, entry.relative);
  }
  const original = JSON.parse((await readMigrationFile(path.join(data.backupDirectory, "manifest.json"))).toString("utf8")) as WorkspaceMigrationManifest;
  if (JSON.stringify({ ...data, phase: "backed-up" }) !== JSON.stringify(original)) throw new Error("The migration manifest differs from the original backup inventory.");
  return data;
};

export const persistWorkspaceMigrationPhase = async (paths: WorkerPaths, manifest: WorkspaceMigrationManifest, phase: string): Promise<void> => {
  manifest.phase = phase;
  await writeMigrationFile(workspaceMigrationFile(paths), `${JSON.stringify(manifest, null, 2)}\n`);
};
export const completeWorkspaceMigration = async (paths: WorkerPaths, manifest: WorkspaceMigrationManifest, outcome: "completed" | "rolled-back"): Promise<void> => {
  await writeMigrationFile(path.join(manifest.backupDirectory, "outcome.json"), `${JSON.stringify({ outcome, completedAt: new Date().toISOString() })}\n`);
  await unlink(workspaceMigrationFile(paths));
  await syncMigrationDirectory(paths.workerDirectory);
};

export const rollbackWorkspaceMigration = async (paths: WorkerPaths, manifest: WorkspaceMigrationManifest): Promise<void> => {
  for (const file of manifest.files) {
    const bytes = await readMigrationFile(below(manifest.backupDirectory, file.backup));
    if (migrationHash(bytes) !== file.hash || await migrationDirectoryIdentity(path.dirname(file.target)) !== file.parentIdentity) throw new Error(`Migration rollback cannot verify the original backup or target directory: ${file.target}.`);
    if (await migrationExists(file.target)) await readMigrationFile(file.target);
  }
  const tree = path.join(manifest.backupDirectory, "herdr");
  if (manifest.privateTree.existed) {
    const actual = await captureMigrationTree(tree);
    if (JSON.stringify(actual) !== JSON.stringify(manifest.privateTree.entries)) throw new Error("The original Herdr migration backup failed integrity verification.");
  }
  const staging = path.join(paths.workerDirectory, `.workspace-migration-restore-${randomUUID()}`);
  if (manifest.privateTree.existed) await copyTree(tree, staging, manifest.privateTree.entries);
  if (await migrationExists(paths.herdrDirectory)) {
    await migrationDirectoryIdentity(paths.herdrDirectory);
    await rename(paths.herdrDirectory, path.join(manifest.backupDirectory, `displaced-herdr-${randomUUID()}`));
  }
  if (manifest.privateTree.existed) await rename(staging, paths.herdrDirectory);
  await syncMigrationDirectory(paths.workerDirectory);
  for (const file of manifest.files) await writeMigrationFile(file.target, await readMigrationFile(below(manifest.backupDirectory, file.backup)), file.mode);
  for (const file of manifest.files) if (migrationHash(await readMigrationFile(file.target)) !== file.hash) throw new Error(`Migration rollback did not restore ${file.target}.`);
  if (manifest.privateTree.existed && JSON.stringify(await captureMigrationTree(paths.herdrDirectory)) !== JSON.stringify(manifest.privateTree.entries)) throw new Error("Migration rollback did not restore the original Herdr state.");
  await completeWorkspaceMigration(paths, manifest, "rolled-back");
};
