import type { LifecycleRecoveryObservation } from "../../api/worker-lifecycle.js";
import type { LifecycleResource } from "./lifecycle-store.js";

type Result = Pick<LifecycleRecoveryObservation, "recoverability" | "reasonCode">;
export type LifecycleExecutionRecoveryEvidence = Result & {
  executionId: string | null; sessionId: string | null; executionGeneration: string | null;
};
export type LifecycleTaskRecoveryEvidence = LifecycleExecutionRecoveryEvidence & { projectId: string; taskId: string; claimId: string };
export type LifecycleBotRecoveryEvidence = LifecycleExecutionRecoveryEvidence & { botId: string };
export type LifecycleRecoverySources = {
  tasks?: readonly LifecycleTaskRecoveryEvidence[]; bots?: readonly LifecycleBotRecoveryEvidence[];
};

/** Eligibility is an observed original execution result, never the Worker's gate. */
export const executionRecoveryResult = (facts: {
  ownershipChanged: boolean; independentBlocker: boolean; nativeBlocked: boolean;
  outcomeUnknown: boolean; verified: boolean;
}): Result => {
  if (facts.ownershipChanged) return { recoverability: "blocked", reasonCode: "ownership_changed" };
  if (facts.independentBlocker) return { recoverability: "blocked", reasonCode: "independent_blocker" };
  if (facts.nativeBlocked) return { recoverability: "blocked", reasonCode: "native_unrecoverable" };
  if (facts.outcomeUnknown || !facts.verified) return { recoverability: "unknown", reasonCode: "resume_interrupted" };
  return { recoverability: "eligible", reasonCode: null };
};

export type LifecycleRecoveryOwners = {
  unfinishedClaimIds?: ReadonlySet<string>; currentBotIds?: ReadonlySet<string>;
};

/** Missing owner inventory is uncertainty; only a complete inventory can retire history. */
export const selectLifecycleRecoveryResources = (
  resources: readonly LifecycleResource[], owners: LifecycleRecoveryOwners,
): LifecycleResource[] => resources.filter(resource => {
  if (!["confirmed", "stopped", "not_dispatched"].includes(resource.stage) || resource.saveState !== "durable") return true;
  const { claimId, botId } = resource.identity;
  if (typeof claimId === "string") return owners.unfinishedClaimIds === undefined || owners.unfinishedClaimIds.has(claimId);
  if (typeof botId === "string") return owners.currentBotIds === undefined || owners.currentBotIds.has(botId);
  return false;
});

/** Join only original identities. A successor's success cannot repair its predecessor. */
export const collectLifecycleRecovery = (input: LifecycleRecoverySources & { resources: readonly LifecycleResource[] }): LifecycleRecoveryObservation[] => {
  const result: LifecycleRecoveryObservation[] = [];
  const groups = new Map<string, LifecycleResource[]>();
  for (const resource of input.resources) {
    const identity = resource.identity;
    const key = typeof identity.projectId === "string" && typeof identity.taskId === "string" && typeof identity.claimId === "string"
      ? JSON.stringify(["task", identity.projectId, identity.taskId, identity.claimId])
      : typeof identity.botId === "string" ? JSON.stringify(["bot", identity.botId]) : null;
    if (key !== null) groups.set(key, [...(groups.get(key) ?? []), resource]);
  }
  for (const resources of groups.values()) {
    const ordered = [...resources].sort((a, b) => {
      const scope = BigInt(b.scopeGeneration) - BigInt(a.scopeGeneration);
      if (scope !== 0n) return scope > 0n ? 1 : -1;
      const generation = (value: LifecycleResource) => typeof value.identity.executionGeneration === "string" ? BigInt(value.identity.executionGeneration) : 0n;
      const execution = generation(b) - generation(a);
      if (execution !== 0n) return execution > 0n ? 1 : -1;
      const completeness = (value: LifecycleResource) => ["executionId", "sessionId"].filter(key => typeof value.identity[key] === "string").length;
      return completeness(b) - completeness(a) || a.resourceId.localeCompare(b.resourceId);
    });
    const resource = ordered[0]!;
    const identity = resource.identity;
    const task = typeof identity.projectId === "string" && typeof identity.taskId === "string" && typeof identity.claimId === "string";
    const bot = typeof identity.botId === "string";
    if (!task && !bot) continue;
    const candidates = task
      ? (input.tasks ?? []).filter(item => item.projectId === identity.projectId && item.taskId === identity.taskId && item.claimId === identity.claimId)
      : (input.bots ?? []).filter(item => item.botId === identity.botId);
    const matching = candidates.filter(item => ["executionId", "sessionId", "executionGeneration"].every(key =>
      identity[key] === undefined || identity[key] === null || identity[key] === item[key as keyof LifecycleExecutionRecoveryEvidence]));
    let observation: Result = { recoverability: "unknown", reasonCode: "inventory_incomplete" };
    if (matching.length === 1) {
      const evidence = matching[0]!;
      observation = { recoverability: evidence.recoverability, reasonCode: evidence.reasonCode };
      if (observation.recoverability === "eligible" && resources.some(item => item.stage === "unknown" || item.saveState !== "durable")) {
        observation = { recoverability: "unknown", reasonCode: resources.some(item => item.saveState !== "durable") ? "save_failed" : "resume_interrupted" };
      }
    } else if (candidates.length > 0 && matching.length === 0) {
      observation = { recoverability: "blocked", reasonCode: "ownership_changed" };
    }
    result.push({ resourceId: resource.resourceId, ...observation });
  }
  return result.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
};
