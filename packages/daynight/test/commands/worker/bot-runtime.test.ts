import { afterEach, expect, test, vi } from "vitest";
import { createManagedAssistantRuntime } from "../../../src/commands/worker/bots/runtime.js";
import { BotAdmissionBlockedError } from "../../../src/commands/worker/bots/process.js";
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
const fixture=(pollIntervalMs: number | (() => number) = 60000, assistantTasks?: Parameters<typeof createManagedAssistantRuntime>[0]["assistantTasks"])=>{
  const owner={serverOrigin:"https://daynight.example",ownerUserId:id(1),workerId:id(2)};
  const records=[3,4].map(n=>({owner,botId:id(n),intent:null,observed:{id:id(n),version:"1",deletion:null,startupResult:{state:"pending",code:null}},definition:{},observedAt:1}) as BotRecord);
  const store={list:()=>records,get:(_owner:unknown,key:string)=>records.find(r=>r.botId===key)!,observe:(_owner:unknown,bot:any)=>{const r=records.find(r=>r.botId===bot.id)!;r.observed=bot;return r;}};
  const process={advance:vi.fn(async(_record:BotRecord)=>({startup:{state:"ready",reasonCode:"ready"},lifecycle:"ready",initialInputState:"not_required",nativeSessionId:id(7),error:null})),refreshGrant:vi.fn(async()=>{}),shutdown:vi.fn(async()=>{})};
  const api={report:vi.fn(async(r:BotRecord,result:any)=>({...r.observed,version:"2",startupResult:{state:result.state,code:result.code??null}}))};
  const remote={owner,list:vi.fn(async()=>records.map(r=>r.observed)),read:vi.fn(async(key:string)=>records.find(r=>r.botId===key)!.observed)};
  const reconcile=vi.fn(async()=>({observed:records.map(r=>r.botId),missing:[]})); const onError=vi.fn();
  const deletion={advance:vi.fn(async(_record:BotRecord,_signal:AbortSignal)=>{})};
  let admission = true;
  const runtime=createManagedAssistantRuntime({owner,store:store as never,process:process as never,sessionApi:api as never,remote:remote as never,pollIntervalMs,onError,deletion,...(assistantTasks === undefined ? {} : { assistantTasks }),inventory:{reconcile},canAdmitNewExecution:()=>admission});
  return {runtime,process,api,remote,records,reconcile,onError,deletion,setAdmission:(value:boolean)=>{admission=value;}};
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


test("shutdown joins an in-flight Bot launch before stopping every local writer and retains failures", async () => {
  const f = fixture(), signal = new AbortController().signal;
  let release!: () => void;
  f.process.advance.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({startup:{state:"ready",reasonCode:"ready"},lifecycle:"ready",initialInputState:"not_required",nativeSessionId:id(7),error:null}); }));
  const tick = f.runtime.tick(signal);
  await vi.waitFor(() => expect(f.process.advance).toHaveBeenCalledTimes(2));
  f.process.shutdown.mockRejectedValueOnce(new Error("Bot original writer cannot be proved stopped"));
  const shuttingDown = f.runtime.shutdown();
  const rejected = expect(shuttingDown).rejects.toThrow(/Bot.*shutdown/i);
  await Promise.resolve(); expect(f.process.shutdown).not.toHaveBeenCalled();
  release(); await tick; await rejected;
  expect(f.process.shutdown).toHaveBeenCalledTimes(2);
  await expect(f.runtime.tick(signal)).rejects.toThrow(/closing|closed|shutdown/i);
});

test("cancelling the managed loop stops all Bots with a fresh cleanup signal", async () => {
  vi.useFakeTimers(); const f = fixture(), cancellation = new AbortController();
  const running = f.runtime.run(cancellation.signal); await vi.advanceTimersByTimeAsync(1);
  cancellation.abort(); await running;
  expect(f.process.shutdown).toHaveBeenCalledTimes(2);
  for (const call of f.process.shutdown.mock.calls as unknown as [BotRecord, AbortSignal][]) expect(call[1].aborted).toBe(false);
});


test("routes deleting inventory through its deletion owner while other Bots continue",async()=>{
 const f=fixture(); f.records[0]!.observed={...f.records[0]!.observed,deletion:{deletionId:id(80),requestedVersion:"1",workerCleanup:{state:"pending",code:null},serverCleanup:{state:"pending",code:null}}};
 await f.runtime.tick(new AbortController().signal);
 expect(f.deletion.advance).toHaveBeenCalledTimes(1);expect(f.deletion.advance.mock.calls[0]![0].botId).toBe(id(3));
 expect(f.process.advance).toHaveBeenCalledTimes(1);expect(f.process.advance.mock.calls[0]![0].botId).toBe(id(4));
});
test("retains deletion errors for retry and continues the other Bot",async()=>{
 const f=fixture();f.records[0]!.observed={...f.records[0]!.observed,deletion:{deletionId:id(80),requestedVersion:"1",workerCleanup:{state:"pending",code:null},serverCleanup:{state:"pending",code:null}}};
 f.deletion.advance.mockRejectedValueOnce(new Error("permission denied"));
 await f.runtime.tick(new AbortController().signal);expect(f.onError).toHaveBeenCalledWith("permission denied",id(3));
 await f.runtime.tick(new AbortController().signal);expect(f.deletion.advance).toHaveBeenCalledTimes(2);expect(f.process.advance).toHaveBeenCalledTimes(2);
});

