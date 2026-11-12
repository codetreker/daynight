import { describe, expect, it } from "vitest";
import { parseWorkerCloudValue, parseWorkerCloudReport } from "../../src/api/worker-configuration.js";

const value = { maxConcurrent: 2, pollIntervalMs: 1000, recoveryLimit: 3, preferPlatformSpecificTasks: false, native: { agent: "codex", model: null, args: [] }, projects: [] };
const paths = { codex: { kind: "path", path: "/opt/工具 codex" }, copilot: { kind: "auto" }, herdr: null };
const capabilities = { controlMode: false, toolPaths: true };

describe("negotiated Worker tool choices", () => {
  it("retains independent unadopted, automatic and explicit choices", () => {
    expect(parseWorkerCloudValue({ ...value, toolPaths: paths }, true, capabilities)).toEqual({ ...value, toolPaths: paths });
  });
  it("requires all negotiated choices and rejects extensions without negotiation", () => {
    expect(() => parseWorkerCloudValue({ ...value, toolPaths: paths })).toThrow();
    expect(() => parseWorkerCloudValue(value, true, capabilities)).toThrow();
    expect(() => parseWorkerCloudValue({ ...value, toolPaths: { ...paths, extra: null } }, true, capabilities)).toThrow();
    expect(() => parseWorkerCloudValue({ ...value, toolPaths: { codex: paths.codex, copilot: paths.copilot } }, true, capabilities)).toThrow();
  });
  it("accepts full bootstrap choices but never an unadopted bootstrap tool", () => {
    const bootstrap = { ...paths, herdr: { kind: "auto" } };
    const report = { bootstrap: null, observation: null, toolPathsBootstrap: bootstrap };
    expect(parseWorkerCloudReport(report, capabilities)).toEqual(report);
    expect(() => parseWorkerCloudReport({ ...report, toolPathsBootstrap: paths }, capabilities)).toThrow();
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
      {...entry(),context:"unknown"}, {...entry(),tool:"herdr",context:"web"}, {...entry(),targetRevision:"0"}, {...entry(),configurationSource:"local"},
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

describe("independent tool negotiation", () => {
  const user = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", worker = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  it("requires authenticated configuration confirmation before sending extensions", async () => {
    const calls: RequestInit[] = [], operation = createOperation();
    const desired = {revision:"1",updatedAt:time,value:{...value,toolPaths:paths}};
    const api = createApiClient({serverUrl:"http://localhost:8787",expectedUserId:user,operation,fetch:async (_url, init)=>{
      calls.push(init!); const get = init!.method === "GET";
      return new Response(JSON.stringify(get ? {desired,observationRevision:"0",observation:null} : {observedAt:time,lastReportedAt:time,configuration:{desired,observationRevision:"0",observationAccepted:false}}),{headers:{"Content-Type":"application/json","Daynight-User-ID":user,"Daynight-Worker-Configuration":"1","Daynight-Worker-Tool-Paths":"1"}});
    }});
    try {
      await api.getWorkerConfiguration(worker);
      await api.reportWorkerConfiguration(worker,{...workerTelemetry,toolPaths:telemetry(),taskInventory:null},{bootstrap:null,observation:null,toolPathsBootstrap:{codex:{kind:"auto"},copilot:{kind:"auto"},herdr:{kind:"auto"}}});
      expect(new Headers(calls[0]!.headers).get("Daynight-Worker-Tool-Paths")).toBe("1");
      expect(new Headers(calls[1]!.headers).get("Daynight-Worker-Tool-Paths")).toBe("1");
      expect(JSON.parse(calls[1]!.body as string).toolPaths).toEqual(telemetry());
      expect(JSON.parse(calls[1]!.body as string).configuration.toolPathsBootstrap).toBeDefined();
    } finally {operation.dispose();}
  });
});

it("uses the server JSON escaping budget for symbol-bearing paths", () => {
  const path = "/" + "<".repeat(4095);
  const selected = {...entry(),actual:actual("a".repeat(64),path),target:{kind:"path" as const,path},activeSelectionCount:8,activeSelections:Array.from({length:8},(_,i)=>({actual:actual(i.toString(16).padStart(64,"0"),path),executionCount:1,instanceCount:null,unconfirmedCount:0}))};
  const bounded=boundToolPathTelemetry(telemetry([selected]));
  expect(Buffer.byteLength(JSON.stringify(bounded).replaceAll("<","\\u003c"))).toBeLessThanOrEqual(256*1024);
  expect(bounded.entries[0]!.activeSelectionsComplete).toBe(false);
});

describe("configuration capability combinations and admission",()=>{
  const user="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", worker="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const tools={codex:{kind:"auto" as const},copilot:{kind:"auto" as const},herdr:{kind:"auto" as const}};
  it.each([false,true].flatMap(controlMode=>[false,true].flatMap(toolPaths=>[false,true].map(prompts=>({controlMode,toolPaths,prompts})))))
    ("projects mode=$controlMode tools=$toolPaths independently of prompts=$prompts",async ({controlMode,toolPaths,prompts})=>{
      const operation=createOperation(),calls:RequestInit[]=[];
      const desired={revision:"1",updatedAt:time,value:{...value,...(controlMode?{agentControlMode:"web"}:{}),...(toolPaths?{toolPaths:paths}:{})}};
      const api=createApiClient({serverUrl:"http://localhost:8787",expectedUserId:user,operation,fetch:async (_url,init)=>{
        calls.push(init!);const get=init!.method==="GET";
        return new Response(JSON.stringify(get?{desired,observationRevision:"0",observation:null}:{observedAt:time,lastReportedAt:time,configuration:{desired,observationRevision:"0",observationAccepted:false,...(prompts?{prompts:[]}: {})}}),{headers:{"Content-Type":"application/json","Daynight-User-ID":user,"Daynight-Worker-Configuration":get||!prompts?"1":"2",...(controlMode?{"Daynight-Worker-Control-Mode":"1"}:{}),...(toolPaths?{"Daynight-Worker-Tool-Paths":"1"}:{})}});
      }});
      try {
        await api.getWorkerConfiguration(worker);
        await api.reportWorkerConfiguration(worker,{...workerTelemetry,toolPaths:telemetry(),taskInventory:null},{bootstrap:null,observation:null,controlModeBootstrap:"web",toolPathsBootstrap:tools},prompts?[]:undefined);
        const body=JSON.parse(calls[1]!.body as string),headers=new Headers(calls[1]!.headers);
        expect(headers.get("Daynight-Worker-Control-Mode")).toBe(controlMode?"1":null);
        expect(headers.get("Daynight-Worker-Tool-Paths")).toBe(toolPaths?"1":null);
        expect(headers.get("Daynight-Worker-Configuration")).toBe(prompts?"2":"1");
        expect(Object.hasOwn(body,"toolPaths")).toBe(toolPaths);
        expect(Object.hasOwn(body.configuration,"toolPathsBootstrap")).toBe(toolPaths);
        expect(Object.hasOwn(body.configuration,"controlModeBootstrap")).toBe(controlMode);
      } finally {operation.dispose();}
    });
  it.each(["http://localhost:8788", "http://localhost:8787"])("does not reuse tool capability across an origin or principal change (%s)",async origin=>{
    const operation=createOperation(),calls:RequestInit[]=[];
    const cache={supported:true,serverOrigin:"http://localhost:8787",userId:origin.endsWith("8787")?worker:user};
    const api=createApiClient({serverUrl:origin,expectedUserId:user,workerToolPaths:cache,operation,fetch:async (_url,init)=>{
      calls.push(init!);return new Response(JSON.stringify({observedAt:time,lastReportedAt:time,configuration:{desired:null,observationRevision:"0",observationAccepted:false}}),{headers:{"Content-Type":"application/json","Daynight-User-ID":user,"Daynight-Worker-Configuration":"1"}});
    }});
    try { await api.reportWorkerConfiguration(worker,{...workerTelemetry,taskInventory:null,toolPaths:telemetry()},{bootstrap:null,observation:null,toolPathsBootstrap:tools});
      expect(new Headers(calls[0]!.headers).get("Daynight-Worker-Tool-Paths")).toBeNull();
      expect(JSON.parse(calls[0]!.body as string)).not.toHaveProperty("toolPaths");
    } finally {operation.dispose();}
  });
  it("keeps a missing report capability acknowledgement as an unconfirmed write",async()=>{
    const operation=createOperation();let calls=0;
    const api=createApiClient({serverUrl:"http://localhost:8787",expectedUserId:user,operation,fetch:async ()=>{
      calls++;return new Response(JSON.stringify(calls===1?{desired:null,observationRevision:"0",observation:null}:{observedAt:time,lastReportedAt:time,configuration:{desired:null,observationRevision:"0",observationAccepted:false}}),{headers:{"Content-Type":"application/json","Daynight-User-ID":user,"Daynight-Worker-Configuration":"1",...(calls===1?{"Daynight-Worker-Tool-Paths":"1"}:{})}});
    }});
    try {await api.getWorkerConfiguration(worker);await expect(api.reportWorkerConfiguration(worker,{...workerTelemetry,taskInventory:null},{bootstrap:null,observation:null,toolPathsBootstrap:tools})).rejects.toMatchObject({phase:"protocol",outcomeUnconfirmed:true});expect(calls).toBe(2);}
    finally {operation.dispose();}
  });
});

it("retains a local budget result when even the target fallback cannot fit", () => {
  const required = {...workerTelemetry,workingDirectory:"/"+"x".repeat(1_047_600),taskInventory:null};
  const body = workerReportBody({...required,toolPaths:telemetry()});
  expect(body.value).not.toHaveProperty("toolPaths");
  expect(body.toolPathsBudget).toEqual({code:"report_budget_exceeded",omitted:true});
  expect(body.value.taskInventory).toBeNull();
});

it("retains tool capability from an authenticated missing configuration across clients", async () => {
  const user="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",worker="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operation=createOperation();
  const cache={supported:false},calls:RequestInit[]=[];
  const fetch:typeof globalThis.fetch=async (_url,init)=>{calls.push(init!);return new Response(JSON.stringify(calls.length===1?{error:{code:"not_found",message:"missing",requestId:worker}}:{observedAt:time,lastReportedAt:time,configuration:{desired:null,observationRevision:"0",observationAccepted:false}}),{status:calls.length===1?404:200,headers:{"Content-Type":"application/json","Daynight-User-ID":user,"Daynight-Worker-Configuration":"1","Daynight-Worker-Tool-Paths":"1"}});};
  const client=()=>createApiClient({serverUrl:"http://localhost:8787",expectedUserId:user,workerToolPaths:cache,operation,fetch});
  try {await expect(client().getWorkerConfiguration(worker)).rejects.toMatchObject({status:404});await client().reportWorkerConfiguration(worker,{...workerTelemetry,taskInventory:null},{bootstrap:null,observation:null,toolPathsBootstrap:null});expect(new Headers(calls[1]!.headers).get("Daynight-Worker-Tool-Paths")).toBe("1");}
  finally {operation.dispose();}
});

it.each(["2","1, 1",""])("rejects malformed response capability %j",async header=>{
  const operation=createOperation(),user="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const client=createApiClient({serverUrl:"http://localhost:8787",expectedUserId:user,operation,fetch:async()=>new Response(JSON.stringify({desired:null,observationRevision:"0",observation:null}),{headers:{"Content-Type":"application/json","Daynight-User-ID":user,"Daynight-Worker-Configuration":"1","Daynight-Worker-Tool-Paths":header}})});
  try {await expect(client.getWorkerConfiguration("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).rejects.toMatchObject({phase:"protocol",outcomeUnconfirmed:false});} finally {operation.dispose();}
});

import path from "node:path";
import { parseLocalToolPaths } from "../../src/platform/tool-path-choice.js";
it.each([String.raw`\\?\C:\tools\codex.exe`, String.raw`\\.\C:\tools\codex.exe`])("round-trips an adopted Windows namespace path through cloud and telemetry: %s", selectedPath => {
  const local = parseLocalToolPaths({ codex: selectedPath }, path.win32);
  expect(parseWorkerCloudValue({ ...value, toolPaths: local }, true, capabilities).toolPaths).toEqual(local);
  expect(parseWorkerCloudReport({ bootstrap: null, observation: null, toolPathsBootstrap: local }, capabilities).toolPathsBootstrap).toEqual(local);
  const selected = actual("a".repeat(64), selectedPath);
  const report = telemetry([{ ...entry(), target: local.codex, actual: selected }]);
  expect(parseToolPathTelemetry(report, "windows")).toEqual(report);
});

it("retains a rejected foreign-platform desired target without accepting foreign actual paths", () => {
  const target = { kind: "path" as const, path: String.raw`C:\tools\codex.exe` };
  const failure = { ...entry(), target, state: "error" as const, error: { code: "invalid_path" as const, occurredAt: time }, actual: null };
  const report = telemetry([failure]);
  expect(parseToolPathTelemetry(report, "linux")).toEqual(report);
  expect(parseWorkerCloudValue({ ...value, toolPaths: { ...paths, codex: target } }, true, capabilities).toolPaths?.codex).toEqual(target);
  const foreign = actual("a".repeat(64), target.path);
  for (const invalid of [{ ...failure, actual: foreign }, { ...failure, candidate: foreign }, { ...failure, activeSelectionCount: 1, activeSelections: [{ actual: foreign, executionCount: 1, instanceCount: null, unconfirmedCount: 0 }] }]) {
    expect(() => parseToolPathTelemetry(telemetry([invalid]), "linux")).toThrow();
  }
});
