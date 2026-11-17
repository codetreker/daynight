import { describe, expect, it } from "vitest";
import { parseWorkerCloudValue, parseWorkerCloudReport } from "../../src/api/worker-configuration.js";

const value = { maxConcurrent: 2, pollIntervalMs: 1000, recoveryLimit: 3, preferPlatformSpecificTasks: false, native: { agent: "codex", model: null, args: [] }, projects: [] };
const paths = { codex: { kind: "path", path: "/opt/工具 codex" }, copilot: null };

describe("Worker tool choices", () => {
  it("retains independent unadopted, automatic and explicit choices", () => {
    expect(parseWorkerCloudValue({ ...value, toolPaths: paths })).toEqual({ ...value, toolPaths: paths });
  });
  it("requires both choices and rejects extensions", () => {
    expect(() => parseWorkerCloudValue(value)).toThrow();
    expect(() => parseWorkerCloudValue({ ...value, toolPaths: { ...paths, extra: null } })).toThrow();
    expect(() => parseWorkerCloudValue({ ...value, toolPaths: { codex: paths.codex } })).toThrow();
  });
  it("accepts full bootstrap choices but never an unadopted bootstrap tool", () => {
    const bootstrap = { ...paths, copilot: { kind: "auto" } };
    const report = { bootstrap: null, observation: null, toolPathsBootstrap: bootstrap };
    expect(parseWorkerCloudReport(report)).toEqual(report);
    expect(() => parseWorkerCloudReport({ ...report, toolPathsBootstrap: paths })).toThrow();
  });
});

import { createApiClient } from "../../src/api/client.js";
import { createOperation } from "../../src/api/operation.js";
import { workerReportBody } from "../../src/api/worker-report.js";
import { boundToolPathTelemetry, parseToolPathTelemetry, type ToolPathTelemetry, type ToolPathObservation, type ToolPathActual } from "../../src/api/worker-tool-paths.js";
import { workerTelemetry } from "../fixtures/worker-telemetry.js";
const time = "2026-11-11T00:00:00Z";
const actual = (key = "a".repeat(64), path = "/opt/codex"): ToolPathActual => ({ selection: {kind:"path",path}, selectionKey:key, entryPath:path, executablePath:path, interpreterPath:null, source:"explicit", version:"1.2.3",checkedAt:time });
const entry = (): ToolPathObservation => ({ tool:"codex",context:"web",configurationSource:"cloud",targetRevision:"1",target:{kind:"path",path:"/opt/codex"},state:"applied",reason:null,actual:actual(),candidate:null,activeSelectionCount:0,activeSelectionsComplete:true,activeObservationError:null,activeSelections:[],error:null });
const telemetry = (entries: readonly ToolPathObservation[] = [entry()]): ToolPathTelemetry => ({schemaVersion:1,observedAt:time,entries});

