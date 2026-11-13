import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getSystemErrorMap } from "node:util";
import { replaceFileAtomicallyFromChunks } from "../../platform/files.js";
import { configurationCacheChunks, createConfigurationCache, readConfigurationCache } from "./configuration-cache.js";
import { configurationRetryDelays, freezeConfiguration } from "./configuration-model.js";
import type { WorkerConfigurationCache, WorkerConfigurationIdentity, WorkerConfigurationReportContext, WorkerConfigurationSource } from "./configuration-model.js";

export type ConfigurationPersistenceContext = {
  readonly kind: "authority-read" | "receipt-accept" | "application" | "other";
  readonly source: WorkerConfigurationSource;
  readonly report?: WorkerConfigurationReportContext;
  readonly syncId?: string;
};

export type ConfigurationPersistenceEvent = {
  readonly kind: "blocked" | "recovered";
  readonly phase: "read" | "directory" | "persist";
  readonly error?: unknown;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly recordIds: readonly string[];
  readonly context?: ConfigurationPersistenceContext;
};
export type PreparedConfigurationCommit = {
  readonly cache: WorkerConfigurationCache;
  readonly write: boolean;
  readonly recordIds: readonly string[];
  readonly publish: (committedCache: WorkerConfigurationCache) => void;
  readonly context?: ConfigurationPersistenceContext;
};
export type WorkerConfigurationPersistence = {
  current(): WorkerConfigurationCache;
  commit(prepare: (current: WorkerConfigurationCache) => PreparedConfigurationCommit): Promise<void>;
  isReady(): boolean;
  waitReady(signal: AbortSignal): Promise<void>;
  whenIdle(): Promise<void>;
  beginDrain(): void;
  finish(): Promise<void>;
};

const filesystemCodes = new Set([...getSystemErrorMap().values()].map(([code]) => code));
const isFilesystemError = (error: unknown): boolean => {
  // Mixed parser/encoder and cleanup failures must retain their fatal primary error.
  if (error instanceof AggregateError) return error.errors.length !== 0 && error.errors.every(isFilesystemError);
  return error instanceof Error && !(error instanceof TypeError) && "code" in error && typeof error.code === "string" && filesystemCodes.has(error.code);
};

export class UnsavedConfigurationError extends Error {
  constructor(readonly recordIds: readonly string[], cause: unknown) {
    super(`Worker configuration checkpoint was not saved${recordIds.length === 0 ? "" : ` for records ${recordIds.join(", ")}`}.`, { cause });
    this.name = "UnsavedConfigurationError";
  }
}

export const waitForConfigurationOperation = <T>(owned: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  const abort = (): void => { signal.removeEventListener("abort", abort); reject(signal.reason); };
  // Always observe the owned operation, including when its waiter is already cancelled.
  owned.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
});

