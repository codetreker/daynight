import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openBotStore } from "../../../src/commands/worker/bots/store.js";
import { openBotExecutionStore } from "../../../src/commands/worker/bots/execution-store.js";
import { createBotDeletion } from "../../../src/commands/worker/bots/delete.js";
import type { Bot, BotRecord, BotDeleted } from "../../../src/commands/worker/bots/types.js";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const cleanups:(()=>void)[]=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0).reverse())cleanup();vi.unstubAllEnvs();});
const fixture=()=>{
 const root=path.resolve(import.meta.dirname,"../../../../../.tmp/t15/delete-tests");mkdirSync(root,{recursive:true});
 const home=mkdtempSync(path.join(root,"h-"));cleanups.push(()=>rmSync(home,{recursive:true,force:true}));vi.stubEnv("DN_CONFIG_DIR",path.join(home,"state"));
 const store=openBotStore(path.join(home,"worker.sqlite"),{onMigration:()=>{}}),executions=openBotExecutionStore(path.join(home,"worker.sqlite"),{onMigration:()=>{}});cleanups.push(()=>store.close(),()=>executions.close());
 const owner={serverOrigin:"https://daynight.example",ownerUserId:id(1),workerId:id(2)};
 const bot:Bot={id:id(3),workerId:owner.workerId,ownerUserId:owner.ownerUserId,version:"1",name:"Bot",creationOrder:"1",requestedOverrides:{},resolvedConfiguration:{workerId:owner.workerId,cwd:home,provider:"codex",model:null,args:[]},roleConfiguration:null,sessionId:null,testExecutionId:null,startupResult:{state:"pending",code:null},deletion:null,createdAt:"2026-11-05T00:00:00Z",updatedAt:"2026-11-05T00:00:00Z"};
 store.observe(owner,bot,1);store.prepare(owner,bot.id,{homeDirectory:home,recoveryLimit:3});
 store.observe(owner,{...bot,version:"2",sessionId:id(9),testExecutionId:store.get(owner,bot.id)!.intent!.executionId},2);
 const intent=store.get(owner,bot.id)!.intent!;executions.prepare(store.get(owner,bot.id)!);
 mkdirSync(path.dirname(intent.journalPath),{recursive:true});writeFileSync(intent.journalPath,"private history");
 mkdirSync(path.dirname(intent.ticketPath),{recursive:true});writeFileSync(intent.ticketPath,JSON.stringify({schemaVersion:1,launchId:intent.launchId,executionId:intent.executionId,testExecutionId:intent.executionId,
 controllerId:intent.registration.controllerId,controllerInstanceId:intent.controllerInstanceId,sessionId:intent.sessionId,executionGeneration:"1",serverOrigin:owner.serverOrigin,ownerUserId:owner.ownerUserId,
 provider:"codex",cwd:home,nativeHome:path.join(home,"native"),configuration:{agent:"codex",agentControlMode:"web",model:null,args:[],recoveryLimit:3},
 initialInput:"none",initialOperationId:intent.initialOperationId,initialPrompt:"",resumeNativeSessionId:null,credentialFile:intent.credentialFile,ipcEndpoint:path.join(home,"unused.sock"),ipcSecret:"a".repeat(64),createdAt:"2026-11-05T00:00:00Z"}),{mode:0o600});
 for(const name of ["cwd.txt","native-home.txt","task.txt","worktree.txt"])writeFileSync(path.join(home,name),name);
 let remoteBot:BotDeleted={id:bot.id,workerId:owner.workerId,version:"3",deletion:{deletionId:id(8),requestedVersion:"1",workerCleanup:{state:"pending",code:null},serverCleanup:{state:"pending",code:null}}};
 store.observe(owner,remoteBot,2);
 const current=()=>store.get(owner,bot.id)!;
 const stopProof={protocol:"daynight.session.v1" as const,sessionId:id(9),testExecutionId:intent.executionId,executionGeneration:"1",controllerId:intent.registration.controllerId,controllerInstanceId:intent.controllerInstanceId,stopProof:{kind:"never_started" as const,recordId:intent.launchId,previousControllerInstanceId:intent.controllerInstanceId,stoppedAt:"2026-11-05T00:00:00Z"}};
 const stop=vi.fn(async()=>stopProof);
 const process={withDeletion:async<T>(_r:BotRecord,_s:AbortSignal,action:(stop:()=>Promise<typeof stopProof>)=>Promise<T>)=>action(stop)};
 const remote={owner,read:vi.fn(async()=>remoteBot),list:vi.fn(async()=>[remoteBot])};
 const api={completeDeletion:vi.fn(async(_record:BotRecord,receipt:any)=>{remoteBot={...remoteBot,version:String(Number(remoteBot.version)+1),deletion:{...remoteBot.deletion,workerCleanup:receipt.result,serverCleanup:{state:receipt.result.state==="completed"?"completed":"pending",code:null}}};return remoteBot;})};
 const create=(dependencies={})=>createBotDeletion({homeDirectory:home,store,executions,process:process as never,sessionApi:api as never,remote,dependencies});
 return {home,store,executions,intent,current,stop,stopProof,remote,api,create,setRemote:(bot:BotDeleted)=>{remoteBot=bot;}};
};

