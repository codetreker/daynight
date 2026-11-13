import { describe, expect, it } from "vitest";
import type { WorkerCloudDesired, WorkerCloudFailure, WorkerCloudItemKey, WorkerCloudNative } from "../../../src/api/worker-configuration.js";
import type { TrackedConfigurationItem, WorkerConfigurationCache, WorkerNativeProof } from "../../../src/commands/worker/configuration-model.js";
import { acceptConfigurationProjection, allConfigurationItems, configurationHasUnfinishedRemoval, configurationSnapshot, findCurrentConfigurationItem, projectConfigurationReport, pruneConfigurationRetained, transitionConfigurationDesired } from "../../../src/commands/worker/configuration-state.js";

const id = (value: number): string => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const native: WorkerCloudNative = { agent: "codex", model: "original", args: [] };
const desired = (revision = "1", projects: readonly string[] = []): WorkerCloudDesired => ({ revision, updatedAt: "2026-11-12T00:00:00Z", value: { maxConcurrent: 2, pollIntervalMs: 1200, recoveryLimit: 3, preferPlatformSpecificTasks: false, native, projects: projects.map(projectId => ({ projectId, nativeOverrides: {} })) } });
const empty = (target: WorkerCloudDesired | null = desired()): WorkerConfigurationCache => ({ schemaVersion: 5, identity: { serverOrigin: "https://daynight.example", userId: id(9000), workerId: id(9001) }, authority: { generation: id(8000), desired: target, observationRevision: "0" }, nextFailureId: 100, projectionCursor: null, currentItems: [], retainedItems: [] });
const tracked = (number: number, key: WorkerCloudItemKey, appliedValue: TrackedConfigurationItem["value"]["appliedValue"] = null): TrackedConfigurationItem => ({ recordId: id(number), origin: { generation: id(8000), targetRevision: "1", source: "application" }, value: { key, targetRevision: "1", appliedValue, state: appliedValue === null ? "pending" : "applied", error: null, lastFailure: null, nextAttemptAt: null }, backoffStep: 0, failureId: null, started: false, nativeMode: key.kind === "native" || key.kind === "projectNative" ? "herdr" : null, actualSource: appliedValue === null ? null : { kind: "observed", recordId: id(number), generation: id(8000), targetRevision: "1" }, blockedByRemovalId: null });
const fault: WorkerCloudFailure = { code: "unavailable", category: "agent", phase: "validate", occurredAt: "2026-11-12T00:00:01Z" };
const failed = (item: TrackedConfigurationItem, failureId = 1, occurredAt = fault.occurredAt): TrackedConfigurationItem => ({ ...item, failureId, value: { ...item.value, state: "error", error: { ...fault, occurredAt }, lastFailure: { ...fault, occurredAt }, nextAttemptAt: "2026-11-12T00:00:10Z" }, backoffStep: 1 });
const options = { synchronized: true, localMode: "herdr" as const, localTools: { codex: { kind: "auto" as const }, copilot: { kind: "auto" as const }, herdr: { kind: "auto" as const } }, bootstrap: null };
const ids = () => { let value = 1000; return () => id(value++); };

