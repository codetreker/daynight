import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import Database from "better-sqlite3";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireInstanceLockSync, InstanceLockHeldError } from "../../platform/instance-lock.js";
import { syncDirectory, writeDurableJson } from "../../platform/durable-json.js";
import { controllerExecutionDirectory, controllerPayloadHash, controllerTicketPath, readLaunchTicket, type ControllerLaunchTicket } from "../controller/launch-ticket.js";
import { readControllerSnapshot, readCurrentControllerInventorySnapshot, readHistoricalStoppedControllerGeneration, validateWindowsControllerStopProof, type ControllerSnapshot } from "../controller/lifecycle-store.js";
import { readUnreleasedLaunch } from "../controller/unreleased-launch.js";
import { isLinuxControllerLaunch } from "../controller/linux-controller-launch.js";
import { canonicalId } from "../../api/parse.js";
import { createOperation } from "../../api/operation.js";
import { countStoppedControllerUsage } from "../controller/usage/stopped.js";
import { countRetainedUsage } from "../controller/usage/store.js";
import { controllerStorageConnectionIsOpen } from "../controller/storage-lock.js";
import { resolveWorkerPaths } from "./paths.js";
import type { LocalTask } from "./backends/web-types.js";
import { isUnreleasedWebLaunch, sameUnreleasedWebState } from "./backends/web-process.js";
import { removeOwnedSourceDirectory } from "./owned-source-directory.js";

export class WebRecordingDiscardedError extends Error {
  constructor() { super("This Web recording was selected for local deletion; its source cannot be read or uploaded."); }
}
export class WebUnreleasedPrecedingJournalError extends Error {
  constructor() { super("The current Controller launch was unreleased; its preceding recording remains local because its archive fence is no longer current."); }
}
export class WebUnreleasedEmptyJournalError extends Error {
  constructor() { super("The first Controller launch was unreleased and has no recording or usage source."); }
}

const lockHeld = (error: unknown): boolean => error instanceof InstanceLockHeldError || error instanceof Error && error.cause !== undefined && lockHeld(error.cause);

const current = (task: LocalTask, read: () => LocalTask | null): LocalTask => {
  const found = read();
  if (found === null || found.worktreeId !== task.worktreeId || found.workerId !== task.workerId || found.serverOrigin !== task.serverOrigin
    || found.webExecution?.executionId !== task.webExecution?.executionId || found.webExecution?.executionGeneration !== task.webExecution?.executionGeneration || found.webExecution?.launchId !== task.webExecution?.launchId) throw new Error("The original Web recording identity changed.");
  return found;
};

