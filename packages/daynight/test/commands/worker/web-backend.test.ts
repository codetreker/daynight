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
import * as launchTickets from "../../../src/commands/controller/launch-ticket.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import type { ControllerSnapshot } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import type { requestController } from "../../../src/commands/controller/local-client.js";
const roots:string[]=[];const stores:ReturnType<typeof openWebExecutionStore>[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();for(const store of stores.splice(0))store.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const fixture=async(agent: "codex" | "claude" | "copilot" = "codex", recoveryLimit = 2)=>{
 const base=path.resolve(import.meta.dirname,"../../../../../.tmp/web-backend-tests");await mkdir(base,{recursive:true});const home=await mkdtemp(path.join(base,"h-"));roots.push(home);
 const store=openWebExecutionStore(path.join(home,"worker.sqlite"));stores.push(store);
 const project={serverOrigin:"https://daynight.example",projectId:randomUUID(),repoUrl:"https://example.test/repo.git",localPath:home};
 const identity={...project,taskId:randomUUID(),claimId:randomUUID(),workerId:randomUUID(),worktreeId:randomUUID()};
 store.register({ ...identity, project, configuration: {agent,agentControlMode:"web",model:null,args:[],recoveryLimit}, userId: randomUUID() }, 1);
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
 else{const paused=await backend.advance(task,new AbortController().signal);expect(paused.recovery.pauseReason).toContain("recovery budget is exhausted");expect(f.store.getTask(task)?.webExecution?.executionGeneration).toBe("1");expect(launcher.prepare).not.toHaveBeenCalled();expect(launcher.launch).not.toHaveBeenCalled();}
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

it("retains the stopped task worktree on archive failure and retries without relaunching business work", async () => {
  const f = await fixture();
  let task = f.store.bindWorktree(f.identity, await f.git.prepareWorktree({ projectId: f.identity.projectId, repoUrl: f.identity.repoUrl, localPath: f.identity.localPath }, f.identity, {} as never), 3);
  task = f.store.initializeWebExecution(task, 4);
  task = f.store.updateWebExecution(task, { sessionId: randomUUID(), initialPrompt: "managed", launchSubmission: "acknowledged" }, 5);
  task = f.store.beginCleanup(task, { kind: "terminal", deadline: 10 }, 6);
  task = f.store.recordCleanupResult(task, "completed", null, 7);
  task = f.store.confirmAgentStopped(task, { agentStopped: true }, 8);
  task = f.store.confirmBackendResourcesClosed(task, { controllerStopped: true, endpointClosed: true }, 9);
  const archive = vi.fn().mockRejectedValueOnce(new Error("archive offline")).mockResolvedValue(undefined);
  const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() };
  const request = vi.fn<typeof requestController>();
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 20, archive, request });
  await expect(backend.cleanup(task, "terminal", 30)).rejects.toThrow("archive offline");
  expect(f.git.removeWorktree).not.toHaveBeenCalled();
  expect(f.store.getTask(task)?.cleanup).toMatchObject({ agentStopped: true, worktreeDeleted: false });
  const result = await backend.cleanup(task, "terminal", 30);
  expect(result.cleanup?.worktreeDeleted).toBe(true);
  expect(archive).toHaveBeenCalledTimes(2);
  expect(f.git.removeWorktree).toHaveBeenCalledOnce();
  expect(launcher.launch).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
});
it("ordinary shutdown retains history without publishing an ended archive", async () => {
  const f = await fixture(); let task = f.store.initializeWebExecution(f.store.getTask(f.identity)!, 3);
  task = f.store.updateWebExecution(task, { sessionId: randomUUID(), initialPrompt: "managed", launchSubmission: "acknowledged" }, 4);
  task = f.store.beginCleanup(task, { kind: "shutdown", deadline: 10 }, 5);
  task = f.store.recordCleanupResult(task, "completed", null, 6);
  task = f.store.confirmAgentStopped(task, { agentStopped: true }, 7);
  task = f.store.confirmBackendResourcesClosed(task, { controllerStopped: true, endpointClosed: true }, 8);
  const archive = vi.fn();
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 20, archive });
  await backend.cleanup(task, "shutdown", 30);
  expect(archive).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
});