test("cleans only private sources, strips execution records, and retains exact minimal receipt",async()=>{
 const f=fixture();await f.create().advance(f.current(),new AbortController().signal);
 expect(existsSync(f.intent.journalPath)).toBe(false);expect(existsSync(f.intent.ticketPath)).toBe(false);
 for(const name of ["cwd.txt","native-home.txt","task.txt","worktree.txt"])expect(existsSync(path.join(f.home,name))).toBe(true);
 expect(f.current()).toMatchObject({definition:null,intent:null,cleanup:{localCompleted:true,stop:f.stopProof,targets:[]}});
 expect(f.api.completeDeletion).toHaveBeenCalledTimes(1);expect(f.api.completeDeletion.mock.calls[0]![1]).toEqual({deletionId:id(8),stop:f.stopProof,result:{state:"completed",code:null}});
});
test("retains journal and ticket when exact stop fails even if IPC may have acknowledged",async()=>{
 const f=fixture();f.stop.mockRejectedValue(new Error("process still alive"));
 await expect(f.create().advance(f.current(),new AbortController().signal)).rejects.toThrow("process still alive");
 expect(existsSync(f.intent.journalPath)).toBe(true);expect(existsSync(f.intent.ticketPath)).toBe(true);
 expect(f.current().cleanup).toBeUndefined();expect(f.current().observed.deletion?.workerCleanup).toEqual({state:"failed",code:"execution_stop_unproven"});
});
test("does not stop or clean during an authority outage",async()=>{
 const f=fixture();f.remote.read.mockRejectedValue(new Error("offline"));
 await expect(f.create().advance(f.current(),new AbortController().signal)).rejects.toThrow("offline");
 expect(f.stop).not.toHaveBeenCalled();expect(f.api.completeDeletion).not.toHaveBeenCalled();expect(existsSync(f.intent.journalPath)).toBe(true);
});
test("reconciles an accepted but lost receipt without reaccessing cleaned paths",async()=>{
 const f=fixture();const complete=f.api.completeDeletion.getMockImplementation()!;
 f.api.completeDeletion.mockImplementationOnce(async(...args)=>{await complete(...args);throw new Error("response lost");});
 await expect(f.create().advance(f.current(),new AbortController().signal)).rejects.toThrow("response lost");
 mkdirSync(path.dirname(f.intent.journalPath),{recursive:true});writeFileSync(f.intent.journalPath,"replacement must survive");
 await f.create().advance(f.current(),new AbortController().signal);
 expect(existsSync(f.intent.journalPath)).toBe(true);expect(f.stop).toHaveBeenCalledTimes(1);expect(f.api.completeDeletion).toHaveBeenCalledTimes(1);
});
test("retries an unaccepted completion using the identical persisted receipt",async()=>{
 const f=fixture();f.api.completeDeletion.mockRejectedValueOnce(new Error("permission denied"));
 await expect(f.create().advance(f.current(),new AbortController().signal)).rejects.toThrow("permission denied");
 await f.create().advance(f.current(),new AbortController().signal);
 expect(f.api.completeDeletion.mock.calls[1]![1]).toEqual(f.api.completeDeletion.mock.calls[0]![1]);expect(f.stop).toHaveBeenCalledTimes(1);
});
test("retains progress through partial filesystem failure and never reopens a completed path",async()=>{
 const f=fixture();const {removeBotDeletionFile}=await import("../../../src/commands/worker/bots/delete-files.js");
 let failed=false;const remove=vi.fn(async(target:any,signal:AbortSignal)=>{if(target.path===path.dirname(f.intent.journalPath)&&!failed){failed=true;throw new Error("EACCES");}await removeBotDeletionFile(target,signal);});
 await expect(f.create({remove}).advance(f.current(),new AbortController().signal)).rejects.toThrow("EACCES");
 expect(existsSync(f.intent.ticketPath)).toBe(false);expect(existsSync(f.intent.journalPath)).toBe(true);
 writeFileSync(f.intent.ticketPath,"replacement ticket");
 await f.create({remove}).advance(f.current(),new AbortController().signal);
 expect(existsSync(f.intent.ticketPath)).toBe(true);expect(existsSync(f.intent.journalPath)).toBe(false);expect(f.stop).toHaveBeenCalledTimes(1);
});
