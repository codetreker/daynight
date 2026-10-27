import { mkdir } from "node:fs/promises";
import { acquireInstanceLock, InstanceLockHeldError } from "../../platform/instance-lock.js";
import type { WorkerPaths } from "./paths.js";

export const acquireWorkerInstanceLock = async (paths: WorkerPaths) => {
  await mkdir(paths.workerDirectory, { recursive: true });
  return acquireInstanceLock(paths.lockFile, paths.databaseFile);
};

export const tryAcquireWorkerInstanceLock = async (paths: WorkerPaths) => {
  try { return await acquireWorkerInstanceLock(paths); }
  catch (error) {
    if (error instanceof Error && error.cause instanceof InstanceLockHeldError) return null;
    throw error;
  }
};
