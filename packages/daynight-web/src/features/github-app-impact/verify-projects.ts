export type ProjectAccessCheck = {
  readonly signal: AbortSignal;
  readonly ready: (signal: AbortSignal) => Promise<void>;
  readonly read: (id: string, signal: AbortSignal) => Promise<unknown>;
  readonly isDenied: (error: unknown) => boolean;
  readonly isCurrent: () => boolean;
  readonly onDenied: () => void;
  readonly mapDenied?: (error: unknown) => unknown;
};

// The caller owns cancellation, operation generations, and the final impact read.
export const verifyImpactProjects = async (items: readonly { readonly id: string }[], check: ProjectAccessCheck): Promise<void> => {
  let next = 0, stopped = false, denialReported = false;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (!stopped && next < items.length) {
      const item = items[next++]!;
      try {
        await check.ready(check.signal);
        check.signal.throwIfAborted();
        try { await check.read(item.id, check.signal); }
        catch (error) {
          if (check.isDenied(error)) {
            if (!denialReported && !check.signal.aborted && check.isCurrent()) { denialReported = true; check.onDenied(); }
            throw check.mapDenied ? check.mapDenied(error) : error;
          }
          throw error;
        }
        await check.ready(check.signal);
        check.signal.throwIfAborted();
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }));
};