describe("tool facts and report capacity", () => {
  it("keeps new admission, candidate and old running selections distinct", () => {
    const observation = {...entry(),candidate:actual("b".repeat(64),"/opt/new"),activeSelectionCount:1,activeSelections:[{actual:actual("c".repeat(64),"/opt/old"),executionCount:2,instanceCount:null,unconfirmedCount:1}]};
    expect(parseToolPathTelemetry(telemetry([observation]))).toEqual(telemetry([observation]));
    expect(parseToolPathTelemetry(telemetry([{...entry(),activeSelectionCount:null,activeSelectionsComplete:false,activeObservationError:"legacy_tool_identity_missing"}]))).toBeDefined();
  });
  it("rejects malformed, contradictory and secret-bearing tool observations", () => {
    for (const invalid of [
      {...entry(),context:"unknown"}, {...entry(),tool:"unsupported",context:"web"}, {...entry(),targetRevision:"0"}, {...entry(),configurationSource:"local"},
      {...entry(),state:"not_checked"}, {...entry(),state:"error"}, {...entry(),reason:"active_instance"}, {...entry(),actual:null},
      {...entry(),target:{kind:"auto"}}, {...entry(),activeSelectionCount:null}, {...entry(),activeObservationError:"inventory_unavailable"},
      {...entry(),actual:{...actual(),argv:["secret"]}}, {...entry(),actual:{...actual(),selectionKey:"A".repeat(64)}},
      {...entry(),actual:{...actual(),checkedAt:"2026-11-11T00:00:00.000000001Z"}}, {...entry(),actual:{...actual(),version:"x".repeat(257)}},
      {...entry(),target:{kind:"path",path:"relative"}}, {...entry(),target:{kind:"path",path:"/"+"中".repeat(1366)}},
    ]) expect(() => parseToolPathTelemetry(telemetry([invalid as ToolPathObservation]))).toThrow();
    expect(() => parseToolPathTelemetry(telemetry([entry(),entry()]))).toThrow();
    const selected = {...entry(),activeSelectionCount:2,activeSelections:[{actual:actual(),executionCount:1,instanceCount:null,unconfirmedCount:0},{actual:actual(),executionCount:1,instanceCount:null,unconfirmedCount:0}]};
    expect(() => parseToolPathTelemetry(telemetry([selected]))).toThrow();
  });
  it("validates remote paths without reading the local filesystem", () => {
    const windows = actual("a".repeat(64),"C:\\Users\\工具\\codex.cmd");
    expect(parseToolPathTelemetry(telemetry([{...entry(),actual:windows,target:windows.selection}]),"windows")).toBeDefined();
    expect(() => parseToolPathTelemetry(telemetry([{...entry(),actual:windows,target:windows.selection}]),"linux")).toThrow();
    expect(() => parseToolPathTelemetry(telemetry(),"windows")).toThrow();
  });
  it("removes complete groups under the sub-budget without truncating paths", () => {
    const observation = {...entry(),activeSelectionCount:10,activeSelections:Array.from({length:10},(_,i)=>({actual:actual(i.toString(16).padStart(64,"0"),"/"+"x".repeat(4095)),executionCount:1,instanceCount:null,unconfirmedCount:0}))};
    const bounded = boundToolPathTelemetry(telemetry([observation]),20_000);
    expect(bounded.entries[0]!.activeSelectionCount).toBe(10);
    expect(bounded.entries[0]!.activeSelectionsComplete).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(20_000);
    expect(bounded.entries[0]!.activeSelections.every(group=>group.actual.entryPath.length===4096)).toBe(true);
    expect(parseToolPathTelemetry(bounded)).toEqual(bounded);
  });
  it("degrades only tools when their facts exceed the complete report budget", () => {
    const required = {...workerTelemetry,workingDirectory:"/"+"x".repeat(1_043_000),taskInventory:null};
    const facts = telemetry([{...entry(),actual:actual("a".repeat(64),"/"+"x".repeat(4095)),target:{kind:"path",path:"/"+"x".repeat(4095)}}]);
    const body = workerReportBody({...required,toolPaths:facts}).value;
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(1_048_576);
    expect(body.toolPaths?.entries[0]).toMatchObject({state:"pending",reason:"report_budget_exceeded",actual:null});
    expect(body.workingDirectory).toBe(required.workingDirectory);
    expect(facts.entries[0]!.state).toBe("applied");
  });
});

describe("tool protocol 2", () => {
  const user = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", worker = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  it("sends and validates the tool protocol on configuration and reports", async () => {
    const calls: RequestInit[] = [], operation = createOperation();
    const desired = { revision: "1", updatedAt: time, value: { ...value, toolPaths: paths } };
    const api = createApiClient({ serverUrl: "http://localhost:8787", expectedUserId: user, operation, fetch: async (_url, init) => {
      calls.push(init!); const get = init!.method === "GET";
      return new Response(JSON.stringify(get ? { desired, observationRevision: "0", observation: null } : { observedAt: time, lastReportedAt: time, configuration: { desired, observationRevision: "0", observationAccepted: false } }), { headers: { "Content-Type": "application/json", "Daynight-User-ID": user, "Daynight-Worker-Configuration": "1", "Daynight-Worker-Tool-Paths": "2" } });
    } });
    try {
      await api.getWorkerConfiguration(worker);
      await api.reportWorkerConfiguration(worker, { ...workerTelemetry, toolPaths: telemetry(), taskInventory: null }, { bootstrap: null, observation: null, toolPathsBootstrap: { codex: { kind: "auto" }, copilot: { kind: "auto" } } });
      expect(calls.map(call => new Headers(call.headers).get("Daynight-Worker-Tool-Paths"))).toEqual(["2", "2"]);
      expect(JSON.parse(calls[1]!.body as string).toolPaths).toEqual(telemetry());
    } finally { operation.dispose(); }
  });
});

