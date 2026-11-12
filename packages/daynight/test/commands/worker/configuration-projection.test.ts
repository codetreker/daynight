import { describe, expect, it } from "vitest";
import type { WorkerCloudDesired, WorkerCloudItemKey, WorkerCloudNative } from "../../../src/api/worker-configuration.js";
import type { WorkerReport } from "../../../src/api/types.js";
import { prepareWorkerReport, WORKER_CONFIGURATION_REPORT_BYTES } from "../../../src/api/worker-report.js";
import type { TrackedConfigurationItem, WorkerConfigurationCache } from "../../../src/commands/worker/configuration-model.js";
import { acceptConfigurationProjection, projectConfigurationReport } from "../../../src/commands/worker/configuration-state.js";
import { workerTelemetry } from "../../fixtures/worker-telemetry.js";

const id = (value: number): string => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const native: WorkerCloudNative = { agent: "codex", model: "original", args: [] };
const desired: WorkerCloudDesired = { revision: "1", updatedAt: "2026-11-12T00:00:00Z", value: { maxConcurrent: 2, pollIntervalMs: 1200, recoveryLimit: 3, preferPlatformSpecificTasks: false, native, projects: [] } };
const tracked = (number: number, key: WorkerCloudItemKey, appliedValue: TrackedConfigurationItem["value"]["appliedValue"] = null): TrackedConfigurationItem => ({ recordId: id(number), origin: { generation: id(8000), targetRevision: "1", source: "application" }, value: { key, targetRevision: "1", appliedValue, state: appliedValue === null ? "pending" : "applied", error: null, lastFailure: null, nextAttemptAt: null }, backoffStep: 0, failureId: null, started: false, nativeMode: key.kind === "native" || key.kind === "projectNative" ? "herdr" : null, actualSource: appliedValue === null ? null : { kind: "observed", recordId: id(number), generation: id(8000), targetRevision: "1" }, blockedByRemovalId: null });
const cache = (currentItems: readonly TrackedConfigurationItem[]): WorkerConfigurationCache => ({ schemaVersion: 5, identity: { serverOrigin: "https://daynight.example", userId: id(9000), workerId: id(9001) }, authority: { generation: id(8000), desired, observationRevision: "0" }, nextFailureId: 100, projectionCursor: null, currentItems, retainedItems: [] });
const options = { synchronized: true, localMode: "herdr" as const, localTools: { codex: { kind: "auto" as const }, copilot: { kind: "auto" as const }, herdr: { kind: "auto" as const } }, bootstrap: null };

