import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { createWorkerSessionApi } from "../../../src/commands/worker/backends/session-api.js";
import { createWebExecutionBackend } from "../../../src/commands/worker/backends/web.js";
import type { WorkerGitManager } from "../../../src/commands/worker/execution.js";
import type { LocalTask } from "../../../src/commands/worker/backends/web-types.js";
import * as lifecycle from "../../../src/commands/controller/lifecycle-store.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import type { ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { requestController } from "../../../src/commands/controller/local-client.js";
const roots:string[]=[];const stores:ReturnType<typeof openWebExecutionStore>[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();for(const store of stores.splice(0))store.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const fixture=async(agent: "codex" | "claude" | "copilot" = "codex")=>{
 const base=path.resolve(import.meta.dirname,"../../../../../.tmp/web-backend-tests");await mkdir(base,{recursive:true});const home=await mkdtemp(path.join(base,"h-"));roots.push(home);
 const store=openWebExecutionStore(path.join(home,"worker.sqlite"));stores.push(store);
 const project={serverOrigin:"https://daynight.example",projectId:randomUUID(),repoUrl:"https://example.test/repo.git",localPath:home};
 const identity={...project,taskId:randomUUID(),claimId:randomUUID(),workerId:randomUUID(),worktreeId:randomUUID()};
 store.register({ ...identity, project, configuration: {agent,agentControlMode:"web",model:null,args:[],recoveryLimit:2}, userId: randomUUID() }, 1);
 const binding={repositoryPath:home,commonDirectory:path.join(home,".git"),worktreePath:path.join(home,".worktrees","daynight",identity.taskId),branch:`daynight/${identity.taskId}`};
 const git={prepareWorktree:vi.fn(async()=>binding),verifyWorktree:vi.fn(async()=>binding),findWorktree:vi.fn(async()=>null),removeWorktree:vi.fn(async()=>{}),prepareRepository:vi.fn(),dispose:vi.fn()} as unknown as WorkerGitManager;
 return {home,store,identity,git};
};
it.each([false,true])("submits once and reobserves unknown first input, including a lazy native identity (lazy=%s)",async(lazyIdentity)=>{
 const f=await fixture();let snapshot:ControllerSnapshot;let launches=0;let submissions=0;
 const launcher={
  prepare:vi.fn(async(task:LocalTask,prompt:string):Promise<ControllerLaunchTicket>=>{
   if(task.webExecution!.sessionId===null)task=f.store.updateWebExecution(task,{sessionId:randomUUID(),initialPrompt:prompt},3);
   const e=task.webExecution!;snapshot??={executionId:e.executionId,claimId:task.claimId,sessionId:e.sessionId!,executionGeneration:e.executionGeneration,controllerInstanceId:e.controllerInstanceId,lifecycle:"ready",nativeSessionId:lazyIdentity?null:randomUUID(),initialInputState:"not_submitted",activity:"idle",currentTurnId:null,capabilities:{send:true,steer:true,cancel:true,respond:true},controllerProcess:null,nativeProcesses:[],nativeStopped:false,stoppedAt:null,error:null};
   return {schemaVersion:1,launchId:e.launchId,executionId:e.executionId,controllerId:e.controllerId,controllerInstanceId:e.controllerInstanceId,sessionId:e.sessionId!,executionGeneration:e.executionGeneration,serverOrigin:task.serverOrigin,projectId:task.projectId,taskId:task.taskId,claimId:task.claimId,workerId:task.workerId,worktreeId:task.worktreeId,userId:task.userId!,provider:"codex",cwd:task.resources.worktree!.worktreePath,nativeHome:path.join(f.home,".codex"),configuration:task.configuration!,initialOperationId:e.initialOperationId,initialPrompt:prompt,resumeNativeSessionId:null,credentialFile:path.join(f.home,"grant.json"),ipcEndpoint:path.join(f.home,"c.sock"),ipcSecret:"a".repeat(64),createdAt:new Date(0).toISOString()};
  }),
  launch:vi.fn(async(task:LocalTask)=>{if(task.webExecution!.launchSubmission==="not-submitted"){launches++;f.store.updateWebExecution(task,{launchSubmission:"acknowledged"},4);}}),refreshGrant:vi.fn(async()=>{}),
 };
 const request:typeof requestController=async(_ticket,action)=>{if(action.kind==="submit_initial"){submissions++;snapshot.initialInputState="unknown";snapshot.nativeSessionId??=randomUUID();}return {requestId:randomUUID(),ok:true,snapshot};};
 const backend=createWebExecutionBackend({homeDirectory:f.home,store:f.store,git:f.git,launcher,platform:"macos",buildPrompt:()=>"managed task",emit:()=>{},now:()=>5,request});
 const first=await backend.advance(f.store.getTask(f.identity)!,new AbortController().signal);
 const second=await backend.advance(first,new AbortController().signal);
 expect(launches).toBe(1);expect(submissions).toBe(1);expect(second.webExecution?.initialOperationId).toBe(first.webExecution?.initialOperationId);
 expect(second.nativeExecution).toBeNull();expect(second.resources.herdr).toBeNull();expect(second.resources.nativeSession?.source).toBe("controller");
});
it("closes a provably unlaunched Web execution with backend proof rather than a Herdr workspace claim",async()=>{
 const f=await fixture();const launcher={prepare:vi.fn(),launch:vi.fn(),refreshGrant:vi.fn()};
 const backend=createWebExecutionBackend({homeDirectory:f.home,store:f.store,git:f.git,launcher,platform:"macos",buildPrompt:()=>"managed",emit:()=>{},now:()=>5});
 const result=await backend.cleanup(f.store.getTask(f.identity)!,"terminal",100);
 expect(result.cleanup).toMatchObject({workspaceClosed:null,backendResourcesClosed:true,agentStopped:true,worktreeDeleted:true});
 expect(vi.mocked(f.git.removeWorktree).mock.calls[0]?.[1]).toMatchObject({ claimId: f.identity.claimId, worktreeId: f.identity.worktreeId });
 expect(launcher.launch).not.toHaveBeenCalled();
});

it.each([false,true])("only an orderly shutdown can resume at an exhausted recovery budget (shutdown=%s)",async(orderly)=>{
 const f=await fixture();let task=f.store.bindWorktree(f.identity,await f.git.prepareWorktree({ projectId: f.identity.projectId, repoUrl: f.identity.repoUrl, localPath: f.identity.localPath }, f.identity,{} as never),3);
 task=f.store.initializeWebExecution(task,4);const nativeId=randomUUID();
 task=f.store.updateWebExecution(task,{sessionId:randomUUID(),initialPrompt:"managed",launchSubmission:"acknowledged",controllerProcess:{pid:123,parentPid:1,processGroupId:123,startedAt:"birth",commandHash:"a".repeat(64)}},5);
 task=f.store.bindNativeSession(task,{source:"controller",sessionId:nativeId},6);
 f.store.beginRecovery(task,7);task=f.store.beginRecovery(task,8);
 if(orderly){f.store.beginCleanup(task,{kind:"shutdown",deadline:100},9);f.store.recordCleanupResult(task,"completed",null,10);f.store.confirmAgentStopped(task,{agentStopped:true},11);f.store.confirmBackendResourcesClosed(task,{controllerStopped:true,endpointClosed:true},12);task=f.store.clearShutdown(task,13);}
 const e=task.webExecution!;const stopped:ControllerSnapshot={executionId:e.executionId,claimId:task.claimId,sessionId:e.sessionId!,executionGeneration:e.executionGeneration,controllerInstanceId:e.controllerInstanceId,lifecycle:"stopped",nativeSessionId:nativeId,initialInputState:"confirmed",activity:"stopped",currentTurnId:null,capabilities:{send:true,steer:true,cancel:true,respond:true},controllerProcess:e.controllerProcess,nativeProcesses:[],nativeStopped:true,stoppedAt:new Date(0).toISOString(),error:null};
 vi.spyOn(lifecycle,"readControllerSnapshot").mockReturnValue(stopped);vi.spyOn(lifecycle,"recordStoppedControllerGeneration").mockResolvedValue(stopped);vi.spyOn(processProof,"confirmControllerProcessesStopped").mockResolvedValue(true);
 const launcher={prepare:vi.fn(async(task:LocalTask):Promise<ControllerLaunchTicket>=>{const e=task.webExecution!;return {schemaVersion:1,launchId:e.launchId,executionId:e.executionId,controllerId:e.controllerId,controllerInstanceId:e.controllerInstanceId,sessionId:e.sessionId!,executionGeneration:e.executionGeneration,serverOrigin:task.serverOrigin,projectId:task.projectId,taskId:task.taskId,claimId:task.claimId,workerId:task.workerId,worktreeId:task.worktreeId,userId:task.userId!,provider:"codex",cwd:task.resources.worktree!.worktreePath,nativeHome:path.join(f.home,".codex"),configuration:task.configuration!,initialOperationId:e.initialOperationId,initialPrompt:"managed",resumeNativeSessionId:nativeId,credentialFile:path.join(f.home,"grant.json"),ipcEndpoint:path.join(f.home,"c.sock"),ipcSecret:"a".repeat(64),createdAt:new Date(0).toISOString()};}),launch:vi.fn(async()=>{}),refreshGrant:vi.fn(async()=>{})};
 const actions:string[]=[];const request:typeof requestController=async(ticket,action)=>{actions.push(action.kind);if(ticket.executionGeneration==="1")throw new Error("Original stopped controller is unreachable");return {requestId:randomUUID(),ok:true,snapshot:{...stopped,executionGeneration:ticket.executionGeneration,controllerInstanceId:ticket.controllerInstanceId,lifecycle:"ready",activity:"idle",nativeStopped:false,stoppedAt:null}};};
 const backend=createWebExecutionBackend({homeDirectory:f.home,store:f.store,git:f.git,launcher,platform:"macos",buildPrompt:()=>"managed",emit:()=>{},now:()=>20,request});
 if(orderly){const resumed=await backend.advance(task,new AbortController().signal);expect(resumed.webExecution?.executionGeneration).toBe("2");expect(resumed.recovery.count).toBe(2);expect(resumed.resources.nativeSession?.sessionId).toBe(nativeId);expect(actions).toEqual(["observe","observe"]);}
 else{await expect(backend.advance(task,new AbortController().signal)).rejects.toThrow("recovery budget is exhausted");expect(f.store.getTask(task)?.webExecution?.executionGeneration).toBe("1");}
});


it("registers the frozen Copilot identity only after service capability support", async () => {
 const f = await fixture("copilot");
 const task = f.store.initializeWebExecution(f.store.getTask(f.identity)!, 3), execution = task.webExecution!;
 const original = JSON.parse(await readFile(new URL("../../session/fixtures/snapshot.json", import.meta.url), "utf8"));
 const snapshot = { ...original, claimId: task.claimId, identity: { ...original.identity, projectId: task.projectId, taskId: task.taskId, workerId: task.workerId, worktreeId: task.worktreeId, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId, provider: "copilot" } };
 const fetch = vi.fn<typeof globalThis.fetch>(); vi.stubGlobal("fetch", fetch);
 const api = createWorkerSessionApi(task.serverOrigin, "test-credential"), signal = new AbortController().signal;
 fetch.mockResolvedValueOnce(Response.json({ protocol: "daynight.session.v1", schemaVersion: 1, projectionVersion: 1, providers: ["codex", "claude"] }));
 await expect(api.verifySupport("copilot", signal)).rejects.toThrow("no claim was submitted");
 fetch.mockResolvedValueOnce(Response.json({ protocol: "daynight.session.v1", schemaVersion: 1, projectionVersion: 1, providers: ["codex", "claude", "copilot"] }));
 await api.verifySupport("copilot", signal);
 fetch.mockResolvedValueOnce(Response.json({ session: snapshot }));
 expect((await api.register(task, execution, signal)).identity.provider).toBe("copilot");
 const registration = JSON.parse(fetch.mock.calls[2]![1]!.body as string);
 expect(registration).toMatchObject({ provider: "copilot", claimId: task.claimId, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId });
 fetch.mockResolvedValueOnce(Response.json({ session: { ...snapshot, identity: { ...snapshot.identity, provider: "claude" } } }));
 await expect(api.register(task, execution, signal)).rejects.toThrow("frozen execution");
});


it("requires a matching unregistered server claim before recovering missing launch evidence", async () => {
  const f = await fixture(), api = createWorkerSessionApi("https://daynight.example", "test-token"), signal = new AbortController().signal;
  const fetch = vi.fn<typeof globalThis.fetch>(); vi.stubGlobal("fetch", fetch);
  fetch.mockResolvedValueOnce(Response.json({ status: "not_registered", agentControlMode: "web", claimId: f.identity.claimId }));
  await api.verifyUnregistered(f.identity, signal);
  expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "GET" });
  fetch.mockResolvedValueOnce(Response.json({ status: "not_registered", agentControlMode: "web", claimId: randomUUID() }));
  await expect(api.verifyUnregistered(f.identity, signal)).rejects.toThrow("provenance");
  fetch.mockResolvedValueOnce(new Response("", { status: 503 }));
  await expect(api.verifyUnregistered(f.identity, signal)).rejects.toThrow("503");
});

