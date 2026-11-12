import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../src/api/client.js";
import { stringifyApiJson } from "../../src/api/json.js";
import { createOperation } from "../../src/api/operation.js";
import type { Operation } from "../../src/api/operation.js";
import type { WorkerRuntimeConfiguration } from "../../src/api/types.js";
import type { WorkerCloudItem, WorkerCloudReport, WorkerCloudValue } from "../../src/api/worker-configuration.js";
import type { ToolPathActual, ToolPathObservation, ToolPathTelemetry } from "../../src/api/worker-tool-paths.js";
import { workerTelemetry } from "../fixtures/worker-telemetry.js";

const workerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const time = "2026-11-04T00:00:00.123456789Z";
const value: WorkerCloudValue = { maxConcurrent: 2, pollIntervalMs: 60_000, recoveryLimit: 3, preferPlatformSpecificTasks: false, native: { agent: "codex", model: null, args: [] }, projects: [] };
const desired = { revision: "1", updatedAt: time, value };
const item: WorkerCloudItem = { key: { kind: "maxConcurrent" }, targetRevision: "1", appliedValue: 2, state: "applied", error: null, lastFailure: null, nextAttemptAt: null };
const configuration: WorkerCloudReport = { bootstrap: null, observation: { baseRevision: "0", desiredRevision: "1", items: [item] } };
const report = { ...workerTelemetry, taskInventory: null };
const receipt = { observedAt: time, lastReportedAt: time, configuration: { desired, observationRevision: "1", observationAccepted: true } };
const operations: Operation[] = [];
const api = (fetch: typeof globalThis.fetch) => { const operation = createOperation(); operations.push(operation); return createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", expectedUserId: userId, operation, fetch }); };
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Daynight-User-ID": userId, "Daynight-Worker-Configuration": "1" } });
afterEach(() => { operations.splice(0).forEach(operation => operation.dispose()); vi.restoreAllMocks(); });

const actual = (): ToolPathActual => ({ selection: { kind: "path", path: "/opt/codex" }, selectionKey: "a".repeat(64), entryPath: "/opt/codex", executablePath: "/opt/codex", interpreterPath: null, source: "explicit", version: "1.2.3", checkedAt: time });
const entry = (): ToolPathObservation => ({ tool: "codex", context: "web", configurationSource: "cloud", targetRevision: "1", target: { kind: "path", path: "/opt/codex" }, state: "applied", reason: null, actual: actual(), candidate: null, activeSelectionCount: 0, activeSelectionsComplete: true, activeObservationError: null, activeSelections: [], error: null });
const telemetry = (): ToolPathTelemetry => ({ schemaVersion: 1, observedAt: time, entries: [entry()] });

describe("Worker configuration report body capacity", () => {
  it("sends a complete legal escaped native result larger than the old limit", async () => {
    const native = { agent: "codex" as const, model: null, args: Array(128).fill("\\".repeat(4096)) };
    const applied = { ...item, key: { kind: "native" as const }, appliedValue: native };
    const input: WorkerCloudReport = { bootstrap: null, observation: { baseRevision: "0", desiredRevision: "1", items: [applied] } };
    expect(Buffer.byteLength(stringifyApiJson(applied))).toBeGreaterThan(1_048_576);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(receipt));
    await expect(api(fetch).reportWorkerConfiguration(workerId, report, input)).resolves.toEqual(receipt);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).configuration).toEqual(input);
  });
  it("rejects an oversized complete observation at the body envelope without dropping applied values", async () => {
    const native = { agent: "codex" as const, model: null, args: Array(128).fill("x".repeat(4096)) };
    const input: WorkerCloudReport = { bootstrap: null, observation: { baseRevision: "0", desiredRevision: "1", items: Array.from({ length: 19 }, (_, n) => ({ ...item, key: { kind: "projectNative" as const, projectId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` }, appliedValue: native })) } };
    const before = JSON.stringify(input), fetch = vi.fn<typeof globalThis.fetch>();
    await expect(api(fetch).reportWorkerConfiguration(workerId, report, input)).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false, cause: { kind: "request_limit" } });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(input)).toBe(before);
  });
  it("preserves a large legal observation and runtime source under the new budget", async () => {
    const projectIds = Array.from({ length: 512 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    const native = { agent: "codex" as const, model: "gpt-6-astra", args: ["--add-dir", "/" + "a".repeat(1580)] };
    const observation: WorkerCloudReport = { bootstrap: null, observation: { baseRevision: "0", desiredRevision: "1", items: projectIds.flatMap(projectId => [
      { ...item, key: { kind: "projectNative" as const, projectId }, appliedValue: native },
      { ...item, key: { kind: "projectPreparation" as const, projectId }, appliedValue: true },
    ]) } };
    const source = { agent: "codex" as const, model: { value: "gpt-6-astra", source: "cloud" as const }, reasoningEffort: { value: "high", source: "local" as const } };
    const runtimeConfiguration: WorkerRuntimeConfiguration = { schemaVersion: 1, native: source, projects: projectIds.slice(0, 128).map(projectId => ({ projectId, native: source })) };
    const input = { ...report, runtimeConfiguration };
    expect(Buffer.byteLength(stringifyApiJson({ ...input, configuration: observation }))).toBeGreaterThan(1_048_576);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(receipt));
    await expect(api(fetch).reportWorkerConfiguration(workerId, input, observation)).resolves.toEqual(receipt);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ ...input, configuration: observation });
    expect(input.runtimeConfiguration.projects).toHaveLength(128);
  });

  it("omits the whole optional source observation when it exceeds the complete report budget", async () => {
    const observation = configuration;
    const runtimeConfiguration: WorkerRuntimeConfiguration = { schemaVersion: 1, native: null, projects: [] };
    const base = { ...report, taskInventory: { observedAt: time, claims: [{ projectId: workerId, taskId: userId, claimId: workerId }] }, workingDirectory: "" };
    const padding = 9 * 1_048_576 - Buffer.byteLength(stringifyApiJson({ ...base, configuration: observation }));
    const required = { ...base, workingDirectory: "a".repeat(padding) };
    const input = { ...required, runtimeConfiguration };
    expect(Buffer.byteLength(stringifyApiJson({ ...required, configuration: observation }))).toBe(9 * 1_048_576);
    expect(Buffer.byteLength(stringifyApiJson({ ...input, configuration: observation }))).toBeGreaterThan(9 * 1_048_576);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(receipt));
    await expect(api(fetch).reportWorkerConfiguration(workerId, input, observation)).resolves.toEqual(receipt);
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ ...required, configuration: observation });
    expect(input.runtimeConfiguration).toEqual(runtimeConfiguration);
  });

  it("retains source observations at the exact encoded byte limit and omits them one byte above", async () => {
    const runtimeConfiguration: WorkerRuntimeConfiguration = { schemaVersion: 1, native: null, projects: [] };
    const base = { ...report, runtimeConfiguration, workingDirectory: "" };
    const padding = 9 * 1_048_576 - Buffer.byteLength(stringifyApiJson({ ...base, configuration }));
    const input = { ...base, workingDirectory: "中".repeat(Math.floor(padding / 3)) + "a".repeat(padding % 3) };
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response(receipt));
    const client = api(fetch);
    await expect(client.reportWorkerConfiguration(workerId, input, configuration)).resolves.toEqual(receipt);
    expect(Buffer.byteLength(String(fetch.mock.calls[0]![1]!.body))).toBe(9 * 1_048_576);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).runtimeConfiguration).toEqual(runtimeConfiguration);
    await expect(client.reportWorkerConfiguration(workerId, { ...input, workingDirectory: input.workingDirectory + "a" }, configuration)).resolves.toEqual(receipt);
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).not.toHaveProperty("runtimeConfiguration");
  });

  it("still rejects a required report that exceeds the budget after optional sources are omitted", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const runtimeConfiguration: WorkerRuntimeConfiguration = { schemaVersion: 1, native: null, projects: [] };
    await expect(api(fetch).reportWorkerConfiguration(workerId, { ...report, workingDirectory: "x".repeat(9 * 1_048_576), runtimeConfiguration }, configuration)).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false, cause: { kind: "request_limit" } });
    expect(fetch).not.toHaveBeenCalled();
  });

});

it.each([{ omitted: true, fail: false, asynchronous: false }, { omitted: false, fail: false, asynchronous: true }, { omitted: true, fail: true, asynchronous: false }])("exposes request-time tool budgeting without changing the report outcome ($omitted/$fail/$asynchronous)", async ({ omitted, fail, asynchronous }) => {
  const user = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", worker = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operation = createOperation();
  const notices: unknown[] = [], requests: RequestInit[] = [];
  const configuration = { bootstrap: null, toolPathsBootstrap: null, observation: null };
  const base = { ...workerTelemetry, taskInventory: null, workingDirectory: "" };
  const spare = 9 * 1_048_576 - Buffer.byteLength(JSON.stringify({ ...base, configuration })) - (omitted ? 16 : 600);
  const required = { ...base, workingDirectory: "x".repeat(spare) };
  const client = createApiClient({ serverUrl: "http://localhost:8787", expectedUserId: user, operation,
    onToolPathsBudget: result => { notices.push(result); if (asynchronous) return Promise.reject(new Error("observer-private-content")); throw new Error("observer-private-content"); },
    fetch: async (_url, init) => {
      requests.push(init!); const get = init!.method === "GET";
      if (!get && fail) throw new Error("transport failed");
      return new Response(JSON.stringify(get ? { desired: null, observationRevision: "0", observation: null } : { observedAt: time, lastReportedAt: time, configuration: { desired: null, observationRevision: "0", observationAccepted: false } }), { headers: { "Content-Type": "application/json", "Daynight-User-ID": user, "Daynight-Worker-Configuration": "1", "Daynight-Worker-Tool-Paths": "1" } });
    },
  });
  try {
    await client.getWorkerConfiguration(worker);
    const pending = client.reportWorkerConfiguration(worker, { ...required, toolPaths: telemetry() }, configuration);
    if (fail) await expect(pending).rejects.toMatchObject({ phase: "request", outcomeUnconfirmed: true });
    else await expect(pending).resolves.toMatchObject({ observedAt: time });
    expect(notices).toEqual([{ code: "report_budget_exceeded", omitted }]);
    expect(requests).toHaveLength(2);
    const body = JSON.parse(requests[1]!.body as string);
    expect(body.taskInventory).toBeNull(); expect(body.configuration).toEqual(configuration);
    expect(Buffer.byteLength(requests[1]!.body as string)).toBeLessThanOrEqual(9 * 1_048_576);
    if (omitted) expect(body).not.toHaveProperty("toolPaths");
    else expect(body.toolPaths.entries[0]).toMatchObject({ state: "pending", reason: "report_budget_exceeded" });
    expect(requests[1]!.body).not.toContain("observer-private-content");
  } finally { operation.dispose(); }
});
