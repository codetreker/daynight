export type PipelinePhases = {
  browser(): Promise<void>;
  coverage(waitForPreparations: () => Promise<void>): Promise<void>;
  containerPrepared(): Promise<void>;
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
    let admission: Promise<void> | undefined;
    const waitForPreparations = async (): Promise<void> => {
      if (admission === undefined) {
        admission = start(async () => {
          let prepared = false;
          const readiness = start(async () => { await phases.containerPrepared(); prepared = true; });
          await Promise.race([readiness, container.then(() => {
            cancellation.signal.throwIfAborted();
            if (!prepared) throw new Error('Container acceptance completed before preparation was announced.');
          })]);
          cancellation.signal.throwIfAborted();
          await nativePreparation;
          cancellation.signal.throwIfAborted();
        });
      }
      await admission;
      cancellation.signal.throwIfAborted();
    };
    const coverage = start(() => phases.coverage(waitForPreparations));
    const browser = start(async () => {
      await coverage;
      cancellation.signal.throwIfAborted();
      await phases.browser();
    });
    const nativePreparation = start(phases.nativePreparation);
    const container = start(phases.container);
    const nativeFunctional = start(async () => {
      await Promise.all([browser, nativePreparation]);
      cancellation.signal.throwIfAborted();
      await phases.nativeFunctional();
      cancellation.signal.throwIfAborted();
      await phases.releaseContainer();
    });
    await Promise.all([browser, coverage, nativePreparation, nativeFunctional, container]);
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