const discardReceiptPath = (home: string, ticket: ControllerLaunchTicket): string => `${controllerTicketPath(home, ticket.launchId)}.recording-discarded.json`;
type DiscardReceipt = { kind: "web-preceding-recording-discarded"; state: "intent" | "completed"; ticketHash: string; precedingLaunchId: string; precedingTicketHash: string; precedingSnapshotHash: string; nativeSessionId: string; rootIdentity: string; sourceIdentity: string; rootBirthtime: string; sourceBirthtime: string };
type PartialDiscard = { kind: "partial-discard"; receipt: DiscardReceipt };
const directoryIdentity = (value: { dev: bigint; ino: bigint }): string => {
  if (value.dev < 0n || value.ino <= 0n) throw new Error("Web recording directory identity is unavailable.");
  return `${value.dev}:${value.ino}`;
};
const directoryBirthtime = (value: { birthtimeNs: bigint }): string => {
  if (value.birthtimeNs <= 0n) throw new Error("Web recording directory creation identity is unavailable.");
  return String(value.birthtimeNs);
};
const readDiscardReceipt = async (home: string, task: LocalTask, ticket: ControllerLaunchTicket): Promise<DiscardReceipt | undefined> => {
  const file = discardReceiptPath(home, ticket);
  let handle;
  try { handle = await open(file, process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
  let text: string;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 1024 || process.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error("Web recording discard receipt is invalid.");
    const bytes = Buffer.alloc(1025); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > 1024) throw new Error("Web recording discard receipt is invalid.");
    text = bytes.subarray(0, offset).toString("utf8");
    await handle.sync(); syncDirectory(path.dirname(file));
  } finally { await handle.close(); }
  const value = JSON.parse(text) as Record<string, unknown>;
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "kind,nativeSessionId,precedingLaunchId,precedingSnapshotHash,precedingTicketHash,rootBirthtime,rootIdentity,sourceBirthtime,sourceIdentity,state,ticketHash"
    || text !== JSON.stringify(value) || value.kind !== "web-preceding-recording-discarded" || value.ticketHash !== controllerPayloadHash(ticket)
    || value.state !== "intent" && value.state !== "completed" || typeof value.precedingSnapshotHash !== "string" || !/^[a-f0-9]{64}$/.test(value.precedingSnapshotHash)
    || typeof value.precedingLaunchId !== "string" || canonicalId(value.precedingLaunchId) !== value.precedingLaunchId
    || typeof value.precedingTicketHash !== "string" || !/^[a-f0-9]{64}$/.test(value.precedingTicketHash)
    || typeof value.rootIdentity !== "string" || !/^(?:0|[1-9][0-9]*):[1-9][0-9]*$/.test(value.rootIdentity)
    || typeof value.sourceIdentity !== "string" || !/^(?:0|[1-9][0-9]*):[1-9][0-9]*$/.test(value.sourceIdentity)
    || typeof value.rootBirthtime !== "string" || !/^[1-9][0-9]*$/.test(value.rootBirthtime)
    || typeof value.sourceBirthtime !== "string" || !/^[1-9][0-9]*$/.test(value.sourceBirthtime)
    || value.nativeSessionId !== task.resources.nativeSession?.sessionId || task.status !== "done" || task.cleanup?.kind !== "terminal" || !task.cleanup.discardRecording)
    throw new Error("Web recording discard receipt conflicts with its original execution.");
  const previous = await readLaunchTicket(home, value.precedingLaunchId);
  if (controllerPayloadHash(previous) !== value.precedingTicketHash || previous.executionId !== ticket.executionId || previous.sessionId !== ticket.sessionId
    || BigInt(previous.executionGeneration) + 1n !== BigInt(ticket.executionGeneration) || previous.controllerInstanceId === ticket.controllerInstanceId
    || previous.controllerId !== ticket.controllerId || previous.claimId !== ticket.claimId || previous.projectId !== ticket.projectId
    || previous.taskId !== ticket.taskId || previous.worktreeId !== ticket.worktreeId || previous.workerId !== ticket.workerId || previous.userId !== ticket.userId
    || previous.serverOrigin !== ticket.serverOrigin || previous.initialOperationId !== ticket.initialOperationId || previous.initialPrompt !== ticket.initialPrompt)
    throw new Error("Web recording discard receipt conflicts with its preceding ticket.");
  return value as DiscardReceipt;
};

