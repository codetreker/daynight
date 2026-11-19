import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalId } from "../../../api/parse.js";
import { createOperation } from "../../../api/operation.js";
import { resolveConfigurationPaths } from "../../../config/paths.js";
import { controllerExecutionDirectory, controllerTicketPath, readLaunchTicket } from "../../controller/launch-ticket.js";
import { resolveControllerIpcEndpoint } from "../../controller/paths.js";
import { removeOwnedSourceDirectory } from "../owned-source-directory.js";
import type { BotExecution } from "./execution-store.js";
import { botStateDirectory } from "./environment.js";
import { botUUID, parseBot, type BotRecord } from "./types.js";
import { resolveBotControllerStateDirectory, resolveBotPaths } from "./paths.js";

/** Persist this plan outside the sources before removing any entry. */
export type BotDeletionTarget = {
  path: string; root: string; kind: "directory" | "file" | "socket";
  identity: string | null; rootIdentity: string | null; completed: boolean;
};
const identity = (entry: BigIntStats): string => `${entry.dev}:${entry.ino}`;
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const stat = async (target: string): Promise<BigIntStats | null> => {
  try { return await lstat(target, { bigint: true }); }
  catch (error) { if (missing(error)) return null; throw error; }
};
const owned = (entry: BigIntStats): boolean => process.platform === "win32" || entry.uid === BigInt(process.geteuid!());
const physicalParent = async (directory: string): Promise<BigIntStats | null> => {
  let candidate = directory;
  for (;;) {
    const entry = await stat(candidate);
    if (entry !== null) {
      if (!entry.isDirectory() || await realpath(candidate) !== candidate) throw new Error("Bot private root must be a physical directory without symbolic links.");
      if (candidate === directory && !owned(entry)) throw new Error("Bot private root belongs to a different operating-system user.");
      return candidate === directory ? entry : null;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error("Bot private root has no physical ancestor.");
    candidate = parent;
  }
};
const expectedKind = (entry: BigIntStats, kind: BotDeletionTarget["kind"]): boolean => kind === "directory" ? entry.isDirectory() : kind === "file" ? entry.isFile() : entry.isSocket();
const capture = async (target: string, kind: BotDeletionTarget["kind"], signal: AbortSignal): Promise<BotDeletionTarget> => {
  signal.throwIfAborted();
  const root = path.dirname(target), parent = await physicalParent(root), entry = await stat(target);
  signal.throwIfAborted();
  if (entry !== null && (!expectedKind(entry, kind) || entry.isSymbolicLink() || !owned(entry))) throw new Error("Bot private source has a symbolic link, unsupported type or different owner.");
  if (entry !== null && parent === null) throw new Error("Bot private root changed while capturing its sources.");
  return { path: target, root, kind, identity: entry === null ? null : identity(entry), rootIdentity: parent === null ? null : identity(parent), completed: entry === null };
};

const protectDirectories = async (targets: BotDeletionTarget[], protectedPaths: { directory: string; label: string }[], signal: AbortSignal): Promise<void> => {
  for (const protectedPath of protectedPaths) {
    signal.throwIfAborted();
    let resolved = path.resolve(protectedPath.directory);
    try { resolved = await realpath(resolved); }
    catch (error) { if (!missing(error)) throw error; }
    for (const protectedDirectory of new Set([path.resolve(protectedPath.directory), resolved])) {
      for (const target of targets) {
        if (target.kind !== "directory" || target.completed) continue;
        const relative = path.relative(target.path, protectedDirectory);
        if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error(`Bot private deletion would remove its ${protectedPath.label}; original sources are retained.`);
      }
    }
  }
};

/**
 * The caller first proves all Bot writers stopped and blocks new generations.
 * Sources are derived from the trusted Worker home, never from cwd or native home.
 */
export const captureBotDeletionFiles = async (homeDirectory: string, record: BotRecord, execution: BotExecution | null, signal: AbortSignal): Promise<BotDeletionTarget[]> => {
  signal.throwIfAborted();
  if (!path.isAbsolute(homeDirectory) || path.resolve(homeDirectory) !== homeDirectory || /[\0\r\n]/.test(homeDirectory)) throw new Error("Bot deletion requires the original absolute Worker home.");
  const bot = parseBot(record.observed, record.owner), intent = record.intent;
  if (bot.id !== record.botId || bot.deletion === null) throw new Error("Bot private deletion requires the original deletion responsibility.");
  const paths = resolveConfigurationPaths(homeDirectory);
  const protectedPaths = record.definition === null ? [] : [{ directory: record.definition.resolvedConfiguration.cwd, label: "working directory" }];
  const targets = [await capture(botStateDirectory(paths, record.botId), "directory", signal)];
  const codexRecovery = await capture(resolveBotPaths(paths.stateDirectory, record.botId).codexRecoveryDirectory, "directory", signal);
  if (!codexRecovery.completed) targets.push(codexRecovery);
  // Preparation can create shims before its launch intent is committed. This
  // private root belongs to the Bot even when no individual alias was recorded.
  const botAliasRoot = path.join(resolveBotPaths(paths.stateDirectory, record.botId).directory, "agent-cli-aliases");
  const botAliases = await capture(botAliasRoot, "directory", signal);
  if (!botAliases.completed) targets.push(botAliases);
  if (intent === null) {
    if (execution !== null) throw new Error("Bot private execution has lost its original launch intent.");
    await protectDirectories(targets, protectedPaths, signal);
    return targets;
  }
  const storage = resolveBotControllerStateDirectory(homeDirectory, record);
  const directory = controllerExecutionDirectory(homeDirectory, intent.executionId, storage);
  if (intent.executionId !== intent.registration.testExecutionId || intent.ticketPath !== controllerTicketPath(homeDirectory, intent.launchId, storage)
    || intent.journalPath !== path.join(directory, "journal.sqlite") || intent.credentialFile !== path.join(directory, "credential.json")) throw new Error("Bot private paths differ from the original derived execution paths.");
  if (execution !== null && (execution.executionId !== intent.executionId || execution.launchId !== intent.launchId || execution.executionGeneration !== intent.executionGeneration)) throw new Error("Bot private execution identity differs from the original launch intent.");
  const { stateDirectory } = paths;
  const aliasRoots = [botAliasRoot,
    ...(storage === undefined ? [path.join(stateDirectory, "agent-cli-aliases")] : [])];
  const aliases = [...new Set([...(execution?.retainedAliasDirectories ?? []), ...(execution?.aliasDirectory == null ? [] : [execution.aliasDirectory])])];
  for (const alias of aliases) {
    if (!path.isAbsolute(alias) || !aliasRoots.includes(path.dirname(alias)) || !/^execution-[A-Za-z0-9]+$/.test(path.basename(alias))) throw new Error("Bot aliases must be original execution directories directly under the private alias root.");
  }
  const launches = [...new Set([intent.launchId, ...(execution?.retainedLaunchIds ?? [])])];
  for (const launch of launches) botUUID(launch, "Bot retained launch ID");
  const launchRoot = path.dirname(intent.ticketPath), launchParent = await physicalParent(launchRoot);
  const launchFiles = launchParent === null ? [] : await readdir(launchRoot);
  for (const launch of launches) {
    if (process.platform !== "win32") {
      const endpoint = resolveControllerIpcEndpoint(homeDirectory, launch, process.platform, storage);
      // macOS resolves its system /tmp through /private/tmp. Only normalize that
      // fixed system prefix; the private IPC root and socket cannot be symlinks.
      const target = endpoint.startsWith("/tmp/") ? path.join(await realpath("/tmp"), path.relative("/tmp", endpoint)) : endpoint;
      targets.push(await capture(target, "socket", signal));
    }
  }
  for (const alias of aliases) if (path.dirname(alias) !== botAliasRoot) targets.push(await capture(alias, "directory", signal));
  for (const launch of launches) {
    const file = controllerTicketPath(homeDirectory, launch, storage), target = await capture(file, "file", signal);
    if (!target.completed) {
      const ticket = await readLaunchTicket(homeDirectory, launch, storage);
      const current = await stat(file);
      if (current === null || identity(current) !== target.identity) throw new Error("Bot launch ticket identity changed during capture.");
      if (ticket.executionId !== intent.executionId || ticket.testExecutionId !== intent.executionId || ticket.claimId !== undefined
        || ticket.sessionId !== intent.sessionId || ticket.controllerId !== intent.registration.controllerId
        || ticket.ownerUserId !== record.owner.ownerUserId || ticket.serverOrigin !== record.owner.serverOrigin
        || (launch === intent.launchId ? ticket.executionGeneration !== intent.executionGeneration || ticket.controllerInstanceId !== intent.controllerInstanceId
          : BigInt(ticket.executionGeneration) >= BigInt(intent.executionGeneration))) throw new Error("Bot launch ticket differs from its original execution ownership.");
      protectedPaths.push({ directory: ticket.cwd, label: "working directory" }, { directory: ticket.nativeHome, label: "native home" });
    }
    // Atomic ticket writes can leave an incomplete private file after a crash.
    // Only the exact original launch prefix and canonical temporary UUID belong
    // to this responsibility; no other files under the shared launch root do.
    const prefix = `${launch}.json.`;
    for (const name of launchFiles) {
      if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
      const temporaryId = name.slice(prefix.length, -4);
      if (canonicalId(temporaryId) !== temporaryId) continue;
      targets.push(await capture(path.join(launchRoot, name), "file", signal));
    }
    targets.push(target);
  }
  // Retain the journal until all other captured private sources are removed.
  targets.push(await capture(directory, "directory", signal));
  await protectDirectories(targets, protectedPaths, signal);
  return targets;
};

// Deletion completion discards the captured execution identity, so its parent
// directory entry must reach disk even when a previous attempt removed the source.
const syncExecutionRemoval = async (target: BotDeletionTarget, signal: AbortSignal): Promise<void> => {
  if (process.platform === "win32" || target.kind !== "directory" || path.basename(target.root) !== "executions"
    || path.basename(path.dirname(target.root)) !== "controller" || canonicalId(path.basename(target.path)) !== path.basename(target.path)) return;
  signal.throwIfAborted();
  const handle = await open(target.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let failed = false, failure: unknown;
  try {
    const parent = await physicalParent(target.root);
    if (identity(await handle.stat({ bigint: true })) !== target.rootIdentity || parent === null || identity(parent) !== target.rootIdentity) throw new Error("Bot private root identity changed before execution deletion synchronization.");
    if (await stat(target.path) !== null) throw new Error("Controller execution source reappeared before deletion synchronization.");
    signal.throwIfAborted();
    await handle.sync();
    signal.throwIfAborted();
  } catch (error) { failed = true; failure = error; }
  try { await handle.close(); }
  catch (close) {
    if (failed) throw new AggregateError([failure, close], "Controller execution deletion synchronization and close failed.", { cause: failure });
    throw close;
  }
  if (failed) throw failure;
};

/** A successful return permits persisting completed=true; completed paths are never revisited. */
export const removeBotDeletionFile = async (target: BotDeletionTarget, signal: AbortSignal): Promise<void> => {
  if (target.completed) return;
  signal.throwIfAborted();
  if (!path.isAbsolute(target.root) || path.resolve(target.root) !== target.root || !path.isAbsolute(target.path) || path.resolve(target.path) !== target.path
    || path.dirname(target.path) !== target.root || !["directory", "file", "socket"].includes(target.kind)
    || target.identity === null || !/^\d+:\d+$/.test(target.identity) || target.rootIdentity === null || !/^\d+:\d+$/.test(target.rootIdentity)) throw new Error("Bot private deletion requires a captured direct-child identity.");
  const check = async (): Promise<boolean> => {
    signal.throwIfAborted();
    const parent = await physicalParent(target.root);
    if (parent === null) return false;
    if (identity(parent) !== target.rootIdentity) throw new Error("Bot private root identity changed after capture.");
    const entry = await stat(target.path);
    if (entry === null) return false;
    if (!expectedKind(entry, target.kind) || identity(entry) !== target.identity || !owned(entry)) throw new Error("Bot private source identity changed after capture.");
    signal.throwIfAborted();
    return true;
  };
  if (!await check()) { await syncExecutionRemoval(target, signal); return; }
  if (target.kind === "directory") {
    const operation = createOperation({ signal, limits: { totalMs: 300_000 } });
    try { await removeOwnedSourceDirectory(target.root, target.path, operation, { rootIdentity: target.rootIdentity, sourceIdentity: target.identity }); }
    finally { operation.dispose(); }
    await syncExecutionRemoval(target, signal);
    return;
  }
  const handle = process.platform === "win32" ? null : await open(target.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (handle !== null && identity(await handle.stat({ bigint: true })) !== target.rootIdentity) throw new Error("Bot private root identity changed before unlink.");
    if (!await check()) return;
    // Node has no portable unlinkat. Recheck the retained parent and exact inode
    // immediately before a nonrecursive unlink, which never follows the source.
    try { await unlink(target.path); }
    catch (error) { if (!missing(error)) throw error; }
  } finally { await handle?.close(); }
};
