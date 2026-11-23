import { createServer } from "node:http";
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
const value: WorkerCloudValue = { maxConcurrent: 2, pollIntervalMs: 60_000, recoveryLimit: 3, preferPlatformSpecificTasks: false, native: { agent: "codex", model: null, args: [] }, projects: [{ projectId: workerId, nativeOverrides: { model: null, args: [] } }, { projectId: userId, nativeOverrides: {} }] };
const desired: WorkerCloudDesired = { revision: "9223372036854775807", updatedAt: time, value };
const item: WorkerCloudItem = { key: { kind: "maxConcurrent" }, targetRevision: "1", appliedValue: 2, state: "applied", error: null, lastFailure: null, nextAttemptAt: null };
const configuration: WorkerCloudReport = { bootstrap: null, observation: { baseRevision: "0", desiredRevision: "1", items: [item] } };
const networkValue: WorkerCloudValue = { ...value, toolPaths: { codex: { kind: "auto" }, copilot: { kind: "auto" } } };
const networkDesired = { ...desired, value: networkValue };
const resource = { desired: networkDesired, observationRevision: "0", observation: null };
const report = { ...workerTelemetry, taskInventory: null };
const receipt = { observedAt: time, lastReportedAt: time, configuration: { desired: networkDesired, observationRevision: "1", observationAccepted: true } };
const receivedDesired = (value: WorkerCloudDesired | null) => value === null ? null : { json: JSON.stringify(value), revision: value.revision, updatedAt: value.updatedAt, known: value };
const receivedReceipt = (value: typeof receipt) => ({ ...value, configuration: { ...value.configuration, json: JSON.stringify(value.configuration), desired: receivedDesired(value.configuration.desired) } });
const operations: Operation[] = [];
const api = (fetch: typeof globalThis.fetch) => {
  const operation = createOperation(); operations.push(operation);
  return createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", expectedUserId: userId, operation, fetch });
};
const response = (body: unknown, capability: string | null = "1", principal = userId) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Daynight-User-ID": principal, "Daynight-Worker-Tool-Paths": "2", ...(capability === null ? {} : { "Daynight-Worker-Configuration": capability }) } });
afterEach(() => { operations.splice(0).forEach(operation => operation.dispose()); vi.restoreAllMocks(); });