it.each(["codex", "claude", "copilot"] as const)("shuts down a stopped %s execution after failed terminal archival without retrying or losing finalization", async provider => {
  const f = await fixture(provider);
  let task = f.store.bindWorktree(f.identity, await f.git.prepareWorktree({ projectId: f.identity.projectId, repoUrl: f.identity.repoUrl, localPath: f.identity.localPath }, f.identity, {} as never), 3);
  task = f.store.initializeWebExecution(task, 4);
  task = f.store.updateWebExecution(task, { sessionId: randomUUID(), initialPrompt: "managed", launchSubmission: "acknowledged" }, 5);
  task = f.store.beginCleanup(task, { kind: "terminal", deadline: 10 }, 6);
  task = f.store.recordCleanupResult(task, "completed", null, 7);
  task = f.store.confirmAgentStopped(task, { agentStopped: true }, 8);
  task = f.store.confirmBackendResourcesClosed(task, { controllerStopped: true, endpointClosed: true }, 9);
  const archive = vi.fn().mockRejectedValue(new Error("archive offline"));
  const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() };
  const request = vi.fn<typeof requestController>();
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 20, archive, request });

  await expect(backend.cleanup(task, "terminal", 30)).rejects.toThrow("archive offline");
  const pending = f.store.getTask(task)!;
  expect(pending.cleanup).toMatchObject({ kind: "terminal", agentStopped: true, backendResourcesClosed: true, worktreeDeleted: false });
  const stopped = await backend.cleanup(pending, "shutdown", 20, undefined, true);
  expect(stopped.cleanup).toEqual(pending.cleanup);
  expect(f.store.getTask(task)?.cleanup).toEqual(pending.cleanup);
  expect(archive).toHaveBeenCalledOnce();
  expect(f.git.removeWorktree).not.toHaveBeenCalled();

  archive.mockResolvedValue(undefined);
  const completed = await backend.cleanup(stopped, "terminal", 30);
  expect(completed.cleanup).toMatchObject({ kind: "terminal", agentStopped: true, backendResourcesClosed: true, worktreeDeleted: true, startedAt: 6, deadline: 10 });
  expect(archive).toHaveBeenCalledTimes(2);
  expect(f.git.removeWorktree).toHaveBeenCalledOnce();
  expect(launcher.launch).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it("cleanup propagates a local snapshot write failure without taking the IPC fallback", async () => {
  const f = await fixture();
  let task = f.store.bindWorktree(f.identity, await f.git.prepareWorktree({ projectId: f.identity.projectId, repoUrl: f.identity.repoUrl, localPath: f.identity.localPath }, f.identity, {} as never), 2);
  task = f.store.initializeWebExecution(task, 3);
  const execution = task.webExecution!, proof = { pid: 987, parentPid: 1, processGroupId: 987, startedAt: "original", commandHash: "a".repeat(64) };
  task = f.store.updateWebExecution(task, { sessionId: randomUUID(), initialPrompt: "original", launchSubmission: "acknowledged", controllerProcess: proof }, 4);
  const ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: execution.launchId, executionId: execution.executionId, controllerId: execution.controllerId, controllerInstanceId: execution.controllerInstanceId, sessionId: task.webExecution!.sessionId!, executionGeneration: "1", serverOrigin: task.serverOrigin, projectId: task.projectId, taskId: task.taskId, claimId: task.claimId, workerId: task.workerId, worktreeId: task.worktreeId, userId: task.userId!, provider: "codex", cwd: f.home, nativeHome: path.join(f.home, ".codex"), configuration: task.configuration!, initialOperationId: execution.initialOperationId, initialPrompt: "original", resumeNativeSessionId: null, credentialFile: path.join(f.home, "grant.json"), ipcEndpoint: path.join(f.home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  const { writeLaunchTicket } = await import("../../../src/commands/controller/launch-ticket.js");
  task = f.store.updateWebExecution(task, { ticketPath: await writeLaunchTicket(f.home, ticket) }, 5);
  const snapshot: ControllerSnapshot = { executionId: execution.executionId, claimId: task.claimId, sessionId: ticket.sessionId, executionGeneration: "1", controllerInstanceId: execution.controllerInstanceId, lifecycle: "ready", nativeSessionId: null, initialInputState: "confirmed", activity: "idle", currentTurnId: null, capabilities: { send: true, steer: true, cancel: true, respond: true }, controllerProcess: proof, nativeProcesses: [], nativeStopped: false, stoppedAt: null, error: null };
  const failure = new Error("local execution write failed"), fallback = vi.spyOn(lifecycle, "readControllerSnapshot"), stopping = vi.spyOn(processProof, "confirmControllerProcessesStopped");
  vi.spyOn(f.store, "updateWebExecution").mockImplementation(() => { throw failure; });
  const request = vi.fn<typeof requestController>().mockResolvedValue({ requestId: randomUUID(), ok: true, snapshot });
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() }, platform: "macos", buildPrompt: () => "managed", emit: () => {}, now: () => 6, request });
  await expect(backend.cleanup(task, "shutdown", 100)).rejects.toBe(failure);
  expect(request).toHaveBeenCalledOnce(); expect(fallback).not.toHaveBeenCalled(); expect(stopping).not.toHaveBeenCalled();
  expect(f.store.getTask(task)?.cleanup).toMatchObject({ input: "not-submitted", agentStopped: false, backendResourcesClosed: false });
});


