import { setTimeout as delay } from "node:timers/promises";

/** A revision preserves notifications received during a reconciliation round. */
export const createReconcileWake = () => {
  let revision = 0n;
  let changed = new AbortController();
  let closed = false;
  return {
    snapshot: (): bigint => revision,
    request(): void {
      if (closed) return;
      revision++;
      const previous = changed;
      changed = new AbortController();
      previous.abort();
    },
    async waitAfter(observed: bigint, delayMs: number, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      if (closed || observed !== revision) return;
      const current = changed;
      try { await delay(delayMs, undefined, { signal: AbortSignal.any([signal, current.signal]) }); }
      catch (error) {
        signal.throwIfAborted();
        if (!current.signal.aborted) throw error;
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      changed.abort();
    },
  };
};
