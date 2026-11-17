import path from "node:path";
import { readTerminationPending, withTerminationDomain } from "../../session-termination/domain.js";
import { resolveWorkerPaths } from "../paths.js";
import type { WebExecutionStore } from "./web-store.js";

/** Recover only the original durable closure intent; no service or content access is needed. */
export const recoverPendingWebClosure = async (homeDirectory: string, store: WebExecutionStore, owner: { serverOrigin: string; workerId: string }, signal: AbortSignal): Promise<boolean> => {
  const directory = path.join(resolveWorkerPaths(homeDirectory).workerDirectory, "termination-domain");
  const pending = readTerminationPending(directory);
  if (pending === null || !pending.key.startsWith("web/")) return false;
  const [, projectId, taskId, claimId, sessionId] = pending.key.split("/");
  if (projectId === undefined || taskId === undefined || claimId === undefined || sessionId === undefined) throw new Error("The original Web closure intent is invalid.");
  const identity = { projectId, taskId, claimId };
  const source = store.readTerminationSource(identity);
  if (source === null || source.sessionId !== sessionId || source.cleanup !== "terminal" || source.domainId === null || source.serverOrigin !== owner.serverOrigin || source.workerId !== owner.workerId) throw new Error("The original Web closure owner or termination domain is unavailable or conflicts with this Worker.");
  await withTerminationDomain(directory, async domain => {
    const original = readTerminationPending(directory);
    if (original === null || original.key !== pending.key || original.sequence !== pending.sequence) throw new Error("The original Web closure intent changed during recovery.");
    const existing = store.readTerminationClosure(identity);
    if (existing === null) store.freezeTerminationClosure(identity, domain.domainId, original.sequence);
    const confirmed = store.readTerminationClosure(identity);
    if (confirmed === null || confirmed.domainId !== domain.domainId || confirmed.sequence !== original.sequence) throw new Error("The original Web closure could not be confirmed.");
    domain.finishClosure(original.key);
  }, { signal, expectedDomainId: source.domainId, pendingKey: pending.key });
  return true;
};