it("blocks all preparation and input across repeated paused advances", async () => {
  const f = await fixture();
  f.store.beginRecovery(f.identity, 2); f.store.beginRecovery(f.identity, 3);
  const paused = f.store.beginRecovery(f.identity, 4);
  const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() };
  const request = vi.fn();
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher, platform: "macos", buildPrompt: vi.fn(), emit: () => {}, now: () => 5, request });
  for (let i = 0; i < 3; i++) expect((await backend.advance(paused, new AbortController().signal)).recovery).toEqual(paused.recovery);
  expect(f.git.prepareWorktree).not.toHaveBeenCalled();
  expect(f.git.verifyWorktree).not.toHaveBeenCalled();
  expect(launcher.prepare).not.toHaveBeenCalled(); expect(launcher.launch).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  expect(f.store.getTask(f.identity)?.webExecution).toBeNull();
});


const recoveryFixture = async (recoveryLimit = 2) => {
  const f = await fixture("codex", recoveryLimit);
  let task = f.store.bindWorktree(f.identity, await f.git.prepareWorktree({ projectId: f.identity.projectId, repoUrl: f.identity.repoUrl, localPath: f.identity.localPath }, f.identity, {} as never), 2);
  vi.mocked(f.git.prepareWorktree).mockClear();
  task = f.store.initializeWebExecution(task, 3);
  task = f.store.updateWebExecution(task, { sessionId: randomUUID(), initialPrompt: "original assignment", launchSubmission: "acknowledged", ticketPath: path.join(f.home, "original-ticket.json"), controllerProcess: { pid: 123, parentPid: 1, processGroupId: 123, startedAt: "birth", commandHash: "a".repeat(64) } }, 4);
  task = f.store.bindNativeSession(task, { source: "controller", sessionId: randomUUID() }, 5);
  task = f.store.beginRecovery(task, 6); task = f.store.beginRecovery(task, 7);
  const execution = task.webExecution!;
  const snapshot: ControllerSnapshot = { executionId: execution.executionId, claimId: task.claimId, sessionId: execution.sessionId!, executionGeneration: execution.executionGeneration, controllerInstanceId: execution.controllerInstanceId, lifecycle: "stopped", nativeSessionId: task.resources.nativeSession!.sessionId, initialInputState: "confirmed", activity: "stopped", currentTurnId: null, capabilities: { send: false, steer: false, cancel: false, respond: false }, controllerProcess: execution.controllerProcess, nativeProcesses: [], nativeStopped: true, stoppedAt: new Date(0).toISOString(), error: "Original failure" };
  const ticketFor = (record: LocalTask): ControllerLaunchTicket => {
    const e = record.webExecution!;
    return { schemaVersion: 1, launchId: e.launchId, executionId: e.executionId, controllerId: e.controllerId, controllerInstanceId: e.controllerInstanceId, sessionId: e.sessionId!, executionGeneration: e.executionGeneration, serverOrigin: record.serverOrigin, projectId: record.projectId, taskId: record.taskId, claimId: record.claimId, workerId: record.workerId, worktreeId: record.worktreeId, userId: record.userId!, provider: "codex", cwd: record.resources.worktree!.worktreePath, nativeHome: path.join(f.home, ".codex"), configuration: record.configuration!, initialOperationId: e.initialOperationId, initialPrompt: e.initialPrompt!, resumeNativeSessionId: record.resources.nativeSession?.sessionId ?? null, credentialFile: path.join(f.home, "grant.json"), ipcEndpoint: path.join(f.home, "controller.sock"), ipcSecret: "a".repeat(64), createdAt: new Date(0).toISOString() };
  };
  vi.spyOn(launchTickets, "readLaunchTicket").mockResolvedValue(ticketFor(task));
  const saved = vi.spyOn(lifecycle, "readControllerSnapshot").mockReturnValue(snapshot);
  const stopped = vi.spyOn(processProof, "confirmControllerProcessesStopped").mockResolvedValue(true);
  vi.spyOn(lifecycle, "recordStoppedControllerGeneration").mockResolvedValue(snapshot);
  const launcher = { prepare: vi.fn(async (record: LocalTask) => ticketFor(record)), launch: vi.fn(async () => {}), refreshGrant: vi.fn(async () => {}) };
  const request = vi.fn<typeof requestController>(async ticket => ({ requestId: randomUUID(), ok: true, snapshot: { ...snapshot, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: "ready", activity: "idle", nativeStopped: false, stoppedAt: null, error: null } }));
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher, platform: "macos", buildPrompt: () => "replacement must not be used", emit: () => {}, now: () => 20, request });
  return { ...f, task, snapshot, saved, stopped, launcher, request, backend };
};

