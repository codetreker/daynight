import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWorkerConfiguration, parseWorkerConfiguration, saveWorkerConfiguration } from '../src/api/worker-configuration';
import { getWorker, parseWorkerDetail } from '../src/api/workers';
import { invalidateAuthRequests } from '../src/api/client';
import { configurationResource, configurationValue, configurationResponse } from './helpers/worker-configuration';
import { WORKER_USER, workerId, workerDetail, workerResponse } from './helpers/workers';
const paths = {codex:{kind:'path' as const,path:'/opt/codex'},copilot:{kind:'auto' as const}};
const admission = () => ({userId:WORKER_USER,onPrincipalMismatch:vi.fn()});
afterEach(()=>{invalidateAuthRequests();vi.unstubAllGlobals();});

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
  const adopted={codex:{kind:'path' as const,path},copilot:{kind:'auto' as const}};
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
