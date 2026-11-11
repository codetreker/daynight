import { setTimeout as delay } from "node:timers/promises";

/** Retains requests made during a round until the single scheduler waits. */
export const createReconcileWake = () => {
  let revision = 0n;
  let pending = new AbortController();
  return {
    snapshot: (): bigint => revision,
    request: (): void => {
      revision += 1n;
      const previous = pending;
      pending = new AbortController();
      previous.abort();
    },
    waitAfter: async (observed: bigint, delayMs: number, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (observed !== revision) return;
      const wake = pending.signal;
      try { await delay(delayMs, undefined, { signal: AbortSignal.any([signal, wake]) }); }
      catch (error) {
        if (signal.aborted || !wake.aborted) throw error;
      }
    },
  };
};