describe("Worker configuration fact transitions", () => {
  it("creates new current identities without rewriting an observed source or copying failure ownership", () => {
    const original = failed(tracked(1, { kind: "native" }, native));
    const cache = { ...empty(), currentItems: [original] };
    const next = transitionConfigurationDesired(cache, desired("2"), "herdr", new Set(), ids());
    const current = findCurrentConfigurationItem(next, { kind: "native" })!;
    expect(current.recordId).not.toBe(original.recordId);
    expect(current.origin).toEqual({ generation: next.authority.generation, targetRevision: "2", source: "application" });
    expect(current.actualSource).toEqual(original.actualSource);
    expect(current.failureId).toBeNull();
    expect(current.value.lastFailure).toBeNull();
    expect(next.retainedItems).toContainEqual(original);
    expect(configurationSnapshot(next, true, new Map(), "herdr", options.localTools, valueProof).items.find(item => item.key.kind === "native")?.lastFailure).toEqual(fault);
    expect(original.origin.targetRevision).toBe("1");
  });

  it("retains a running old stop and blocks new stop verification and preparation for a reselected project", () => {
    const projectId = id(70), stop = { ...tracked(1, { kind: "projectRemoval", projectId }), started: true, value: { ...tracked(1, { kind: "projectRemoval", projectId }).value, state: "applying" as const } };
    const next = transitionConfigurationDesired({ ...empty(), currentItems: [stop] }, desired("2", [projectId]), "herdr", new Set([stop.recordId]), ids());
    expect(next.retainedItems).toContainEqual(stop);
    expect(findCurrentConfigurationItem(next, { kind: "projectPreparation", projectId })).toMatchObject({ blockedByRemovalId: stop.recordId, value: { state: "pending", appliedValue: null } });
    expect(findCurrentConfigurationItem(next, { kind: "projectRemoval", projectId })).toMatchObject({ blockedByRemovalId: stop.recordId, value: { targetRevision: "2", state: "pending" } });
    expect(configurationHasUnfinishedRemoval(next, projectId)).toBe(true);
  });

  it("retires superseded unstarted verification placeholders while the original stop remains owned", () => {
    const projectId = id(70), original = { ...tracked(1, { kind: "projectRemoval", projectId }), started: true, value: { ...tracked(1, { kind: "projectRemoval", projectId }).value, state: "applying" as const } };
    let current = { ...empty(), currentItems: [original] } as WorkerConfigurationCache;
    const newId = ids();
    for (let revision = 2; revision <= 10; revision++) {
      current = transitionConfigurationDesired(current, desired(String(revision), [projectId]), "herdr", new Set([original.recordId]), newId);
      expect(current.retainedItems).toEqual([original]);
      expect(findCurrentConfigurationItem(current, { kind: "projectRemoval", projectId })?.blockedByRemovalId).toBe(original.recordId);
    }
  });

  it("keeps referenced original stop facts until its current verification completes", () => {
    const projectId = id(70), stop = tracked(1, { kind: "projectRemoval", projectId }, true);
    const verification = { ...tracked(2, { kind: "projectRemoval", projectId }), blockedByRemovalId: stop.recordId };
    const preparation = { ...tracked(3, { kind: "projectPreparation", projectId }), blockedByRemovalId: stop.recordId };
    const cache = { ...empty(), currentItems: [verification, preparation], retainedItems: [stop] };
    const running = pruneConfigurationRetained(cache, new Set([stop.recordId]));
    expect(running.currentItems.every(item => item.blockedByRemovalId === stop.recordId)).toBe(true);
    const joined = pruneConfigurationRetained(cache, new Set());
    expect(joined.currentItems[0]!.blockedByRemovalId).toBe(stop.recordId);
    expect(joined.currentItems[1]!.blockedByRemovalId).toBeNull();
    expect(joined.retainedItems).toContainEqual(stop);
    const completed = { ...joined, currentItems: [{ ...verification, value: { ...verification.value, appliedValue: true, state: "applied" as const } }, preparation] };
    expect(pruneConfigurationRetained(completed, new Set()).currentItems[0]!.blockedByRemovalId).toBeNull();
  });

  it("retains an unstarted removal failure without inventing a stop requirement for a selected project", () => {
    const projectId = id(70), stop = failed(tracked(1, { kind: "projectRemoval", projectId }));
    const next = transitionConfigurationDesired({ ...empty(), currentItems: [stop] }, desired("2", [projectId]), "herdr", new Set(), ids());
    expect(next.retainedItems).toContainEqual(stop);
    expect(findCurrentConfigurationItem(next, { kind: "projectRemoval", projectId })).toBeUndefined();
    expect(projectConfigurationReport(next, options).failures).toEqual([]);
  });

  it("verifies a historical applied-plus-started stop before retiring its original bits", () => {
    const projectId = id(70), stop = { ...tracked(1, { kind: "projectRemoval", projectId }, true), started: true };
    const next = transitionConfigurationDesired({ ...empty(), currentItems: [stop] }, desired("2", [projectId]), "herdr", new Set(), ids());
    const verification = findCurrentConfigurationItem(next, { kind: "projectRemoval", projectId })!;
    expect(verification).toMatchObject({ blockedByRemovalId: stop.recordId, value: { state: "pending" } });
    expect(next.retainedItems).toContainEqual(stop);
    const verified = { ...next, currentItems: next.currentItems.map(item => item === verification ? { ...item, value: { ...item.value, state: "applied" as const, appliedValue: true as const } } : item) };
    const acknowledged = acceptConfigurationProjection(verified, projectConfigurationReport(verified, options), new Set());
    expect(allConfigurationItems(acknowledged).some(item => item.recordId === stop.recordId)).toBe(false);
    expect(findCurrentConfigurationItem(acknowledged, { kind: "projectRemoval", projectId })).toBeUndefined();
    expect(stop.started).toBe(true);
  });

  it("preserves real values and unfinished failures when the target becomes null", () => {
    const value = tracked(1, { kind: "native" }, native), stop = { ...failed(tracked(2, { kind: "projectRemoval", projectId: id(70) })), started: true };
    const next = transitionConfigurationDesired({ ...empty(), currentItems: [value, stop] }, null, "herdr", new Set(), ids());
    expect(next.authority.desired).toBeNull();
    expect(next.currentItems).toEqual([]);
    expect(next.retainedItems).toEqual([value, stop]);
    expect(projectConfigurationReport(next, options).report.observation).toBeNull();
  });

  it("does not manufacture runtime native authority from durable applied text", () => {
    const item = tracked(1, { kind: "native" }, native), cache = { ...empty(), currentItems: [item] };
    expect(configurationSnapshot(cache, true, new Map(), "herdr", options.localTools, valueProof).effective.native).toBeNull();
    expect(configurationSnapshot(cache, true, new Map([[item.recordId, valueProof(cache, native, "herdr")]]), "herdr", options.localTools, valueProof).effective.native).toEqual(native);
    expect(configurationSnapshot(cache, false, new Map([[item.recordId, valueProof(cache, native, "herdr")]]), "herdr", options.localTools, valueProof).effective.native).toBeNull();
  });
});