/** Local evidence cannot authorize replay under either generation's server fence. */
const unreleasedJournal = async (home: string, task: LocalTask, read: () => LocalTask | null, signal?: AbortSignal): Promise<"ordinary" | "empty" | "discarded" | ControllerSnapshot | PartialDiscard> => {
  const execution = task.webExecution;
  if (execution === null || execution.launchSubmission !== "unknown") return "ordinary";
  const ticket = await readLaunchTicket(home, execution.launchId);
  if (await readUnreleasedLaunch(home, ticket) === undefined) return "ordinary";
  const abort = signal ?? AbortSignal.timeout(5000);
  if (!await isUnreleasedWebLaunch(home, task, ticket, abort)) throw new Error("Unreleased Web recording evidence disappeared.");
  const discard = await readDiscardReceipt(home, task, ticket);
  if (discard !== undefined) {
    if (!sameUnreleasedWebState(task, current(task, read))) throw new Error("Unreleased Web recording evidence changed during observation.");
    const directory = controllerExecutionDirectory(home, ticket.executionId);
    const root = await lstat(path.dirname(directory), { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink() || directoryIdentity(root) !== discard.rootIdentity || directoryBirthtime(root) !== discard.rootBirthtime) throw new Error("Web recording root identity changed during discard.");
    let missing = false;
    try {
      const source = await lstat(directory, { bigint: true });
      if (!source.isDirectory() || source.isSymbolicLink() || directoryIdentity(source) !== discard.sourceIdentity || directoryBirthtime(source) !== discard.sourceBirthtime) throw new Error("Web recording directory identity changed during discard.");
    } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") missing = true; else throw error; }
    if (missing) {
      syncDirectory(path.dirname(directory));
      if (discard.state === "intent") {
        writeDurableJson(discardReceiptPath(home, ticket), { ...discard, state: "completed" });
        if ((await readDiscardReceipt(home, task, ticket))?.state !== "completed") throw new Error("Web recording discard completion is unavailable.");
      }
      return "discarded";
    }
    if (discard.state === "completed") throw new Error("Web recording discard receipt conflicts with a retained source.");
  }
  const preceding = readControllerSnapshot(path.join(controllerExecutionDirectory(home, execution.executionId), "journal.sqlite"));
  if (!sameUnreleasedWebState(task, current(task, read))) throw new Error("Unreleased Web recording evidence changed during observation.");
  if (preceding === null) {
    if (discard?.state === "intent") return { kind: "partial-discard", receipt: discard };
    if (execution.executionGeneration !== "1") throw new Error("Unreleased Web recording lacks its preceding generation evidence.");
    const journal = path.join(controllerExecutionDirectory(home, execution.executionId), "journal.sqlite");
    const exists = async (file: string): Promise<boolean> => {
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unreleased Web journal evidence is not a regular file.");
        return true;
      } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
    };
    const files = await Promise.all([journal, `${journal}-wal`, `${journal}-journal`, `${journal}-shm`].map(exists));
    if (!files[0] && files.slice(1).some(Boolean)) throw new Error("Unreleased Web journal has a sidecar without its original database.");
    if (!sameUnreleasedWebState(task, current(task, read))) throw new Error("Unreleased Web recording evidence changed during observation.");
    return "empty";
  }
  if (preceding.testExecutionId !== undefined || preceding.executionId !== execution.executionId || preceding.claimId !== task.claimId
    || preceding.sessionId !== execution.sessionId || BigInt(preceding.executionGeneration) + 1n !== BigInt(execution.executionGeneration)
    || preceding.controllerInstanceId === execution.controllerInstanceId || preceding.nativeSessionId === null
    || preceding.nativeSessionId !== task.resources.nativeSession?.sessionId || preceding.lifecycle !== "stopped" || !preceding.nativeStopped
    || preceding.stoppedAt === null || preceding.controllerProcess === null) throw new Error("Unreleased Web recording conflicts with its preceding generation.");
  if (discard !== undefined && discard.precedingSnapshotHash !== controllerPayloadHash(preceding)) throw new Error("Web recording discard intent conflicts with its preceding journal.");
  return preceding;
};

const requireCurrentJournal = async (home: string, task: LocalTask, read: () => LocalTask | null, signal?: AbortSignal): Promise<void> => {
  const source = await unreleasedJournal(home, task, read, signal);
  if (typeof source !== "string") throw new WebUnreleasedPrecedingJournalError();
  if (source === "empty" || source === "discarded") throw new WebUnreleasedEmptyJournalError();
};

