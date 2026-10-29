type PipelinePhases = {
  nativePreparation(): Promise<void>;
  nativeFunctional(): Promise<void>;
  container(): Promise<void>;
  releaseContainer(): Promise<void>;
  capacity(): Promise<void>;
};

export const runPipeline = async (cancellation: AbortController, phases: PipelinePhases): Promise<void> => {
  const failures = new Set<unknown>();
  const started: Promise<void>[] = [];
  const aborted = (): void => { failures.add(cancellation.signal.reason); };
  const fail = (error: unknown): void => {
    failures.add(error);
    if (!cancellation.signal.aborted) cancellation.abort(error);
  };
  const start = (operation: () => Promise<void>): Promise<void> => {
    const pending = Promise.resolve().then(() => {
      cancellation.signal.throwIfAborted();
      return operation();
    }).catch(fail);
    started.push(pending);
    return pending;
  };

  cancellation.signal.addEventListener('abort', aborted, { once: true });
  try {
    cancellation.signal.throwIfAborted();
    const nativePreparation = start(phases.nativePreparation);
    const container = start(phases.container);
    const nativeFunctional = start(async () => {
      await nativePreparation;
      cancellation.signal.throwIfAborted();
      await phases.nativeFunctional();
      cancellation.signal.throwIfAborted();
      await phases.releaseContainer();
    });
    await Promise.all([nativePreparation, nativeFunctional, container]);
    cancellation.signal.throwIfAborted();
    await start(phases.capacity);
  } catch (error) {
    fail(error);
  } finally {
    await Promise.all(started);
    cancellation.signal.removeEventListener('abort', aborted);
  }
  if (failures.size === 1) throw [...failures][0];
  if (failures.size > 1) throw new AggregateError(failures, 'Web verification pipeline failed.');
};

type TargetPipeline = {
  target: 'native'; preparation(): Promise<void>; functional(): Promise<void>; capacity(): Promise<void>;
} | {
  target: 'container'; preparation(): Promise<void>; container(): Promise<void>;
};

export const runTargetPipeline = async (cancellation: AbortController, phases: TargetPipeline): Promise<void> => {
  const operations = phases.target === 'native'
    ? [phases.preparation, phases.functional, phases.capacity]
    : [phases.preparation, phases.container];
  const failures = new Set<unknown>();
  const aborted = (): void => { failures.add(cancellation.signal.reason); };
  cancellation.signal.addEventListener('abort', aborted, { once: true });
  try {
    for (const operation of operations) {
      cancellation.signal.throwIfAborted();
      await operation();
    }
    cancellation.signal.throwIfAborted();
  } catch (error) {
    failures.add(error);
    if (!cancellation.signal.aborted) cancellation.abort(error);
  } finally { cancellation.signal.removeEventListener('abort', aborted); }
  if (failures.size === 1) throw [...failures][0];
  if (failures.size > 1) throw new AggregateError(failures, 'Target verification or cancellation failed.');
};
