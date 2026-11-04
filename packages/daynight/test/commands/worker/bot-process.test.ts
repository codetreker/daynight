import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openBotStore } from "../../../src/commands/worker/bots/store.js";
import { openBotExecutionStore } from "../../../src/commands/worker/bots/execution-store.js";
import { createBotProcess } from "../../../src/commands/worker/bots/process.js";
import type { BotDefinition, BotRecord } from "../../../src/commands/worker/bots/types.js";
import { ControllerStartupError } from "../../../src/commands/controller/startup.js";
import { openControllerLifecycleStore } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { resolveConfigurationPaths } from "../../../src/config/paths.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const cleanups: (()=>void)[] = [];
afterEach(()=>{ vi.unstubAllEnvs(); for(const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const fixture = (provider: "codex"|"claude"|"copilot" = "codex") => {
  const root=path.resolve(import.meta.dirname,"../../../../../.tmp/bot-process"); mkdirSync(root,{recursive:true});
  const home=mkdtempSync(path.join(root,"h-")); cleanups.push(()=>rmSync(home,{recursive:true,force:true})); vi.stubEnv("DN_CONFIG_DIR",path.join(home,"state"));
  const file=path.join(home,"state.sqlite"), store=openBotStore(file,{onMigration:()=>{}}), executions=openBotExecutionStore(file,{onMigration:()=>{}}); cleanups.push(()=>store.close(),()=>executions.close());
  const owner={serverOrigin:"https://daynight.example",ownerUserId:id(1),workerId:id(2)};
  let bot:BotDefinition={id:id(3),workerId:id(2),ownerUserId:id(1),version:"1",name:"Only a name",creationOrder:"1",requestedOverrides:{},resolvedConfiguration:{workerId:id(2),cwd:home,provider,model:null,args:[]},roleConfiguration:null,sessionId:null,testExecutionId:null,startupResult:{state:"pending",code:null},deletion:null,createdAt:"2026-11-05T00:00:00Z",updatedAt:"2026-11-05T00:00:00Z"};
  store.observe(owner,bot,1);
  const current=()=>store.get(owner,bot.id)!;
  const snapshot=(ticket:ControllerLaunchTicket):ControllerSnapshot=>({executionId:ticket.executionId,testExecutionId:ticket.executionId,sessionId:ticket.sessionId,executionGeneration:ticket.executionGeneration,controllerInstanceId:ticket.controllerInstanceId,lifecycle:"ready",nativeSessionId:id(9),initialInputState:"not_required",activity:"idle",currentTurnId:null,capabilities:{send:true,steer:false,cancel:false,respond:true},controllerProcess:null,nativeProcesses:[],nativeStopped:false,stoppedAt:null,error:null,startup:{state:"ready",reasonCode:"ready"}});
  const register=vi.fn(async(record:BotRecord)=>{expect(current().intent?.roleConfiguration).not.toBeNull(); expect(record.intent?.roleConfiguration).toEqual(current().intent?.roleConfiguration); bot={...bot,version:"2",sessionId:id(4),testExecutionId:record.intent!.executionId,roleConfiguration:record.intent!.roleConfiguration}; return {bot,snapshot:{} as never};});
  const grant=vi.fn(async(record:BotRecord)=>({sessionId:id(4),testExecutionId:record.intent!.executionId,executionGeneration:"1",controllerId:record.intent!.registration.controllerId,controllerInstanceId:record.intent!.registration.controllerInstanceId,token:"relay-fixture",expiresAt:new Date(Date.now()+300000).toISOString()}));
  const environment={HOME:"/real/home",PATH:"/native/bin",CODEX_HOME:"/real/codex",DN_CONFIG_DIR:resolveConfigurationPaths(home).stateDirectory};
  const release=vi.fn(async()=>{}), prepareEnvironment=vi.fn(async()=>({environment,aliasDirectory:null,bindings:[],release}));
  let ticket:ControllerLaunchTicket;
  const launch=vi.fn(async(options:any)=>{ ticket=options.ticket; expect(executions.get(current())!.launchSubmission).toBe("not-submitted"); await options.onSubmitting(); expect(executions.get(current())!.launchSubmission).toBe("unknown"); expect(options.env).toEqual(environment); const value=snapshot(ticket); await options.onObserved(value); return value; });
  const observe=vi.fn(async(t:ControllerLaunchTicket)=>snapshot(t));
  const api={register,grant,readSession:vi.fn(async()=>({} as never)),report:vi.fn(async()=>bot)};
  const createProcess=(extra: Record<string, unknown> = {})=>createBotProcess({homeDirectory:home,packageDirectory:home,store,executions,sessionApi:api,recoveryLimit:3,dependencies:{prepareEnvironment,launch,observe,...extra}});
  return {home,owner,store,executions,current,register,grant,prepareEnvironment,release,launch,observe,process:createProcess(),createProcess,getBot:()=>bot,getTicket:()=>ticket!};
};

test.each(["codex","claude","copilot"] as const)("launches %s in an ordinary cwd with a persisted role and no user turn",async provider=>{
  const f=fixture(provider); const snapshot=await f.process.advance(f.current(),new AbortController().signal);
  expect(snapshot.lifecycle).toBe("ready"); expect(f.getTicket()).toMatchObject({provider,cwd:f.home,initialInput:"none",initialPrompt:"",instructions:f.current().intent!.roleConfiguration!.instructions,resumeNativeSessionId:null});
  expect(f.getTicket()).not.toHaveProperty("claimId"); expect(f.getTicket()).not.toHaveProperty("workerId"); expect(f.getTicket().configuration.agentControlMode).toBe("web");
  expect(existsSync(path.join(f.home,".git"))).toBe(false); expect(f.executions.get(f.current())!.launchSubmission).toBe("acknowledged"); expect(f.release).not.toHaveBeenCalled();
  await f.process.advance(f.current(),new AbortController().signal); expect(f.launch).toHaveBeenCalledTimes(1); expect(f.register).toHaveBeenCalledTimes(1); expect(f.prepareEnvironment).toHaveBeenCalledTimes(1);
});

test("reconciles an accepted registration with a lost response using the original role and identity",async()=>{
  const f=fixture(); const register=f.register.getMockImplementation()!;
  f.register.mockImplementationOnce(async record=>{await register(record);throw new Error("response lost");});
  await expect(f.process.advance(f.current(),new AbortController().signal)).rejects.toThrow("response lost"); const original=f.current().intent!;
  f.store.observe(f.owner,f.getBot(),2);
  await f.process.advance(f.current(),new AbortController().signal);
  expect(f.current().intent).toMatchObject({launchId:original.launchId,botVersion:"1",roleConfiguration:original.roleConfiguration}); expect(f.register).toHaveBeenCalledTimes(1); expect(f.launch).toHaveBeenCalledTimes(1);
});

test("never repeats a possible spawn even after constructing a new process manager",async()=>{
  const f=fixture(); f.launch.mockImplementationOnce(async options=>{await options.onSubmitting();throw new Error("spawn outcome unknown");});
  await expect(f.process.advance(f.current(),new AbortController().signal)).rejects.toThrow("spawn outcome unknown");
  expect(f.executions.get(f.current())!.launchSubmission).toBe("unknown"); f.observe.mockRejectedValueOnce(new Error("IPC unavailable"));
  await expect(f.process.advance(f.current(),new AbortController().signal)).rejects.toThrow(/IPC.*unavailable/);
  await f.createProcess().advance(f.current(),new AbortController().signal); expect(f.launch).toHaveBeenCalledTimes(1); expect(f.register).toHaveBeenCalledTimes(1);
});

test("rejects unsupported native configuration before registration and leaves failures visible",async()=>{
  const f=fixture(); const old=f.current().definition!;
  // The initial authoritative definition already contains the unsupported configuration.
  const other={...old,id:id(33),resolvedConfiguration:{...old.resolvedConfiguration,args:["--unsafe","yes"]}};
  f.store.observe(f.owner,other,1); await expect(f.process.advance(f.store.get(f.owner,other.id)!,new AbortController().signal)).rejects.toThrow(/Unsupported/);
  expect(f.register).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
});


test("renews only expiring credentials and retains the observed native identity",async()=>{
  const f=fixture(), signal=new AbortController().signal;
  await f.process.advance(f.current(),signal); await f.process.refreshGrant(f.current(),signal);expect(f.grant).toHaveBeenCalledTimes(1);
  writeFileSync(f.getTicket().credentialFile,JSON.stringify({expiresAt:new Date(Date.now()+60000).toISOString()}));
  await f.process.refreshGrant(f.current(),signal);expect(f.grant).toHaveBeenCalledTimes(2);
  expect(f.grant.mock.calls[1]![0].intent!.nativeSessionId).toBe(id(9));expect(f.launch).toHaveBeenCalledTimes(1);
  writeFileSync(f.getTicket().credentialFile,"{}");await expect(f.process.refreshGrant(f.current(),signal)).rejects.toThrow(/expiry/);expect(f.grant).toHaveBeenCalledTimes(2);
});

test("rejects a conflicting stored ticket without spawning or overwriting it",async()=>{
  const f=fixture(), signal=new AbortController().signal;await f.process.advance(f.current(),signal);
  const file=f.current().intent!.ticketPath;writeFileSync(file,JSON.stringify({...f.getTicket(),instructions:"different role"}),{mode:0o600});
  await expect(f.createProcess().advance(f.current(),signal)).rejects.toThrow(/ticket conflicts/);expect(f.launch).toHaveBeenCalledTimes(1);
});

test("retains registration and releases unsubmitted aliases when grant preparation fails",async()=>{
  const f=fixture(), signal=new AbortController().signal;f.grant.mockRejectedValueOnce(new Error("grant denied"));
  await expect(f.process.advance(f.current(),signal)).rejects.toThrow("grant denied");expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.executions.get(f.current())!.launchSubmission).toBe("not-submitted");
  await f.process.advance(f.current(),signal);expect(f.register).toHaveBeenCalledTimes(1);expect(f.launch).toHaveBeenCalledTimes(1);
});


test("retains an explicit OS rejection across failed reporting and never spawns again",async()=>{
  const f=fixture(), signal=new AbortController().signal;
  f.launch.mockImplementationOnce(async options=>{await options.onSubmitting();throw new ControllerStartupError({state:"failed",reasonCode:"controller_launch_failed"},"OS rejected spawn");});
  await expect(f.process.advance(f.current(),signal)).rejects.toMatchObject({observation:{state:"failed"}});
  expect(f.executions.get(f.current())!.startup).toEqual({state:"failed",reasonCode:"controller_launch_failed"});
  await expect(f.createProcess().advance(f.current(),signal)).rejects.toMatchObject({observation:{state:"failed"}});
  expect(f.launch).toHaveBeenCalledTimes(1);expect(f.observe).not.toHaveBeenCalled();
});

test("recovers a native initialization rejection from the original journal after IPC closes",async()=>{
  const f=fixture(), signal=new AbortController().signal;
  f.launch.mockImplementationOnce(async options=>{
    await options.onSubmitting();
    const journal=openControllerLifecycleStore(f.current().intent!.journalPath,options.ticket);
    journal.patchSnapshot({lifecycle:"failed",startup:{state:"failed",reasonCode:"native_rejected"},error:"native rejected"});journal.close();
    throw new Error("IPC closed before observation");
  });
  await expect(f.process.advance(f.current(),signal)).rejects.toThrow("IPC closed");f.observe.mockRejectedValue(new Error("unreachable"));
  expect(await f.createProcess().advance(f.current(),signal)).toMatchObject({startup:{state:"failed",reasonCode:"native_rejected"}});
  expect(f.launch).toHaveBeenCalledTimes(1);
});

const recoveryFixture = async () => {
  const f = fixture(), signal = new AbortController().signal;
  const proof = { pid: 123, parentPid: 12, processGroupId: 123, startedAt: "original", commandHash: "a".repeat(64) };
  await f.process.advance(f.current(), signal);
  let saved: ControllerSnapshot = { ...f.executions.get(f.current())!.snapshot!, controllerProcess: proof };
  f.executions.update(f.current(), { snapshot: saved });
  const confirmStopped = vi.fn(async () => false);
  const stopProcesses = vi.fn(async () => { confirmStopped.mockResolvedValue(true); });
  const request = vi.fn(async () => ({ snapshot: saved }));
  const recordStopped = vi.fn(async () => (saved = { ...saved, lifecycle: "stopped", activity: "stopped", nativeStopped: true, stoppedAt: "2026-11-05T00:00:00Z" }));
  f.observe.mockImplementation(async () => { if (saved.nativeStopped) throw new Error("IPC unavailable"); return saved; });
  const deps = { confirmStopped, stopProcesses, request, recordStopped, readSnapshot: () => saved };
  return { ...f, signal, deps, manager: f.createProcess(deps), saved: () => saved,
    patch: (patch: Partial<ControllerSnapshot>) => { saved = { ...saved, ...patch } as ControllerSnapshot; },
    restart: () => f.createProcess(deps) };
};

test("shutdown retains Bot artifacts and restart resumes the original native session with a new generation", async () => {
  const f = await recoveryFixture(), original = f.current().intent!;
  await f.manager.shutdown(f.current(), f.signal);
  expect(f.executions.get(f.current())).toMatchObject({ restartAfterShutdown: true, recoveryCount: 0, snapshot: { nativeStopped: true } });
  expect(existsSync(original.ticketPath)).toBe(true);
  await f.restart().advance(f.current(), f.signal);
  expect(f.getTicket()).toMatchObject({ executionGeneration: "2", sessionId: original.sessionId, testExecutionId: original.executionId, resumeNativeSessionId: id(9), instructions: original.roleConfiguration!.instructions, initialInput: "none", initialPrompt: "" });
  expect(f.current().intent!.registration).toEqual(original.registration);
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(f.grant.mock.calls.at(-1)).toHaveLength(3);
});

test("IPC loss with a live writer cannot grant or launch a new generation", async () => {
  const f = await recoveryFixture(); f.observe.mockRejectedValue(new Error("unreachable"));
  await expect(f.restart().advance(f.current(), f.signal)).rejects.toThrow(/stop|running|unreachable/i);
  expect(f.current().intent!.executionGeneration).toBe("1");
  expect(f.grant).toHaveBeenCalledTimes(1); expect(f.launch).toHaveBeenCalledTimes(1);
});

test("shutdown fails visibly when its stop receipt cannot prove the process tree stopped", async () => {
  const f = await recoveryFixture(); f.deps.stopProcesses.mockRejectedValue(new Error("cannot stop original process"));
  await expect(f.manager.shutdown(f.current(), f.signal)).rejects.toThrow(/cannot stop/);
  expect(f.deps.recordStopped).not.toHaveBeenCalled(); expect(f.current().intent!.executionGeneration).toBe("1");
});

test("stopped process without native ID never obtains a recovery grant or a blank replacement", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.launch.mockImplementationOnce(async options => { await options.onSubmitting(); const ticket = options.ticket; const journal = openControllerLifecycleStore(f.current().intent!.journalPath, ticket); journal.close(); throw new Error("unknown launch"); });
  await expect(f.process.advance(f.current(), signal)).rejects.toThrow("unknown launch");
  f.observe.mockRejectedValue(new Error("IPC unavailable"));
  await expect(f.createProcess({ confirmStopped: async () => true }).advance(f.current(), signal)).rejects.toThrow();
  expect(f.grant).toHaveBeenCalledTimes(1); expect(f.launch).toHaveBeenCalledTimes(1);
});

test("recovery keeps its persisted target generation after a lost grant response", async () => {
  const f = await recoveryFixture(); await f.manager.shutdown(f.current(), f.signal);
  f.grant.mockRejectedValueOnce(new Error("response lost"));
  await expect(f.restart().advance(f.current(), f.signal)).rejects.toThrow("response lost");
  const target = f.current().intent!;
  await f.restart().advance(f.current(), f.signal);
  expect(f.current().intent).toEqual(target); expect(f.launch).toHaveBeenCalledTimes(2);
  expect(f.executions.get(f.current())!.recoveryCount).toBe(0);
});


test("an abnormal stopped writer consumes one recovery attempt and a healthy later shutdown does not reset it", async () => {
  const f = await recoveryFixture();
  f.patch({ lifecycle: "failed", error: "native connection lost" });
  f.deps.confirmStopped.mockResolvedValue(true);
  await f.restart().advance(f.current(), f.signal);
  expect(f.executions.get(f.current())!.recoveryCount).toBe(1);
  expect(f.current().intent!.executionGeneration).toBe("2");
});

test("reattaching a surviving writer cancels stale orderly-stop provenance before a later crash", async () => {
  const f = await recoveryFixture();
  f.deps.stopProcesses.mockRejectedValueOnce(new Error("stop failed"));
  await expect(f.manager.shutdown(f.current(), f.signal)).rejects.toThrow("stop failed");
  expect(f.executions.get(f.current())!.restartAfterShutdown).toBe(true);
  await f.restart().advance(f.current(), f.signal);
  expect(f.executions.get(f.current())!.restartAfterShutdown).toBe(false);
  f.observe.mockRejectedValue(new Error("IPC disappeared")); f.deps.confirmStopped.mockResolvedValue(true);
  await f.restart().advance(f.current(), f.signal);
  expect(f.executions.get(f.current())!.recoveryCount).toBe(1);
});

test("shutdown ignores a never-started deletion projection without inventing a missing writer", async () => {
  const f = fixture();
  const deleted = f.store.observe(f.owner, { id: id(88), workerId: f.owner.workerId, version: "2", deletion: { deletionId: id(89), requestedVersion: "1", workerCleanup: { state: "pending", code: null }, serverCleanup: { state: "pending", code: null } } }, 1);
  expect(deleted.definition).toBeNull();
  await expect(f.process.shutdown(deleted, new AbortController().signal)).resolves.toBeUndefined();
});
