import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWorkerConfiguration, parseWorkerConfiguration, saveWorkerConfiguration } from '../src/api/worker-configuration';
import { getWorker, parseWorkerDetail } from '../src/api/workers';
import { invalidateAuthRequests } from '../src/api/client';
import { configurationResource, configurationValue, configurationResponse } from './helpers/worker-configuration';
import { WORKER_USER, workerId, workerDetail, workerResponse } from './helpers/workers';
const paths = {codex:{kind:'path' as const,path:'/opt/codex'},copilot:{kind:'auto' as const},herdr:null};
const admission = () => ({userId:WORKER_USER,onPrincipalMismatch:vi.fn()});
afterEach(()=>{invalidateAuthRequests();vi.unstubAllGlobals();});

describe('explicit tool API capability',()=>{
  it('parses the tool extension independently from control mode',()=>{
    const resource = configurationResource('1',{...configurationValue(),toolPaths:paths});
    expect(parseWorkerConfiguration(resource,{controlMode:false,toolPaths:true}).desired?.value.toolPaths).toEqual(paths);
    expect(()=>parseWorkerConfiguration(resource)).toThrow();
  });
  it('keeps existing forms on the legacy projection and enables tools only for admitted callers',async()=>{
    const response = configurationResponse(configurationResource('1',{...configurationValue(),toolPaths:paths}));
    response.headers.set('Daynight-Worker-Tool-Paths','1');
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockResolvedValueOnce(response);
    vi.stubGlobal('fetch',fetch);const signal=new AbortController().signal;
    await getWorkerConfiguration(workerId(1),signal,admission());
    const result=await getWorkerConfiguration(workerId(1),signal,{...admission(),toolPathsSupported:true});
    expect(new Headers(fetch.mock.calls[0]![1].headers).has('Daynight-Worker-Tool-Paths')).toBe(false);
    expect(new Headers(fetch.mock.calls[1]![1].headers).get('Daynight-Worker-Tool-Paths')).toBe('1');
    expect(result.toolPathsSupported).toBe(true);
  });
  it('projects an old save without clearing cloud tools or sending their extension',async()=>{
    const fetch=vi.fn().mockResolvedValue(configurationResponse(configurationResource('2')));vi.stubGlobal('fetch',fetch);
    await saveWorkerConfiguration(workerId(1),'1',{...configurationValue(),toolPaths:paths},new AbortController().signal,admission());
    expect(JSON.parse(fetch.mock.calls[0]![1].body).value).not.toHaveProperty('toolPaths');
    expect(new Headers(fetch.mock.calls[0]![1].headers).has('Daynight-Worker-Tool-Paths')).toBe(false);
  });
  it('reads tool observations only after the detail response confirms capability',async()=>{
    const facts={schemaVersion:1,observedAt:'2026-11-11T00:00:00Z',entries:[]};
    const detail=workerDetail();const current={...detail,worker:{...detail.worker,telemetry:{...detail.worker.telemetry,toolPaths:facts}}};
    expect(()=>parseWorkerDetail(current,workerId(1))).toThrow();
    expect(parseWorkerDetail(current,workerId(1),true).worker.telemetry.toolPaths).toEqual(facts);
    const response=workerResponse(current);response.headers.set('Daynight-Worker-Tool-Paths','1');
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response));
    expect((await getWorker(workerId(1),new AbortController().signal,admission())).worker.telemetry.toolPaths).toEqual(facts);
  });
});

import { parseToolPathTelemetry, toolPathTelemetryBytes } from '../src/api/worker-tool-paths';
it('validates public tool facts and rejects secret fields and inconsistent evidence',()=>{
  const time='2026-11-11T00:00:00Z';
  const actual={selection:{kind:'path',path:'/opt/codex'},selectionKey:'a'.repeat(64),entryPath:'/opt/codex',executablePath:'/opt/codex',interpreterPath:null,source:'explicit',version:'1.2.3',checkedAt:time};
  const entry={tool:'codex',context:'web',configurationSource:'cloud',targetRevision:'1',target:actual.selection,state:'applied',reason:null,actual,candidate:null,activeSelectionCount:0,activeSelectionsComplete:true,activeObservationError:null,activeSelections:[],error:null};
  const report={schemaVersion:1,observedAt:time,entries:[entry]};
  expect(parseToolPathTelemetry(report)).toEqual(report);
  for(const changed of [{...entry,actual:{...actual,argv:['secret']}},{...entry,state:'not_checked'},{...entry,target:{kind:'auto'}},{...entry,activeSelectionCount:null},{...entry,actual:{...actual,version:'x'.repeat(257)}},{...entry,actual:{...actual,checkedAt:'2026-11-11T00:00:00.000000001Z'}}]) expect(()=>parseToolPathTelemetry({...report,entries:[changed]})).toThrow();
  expect(()=>parseToolPathTelemetry({...report,entries:[entry,entry]})).toThrow();
  const parsed=parseToolPathTelemetry({...report,entries:[{...entry,actual:{...actual,entryPath:'/a<b'}}]});
  expect(toolPathTelemetryBytes(parsed)).toBe(new TextEncoder().encode(JSON.stringify(parsed).replaceAll('<','\\u003c')).byteLength);
});

it.each([String.raw`\\?\C:\tools\codex.exe`, String.raw`\\.\C:\tools\codex.exe`])('accepts adopted Windows namespace choices in configuration and telemetry: %s',path=>{
  const adopted={codex:{kind:'path' as const,path},copilot:{kind:'auto' as const},herdr:{kind:'auto' as const}};
  const resource=configurationResource('1',{...configurationValue(),toolPaths:adopted});
  expect(parseWorkerConfiguration(resource,{controlMode:false,toolPaths:true}).desired?.value.toolPaths).toEqual(adopted);
  const time='2026-11-11T00:00:00Z';
  const actual={selection:adopted.codex,selectionKey:'a'.repeat(64),entryPath:path,executablePath:path,interpreterPath:null,source:'explicit',version:'1.2.3',checkedAt:time};
  const entry={tool:'codex',context:'web',configurationSource:'cloud',targetRevision:'1',target:adopted.codex,state:'applied',reason:null,actual,candidate:null,activeSelectionCount:0,activeSelectionsComplete:true,activeObservationError:null,activeSelections:[],error:null};
  const report={schemaVersion:1,observedAt:time,entries:[entry]};
  expect(parseToolPathTelemetry(report,'windows')).toEqual(report);
});

it('keeps a foreign-platform desired target visible as invalid_path while rejecting foreign actual evidence',()=>{
  const time='2026-11-11T00:00:00Z',target={kind:'path' as const,path:String.raw`C:\tools\codex.exe`};
  const entry={tool:'codex',context:'web',configurationSource:'cloud',targetRevision:'1',target,state:'error',reason:null,actual:null,candidate:null,activeSelectionCount:0,activeSelectionsComplete:true,activeObservationError:null,activeSelections:[],error:{code:'invalid_path',occurredAt:time}};
  const report={schemaVersion:1,observedAt:time,entries:[entry]};
  expect(parseToolPathTelemetry(report,'linux')).toEqual(report);
  const actual={selection:target,selectionKey:'a'.repeat(64),entryPath:target.path,executablePath:target.path,interpreterPath:null,source:'explicit',version:'1.2.3',checkedAt:time};
  for(const invalid of [{...entry,actual},{...entry,candidate:actual},{...entry,activeSelectionCount:1,activeSelections:[{actual,executionCount:1,instanceCount:null,unconfirmedCount:0}]}]) expect(()=>parseToolPathTelemetry({...report,entries:[invalid]},'linux')).toThrow();
});
