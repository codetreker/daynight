import { describe, expect, it } from "vitest";
import { collectLifecycleRecovery, executionRecoveryResult, selectLifecycleRecoveryResources, type LifecycleTaskRecoveryEvidence } from "../../../src/commands/worker/lifecycle-recovery.js";
import type { LifecycleResource } from "../../../src/commands/worker/lifecycle-store.js";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const task: LifecycleTaskRecoveryEvidence = { projectId: id(1), taskId: id(2), claimId: id(3), executionId: id(4), sessionId: id(5), executionGeneration: "2", recoverability: "eligible", reasonCode: null };
const resource = (overrides: Partial<LifecycleResource> = {}): LifecycleResource => ({ resourceId: id(6), ownerKind: "task", identity: { projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, executionId: task.executionId, sessionId: task.sessionId, executionGeneration: task.executionGeneration }, instanceId: id(7), scopeGeneration: "2", operationId: id(8), stage: "stopped", processProof: null, stopProof: null, saveState: "durable", error: null, ...overrides });

describe("original execution lifecycle recovery", () => {
  it("does not infer eligibility without an observed original execution", () => {
    expect(collectLifecycleRecovery({ resources: [resource()] })).toEqual([{ resourceId: id(6), recoverability: "unknown", reasonCode: "inventory_incomplete" }]);
    expect(executionRecoveryResult({ ownershipChanged: false, independentBlocker: false, nativeBlocked: false, outcomeUnknown: false, verified: false }).recoverability).toBe("unknown");
  });
  it("preserves independent blockers and native recovery failures separately", () => {
    for (const [flag, reasonCode] of [["ownershipChanged", "ownership_changed"], ["independentBlocker", "independent_blocker"], ["nativeBlocked", "native_unrecoverable"]] as const) {
      expect(executionRecoveryResult({ ownershipChanged: false, independentBlocker: false, nativeBlocked: false, outcomeUnknown: false, verified: true, [flag]: true })).toEqual({ recoverability: "blocked", reasonCode });
    }
  });
  it("cannot use another Session or execution generation's successful recovery", () => {
    for (const replacement of [{ sessionId: id(11) }, { executionGeneration: "3" }]) {
      expect(collectLifecycleRecovery({ resources: [resource()], tasks: [{ ...task, ...replacement }] })).toEqual([{ resourceId: id(6), recoverability: "blocked", reasonCode: "ownership_changed" }]);
    }
  });
  it("selects the latest scope once without hiding an older unknown request", () => {
    const older = resource({ resourceId: id(10), scopeGeneration: "1", stage: "unknown" });
    expect(collectLifecycleRecovery({ resources: [older, resource()], tasks: [task] })).toEqual([{ resourceId: id(6), recoverability: "unknown", reasonCode: "resume_interrupted" }]);
    expect(collectLifecycleRecovery({ resources: [{ ...older, stage: "confirmed" }, resource()], tasks: [task] })).toEqual([{ resourceId: id(6), recoverability: "eligible", reasonCode: null }]);
  });
  it("retains a save failure even when native recovery was observed", () => {
    expect(collectLifecycleRecovery({ resources: [resource({ saveState: "failed" })], tasks: [task] })).toEqual([{ resourceId: id(6), recoverability: "unknown", reasonCode: "save_failed" }]);
  });
  it("keeps Bot recovery independent from Task results and sorts the wire inventory", () => {
    const bot = resource({ resourceId: id(9), ownerKind: "bot", identity: { botId: id(12), executionId: id(13), sessionId: id(14), executionGeneration: "1" } });
    expect(collectLifecycleRecovery({ resources: [bot, resource()], tasks: [task], bots: [{ botId: id(12), executionId: id(13), sessionId: id(14), executionGeneration: "1", recoverability: "blocked", reasonCode: "native_unrecoverable" }] })).toEqual([
      { resourceId: id(6), recoverability: "eligible", reasonCode: null }, { resourceId: id(9), recoverability: "blocked", reasonCode: "native_unrecoverable" },
    ]);
  });
});


describe("lifecycle recovery owner inventory", () => {
  const noOwners = { unfinishedClaimIds: new Set<string>(), currentBotIds: new Set<string>() };
  const bot = () => resource({ resourceId: id(9), ownerKind: "bot", identity: { botId: id(12), executionId: id(13), sessionId: id(14), executionGeneration: "1" } });

  it("excludes completed Tasks and removed Bots only after their responsibilities close", () => {
    const selected = selectLifecycleRecoveryResources([resource(), bot()], noOwners);
    expect(selected).toEqual([]);
    expect(collectLifecycleRecovery({ resources: selected })).toEqual([]);
  });

  it("retains an unknown request or unsaved result after its owner leaves the inventory", () => {
    const unknownTask = resource({ stage: "unknown" });
    const unsavedBot = { ...bot(), saveState: "failed" as const };
    const selected = selectLifecycleRecoveryResources([unknownTask, unsavedBot, resource({ resourceId: id(10) })], noOwners);
    expect(selected).toEqual([unknownTask, unsavedBot]);
    expect(collectLifecycleRecovery({ resources: selected })).toEqual([
      { resourceId: id(6), recoverability: "unknown", reasonCode: "inventory_incomplete" },
      { resourceId: id(9), recoverability: "unknown", reasonCode: "inventory_incomplete" },
    ]);
  });

  it("retains an unfinished original claim before the next scope supplies Web evidence", () => {
    const original = resource({ scopeGeneration: "1" });
    const selected = selectLifecycleRecoveryResources([original], { ...noOwners, unfinishedClaimIds: new Set([task.claimId]) });
    expect(selected).toEqual([original]);
    expect(collectLifecycleRecovery({ resources: selected })).toEqual([
      { resourceId: id(6), recoverability: "unknown", reasonCode: "inventory_incomplete" },
    ]);
  });

  it("does not interpret unavailable owner sources as complete empty inventories", () => {
    expect(selectLifecycleRecoveryResources([resource(), bot()], {})).toEqual([resource(), bot()]);
    expect(selectLifecycleRecoveryResources([resource(), bot()], { unfinishedClaimIds: new Set() })).toEqual([bot()]);
    expect(selectLifecycleRecoveryResources([resource(), bot()], { currentBotIds: new Set() })).toEqual([resource()]);
  });

  it("keeps a current Bot even when its previous native execution stopped durably", () => {
    expect(selectLifecycleRecoveryResources([bot()], { ...noOwners, currentBotIds: new Set([id(12)]) })).toEqual([bot()]);
  });
});
