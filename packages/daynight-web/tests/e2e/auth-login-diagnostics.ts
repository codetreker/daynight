export type AuthLoginOperation = {
  operation: string;
  status: 'running' | 'passed' | 'failed';
  durationMs: number;
  errorName?: string;
};
export type AuthLoginStep = <T>(name: string, action: () => Promise<T>) => Promise<T>;
type Cleanup = { operation: string; action: () => Promise<unknown> };
const combinedFailures = new WeakMap<AggregateError, unknown[]>();

const throwFailures = (failures: unknown[]): void => {
  const errors = failures.flatMap((failure) => failure instanceof AggregateError ? combinedFailures.get(failure) ?? [failure] : [failure]);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    const error = new AggregateError(errors, 'Authentication operation and cleanup failures.', { cause: errors[0] });
    combinedFailures.set(error, errors);
    throw error;
  }
};

const boundedCleanup = async (cleanup: Cleanup, timeoutMs: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(cleanup.action),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Authentication cleanup exceeded ${timeoutMs}ms: ${cleanup.operation}.`);
          error.name = 'TimeoutError';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
};

export const runAuthLogin = async <T>(options: {
  step: AuthLoginStep;
  attach: (operations: readonly AuthLoginOperation[]) => Promise<void>;
  cleanupTimeoutMs: number;
}, body: (diagnostics: {
  operation: AuthLoginStep;
  withCleanup: <V>(action: () => Promise<V>, cleanup: readonly Cleanup[]) => Promise<V>;
}) => Promise<T>): Promise<T> => {
  const operations: AuthLoginOperation[] = [];
  const operation: AuthLoginStep = async (name, action) => {
    const record: AuthLoginOperation = { operation: name, status: 'running', durationMs: 0 };
    operations.push(record);
    const started = performance.now();
    try {
      const value = await options.step(name, action);
      record.status = 'passed';
      return value;
    } catch (error) {
      record.status = 'failed';
      record.errorName = error instanceof Error ? error.name : typeof error;
      throw error;
    } finally { record.durationMs = Math.round(performance.now() - started); }
  };
  const withCleanup = async <V>(action: () => Promise<V>, cleanup: readonly Cleanup[]): Promise<V> => {
    const failures: unknown[] = [];
    let value!: V;
    try { value = await action(); } catch (error) { failures.push(error); }
    for (const current of cleanup) {
      try { await operation(current.operation, () => boundedCleanup(current, options.cleanupTimeoutMs)); }
      catch (error) { failures.push(error); }
    }
    throwFailures(failures);
    return value;
  };
  const failures: unknown[] = [];
  let value!: T;
  try { value = await body({ operation, withCleanup }); } catch (error) { failures.push(error); }
  try { await options.attach(operations); } catch (error) { failures.push(error); }
  throwFailures(failures);
  return value;
};