/** Locate only the exact ticket whose hash owns the retained stopped journal. */
const precedingUsageTicket = async (home: string, task: LocalTask, preceding: ControllerSnapshot, read: () => LocalTask | null, signal?: AbortSignal): Promise<ControllerLaunchTicket> => {
  const execution = task.webExecution!;
  const deadline = Date.now() + 5000;
  const check = () => { signal?.throwIfAborted(); if (Date.now() >= deadline) throw new Error("Preceding usage ticket observation exceeded its deadline."); };
  const matches = (ticket: ControllerLaunchTicket): boolean => ticket.executionId === execution.executionId && ticket.executionGeneration === preceding.executionGeneration
    && ticket.controllerInstanceId === preceding.controllerInstanceId && ticket.controllerId === execution.controllerId && ticket.sessionId === execution.sessionId
    && ticket.initialOperationId === execution.initialOperationId && ticket.initialPrompt === execution.initialPrompt && ticket.provider === task.configuration?.agent
    && (task.resources.worktree === null || ticket.cwd === task.resources.worktree.worktreePath)
    && (execution.nativeHome === null || ticket.nativeHome === execution.nativeHome)
    && ticket.claimId === task.claimId && ticket.projectId === task.projectId
    && ticket.taskId === task.taskId && ticket.worktreeId === task.worktreeId && ticket.workerId === task.workerId && ticket.userId === task.userId
    && ticket.serverOrigin === task.serverOrigin;
  const ids = isLinuxControllerLaunch(preceding.controllerProcess) ? [preceding.controllerProcess.launchId] : await readdir(path.dirname(controllerTicketPath(home, execution.launchId)));
  if (ids.length > 20_000) throw new Error("Controller launch inventory exceeds its safe bound.");
  const tickets: ControllerLaunchTicket[] = [];
  for (const entry of ids) {
    check();
    const launchId = isLinuxControllerLaunch(preceding.controllerProcess) ? entry : entry.endsWith(".json") ? entry.slice(0, -5) : "";
    if (canonicalId(launchId) !== launchId) continue;
    const ticket = await readLaunchTicket(home, launchId);
    if (matches(ticket)) tickets.push(ticket);
  }
  check();
  const journal = path.join(controllerExecutionDirectory(home, execution.executionId), "journal.sqlite");
  const located = readCurrentControllerInventorySnapshot(journal, tickets, deadline);
  if (located === null || !matches(located.ticket) || controllerPayloadHash(located.snapshot) !== controllerPayloadHash(preceding)) throw new Error("The preceding usage journal has no exact original ticket.");
  if (isLinuxControllerLaunch(preceding.controllerProcess)) {
    const historical = readHistoricalStoppedControllerGeneration(journal, located.ticket, deadline);
    if (historical === null || controllerPayloadHash(historical) !== controllerPayloadHash(preceding)) throw new Error("The preceding Linux usage journal lacks its verified stopped boundary.");
  }
  if (process.platform === "win32") validateWindowsControllerStopProof(preceding, located.ticket, controllerPayloadHash(located.ticket));
  if (!sameUnreleasedWebState(task, current(task, read))) throw new Error("Unreleased Web recording evidence changed during usage observation.");
  check();
  return located.ticket;
};