it.each(["ready", "working"] as const)("keeps the healthy last recovery generation running at its exact budget (%s)", async lifecycleState => {
  const f = await recoveryFixture();
  f.stopped.mockResolvedValue(false);
  f.saved.mockReturnValue({ ...f.snapshot, lifecycle: lifecycleState, activity: "working", nativeStopped: false, stoppedAt: null, error: null });
  f.request.mockImplementation(async ticket => ({ requestId: randomUUID(), ok: true, snapshot: { ...f.snapshot, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: lifecycleState, activity: "working", nativeStopped: false, stoppedAt: null, error: null } }));
  const observed = await f.backend.advance(f.task, new AbortController().signal);
  expect(observed.recovery).toEqual({ count: 2, pauseReason: null, retryAuthorized: false });
  expect(observed.webExecution?.executionGeneration).toBe("1");
});

it("persists diagnostic waiting when exhausted stop evidence is incomplete", async () => {
  const f = await recoveryFixture();
  f.stopped.mockRejectedValue(new Error("Process identity cannot be established."));
  const paused = await f.backend.advance(f.task, new AbortController().signal);
  expect(paused.recovery.pauseReason).toContain("Process identity cannot be established");
  expect(f.launcher.prepare).not.toHaveBeenCalled(); expect(f.launcher.launch).not.toHaveBeenCalled();
});

it.each(["ready", "working"] as const)("uses one explicit retry for the stopped original native identity without sending its assignment (%s)", async lifecycleState => {
  const f = await recoveryFixture();
  f.store.beginRecovery(f.task, 8);
  const authorized = f.store.authorizeRecoveryRetry(f.task, 9);
  f.request.mockImplementation(async ticket => ({ requestId: randomUUID(), ok: true, snapshot: { ...f.snapshot, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: lifecycleState, activity: lifecycleState === "working" ? "working" : "idle", nativeStopped: false, stoppedAt: null, error: null } }));
  const result = await f.backend.advance(authorized, new AbortController().signal);
  expect(result.recovery).toEqual({ count: 3, pauseReason: null, retryAuthorized: false });
  expect(result.webExecution?.executionGeneration).toBe("2");
  expect(result.resources.nativeSession).toEqual(f.task.resources.nativeSession);
  expect(f.launcher.prepare.mock.calls.map(([record]) => record.webExecution?.executionGeneration)).toEqual(["2"]);
  expect(f.request.mock.calls.map(([, action]) => action.kind)).toEqual(["observe"]);
});

