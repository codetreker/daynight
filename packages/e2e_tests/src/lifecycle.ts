export type Lifecycle = {
  defer: (cleanup: () => Promise<void>) => void;
  close: () => Promise<void>;
};

export const createLifecycle = (): Lifecycle => {
  const cleanups: (() => Promise<void>)[] = [];
  let closing: Promise<void> | undefined;
  return {
    defer: (cleanup) => {
      if (closing !== undefined) throw new Error('Cannot register a resource after cleanup starts.');
      cleanups.push(cleanup);
    },
    close: () => {
      if (closing !== undefined) return closing;
      closing = (async () => {
        const failures: unknown[] = [];
        for (const cleanup of cleanups.reverse()) {
          try { await cleanup(); }
          catch (error) { failures.push(error); }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, 'Environment cleanup failed.', { cause: failures[0] });
      })();
      return closing;
    },
  };
};

export const prepareWithLifecycle = async <T>(prepare: (lifecycle: Lifecycle) => Promise<T>): Promise<{ value: T; lifecycle: Lifecycle }> => {
  const lifecycle = createLifecycle();
  try { return { value: await prepare(lifecycle), lifecycle }; }
  catch (error) {
    try { await lifecycle.close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Environment setup and cleanup failed.', { cause: error }); }
    throw error;
  }
};

export const runCleanupSteps = async (steps: readonly (() => Promise<void>)[]): Promise<void> => {
  const lifecycle = createLifecycle();
  for (const step of [...steps].reverse()) lifecycle.defer(step);
  await lifecycle.close();
};
