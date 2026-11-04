import { afterEach, expect, test, vi } from "vitest";
import { createManagedAssistantRuntime } from "../../../src/commands/worker/bots/runtime.js";
import { ControllerStartupError } from "../../../src/commands/controller/startup.js";
import type { BotRecord } from "../../../src/commands/worker/bots/types.js";
vi.mock("node:timers/promises", () => ({ setTimeout: (ms: number, value: unknown, options?: {signal?: AbortSignal}) => new Promise((resolve, reject) => {
  const signal=options?.signal;
  if(signal?.aborted) {reject(signal.reason);return;}
  const abort=()=>{clearTimeout(timer);reject(signal?.reason);};
  const timer=setTimeout(()=>{signal?.removeEventListener("abort",abort);resolve(value);},ms);
  signal?.addEventListener("abort",abort,{once:true});
}) }));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
afterEach(()=>{vi.useRealTimers();});
const fixture=()=>{
  const owner={serverOrigin:"https://daynight.example",ownerUserId:id(1),workerId:id(2)};
  const records=[3,4].map(n=>({owner,botId:id(n),intent:null,observed:{id:id(n),version:"1",deletion:null,startupResult:{state:"pending",code:null}},definition:{},observedAt:1}) as BotRecord);
  const store={list:()=>records,get:(_owner:unknown,key:string)=>records.find(r=>r.botId===key)!,observe:(_owner:unknown,bot:any)=>{const r=records.find(r=>r.botId===bot.id)!;r.observed=bot;return r;}};
  const process={advance:vi.fn(async(_record:BotRecord)=>({startup:{state:"ready",reasonCode:"ready"},lifecycle:"ready",initialInputState:"not_required",nativeSessionId:id(7),error:null})),refreshGrant:vi.fn(async()=>{})};
  const api={report:vi.fn(async(r:BotRecord,result:any)=>({...r.observed,version:"2",startupResult:{state:result.state,code:result.code??null}}))};
  const remote={owner,list:vi.fn(async()=>records.map(r=>r.observed)),read:vi.fn(async(key:string)=>records.find(r=>r.botId===key)!.observed)};
  const reconcile=vi.fn(async()=>({observed:records.map(r=>r.botId),missing:[]})); const onError=vi.fn();
  const runtime=createManagedAssistantRuntime({owner,store:store as never,process:process as never,sessionApi:api as never,remote:remote as never,pollIntervalMs:60000,onError,inventory:{reconcile}});
  return {runtime,process,api,remote,records,reconcile,onError};
};

test("isolates failed Bots and reports ready only after Controller observation",async()=>{
  const f=fixture();f.process.advance.mockRejectedValueOnce(new Error("unavailable"));
  await f.runtime.tick(new AbortController().signal);
  expect(f.process.advance).toHaveBeenCalledTimes(2); expect(f.api.report.mock.calls.filter(c=>c[1].state==="ready")).toHaveLength(1);expect(f.onError).toHaveBeenCalled();
});
test("does not report ready from an initializing or failed Controller",async()=>{
  const f=fixture();f.process.advance.mockResolvedValue({lifecycle:"starting",initialInputState:"not_required",nativeSessionId:null,error:null} as never);
  await f.runtime.tick(new AbortController().signal);expect(f.api.report).not.toHaveBeenCalled();
});
test("keeps five-second discovery and thirty-second renewal independent of a slow Bot and task polling",async()=>{
  vi.useFakeTimers();const f=fixture(),abort=new AbortController();let release!:()=>void;
  f.process.advance.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({startup:{state:"ready",reasonCode:"ready"},lifecycle:"ready",initialInputState:"not_required",nativeSessionId:id(7),error:null});}));
  const running=f.runtime.run(abort.signal);await vi.advanceTimersByTimeAsync(31000);
  expect(f.reconcile.mock.calls.length).toBeGreaterThanOrEqual(7);expect(f.process.refreshGrant.mock.calls.length).toBeGreaterThanOrEqual(4);
  expect(f.process.advance.mock.calls.filter(call=>(call[0] as unknown as BotRecord).botId===id(3))).toHaveLength(1);
  abort.abort();release();await running;
});
test("a failed inventory read retains local responsibility without launching from stale definitions",async()=>{
  const f=fixture();f.reconcile.mockRejectedValueOnce(new Error("offline"));await expect(f.runtime.tick(new AbortController().signal)).rejects.toThrow("offline");
  expect(f.process.advance).not.toHaveBeenCalled();expect(f.records).toHaveLength(2);
});
test("deletion and missing authority prevent startup without deleting original records",async()=>{
  const f=fixture();f.remote.read.mockResolvedValue(null as never);await f.runtime.tick(new AbortController().signal);
  expect(f.process.advance).not.toHaveBeenCalled();expect(f.records).toHaveLength(2);
});


test("reconciles an unknown failure report and retries from durable startup failure on the next tick",async()=>{
  const f=fixture();f.records.splice(1);
  f.records[0]!.intent={sessionId:id(8)} as never;
  f.process.advance.mockRejectedValue(new ControllerStartupError({state:"failed",reasonCode:"controller_launch_failed"},"OS rejected spawn"));
  f.api.report.mockRejectedValueOnce(new Error("report connection failed"));
  await f.runtime.tick(new AbortController().signal);expect(f.records[0]!.observed.deletion===null && f.records[0]!.observed.startupResult.state).toBe("pending");
  await f.runtime.tick(new AbortController().signal);expect(f.records[0]!.observed).toMatchObject({startupResult:{state:"failed",code:"controller_launch_failed"}});
  expect(f.api.report).toHaveBeenCalledTimes(2);
});


test("does not report ready from native activity before initialization is confirmed",async()=>{
  const f=fixture();f.process.advance.mockResolvedValue({startup:{state:"starting",reasonCode:"initializing"},lifecycle:"ready",initialInputState:"not_required",nativeSessionId:id(7),error:null});
  await f.runtime.tick(new AbortController().signal);expect(f.api.report).not.toHaveBeenCalled();
});
