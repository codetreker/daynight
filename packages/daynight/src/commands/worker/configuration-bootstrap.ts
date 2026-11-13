import { createHash } from "node:crypto";
import { createOperation } from "../../api/operation.js";
import type { Operation } from "../../api/operation.js";
import type { WorkerCloudValue } from "../../api/worker-configuration.js";
import type { WorkerConfigurationIdentity } from "./configuration-model.js";
import { waitForConfigurationOperation } from "./configuration-persistence.js";
import { parseWorkerCloudBootstrap, readWorkerLocalConfiguration, validateWorkerBootstrapIdentity } from "./configuration-source.js";
import type { WorkerBootstrapProjectResolver } from "./configuration-source.js";
import type { WorkerPaths } from "./paths.js";

export type WorkerConfigurationBootstrap = {
  prepare(operation: Operation): Promise<WorkerCloudValue | null>;
  clear(): Promise<void>;
  invalidate(): void;
  stop(): Promise<void>;
};

export const createWorkerConfigurationBootstrap = (options: {
  readonly paths: WorkerPaths;
  readonly identity: WorkerConfigurationIdentity;
  readonly signal: AbortSignal;
  readonly resolveProject: WorkerBootstrapProjectResolver;
  readonly onError?: (error: unknown) => void;
}): WorkerConfigurationBootstrap => {
  type Pass = { readonly controller: AbortController; readonly promise: Promise<WorkerCloudValue> };
  let active: Pass | undefined, stopped = false, epoch = 0;
  let scope: string | undefined;
  const resolved = new Map<string, { readonly id: string }>();
  const reset = (): void => { epoch++; scope = undefined; resolved.clear(); };
  const cancel = async (reason: Error): Promise<void> => {
    const pass = active;
    pass?.controller.abort(reason);
    // Superseded candidates have no remaining authority, but their owned operations must finish.
    if (pass !== undefined) await Promise.allSettled([pass.promise]);
  };
  const start = (): Pass => {
    const controller = new AbortController();
    const operation = createOperation({ signal: AbortSignal.any([options.signal, controller.signal]), limits: { totalMs: 60_000 } });
    const passEpoch = epoch;
    const promise = (async (): Promise<WorkerCloudValue> => {
      try {
        const local = await readWorkerLocalConfiguration(options.paths, operation.signal);
        operation.check();
        validateWorkerBootstrapIdentity(local, options.paths, options.identity);
        const sourceHash = createHash("sha256").update(local.source === undefined ? "missing" : `source:${local.source}`).digest("hex");
        const currentScope = JSON.stringify([options.identity.serverOrigin, options.identity.userId, options.identity.workerId, sourceHash]);
        if (scope !== currentScope) { resolved.clear(); scope = currentScope; }
        const resolveProject: WorkerBootstrapProjectResolver = async (repository, signal) => {
          operation.check();
          const key = JSON.stringify(repository), cached = resolved.get(key);
          if (cached !== undefined) return cached;
          const project = await options.resolveProject(repository, signal);
          operation.check();
          const result = Object.freeze({ id: project.id });
          if (epoch === passEpoch && scope === currentScope) resolved.set(key, result);
          return result;
        };
        const candidate = await parseWorkerCloudBootstrap(local.source, options.paths, resolveProject, operation.signal);
        operation.check();
        return candidate;
      } catch (error) {
        if (!options.signal.aborted && !controller.signal.aborted) {
          try { options.onError?.(error); }
          catch (notificationError) { throw new AggregateError([error, notificationError], "Worker bootstrap preparation and error notification failed.", { cause: error }); }
        }
        throw error;
      } finally { operation.dispose(); }
    })();
    const pass = { controller, promise };
    active = pass;
    void promise.finally(() => { if (active === pass) active = undefined; }).catch(() => undefined);
    return pass;
  };
  return {
    prepare: operation => {
      operation.check(); options.signal.throwIfAborted();
      if (stopped) return Promise.reject(new Error("Worker configuration bootstrap has stopped."));
      return waitForConfigurationOperation((active ?? start()).promise, operation.signal);
    },
    clear: async () => { reset(); await cancel(new Error("The Worker has an authoritative cloud configuration.")); },
    invalidate: () => { reset(); active?.controller.abort(new Error("The Worker bootstrap candidate was rejected.")); },
    stop: async () => { stopped = true; reset(); await cancel(new Error("Worker configuration bootstrap has stopped.")); },
  };
};
