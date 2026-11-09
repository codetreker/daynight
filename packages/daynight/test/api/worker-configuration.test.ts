import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../src/api/client.js";
import { stringifyApiJson } from "../../src/api/json.js";
import type { WorkerRuntimeConfiguration } from "../../src/api/types.js";
import { createOperation } from "../../src/api/operation.js";
import type { Operation } from "../../src/api/operation.js";
import { ProtocolError } from "../../src/api/validation.js";
import { decodeWorkerCloudJsonSource, parseWorkerCloudObservation, parseWorkerCloudReport, parseWorkerCloudResource, parseWorkerCloudValue } from "../../src/api/worker-configuration.js";
import { parseWorkerRuntimeConfiguration } from "../../src/api/worker-runtime-configuration.js";
import { workerRuntimeConfigurationReport } from "../../src/commands/worker/native-overrides.js";
import type { WorkerCloudDesired, WorkerCloudItem, WorkerCloudReport, WorkerCloudValue } from "../../src/api/worker-configuration.js";
import { workerTelemetry } from "../fixtures/worker-telemetry.js";

const workerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const time = "2026-11-04T00:00:00.123456789Z";
const value: WorkerCloudValue = { maxConcurrent: 2, pollIntervalMs: 60_000, recoveryLimit: 3, native: { agent: "codex", model: null, args: [] }, projects: [{ projectId: workerId, nativeOverrides: { model: null, args: [] } }, { projectId: userId, nativeOverrides: {} }] };
const desired: WorkerCloudDesired = { revision: "9223372036854775807", updatedAt: time, value };
const item: WorkerCloudItem = { key: { kind: "maxConcurrent" }, targetRevision: "1", appliedValue: 2, state: "applied", error: null, lastFailure: null, nextAttemptAt: null };
const configuration: WorkerCloudReport = { bootstrap: null, observation: { baseRevision: "0", desiredRevision: "1", items: [item] } };
const resource = { desired, observationRevision: "0", observation: null };
const report = { ...workerTelemetry, taskInventory: null };
const receipt = { observedAt: time, lastReportedAt: time, configuration: { desired, observationRevision: "1", observationAccepted: true } };
const operations: Operation[] = [];
const api = (fetch: typeof globalThis.fetch) => {
  const operation = createOperation(); operations.push(operation);
  return createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", expectedUserId: userId, operation, fetch });
};
const response = (body: unknown, capability: string | null = "1", principal = userId) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Daynight-User-ID": principal, ...(capability === null ? {} : { "Daynight-Worker-Configuration": capability }) } });
afterEach(() => { operations.splice(0).forEach(operation => operation.dispose()); vi.restoreAllMocks(); });

