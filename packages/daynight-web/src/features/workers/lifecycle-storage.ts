export const workerLifecycleStoragePrefix = (origin: string, userId: string): string => `daynight.lifecycle.v1:${origin}:${userId}:`;
export const workerLifecycleStorageKey = (origin: string, userId: string, workerId: string): string => `${workerLifecycleStoragePrefix(origin, userId)}${workerId}`;

/** Clear cold journals too: the account may sign out without mounting a Worker view. */
export const clearWorkerLifecyclePending = (origin: string, userId: string, storage?: Storage): Error | null => {
  try {
    const target = storage ?? sessionStorage, prefix = workerLifecycleStoragePrefix(origin, userId), keys: string[] = [];
    for (let index = 0; index < target.length; index++) {
      const key = target.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) target.removeItem(key);
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause : new Error('Pending Worker lifecycle records could not be cleared.', { cause });
  }
};
