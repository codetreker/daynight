import { describe, expect, it } from "vitest";
import { receiveWorkerDesired } from "../../../src/api/worker-configuration-source.js";
import { parseWorkerCloudReport, projectWorkerCloudReport } from "../../../src/api/worker-configuration.js";
import type { WorkerCloudDesired, WorkerCloudFailure, WorkerCloudItemKey, WorkerCloudNative } from "../../../src/api/worker-configuration.js";
import type { TrackedConfigurationItem, WorkerConfigurationCache, WorkerNativeProof } from "../../../src/commands/worker/configuration-model.js";
import { acceptConfigurationProjection, allConfigurationItems, configurationHasUnfinishedRemoval, configurationSnapshot, configurationTarget, findCurrentConfigurationItem, projectConfigurationReport, pruneConfigurationRetained, transitionConfigurationDesired } from "../../../src/commands/worker/configuration-state.js";

const id = (value: number): string => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const native: WorkerCloudNative = { agent: "codex", model: "original", args: [] };
const desired = (revision = "1", projects: readonly string[] = []): WorkerCloudDesired => ({ revision, updatedAt: "2026-11-12T00:00:00Z", value: { toolPaths: { codex: { kind: "auto" }, copilot: { kind: "auto" } }, maxConcurrent: Number(revision) + 1, pollIntervalMs: 1200, recoveryLimit: 3, preferPlatformSpecificTasks: false, native, projects: projects.map(projectId => ({ projectId, nativeOverrides: {} })) } });
const empty = (target: WorkerCloudDesired | null = desired()): WorkerConfigurationCache => ({ schemaVersion: 10, identity: { serverOrigin: "https://daynight.example", userId: id(9000), workerId: id(9001) }, authority: { generation: id(8000), desiredJson: target === null ? null : JSON.stringify(target), applicationRevision: target?.revision ?? null, observationRevision: "0", pendingApplication: target === null }, remoteObservation: null, nextFailureId: 100, projectionCursor: null, currentItems: [], retainedItems: [] });
const received = (...args: Parameters<typeof desired>) => receiveWorkerDesired(JSON.stringify(desired(...args)));
const tracked = (number: number, key: WorkerCloudItemKey, appliedValue: TrackedConfigurationItem["value"]["appliedValue"] = null): TrackedConfigurationItem => ({ recordId: id(number), origin: { generation: id(8000), targetRevision: "1", source: "application" }, value: { key, targetRevision: "1", appliedValue, state: appliedValue === null ? "pending" : "applied", error: null, lastFailure: null, nextAttemptAt: null }, backoffStep: 0, failureId: null, started: false, actualSource: appliedValue === null ? null : { kind: "observed", recordId: id(number), generation: id(8000), targetRevision: "1" }, blockedByRemovalId: null });
const fault: WorkerCloudFailure = { code: "unavailable", category: "agent", phase: "validate", occurredAt: "2026-11-12T00:00:01Z" };
const failed = (item: TrackedConfigurationItem, failureId = 1, occurredAt = fault.occurredAt): TrackedConfigurationItem => ({ ...item, failureId, value: { ...item.value, state: "error", error: { ...fault, occurredAt }, lastFailure: { ...fault, occurredAt }, nextAttemptAt: "2026-11-12T00:00:10Z" }, backoffStep: 1 });
const options = { synchronized: true, localTools: { codex: { kind: "auto" as const }, copilot: { kind: "auto" as const }, herdr: { kind: "auto" as const } }, bootstrap: null };
const ids = () => { let value = 1000; return () => id(value++); };