it("uses the server JSON escaping budget for symbol-bearing paths", () => {
  const path = "/" + "<".repeat(4095);
  const selected = {...entry(),actual:actual("a".repeat(64),path),target:{kind:"path" as const,path},activeSelectionCount:8,activeSelections:Array.from({length:8},(_,i)=>({actual:actual(i.toString(16).padStart(64,"0"),path),executionCount:1,instanceCount:null,unconfirmedCount:0}))};
  const bounded=boundToolPathTelemetry(telemetry([selected]));
  expect(Buffer.byteLength(JSON.stringify(bounded).replaceAll("<","\\u003c"))).toBeLessThanOrEqual(256*1024);
  expect(bounded.entries[0]!.activeSelectionsComplete).toBe(false);
});

it("keeps a missing report protocol acknowledgement as an unconfirmed write", async () => {
  const operation = createOperation(), user = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", worker = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const api = createApiClient({ serverUrl: "http://localhost:8787", expectedUserId: user, operation, fetch: async () => new Response(JSON.stringify({ observedAt: time, lastReportedAt: time, configuration: { desired: null, observationRevision: "0", observationAccepted: false } }), { headers: { "Content-Type": "application/json", "Daynight-User-ID": user, "Daynight-Worker-Configuration": "1" } }) });
  try { await expect(api.reportWorkerConfiguration(worker, { ...workerTelemetry, taskInventory: null }, { bootstrap: null, observation: null, toolPathsBootstrap: null })).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: true }); }
  finally { operation.dispose(); }
});

it("retains a local budget result when even the target fallback cannot fit", () => {
  const required = {...workerTelemetry,workingDirectory:"/"+"x".repeat(1_047_600),taskInventory:null};
  const body = workerReportBody({...required,toolPaths:telemetry()});
  expect(body.value).not.toHaveProperty("toolPaths");
  expect(body.toolPathsBudget).toEqual({code:"report_budget_exceeded",omitted:true});
  expect(body.value.taskInventory).toBeNull();
});

it.each(["1", "2, 2", ""]) ("rejects malformed response capability %j", async header => {
  const operation = createOperation(), user = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const client = createApiClient({ serverUrl: "http://localhost:8787", expectedUserId: user, operation, fetch: async () => new Response(JSON.stringify({ desired: null, observationRevision: "0", observation: null }), { headers: { "Content-Type": "application/json", "Daynight-User-ID": user, "Daynight-Worker-Configuration": "1", "Daynight-Worker-Tool-Paths": header } }) });
  try { await expect(client.getWorkerConfiguration("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).rejects.toMatchObject({ phase: "protocol", outcomeUnconfirmed: false }); } finally { operation.dispose(); }
});

import path from "node:path";
import { parseLocalToolPaths } from "../../src/platform/tool-path-choice.js";
it.each([String.raw`\\?\C:\tools\codex.exe`, String.raw`\\.\C:\tools\codex.exe`])("round-trips an adopted Windows namespace path through cloud and telemetry: %s", selectedPath => {
  const local = parseLocalToolPaths({ codex: selectedPath }, path.win32);
  expect(parseWorkerCloudValue({ ...value, toolPaths: local }).toolPaths).toEqual(local);
  expect(parseWorkerCloudReport({ bootstrap: null, observation: null, toolPathsBootstrap: local }).toolPathsBootstrap).toEqual(local);
  const selected = actual("a".repeat(64), selectedPath);
  const report = telemetry([{ ...entry(), target: local.codex, actual: selected }]);
  expect(parseToolPathTelemetry(report, "windows")).toEqual(report);
});

it("retains a rejected foreign-platform desired target without accepting foreign actual paths", () => {
  const target = { kind: "path" as const, path: String.raw`C:\tools\codex.exe` };
  const failure = { ...entry(), target, state: "error" as const, error: { code: "invalid_path" as const, occurredAt: time }, actual: null };
  const report = telemetry([failure]);
  expect(parseToolPathTelemetry(report, "linux")).toEqual(report);
  expect(parseWorkerCloudValue({ ...value, toolPaths: { ...paths, codex: target } }).toolPaths?.codex).toEqual(target);
  const foreign = actual("a".repeat(64), target.path);
  for (const invalid of [{ ...failure, actual: foreign }, { ...failure, candidate: foreign }, { ...failure, activeSelectionCount: 1, activeSelections: [{ actual: foreign, executionCount: 1, instanceCount: null, unconfirmedCount: 0 }] }]) {
    expect(() => parseToolPathTelemetry(telemetry([invalid]), "linux")).toThrow();
  }
});