it.each(["codex", "claude", "copilot"] as const)("starts %s immediate shutdown with zero remaining cleanup budget after the caller clock advances", async provider => {
  const f = await fixture(provider), request = vi.fn<typeof requestController>();
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 101, request });
  const result = await backend.cleanup(f.store.getTask(f.identity)!, "shutdown", 100, undefined, true);
  expect(result.cleanup).toMatchObject({ startedAt: 101, deadline: 101, agentStopped: true, backendResourcesClosed: true, worktreeDeleted: false });
  expect(result.claimId).toBe(f.identity.claimId);
  expect(request).not.toHaveBeenCalled();
  expect(f.git.removeWorktree).not.toHaveBeenCalled();
});

it("preserves an existing cleanup deadline and gives an expired first terminal cleanup no new grace period", async () => {
  const f = await fixture(), request = vi.fn<typeof requestController>(); let now = 101;
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => now, request });
  const first = await backend.cleanup(f.store.getTask(f.identity)!, "terminal", 100);
  expect(first.cleanup).toMatchObject({ startedAt: 101, deadline: 101, agentStopped: true, worktreeDeleted: true });
  now = 1_000;
  const retry = await backend.cleanup(first, "terminal", now + 600_000);
  expect(retry.cleanup).toMatchObject({ startedAt: 101, deadline: 101 });
  expect(request).not.toHaveBeenCalled();
  expect(f.git.removeWorktree).toHaveBeenCalledOnce();
});