test("uses updated discovery intervals without replacing its runtime or stopping Bots", async () => {
  vi.useFakeTimers(); let interval = 1000; const f = fixture(() => interval), cancellation = new AbortController();
  const running = f.runtime.run(cancellation.signal); await vi.advanceTimersByTimeAsync(1000);
  expect(f.reconcile).toHaveBeenCalledTimes(2);
  interval = 2000; await vi.advanceTimersByTimeAsync(1000);
  expect(f.reconcile).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1999); expect(f.reconcile).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1); expect(f.reconcile).toHaveBeenCalledTimes(4);
  expect(f.process.shutdown).not.toHaveBeenCalled();
  cancellation.abort(); await running;
});

test("keeps new Bots waiting without a startup failure while admission is closed", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.setAdmission(false);
  await f.runtime.tick(signal);
  expect(f.process.advance).not.toHaveBeenCalled();
  expect(f.api.report).not.toHaveBeenCalled();
  expect(f.onError).not.toHaveBeenCalled();
  expect(f.records.every(record => record.observed.deletion === null && record.observed.startupResult.state === "pending")).toBe(true);
  f.setAdmission(true);
  await f.runtime.tick(signal);
  expect(f.process.advance).toHaveBeenCalledTimes(2);
  expect(f.api.report).toHaveBeenCalledTimes(2);
});

test("does not turn a mid-preparation admission block into environment failure", async () => {
  const f = fixture(); f.records.splice(1);
  f.process.advance.mockRejectedValueOnce(new BotAdmissionBlockedError());
  await f.runtime.tick(new AbortController().signal);
  expect(f.api.report).not.toHaveBeenCalled();
  expect(f.onError).not.toHaveBeenCalled();
  const observed = f.records[0]!.observed;
  expect(observed.deletion).toBeNull();
  if (observed.deletion !== null) throw new Error("A waiting Bot must remain live.");
  expect(observed.startupResult.state).toBe("pending");
});

test("continues original execution observation and deletion while new admission is closed", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.records[0]!.intent = { sessionId: id(8), nativeSessionId: id(9) } as never;
  f.records[1]!.observed = { ...f.records[1]!.observed, deletion: { deletionId: id(80), requestedVersion: "1", workerCleanup: { state: "pending", code: null }, serverCleanup: { state: "pending", code: null } } };
  f.setAdmission(false);
  await f.runtime.tick(signal);
  expect(f.process.advance).toHaveBeenCalledOnce();
  expect(f.process.advance.mock.calls[0]![0].botId).toBe(id(3));
  expect(f.deletion.advance).toHaveBeenCalledOnce();
  expect(f.deletion.advance.mock.calls[0]![0].botId).toBe(id(4));
  await f.runtime.shutdown();
  expect(f.process.shutdown).toHaveBeenCalledTimes(2);
});


test("runs assistant-task maintenance and joins its applications before stopping Controllers", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const joined = new Promise<void>(resolve => { release = resolve; });
  const assistantTasks = {
    run: vi.fn((signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))),
    shutdown: vi.fn(() => joined),
    stopBot: vi.fn(async (_botId: string) => {}),
  };
  const f = fixture(60000, assistantTasks as never), cancellation = new AbortController();
  const running = f.runtime.run(cancellation.signal);
  await vi.advanceTimersByTimeAsync(1);
  expect(assistantTasks.run).toHaveBeenCalledOnce();
  cancellation.abort();
  await vi.advanceTimersByTimeAsync(1);
  expect(assistantTasks.shutdown).toHaveBeenCalledOnce();
  expect(f.process.shutdown).not.toHaveBeenCalled();
  release(); await running;
  expect(f.process.shutdown).toHaveBeenCalledTimes(2);
});

test("retains assistant-task shutdown failure while still stopping every Controller", async () => {
  const assistantTasks = { shutdown: vi.fn(async () => { throw new Error("Application cleanup unconfirmed"); }), stopBot: vi.fn(async (_botId: string) => {}) };
  const f = fixture(60000, assistantTasks as never);
  await expect(f.runtime.shutdown()).rejects.toThrow(/shutdown/);
  expect(assistantTasks.shutdown).toHaveBeenCalledOnce();
  expect(f.process.shutdown).toHaveBeenCalledTimes(2);
});


test("joins assistant-task writes before deleting a Bot's private state", async () => {
  let release!: () => void;
  const stopped = new Promise<void>(resolve => { release = resolve; });
  const assistantTasks = { stopBot: vi.fn((_botId: string) => stopped) };
  const f = fixture(60000, assistantTasks as never);
  f.records[0]!.observed = { ...f.records[0]!.observed, deletion: { deletionId: id(80), requestedVersion: "1", workerCleanup: { state: "pending", code: null }, serverCleanup: { state: "pending", code: null } } };
  const tick = f.runtime.tick(new AbortController().signal);
  await vi.waitFor(() => expect(assistantTasks.stopBot).toHaveBeenCalledWith(id(3)));
  expect(f.deletion.advance).not.toHaveBeenCalled();
  release(); await tick;
  expect(f.deletion.advance).toHaveBeenCalledOnce();
  expect(f.deletion.advance.mock.calls[0]![0].botId).toBe(id(3));
});