// The lock and its ownership gate outlive the recording directory being removed.
const withLock = async <T>(home: string, task: LocalTask, action: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (task.webExecution === null) throw new Error("The original Web recording execution is missing.");
  const id = path.basename(controllerExecutionDirectory(home, task.webExecution.executionId));
  const directory = path.join(resolveWorkerPaths(home).workerDirectory, "recording-locks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let lock: ReturnType<typeof acquireInstanceLockSync>;
  for (;;) {
    signal?.throwIfAborted();
    try { lock = acquireInstanceLockSync(path.join(directory, `${id}.lock`), path.join(directory, `${id}.sqlite`)); break; }
    catch (error) { if (!lockHeld(error)) throw error; await delay(100, undefined, signal === undefined ? {} : { signal }); }
  }
  let result: T | undefined, failure: unknown, failed = false;
  try { signal?.throwIfAborted(); result = await action(); }
  catch (error) { failed = true; failure = error; }
  // An unclosed journal connection still owns the source even after its caller fails.
  if (failed && controllerStorageConnectionIsOpen(failure)) throw failure;
  try { lock.release(); }
  catch (error) { if (failed) throw new AggregateError([failure, error], "Web recording operation and source lock release failed.", { cause: failure }); throw error; }
  if (failed) throw failure;
  return result!;
};

export const withWebRecordingSource = async <T>(home: string, task: LocalTask, read: () => LocalTask | null, action: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (current(task, read).cleanup?.discardRecording) throw new WebRecordingDiscardedError();
  return withLock(home, task, async () => {
    const found = current(task, read);
    if (found.cleanup?.discardRecording) throw new WebRecordingDiscardedError();
    await requireCurrentJournal(home, found, read, signal);
    return action();
  }, signal);
};

/** Usage has its own grants and retention; recording discard does not acknowledge it. */
export const withWebUsageSource = async <T>(home: string, task: LocalTask, read: () => LocalTask | null, action: (precedingTicket?: ControllerLaunchTicket) => Promise<T>, signal?: AbortSignal): Promise<T> => withLock(home, task, async () => {
  const found = current(task, read);
  const source = await unreleasedJournal(home, found, read, signal);
  if (source === "empty" || source === "discarded" || typeof source !== "string" && "receipt" in source) throw new WebUnreleasedEmptyJournalError();
  const ticket = typeof source === "string" ? undefined : await precedingUsageTicket(home, found, source, read, signal);
  return action(ticket);
}, signal);

export const deleteWebRecording = async (home: string, task: LocalTask, read: () => LocalTask | null, isSettled: (task: LocalTask) => boolean, signal?: AbortSignal): Promise<void> => {
  await withLock(home, task, async () => {
    const found = current(task, read);
    if (found.status !== "done" || found.cleanup?.kind !== "terminal" || !found.cleanup.discardRecording || found.webExecution === null) throw new Error("Web recording deletion requires the original completed discard decision.");
    if (!isSettled(found)) throw new Error("The original Web cleanup has not settled.");
    const source = await unreleasedJournal(home, found, read, signal);
    if (source === "discarded") return;
    const journalPath = path.join(controllerExecutionDirectory(home, found.webExecution.executionId), "journal.sqlite");
    if (typeof source !== "string" && "receipt" in source) {
      signal?.throwIfAborted();
      if (!sameUnreleasedWebState(found, current(found, read)) || !isSettled(current(found, read))) throw new Error("The original Web cleanup changed during recording deletion.");
      const directory = controllerExecutionDirectory(home, found.webExecution.executionId), ticket = await readLaunchTicket(home, found.webExecution.launchId);
      const sourceInfo = await lstat(directory, { bigint: true });
      if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink() || directoryIdentity(sourceInfo) !== source.receipt.sourceIdentity || directoryBirthtime(sourceInfo) !== source.receipt.sourceBirthtime) throw new Error("Web recording directory identity changed during discard.");
      const operation = createOperation({ ...(signal === undefined ? {} : { signal }), limits: { totalMs: 60_000 } });
      try { await removeOwnedSourceDirectory(path.dirname(directory), directory, operation, { rootIdentity: source.receipt.rootIdentity, sourceIdentity: source.receipt.sourceIdentity }); }
      finally { operation.dispose(); }
      try { await lstat(directory); throw new Error("The original Web recording remains after deletion."); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      syncDirectory(path.dirname(directory));
      writeDurableJson(discardReceiptPath(home, ticket), { ...source.receipt, state: "completed" });
      if ((await readDiscardReceipt(home, found, ticket))?.state !== "completed") throw new Error("Web recording discard receipt is unavailable after deletion.");
      return;
    }
    if (typeof source !== "string") {
      const preceding = source;
      const directory = controllerExecutionDirectory(home, found.webExecution.executionId);
      const [firstRoot, firstSource] = await Promise.all([lstat(path.dirname(directory), { bigint: true }), lstat(directory, { bigint: true })]);
      if (!firstRoot.isDirectory() || firstRoot.isSymbolicLink() || !firstSource.isDirectory() || firstSource.isSymbolicLink()) throw new Error("Web recording deletion requires original physical directories.");
      const previous = await precedingUsageTicket(home, found, preceding, read, signal);
      if (countStoppedControllerUsage({ journalPath, ticket: previous }) !== 0) throw new Error("The original recording still owns pending or quarantined usage or unresolved local conflicts; its journal must be retained.");
      signal?.throwIfAborted();
      if (!sameUnreleasedWebState(found, current(found, read)) || !isSettled(current(found, read))) throw new Error("The original Web cleanup changed during recording deletion.");
      const ticket = await readLaunchTicket(home, found.webExecution.launchId);
      const verified = readCurrentControllerInventorySnapshot(journalPath, [previous], Date.now() + 5000);
      if (verified === null || controllerPayloadHash(verified.snapshot) !== controllerPayloadHash(preceding)) throw new Error("The preceding Web journal changed during recording deletion.");
      const [root, original] = await Promise.all([lstat(path.dirname(directory), { bigint: true }), lstat(directory, { bigint: true })]);
      if (!root.isDirectory() || root.isSymbolicLink() || !original.isDirectory() || original.isSymbolicLink() || directoryIdentity(root) !== directoryIdentity(firstRoot) || directoryBirthtime(root) !== directoryBirthtime(firstRoot) || directoryIdentity(original) !== directoryIdentity(firstSource) || directoryBirthtime(original) !== directoryBirthtime(firstSource)) throw new Error("Web recording directory identity changed during deletion.");
      const intent: DiscardReceipt = { kind: "web-preceding-recording-discarded", state: "intent", ticketHash: controllerPayloadHash(ticket), precedingLaunchId: previous.launchId, precedingTicketHash: controllerPayloadHash(previous), precedingSnapshotHash: controllerPayloadHash(preceding), nativeSessionId: found.resources.nativeSession!.sessionId, rootIdentity: directoryIdentity(root), sourceIdentity: directoryIdentity(original), rootBirthtime: directoryBirthtime(root), sourceBirthtime: directoryBirthtime(original) };
      const retained = await readDiscardReceipt(home, found, ticket);
      if (retained !== undefined && JSON.stringify(retained) !== JSON.stringify(intent)) throw new Error("Web recording discard intent conflicts with the original source.");
      if (retained === undefined) {
        writeDurableJson(discardReceiptPath(home, ticket), intent);
        if (JSON.stringify(await readDiscardReceipt(home, found, ticket)) !== JSON.stringify(intent)) throw new Error("Web recording discard intent is unavailable.");
      }
      signal?.throwIfAborted();
      if (!sameUnreleasedWebState(found, current(found, read)) || !isSettled(current(found, read))) throw new Error("The original Web cleanup changed during recording deletion.");
      const operation = createOperation({ ...(signal === undefined ? {} : { signal }), limits: { totalMs: 60_000 } });
      try { await removeOwnedSourceDirectory(path.dirname(directory), directory, operation, { rootIdentity: intent.rootIdentity, sourceIdentity: intent.sourceIdentity }); }
      finally { operation.dispose(); }
      try { await lstat(controllerExecutionDirectory(home, found.webExecution.executionId)); throw new Error("The original Web recording remains after deletion."); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      syncDirectory(path.dirname(controllerExecutionDirectory(home, found.webExecution.executionId)));
      writeDurableJson(discardReceiptPath(home, ticket), { ...intent, state: "completed" });
      if ((await readDiscardReceipt(home, found, ticket))?.state !== "completed") throw new Error("Web recording discard receipt is unavailable after deletion.");
      return;
    }
    let retainsUsage = false;
    if (existsSync(journalPath)) {
      const journal = new Database(journalPath, { readonly: true, fileMustExist: true });
      try {
        retainsUsage = journal.transaction(() => countRetainedUsage(journal)).deferred() !== 0;
      } catch (error) {
        // Explicit recording deletion already covers unreadable legacy recordings.
        if (!(error instanceof Database.SqliteError) || error.code !== "SQLITE_NOTADB") throw error;
      } finally { journal.close(); }
    }
    if (retainsUsage) {
      const ticket = await readLaunchTicket(home, found.webExecution.launchId);
      if (ticket.executionId !== found.webExecution.executionId || ticket.executionGeneration !== found.webExecution.executionGeneration || ticket.claimId !== found.claimId || ticket.sessionId !== found.webExecution.sessionId || ticket.workerId !== found.workerId || ticket.serverOrigin !== found.serverOrigin) throw new Error("Usage retention does not identify the original recording.");
      if (countStoppedControllerUsage({ journalPath, ticket }) !== 0) throw new Error("The original recording still owns pending or quarantined usage or unresolved local conflicts; its journal must be retained.");
    }
    await rm(controllerExecutionDirectory(home, found.webExecution.executionId), { recursive: true, force: true });
  }, signal);
};