it("consumes retry authorization and pauses again after a failed launch", async () => {
  const f = await recoveryFixture();
  f.store.beginRecovery(f.task, 8);
  const authorized = f.store.authorizeRecoveryRetry(f.task, 9);
  f.launcher.launch.mockRejectedValue(new Error("Retry launch failed."));
  await expect(f.backend.advance(authorized, new AbortController().signal)).rejects.toThrow("Retry launch failed");
  const result = f.store.getTask(f.task)!;
  expect(result.recovery).toEqual({ count: 3, pauseReason: "Retry launch failed.", retryAuthorized: false });
  await f.backend.advance(result, new AbortController().signal);
  expect(f.launcher.launch).toHaveBeenCalledOnce();
});

it("rejects retry without complete original stop evidence before preparing anything", async () => {
  const f = await recoveryFixture();
  f.store.beginRecovery(f.task, 8);
  const authorized = f.store.authorizeRecoveryRetry(f.task, 9);
  f.stopped.mockResolvedValue(false);
  await expect(f.backend.advance(authorized, new AbortController().signal)).rejects.toThrow("stop");
  expect(f.store.getTask(f.task)?.recovery.retryAuthorized).toBe(false);
  expect(f.store.getTask(f.task)?.recovery.pauseReason).not.toBeNull();
  expect(f.launcher.prepare).not.toHaveBeenCalled(); expect(f.launcher.launch).not.toHaveBeenCalled();
});

it("retains initializing until an explicit retry is actually observed ready", async () => {
  const f = await recoveryFixture();
  f.store.beginRecovery(f.task, 8);
  const authorized = f.store.authorizeRecoveryRetry(f.task, 9);
  f.request.mockImplementationOnce(async ticket => ({ requestId: randomUUID(), ok: true, snapshot: { ...f.snapshot, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: "starting", activity: "idle", nativeStopped: false, stoppedAt: null, error: null } }));
  const starting = await f.backend.advance(authorized, new AbortController().signal);
  expect(starting.webExecution?.activity).toBe("initializing");
  expect(starting.recovery).toEqual({ count: 3, pauseReason: null, retryAuthorized: true });
  f.saved.mockReturnValue({ ...f.snapshot, executionGeneration: starting.webExecution!.executionGeneration, controllerInstanceId: starting.webExecution!.controllerInstanceId, lifecycle: "ready", activity: "idle", nativeStopped: false, stoppedAt: null, error: null });
  f.stopped.mockResolvedValue(false);
  const ready = await f.backend.advance(starting, new AbortController().signal);
  expect(ready.webExecution?.activity).toBe("idle");
  expect(ready.webExecution?.executionGeneration).toBe("2");
  expect(ready.recovery.count).toBe(3);
});

it("refuses an explicit retry whose native session identity is missing", async () => {
  const f = await fixture();
  f.store.pauseRecovery(f.identity, "Stopped without an original native identity.", 2);
  const authorized = f.store.authorizeRecoveryRetry(f.identity, 3);
  const launcher = { prepare: vi.fn(), launch: vi.fn(), refreshGrant: vi.fn() };
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher, platform: "macos", buildPrompt: vi.fn(), emit: () => {}, now: () => 4 });
  await expect(backend.advance(authorized, new AbortController().signal)).rejects.toThrow("original native session identity");
  expect(f.store.getTask(f.identity)?.recovery.retryAuthorized).toBe(false);
  expect(f.git.prepareWorktree).not.toHaveBeenCalled(); expect(launcher.prepare).not.toHaveBeenCalled();
});

it("does not resend an initial assignment from a recovered generation", async () => {
  const f = await recoveryFixture();
  f.store.beginRecovery(f.task, 8);
  const authorized = f.store.authorizeRecoveryRetry(f.task, 9);
  f.request.mockImplementation(async ticket => ({ requestId: randomUUID(), ok: true, snapshot: { ...f.snapshot, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: "ready", initialInputState: "not_submitted", activity: "idle", nativeStopped: false, stoppedAt: null, error: null } }));
  await expect(f.backend.advance(authorized, new AbortController().signal)).rejects.toThrow("cannot resubmit");
  expect(f.store.getTask(f.task)?.recovery.pauseReason).toContain("cannot resubmit");
  expect(f.request.mock.calls.map(([, action]) => action.kind)).toEqual(["observe"]);
});