export const createWorkerConfigurationPersistence = async (options: {
  readonly file: string;
  readonly identity: WorkerConfigurationIdentity;
  readonly signal: AbortSignal;
  readonly now?: () => number;
  readonly persist?: (file: string, chunks: () => Iterable<string>) => Promise<void>;
  readonly onState?: (event: ConfigurationPersistenceEvent) => void;
}): Promise<WorkerConfigurationPersistence> => {
  const now = options.now ?? Date.now;
  const persist = options.persist ?? ((file, chunks) => replaceFileAtomicallyFromChunks(file, chunks(), 0o600));
  let cache: WorkerConfigurationCache;
  let initialized = false, draining = false, expired = false, sealed = false;
  let fatal: { error: unknown } | undefined, blocked: ConfigurationPersistenceEvent | undefined;
  let lastIoError: unknown, drainDeadline: number | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelRetry: (() => void) | undefined;
  let tail = Promise.resolve(), finishing: Promise<void> | undefined;
  const failures: unknown[] = [], notificationFailures: unknown[] = [];
  const waiters = new Set<{ resolve: () => void; reject: (error: unknown) => void }>();
  const stoppingReason = (): unknown => options.signal.aborted ? options.signal.reason : new Error("Worker configuration persistence is draining.");
  const failure = (): { error: unknown } | undefined => fatal ?? (draining ? { error: stoppingReason() } : undefined);
  const ready = (): boolean => initialized && !draining && blocked === undefined && fatal === undefined;
  const settleWaiters = (): void => {
    const error = failure();
    if (!ready() && error === undefined) return;
    for (const waiter of waiters) error === undefined ? waiter.resolve() : waiter.reject(error.error);
    waiters.clear();
  };
  const notify = (event: ConfigurationPersistenceEvent): void => {
    try { options.onState?.(event); } catch (error) { notificationFailures.push(error); }
  };
  const recovered = (): void => {
    const previous = blocked;
    blocked = undefined;
    lastIoError = undefined;
    if (previous !== undefined) notify({ kind: "recovered", phase: previous.phase, attempts: previous.attempts, nextAttemptAt: null, recordIds: previous.recordIds, ...(previous.context === undefined ? {} : { context: previous.context }) });
    settleWaiters();
  };
  const beginDrain = (): void => {
    if (draining) return;
    draining = true;
    drainDeadline = now() + 5_000;
    drainTimer = setTimeout(() => {
      expired = true;
      cancelRetry?.();
    }, 5_000);
    drainTimer.unref();
    settleWaiters();
  };
  options.signal.addEventListener("abort", beginDrain, { once: true });
  if (options.signal.aborted) beginDrain();
  const cleanup = (): void => {
    if (drainTimer !== undefined) clearTimeout(drainTimer);
    options.signal.removeEventListener("abort", beginDrain);
  };
  const retryWait = async (delay: number): Promise<void> => new Promise(resolve => {
    const timer = setTimeout(done, delay);
    function done(): void { clearTimeout(timer); cancelRetry = undefined; resolve(); }
    cancelRetry = done;
    if (expired) done();
  });
  const retry = async <T>(phase: ConfigurationPersistenceEvent["phase"], recordIds: readonly string[], action: () => Promise<T>, context?: ConfigurationPersistenceContext): Promise<T> => {
    let attempts = 0;
    while (true) {
      if (expired || drainDeadline !== undefined && now() >= drainDeadline) throw new UnsavedConfigurationError(recordIds, lastIoError ?? stoppingReason());
      try { return await action(); }
      catch (error) {
        if (!isFilesystemError(error)) throw error;
        lastIoError = error;
        const delay = configurationRetryDelays[Math.min(attempts++, configurationRetryDelays.length - 1)]!;
        const retryAt = now() + delay;
        const scheduled = !expired && (drainDeadline === undefined || retryAt < drainDeadline);
        blocked = { kind: "blocked", phase, error, attempts, nextAttemptAt: scheduled ? new Date(retryAt).toISOString() : null, recordIds, ...(context === undefined ? {} : { context }) };
        notify(blocked);
        // The deadline interrupts scheduling only. The action above has already joined all owned I/O.
        if (!scheduled && draining) {
          if (!expired) await retryWait(Math.max(0, drainDeadline! - now()));
          throw new UnsavedConfigurationError(recordIds, error);
        }
        await retryWait(delay);
      }
    }
  };
  try {
    // Root cancellation owns drain scheduling, not the lifetime of an active file descriptor.
    const readSignal = new AbortController().signal;
    const loaded = await retry("read", [], async () => {
      try { return await readConfigurationCache(options.file, options.identity, readSignal); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT" && "syscall" in error && error.syscall === "open") return { cache: createConfigurationCache(options.identity), migrated: false };
        throw error;
      }
    });
    cache = freezeConfiguration(loaded.cache);
    await retry("directory", [], () => mkdir(path.dirname(options.file), { recursive: true, mode: 0o700 }));
    if (loaded.migrated) await retry("persist", [...cache.currentItems, ...cache.retainedItems].map(item => item.recordId), () => persist(options.file, () => configurationCacheChunks(cache)));
    if (draining) throw stoppingReason();
    initialized = true;
    recovered();
  } catch (error) {
    cleanup();
    if (notificationFailures.length !== 0) throw new AggregateError([error, ...notificationFailures], "Worker configuration initialization and notification failed.", { cause: error });
    throw error;
  }
  const recordFailure = (error: unknown): void => {
    if (!failures.includes(error)) failures.push(error);
    if (!(error instanceof UnsavedConfigurationError)) fatal = { error };
    settleWaiters();
  };
  const checkFailures = (): void => {
    const errors = [...failures, ...notificationFailures];
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Worker configuration persistence failed.", { cause: errors[0] });
  };
  return {
    current: () => cache,
    isReady: ready,
    waitReady: signal => {
      const error = failure();
      if (signal.aborted) return Promise.reject(signal.reason);
      if (error !== undefined) return Promise.reject(error.error);
      if (ready()) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const waiter = { resolve: () => { signal.removeEventListener("abort", abort); resolve(); }, reject: (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); } };
        const abort = (): void => { waiters.delete(waiter); signal.removeEventListener("abort", abort); reject(signal.reason); };
        waiters.add(waiter);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    },
    commit: prepare => {
      if (sealed) return Promise.reject(new Error("Worker configuration persistence has finished accepting results."));
      const operation = tail.then(async () => {
        if (fatal !== undefined) throw fatal.error;
        const prepared = prepare(cache), next = freezeConfiguration(prepared.cache), recordIds = Object.freeze([...prepared.recordIds]);
        const context = prepared.context === undefined ? undefined : freezeConfiguration(prepared.context);
        if (prepared.write) await retry("persist", recordIds, () => persist(options.file, () => configurationCacheChunks(next)), context);
        cache = next;
        prepared.publish(cache);
        if (prepared.write) recovered();
      });
      tail = operation.catch(recordFailure);
      return operation;
    },
    whenIdle: async () => { await tail; checkFailures(); },
    beginDrain,
    finish: () => {
      if (finishing !== undefined) return finishing;
      sealed = true;
      beginDrain();
      finishing = (async () => { try { await tail; checkFailures(); } finally { cleanup(); } })();
      return finishing;
    },
  };
};
