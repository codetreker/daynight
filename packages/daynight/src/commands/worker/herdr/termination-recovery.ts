import path from "node:path";
import { readTerminationPending, withTerminationDomain } from "../../session-termination/domain.js";
import { openHerdrLifecycleStore } from "./lifecycle-store.js";

/** Reconcile the original local intent before network-dependent Worker startup. */
export const recoverHerdrTerminationPending = async (options: { workerDirectory: string; serverOrigin: string; workerId: string; signal?: AbortSignal }): Promise<void> => {
  const domainDirectory = path.join(options.workerDirectory, "termination-domain");
  const pending = readTerminationPending(domainDirectory);
  if (pending === null || !pending.key.startsWith("herdr/")) return;
  const [, projectId, taskId, claimId, sessionId] = pending.key.split("/");
  const identity = { projectId: projectId!, taskId: taskId!, claimId: claimId! };
  const store = openHerdrLifecycleStore(path.join(options.workerDirectory, "herdr-executions.sqlite"), { existingOnly: true, onMigration: () => {} });
  let failure: unknown;
  try {
    const record = store.terminationRecord(identity);
    if (record === null || record.sessionId !== sessionId || `herdr/${record.owner.projectId}/${record.owner.taskId}/${record.claimId}/${record.sessionId}` !== pending.key) throw new Error("The original Herdr termination intent has no matching lifecycle identity.");
    if (record.owner.serverOrigin !== options.serverOrigin || record.owner.workerId !== options.workerId) throw new Error("The original Herdr termination intent belongs to another Worker or service.");
    const domainId = store.terminationBinding(identity);
    if (domainId === null || store.terminationRetired(identity)) throw new Error("The original Herdr termination intent has no valid domain binding.");
    await withTerminationDomain(domainDirectory, async domain => {
      const current = readTerminationPending(domainDirectory);
      if (current === null) return;
      if (current.key !== pending.key) throw new Error("The original Herdr termination intent changed.");
      const closure = store.terminationCommitted(identity);
      if (closure !== null && (closure.domainId !== domain.domainId || closure.sequence !== current.sequence)) throw new Error("The original Herdr termination closure differs from its intent.");
      domain.finishClosure(pending.key);
    }, { expectedDomainId: domainId, pendingKey: pending.key, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  } catch (error) { failure = error; throw error; }
  finally {
    try { store.close(); }
    catch (error) { if (failure !== undefined) throw new AggregateError([failure, error], "Herdr termination recovery and journal close failed.", { cause: failure }); throw error; }
  }
};