it("keeps a persisted pause ahead of shutdown restart provenance", async () => {
  const f = await recoveryFixture();
  const paused = f.store.beginRecovery(f.task, 8);
  f.store.beginCleanup(paused, { kind: "shutdown", deadline: 100 }, 9);
  f.store.confirmAgentStopped(paused, { agentStopped: true }, 10);
  f.store.confirmBackendResourcesClosed(paused, { controllerStopped: true, endpointClosed: true }, 11);
  const restored = f.store.clearShutdown(paused, 12);
  for (let i = 0; i < 3; i++) expect((await f.backend.advance(restored, new AbortController().signal)).recovery).toEqual(paused.recovery);
  expect(f.launcher.prepare).not.toHaveBeenCalled(); expect(f.launcher.launch).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
});

it("does not let shutdown provenance revive a legacy exhausted failed generation", async () => {
  const f = await recoveryFixture();
  f.store.beginCleanup(f.task, { kind: "shutdown", deadline: 100 }, 8);
  f.store.confirmAgentStopped(f.task, { agentStopped: true }, 9);
  f.store.confirmBackendResourcesClosed(f.task, { controllerStopped: true, endpointClosed: true }, 10);
  const restored = f.store.clearShutdown(f.task, 11);
  const result = await f.backend.advance(restored, new AbortController().signal);
  expect(result.recovery.pauseReason).toContain("recovery budget is exhausted");
  expect(f.launcher.prepare).not.toHaveBeenCalled(); expect(f.launcher.launch).not.toHaveBeenCalled();
});

it.each(["stopped", "ready"] as const)("persists legacy exhaustion before shutdown when the original writer is already gone (%s journal)", async lifecycleState => {
  const f = await recoveryFixture();
  f.saved.mockReturnValue({ ...f.snapshot, lifecycle: lifecycleState, error: null });
  const shutdown = await f.backend.cleanup(f.task, "shutdown", 20, undefined, true);
  expect(shutdown.recovery.pauseReason).toContain("recovery budget is exhausted");
  const restored = f.store.clearShutdown(shutdown, 21);
  await f.backend.advance(restored, new AbortController().signal);
  expect(f.launcher.prepare).not.toHaveBeenCalled(); expect(f.launcher.launch).not.toHaveBeenCalled();
});

it("does not immediately pause a healthy last generation when grant refresh fails", async () => {
  const f = await recoveryFixture();
  f.stopped.mockResolvedValue(false);
  f.saved.mockReturnValue({ ...f.snapshot, lifecycle: "ready", activity: "working", nativeStopped: false, stoppedAt: null, error: null });
  f.launcher.refreshGrant.mockRejectedValue(new Error("Grant service temporarily unavailable."));
  await expect(f.backend.advance(f.task, new AbortController().signal)).rejects.toThrow("Grant service temporarily unavailable");
  expect(f.store.getTask(f.task)?.recovery.pauseReason).toBeNull();
});


it("retains a single retry across starting, store reopen, and later native failure below the ordinary budget", async () => {
  const f = await recoveryFixture(5);
  f.store.pauseRecovery(f.task, "Execution failure threshold reached.", 8);
  const authorized = f.store.authorizeRecoveryRetry(f.task, 9);
  f.request.mockImplementationOnce(async ticket => ({ requestId: randomUUID(), ok: true, snapshot: { ...f.snapshot, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: "starting", activity: "initializing", nativeStopped: false, stoppedAt: null, error: null } }));
  const starting = await f.backend.advance(authorized, new AbortController().signal);
  expect(starting.recovery).toEqual({ count: 3, pauseReason: null, retryAuthorized: true });
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = openWebExecutionStore(path.join(f.home, "worker.sqlite")); stores.push(reopened);
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: reopened, git: f.git, launcher: f.launcher, platform: "macos", buildPrompt: vi.fn(), emit: () => {}, now: () => 30, request: f.request });
  f.request.mockRejectedValue(new Error("The retried generation stopped before becoming ready."));
  await expect(backend.advance(reopened.getTask(f.task)!, new AbortController().signal)).rejects.toThrow("stopped before becoming ready");
  expect(reopened.getTask(f.task)?.recovery).toEqual({ count: 3, pauseReason: "The retried generation stopped before becoming ready.", retryAuthorized: false });
  expect(reopened.getTask(f.task)?.webExecution?.executionGeneration).toBe("2");
});