describe("Worker cloud configuration protocol", () => {
  it("receives the filter through GET and report receipts while reporting only its applied digest", async () => {
    const taskTagFilter = { names: ["Backend", "urgent"], match: "all" as const };
    const filteredDesired = { ...networkDesired, value: { ...networkValue, taskTagFilter } };
    const digest = "b60f83f3c95a35685b5ceedbcd54b0aea405fef15c3f8bb11203002f0eca3ab6";
    const applied: WorkerCloudItem = { ...item, key: { kind: "taskTagFilter" }, appliedValue: digest };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ ...resource, desired: filteredDesired }))
      .mockResolvedValueOnce(response({ ...receipt, configuration: { ...receipt.configuration, desired: filteredDesired } }));
    const client = api(fetch);
    expect((await client.getWorkerConfiguration(workerId)).desired?.known?.value.taskTagFilter).toEqual(taskTagFilter);
    const received = await client.reportWorkerConfiguration(workerId, report, { bootstrap: null, observation: { baseRevision: "0", desiredRevision: "1", items: [applied] } });
    expect(received.configuration.desired?.known?.value.taskTagFilter).toEqual(taskTagFilter);
    const body = JSON.parse(String(fetch.mock.calls[1]![1]!.body));
    expect(body.configuration.observation.items).toEqual([applied]);
    expect(JSON.stringify(body)).not.toContain('"names"');
  });

  it("accepts optional tag filters and only digest application values", () => {
    const filter = { names: [" urgent ", "Backend", "backend"], match: "all" };
    expect(parseWorkerCloudValue({ ...value, taskTagFilter: filter }).taskTagFilter).toEqual({ names: ["Backend", "urgent"], match: "all" });
    expect(parseWorkerCloudValue(value)).not.toHaveProperty("taskTagFilter");
    for (const invalid of [null, {}, { names: [], match: "ALL" }]) expect(() => parseWorkerCloudValue({ ...value, taskTagFilter: invalid })).toThrow(ProtocolError);
    const observation = (appliedValue: unknown, state = "applied") => ({ baseRevision: "0", desiredRevision: "1", items: [{ ...item, key: { kind: "taskTagFilter" }, appliedValue, state }] });
    const digest = "d6b8862fae28deb5524520e92b0c2252f54a3d6607ea333c47c6ba91b99816f2";
    expect(parseWorkerCloudObservation(observation(digest)).items[0]!.appliedValue).toBe(digest);
    expect(parseWorkerCloudObservation(observation(null, "pending")).items[0]!.appliedValue).toBeNull();
    for (const invalid of [filter, true, 2, digest.toUpperCase(), "a".repeat(63), "web", null]) expect(() => parseWorkerCloudObservation(observation(invalid))).toThrow(ProtocolError);
    expect(() => parseWorkerCloudObservation({ baseRevision: "0", desiredRevision: "1", items: [{ ...item, appliedValue: digest }] })).toThrow(ProtocolError);
  });

  it("reserves one tag digest slot while retaining the historical ordinary item limit", () => {
    const items = Array.from({ length: 1025 }, (_, n) => ({ ...item, key: { kind: "projectRemoval", projectId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` }, appliedValue: null, state: "pending" }));
    const extensions = [
      { ...item, key: { kind: "agentControlMode" }, appliedValue: "web" },
      { ...item, key: { kind: "enableSudoCleanup" }, appliedValue: false },
      { ...item, key: { kind: "archiveSessions" }, appliedValue: true },
      { ...item, key: { kind: "taskTagFilter" }, appliedValue: "a".repeat(64) },
    ];
    const capabilities = { controlMode: true, toolPaths: false, archiveSessions: true };
    expect(parseWorkerCloudObservation({ baseRevision: "0", desiredRevision: "1", items: [...items, ...extensions] }, true, capabilities).items).toHaveLength(1029);
    expect(() => parseWorkerCloudObservation({ baseRevision: "0", desiredRevision: "1", items: [...items, { ...items[0], key: { kind: "projectRemoval", projectId: workerId } }, ...extensions] }, true, capabilities)).toThrow(ProtocolError);
  });

  it("retains incompatible stored targets across GET and report receipts", async () => {
    const raw = JSON.stringify(networkDesired).replace('"maxConcurrent":2', '"maxConcurrent":"future-value"').replace('"value":{', '"value":{"future":900719925474099312345,');
    const config = `{"desired":${raw},"observationRevision":"1","observationAccepted":true}`;
    const rawResponse = (source: string, version: string) => new Response(source, { headers: { "Content-Type": "application/json", "Daynight-User-ID": userId, "Daynight-Worker-Configuration": version, "Daynight-Worker-Tool-Paths": "2" } });
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(rawResponse(`{"desired":${raw},"observationRevision":"0","observation":null}`, "1"))
      .mockResolvedValueOnce(rawResponse(`{"observedAt":"${time}","lastReportedAt":"${time}","configuration":${config}}`, "1"))
      .mockResolvedValueOnce(rawResponse(`{"observedAt":"${time}","lastReportedAt":"${time}","configuration":${config.slice(0, -1)},"prompts":[]}}`, "2"));
    const client = api(fetch), expected = { json: raw, revision: desired.revision, updatedAt: time, known: null };
    expect((await client.getWorkerConfiguration(workerId)).desired).toEqual(expected);
    expect((await client.reportWorkerConfiguration(workerId, report, configuration)).configuration.desired).toEqual(expected);
    const receipt = await client.reportWorkerConfiguration(workerId, report, configuration, []);
    expect(receipt.configuration.desired).toEqual(expected);
    expect(receipt.prompts).toEqual({ ok: true, results: [] });
  });

  it("rejects an accepted observation newer than an incompatible stored target", async () => {
    const raw = JSON.stringify(networkDesired).replace('"maxConcurrent":2', '"maxConcurrent":"future-value"').replace(desired.revision, "1");
    const config = `{"desired":${raw},"observationRevision":"1","observationAccepted":true}`;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(`{"observedAt":"${time}","lastReportedAt":"${time}","configuration":${config}}`, {
      headers: { "Content-Type": "application/json", "Daynight-User-ID": userId, "Daynight-Worker-Configuration": "1" },
    }));
    await expect(api(fetch).reportWorkerConfiguration(workerId, report, { ...configuration, observation: { ...configuration.observation!, desiredRevision: "2" } })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["web", "herdr", null] as const)("preserves retired mode %j and unknown tool source across GET and both report receipt variants", async agentControlMode => {
    const future = '{"negative":-2,"fraction":1.25,"integer":9007199254740993,"exponent":1e9999,"array":[true,null]}';
    const desiredJson = JSON.stringify(networkDesired).replace('"maxConcurrent":2', '"maxConcurrent":4').replace('"value":{', `"future":${future},"value":{"agentControlMode":${JSON.stringify(agentControlMode)},"future":${future},`).replace('"agent":"codex"', `"agent":"codex","future":${future}`).replace('"toolPaths":{', `"toolPaths":{"herdr":${future},`);
    const expected = { ...networkDesired, value: { ...networkValue, maxConcurrent: 4 } };
    const configJson = `{"desired":${desiredJson},"observationRevision":"1","observationAccepted":true,"future":${future}}`;
    const responses = [
      `{"desired":${desiredJson},"observationRevision":"0","observation":null,"future":${future}}`,
      `{"observedAt":"${time}","lastReportedAt":"${time}","configuration":${configJson}}`,
      `{"observedAt":"${time}","lastReportedAt":"${time}","configuration":${configJson.slice(0, -1)},"prompts":[]}}`,
    ];
    let received = 0;
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "Content-Type": "application/json", "Daynight-User-ID": userId, "Daynight-Worker-Configuration": received === 2 ? "2" : "1", "Daynight-Worker-Tool-Paths": "2" });
      response.end(responses[received++]);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture server address.");
    const operation = createOperation(); operations.push(operation);
    const client = createApiClient({ serverUrl: `http://127.0.0.1:${address.port}`, serverToken: "fixture-token", expectedUserId: userId, operation });
    try {
      expect((await client.getWorkerConfiguration(workerId)).desired).toEqual({ json: desiredJson, revision: desired.revision, updatedAt: desired.updatedAt, known: expected });
      expect((await client.reportWorkerConfiguration(workerId, report, configuration)).configuration).toEqual({ json: configJson, desired: { json: desiredJson, revision: desired.revision, updatedAt: desired.updatedAt, known: expected }, observationRevision: "1", observationAccepted: true });
      const sync = await client.reportWorkerConfiguration(workerId, report, configuration, []);
      expect(sync.configuration.desired?.json).toBe(desiredJson);
      expect(sync.configuration.desired?.known).toEqual(expected);
      expect(sync.configuration.json).toBe(configJson);
      expect(sync.prompts).toEqual({ ok: true, results: [] });
      expect(received).toBe(3);
    } finally {
      await new Promise<void>((resolve, reject) => { server.close(error => error === undefined ? resolve() : reject(error)); server.closeAllConnections(); });
    }
  });
  it("requires the negotiated control mode field and validates its distinct observation value", () => {
    expect(parseWorkerCloudValue({ ...value, agentControlMode: "web" }, true, true).agentControlMode).toBe("web");
    expect(parseWorkerCloudValue({ ...value, agentControlMode: null }, true, true).agentControlMode).toBeNull();
    for (const invalid of [value, { ...value, agentControlMode: false }, { ...value, agentControlMode: "other" }]) expect(() => parseWorkerCloudValue(invalid, true, true)).toThrow(ProtocolError);
    expect(() => parseWorkerCloudValue({ ...value, agentControlMode: "web" })).toThrow(ProtocolError);
    const applied = { ...item, key: { kind: "agentControlMode" }, appliedValue: "web" };
    expect(parseWorkerCloudObservation({ baseRevision: "0", desiredRevision: "1", items: [applied] }, true, true).items).toEqual([applied]);
    expect(() => parseWorkerCloudReport({ bootstrap: { ...value, agentControlMode: null }, observation: null, controlModeBootstrap: "web" }, true)).toThrow(ProtocolError);
  });
  it("reserves the extra observation slot for control mode so legacy projections fit", () => {
    const items = Array.from({ length: 1026 }, (_, n) => ({ ...item, key: { kind: "projectRemoval", projectId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` }, appliedValue: null, state: "pending" }));
    expect(() => parseWorkerCloudObservation({ baseRevision: "0", desiredRevision: "1", items }, true, true)).toThrow(ProtocolError);
    expect(parseWorkerCloudObservation({ baseRevision: "0", desiredRevision: "1", items: [...items.slice(0, 1025), { ...item, key: { kind: "agentControlMode" }, appliedValue: "web" }] }, true, true).items).toHaveLength(1026);
  });
  it("reserves separate slots for mode, sudo and archive without expanding ordinary items", () => {
    const items = Array.from({ length: 1026 }, (_, n) => ({ ...item, key: { kind: "projectRemoval", projectId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` }, appliedValue: null, state: "pending" }));
    const extensions = [
      { ...item, key: { kind: "agentControlMode" }, appliedValue: "web" },
      { ...item, key: { kind: "enableSudoCleanup" }, appliedValue: false },
      { ...item, key: { kind: "archiveSessions" }, appliedValue: true },
    ];
    const capabilities = { controlMode: true, toolPaths: false, archiveSessions: true };
    expect(parseWorkerCloudObservation({ baseRevision: "0", desiredRevision: "1", items: [...items.slice(0, 1025), ...extensions] }, true, capabilities).items).toHaveLength(1028);
    expect(parseWorkerCloudObservation({ baseRevision: "0", desiredRevision: "1", items: [...items.slice(0, 1025), ...extensions.slice(0, 2)] }, true, true).items).toHaveLength(1027);
    expect(() => parseWorkerCloudObservation({ baseRevision: "0", desiredRevision: "1", items: [...items, ...extensions] }, true, capabilities)).toThrow(ProtocolError);
  });
  it("enforces byte, scalar, Project and observation limits before producing reports", () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const projects = Array.from({ length: 129 }, (_, n) => ({ projectId: id(n), nativeOverrides: {} }));
    const bounded = { ...value, maxConcurrent: 64, pollIntervalMs: 1000, recoveryLimit: 10, preferPlatformSpecificTasks: false, native: { ...value.native, model: "界".repeat(85) + "x", args: Array(128).fill("界".repeat(1365) + "x") }, projects: projects.slice(0, 128) };
    expect(parseWorkerCloudValue(bounded).projects).toHaveLength(128);
    for (const invalid of [
      { ...bounded, projects }, { ...bounded, maxConcurrent: 65 }, { ...bounded, recoveryLimit: 11 },
      { ...bounded, pollIntervalMs: 999 }, { ...bounded, pollIntervalMs: 60_001 },
      { ...bounded, native: { ...bounded.native, model: "界".repeat(86) } },
      { ...bounded, native: { ...bounded.native, args: [...bounded.native.args, "x"] } },
      { ...bounded, native: { ...bounded.native, args: ["界".repeat(1366)] } },
    ]) expect(() => parseWorkerCloudValue(invalid)).toThrow(ProtocolError);
    const items = Array.from({ length: 1026 }, (_, n) => ({ ...item, key: { kind: "projectRemoval", projectId: id(n) }, appliedValue: null, state: "pending" }));
    expect(parseWorkerCloudObservation({ baseRevision: "0", desiredRevision: "1", items: items.slice(0, 1025) }).items).toHaveLength(1025);
    expect(() => parseWorkerCloudObservation({ baseRevision: "0", desiredRevision: "1", items })).toThrow(ProtocolError);
    const runtimeProjects = projects.map(project => ({ projectId: project.projectId, native: null }));
    expect(parseWorkerRuntimeConfiguration({ schemaVersion: 1, native: null, projects: runtimeProjects.slice(0, 128) }).projects).toHaveLength(128);
    expect(() => parseWorkerRuntimeConfiguration({ schemaVersion: 1, native: null, projects: runtimeProjects })).toThrow(ProtocolError);
    expect(workerRuntimeConfigurationReport({ native: null, projects: runtimeProjects }, {})).toBeUndefined();
  });
  it("requires a boolean platform preference and preserves false application results", () => {
    for (const preference of [true, false]) {
      expect(parseWorkerCloudValue({ ...value, preferPlatformSpecificTasks: preference }).preferPlatformSpecificTasks).toBe(preference);
      const applied = { ...item, key: { kind: "preferPlatformSpecificTasks" }, appliedValue: preference };
      expect(parseWorkerCloudObservation({ baseRevision: "0", desiredRevision: "1", items: [applied] }).items).toEqual([applied]);
    }
    const { preferPlatformSpecificTasks: _preference, ...missing } = value;
    for (const invalid of [missing, { ...value, preferPlatformSpecificTasks: null }, { ...value, preferPlatformSpecificTasks: "false" }]) {
      expect(() => parseWorkerCloudValue(invalid)).toThrow(ProtocolError);
    }
    expect(() => parseWorkerCloudObservation({ baseRevision: "0", desiredRevision: "1", items: [{ ...item, key: { kind: "preferPlatformSpecificTasks" }, appliedValue: 0 }] })).toThrow(ProtocolError);
  });

  it("preserves inheritance, explicit clears and the full int64 string range", () => {
    expect(parseWorkerCloudResource(resource, { controlMode: false, toolPaths: true })).toEqual(resource);
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

  it("rejects duplicate keys and malformed source before projecting known values", () => {
    for (const source of ["{\"a\":1,\"a\":2}", "{\"nested\":{\"a\":1,\"a\":2}}", "{} {}"] ) {
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
  it("negotiates platform modes while retaining the legacy bootstrap and actual report", async () => {
    const operation = createOperation(); operations.push(operation);
    const capability = { supported: false }, sent: RequestInit[] = [];
    const { preferPlatformSpecificTasks: _old, ...base } = networkValue;
    const modern = { ...networkDesired, value: { ...base, platformTaskMode: "only" as const } };
    const headers = { "Content-Type": "application/json", "Daynight-User-ID": userId, "Daynight-Worker-Configuration": "1", "Daynight-Worker-Platform-Task-Mode": "1", "Daynight-Worker-Tool-Paths": "2" };
    const fetch = vi.fn(async (_url, init) => {
      sent.push(init!);
      return sent.length === 1
        ? new Response(JSON.stringify({ desired: modern, observationRevision: "0", observation: null }), { headers })
        : new Response(JSON.stringify({ ...receipt, configuration: { desired: modern, observationRevision: "1", observationAccepted: true } }), { headers });
    }) as typeof globalThis.fetch;
    const client = () => createApiClient({ serverUrl: "http://localhost:8787", expectedUserId: userId, operation, fetch, workerPlatformTaskMode: capability });
    expect((await client().getWorkerConfiguration(workerId)).desired?.known).toEqual(modern);
    const applied = { ...item, key: { kind: "platformTaskMode" } as const, appliedValue: "only" };
    await client().reportWorkerConfiguration(workerId, report, { bootstrap: null, observation: { baseRevision: "0", desiredRevision: "1", items: [applied] } });
    expect(new Headers(sent[0]!.headers).get("Daynight-Worker-Platform-Task-Mode")).toBe("1");
    expect(new Headers(sent[1]!.headers).get("Daynight-Worker-Platform-Task-Mode")).toBe("1");
    expect(JSON.parse(sent[1]!.body as string).configuration.observation.items).toEqual([applied]);
    expect(() => client().reportWorkerConfiguration(workerId, report, { bootstrap: null, observation: { baseRevision: "0", desiredRevision: "1", items: [{ ...item, key: { kind: "preferPlatformSpecificTasks" }, appliedValue: true }] } })).toThrow("refresh configuration");
    expect(sent).toHaveLength(2);
  });

  it("does not report enum facts to an old service", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(resource));
    const client = api(fetch);
    await client.getWorkerConfiguration(workerId);
    const applied = { ...item, key: { kind: "platformTaskMode" } as const, appliedValue: "only" };
    expect(() => client.reportWorkerConfiguration(workerId, report, { bootstrap: null, observation: { baseRevision: "0", desiredRevision: "1", items: [applied] } })).toThrow("refresh configuration");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("negotiates the archive field and observation across client instances", async () => {
    const operation = createOperation(); operations.push(operation);
    const capability = { supported: false }, sent: RequestInit[] = [];
    const headers = { "Content-Type": "application/json", "Daynight-User-ID": userId, "Daynight-Worker-Configuration": "1", "Daynight-Worker-Archive-Sessions": "1", "Daynight-Worker-Tool-Paths": "2" };
    const archiveDesired = { ...networkDesired, value: { ...networkValue, archiveSessions: false } };
    const fetch = vi.fn(async (_url, init) => {
      sent.push(init!);
      return sent.length === 1
        ? new Response(JSON.stringify({ error: { code: "not_found", message: "not found", requestId: workerId } }), { status: 404, headers })
        : new Response(JSON.stringify({ ...receipt, configuration: { desired: archiveDesired, observationRevision: "0", observationAccepted: false } }), { headers });
    }) as typeof globalThis.fetch;
    const client = () => createApiClient({ serverUrl: "http://localhost:8787", expectedUserId: userId, operation, fetch, workerArchiveSessions: capability });
    await expect(client().getWorkerConfiguration(workerId)).rejects.toMatchObject({ status: 404 });
    await client().reportWorkerConfiguration(workerId, report, { bootstrap: { ...networkValue, archiveSessions: false }, observation: null });
    expect(new Headers(sent[0]!.headers).get("Daynight-Worker-Archive-Sessions")).toBe("1");
    expect(new Headers(sent[1]!.headers).get("Daynight-Worker-Archive-Sessions")).toBe("1");
    expect(JSON.parse(sent[1]!.body as string).configuration.bootstrap.archiveSessions).toBe(false);
    const archiveItem = { ...item, key: { kind: "archiveSessions" }, appliedValue: false };
    const opts = { controlMode: false, toolPaths: false, archiveSessions: true };
    expect(parseWorkerCloudObservation({ baseRevision: "0", desiredRevision: "1", items: [archiveItem] }, true, opts).items).toEqual([archiveItem]);
    expect(() => parseWorkerCloudObservation({ baseRevision: "0", desiredRevision: "1", items: [archiveItem] })).toThrow();
    expect(() => parseWorkerCloudValue({ ...value, archiveSessions: "false" }, true, opts)).toThrow();
  });

  it("projects the default bootstrap on a legacy service and refuses an unconfirmed response", async () => {
    const calls: RequestInit[] = [];
    const fetch = vi.fn(async (_url, init) => {
      calls.push(init!);
      return calls.length === 1 ? response(resource) : response({ ...receipt, configuration: { desired, observationRevision: "0", observationAccepted: false } });
    }) as typeof globalThis.fetch;
    const client = api(fetch);
    await client.getWorkerConfiguration(workerId);
    await client.reportWorkerConfiguration(workerId, report, { bootstrap: { ...networkValue, archiveSessions: true }, observation: null });
    expect(new Headers(calls[1]!.headers).get("Daynight-Worker-Archive-Sessions")).toBeNull();
    expect(JSON.parse(calls[1]!.body as string).configuration.bootstrap).not.toHaveProperty("archiveSessions");

    const operation = createOperation(); operations.push(operation);
    const capability = { supported: false };
    const archiveDesired = { ...networkDesired, value: { ...networkValue, archiveSessions: false } };
    const modernHeaders = { "Content-Type": "application/json", "Daynight-User-ID": userId, "Daynight-Worker-Configuration": "1", "Daynight-Worker-Archive-Sessions": "1", "Daynight-Worker-Tool-Paths": "2" };
    const broken = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ desired: archiveDesired, observationRevision: "0", observation: null }), { headers: modernHeaders }))
      .mockResolvedValueOnce(response({ ...receipt, configuration: { desired, observationRevision: "0", observationAccepted: false } }));
    const negotiated = createApiClient({ serverUrl: "http://localhost:8787", expectedUserId: userId, operation, fetch: broken, workerArchiveSessions: capability });
    await negotiated.getWorkerConfiguration(workerId);
    await expect(negotiated.reportWorkerConfiguration(workerId, report, { bootstrap: null, observation: null })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
    expect(capability.supported).toBe(false);
  });

  it("does not silently submit a new disabled bootstrap to an unsupported service", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => api(fetch).reportWorkerConfiguration(workerId, report, { bootstrap: { ...networkValue, archiveSessions: false }, observation: null })).toThrow("does not support disabling");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports an older server's 413 as a capacity refusal", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code: "payload_too_large", message: "Request body too large.", requestId: workerId } }), { status: 413, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } }));
    await expect(api(fetch).reportWorkerConfiguration(workerId, report, configuration)).rejects.toMatchObject({ status: 413, outcomeUnconfirmed: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retains the capacity status and unknown outcome for a non-JSON proxy 413", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("<h1>Too large</h1>", { status: 413, headers: { "Content-Type": "text/html" } }));
    await expect(api(fetch).reportWorkerConfiguration(workerId, report, configuration)).rejects.toMatchObject({ operation: "worker.configuration.report", status: 413, outcomeUnconfirmed: true, confirmedRefusal: false });
    expect(fetch).toHaveBeenCalledOnce();
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
    await expect(client.getWorkerConfiguration(workerId)).resolves.toEqual({ json: JSON.stringify(resource), desired: receivedDesired(networkDesired), observationRevision: "0", observationJson: null });
    await expect(client.reportWorkerConfiguration(workerId, report, configuration)).resolves.toEqual(receivedReceipt(receipt));
    await expect(client.reportWorker(workerId, report)).resolves.toEqual(legacy);
    expect(fetch.mock.calls.map(([, options]) => new Headers(options!.headers).get("Daynight-Worker-Configuration"))).toEqual(["1", "1", null]);
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual({ ...report, configuration: { ...configuration, toolPathsBootstrap: null } });
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
    await expect(api(fetch).reportWorkerConfiguration(workerId, report, { bootstrap: networkValue, observation: null })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true });
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
    await expect(api(fetch).reportWorkerConfiguration(workerId, report, configuration)).resolves.toEqual(receivedReceipt(rejected));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retains unknown report outcomes and rejects oversized outgoing configuration without dispatch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("connection closed"));
    await expect(api(fetch).reportWorkerConfiguration(workerId, report, configuration)).rejects.toMatchObject({ outcomeUnconfirmed: true });
    expect(fetch).toHaveBeenCalledOnce();
    const bounded = vi.fn<typeof globalThis.fetch>();
    expect(() => api(bounded).reportWorkerConfiguration(workerId, report, { bootstrap: { ...networkValue, native: { ...value.native, args: ["x".repeat(4097)] } }, observation: null })).toThrow(ProtocolError);
    expect(bounded).not.toHaveBeenCalled();
  });
});

describe("Worker prompt configuration sync", () => {
  const selectors = [{ key: { scope: "user" as const }, knownRevision: null }, { key: { scope: "worker" as const }, knownRevision: null }];
  const prompts = [
    { key: selectors[0]!.key, status: "value", value: { scope: "user", scopeId: userId, revision: "0", text: "", updatedAt: null } },
    { key: selectors[1]!.key, status: "value", value: { scope: "worker", scopeId: workerId, revision: "1", text: " x\n", updatedAt: time } },
  ];
  it("sends selectors on the same POST and returns the native and prompt results", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...receipt, configuration: { ...receipt.configuration, prompts } }, "2"));
    const result = await api(fetch).reportWorkerConfiguration(workerId, report, configuration, selectors);
    expect(result).toEqual({ ...receivedReceipt(receipt), prompts: { ok: true, results: prompts } });
    const headers = new Headers(fetch.mock.calls[0]![1]!.headers);
    expect(headers.get("Daynight-Worker-Configuration")).toBe("2");
    expect(JSON.parse(headers.get("Daynight-Worker-Prompts")!)).toEqual(selectors);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ ...report, configuration: { ...configuration, toolPathsBootstrap: null } });
  });
  it("retains the native receipt while refusing malformed prompt batches", async () => {
    const invalid = { ...receipt, configuration: { ...receipt.configuration, prompts: [{ ...prompts[0], value: { ...prompts[0]!.value, scopeId: workerId } }] } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(invalid, "2"));
    await expect(api(fetch).reportWorkerConfiguration(workerId, report, configuration, selectors)).resolves.toEqual({ ...receivedReceipt(receipt), prompts: { ok: false } });
    const duplicate = JSON.stringify({ ...receipt, configuration: { ...receipt.configuration, prompts } }).replace('"scope":"user"', '"scope":"user","scope":"user"');
    const raw = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(duplicate, { headers: { "Content-Type": "application/json", "Daynight-User-ID": userId, "Daynight-Worker-Configuration": "2", "Daynight-Worker-Tool-Paths": "2" } }));
    await expect(api(raw).reportWorkerConfiguration(workerId, report, configuration, selectors)).resolves.toEqual({ ...receivedReceipt(receipt), prompts: { ok: false } });
  });
  it("reads three worst-case escaped prompt values within the POST limit without lowering the operation budget", async () => {
    const project = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const requested = [...selectors, { key: { scope: "project" as const, projectId: project }, knownRevision: null }];
    const items = requested.map(({ key }, index) => ({ key, status: "value", value: { scope: key.scope, scopeId: index === 0 ? userId : index === 1 ? workerId : project, revision: "1", text: `PLACEHOLDER${index}`, updatedAt: time } }));
    let body = JSON.stringify({ ...receipt, configuration: { ...receipt.configuration, prompts: items } });
    for (let index = 0; index < 3; index++) body = body.replace(`PLACEHOLDER${index}`, "\\u0026".repeat(1_048_400));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(resource)).mockResolvedValueOnce(new Response(body, { headers: { "Content-Type": "application/json", "Daynight-User-ID": userId, "Daynight-Worker-Configuration": "2", "Daynight-Worker-Tool-Paths": "2" } }));
    const operation = createOperation(); operations.push(operation);
    operation.consume(35 * 1_048_576);
    const client = createApiClient({ serverUrl: "http://localhost:8787", serverToken: "fixture-token", expectedUserId: userId, operation, fetch });
    await client.getWorkerConfiguration(workerId);
    const result = await client.reportWorkerConfiguration(workerId, report, configuration, requested);
    expect(result.prompts?.ok).toBe(true);
    if (result.prompts?.ok) expect(result.prompts.results.map(item => item.status === "value" ? item.value.text.length : 0)).toEqual([1_048_400, 1_048_400, 1_048_400]);
  });
  it("refuses principal or capability mismatches and invalid outgoing selectors", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...receipt, configuration: { ...receipt.configuration, prompts } }, "1"));
    await expect(api(fetch).reportWorkerConfiguration(workerId, report, configuration, selectors)).rejects.toMatchObject({ phase: "protocol" });
    const changed = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...receipt, configuration: { ...receipt.configuration, prompts } }, "2", workerId));
    await expect(api(changed).reportWorkerConfiguration(workerId, report, configuration, selectors)).rejects.toMatchObject({ phase: "protocol" });
    expect(() => api(fetch).reportWorkerConfiguration(workerId, report, configuration, [selectors[0]!, selectors[0]!])).toThrow(ProtocolError);
  });
});