const valueProof = (_cache: WorkerConfigurationCache, value: WorkerCloudNative, mode: "herdr" | "web"): WorkerNativeProof => ({ native: value, mode, tools: [] });

describe("Worker configuration projection acceptance", () => {
  it("reports the newest same-key failure and acknowledges only its immutable source token", () => {
    const current = tracked(1, { kind: "native" }, native), older = failed(tracked(2, { kind: "native" }, native), 1), newer = failed(tracked(3, { kind: "native" }, native), 2, "2026-11-12T00:00:02Z");
    const cache = { ...empty(), currentItems: [current], retainedItems: [older, newer] };
    const projection = projectConfigurationReport(cache, options);
    expect(projection.failures).toEqual([{ sourceRecordId: newer.recordId, failureId: 2 }]);
    expect(projection.report.observation!.items[0]!.lastFailure?.occurredAt).toBe(newer.value.lastFailure!.occurredAt);
    const accepted = acceptConfigurationProjection(cache, projection, new Set());
    expect(accepted.retainedItems).toEqual([older]);
    expect(projectConfigurationReport(accepted, options).failures).toEqual([{ sourceRecordId: older.recordId, failureId: 1 }]);
    expect(current.failureId).toBeNull();
  });

  it("keeps failures without a legitimate current carrier local", () => {
    const failure = failed(tracked(2, { kind: "projectNative", projectId: id(70) }, native));
    const cache = { ...empty(), currentItems: [tracked(1, { kind: "maxConcurrent" }, 2)], retainedItems: [failure] };
    const projection = projectConfigurationReport(cache, options);
    expect(projection.failures).toEqual([]);
    expect(acceptConfigurationProjection(cache, projection, new Set()).retainedItems).toEqual([failure]);
  });

  it("does not clear a newer failure on the same record with an older captured acknowledgement", () => {
    const original = failed(tracked(1, { kind: "native" }, native), 1), cache = { ...empty(), currentItems: [original] };
    const projection = projectConfigurationReport(cache, options);
    const updated = failed(original, 2, "2026-11-12T00:00:02Z");
    const accepted = acceptConfigurationProjection({ ...cache, currentItems: [updated] }, projection, new Set());
    expect(accepted.currentItems[0]!.failureId).toBe(2);
    expect(accepted.currentItems[0]!.value.lastFailure).toEqual(updated.value.lastFailure);
  });

  it("rejects an old generation acknowledgement without retiring its exact source failure or advancing the cursor", () => {
    const original = failed(tracked(1, { kind: "native" }, native)), cache = { ...empty(), currentItems: [original] };
    const projection = projectConfigurationReport(cache, options);
    const changed = { ...cache, authority: { ...cache.authority, generation: id(8001) }, projectionCursor: id(90), currentItems: [], retainedItems: [original] };
    const accepted = acceptConfigurationProjection(changed, projection, new Set());
    expect(accepted.projectionCursor).toBe(id(90));
    expect(accepted).toBe(changed);
    expect(allConfigurationItems(accepted).some(item => item.failureId !== null)).toBe(true);
  });

  it("retains completed stop ownership until the exact applied carrier is accepted and joined", () => {
    const stop = tracked(1, { kind: "projectRemoval", projectId: id(70) }, true), cache = { ...empty(), currentItems: [stop] };
    const projection = projectConfigurationReport(cache, options);
    expect(acceptConfigurationProjection(cache, projection, new Set([stop.recordId])).currentItems).toEqual([stop]);
    expect(acceptConfigurationProjection(cache, projection, new Set()).currentItems).toEqual([]);
  });
});