describe("Worker cloud configuration protocol", () => {
  it("enforces byte, scalar, Project and observation limits before producing reports", () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const projects = Array.from({ length: 129 }, (_, n) => ({ projectId: id(n), nativeOverrides: {} }));
    const bounded = { ...value, maxConcurrent: 64, pollIntervalMs: 1000, recoveryLimit: 10, native: { ...value.native, model: "界".repeat(85) + "x", args: Array(128).fill("界".repeat(1365) + "x") }, projects: projects.slice(0, 128) };
    expect(parseWorkerCloudValue(bounded).projects).toHaveLength(128);
    for (const invalid of [
      { ...bounded, projects }, { ...bounded, maxConcurrent: 65 }, { ...bounded, recoveryLimit: 11 },
      { ...bounded, pollIntervalMs: 999 }, { ...bounded, pollIntervalMs: 60_001 },
      { ...bounded, native: { ...bounded.native, model: "界".repeat(86) } },
      { ...bounded, native: { ...bounded.native, args: [...bounded.native.args, "x"] } },
      { ...bounded, native: { ...bounded.native, args: ["界".repeat(1366)] } },
    ]) expect(() => parseWorkerCloudValue(invalid)).toThrow(ProtocolError);
    const items = Array.from({ length: 1025 }, (_, n) => ({ ...item, key: { kind: "projectRemoval", projectId: id(n) }, appliedValue: null, state: "pending" }));
    expect(parseWorkerCloudObservation({ baseRevision: "0", desiredRevision: "1", items: items.slice(0, 1024) }).items).toHaveLength(1024);
    expect(() => parseWorkerCloudObservation({ baseRevision: "0", desiredRevision: "1", items })).toThrow(ProtocolError);
    const runtimeProjects = projects.map(project => ({ projectId: project.projectId, native: null }));
    expect(parseWorkerRuntimeConfiguration({ schemaVersion: 1, native: null, projects: runtimeProjects.slice(0, 128) }).projects).toHaveLength(128);
    expect(() => parseWorkerRuntimeConfiguration({ schemaVersion: 1, native: null, projects: runtimeProjects })).toThrow(ProtocolError);
    expect(workerRuntimeConfigurationReport({ native: null, projects: runtimeProjects }, "web", {})).toBeUndefined();
  });
  it("preserves inheritance, explicit clears and the full int64 string range", () => {
    expect(parseWorkerCloudResource(resource)).toEqual(resource);
    expect(parseWorkerCloudValue(value).projects.map(project => project.nativeOverrides)).toEqual([{ model: null, args: [] }, {}]);
    expect(parseWorkerCloudResource({ desired: null, observationRevision: "0", observation: null })).toEqual({ desired: null, observationRevision: "0", observation: null });
  });

  it.each(["0", "01", "+1", "1e2", "1.0", "9223372036854775808", 1])("rejects malformed or out-of-range desired revision %j", revision => {
    expect(() => parseWorkerCloudResource({ ...resource, desired: { ...desired, revision } })).toThrow(ProtocolError);
  });

  it.each([
    { ...value, maxConcurrent: 0 }, { ...value, recoveryLimit: -1 }, { ...value, pollIntervalMs: 2_147_483_648 },
    { ...value, maxConcurrent: Number.MAX_SAFE_INTEGER + 1 }, { ...value, native: { ...value.native, model: " " } },
    { ...value, native: { ...value.native, args: ["--argument\nprivate"] } }, { ...value, native: { ...value.native, model: "\ud800" } },
    { ...value, native: { ...value.native, agentControlMode: "web" } }, { ...value, projects: [...value.projects, value.projects[0]] },
    { ...value, projects: [{ projectId: workerId, nativeOverrides: { path: "/private" } }] },
  ])("rejects malformed cloud values %j", invalid => { expect(() => parseWorkerCloudValue(invalid)).toThrow(ProtocolError); });

  it("validates outcomes independently of the current target list, retaining removed-project results", () => {
    const failure = { code: "permission_denied", category: "runtime", phase: "stop", occurredAt: time };
    const removed = { ...item, key: { kind: "projectRemoval", projectId: userId }, appliedValue: null, state: "error", error: failure, lastFailure: failure, nextAttemptAt: time };
    const observation = { baseRevision: "7", desiredRevision: "8", items: [item, removed], reportedAt: time };
    const parsed = parseWorkerCloudResource({ desired: { ...desired, value: { ...value, projects: [] } }, observationRevision: "8", observation });
    expect(parsed.observation?.items).toEqual([item, removed]);
    expect(parsed.observation?.baseRevision).toBe("7");
  });

  it("reads historical over-limit observations while rejecting them on a new report", () => {
    const observation = { baseRevision: "0", desiredRevision: "1", items: [{ ...item, appliedValue: 65 }], reportedAt: time };
    expect(parseWorkerCloudResource({ desired, observationRevision: "1", observation }).observation).toEqual(observation);
    expect(() => parseWorkerCloudReport({ bootstrap: null, observation: { ...observation, reportedAt: undefined } })).toThrow(ProtocolError);
    expect(() => parseWorkerCloudObservation({ baseRevision: "0", desiredRevision: "1", items: observation.items })).toThrow(ProtocolError);
  });

  it.each([
    { ...item, appliedValue: null }, { ...item, key: { kind: "projectPreparation", projectId: workerId }, appliedValue: false },
    { ...item, error: { code: "io_error", category: "storage", phase: "persist", occurredAt: time } },
    { ...item, state: "pending", nextAttemptAt: time }, { ...item, key: { kind: "native", projectId: workerId } },
    { ...item, key: { kind: "projectNative" } }, { ...item, targetRevision: "2" },
    { ...item, state: "error", error: { code: "io_error", category: "storage", phase: "persist", occurredAt: time, message: "private command" } },
  ])("rejects invalid item state or diagnostics %j", invalid => {
    expect(() => parseWorkerCloudReport({ bootstrap: null, observation: { baseRevision: "0", desiredRevision: "1", items: [invalid] } })).toThrow(ProtocolError);
  });

  it("rejects duplicate keys, lexical nonintegers and malformed source before coercion", () => {
    for (const source of ["{\"a\":1,\"a\":2}", "{\"nested\":{\"a\":1,\"a\":2}}", "{\"a\":1e2}", "{\"a\":1.0}", "{\"a\":-0}", "{} {}"] ) {
      expect(() => decodeWorkerCloudJsonSource(source)).toThrow();
    }
    expect(() => parseWorkerCloudReport({ ...configuration, observation: { ...configuration.observation!, items: [item, item] } })).toThrow(ProtocolError);
    expect(() => parseWorkerCloudResource({ ...resource, supported: true })).toThrow(ProtocolError);
  });

  it("requires exact observation CAS history and forbids results without an initialized target", () => {
    const observation = { baseRevision: "0", desiredRevision: "1", items: [item], reportedAt: time };
    expect(() => parseWorkerCloudResource({ ...resource, observation, observationRevision: "2" })).toThrow(ProtocolError);
    expect(() => parseWorkerCloudResource({ ...resource, desired: null, observation, observationRevision: "1" })).toThrow(ProtocolError);
    expect(() => parseWorkerCloudResource({ ...resource, observation: null, observationRevision: "1" })).toThrow(ProtocolError);
  });
});