describe("Worker configuration fact transitions", () => {
  it("requires a synchronized supported target without reporting mode adoption", () => {
    const pending = transitionConfigurationDesired(empty(null), received(), new Set(), ids());
    expect(findCurrentConfigurationItem(pending, { kind: "agentControlMode" })).toBeUndefined();
    expect(configurationSnapshot(pending, true, new Map(), options.localTools, valueProof).effective.agentControlMode).toBe("web");
    expect(configurationSnapshot(pending, false, new Map(), options.localTools, valueProof).effective.agentControlMode).toBeNull();
    const unsupported = transitionConfigurationDesired(pending, receiveWorkerDesired(JSON.stringify({ ...desired("2"), value: { ...desired("2").value, agentControlMode: "herdr" } })), new Set(), ids());
    expect(configurationSnapshot(unsupported, true, new Map(), options.localTools, valueProof).effective.agentControlMode).toBeNull();
  });

  it.each(["empty", "applied A"] as const)("rebuilds newly understood same-revision authority B from an %s ledger", state => {
    const oldProject = id(70), nextProject = id(71), nextId = ids();
    let original = empty(null);
    if (state === "applied A") {
      const built = transitionConfigurationDesired(original, received("1", [oldProject]), new Set(), nextId);
      original = { ...built, currentItems: built.currentItems.map(item => {
        const appliedValue = configurationTarget(built, item.value.key);
        return { ...item, value: { ...item.value, state: "applied" as const, appliedValue }, actualSource: { kind: "observed" as const, recordId: item.recordId, generation: item.origin.generation, targetRevision: item.origin.targetRevision } };
      }) };
    }
    const oldReport = projectConfigurationReport(original, options);
    const understood = received("2", [nextProject]);
    const pending = transitionConfigurationDesired(original, { ...understood, known: null }, new Set(), nextId);
    expect(pending.authority).toMatchObject({ desiredJson: understood.json, applicationRevision: original.authority.applicationRevision, pendingApplication: true });
    expect(pending.currentItems).toEqual(original.currentItems);
    expect(projectConfigurationReport(pending, options).report.observation).toBeNull();
    const rebuilt = transitionConfigurationDesired(pending, understood, new Set(), nextId);
    expect(rebuilt.authority).toMatchObject({ desiredJson: understood.json, applicationRevision: "2", pendingApplication: false });
    expect(rebuilt.authority.generation).not.toBe(pending.authority.generation);
    expect(findCurrentConfigurationItem(rebuilt, { kind: "projectPreparation", projectId: nextProject })).toMatchObject({ value: { targetRevision: "2", state: "pending" } });
    if (state === "applied A") expect(findCurrentConfigurationItem(rebuilt, { kind: "projectRemoval", projectId: oldProject })).toBeDefined();
    expect(acceptConfigurationProjection(rebuilt, oldReport, new Set())).toBe(rebuilt);
    const unknownOnly = receiveWorkerDesired(understood.json.replace('"revision":"2"', '"revision":"3"').replace('"maxConcurrent":3', '"maxConcurrent":3,"future":{"new":true}'));
    const updated = transitionConfigurationDesired(rebuilt, unknownOnly, new Set(), nextId);
    expect(updated.authority.generation).toBe(rebuilt.authority.generation);
    expect(updated.authority.applicationRevision).toBe("2");
    expect(updated.currentItems).toEqual(rebuilt.currentItems);
    expect(updated.authority.desiredJson).toBe(unknownOnly.json);
    expect(acceptConfigurationProjection(updated, oldReport, new Set())).toBe(updated);
  });

  it.each(["unsupported mode", "oversized target"] as const)("keeps existing work while %s is unreadable for application", scenario => {
    const selected = id(70), removing = id(71), unrelated = id(72);
    const currentTarget = desired("1", [selected]);
    const preparation = tracked(1, { kind: "projectPreparation", projectId: selected }, true);
    const appliedNative = tracked(2, { kind: "native" }, native);
    const stop = { ...tracked(3, { kind: "projectRemoval", projectId: removing }), started: true };
    const original = { ...empty(currentTarget), currentItems: [preparation, appliedNative, stop], projectionCursor: id(1) };
    const raw = desired("2", [unrelated]);
    const invalid = { ...raw, value: { ...raw.value, ...(scenario === "unsupported mode" ? { agentControlMode: "herdr" as const } : { maxConcurrent: 65 }) } };
    const nextId = ids();
    const next = transitionConfigurationDesired(original, receiveWorkerDesired(JSON.stringify(invalid)), new Set([stop.recordId]), nextId);
    expect(JSON.parse(next.authority.desiredJson!)).toEqual(invalid);
    expect(next.authority.generation).not.toBe(original.authority.generation);
    expect(next.authority.applicationRevision).toBe("1");
    expect(next.projectionCursor).toBeNull();
    expect(next.currentItems).toEqual(original.currentItems);
    const proof = new Map([[appliedNative.recordId, valueProof(next, native)]]);
    const snapshot = configurationSnapshot(next, true, proof, options.localTools, valueProof);
    expect(snapshot.selectedProjects).toBeNull();
    expect(snapshot.toolTargets).toBeNull();
    expect(snapshot.effective.native).toBeNull();
    expect(projectConfigurationReport(next, options).report.observation).toBeNull();
    const restored = transitionConfigurationDesired(next, received("3", [selected]), new Set([stop.recordId]), nextId);
    expect(allConfigurationItems(restored)).toContainEqual(stop);
    expect(allConfigurationItems(restored).some(item => item.value.key.kind === "projectRemoval" && item.value.key.projectId === unrelated)).toBe(false);
    expect(findCurrentConfigurationItem(restored, { kind: "projectPreparation", projectId: selected })?.value.appliedValue).toBe(true);
  });

  it("retains the confirmed archive setting when the server omits its capability", () => {
    const withArchive = { ...desired(), value: { ...desired().value, archiveSessions: false } };
    const applied = tracked(1, { kind: "archiveSessions" }, false);
    const original = { ...empty(withArchive), currentItems: [applied] };
    const legacy = transitionConfigurationDesired(original, received("2"), new Set(), ids());
    expect(legacy.retainedItems).toContainEqual(applied);
    expect(configurationSnapshot(legacy, true, new Map(), options.localTools, valueProof).effective.archiveSessions).toBe(false);
    expect(configurationSnapshot(legacy, false, new Map(), options.localTools, valueProof).effective.archiveSessions).toBeNull();
    expect(configurationSnapshot(legacy, false, new Map(), options.localTools, valueProof).retainedArchiveSessions).toBe(false);
    const pristine = transitionConfigurationDesired(empty(null), received("2"), new Set(), ids());
    expect(configurationSnapshot(pristine, true, new Map(), options.localTools, valueProof).effective.archiveSessions).toBe(true);
    expect(configurationSnapshot(pristine, false, new Map(), options.localTools, valueProof).retainedArchiveSessions).toBe(true);
    const restored = transitionConfigurationDesired(legacy, receiveWorkerDesired(JSON.stringify({ ...withArchive, revision: "3" })), new Set(), ids());
    expect(findCurrentConfigurationItem(restored, { kind: "archiveSessions" })?.value).toMatchObject({ state: "applied", appliedValue: false });
  });

  it("retains only an actual archive value before synchronization, including pending targets", () => {
    const configured = { ...desired(), value: { ...desired().value, archiveSessions: false } };
    const fresh = transitionConfigurationDesired(empty(null), receiveWorkerDesired(JSON.stringify(configured)), new Set(), ids());
    expect(configurationSnapshot(empty(null), false, new Map(), options.localTools, valueProof).retainedArchiveSessions).toBeNull();
    expect(configurationSnapshot(fresh, false, new Map(), options.localTools, valueProof).retainedArchiveSessions).toBeNull();
    const previouslyTrue = { ...empty(configured), currentItems: [tracked(4, { kind: "archiveSessions" }, true)] };
    expect(configurationSnapshot(previouslyTrue, false, new Map(), options.localTools, valueProof).retainedArchiveSessions).toBe(true);
    const hidden = transitionConfigurationDesired(fresh, received("2"), new Set(), ids());
    expect(hidden.hiddenCapabilitySources?.archiveSessions).toBeDefined();
    expect(configurationSnapshot(hidden, true, new Map(), options.localTools, valueProof).effective.archiveSessions).toBeNull();
    expect(configurationSnapshot(hidden, false, new Map(), options.localTools, valueProof).retainedArchiveSessions).toBeNull();
  });

  it("creates new current identities without rewriting an observed source or copying failure ownership", () => {
    const original = failed(tracked(1, { kind: "native" }, native));
    const cache = { ...empty(), currentItems: [original] };
    const next = transitionConfigurationDesired(cache, received("2"), new Set(), ids());
    const current = findCurrentConfigurationItem(next, { kind: "native" })!;
    expect(current.recordId).not.toBe(original.recordId);
    expect(current.origin).toEqual({ generation: next.authority.generation, targetRevision: "2", source: "application" });
    expect(current.actualSource).toEqual(original.actualSource);
    expect(current.failureId).toBeNull();
    expect(current.value.lastFailure).toBeNull();
    expect(next.retainedItems).toContainEqual(original);
    expect(configurationSnapshot(next, true, new Map(), options.localTools, valueProof).items.find(item => item.key.kind === "native")?.lastFailure).toEqual(fault);
    expect(original.origin.targetRevision).toBe("1");
  });

  it("retains a running old stop and blocks new stop verification and preparation for a reselected project", () => {
    const projectId = id(70), stop = { ...tracked(1, { kind: "projectRemoval", projectId }), started: true, value: { ...tracked(1, { kind: "projectRemoval", projectId }).value, state: "applying" as const } };
    const next = transitionConfigurationDesired({ ...empty(), currentItems: [stop] }, received("2", [projectId]), new Set([stop.recordId]), ids());
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
      current = transitionConfigurationDesired(current, received(String(revision), [projectId]), new Set([original.recordId]), newId);
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
    const next = transitionConfigurationDesired({ ...empty(), currentItems: [stop] }, received("2", [projectId]), new Set(), ids());
    expect(next.retainedItems).toContainEqual(stop);
    expect(findCurrentConfigurationItem(next, { kind: "projectRemoval", projectId })).toBeUndefined();
    expect(projectConfigurationReport(next, options).failures).toEqual([]);
  });

  it("verifies a historical applied-plus-started stop before retiring its original bits", () => {
    const projectId = id(70), stop = { ...tracked(1, { kind: "projectRemoval", projectId }, true), started: true };
    const next = transitionConfigurationDesired({ ...empty(), currentItems: [stop] }, received("2", [projectId]), new Set(), ids());
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
    const next = transitionConfigurationDesired({ ...empty(), currentItems: [value, stop] }, null, new Set(), ids());
    expect(next.authority.desiredJson).toBeNull();
    expect(next.currentItems).toEqual([]);
    expect(next.retainedItems).toEqual([value, stop]);
    expect(projectConfigurationReport(next, options).report.observation).toBeNull();
  });

  it("does not manufacture runtime native authority from durable applied text", () => {
    const item = tracked(1, { kind: "native" }, native), cache = { ...empty(), currentItems: [item] };
    expect(configurationSnapshot(cache, false, new Map(), options.localTools, valueProof).retainedRecoveryLimit).toBeNull();
    expect(configurationSnapshot(cache, false, new Map(), options.localTools, valueProof).toolTargets).toBeNull();
    expect(configurationSnapshot(cache, true, new Map(), options.localTools, valueProof).effective.native).toBeNull();
    expect(configurationSnapshot(cache, true, new Map([[item.recordId, valueProof(cache, native)]]), options.localTools, valueProof).effective.native).toEqual(native);
    expect(configurationSnapshot(cache, false, new Map([[item.recordId, valueProof(cache, native)]]), options.localTools, valueProof).effective.native).toBeNull();
  });
});

