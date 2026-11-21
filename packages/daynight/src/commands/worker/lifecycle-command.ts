import { randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { CliContext } from "../../cli/context.js";
import { loadServerConfiguration } from "../../config/server.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import { lifecycleId } from "../../api/worker-lifecycle.js";
import { resolveWorkerPaths } from "./paths.js";
import { openLifecycleStore, readLifecycleIdentity, readLifecycleSnapshot, type LifecycleSnapshot } from "./lifecycle-store.js";
import { LifecycleIpcUnknownError, requestLifecycleIpc } from "./lifecycle-ipc.js";

export type WorkerLifecycleCommandRequest = { kind: "show" | "disable" | "resume"; workerId: string };
export type LifecycleManagementOnlyOptions = { homeDirectory: string; packageDirectory: string; version: string; workerId: string; operationId: string; kind: "disable" | "reconcile" | "resume"; signal?: AbortSignal };
export type WorkerLifecycleCommandDependencies = {
  request: typeof requestLifecycleIpc;
  manage: (options: LifecycleManagementOnlyOptions) => Promise<unknown>;
};
const defaults: WorkerLifecycleCommandDependencies = {
  request: requestLifecycleIpc,
  manage: async options => (await import("./runtime.js")).runLifecycleManagementOnly(options),
};
export const lifecycleLocalView = ({ state, resources, inventoryComplete }: LifecycleSnapshot) => ({
  protocolVersion: 1, workerId: state.workerId, operationId: state.operationId, localEpoch: state.localEpoch,
  intentVersion: state.intentVersion, phase: state.phase, stop: state.stop, save: state.save, sync: state.sync,
  inventoryComplete, resources, errorCode: state.errorCode,
});
const unavailableBeforeDispatch = (error: unknown): boolean => {
  if (error instanceof LifecycleIpcUnknownError) return !error.dispatched;
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ECONNREFUSED");
};

export const runWorkerLifecycleCommand = async (request: WorkerLifecycleCommandRequest, context: CliContext, dependencies: WorkerLifecycleCommandDependencies = defaults): Promise<void> => {
  const workerId = lifecycleId(request.workerId), paths = resolveWorkerPaths(context.homeDirectory());
  const configuration = await loadServerConfiguration(paths), file = path.join(paths.workerDirectory, "lifecycle.sqlite");
  const identity = readLifecycleIdentity({ file, workerId, serverOrigin: configuration.serverUrl });
  const read = () => readLifecycleSnapshot({ file, identity, allResources: true });
  if (request.kind === "show") { context.stdout(`${JSON.stringify(lifecycleLocalView(read()))}\n`); return; }
  const deadline = performance.now() + 90_000, operationId = randomUUID();
  let localEpoch: string | undefined;
  if (request.kind === "disable") {
    const store = openLifecycleStore({ file, identity });
    try { localEpoch = store.closeAdmission({ operationId, local: true }).localEpoch; }
    finally { store.close(); }
  }
  // A local disable is already durable before waking the original manager.
  // A resume is sent only once; an unknown IPC result must be observed, not replayed.
  let transportFailure: unknown;
  try { await dependencies.request({ workerDirectory: paths.workerDirectory, identity, kind: request.kind, operationId, timeoutMs: Math.min(10_000, Math.ceil(deadline - performance.now())) }); }
  catch (error) {
    transportFailure = error;
    if (unavailableBeforeDispatch(error)) {
      const cancellation = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { const error = new Error("Worker lifecycle command deadline elapsed."); cancellation.abort(error); reject(error); }, Math.max(1, deadline - performance.now())); });
      try { await Promise.race([dependencies.manage({ homeDirectory: context.homeDirectory(), packageDirectory: context.packageDirectory, version: context.version, workerId, operationId, kind: request.kind, signal: cancellation.signal }), expired]); transportFailure = undefined; }
      catch (failure) { transportFailure = failure; }
      finally { clearTimeout(timer); }
    }
  }
  for (;;) {
    const snapshot = read(), state = snapshot.state;
    const complete = request.kind === "disable"
      ? state.phase === "disabled" && state.stop === "confirmed" && state.save === "durable" && state.localVeto && localEpoch !== undefined && BigInt(state.localEpoch) >= BigInt(localEpoch)
      : state.phase === "accepting" && !state.localVeto && state.activation?.operationId === operationId;
    if (complete) { context.stdout(`${JSON.stringify({ ...lifecycleLocalView(snapshot), requestedOperationId: operationId, outcome: "confirmed" })}\n`); return; }
    if (state.phase === "blocked" && transportFailure === undefined) {
      context.stdout(`${JSON.stringify({ ...lifecycleLocalView(snapshot), requestedOperationId: operationId, outcome: "blocked" })}\n`);
      throw new PublicDiagnosticError("Worker lifecycle is blocked; inspect the retained local resource evidence.", 1, { cause: transportFailure });
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      context.stdout(`${JSON.stringify({ ...lifecycleLocalView(snapshot), requestedOperationId: operationId, outcome: "pending" })}\n`);
      throw new PublicDiagnosticError("Worker lifecycle outcome is pending. Use worker lifecycle show for the original local state.", 3, { cause: transportFailure });
    }
    await delay(Math.min(1000, remaining));
  }
};
