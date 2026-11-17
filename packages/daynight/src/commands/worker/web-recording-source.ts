import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireInstanceLockSync, InstanceLockHeldError } from "../../platform/instance-lock.js";
import { controllerExecutionDirectory } from "../controller/launch-ticket.js";
import { controllerStorageConnectionIsOpen } from "../controller/storage-lock.js";
import { resolveWorkerPaths } from "./paths.js";
import type { LocalTask } from "./backends/web-types.js";

export class WebRecordingDiscardedError extends Error {
  constructor() { super("This Web recording was selected for local deletion; its source cannot be read or uploaded."); }
}

const lockHeld = (error: unknown): boolean => error instanceof InstanceLockHeldError || error instanceof Error && error.cause !== undefined && lockHeld(error.cause);

const current = (task: LocalTask, read: () => LocalTask | null): LocalTask => {
  const found = read();
  if (found === null || found.worktreeId !== task.worktreeId || found.workerId !== task.workerId || found.serverOrigin !== task.serverOrigin
    || found.webExecution?.executionId !== task.webExecution?.executionId || found.webExecution?.executionGeneration !== task.webExecution?.executionGeneration || found.webExecution?.launchId !== task.webExecution?.launchId) throw new Error("The original Web recording identity changed.");
  return found;
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
    if (current(task, read).cleanup?.discardRecording) throw new WebRecordingDiscardedError();
    return action();
  }, signal);
};

export const deleteWebRecording = async (home: string, task: LocalTask, read: () => LocalTask | null, isSettled: (task: LocalTask) => boolean, signal?: AbortSignal): Promise<void> => {
  await withLock(home, task, async () => {
    const found = current(task, read);
    if (found.status !== "done" || found.cleanup?.kind !== "terminal" || !found.cleanup.discardRecording || found.webExecution === null) throw new Error("Web recording deletion requires the original completed discard decision.");
    if (!isSettled(found)) throw new Error("The original Web cleanup has not settled.");
    await rm(controllerExecutionDirectory(home, found.webExecution.executionId), { recursive: true, force: true });
  }, signal);
};