const valueProof = (_cache: WorkerConfigurationCache, value: WorkerCloudNative): WorkerNativeProof => ({ native: value, tools: [] });

describe("Worker configuration projection acceptance", () => {
  it("does not report mode or adopt tools for unsupported raw authority", () => {
    const base = desired();
    for (const value of [{ ...base.value, agentControlMode: "herdr" }, { ...base.value, toolPaths: { ...base.value.toolPaths!, herdr: null } }, (({ toolPaths: _tools, ...rest }) => rest)(base.value)]) {
      const cache = empty({ ...base, value } as WorkerCloudDesired), raw = cache.authority.desiredJson;
      const report = projectConfigurationReport(cache, options).report;
      expect(report).not.toHaveProperty("controlModeBootstrap");
      expect(report.toolPathsBootstrap).toBeNull();
      expect(report.observation).toBeNull();
      expect(cache.authority.desiredJson).toBe(raw);
    }
  });

  it("uses the complete two-tool bootstrap candidate", () => {
    const candidate = { ...desired().value, toolPaths: { codex: { kind: "path" as const, path: "/candidate/codex" }, copilot: { kind: "auto" as const } } };
    const report = projectConfigurationReport(empty(null), { ...options, bootstrap: candidate }).report;
    expect(parseWorkerCloudReport(report, { controlMode: false, toolPaths: true, archiveSessions: false })).toMatchObject({ bootstrap: candidate, toolPathsBootstrap: candidate.toolPaths });
  });

  it("adopts unselected Web tool choices without changing raw authority", () => {
    const base = desired(), copilot = { kind: "path" as const, path: "/cloud/copilot" };
    const cache = empty({ ...base, value: { ...base.value, toolPaths: { codex: null, copilot } } }), raw = cache.authority.desiredJson;
    const report = projectConfigurationReport(cache, options).report;
    expect(report.toolPathsBootstrap).toEqual({ codex: options.localTools.codex, copilot });
    expect(cache.authority.desiredJson).toBe(raw);
  });

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
