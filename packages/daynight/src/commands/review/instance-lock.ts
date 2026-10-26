import { acquireInstanceLock as acquireLock } from "../../platform/instance-lock.js";

export const acquireInstanceLock = (lockFile: string, owner?: string) =>
  acquireLock(lockFile, `${lockFile}.sqlite`, owner);
