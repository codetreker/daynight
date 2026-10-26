import { mkdir } from "node:fs/promises";
import { acquireInstanceLock } from "../../platform/instance-lock.js";
import type { WorkerPaths } from "./paths.js";

export const acquireWorkerInstanceLock = async (paths: WorkerPaths) => {
  await mkdir(paths.workerDirectory, { recursive: true });
  return acquireInstanceLock(paths.lockFile, paths.databaseFile);
};
