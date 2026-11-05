import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../src/api/client.js";
import { createOperation } from "../../src/api/operation.js";
import type { Operation } from "../../src/api/operation.js";
import { ProtocolError } from "../../src/api/validation.js";
import { decodeWorkerCloudJsonSource, parseWorkerCloudReport, parseWorkerCloudResource, parseWorkerCloudValue } from "../../src/api/worker-configuration.js";
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
    await expect(api(bounded).reportWorkerConfiguration(workerId, report, { bootstrap: { ...value, native: { ...value.native, args: ["x".repeat(1_048_576)] } }, observation: null })).rejects.toMatchObject({ phase: "prepare", outcomeUnconfirmed: false, cause: { kind: "request_limit" } });
    expect(bounded).not.toHaveBeenCalled();
  });
});