describe("Worker configuration bounded report projection", () => {
  it("rotates a saturated observation after exact acceptance and preserves every local record", () => {
    const items = Array.from({ length: 1100 }, (_, index) => tracked(index + 1, { kind: "projectRemoval", projectId: id(2000 + index) }));
    const original = cache(items), first = projectConfigurationReport(original, options);
    expect(first.recordIds).toHaveLength(1025);
    expect(first.nextCursor).toBe(id(1025));
    expect(original.currentItems).toHaveLength(1100);
    expect(projectConfigurationReport(original, options).recordIds).toEqual(first.recordIds);
    const reopened = structuredClone(acceptConfigurationProjection(original, first, new Set()));
    const second = projectConfigurationReport(reopened, options);
    expect(second.recordIds.slice(0, 76)).toEqual([id(1), ...Array.from({ length: 75 }, (_, index) => id(1026 + index))]);
    expect(new Set([...first.recordIds, ...second.recordIds]).size).toBe(1100);
    expect(reopened.currentItems).toHaveLength(1100);
  });

  it("caps non-mode items independently when the 1026th slot carries control-mode evidence", () => {
    const removals = Array.from({ length: 1100 }, (_, index) => tracked(index + 1, { kind: "projectRemoval", projectId: id(3000 + index) }));
    const original = { ...cache([...removals, tracked(2000, { kind: "agentControlMode" }, "web")]), authority: { ...cache([]).authority, desired: { ...desired, value: { ...desired.value, agentControlMode: "web" as const } } }, projectionCursor: id(1100) };
    const projected = projectConfigurationReport(original, options);
    expect(projected.recordIds).toHaveLength(1026);
    expect(projected.report.observation!.items.filter(item => item.key.kind !== "agentControlMode")).toHaveLength(1025);
    expect(projected.report.observation!.items.some(item => item.key.kind === "agentControlMode")).toBe(true);
  });

  it("keeps the first oversized prefix candidate as the next batch start without skipping it for small items", () => {
    const large: WorkerCloudNative = { ...native, args: Array.from({ length: 128 }, () => "<".repeat(4096)) };
    const items = [tracked(1, { kind: "maxConcurrent" }, 2), tracked(2, { kind: "projectNative", projectId: id(70) }, large), tracked(3, { kind: "projectNative", projectId: id(71) }, large), tracked(4, { kind: "projectRemoval", projectId: id(72) }), tracked(5, { kind: "recoveryLimit" }, 3)];
    const original = cache(items), first = projectConfigurationReport(original, options);
    expect(first.recordIds).toEqual([id(4), id(1), id(2)]);
    expect(first.nextCursor).toBe(id(2));
    const second = projectConfigurationReport(acceptConfigurationProjection(original, first, new Set()), options);
    expect(second.recordIds).toContain(id(3));
    expect(second.recordIds[1]).toBe(id(3));
    expect(original.currentItems).toEqual(items);
  });

  it("counts Go HTML and line-separator escaping rather than only shorter JavaScript encoding", () => {
    const large: WorkerCloudNative = { ...native, args: Array.from({ length: 128 }, () => "<>&\u2028\u2029".repeat(256)) };
    const original = cache(Array.from({ length: 5 }, (_, index) => tracked(index + 1, { kind: "projectNative", projectId: id(70 + index) }, large)));
    const projected = projectConfigurationReport(original, options);
    // Each argument encodes as 256 groups of five six-byte Go Unicode escapes.
    expect(projected.report.observation!.items).toHaveLength(4);
    expect(Buffer.byteLength(JSON.stringify({ ...projected.report.observation, items: original.currentItems.map(item => item.value) }), "utf8")).toBeLessThan(4 * 1_048_576);
    expect(projected.nextCursor).toBe(id(4));
  });

  it("reserves the storage wrapper at the exact encoded boundary and defers one byte above", () => {
    const argument = "<".repeat(4096);
    const first = tracked(1, { kind: "projectNative", projectId: id(70) }, { ...native, args: Array.from({ length: 128 }, () => argument) });
    const secondNative = { ...native, args: Array.from({ length: 42 }, () => argument) };
    const second = tracked(2, { kind: "projectNative", projectId: id(71) }, secondNative);
    const observation = { baseRevision: "0", desiredRevision: "1", items: [first.value, second.value] };
    const encoded = JSON.stringify(observation).replaceAll("<", "\\u003c");
    const remaining = 4 * 1_048_576 - 512 - Buffer.byteLength(encoded, "utf8");
    const additional = Math.ceil(remaining / 4099);
    let content = remaining - 3 * additional;
    const padding = Array.from({ length: additional }, () => { const size = Math.min(content, 4096); content -= size; return "x".repeat(size); });
    expect(padding.at(-1)!.length).toBeLessThan(4096);
    const exact = { ...second, value: { ...second.value, appliedValue: { ...secondNative, args: [...secondNative.args, ...padding] } } };
    const exactObservation = { ...observation, items: [first.value, exact.value] };
    expect(Buffer.byteLength(JSON.stringify(exactObservation).replaceAll("<", "\\u003c"), "utf8") + 512).toBe(4 * 1_048_576);
    expect(projectConfigurationReport(cache([first, exact]), options).recordIds).toEqual([first.recordId, second.recordId]);
    const over = { ...exact, value: { ...exact.value, appliedValue: { ...secondNative, args: [...secondNative.args, ...padding.slice(0, -1), `${padding.at(-1)!}x`] } } };
    expect(projectConfigurationReport(cache([first, over]), options).recordIds).toEqual([first.recordId]);
  });

  it("always includes the most severe real unfinished removal before the rotating prefix", () => {
    const pending = tracked(3, { kind: "projectRemoval", projectId: id(73) });
    const active = { ...tracked(4, { kind: "projectRemoval", projectId: id(74) }), started: true, value: { ...pending.value, key: { kind: "projectRemoval" as const, projectId: id(74) }, state: "applying" as const } };
    const failure = { code: "unavailable" as const, category: "runtime" as const, phase: "stop" as const, occurredAt: "2026-11-12T00:00:01Z" };
    const error = { ...tracked(5, { kind: "projectRemoval", projectId: id(75) }), failureId: 1, value: { ...pending.value, key: { kind: "projectRemoval" as const, projectId: id(75) }, state: "error" as const, error: failure, lastFailure: failure, nextAttemptAt: "2026-11-12T00:00:10Z" } };
    const projected = projectConfigurationReport({ ...cache([tracked(1, { kind: "maxConcurrent" }, 2), pending, active, error]), projectionCursor: id(4) }, options);
    expect(projected.recordIds[0]).toBe(error.recordId);
    expect(projected.report.observation!.items[0]!.state).toBe("error");
  });

  it("prioritizes a pending current carrier by its retained original stop error without rewriting the wire state", () => {
    const failure = { code: "unavailable" as const, category: "runtime" as const, phase: "stop" as const, occurredAt: "2026-11-12T00:00:01Z" };
    const original = { ...tracked(50, { kind: "projectRemoval", projectId: id(70) }), started: true, failureId: 1, value: { ...tracked(50, { kind: "projectRemoval", projectId: id(70) }).value, state: "error" as const, error: failure, lastFailure: failure, nextAttemptAt: "2026-11-12T00:00:10Z" } };
    const carrier = { ...tracked(10, { kind: "projectRemoval", projectId: id(70) }), blockedByRemovalId: original.recordId };
    const pending = tracked(1, { kind: "projectRemoval", projectId: id(71) });
    const projected = projectConfigurationReport({ ...cache([pending, carrier]), retainedItems: [original] }, options);
    expect(projected.recordIds[0]).toBe(carrier.recordId);
    expect(projected.report.observation!.items[0]).toMatchObject({ state: "pending", error: null, lastFailure: failure });
    expect(projected.failures).toEqual([{ sourceRecordId: original.recordId, failureId: 1 }]);
  });

  it("uses a deleted cursor identity as a stable lexical position", () => {
    const original = { ...cache([tracked(1, { kind: "maxConcurrent" }, 2), tracked(3, { kind: "recoveryLimit" }, 3)]), projectionCursor: id(2) };
    expect(projectConfigurationReport(original, options).recordIds).toEqual([id(3), id(1)]);
  });

  it("admits a complete native value when request preparation can omit optional telemetry", () => {
    const large = { ...native, args: Array.from({ length: 128 }, () => "\\".repeat(4096)) };
    const telemetry: WorkerReport = { ...workerTelemetry, taskInventory: null, workingDirectory: "x".repeat(1_048_576), runtimeConfiguration: { schemaVersion: 1, native: { agent: "codex", model: { value: "x".repeat(7.5 * 1_048_576), source: "cloud" }, reasoningEffort: { value: null, source: "native" } }, projects: [] } };
    const projected = projectConfigurationReport(cache([tracked(1, { kind: "native" }, large)]), { ...options, telemetry });
    expect(projected.report.observation!.items[0]!.appliedValue).toEqual(large);
    const prepared = prepareWorkerReport({ ...telemetry, configuration: projected.report }, WORKER_CONFIGURATION_REPORT_BYTES).value;
    expect(prepared.runtimeConfiguration).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(prepared), "utf8")).toBeLessThanOrEqual(WORKER_CONFIGURATION_REPORT_BYTES);
  });

  it("refuses mandatory request content over budget before inventing an empty observation", () => {
    const telemetry: WorkerReport = { ...workerTelemetry, taskInventory: null, workingDirectory: "x".repeat(WORKER_CONFIGURATION_REPORT_BYTES) };
    expect(() => projectConfigurationReport(cache([tracked(1, { kind: "maxConcurrent" }, 2)]), { ...options, telemetry })).toThrow("required content exceeds");
  });

  it("leaves an unrepresentable structural historical value local until it is replaced by a valid actual value", () => {
    const historical = tracked(1, { kind: "native" }, { ...native, args: Array.from({ length: 129 }, () => "old") });
    const original = cache([historical]);
    expect(projectConfigurationReport(original, options).recordIds).toEqual([]);
    expect(original.currentItems).toEqual([historical]);
    expect(projectConfigurationReport({ ...original, currentItems: [{ ...historical, value: { ...historical.value, appliedValue: native } }] }, options).recordIds).toEqual([historical.recordId]);
  });

  it("exposes a malformed current record instead of treating it as omitted structural history", () => {
    const invalid = { ...tracked(1, { kind: "native" }, native), value: { ...tracked(1, { kind: "native" }, native).value, state: "error" as const } };
    expect(() => projectConfigurationReport(cache([invalid]), options)).toThrow();
  });
});
