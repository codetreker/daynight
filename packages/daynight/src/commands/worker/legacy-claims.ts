import { isDurableLegacyResource, readLegacyWorkerResources, type LegacyWorkerIdentity } from "./backends/legacy-retired-evidence.js";
import { parseFrozenNative, type ClaimToolReservation, type WorkerStore } from "./store.js";

/** Keep the frozen configuration and identity of an original, possibly granted claim. */
export const importInterruptedWorkerClaims = (homeDirectory: string, identity: LegacyWorkerIdentity, store: WorkerStore): ReadonlyMap<string, ClaimToolReservation> => {
  const retained = new Map<string, ClaimToolReservation>();
  const existing = new Set(store.listClaimToolReservations().map(row => `${row.projectId}/${row.taskId}`));
  for (const resource of readLegacyWorkerResources(homeDirectory, identity, "task")) {
    const original = resource.identity;
    if (original.kind !== "task_claim" || isDurableLegacyResource(resource)) continue;
    const { projectId, taskId, claimId, worktreeId, candidateVersion } = original;
    if (typeof projectId !== "string" || typeof taskId !== "string" || typeof claimId !== "string" || typeof worktreeId !== "string"
      || typeof candidateVersion !== "string" || !/^[1-9][0-9]{0,18}$/.test(candidateVersion)
      || resource.operationId !== claimId) throw new Error("The original claim reservation identity is incomplete.");
    const task = { projectId, taskId, claimId };
    const key = `${projectId}/${taskId}`;
    if (store.getTask(task) !== null) continue;
    const reservation: ClaimToolReservation = { ...task, worktreeId, workerId: identity.workerId, agentControlMode: "web",
      version: BigInt(candidateVersion), nativeConfiguration: parseFrozenNative(original.frozenConfiguration) };
    retained.set(`${key}/${claimId}`, reservation);
    if (!existing.has(key)) {
      store.reserveClaimTools(reservation);
      existing.add(key);
    }
  }
  return retained;
};