describe("Worker cloud configuration client", () => {
  it("rejects an oversized complete observation at the body envelope without dropping applied values", async () => {
    const native = { agent: "codex" as const, model: null, args: Array(128).fill("x".repeat(4096)) };
    const input: WorkerCloudReport = { bootstrap: null, observation: { baseRevision: "0", desiredRevision: "1", items: [
      { ...item, key: { kind: "native" }, appliedValue: native },
      { ...item, key: { kind: "projectNative", projectId: workerId }, appliedValue: native },
    ] } };
    const before = JSON.stringify(input), fetch = vi.fn<typeof globalThis.fetch>();
    await expect(api(fetch).reportWorkerConfiguration(workerId, report, input)).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false, cause: { kind: "request_limit" } });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(input)).toBe(before);
  });
  it("omits the whole optional source observation when it exceeds the complete report budget", async () => {
    const projectIds = Array.from({ length: 512 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    const native = { agent: "codex" as const, model: "gpt-6-astra", args: ["--add-dir", "/" + "a".repeat(1580)] };
    const observation: WorkerCloudReport = { bootstrap: null, observation: { baseRevision: "0", desiredRevision: "1", items: projectIds.flatMap(projectId => [
      { ...item, key: { kind: "projectNative" as const, projectId }, appliedValue: native },
      { ...item, key: { kind: "projectPreparation" as const, projectId }, appliedValue: true },
    ]) } };
    const source = { agent: "codex" as const, model: { value: "gpt-6-astra", source: "cloud" as const }, reasoningEffort: { value: "high", source: "local" as const } };
    const runtimeConfiguration: WorkerRuntimeConfiguration = { schemaVersion: 1, native: source, projects: projectIds.slice(0, 128).map(projectId => ({ projectId, native: source })) };
    const required = { ...report, taskInventory: { observedAt: time, claims: [{ projectId: workerId, taskId: userId, claimId: workerId }] } };
    const input = { ...required, runtimeConfiguration };
    expect(Buffer.byteLength(stringifyApiJson({ ...required, configuration: observation }))).toBeLessThan(1_048_576);
    expect(Buffer.byteLength(stringifyApiJson({ ...input, configuration: observation }))).toBeGreaterThan(1_048_576);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(receipt));
    await expect(api(fetch).reportWorkerConfiguration(workerId, input, observation)).resolves.toEqual(receipt);
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ ...required, configuration: observation });
    expect(input.runtimeConfiguration.projects).toHaveLength(128);
  });

  it("retains source observations at the exact encoded byte limit and omits them one byte above", async () => {
    const runtimeConfiguration: WorkerRuntimeConfiguration = { schemaVersion: 1, native: null, projects: [] };
    const base = { ...report, runtimeConfiguration, workingDirectory: "" };
    const padding = 1_048_576 - Buffer.byteLength(stringifyApiJson({ ...base, configuration }));
    const input = { ...base, workingDirectory: "中".repeat(Math.floor(padding / 3)) + "a".repeat(padding % 3) };
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response(receipt));
    const client = api(fetch);
    await expect(client.reportWorkerConfiguration(workerId, input, configuration)).resolves.toEqual(receipt);
    expect(Buffer.byteLength(String(fetch.mock.calls[0]![1]!.body))).toBe(1_048_576);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).runtimeConfiguration).toEqual(runtimeConfiguration);
    await expect(client.reportWorkerConfiguration(workerId, { ...input, workingDirectory: input.workingDirectory + "a" }, configuration)).resolves.toEqual(receipt);
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).not.toHaveProperty("runtimeConfiguration");
  });

  it("still rejects a required report that exceeds the budget after optional sources are omitted", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const runtimeConfiguration: WorkerRuntimeConfiguration = { schemaVersion: 1, native: null, projects: [] };
    await expect(api(fetch).reportWorkerConfiguration(workerId, { ...report, workingDirectory: "x".repeat(1_048_576), runtimeConfiguration }, configuration)).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false, cause: { kind: "request_limit" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("applies the complete byte budget to legacy reports without configuration observations", async () => {
    const runtimeConfiguration: WorkerRuntimeConfiguration = { schemaVersion: 1, native: null, projects: [] };
    const base = { ...report, workingDirectory: "" };
    const input = { ...base, workingDirectory: "a".repeat(1_048_576 - Buffer.byteLength(stringifyApiJson(base))) };
    const legacy = { observedAt: time, lastReportedAt: time };
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response(legacy, null));
    const client = api(fetch);
    await expect(client.reportWorker(workerId, { ...input, runtimeConfiguration })).resolves.toEqual(legacy);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual(input);
    await expect(client.reportWorker(workerId, { ...input, workingDirectory: input.workingDirectory + "a", runtimeConfiguration })).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false, cause: { kind: "request_limit" } });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not discard optional sources to hide serialization errors", async () => {
    const runtimeConfiguration: WorkerRuntimeConfiguration = { schemaVersion: 1, native: null, projects: [] };
    Object.assign(runtimeConfiguration, { invalid: 0n });
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = api(fetch);
    await expect(client.reportWorker(workerId, { ...report, runtimeConfiguration })).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false, cause: { message: "version must be a positive 64-bit integer." } });
    await expect(client.reportWorkerConfiguration(workerId, { ...report, runtimeConfiguration }, configuration)).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false, cause: { message: "version must be a positive 64-bit integer." } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("isolates capability headers per request and preserves the exact legacy receipt", async () => {
    const legacy = { observedAt: time, lastReportedAt: time };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(resource)).mockResolvedValueOnce(response(receipt)).mockResolvedValueOnce(response(legacy, null));
    const client = api(fetch);
    await expect(client.getWorkerConfiguration(workerId)).resolves.toEqual(resource);
    await expect(client.reportWorkerConfiguration(workerId, report, configuration)).resolves.toEqual(receipt);
    await expect(client.reportWorker(workerId, report)).resolves.toEqual(legacy);
    expect(fetch.mock.calls.map(([, options]) => new Headers(options!.headers).get("Daynight-Worker-Configuration"))).toEqual(["1", "1", null]);
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual({ ...report, configuration });
    expect(JSON.parse(fetch.mock.calls[2]![1]!.body as string)).toEqual(report);
  });

  it.each([null, "2", "1, 1", ""]) ("refuses unsupported or ambiguous configuration capability %j", async capability => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(resource, capability));
    await expect(api(fetch).getWorkerConfiguration(workerId)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects a changed principal and does not replay a configuration mutation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(receipt, "1", workerId));
    await expect(api(fetch).reportWorkerConfiguration(workerId, report, configuration)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not interpret an unscoped route 404 as an absent cloud configuration", async () => {
    const missing = () => new Response(JSON.stringify({ error: { code: "not_found", message: "Resource not found.", requestId: "configuration-missing" } }), { status: 404, headers: { "Content-Type": "application/json" } });
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => missing());
    await expect(api(fetch).getWorkerConfiguration(workerId)).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not acknowledge an observation that was absent or has a different CAS revision", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response(receipt));
    await expect(api(fetch).reportWorkerConfiguration(workerId, report, { bootstrap: value, observation: null })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    await expect(api(fetch).reportWorkerConfiguration(workerId, report, { ...configuration, observation: { ...configuration.observation!, baseRevision: "9" } })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses an accepted observation that references a future target", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...receipt, configuration: { ...receipt.configuration, desired: { ...desired, revision: "1" } } }));
    await expect(api(fetch).reportWorkerConfiguration(workerId, report, { ...configuration, observation: { ...configuration.observation!, desiredRevision: "2" } })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("exposes a rejected CAS receipt without treating it as success or retrying", async () => {
    const rejected = { ...receipt, configuration: { ...receipt.configuration, observationRevision: "9", observationAccepted: false } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(rejected));
    await expect(api(fetch).reportWorkerConfiguration(workerId, report, configuration)).resolves.toEqual(rejected);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retains unknown report outcomes and rejects oversized outgoing configuration without dispatch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("connection closed"));
    await expect(api(fetch).reportWorkerConfiguration(workerId, report, configuration)).rejects.toMatchObject({ outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
    const bounded = vi.fn<typeof globalThis.fetch>();
    expect(() => api(bounded).reportWorkerConfiguration(workerId, report, { bootstrap: { ...value, native: { ...value.native, args: ["x".repeat(4097)] } }, observation: null })).toThrow(ProtocolError);
    expect(bounded).not.toHaveBeenCalled();
  });
});