it("does not prepare an exhausted generation whose last ready journal cannot be observed live", async () => {
  const f = await recoveryFixture();
  f.stopped.mockResolvedValue(false);
  f.saved.mockReturnValue({ ...f.snapshot, lifecycle: "ready", activity: "working", nativeStopped: false, stoppedAt: null, error: null });
  f.request.mockRejectedValue(new Error("Original controller is unreachable."));
  const paused = await f.backend.advance(f.task, new AbortController().signal);
  expect(paused.recovery.pauseReason).toContain("unreachable");
  expect(f.launcher.prepare).not.toHaveBeenCalled(); expect(f.launcher.launch).not.toHaveBeenCalled();
});

it("retains a healthy exhausted generation through an actual orderly cleanup and restart", async () => {
  const f = await recoveryFixture();
  f.saved.mockReturnValue({ ...f.snapshot, lifecycle: "working", activity: "working", nativeStopped: false, stoppedAt: null, error: null });
  f.stopped.mockResolvedValueOnce(false).mockResolvedValue(true);
  const shutdown = await f.backend.cleanup(f.task, "shutdown", 20, undefined, true);
  expect(shutdown.recovery.pauseReason).toBeNull();
  const restored = f.store.clearShutdown(shutdown, 21);
  f.saved.mockReturnValue({ ...f.snapshot, error: null });
  f.request.mockImplementation(async ticket => {
    if (ticket.executionGeneration === "1") throw new Error("Original writer was stopped by orderly shutdown.");
    return { requestId: randomUUID(), ok: true, snapshot: { ...f.snapshot, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: "working", activity: "working", nativeStopped: false, stoppedAt: null, error: null } };
  });
  const result = await f.backend.advance(restored, new AbortController().signal);
  expect(result.recovery).toEqual({ count: 2, pauseReason: null, retryAuthorized: false });
  expect(result.webExecution?.executionGeneration).toBe("2");
});

it("does not turn a pending retry into another orderly restart during shutdown", async () => {
  const f = await recoveryFixture(5);
  f.store.pauseRecovery(f.task, "Execution failure threshold reached.", 8);
  const authorized = f.store.authorizeRecoveryRetry(f.task, 9);
  f.request.mockImplementationOnce(async ticket => ({ requestId: randomUUID(), ok: true, snapshot: { ...f.snapshot, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: "starting", activity: "initializing", nativeStopped: false, stoppedAt: null, error: null } }));
  let starting = await f.backend.advance(authorized, new AbortController().signal);
  starting = f.store.updateWebExecution(starting, { ticketPath: path.join(f.home, "retry-ticket.json") }, 21);
  const shutdown = await f.backend.cleanup(starting, "shutdown", 30, undefined, true);
  expect(shutdown.recovery).toEqual({ count: 3, pauseReason: "The explicit recovery attempt stopped before a successful observation.", retryAuthorized: false });
  const restored = f.store.clearShutdown(shutdown, 31);
  await f.backend.advance(restored, new AbortController().signal);
  expect(f.launcher.launch).toHaveBeenCalledOnce();
  expect(restored.webExecution?.executionGeneration).toBe("2");
});

it.each(["failed", "paused", "stopped", "stopping"] as const)("persists a failed explicit retry without sending an initial assignment (%s)", async lifecycleState => {
  const f = await recoveryFixture(5);
  f.store.pauseRecovery(f.task, "Execution failure threshold reached.", 8);
  const authorized = f.store.authorizeRecoveryRetry(f.task, 9);
  f.request.mockImplementation(async ticket => ({ requestId: randomUUID(), ok: true, snapshot: { ...f.snapshot, executionGeneration: ticket.executionGeneration, controllerInstanceId: ticket.controllerInstanceId, lifecycle: lifecycleState, initialInputState: "not_submitted", error: "The retry did not become healthy." } }));
  await expect(f.backend.advance(authorized, new AbortController().signal)).rejects.toThrow("did not become healthy");
  expect(f.store.getTask(f.task)?.recovery).toEqual({ count: 3, pauseReason: "The retry did not become healthy.", retryAuthorized: false });
  expect(f.request.mock.calls.map(([, action]) => action.kind)).toEqual(["observe"]);
});
